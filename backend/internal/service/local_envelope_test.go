package service

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/store"
)

func TestPrepareLocalCredentialEnvelopeFollowsAdapterAuth(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provSvc := NewProviderService(provStore, formats, adapters)
	convSvc := NewConversationService(convStore, msgStore)
	chatSvc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{})

	cases := []struct {
		name     string
		authType string
		headers  map[string]string
		key      string
		// assert proves the credential reached the envelope in the adapter's own shape.
		assert func(t *testing.T, prep PreparedLocalRequest)
	}{
		{
			name: "bearer", authType: domain.AuthTypeBearer, key: "sk-bearer",
			assert: func(t *testing.T, prep PreparedLocalRequest) {
				if prep.Headers["Authorization"] != "Bearer sk-bearer" {
					t.Fatalf("bearer header missing: %+v", prep.Headers)
				}
			},
		},
		{
			name: "x-api-key", authType: domain.AuthTypeXAPIKey, key: "sk-header",
			assert: func(t *testing.T, prep PreparedLocalRequest) {
				if prep.Headers["X-Api-Key"] != "sk-header" {
					t.Fatalf("x-api-key header missing: %+v", prep.Headers)
				}
			},
		},
		{
			name: "query-key", authType: domain.AuthTypeQueryKey, key: "sk-query",
			assert: func(t *testing.T, prep PreparedLocalRequest) {
				if !strings.Contains(prep.URL, "key=sk-query") {
					t.Fatalf("query credential missing: %s", prep.URL)
				}
			},
		},
		{
			name: "header-key-template", authType: domain.AuthTypeHeaderKey, key: "sk-custom",
			headers: map[string]string{"x-auth-header": "X-Custom-Key"},
			assert: func(t *testing.T, prep PreparedLocalRequest) {
				if prep.Headers["X-Custom-Key"] != "sk-custom" {
					t.Fatalf("custom header credential missing: %+v", prep.Headers)
				}
			},
		},
		{
			name: "none", authType: domain.AuthTypeNone, key: "",
			assert: func(t *testing.T, prep PreparedLocalRequest) {
				if prep.Headers["Authorization"] != "" || strings.Contains(prep.URL, "key=") {
					t.Fatalf("authType none injected a credential: %+v", prep)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prov, err := provSvc.Create(ctx, ProviderInput{
				ID:           "p-" + tc.name,
				Name:         tc.name,
				Adapter:      "generic-http",
				BaseURL:      "https://upstream.example/v1",
				AuthType:     tc.authType,
				APIKey:       tc.key,
				Headers:      tc.headers,
				LocalRequest: domain.BoolPtr(true),
				Models: []domain.ModelConfig{{
					ID:        "m1",
					Name:      "M1",
					APIFormat: "openai-completions",
				}},
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}
			conv, err := convSvc.Create(ctx, CreateConversationInput{
				ProviderID: prov.ID,
				ModelID:    "m1",
			})
			if err != nil {
				t.Fatalf("create conversation: %v", err)
			}

			// Legacy clients keep the credential-free shape.
			plain, err := chatSvc.PrepareLocal(ctx, StreamChatInput{
				ConversationID: conv.ID,
				Text:           "hello",
			})
			if err != nil {
				t.Fatalf("PrepareLocal without envelope: %v", err)
			}
			if plain.Headers["Authorization"] != "" || strings.Contains(plain.URL, tc.key) && tc.key != "" {
				t.Fatalf("default envelope leaked a credential: %+v", plain)
			}
			if tc.key != "" && strings.Contains(string(plain.Body), tc.key) {
				t.Fatalf("default envelope leaked a credential in the body")
			}

			// An explicit request receives the credential bound to the saved target.
			prep, err := chatSvc.PrepareLocal(ctx, StreamChatInput{
				ConversationID:     conv.ID,
				Text:               "hello",
				CredentialEnvelope: true,
			})
			if err != nil {
				t.Fatalf("PrepareLocal with envelope: %v", err)
			}
			if !strings.HasPrefix(prep.URL, "https://upstream.example/v1/") {
				t.Fatalf("envelope must target the saved provider: %s", prep.URL)
			}
			tc.assert(t, prep)
		})
	}
}
