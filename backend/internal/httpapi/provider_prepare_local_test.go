package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestPrepareLocalModelsEndpoint(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	formats.MustRegister(format.NewGoogleGenAIFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provSvc := service.NewProviderService(store.NewProviderStore(db), formats, adapters)
	localTrue := true
	localFalse := false
	_, err = provSvc.Create(ctx, service.ProviderInput{
		ID:           "p-local",
		Name:         "Local Provider",
		Adapter:      "generic-http",
		BaseURL:      "http://127.0.0.1:11434/v1",
		AuthType:     domain.AuthTypeBearer,
		APIKey:       "sk-local-secret",
		LocalRequest: &localTrue,
		Models: []domain.ModelConfig{
			{ID: "gemini-2.5-flash", Name: "Gemini", APIFormat: "google-generative-ai"},
		},
	})
	if err != nil {
		t.Fatalf("create local provider: %v", err)
	}
	_, err = provSvc.Create(ctx, service.ProviderInput{
		ID:           "p-normal",
		Name:         "Normal Provider",
		Adapter:      "generic-http",
		BaseURL:      "https://api.example.com/v1",
		AuthType:     domain.AuthTypeBearer,
		APIKey:       "sk-normal-secret",
		LocalRequest: &localFalse,
	})
	if err != nil {
		t.Fatalf("create normal provider: %v", err)
	}

	router := NewRouter(RouterDeps{
		Config:          config.Config{AccessToken: "gw-tok", DevMode: false},
		Formats:         formats,
		Adapters:        adapters,
		ProviderService: provSvc,
	})

	doPost := func(path, token string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	// 1. Missing auth rejected.
	if rec := doPost("/api/v1/providers/p-local/models/prepare-local", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", rec.Code)
	}

	// 2. Non-localRequest provider rejected with 409 CONFLICT.
	if rec := doPost("/api/v1/providers/p-normal/models/prepare-local", "gw-tok", nil); rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for non-local provider, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 3. Target/credential overrides rejected with 400.
	if rec := doPost("/api/v1/providers/p-local/models/prepare-local", "gw-tok", []byte(`{"baseURL":"https://evil.example"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for override body, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 4. Valid saved localRequest provider returns no-store envelope using decoupled /v1/models path.
	rec := doPost("/api/v1/providers/p-local/models/prepare-local", "gw-tok", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("missing no-store headers: cc=%q pragma=%q", rec.Header().Get("Cache-Control"), rec.Header().Get("Pragma"))
	}
	var env service.PreparedLocalModelProbe
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if env.Method != http.MethodGet || env.URL != "http://127.0.0.1:11434/v1/models" || env.Headers["Authorization"] != "Bearer sk-local-secret" || env.DefaultFormat != "openai-completions" {
		t.Fatalf("unexpected prepared envelope: %+v", env)
	}
}
