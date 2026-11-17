package plugin

import (
	"context"
	"io"
	"net/url"
	"testing"

	"llmstudio/backend/internal/domain"
)

type stubFormat struct{ id string }

func (s stubFormat) ID() string          { return s.id }
func (s stubFormat) DisplayName() string { return "Stub " + s.id }
func (s stubFormat) DefaultPath() string { return "/v1/stub" }
func (s stubFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{MaxTokensField: "max_tokens"}
}
func (s stubFormat) EncodeRequest(context.Context, ChatInput) (EncodedRequest, error) {
	return EncodedRequest{}, nil
}
func (s stubFormat) DecodeStream(context.Context, io.Reader, func(domain.StreamEvent) error) error {
	return nil
}

type stubAdapter struct{ id string }

func (s stubAdapter) ID() string          { return s.id }
func (s stubAdapter) DisplayName() string { return "Adapter " + s.id }
func (s stubAdapter) ResolveEndpoint(domain.ProviderConfig, domain.ModelConfig, string, url.Values, domain.CompatConfig) (ResolvedEndpoint, error) {
	return ResolvedEndpoint{}, nil
}

func TestRegistriesAndSyncState(t *testing.T) {
	formats := NewFormatRegistry()
	if err := formats.Register(stubFormat{id: "openai-completions"}); err != nil {
		t.Fatalf("register format failed: %v", err)
	}
	if err := formats.Register(stubFormat{id: "openai-completions"}); err == nil {
		t.Fatal("expected duplicate format registration error")
	}
	if !formats.Has("openai-completions") || len(formats.List()) != 1 || formats.List()[0].DefaultPath != "/v1/stub" {
		t.Fatalf("unexpected formats registry state: %+v", formats.List())
	}

	providers := NewProviderRegistry()
	if err := providers.Register(stubAdapter{id: "generic-http"}); err != nil {
		t.Fatalf("register provider failed: %v", err)
	}
	if err := providers.Register(stubAdapter{id: "generic-http"}); err == nil {
		t.Fatal("expected duplicate provider registration error")
	}
	if !providers.Has("generic-http") || len(providers.List()) != 1 {
		t.Fatalf("unexpected providers registry state: %+v", providers.List())
	}

	if !ValidSyncState(string(SyncStateLocalOnly)) || !ValidSyncState(string(SyncStateConflict)) {
		t.Fatal("expected valid sync states to return true")
	}
	if ValidSyncState("unknown") {
		t.Fatal("expected unknown sync state to return false")
	}
}
