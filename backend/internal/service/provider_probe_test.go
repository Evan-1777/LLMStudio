package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"llmstudio/backend/internal/domain"
)

func TestModelListProtocolDecoupledFromFirstModelAndStrictPayloads(t *testing.T) {
	ctx := context.Background()
	provSvc, _, _, _, _, _ := setupServiceTestEnv(t)

	// 1. Bearer aggregator whose first configured model is google-generative-ai MUST still request /v1/models.
	var seenPath string
	var seenAuth string
	aggSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "gpt-4.1"},
				{"id": "claude-3-7-sonnet"},
				{"id": "gemini-2.5-pro"},
			},
		})
	}))
	defer aggSrv.Close()

	pAgg, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-agg",
		Name:     "Mixed Aggregator",
		Adapter:  "generic-http",
		BaseURL:  aggSrv.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-agg-sentinel",
		Models: []domain.ModelConfig{
			{ID: "gemini-2.5-pro", Name: "Gemini 2.5 Pro", APIFormat: "google-generative-ai"},
			{ID: "claude-3-7-sonnet", Name: "Claude 3.7", APIFormat: "anthropic-messages"},
		},
	})
	if err != nil {
		t.Fatalf("create pAgg: %v", err)
	}
	models, err := provSvc.FetchUpstreamModels(ctx, pAgg.ID, ProviderProbeInput{})
	if err != nil {
		t.Fatalf("fetch mixed aggregator models: %v", err)
	}
	if seenPath != "/v1/models" || seenAuth != "Bearer sk-agg-sentinel" {
		t.Fatalf("unexpected mixed aggregator request: path=%q auth=%q", seenPath, seenAuth)
	}
	if len(models) != 3 || models[0].APIFormat != "openai-completions" || models[1].APIFormat != "anthropic-messages" || models[2].APIFormat != "google-generative-ai" {
		t.Fatalf("unexpected normalized formats: %+v", models)
	}

	// 2. Unknown JSON payloads must NOT be silently treated as an empty model list.
	unknownSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tags":[{"name":"llama3"}]}`))
	}))
	defer unknownSrv.Close()
	_, _ = provSvc.Create(ctx, ProviderInput{
		ID:       "p-unknown",
		Name:     "Unknown Payload",
		Adapter:  "generic-http",
		BaseURL:  unknownSrv.URL,
		AuthType: domain.AuthTypeNone,
	})
	if _, err := provSvc.FetchUpstreamModels(ctx, "p-unknown", ProviderProbeInput{}); err == nil {
		t.Fatal("expected unknown JSON payload to return error instead of empty list")
	}

	// 3. Valid empty array and empty data[] remain valid empty lists.
	emptyArrSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer emptyArrSrv.Close()
	_, _ = provSvc.Create(ctx, ProviderInput{
		ID:       "p-empty",
		Name:     "Empty Array",
		Adapter:  "generic-http",
		BaseURL:  emptyArrSrv.URL,
		AuthType: domain.AuthTypeNone,
	})
	if got, err := provSvc.FetchUpstreamModels(ctx, "p-empty", ProviderProbeInput{}); err != nil || len(got) != 0 {
		t.Fatalf("expected valid empty array, got err=%v len=%d", err, len(got))
	}
}

func TestProbeSafeErrorsDraftIsolationAndCrossOriginRedirects(t *testing.T) {
	ctx := context.Background()
	provSvc, _, _, _, _, _ := setupServiceTestEnv(t)

	const secretSentinel = "SECRET_SENTINEL_XYZ_999"
	const headerSentinel = "HEADER_SENTINEL_ABC_777"

	// 1. HTML 502 must only expose safe HTTP status summary, never raw HTML or secrets.
	html502Srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html><body>502 Bad Gateway internal-host " + secretSentinel + "</body></html>"))
	}))
	defer html502Srv.Close()

	_, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-502",
		Name:     "HTML 502",
		Adapter:  "generic-http",
		BaseURL:  html502Srv.URL,
		AuthType: domain.AuthTypeQueryKey,
		APIKey:   secretSentinel,
		Headers:  map[string]string{"X-Custom-Secret": headerSentinel},
	})
	if err != nil {
		t.Fatalf("create p-502: %v", err)
	}
	_, err = provSvc.FetchUpstreamModels(ctx, "p-502", ProviderProbeInput{})
	if err == nil {
		t.Fatal("expected error for 502")
	}
	errMsg := err.Error()
	if !strings.Contains(errMsg, "502") {
		t.Fatalf("expected HTTP 502 in error message, got %q", errMsg)
	}
	for _, forbidden := range []string{"<html>", "internal-host", secretSentinel, headerSentinel, html502Srv.URL} {
		if strings.Contains(errMsg, forbidden) {
			t.Fatalf("error message leaked %q: %q", forbidden, errMsg)
		}
	}

	// 2. Network failure on query-key provider must NOT leak URL/query key sentinel.
	deadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := deadSrv.URL
	deadSrv.Close()
	_, _ = provSvc.Create(ctx, ProviderInput{
		ID:       "p-dead",
		Name:     "Dead Gemini",
		Adapter:  "generic-http",
		BaseURL:  deadURL + "/v1beta",
		AuthType: domain.AuthTypeQueryKey,
		APIKey:   secretSentinel,
	})
	_, err = provSvc.FetchUpstreamModels(ctx, "p-dead", ProviderProbeInput{})
	if err == nil {
		t.Fatal("expected network error")
	}
	if strings.Contains(err.Error(), secretSentinel) || strings.Contains(err.Error(), deadURL) {
		t.Fatalf("network error leaked secret or URL: %q", err.Error())
	}

	// 3. Rewriting baseURL in draft MUST NOT inherit saved APIKey or saved headers.
	var rewrittenAuth, rewrittenCustomHeader string
	var rewrittenHits atomic.Int32
	otherTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rewrittenHits.Add(1)
		rewrittenAuth = r.Header.Get("Authorization")
		rewrittenCustomHeader = r.Header.Get("X-Custom-Secret")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "draft-ok"}}})
	}))
	defer otherTarget.Close()

	_, _ = provSvc.Create(ctx, ProviderInput{
		ID:       "p-saved",
		Name:     "Saved Provider",
		Adapter:  "generic-http",
		BaseURL:  html502Srv.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   secretSentinel,
		Headers:  map[string]string{"X-Custom-Secret": headerSentinel},
	})

	// Draft changes baseURL without explicit apiKey -> Bearer adapter requires apiKey, so rejected (saved key NOT inherited).
	if _, err := provSvc.FetchUpstreamModels(ctx, "p-saved", ProviderProbeInput{
		BaseURL: otherTarget.URL,
	}); err == nil {
		t.Fatal("expected rewritten baseURL without explicit key to fail instead of inheriting saved key")
	}
	if rewrittenHits.Load() != 0 {
		t.Fatalf("rewritten target should not have been called with saved key, hits=%d", rewrittenHits.Load())
	}

	// Draft changes baseURL WITH explicit draft key -> succeeds using ONLY explicit key, without saved headers.
	models, err := provSvc.FetchUpstreamModels(ctx, "p-saved", ProviderProbeInput{
		BaseURL: otherTarget.URL,
		APIKey:  "explicit-draft-key",
	})
	if err != nil || len(models) != 1 {
		t.Fatalf("expected explicit draft probe to succeed, err=%v models=%+v", err, models)
	}
	if rewrittenAuth != "Bearer explicit-draft-key" || rewrittenCustomHeader != "" {
		t.Fatalf("draft probe leaked saved headers or wrong auth: auth=%q header=%q", rewrittenAuth, rewrittenCustomHeader)
	}

	// 4. Cross-origin redirect MUST strip Authorization, custom headers, and query credentials.
	var redirAuth, redirHeader, redirQuery string
	targetB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirAuth = r.Header.Get("Authorization")
		redirHeader = r.Header.Get("X-Custom-Secret")
		redirQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "after-redir"}}})
	}))
	defer targetB.Close()

	originA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, targetB.URL+"/v1/models?key="+secretSentinel, http.StatusFound)
	}))
	defer originA.Close()

	_, _ = provSvc.Create(ctx, ProviderInput{
		ID:       "p-redir",
		Name:     "Redirecting Provider",
		Adapter:  "generic-http",
		BaseURL:  originA.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   secretSentinel,
		Headers:  map[string]string{"X-Custom-Secret": headerSentinel},
	})
	if _, err := provSvc.FetchUpstreamModels(ctx, "p-redir", ProviderProbeInput{}); err != nil {
		t.Fatalf("redirect probe failed: %v", err)
	}
	if strings.Contains(redirAuth, secretSentinel) || strings.Contains(redirHeader, headerSentinel) || strings.Contains(redirQuery, secretSentinel) {
		t.Fatalf("cross-origin redirect leaked credentials: auth=%q header=%q query=%q", redirAuth, redirHeader, redirQuery)
	}
}
