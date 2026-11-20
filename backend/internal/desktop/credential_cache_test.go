package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
)

func TestMemoryCredentialCacheAndNoDiskKeyPersistence(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "desktop.db")
	st, err := OpenDesktopStore(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer st.Close()

	const rawProvSecret = "sk-memory-only-provider-secret-999"
	const rawSearchSecret = "tvly-memory-only-search-secret-888"

	var provHits atomic.Int32
	var searchHits atomic.Int32
	t1 := time.Now().UTC().Truncate(time.Second)

	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/providers/prov-1/credential":
			provHits.Add(1)
			_ = json.NewEncoder(w).Encode(service.ProviderRuntimeCredential{
				ProviderID: "prov-1",
				Adapter:    "generic-http",
				BaseURL:    "https://upstream.example/v1",
				AuthType:   domain.AuthTypeBearer,
				APIKey:     rawProvSecret,
				UpdatedAt:  t1,
			})
		case "/api/v1/plugins/search/tavily/credential":
			searchHits.Add(1)
			_ = json.NewEncoder(w).Encode(service.SearchEngineRuntimeCredential{
				EngineID:   "tavily",
				Enabled:    true,
				Endpoint:   "https://api.tavily.com/search",
				APIKey:     rawSearchSecret,
				MaxResults: 5,
				UpdatedAt:  t1,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer cloudSrv.Close()

	cloud := NewCloudClient(cloudSrv.URL, "gw-tok")
	cache := NewMemoryCredentialCache(cloud)
	st.SetMemoryCacheInvalidator(cache.ClearAll)

	if _, err := st.SaveConnection(ctx, cloudSrv.URL, "gw-tok"); err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if err := st.SaveCachedProviderConfigs(ctx, []domain.ProviderConfig{
		{
			ID:       "prov-1",
			Name:     "OpenAI",
			Adapter:  "generic-http",
			BaseURL:  "https://upstream.example/v1",
			AuthType: domain.AuthTypeBearer,
			APIKey:   rawProvSecret,
			Enabled:  true,
			Models: []domain.ModelConfig{
				{
					ID:        "gpt-4o",
					Name:      "GPT-4o",
					APIFormat: "openai-completions",
					Compat:    domain.CompatConfig{CacheMode: domain.CacheModeExplicit},
				},
			},
			UpdatedAt: t1,
		},
	}); err != nil {
		t.Fatalf("SaveCachedProviderConfigs: %v", err)
	}

	// First resolve fetches once; subsequent resolves hit memory (0 cloud calls).
	c1, err := cache.ResolveProviderCredential(ctx, "prov-1", t1)
	if err != nil || c1.APIKey != rawProvSecret {
		t.Fatalf("first ResolveProviderCredential: err=%v cred=%+v", err, c1)
	}
	c2, err := cache.ResolveProviderCredential(ctx, "prov-1", t1)
	if err != nil || c2.APIKey != rawProvSecret {
		t.Fatalf("second ResolveProviderCredential: err=%v", err)
	}
	if provHits.Load() != 1 {
		t.Fatalf("expected exactly 1 provider credential fetch, got %d", provHits.Load())
	}

	// updatedAt change triggers re-fetch.
	t2 := t1.Add(time.Minute)
	if _, err := cache.ResolveProviderCredential(ctx, "prov-1", t2); err != nil {
		t.Fatalf("ResolveProviderCredential after updatedAt change: %v", err)
	}
	if provHits.Load() != 2 {
		t.Fatalf("expected 2 fetches after updatedAt bump, got %d", provHits.Load())
	}

	// InvalidateProvider triggers re-fetch.
	cache.InvalidateProvider("prov-1")
	if _, err := cache.ResolveProviderCredential(ctx, "prov-1", t1); err != nil {
		t.Fatalf("ResolveProviderCredential after invalidate: %v", err)
	}
	if provHits.Load() != 3 {
		t.Fatalf("expected 3 fetches after InvalidateProvider, got %d", provHits.Load())
	}

	// Search credential caching.
	if sc, err := cache.ResolveSearchCredential(ctx, "tavily", t1); err != nil || sc.APIKey != rawSearchSecret {
		t.Fatalf("ResolveSearchCredential: err=%v sc=%+v", err, sc)
	}
	if _, err := cache.ResolveSearchCredential(ctx, "tavily", t1); err != nil {
		t.Fatalf("second ResolveSearchCredential: %v", err)
	}
	if searchHits.Load() != 1 {
		t.Fatalf("expected 1 search credential fetch, got %d", searchHits.Load())
	}

	// DisconnectCloud clears access_token in SQLite and clears memory cache.
	if err := st.DisconnectCloud(ctx); err != nil {
		t.Fatalf("DisconnectCloud: %v", err)
	}
	conn, err := st.GetConnection(ctx)
	if err != nil || conn.AccessToken != "" || conn.GatewayBaseURL != "" || conn.TokenSet {
		t.Fatalf("expected cleared desktop_connection after DisconnectCloud, got %+v err=%v", conn, err)
	}
	if _, err := cache.ResolveProviderCredential(ctx, "prov-1", t1); err != nil {
		t.Fatalf("ResolveProviderCredential after ClearAll: %v", err)
	}
	if provHits.Load() != 4 {
		t.Fatalf("expected cache cleared on DisconnectCloud (hits=%d)", provHits.Load())
	}

	// Disconnect retires the supplier snapshot together with its credentials.
	cachedProvs, err := st.LoadCachedProviders(ctx)
	if err != nil || len(cachedProvs) != 0 {
		t.Fatalf("expected disconnected provider cache to be empty, got %+v err=%v", cachedProvs, err)
	}
	_ = st.Close()
	dbBytes, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read db file: %v", err)
	}
	if strings.Contains(string(dbBytes), rawProvSecret) || strings.Contains(string(dbBytes), rawSearchSecret) {
		t.Fatal("plaintext API key found on disk in SQLite database")
	}
}

func TestProviderCredentialFlightsAndSnapshotInvalidation(t *testing.T) {
	ctx := context.Background()
	version := time.Now().UTC()
	const id = "same-id"
	var hits atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	cloud := NewCloudClient("http://gateway.test", "token-a")
	cloud.SetHTTPClient(&http.Client{Transport: desktopRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/v1/providers/"+id+"/credential" {
			if hits.Add(1) == 1 {
				close(started)
				<-release
			}
			key := "key-a"
			if r.Header.Get("Authorization") == "Bearer token-b" {
				key = "key-b"
			}
			raw, _ := json.Marshal(service.ProviderRuntimeCredential{ProviderID: id, UpdatedAt: version, APIKey: key})
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw))}, nil
		}
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("not found"))}, nil
	})})
	st, err := OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "desktop.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.SetCredentialProtector(newTestProtector(t, 1))
	cache := NewMemoryCredentialCache(cloud)
	st.SetMemoryCacheInvalidator(cache.ClearAll)
	lookup := DesktopProviderLookup{st, cloud, cache}
	if _, err := st.SaveConnection(ctx, "http://gateway.test", "token-a"); err != nil {
		t.Fatal(err)
	}
	snapshot := []CachedProvider{{ID: id, APIKeySet: true, UpdatedAt: version}}
	if err := st.SaveCachedProviders(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			p, err := lookup.Get(ctx, id)
			if err != nil || p.APIKey != "key-a" {
				t.Errorf("same version did not resolve: %v", err)
			}
		})
	}
	<-started
	close(release)
	wg.Wait()
	if hits.Load() != 1 {
		t.Fatalf("credential requests = %d; want 1", hits.Load())
	}

	cache.nowFn = func() time.Time { return time.Now().Add(2 * defaultCredentialTTL) }
	if err := st.ClearLocalCache(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCachedProviders(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	// Start a fetch and hold the response while SQLite retires the old generation.
	oldStarted, oldRelease := make(chan struct{}), make(chan struct{})
	cloud.SetHTTPClient(&http.Client{Transport: desktopRoundTripper(func(r *http.Request) (*http.Response, error) {
		key := "key-b"
		if r.Header.Get("Authorization") == "Bearer token-a" {
			close(oldStarted)
			<-oldRelease
			key = "key-a"
		}
		raw, _ := json.Marshal(service.ProviderRuntimeCredential{ProviderID: id, UpdatedAt: version, APIKey: key})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw))}, nil
	})})
	old := make(chan error, 1)
	go func() { _, err := lookup.Get(ctx, id); old <- err }()
	<-oldStarted
	t.Cleanup(func() {
		select {
		case <-oldRelease:
		default:
			close(oldRelease)
		}
	})
	oldRevision := st.providerSnapshotRevision()
	if _, err := st.SaveConnection(ctx, "http://gateway.test", "token-b"); err != nil {
		t.Fatal(err)
	}
	cloud.SetCredentials("http://gateway.test", "token-b")
	if err := st.publishProviders(ctx, oldRevision, snapshot); err == nil {
		t.Fatal("old list was allowed to repopulate snapshot")
	}
	if err := st.SaveCachedProviders(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	p, err := lookup.Get(ctx, id)
	if err != nil || p.APIKey != "key-b" {
		t.Fatalf("new connection did not resolve: %v", err)
	}
	close(oldRelease)
	if err := <-old; err == nil {
		t.Fatal("old credential was returned after switch")
	}
	if st.loadProviderKey(ctx, id, version) != "key-b" {
		t.Fatal("old credential overwrote the new encrypted key")
	}

	snapshot[0].APIKeySet = false
	snapshot[0].UpdatedAt = version.Add(time.Second)
	if err := st.SaveCachedProviders(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	p, err = lookup.Get(ctx, id)
	if err != nil || p.APIKey != "" || st.loadProviderKey(ctx, id, version) != "" {
		t.Fatalf("clearing key retained the previous version: %v", err)
	}
	if err := st.SaveCachedProviders(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := lookup.Get(ctx, id); err == nil {
		t.Fatal("deleted provider remained available")
	}
}
