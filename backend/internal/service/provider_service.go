package service

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/store"
)

// ProviderInput represents a create or update request for a provider configuration.
type ProviderInput struct {
	ID          string              `json:"id,omitempty"`
	Name        string              `json:"name"`
	Adapter     string              `json:"adapter"`
	BaseURL     string              `json:"baseURL"`
	AuthType    string              `json:"authType"`
	APIKey      string              `json:"apiKey,omitempty"`
	ClearAPIKey bool                `json:"clearApiKey,omitempty"`
	Headers     map[string]string   `json:"headers,omitempty"`
	Models      []domain.ModelConfig `json:"models"`
	Enabled     *bool               `json:"enabled,omitempty"`
}

// ProviderService manages provider configurations and validates format/adapter bindings.
type ProviderService struct {
	store     *store.ProviderStore
	formats   *plugin.FormatRegistry
	providers *plugin.ProviderRegistry
}

// NewProviderService constructs a ProviderService.
func NewProviderService(
	store *store.ProviderStore,
	formats *plugin.FormatRegistry,
	providers *plugin.ProviderRegistry,
) *ProviderService {
	return &ProviderService{
		store:     store,
		formats:   formats,
		providers: providers,
	}
}

// List returns all configured providers.
func (s *ProviderService) List(ctx context.Context) ([]domain.ProviderConfig, error) {
	return s.store.List(ctx)
}

// Get returns a single provider by ID.
func (s *ProviderService) Get(ctx context.Context, id string) (domain.ProviderConfig, error) {
	return s.store.Get(ctx, id)
}

// Create validates and persists a new provider configuration.
func (s *ProviderService) Create(ctx context.Context, in ProviderInput) (domain.ProviderConfig, error) {
	cfg := domain.ProviderConfig{
		ID:       strings.TrimSpace(in.ID),
		Name:     strings.TrimSpace(in.Name),
		Adapter:  strings.TrimSpace(in.Adapter),
		BaseURL:  strings.TrimSpace(in.BaseURL),
		AuthType: strings.TrimSpace(in.AuthType),
		APIKey:   strings.TrimSpace(in.APIKey),
		Headers:  in.Headers,
		Models:   in.Models,
		Enabled:  true,
	}
	if in.Enabled != nil {
		cfg.Enabled = *in.Enabled
	}
	if err := s.normalizeAndValidate(&cfg); err != nil {
		return domain.ProviderConfig{}, err
	}
	return s.store.Create(ctx, cfg)
}

// Update validates and updates an existing provider configuration, preserving APIKey unless overridden or cleared.
func (s *ProviderService) Update(ctx context.Context, id string, in ProviderInput) (domain.ProviderConfig, error) {
	existing, err := s.store.Get(ctx, id)
	if err != nil {
		return domain.ProviderConfig{}, err
	}

	cfg := existing
	if name := strings.TrimSpace(in.Name); name != "" {
		cfg.Name = name
	}
	if adapter := strings.TrimSpace(in.Adapter); adapter != "" {
		cfg.Adapter = adapter
	}
	if baseURL := strings.TrimSpace(in.BaseURL); baseURL != "" {
		cfg.BaseURL = baseURL
	}
	if authType := strings.TrimSpace(in.AuthType); authType != "" {
		cfg.AuthType = authType
	}
	if in.ClearAPIKey {
		cfg.APIKey = ""
	} else if key := strings.TrimSpace(in.APIKey); key != "" {
		cfg.APIKey = key
	}
	if in.Headers != nil {
		cfg.Headers = in.Headers
	}
	if in.Models != nil {
		cfg.Models = in.Models
	}
	if in.Enabled != nil {
		cfg.Enabled = *in.Enabled
	}

	if err := s.normalizeAndValidate(&cfg); err != nil {
		return domain.ProviderConfig{}, err
	}
	return s.store.Update(ctx, cfg)
}

// Delete removes a provider by ID.
func (s *ProviderService) Delete(ctx context.Context, id string) error {
	return s.store.Delete(ctx, id)
}

func (s *ProviderService) normalizeAndValidate(cfg *domain.ProviderConfig) error {
	if cfg.Name == "" {
		return domain.NewError(domain.ErrCodeInvalidArgument, "provider name is required", nil)
	}
	if cfg.Adapter == "" {
		cfg.Adapter = "generic-http"
	}
	if !s.providers.Has(cfg.Adapter) {
		return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unknown provider adapter %q", cfg.Adapter), nil)
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return domain.NewError(domain.ErrCodeInvalidArgument, "valid baseURL with scheme and host is required", err)
	}
	if cfg.AuthType == "" {
		cfg.AuthType = domain.AuthTypeBearer
	}
	switch cfg.AuthType {
	case domain.AuthTypeBearer, domain.AuthTypeXAPIKey, domain.AuthTypeQueryKey, domain.AuthTypeHeaderKey, domain.AuthTypeNone:
	default:
		return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unsupported authType %q", cfg.AuthType), nil)
	}

	seenModels := make(map[string]struct{}, len(cfg.Models))
	for i := range cfg.Models {
		m := &cfg.Models[i]
		m.ID = strings.TrimSpace(m.ID)
		m.Name = strings.TrimSpace(m.Name)
		m.APIFormat = strings.TrimSpace(m.APIFormat)
		if m.ID == "" {
			return domain.NewError(domain.ErrCodeInvalidArgument, "model id is required", nil)
		}
		if _, dup := seenModels[m.ID]; dup {
			return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("duplicate model id %q", m.ID), nil)
		}
		seenModels[m.ID] = struct{}{}
		if m.Name == "" {
			m.Name = m.ID
		}
		if m.APIFormat == "" || !s.formats.Has(m.APIFormat) {
			return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unknown apiFormat %q for model %q", m.APIFormat, m.ID), nil)
		}
	}
	return nil
}
