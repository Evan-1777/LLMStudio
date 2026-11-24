package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sync/atomic"
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

	originalBlocks := []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "caption"}, {Type: domain.BlockTypeImage, MimeType: "image/png", Data: "b2xk"}}
	original, err := localStore.Messages.Create(ctx, domain.Message{ConversationID: locOut.Conversation.ID, Role: domain.RoleUser, Blocks: originalBlocks})
	if err != nil {
		t.Fatal(err)
	}

	// Upload local topic via desktop endpoint.
	uploadRec := doReq(http.MethodPost, "/api/v1/desktop/conversations/"+locOut.Conversation.ID+"/upload", tok, "", map[string]any{})
	if uploadRec.Code != http.StatusOK {
		t.Fatalf("upload conversation status=%d body=%s", uploadRec.Code, uploadRec.Body.String())
	}

	// The same message ID exists on both sides after upload. PATCH must update only its requested scope.
	patchPath := "/api/v1/conversations/" + locOut.Conversation.ID + "/messages/" + original.ID
	withImage := []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "caption"}, {Type: domain.BlockTypeImage, MimeType: "image/png", Data: "bmV3"}}
	if rec := doReq(http.MethodPatch, patchPath+"?scope=local", tok, "", map[string]any{"blocks": withImage}); rec.Code != http.StatusOK {
		t.Fatalf("local PATCH: %d %s", rec.Code, rec.Body.String())
	}
	conv, err := localStore.Conversations.Get(ctx, locOut.Conversation.ID)
	if err != nil || conv.SyncState != domain.SyncStatePending {
		t.Fatalf("local PATCH sync state=%s err=%v", conv.SyncState, err)
	}
	cloudMessage, err := cloudMsgStore.Get(ctx, original.ID)
	if err != nil || !reflect.DeepEqual(cloudMessage.Blocks, originalBlocks) {
		t.Fatalf("local PATCH altered cloud message: %v", err)
	}
	withoutImage := originalBlocks[:1]
	if rec := doReq(http.MethodPatch, patchPath+"?scope=cloud", tok, "", map[string]any{"blocks": withoutImage}); rec.Code != http.StatusOK {
		t.Fatalf("cloud PATCH: %d %s", rec.Code, rec.Body.String())
	}
	cloudMessage, err = cloudMsgStore.Get(ctx, original.ID)
	if err != nil || !reflect.DeepEqual(cloudMessage.Blocks, withoutImage) {
		t.Fatalf("cloud PATCH did not forward replacement blocks: %v", err)
	}
	localMessage, err := localStore.Messages.Get(ctx, original.ID)
	if err != nil || !reflect.DeepEqual(localMessage.Blocks, withImage) {
		t.Fatalf("cloud PATCH altered local message: %v", err)
	}

	// A graph patch must stay in its requested scope, then round-trip via sync.
	graphPath := "/api/v1/conversations/" + locOut.Conversation.ID + "/graph?scope="
	patchGraph := func(scope string, input map[string]any) service.ConversationDetail {
		t.Helper()
		rec := doReq(http.MethodPatch, graphPath+scope, tok, "", input)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s graph PATCH: %d %s", scope, rec.Code, rec.Body.String())
		}
		var detail service.ConversationDetail
		if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
			t.Fatal(err)
		}
		return detail
	}
	localGraph := patchGraph("local", map[string]any{"op": "setNodeMeta", "messageId": original.ID, "graphMeta": map[string]any{"collapsed": true, "summary": "local summary"}})
	if !localGraph.Conversation.GraphState.Enabled || !localGraph.Messages[0].GraphMeta.Collapsed {
		t.Fatalf("missing local graph: %+v", localGraph)
	}
	cloudConv, err := cloudConvStore.Get(ctx, locOut.Conversation.ID)
	if err != nil || cloudConv.GraphState != nil {
		t.Fatalf("local graph PATCH polluted cloud: %+v %v", cloudConv, err)
	}
	msgRec := doReq(http.MethodPost, "/api/v1/conversations/"+locOut.Conversation.ID+"/messages?scope=local", tok, "", map[string]any{"role": "assistant", "blocks": withoutImage, "parentId": original.ID})
	if msgRec.Code != http.StatusCreated {
		t.Fatalf("graph message write failed: %d %s", msgRec.Code, msgRec.Body.String())
	}
	localGraph = patchGraph("local", map[string]any{"op": "createBranch", "parentMessageId": original.ID, "activate": true})
	if len(localGraph.Messages) != 2 || localGraph.Messages[1].ParentID != original.ID {
		t.Fatalf("graph parent pointer missing: %+v", localGraph)
	}
	upRes, err := syncSvc.UploadConversation(ctx, locOut.Conversation.ID, true)
	if err != nil || upRes.Conversation.GraphState == nil || !reflect.DeepEqual(upRes.Messages, localGraph.Messages) || !reflect.DeepEqual(upRes.Conversation.GraphState, localGraph.Conversation.GraphState) || upRes.Conversation.ActiveLeafID != original.ID {
		t.Fatalf("graph upload did not preserve state: %+v %v", upRes, err)
	}
	cloudGraph := patchGraph("cloud", map[string]any{"op": "setNodeMeta", "messageId": original.ID, "summary": "cloud summary"})
	localMessage, err = localStore.Messages.Get(ctx, original.ID)
	if err != nil || localMessage.GraphMeta.Summary != "local summary" || cloudGraph.Messages[0].GraphMeta.Summary != "cloud summary" {
		t.Fatalf("cloud patch did not isolate scopes: %+v %v", cloudGraph, err)
	}
	pullRes, err := syncSvc.PullConversation(ctx, locOut.Conversation.ID, true)
	if err != nil || !reflect.DeepEqual(pullRes.Messages, cloudGraph.Messages) || !reflect.DeepEqual(pullRes.Conversation.GraphState, cloudGraph.Conversation.GraphState) || pullRes.Conversation.ActiveLeafID != cloudGraph.Conversation.ActiveLeafID {
		t.Fatalf("graph pull did not preserve state: %+v %v", pullRes, err)
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

func TestDesktopStatusProbeSingleRequestRetryAndUnauthorized(t *testing.T) {
	ctx := context.Background()

	var mode atomic.Int32 // 0=ok, 1=transient-then-ok, 2=401
	var healthHits, settingsHits atomic.Int32
	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			healthHits.Add(1)
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"status": "ok", "authRequired": true})
		case "/api/v1/settings":
			hit := settingsHits.Add(1)
			switch mode.Load() {
			case 1:
				if hit == 1 {
					http.Error(w, "bad gateway", http.StatusBadGateway)
					return
				}
			case 2:
				httpapi.WriteJSON(w, http.StatusUnauthorized, map[string]any{"code": "UNAUTHORIZED", "message": "bad token"})
				return
			}
			prefs := domain.DefaultPreferences()
			prefs.ThemeMode = domain.ThemeModeDark
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"preferences": prefs, "initialized": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer cloudSrv.Close()

	tmpDir := t.TempDir()
	paths := StoragePaths{Mode: DataModePortable, DataDir: tmpDir, DBPath: filepath.Join(tmpDir, "local.db")}
	localStore, err := OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()
	if _, err := localStore.SaveConnection(ctx, cloudSrv.URL, "secret-tok"); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}

	formats := plugin.NewFormatRegistry()
	adapters := plugin.NewProviderRegistry()
	searchReg := plugin.NewSearchRegistry()
	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()
	cloud := NewCloudClient(cloudSrv.URL, "secret-tok")
	credCache := NewMemoryCredentialCache(cloud)
	composite := NewCompositeToolRuntime(localStore.MCPs, mcpRuntime, cloud)
	chatEngine := NewDesktopChatEngine(localStore, cloud, credCache, formats, adapters, searchReg, composite, &http.Client{})

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
		SyncService:    NewSyncService(localStore, cloud),
		Version:        "1.5.0",
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	getStatus := func() DesktopStatus {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/desktop/status", nil)
		req.Header.Set("Authorization", "Bearer "+srv.Token())
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /desktop/status code=%d body=%s", rec.Code, rec.Body.String())
		}
		var out DesktopStatus
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode status: %v", err)
		}
		return out
	}

	// 1. Healthy cloud: single /api/v1/settings probe, zero /healthz calls, warms preference cache.
	mode.Store(0)
	st := getStatus()
	if st.CloudState != "connected" || !st.AuthRequired || healthHits.Load() != 0 || settingsHits.Load() != 1 {
		t.Fatalf("unexpected connected status=%+v healthHits=%d settingsHits=%d", st, healthHits.Load(), settingsHits.Load())
	}
	cachedPrefs, ok, err := localStore.LoadCachedPreferences(ctx)
	if err != nil || !ok || cachedPrefs.ThemeMode != domain.ThemeModeDark {
		t.Fatalf("expected cached dark theme preference, ok=%v prefs=%+v err=%v", ok, cachedPrefs, err)
	}

	// 2. Transient 502 on first probe automatically retries once and recovers to connected.
	settingsHits.Store(0)
	mode.Store(1)
	st = getStatus()
	if st.CloudState != "connected" || settingsHits.Load() != 2 {
		t.Fatalf("expected retry recovery to connected with 2 attempts, got status=%+v settingsHits=%d", st, settingsHits.Load())
	}

	// 3. 401 unauthorized fails fast without retry.
	settingsHits.Store(0)
	mode.Store(2)
	st = getStatus()
	if st.CloudState != "auth-required" || !st.AuthRequired || settingsHits.Load() != 1 {
		t.Fatalf("expected auth-required without retry, got status=%+v settingsHits=%d", st, settingsHits.Load())
	}
}

func TestDesktopSearchConversationsScopeDispatch(t *testing.T) {
	ctx := context.Background()
	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer cloudDB.Close()
	cloudConvs := store.NewConversationStore(cloudDB)
	cloudMsgs := store.NewMessageStore(cloudDB)
	cloudConv, err := cloudConvs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "Cloud Topic"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cloudMsgs.Create(ctx, domain.Message{
		ID: "cm1", ConversationID: cloudConv.ID, Role: domain.RoleAssistant,
		Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "cloud-only-needle"}},
	}); err != nil {
		t.Fatal(err)
	}
	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:              config.Config{AccessToken: "remote-tok"},
		ConversationService: service.NewConversationService(cloudConvs, cloudMsgs),
	})
	cloudSrv := httptest.NewServer(cloudRouter)
	defer cloudSrv.Close()

	tmpDir := t.TempDir()
	paths := StoragePaths{Mode: DataModePortable, DataDir: tmpDir, DBPath: filepath.Join(tmpDir, "local.db")}
	localStore, err := OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer localStore.Close()
	localConv, err := localStore.Conversations.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "Local Topic"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := localStore.Messages.Create(ctx, domain.Message{
		ID: "lm1", ConversationID: localConv.ID, Role: domain.RoleAssistant,
		Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "local-only-needle"}},
	}); err != nil {
		t.Fatal(err)
	}

	cloud := NewCloudClient("", "")
	srv, err := NewServer(ServerConfig{Paths: paths, Store: localStore, Cloud: cloud})
	if err != nil {
		t.Fatal(err)
	}

	doSearch := func(rawURL string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, rawURL, nil)
		req.Header.Set("Authorization", "Bearer "+srv.Token())
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		return rec
	}

	// 1. Offline local search succeeds.
	rec := doSearch("/api/v1/conversations/search?scope=local&q=local-only-needle")
	if rec.Code != http.StatusOK {
		t.Fatalf("local search code=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct{ Hits []domain.ConversationSearchHit }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Hits) != 1 || out.Hits[0].MessageID != "lm1" {
		t.Fatalf("unexpected local hits: %+v err=%v", out.Hits, err)
	}

	// 2. Offline cloud search returns 401/error.
	rec = doSearch("/api/v1/conversations/search?scope=cloud&q=cloud-only-needle")
	if rec.Code == http.StatusOK {
		t.Fatalf("expected offline cloud search to fail, got 200: %s", rec.Body.String())
	}

	// 3. Connected cloud search proxies to cloud gateway.
	cloud.SetCredentials(cloudSrv.URL, "remote-tok")
	rec = doSearch("/api/v1/conversations/search?scope=cloud&q=cloud-only-needle")
	if rec.Code != http.StatusOK {
		t.Fatalf("online cloud search code=%d body=%s", rec.Code, rec.Body.String())
	}
	out.Hits = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Hits) != 1 || out.Hits[0].MessageID != "cm1" {
		t.Fatalf("unexpected cloud hits: %+v err=%v", out.Hits, err)
	}
}
