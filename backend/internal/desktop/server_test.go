package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/mcp"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestDesktopLoopbackServerAuthCORSAndRoutes(t *testing.T) {
	ctx := context.Background()

	// Cloud gateway fixture.
	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open cloud db: %v", err)
	}
	defer cloudDB.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())
	searchReg := plugin.NewSearchRegistry()
	searchReg.MustRegister(search.NewTavilyEngine(nil))

	cloudConvStore := store.NewConversationStore(cloudDB)
	cloudMsgStore := store.NewMessageStore(cloudDB)
	cloudAssistStore := store.NewAssistantStore(cloudDB)
	cloudMCPStore := store.NewMCPServerStore(cloudDB)
	cloudPrefStore := store.NewPreferenceStore(cloudDB)
	cloudProvStore := store.NewProviderStore(cloudDB)
	cloudSearchStore := store.NewSearchConfigStore(cloudDB)

	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:              config.Config{AccessToken: "remote-tok", DevMode: false},
		Formats:             formats,
		Adapters:            adapters,
		ProviderService:     service.NewProviderService(cloudProvStore, formats, adapters),
		AssistantService:    service.NewAssistantService(cloudAssistStore),
		ConversationService: service.NewConversationService(cloudConvStore, cloudMsgStore).WithAssistants(cloudAssistStore),
		PluginService:       service.NewPluginService(searchReg, cloudSearchStore, cloudMCPStore),
		PreferenceService:   service.NewPreferenceService(cloudPrefStore),
	})
	cloudSrv := httptest.NewServer(cloudRouter)
	defer cloudSrv.Close()

	// Desktop runtime server backed by temp file SQLite.
	tmpDir := t.TempDir()
	paths := StoragePaths{
		Mode:    DataModePortable,
		DataDir: tmpDir,
		DBPath:  filepath.Join(tmpDir, "local.db"),
	}
	localStore, err := OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()
	cloud := NewCloudClient("", "")
	credCache := NewMemoryCredentialCache(cloud)
	localStore.SetMemoryCacheInvalidator(credCache.ClearAll)
	composite := NewCompositeToolRuntime(localStore.MCPs, mcpRuntime, cloud)
	chatEngine := NewDesktopChatEngine(localStore, cloud, credCache, formats, adapters, searchReg, composite, &http.Client{})
	syncSvc := NewSyncService(localStore, cloud)

	srv, err := NewServer(ServerConfig{
		Paths:          paths,
		Store:          localStore,
		Cloud:          cloud,
		CredCache:      credCache,
		Formats:        formats,
		Adapters:       adapters,
		SearchReg:      searchReg,
		LocalMCPClient: mcpRuntime,
		CompositeTools: composite,
		ChatEngine:     chatEngine,
		SyncService:    syncSvc,
		DevMode:        false,
		Version:        "1.5.0",
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	h := srv.Handler()

	doReq := func(method, path, token, origin string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, path, &buf)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Unauthenticated / wrong-token requests return 401; OPTIONS preflight respects allowed origins only.
	if rec := doReq(http.MethodGet, "/api/v1/desktop/status", "", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", rec.Code)
	}
	if rec := doReq(http.MethodGet, "/healthz", "wrong-token", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d", rec.Code)
	}
	optGood := doReq(http.MethodOptions, "/api/v1/desktop/status", "", "mygo://localhost", nil)
	if optGood.Code != http.StatusNoContent || optGood.Header().Get("Access-Control-Allow-Origin") != "mygo://localhost" {
		t.Fatalf("unexpected allowed CORS preflight: code=%d allow=%q", optGood.Code, optGood.Header().Get("Access-Control-Allow-Origin"))
	}
	optBad := doReq(http.MethodOptions, "/api/v1/desktop/status", "", "https://evil.example", nil)
	if optBad.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unexpected CORS origin allowed for evil.example: %q", optBad.Header().Get("Access-Control-Allow-Origin"))
	}

	tok := srv.Token()
	if len(tok) != 64 {
		t.Fatalf("expected 64-char hex session token, got len=%d", len(tok))
	}

	// 2. Connect cloud, verify status and connection sanitization.
	testConn := doReq(http.MethodPost, "/api/v1/desktop/connection/test", tok, "", map[string]any{
		"gatewayBaseUrl": cloudSrv.URL,
		"accessToken":    "remote-tok",
	})
	if testConn.Code != http.StatusOK {
		t.Fatalf("connection test status=%d body=%s", testConn.Code, testConn.Body.String())
	}
	saveConn := doReq(http.MethodPut, "/api/v1/desktop/connection", tok, "", map[string]any{
		"gatewayBaseUrl": cloudSrv.URL,
		"accessToken":    "remote-tok",
	})
	if saveConn.Code != http.StatusOK {
		t.Fatalf("save connection status=%d body=%s", saveConn.Code, saveConn.Body.String())
	}
	getConn := doReq(http.MethodGet, "/api/v1/desktop/connection", tok, "", nil)
	if getConn.Code != http.StatusOK || bytes.Contains(getConn.Body.Bytes(), []byte("remote-tok")) {
		t.Fatalf("GET /desktop/connection leaked token or failed: %d %s", getConn.Code, getConn.Body.String())
	}

	// 3. Create local & cloud conversations under scope separation, plus local storage stats/compact/clear-cache.
	locCreate := doReq(http.MethodPost, "/api/v1/conversations?scope=local", tok, "", map[string]any{"title": "Local Topic"})
	if locCreate.Code != http.StatusCreated {
		t.Fatalf("create local topic status=%d body=%s", locCreate.Code, locCreate.Body.String())
	}
	var locOut struct {
		Conversation domain.Conversation `json:"conversation"`
	}
	_ = json.Unmarshal(locCreate.Body.Bytes(), &locOut)

	cloudCreate := doReq(http.MethodPost, "/api/v1/conversations?scope=cloud", tok, "", map[string]any{"title": "Cloud Topic"})
	if cloudCreate.Code != http.StatusCreated {
		t.Fatalf("create cloud topic status=%d body=%s", cloudCreate.Code, cloudCreate.Body.String())
	}

	locList := doReq(http.MethodGet, "/api/v1/conversations?scope=local", tok, "", nil)
	cloudList := doReq(http.MethodGet, "/api/v1/conversations?scope=cloud", tok, "", nil)
	if !bytes.Contains(locList.Body.Bytes(), []byte("Local Topic")) || bytes.Contains(locList.Body.Bytes(), []byte("Cloud Topic")) {
		t.Fatalf("local list polluted: %s", locList.Body.String())
	}
	if !bytes.Contains(cloudList.Body.Bytes(), []byte("Cloud Topic")) || bytes.Contains(cloudList.Body.Bytes(), []byte("Local Topic")) {
		t.Fatalf("cloud list polluted: %s", cloudList.Body.String())
	}

	// Upload local topic via desktop endpoint.
	uploadRec := doReq(http.MethodPost, "/api/v1/desktop/conversations/"+locOut.Conversation.ID+"/upload", tok, "", map[string]any{})
	if uploadRec.Code != http.StatusOK {
		t.Fatalf("upload conversation status=%d body=%s", uploadRec.Code, uploadRec.Body.String())
	}

	// Local storage stats, compact, and clear-cache (preserving local topic).
	stInfoRec := doReq(http.MethodGet, "/api/v1/desktop/storage", tok, "", nil)
	if stInfoRec.Code != http.StatusOK {
		t.Fatalf("GET /desktop/storage status=%d", stInfoRec.Code)
	}
	var stInfo DesktopStorageInfo
	_ = json.Unmarshal(stInfoRec.Body.Bytes(), &stInfo)
	if stInfo.Mode != DataModePortable || !stInfo.Compactable || stInfo.TotalBytes <= 0 || stInfo.ConversationCount != 1 {
		t.Fatalf("unexpected desktop storage info: %+v", stInfo)
	}

	compactRec := doReq(http.MethodPost, "/api/v1/desktop/storage/compact", tok, "", nil)
	if compactRec.Code != http.StatusOK {
		t.Fatalf("POST /desktop/storage/compact status=%d body=%s", compactRec.Code, compactRec.Body.String())
	}

	_ = localStore.SaveCachedPreferences(ctx, domain.DefaultPreferences())
	clearCacheRec := doReq(http.MethodPost, "/api/v1/desktop/storage/clear-cache", tok, "", nil)
	if clearCacheRec.Code != http.StatusOK {
		t.Fatalf("POST /desktop/storage/clear-cache status=%d", clearCacheRec.Code)
	}
	if _, ok, _ := localStore.LoadCachedPreferences(ctx); ok {
		t.Fatal("expected desktop_cache cleared")
	}
	if _, err := localStore.Conversations.Get(ctx, locOut.Conversation.ID); err != nil {
		t.Fatalf("local topic must survive clear-cache: %v", err)
	}

	// Cleanup local ungrouped removes local unpinned topic.
	cleanupRec := doReq(http.MethodPost, "/api/v1/desktop/storage/cleanup-ungrouped", tok, "", nil)
	if cleanupRec.Code != http.StatusOK || !bytes.Contains(cleanupRec.Body.Bytes(), []byte(locOut.Conversation.ID)) {
		t.Fatalf("POST /desktop/storage/cleanup-ungrouped status=%d body=%s", cleanupRec.Code, cleanupRec.Body.String())
	}
}
