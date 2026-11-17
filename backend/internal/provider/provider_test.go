package provider

import (
	"context"
	"net/url"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

func TestGenericHTTPAdapterAuthModes(t *testing.T) {
	adapter := NewGenericHTTPAdapter()
	model := domain.ModelConfig{ID: "gemini-2.5-flash"}

	t.Run("bearer with /v1 deduplication", func(t *testing.T) {
		ep, err := adapter.ResolveEndpoint(
			domain.ProviderConfig{
				Name:     "OpenAI",
				BaseURL:  "https://api.openai.com/v1",
				AuthType: domain.AuthTypeBearer,
				APIKey:   "sk-123",
			},
			model,
			"/v1/chat/completions",
			nil,
			domain.CompatConfig{},
		)
		if err != nil {
			t.Fatalf("ResolveEndpoint failed: %v", err)
		}
		if ep.URL != "https://api.openai.com/v1/chat/completions" {
			t.Fatalf("unexpected URL: %q", ep.URL)
		}
		if ep.Headers.Get("Authorization") != "Bearer sk-123" {
			t.Fatalf("missing bearer header: %v", ep.Headers)
		}
	})

	t.Run("x-api-key", func(t *testing.T) {
		ep, err := adapter.ResolveEndpoint(
			domain.ProviderConfig{
				Name:     "Anthropic",
				BaseURL:  "https://api.anthropic.com",
				AuthType: domain.AuthTypeXAPIKey,
				APIKey:   "ant-key",
			},
			model,
			"/v1/messages",
			nil,
			domain.CompatConfig{},
		)
		if err != nil {
			t.Fatalf("ResolveEndpoint failed: %v", err)
		}
		if ep.Headers.Get("x-api-key") != "ant-key" {
			t.Fatalf("missing x-api-key header: %v", ep.Headers)
		}
	})

	t.Run("query-key with model template and alt=sse", func(t *testing.T) {
		q := url.Values{"alt": []string{"sse"}}
		ep, err := adapter.ResolveEndpoint(
			domain.ProviderConfig{
				Name:     "Gemini",
				BaseURL:  "https://generativelanguage.googleapis.com/v1beta",
				AuthType: domain.AuthTypeQueryKey,
				APIKey:   "gem-key",
			},
			model,
			"/v1beta/models/{model}:streamGenerateContent",
			q,
			domain.CompatConfig{},
		)
		if err != nil {
			t.Fatalf("ResolveEndpoint failed: %v", err)
		}
		parsed, _ := url.Parse(ep.URL)
		if parsed.Path != "/v1beta/models/gemini-2.5-flash:streamGenerateContent" {
			t.Fatalf("unexpected gemini path: %q", parsed.Path)
		}
		if parsed.Query().Get("key") != "gem-key" || parsed.Query().Get("alt") != "sse" {
			t.Fatalf("unexpected gemini query: %s", parsed.RawQuery)
		}
	})

	t.Run("header-key with custom header name", func(t *testing.T) {
		ep, err := adapter.ResolveEndpoint(
			domain.ProviderConfig{
				Name:     "Azure",
				BaseURL:  "https://azure.example.com",
				AuthType: domain.AuthTypeHeaderKey,
				APIKey:   "az-key",
				Headers:  map[string]string{"X-Auth-Header": "api-key"},
			},
			model,
			"/openai/deployments/gpt/chat/completions",
			nil,
			domain.CompatConfig{},
		)
		if err != nil {
			t.Fatalf("ResolveEndpoint failed: %v", err)
		}
		if ep.Headers.Get("api-key") != "az-key" || ep.Headers.Get("X-Auth-Header") != "" {
			t.Fatalf("unexpected custom headers: %v", ep.Headers)
		}
	})

	t.Run("none auth skips key check", func(t *testing.T) {
		ep, err := adapter.ResolveEndpoint(
			domain.ProviderConfig{
				Name:     "Local",
				BaseURL:  "http://localhost:11434/v1",
				AuthType: domain.AuthTypeNone,
			},
			model,
			"/v1/chat/completions",
			nil,
			domain.CompatConfig{},
		)
		if err != nil {
			t.Fatalf("expected none auth to succeed without key: %v", err)
		}
		if ep.Headers.Get("Authorization") != "" {
			t.Fatalf("unexpected auth header: %v", ep.Headers)
		}
	})
}

func TestSeedBuiltInProvidersNonDestructive(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	providers := store.NewProviderStore(db)
	if err := SeedBuiltInProviders(ctx, providers); err != nil {
		t.Fatalf("first SeedBuiltInProviders failed: %v", err)
	}

	openai, err := providers.Get(ctx, "openai")
	if err != nil {
		t.Fatalf("get seeded openai: %v", err)
	}
	openai.BaseURL = "https://proxy.myvps.example/v1"
	openai.APIKey = "sk-custom-user"
	if _, err := providers.Update(ctx, openai); err != nil {
		t.Fatalf("update openai: %v", err)
	}

	if err := SeedBuiltInProviders(ctx, providers); err != nil {
		t.Fatalf("second SeedBuiltInProviders failed: %v", err)
	}
	after, err := providers.Get(ctx, "openai")
	if err != nil {
		t.Fatalf("get openai after reseed: %v", err)
	}
	if after.BaseURL != "https://proxy.myvps.example/v1" || after.APIKey != "sk-custom-user" {
		t.Fatalf("SeedBuiltInProviders overwrote user configuration: %+v", after)
	}
}
