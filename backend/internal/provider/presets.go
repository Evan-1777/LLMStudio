package provider

import (
	"context"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

// BuiltInPresets returns default built-in provider configurations bound to registered formats.
func BuiltInPresets() []domain.ProviderConfig {
	now := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	return []domain.ProviderConfig{
		{
			ID:        "openai",
			Name:      "OpenAI",
			Adapter:   AdapterGenericHTTP,
			BaseURL:   "https://api.openai.com/v1",
			AuthType:  domain.AuthTypeBearer,
			Enabled:   true,
			BuiltIn:   true,
			CreatedAt: now,
			UpdatedAt: now,
			Models: []domain.ModelConfig{
				{
					ID:              "gpt-4.1",
					Name:            "GPT-4.1",
					APIFormat:       "openai-responses",
					ContextWindow:   1047576,
					MaxTokens:       32768,
					InputModalities: []string{"text", "image"},
				},
				{
					ID:              "gpt-4o",
					Name:            "GPT-4o",
					APIFormat:       "openai-completions",
					ContextWindow:   128000,
					MaxTokens:       16384,
					InputModalities: []string{"text", "image"},
				},
				{
					ID:              "o4-mini",
					Name:            "o4-mini",
					APIFormat:       "openai-responses",
					ContextWindow:   200000,
					MaxTokens:       100000,
					Reasoning:       true,
					InputModalities: []string{"text", "image"},
				},
			},
		},
		{
			ID:        "anthropic",
			Name:      "Anthropic",
			Adapter:   AdapterGenericHTTP,
			BaseURL:   "https://api.anthropic.com",
			AuthType:  domain.AuthTypeXAPIKey,
			Enabled:   true,
			BuiltIn:   true,
			CreatedAt: now,
			UpdatedAt: now,
			Models: []domain.ModelConfig{
				{
					ID:              "claude-sonnet-4-5",
					Name:            "Claude Sonnet 4.5",
					APIFormat:       "anthropic-messages",
					ContextWindow:   200000,
					MaxTokens:       16384,
					Reasoning:       true,
					InputModalities: []string{"text", "image"},
				},
				{
					ID:              "claude-3-5-haiku-latest",
					Name:            "Claude 3.5 Haiku",
					APIFormat:       "anthropic-messages",
					ContextWindow:   200000,
					MaxTokens:       8192,
					InputModalities: []string{"text", "image"},
				},
			},
		},
		{
			ID:        "google-gemini",
			Name:      "Google Gemini",
			Adapter:   AdapterGenericHTTP,
			BaseURL:   "https://generativelanguage.googleapis.com/v1beta",
			AuthType:  domain.AuthTypeQueryKey,
			Enabled:   true,
			BuiltIn:   true,
			CreatedAt: now,
			UpdatedAt: now,
			Models: []domain.ModelConfig{
				{
					ID:              "gemini-2.5-flash",
					Name:            "Gemini 2.5 Flash",
					APIFormat:       "google-generative-ai",
					ContextWindow:   1048576,
					MaxTokens:       65536,
					Reasoning:       true,
					InputModalities: []string{"text", "image"},
				},
				{
					ID:              "gemini-2.5-pro",
					Name:            "Gemini 2.5 Pro",
					APIFormat:       "google-generative-ai",
					ContextWindow:   1048576,
					MaxTokens:       65536,
					Reasoning:       true,
					InputModalities: []string{"text", "image"},
				},
			},
		},
		{
			ID:        "openai-compatible",
			Name:      "OpenAI Compatible",
			Adapter:   AdapterGenericHTTP,
			BaseURL:   "http://localhost:11434/v1",
			AuthType:  domain.AuthTypeNone,
			Enabled:   false,
			BuiltIn:   true,
			CreatedAt: now,
			UpdatedAt: now,
			Models: []domain.ModelConfig{
				{
					ID:              "llama3.2",
					Name:            "Llama 3.2",
					APIFormat:       "openai-completions",
					ContextWindow:   131072,
					MaxTokens:       8192,
					InputModalities: []string{"text"},
					Compat: domain.CompatConfig{
						MaxTokensField:        "max_tokens",
						SupportsDeveloperRole: domain.BoolPtr(false),
					},
				},
			},
		},
	}
}

// SeedBuiltInProviders inserts missing built-in presets without overwriting user-saved configs.
func SeedBuiltInProviders(ctx context.Context, providers *store.ProviderStore) error {
	for _, preset := range BuiltInPresets() {
		if err := providers.EnsureBuiltIn(ctx, preset); err != nil {
			return err
		}
	}
	return nil
}
