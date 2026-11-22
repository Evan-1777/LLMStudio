package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestDesktopProviderProbeRoutingBySavedLocalRequest(t *testing.T) {
	ctx := context.Background()

	// Upstream A: only reachable by cloud gateway.
	var gwUpstreamHits atomic.Int32
	gwOnlyUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gwUpstreamHits.Add(1)
		if r.Header.Get("Authorization") != "Bearer sk-gw-only" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"id": "gw-model-1"}},
		})
	}))
	defer gwOnlyUpstream.Close()

	// Upstream B: only reachable by desktop local client.
	var desktopUpstreamHits atomic.Int32
	desktopOnlyUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		desktopUpstreamHits.Add(1)
		if r.Header.Get("Authorization") != "Bearer sk-desktop-local" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"id": "desktop-local-model-1"}},
		})
	}))
	defer desktopOnlyUpstream.Close()

	// Cloud gateway whose HTTP client blocks desktopOnlyUpstream.
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

	gwHTTPClient := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if strings.HasPrefix(r.URL.String(), desktopOnlyUpstream.URL) {
				return nil, errors.New("gateway cannot reach desktop-only upstream")
			}
			return http.DefaultTransport.RoundTrip(r)
		}),
	}
	cloudProvSvc := service.NewProviderService(store.NewProviderStore(cloudDB), formats, adapters).WithHTTPClient(gwHTTPClient)
	localFalse := false
	localTrue := true
	_, err = cloudProvSvc.Create(ctx, service.ProviderInput{
		ID:           "p-cloud",
		Name:         "Gateway Reachable",
		Adapter:      "generic-http",
		BaseURL:      gwOnlyUpstream.URL + "/v1",
		AuthType:     domain.AuthTypeBearer,
		APIKey:       "sk-gw-only",
		LocalRequest: &localFalse,
	})
	if err != nil {
		t.Fatalf("create p-cloud: %v", err)
	}
	_, err = cloudProvSvc.Create(ctx, service.ProviderInput{
		ID:           "p-local",
		Name:         "Desktop Reachable",
		Adapter:      "generic-http",
		BaseURL:      desktopOnlyUpstream.URL + "/v1",
		AuthType:     domain.AuthTypeBearer,
		APIKey:       "sk-desktop-local",
		LocalRequest: &localTrue,
	})
	if err != nil {
		t.Fatalf("create p-local: %v", err)
	}
	// Wrong-direction negative case: localRequest=true pointing to gateway-only upstream.
	_, err = cloudProvSvc.Create(ctx, service.ProviderInput{
		ID:           "p-wrong-dir",
		Name:         "Wrong Direction",
		Adapter:      "generic-http",
		BaseURL:      gwOnlyUpstream.URL + "/v1",
		AuthType:     domain.AuthTypeBearer,
		APIKey:       "sk-gw-only",
		LocalRequest: &localTrue,
	})
	if err != nil {
		t.Fatalf("create p-wrong-dir: %v", err)
	}

	var cloudProbeEndpointHits atomic.Int32
	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:          config.Config{AccessToken: "cloud-tok", DevMode: false},
		Formats:         formats,
		Adapters:        adapters,
		ProviderService: cloudProvSvc,
	})
	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/test") || strings.HasSuffix(r.URL.Path, "/models/fetch") {
			cloudProbeEndpointHits.Add(1)
		}
		cloudRouter.ServeHTTP(w, r)
	}))
	defer cloudSrv.Close()

	// Desktop HTTP client blocks gwOnlyUpstream so only desktopOnlyUpstream is reachable from desktop.
	desktopHTTPClient := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if strings.HasPrefix(r.URL.String(), gwOnlyUpstream.URL) {
				return nil, errors.New("desktop cannot reach gateway-only upstream")
			}
			return http.DefaultTransport.RoundTrip(r)
		}),
	}

	tmpDir := t.TempDir()
	paths := StoragePaths{Mode: DataModePortable, DataDir: tmpDir, DBPath: filepath.Join(tmpDir, "local.db")}
	localStore, err := OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()
	cloud := NewCloudClient(cloudSrv.URL, "cloud-tok")
	credCache := NewMemoryCredentialCache(cloud)
	composite := NewCompositeToolRuntime(localStore.MCPs, mcpRuntime, cloud)
	chatEngine := NewDesktopChatEngine(localStore, cloud, credCache, formats, adapters, searchReg, composite, desktopHTTPClient)

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
		HTTPClient:     desktopHTTPClient,
		Version:        "1.5.0",
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	h := srv.Handler()
	tok := srv.Token()

	doPost := func(path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(http.MethodPost, path, &buf)
		req.Header.Set("Authorization", "Bearer "+tok)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Ordinary provider (localRequest=false) hits ONLY cloud gateway.
	testCloud := doPost("/api/v1/providers/p-cloud/test", map[string]any{})
	if testCloud.Code != http.StatusOK {
		t.Fatalf("ordinary provider test failed: %d %s", testCloud.Code, testCloud.Body.String())
	}
	fetchCloud := doPost("/api/v1/providers/p-cloud/models/fetch", map[string]any{})
	if fetchCloud.Code != http.StatusOK || !bytes.Contains(fetchCloud.Body.Bytes(), []byte("gw-model-1")) {
		t.Fatalf("ordinary provider fetch failed: %d %s", fetchCloud.Code, fetchCloud.Body.String())
	}
	if gwUpstreamHits.Load() != 2 || cloudProbeEndpointHits.Load() != 2 {
		t.Fatalf("expected ordinary provider to hit gateway twice, gw=%d cloudEndpoints=%d", gwUpstreamHits.Load(), cloudProbeEndpointHits.Load())
	}

	// 2. Saved localRequest=true provider hits ONLY desktop local upstream, never cloud probe endpoints.
	testLocal := doPost("/api/v1/providers/p-local/test", map[string]any{})
	if testLocal.Code != http.StatusOK {
		t.Fatalf("local provider test failed: %d %s", testLocal.Code, testLocal.Body.String())
	}
	fetchLocal := doPost("/api/v1/providers/p-local/models/fetch", map[string]any{})
	if fetchLocal.Code != http.StatusOK || !bytes.Contains(fetchLocal.Body.Bytes(), []byte("desktop-local-model-1")) {
		t.Fatalf("local provider fetch failed: %d %s", fetchLocal.Code, fetchLocal.Body.String())
	}
	if desktopUpstreamHits.Load() != 2 {
		t.Fatalf("expected desktop local upstream hits=2, got %d", desktopUpstreamHits.Load())
	}
	if cloudProbeEndpointHits.Load() != 2 {
		t.Fatalf("localRequest=true must NOT call cloud /test or /models/fetch, cloudEndpoints=%d", cloudProbeEndpointHits.Load())
	}

	// 3. Unsaved draft overrides on localRequest=true or enabling localRequest via draft are rejected (409).
	if rec := doPost("/api/v1/providers/p-local/test", map[string]any{"baseURL": "https://evil.example/v1"}); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for unsaved baseURL override on localRequest=true, got %d %s", rec.Code, rec.Body.String())
	}
	if rec := doPost("/api/v1/providers/p-cloud/models/fetch", map[string]any{"localRequest": true}); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 when enabling localRequest via unsaved draft, got %d %s", rec.Code, rec.Body.String())
	}

	// 4. Wrong direction (localRequest=true pointing at gateway-only upstream) fails on desktop and does NOT fall back to cloud.
	if rec := doPost("/api/v1/providers/p-wrong-dir/models/fetch", map[string]any{}); rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when desktop cannot reach localRequest upstream, got %d %s", rec.Code, rec.Body.String())
	}
	if cloudProbeEndpointHits.Load() != 2 {
		t.Fatalf("failed desktop local probe must NOT fall back to cloud gateway, cloudEndpoints=%d", cloudProbeEndpointHits.Load())
	}
}
