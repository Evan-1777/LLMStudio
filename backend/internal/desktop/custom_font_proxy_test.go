package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

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

func TestDesktopCustomFontProxyAndConnectionIsolation(t *testing.T) {
	ctx := context.Background()

	// Cloud gateway A with real CustomFontService.
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

	var cloudHits atomic.Int32
	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:            config.Config{AccessToken: "cloud-tok-a", DevMode: false},
		Formats:           formats,
		Adapters:          adapters,
		PreferenceService: service.NewPreferenceService(store.NewPreferenceStore(cloudDB)),
		CustomFontService: service.NewCustomFontService(store.NewCustomFontStore(cloudDB)),
	})
	cloudSrvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cloudHits.Add(1)
		cloudRouter.ServeHTTP(w, r)
	}))
	defer cloudSrvA.Close()

	// Desktop loopback server.
	tmpDir := t.TempDir()
	paths := StoragePaths{Mode: DataModePortable, DataDir: tmpDir, DBPath: filepath.Join(tmpDir, "local.db")}
	localStore, err := OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()
	cloud := NewCloudClient("", "")
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
	h := srv.Handler()
	tok := srv.Token()

	doReq := func(method, path string, headers map[string]string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Disconnected returns 503 CLOUD_NOT_CONNECTED (not empty font, not 401) and never hits cloud.
	disconn := doReq(http.MethodGet, "/api/v1/settings/custom-font", nil, nil)
	if disconn.Code != http.StatusServiceUnavailable {
		t.Fatalf("disconnected status=%d body=%s, want 503", disconn.Code, disconn.Body.String())
	}
	if !bytes.Contains(disconn.Body.Bytes(), []byte(domain.ErrCodeCloudNotConnected)) {
		t.Fatalf("expected CLOUD_NOT_CONNECTED, got %s", disconn.Body.String())
	}
	if cloudHits.Load() != 0 {
		t.Fatalf("disconnected request hit cloud %d times", cloudHits.Load())
	}

	// 2. Wrong token returns 401 UNAUTHORIZED (distinct from disconnected and unreachable).
	cloud.SetCredentials(cloudSrvA.URL, "wrong-tok")
	unauth := doReq(http.MethodGet, "/api/v1/settings/custom-font", nil, nil)
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("wrong cloud token status=%d body=%s, want 401", unauth.Code, unauth.Body.String())
	}

	// 3. Unreachable gateway returns 502 UPSTREAM_ERROR (distinct from disconnected and 401).
	deadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := deadSrv.URL
	deadSrv.Close()
	cloud.SetCredentials(deadURL, "cloud-tok-a")
	unreach := doReq(http.MethodGet, "/api/v1/settings/custom-font", nil, nil)
	if unreach.Code != http.StatusBadGateway {
		t.Fatalf("unreachable status=%d body=%s, want 502", unreach.Code, unreach.Body.String())
	}

	// 4. Connected: upload, toggle, download, conditional 304, delete; desktop SQLite stores NO font BLOB.
	cloud.SetCredentials(cloudSrvA.URL, "cloud-tok-a")
	fontBytes := append([]byte{0x00, 0x01, 0x00, 0x00}, []byte("desktop-proxied-font")...)
	putRec := doReq(http.MethodPut, "/api/v1/settings/custom-font", map[string]string{
		"Content-Type": "font/ttf",
		"X-Font-Name":  url.PathEscape("Desktop Font.ttf"),
	}, fontBytes)
	if putRec.Code != http.StatusOK {
		t.Fatalf("proxied PUT status=%d body=%s", putRec.Code, putRec.Body.String())
	}
	var metaEnv struct {
		Font domain.CustomFontMeta `json:"font"`
	}
	if err := json.Unmarshal(putRec.Body.Bytes(), &metaEnv); err != nil {
		t.Fatalf("decode proxied PUT: %v", err)
	}
	if metaEnv.Font.Name != "Desktop Font.ttf" || !metaEnv.Font.Enabled {
		t.Fatalf("unexpected proxied meta: %+v", metaEnv.Font)
	}

	// Verify desktop SQLite custom_font table remains empty (no local BLOB copy).
	var localFontCount int
	if err := localStore.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM custom_font`).Scan(&localFontCount); err != nil {
		t.Fatalf("query local custom_font: %v", err)
	}
	if localFontCount != 0 {
		t.Fatalf("desktop SQLite should not store font copy, found %d rows", localFontCount)
	}

	// Download & conditional 304.
	fileRec := doReq(http.MethodGet, "/api/v1/settings/custom-font/file", nil, nil)
	if fileRec.Code != http.StatusOK || !bytes.Equal(fileRec.Body.Bytes(), fontBytes) {
		t.Fatalf("proxied GET file status=%d len=%d", fileRec.Code, fileRec.Body.Len())
	}
	etag := fileRec.Header().Get("ETag")
	if etag == "" || fileRec.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("missing ETag or Cache-Control on proxied file: etag=%q cc=%q", etag, fileRec.Header().Get("Cache-Control"))
	}
	notMod := doReq(http.MethodGet, "/api/v1/settings/custom-font/file", map[string]string{
		"If-None-Match": etag,
	}, nil)
	if notMod.Code != http.StatusNotModified || notMod.Body.Len() != 0 {
		t.Fatalf("expected 304 on conditional GET, got %d len=%d", notMod.Code, notMod.Body.Len())
	}

	// Toggle & Delete.
	patchRec := doReq(http.MethodPatch, "/api/v1/settings/custom-font", map[string]string{
		"Content-Type": "application/json",
	}, []byte(`{"enabled":false}`))
	if patchRec.Code != http.StatusOK {
		t.Fatalf("proxied PATCH status=%d body=%s", patchRec.Code, patchRec.Body.String())
	}
	delRec := doReq(http.MethodDelete, "/api/v1/settings/custom-font", nil, nil)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("proxied DELETE status=%d", delRec.Code)
	}

	// 5. Switching cloud connection mid-flight cancels old request and returns 409 CONFLICT.
	started := make(chan struct{})
	releaseSlow := make(chan struct{})
	slowSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-releaseSlow:
		case <-time.After(3 * time.Second):
		}
	}))
	defer slowSrv.Close()
	defer close(releaseSlow)

	cloud.SetCredentials(slowSrv.URL, "slow-tok")
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- doReq(http.MethodGet, "/api/v1/settings/custom-font/file", nil, nil)
	}()

	<-started
	cloud.SetCredentials(cloudSrvA.URL, "cloud-tok-a")
	rec := <-done
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 CONFLICT when connection switches mid-flight, got %d body=%s", rec.Code, rec.Body.String())
	}
}
