package desktop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

	// Verify cached models/compat survive while zero plaintext API keys ever hit SQLite disk.
	cachedProvs, err := st.LoadCachedProviders(ctx)
	if err != nil || len(cachedProvs) != 1 || cachedProvs[0].Models[0].Compat.CacheMode != domain.CacheModeExplicit {
		t.Fatalf("expected cached models/compat preserved, got %+v err=%v", cachedProvs, err)
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
