package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/store"
)

// ProviderProbeInput defines optional unsaved overrides when probing a provider connection or fetching models.
type ProviderProbeInput struct {
	BaseURL  string            `json:"baseURL,omitempty"`
	AuthType string            `json:"authType,omitempty"`
	APIKey   string            `json:"apiKey,omitempty"`
	Headers  map[string]string `json:"headers,omitempty"`
}

// ProviderConnectionResult summarizes a provider connectivity check.
type ProviderConnectionResult struct {
	OK         bool   `json:"ok"`
	LatencyMs  int64  `json:"latencyMs"`
	ModelCount int    `json:"modelCount"`
	Message    string `json:"message"`
}

// ProviderInput represents a create or update request for a provider configuration.
type ProviderInput struct {
	ID           string               `json:"id,omitempty"`
	Name         string               `json:"name"`
	Adapter      string               `json:"adapter"`
	BaseURL      string               `json:"baseURL"`
	AuthType     string               `json:"authType"`
	APIKey       string               `json:"apiKey,omitempty"`
	ClearAPIKey  bool                 `json:"clearApiKey,omitempty"`
	Headers      map[string]string    `json:"headers,omitempty"`
	Models       []domain.ModelConfig `json:"models"`
	Enabled      *bool                `json:"enabled,omitempty"`
	LocalRequest *bool                `json:"localRequest,omitempty"`
}

// ProviderService manages provider configurations and validates format/adapter bindings.
type ProviderService struct {
	store      *store.ProviderStore
	formats    *plugin.FormatRegistry
	providers  *plugin.ProviderRegistry
	httpClient *http.Client
}

// NewProviderService constructs a ProviderService.
func NewProviderService(
	store *store.ProviderStore,
	formats *plugin.FormatRegistry,
	providers *plugin.ProviderRegistry,
) *ProviderService {
	return &ProviderService{
		store:      store,
		formats:    formats,
		providers:  providers,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

// WithHTTPClient configures a custom HTTP client for upstream model discovery and probing.
func (s *ProviderService) WithHTTPClient(client *http.Client) *ProviderService {
	if client != nil {
		s.httpClient = client
	}
	return s
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
	if in.LocalRequest != nil {
		cfg.LocalRequest = *in.LocalRequest
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
		// An explicit clear is a gateway-owned decision: a stale browser copy must
		// not be able to revive the credential afterwards.
		cfg.APIKey = ""
		cfg.MarkAPIKeyManaged()
	} else if key := strings.TrimSpace(in.APIKey); key != "" {
		cfg.APIKey = key
		cfg.MarkAPIKeyManaged()
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
	if in.LocalRequest != nil {
		cfg.LocalRequest = *in.LocalRequest
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

// APIKeyImportResult reports the outcome of adopting a legacy browser credential.
type APIKeyImportResult struct {
	Applied  bool                  `json:"applied"`
	Provider domain.ProviderConfig `json:"provider"`
}

// ImportAPIKey adopts a non-empty legacy browser credential for an unmanaged
// local-request provider exactly once. Failures never echo the submitted key.
func (s *ProviderService) ImportAPIKey(ctx context.Context, id, apiKey string) (APIKeyImportResult, error) {
	if strings.TrimSpace(apiKey) == "" {
		return APIKeyImportResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "apiKey is required", nil)
	}
	outcome, err := s.store.ImportAPIKey(ctx, id, apiKey)
	if err != nil {
		return APIKeyImportResult{}, err
	}
	switch outcome {
	case store.KeyImportNotFound:
		return APIKeyImportResult{}, domain.NewError(domain.ErrCodeNotFound, "provider not found", nil)
	case store.KeyImportNotEligible:
		return APIKeyImportResult{}, domain.NewError(domain.ErrCodeConflict, "provider is not in local request mode", nil)
	case store.KeyImportAlreadyManaged:
		cfg, err := s.store.Get(ctx, id)
		if err != nil {
			return APIKeyImportResult{}, err
		}
		return APIKeyImportResult{Applied: false, Provider: cfg}, nil
	}
	cfg, err := s.store.Get(ctx, id)
	if err != nil {
		return APIKeyImportResult{}, err
	}
	return APIKeyImportResult{Applied: true, Provider: cfg}, nil
}

// TestConnection probes upstream reachability by fetching the provider's model listing.
func (s *ProviderService) TestConnection(ctx context.Context, id string, probe ProviderProbeInput) (ProviderConnectionResult, error) {
	start := time.Now()
	models, err := s.FetchUpstreamModels(ctx, id, probe)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ProviderConnectionResult{}, err
	}
	return ProviderConnectionResult{
		OK:         true,
		LatencyMs:  latency,
		ModelCount: len(models),
		Message:    "连接正常",
	}, nil
}

// FetchUpstreamModels queries the upstream provider models endpoint and normalizes OpenAI, Anthropic, and Gemini responses.
func (s *ProviderService) FetchUpstreamModels(ctx context.Context, id string, probe ProviderProbeInput) ([]domain.DiscoveredModel, error) {
	cfg, err := s.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if baseURL := strings.TrimSpace(probe.BaseURL); baseURL != "" {
		cfg.BaseURL = baseURL
	}
	if authType := strings.TrimSpace(probe.AuthType); authType != "" {
		cfg.AuthType = authType
	}
	if apiKey := strings.TrimSpace(probe.APIKey); apiKey != "" {
		cfg.APIKey = apiKey
	}
	if probe.Headers != nil {
		cfg.Headers = maps.Clone(probe.Headers)
	}
	if cfg.Adapter == "" {
		cfg.Adapter = "generic-http"
	}
	if cfg.AuthType == "" {
		cfg.AuthType = domain.AuthTypeBearer
	}
	parsed, err := url.Parse(strings.TrimSpace(cfg.BaseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "valid baseURL with scheme and host is required", err)
	}
	adapter, ok := s.providers.Get(cfg.Adapter)
	if !ok {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unknown provider adapter %q", cfg.Adapter), nil)
	}

	protoKind, targetPath, defaultFormat := detectModelListProtocol(cfg)
	endpoint, err := adapter.ResolveEndpoint(cfg, domain.ModelConfig{}, targetPath, nil, domain.CompatConfig{})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.URL, nil)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "construct upstream models request failed", err)
	}
	req.Header.Set("Accept", "application/json")
	for k, vals := range endpoint.Headers {
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}
	if protoKind == "anthropic" && req.Header.Get("anthropic-version") == "" {
		req.Header.Set("anthropic-version", "2023-06-01")
	}

	client := s.httpClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("upstream request failed: %v", err), err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "failed to read upstream models response", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(body))
		if msg == "" {
			msg = resp.Status
		}
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("upstream returned HTTP %d: %s", resp.StatusCode, msg), nil)
	}

	models, err := parseDiscoveredModels(body, defaultFormat)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, err.Error(), err)
	}
	return models, nil
}

func detectModelListProtocol(cfg domain.ProviderConfig) (kind, path, defaultFormat string) {
	lowerBase := strings.ToLower(cfg.BaseURL)
	var firstFormat string
	if len(cfg.Models) > 0 {
		firstFormat = strings.TrimSpace(cfg.Models[0].APIFormat)
	}

	switch {
	case cfg.AuthType == domain.AuthTypeQueryKey ||
		strings.Contains(lowerBase, "generativelanguage") ||
		strings.Contains(lowerBase, "/v1beta") ||
		firstFormat == "google-generative-ai":
		return "gemini", "/v1beta/models", "google-generative-ai"
	case cfg.AuthType == domain.AuthTypeXAPIKey ||
		strings.Contains(lowerBase, "anthropic") ||
		firstFormat == "anthropic-messages":
		return "anthropic", "/v1/models", "anthropic-messages"
	default:
		if firstFormat == "" {
			firstFormat = "openai-completions"
		}
		return "openai", "/v1/models", firstFormat
	}
}

type discoveredStandardItem struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	DisplayName   string `json:"display_name"`
	ContextWindow int    `json:"context_window"`
	MaxTokens     int    `json:"max_tokens"`
	Reasoning     bool   `json:"reasoning"`
}

func parseDiscoveredModels(raw []byte, defaultFormat string) ([]domain.DiscoveredModel, error) {
	type geminiItem struct {
		Name             string `json:"name"`
		DisplayName      string `json:"displayName"`
		InputTokenLimit  int    `json:"inputTokenLimit"`
		OutputTokenLimit int    `json:"outputTokenLimit"`
		Thinking         bool   `json:"thinking"`
	}

	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		var items []discoveredStandardItem
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, fmt.Errorf("invalid model list array: %w", err)
		}
		return normalizeStandardModels(items, defaultFormat), nil
	}

	var envelope struct {
		Data   []discoveredStandardItem `json:"data"`
		Models []geminiItem             `json:"models"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("invalid model list JSON: %w", err)
	}
	if len(envelope.Models) > 0 {
		out := make([]domain.DiscoveredModel, 0, len(envelope.Models))
		seen := make(map[string]struct{}, len(envelope.Models))
		for _, m := range envelope.Models {
			id := strings.TrimSpace(strings.TrimPrefix(m.Name, "models/"))
			if id == "" {
				continue
			}
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			name := strings.TrimSpace(m.DisplayName)
			if name == "" {
				name = id
			}
			out = append(out, domain.DiscoveredModel{
				ID:            id,
				Name:          name,
				Group:         deriveModelGroup(id),
				APIFormat:     "google-generative-ai",
				ContextWindow: m.InputTokenLimit,
				MaxTokens:     m.OutputTokenLimit,
				Reasoning:     m.Thinking,
			})
		}
		return out, nil
	}
	return normalizeStandardModels(envelope.Data, defaultFormat), nil
}

func normalizeStandardModels(items []discoveredStandardItem, defaultFormat string) []domain.DiscoveredModel {
	out := make([]domain.DiscoveredModel, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, m := range items {
		id := strings.TrimSpace(m.ID)
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		name := strings.TrimSpace(m.DisplayName)
		if name == "" {
			name = strings.TrimSpace(m.Name)
		}
		if name == "" {
			name = id
		}
		apiFormat := defaultFormat
		if strings.HasPrefix(strings.ToLower(id), "claude") {
			apiFormat = "anthropic-messages"
		} else if strings.HasPrefix(strings.ToLower(id), "gemini") {
			apiFormat = "google-generative-ai"
		}
		out = append(out, domain.DiscoveredModel{
			ID:            id,
			Name:          name,
			Group:         deriveModelGroup(id),
			APIFormat:     apiFormat,
			ContextWindow: m.ContextWindow,
			MaxTokens:     m.MaxTokens,
			Reasoning:     m.Reasoning,
		})
	}
	return out
}

func deriveModelGroup(id string) string {
	if prefix, _, ok := strings.Cut(id, "/"); ok && strings.TrimSpace(prefix) != "" {
		return strings.TrimSpace(prefix)
	}
	if prefix, _, ok := strings.Cut(id, "-"); ok && strings.TrimSpace(prefix) != "" {
		return strings.TrimSpace(prefix)
	}
	return "other"
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
		m.Compat.CacheMode = strings.ToLower(strings.TrimSpace(m.Compat.CacheMode))
		switch m.Compat.CacheMode {
		case "", domain.CacheModeAuto, domain.CacheModeImplicit, domain.CacheModeExplicit, domain.CacheModeDisabled:
		default:
			return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("invalid compat.cacheMode %q for model %q", m.Compat.CacheMode, m.ID), nil)
		}
	}
	return nil
}
