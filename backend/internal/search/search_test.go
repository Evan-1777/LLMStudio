package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestSearchRegistryAndEngines(t *testing.T) {
	reg := plugin.NewSearchRegistry()
	tavilySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		var req struct {
			APIKey     string `json:"api_key"`
			Query      string `json:"query"`
			MaxResults int    `json:"max_results"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode tavily req: %v", err)
		}
		if req.APIKey != "tvly-test" || req.Query != "go 1.27" || req.MaxResults != 2 {
			t.Fatalf("unexpected tavily payload: %+v", req)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"title": "Go Blog", "url": "https://go.dev/blog", "content": "Go updates"},
				{"title": "Docs", "url": "https://go.dev/doc", "content": "Documentation"},
				{"title": "Extra", "url": "https://go.dev/extra", "content": "Ignored"},
			},
		})
	}))
	defer tavilySrv.Close()

	searxSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("expected GET, got %s", r.Method)
		}
		if r.URL.Query().Get("q") != "llmstudio" || r.URL.Query().Get("format") != "json" {
			t.Fatalf("unexpected searxng query: %v", r.URL.Query())
		}
		if r.Header.Get("Authorization") != "Bearer sx-secret" {
			t.Fatalf("unexpected searxng auth header: %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"title": "LLMStudio", "url": "https://example.com", "content": "Workspace"},
			},
		})
	}))
	defer searxSrv.Close()

	tavily := NewTavilyEngine(tavilySrv.Client())
	searxng := NewSearXNGEngine(searxSrv.Client())
	reg.MustRegister(tavily)
	reg.MustRegister(searxng)

	if !reg.Has("tavily") || !reg.Has("searxng") || len(reg.List()) != 2 {
		t.Fatalf("unexpected registry list: %+v", reg.List())
	}

	results, err := tavily.Search(context.Background(), plugin.SearchQueryInput{
		Query:      "go 1.27",
		Endpoint:   tavilySrv.URL,
		APIKey:     "tvly-test",
		MaxResults: 2,
	})
	if err != nil {
		t.Fatalf("tavily search failed: %v", err)
	}
	if len(results) != 2 || results[0].Title != "Go Blog" || results[0].Snippet != "Go updates" {
		t.Fatalf("unexpected tavily results: %+v", results)
	}

	if _, err := tavily.Search(context.Background(), plugin.SearchQueryInput{Query: "hi"}); err == nil {
		t.Fatal("expected missing API key error for tavily")
	}

	sxResults, err := searxng.Search(context.Background(), plugin.SearchQueryInput{
		Query:      "llmstudio",
		Endpoint:   searxSrv.URL + "/search",
		APIKey:     "sx-secret",
		MaxResults: 5,
	})
	if err != nil {
		t.Fatalf("searxng search failed: %v", err)
	}
	if len(sxResults) != 1 || sxResults[0].URL != "https://example.com" {
		t.Fatalf("unexpected searxng results: %+v", sxResults)
	}
}

func TestSearchTimeoutAndErrorHandling(t *testing.T) {
	slowSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer slowSrv.Close()

	engine := NewSearXNGEngine(slowSrv.Client())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := engine.Search(ctx, plugin.SearchQueryInput{
		Query:    "timeout",
		Endpoint: slowSrv.URL,
	})
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeUpstreamError {
		t.Fatalf("expected UPSTREAM_ERROR, got %v", err)
	}
}
