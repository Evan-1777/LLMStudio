package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
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
	BaseURL     string            `json:"baseURL,omitempty"`
	AuthType    string            `json:"authType,omitempty"`
	APIKey      string            `json:"apiKey,omitempty"`
	ClearAPIKey bool              `json:"clearApiKey,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
}

// PreparedLocalModelProbe is a no-store upstream model list request envelope
// prepared from a saved localRequest provider configuration.
type PreparedLocalModelProbe struct {
	Method        string            `json:"method"`
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers"`
	AuthType      string            `json:"authType"`
	Protocol      string            `json:"protocol"`
	DefaultFormat string            `json:"defaultFormat"`
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

// Reorder persists provider order without changing provider configuration.
func (s *ProviderService) Reorder(ctx context.Context, id string, beforeID *string) ([]domain.ProviderConfig, error) {
	if strings.TrimSpace(id) == "" || (beforeID != nil && strings.TrimSpace(*beforeID) == "") {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "provider id and anchor must not be empty", nil)
	}
	return s.store.Reorder(ctx, id, beforeID)
}

// Get returns a single provider by ID.
func (s *ProviderService) Get(ctx context.Context, id string) (domain.ProviderConfig, error) {
	return s.store.Get(ctx, id)
}

// ProviderRuntimeCredential holds unmasked upstream provider credentials returned
// on explicit authenticated runtime fetches with no-store cache headers.
type ProviderRuntimeCredential struct {
	ProviderID string            `json:"providerId"`
	Adapter    string            `json:"adapter"`
	BaseURL    string            `json:"baseURL"`
	AuthType   string            `json:"authType"`
	APIKey     string            `json:"apiKey"`
	Headers    map[string]string `json:"headers,omitempty"`
	UpdatedAt  time.Time         `json:"updatedAt"`
}

// GetRuntimeCredential returns the raw credential payload for a configured provider.
func (s *ProviderService) GetRuntimeCredential(ctx context.Context, id string) (ProviderRuntimeCredential, error) {
	cfg, err := s.store.Get(ctx, id)
	if err != nil {
		return ProviderRuntimeCredential{}, err
	}
	return ProviderRuntimeCredential{
		ProviderID: cfg.ID,
		Adapter:    cfg.Adapter,
		BaseURL:    cfg.BaseURL,
		AuthType:   cfg.AuthType,
		APIKey:     cfg.APIKey,
		Headers:    cfg.Headers,
		UpdatedAt:  cfg.UpdatedAt,
	}, nil
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

// PrepareLocalModelProbe builds an authenticated upstream request envelope from
// the single saved provider record. Only saved localRequest=true providers are eligible.
func (s *ProviderService) PrepareLocalModelProbe(ctx context.Context, id string) (PreparedLocalModelProbe, error) {
	cfg, err := s.store.Get(ctx, id)
	if err != nil {
		return PreparedLocalModelProbe{}, err
	}
	if !cfg.LocalRequest {
		return PreparedLocalModelProbe{}, domain.NewError(domain.ErrCodeConflict, "provider is not in local request mode", nil)
	}
	return PrepareModelListRequest(s.providers, cfg)
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
	saved, err := s.store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	cfg := ApplyProbeOverrides(saved, probe)
	prepared, err := PrepareModelListRequest(s.providers, cfg)
	if err != nil {
		return nil, err
	}
	return ExecuteModelListRequest(ctx, s.httpClient, prepared, cfg.APIKey)
}

// ApplyProbeOverrides merges unsaved probe draft inputs onto a saved provider configuration.
// When the draft changes the target baseURL or authType, saved credentials and headers
// are never inherited; only explicitly provided draft credentials/headers are applied.
func ApplyProbeOverrides(saved domain.ProviderConfig, probe ProviderProbeInput) domain.ProviderConfig {
	cfg := saved
	savedBase := strings.TrimSpace(saved.BaseURL)
	probeBase := strings.TrimSpace(probe.BaseURL)
	targetChanged := probeBase != "" && probeBase != savedBase

	savedAuth := strings.TrimSpace(saved.AuthType)
	if savedAuth == "" {
		savedAuth = domain.AuthTypeBearer
	}
	probeAuth := strings.TrimSpace(probe.AuthType)
	authChanged := probeAuth != "" && probeAuth != savedAuth

	if targetChanged {
		cfg.BaseURL = probeBase
	}
	if authChanged {
		cfg.AuthType = probeAuth
	}

	if targetChanged || authChanged {
		if probe.ClearAPIKey {
			cfg.APIKey = ""
		} else {
			cfg.APIKey = strings.TrimSpace(probe.APIKey)
		}
		if probe.Headers != nil {
			cfg.Headers = maps.Clone(probe.Headers)
		} else {
			cfg.Headers = nil
		}
		if authChanged && !targetChanged {
			cfg.BaseURL = stripSensitiveQueryParams(cfg.BaseURL)
		}
		return cfg
	}

	if probe.ClearAPIKey {
		cfg.APIKey = ""
	} else if apiKey := strings.TrimSpace(probe.APIKey); apiKey != "" {
		cfg.APIKey = apiKey
	}
	if probe.Headers != nil {
		cfg.Headers = maps.Clone(probe.Headers)
	}
	return cfg
}

func stripSensitiveQueryParams(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.RawQuery == "" {
		return rawURL
	}
	q := parsed.Query()
	for _, key := range []string{"key", "api_key", "apikey", "token", "access_token"} {
		q.Del(key)
	}
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

// PrepareModelListRequest resolves the upstream model-discovery HTTP request
// strictly from provider authType and endpoint characteristics.
func PrepareModelListRequest(
	adapters *plugin.ProviderRegistry,
	cfg domain.ProviderConfig,
) (PreparedLocalModelProbe, error) {
	if strings.TrimSpace(cfg.Adapter) == "" {
		cfg.Adapter = "generic-http"
	}
	if strings.TrimSpace(cfg.AuthType) == "" {
		cfg.AuthType = domain.AuthTypeBearer
	}
	parsed, err := url.Parse(strings.TrimSpace(cfg.BaseURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return PreparedLocalModelProbe{}, domain.NewError(domain.ErrCodeInvalidArgument, "valid baseURL with scheme and host is required", err)
	}
	adapter, ok := adapters.Get(cfg.Adapter)
	if !ok {
		return PreparedLocalModelProbe{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unknown provider adapter %q", cfg.Adapter), nil)
	}

	protoKind, targetPath, defaultFormat := detectModelListProtocol(cfg)
	endpoint, err := adapter.ResolveEndpoint(cfg, domain.ModelConfig{}, targetPath, nil, domain.CompatConfig{})
	if err != nil {
		return PreparedLocalModelProbe{}, err
	}

	headers := make(map[string]string, len(endpoint.Headers)+2)
	headers["Accept"] = "application/json"
	hasAnthropicVersion := false
	for k, vals := range endpoint.Headers {
		if len(vals) == 0 {
			continue
		}
		if strings.EqualFold(k, "anthropic-version") {
			hasAnthropicVersion = true
		}
		headers[k] = vals[0]
	}
	if protoKind == "anthropic" && !hasAnthropicVersion {
		headers["anthropic-version"] = "2023-06-01"
	}

	return PreparedLocalModelProbe{
		Method:        http.MethodGet,
		URL:           endpoint.URL,
		Headers:       headers,
		AuthType:      cfg.AuthType,
		Protocol:      protoKind,
		DefaultFormat: defaultFormat,
	}, nil
}

// ExecuteModelListRequest executes a prepared model-list request with cross-origin
// redirect credential stripping and safe error classification.
func ExecuteModelListRequest(
	ctx context.Context,
	baseClient *http.Client,
	prepared PreparedLocalModelProbe,
	secretSentinel string,
) ([]domain.DiscoveredModel, error) {
	initialURL, err := url.Parse(prepared.URL)
	if err != nil || initialURL.Scheme == "" || initialURL.Host == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "construct upstream models request failed", err)
	}

	req, err := http.NewRequestWithContext(ctx, prepared.Method, prepared.URL, nil)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "construct upstream models request failed", err)
	}
	for k, v := range prepared.Headers {
		req.Header.Set(k, v)
	}

	client := scopedProbeHTTPClient(baseClient, initialURL, prepared.Headers, secretSentinel)
	resp, err := client.Do(req)
	if err != nil {
		return nil, classifyProbeNetworkError(ctx, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "读取上游模型列表响应失败", nil)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, classifyProbeHTTPError(resp.StatusCode)
	}

	models, err := parseDiscoveredModels(body, prepared.DefaultFormat)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, err.Error(), nil)
	}
	return models, nil
}

func scopedProbeHTTPClient(
	base *http.Client,
	initialURL *url.URL,
	configuredHeaders map[string]string,
	secretSentinel string,
) *http.Client {
	timeout := 15 * time.Second
	var transport http.RoundTripper
	if base != nil {
		transport = base.Transport
		if base.Timeout > 0 {
			timeout = base.Timeout
		}
	}
	trimmedSecret := strings.TrimSpace(secretSentinel)
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			if !sameProbeOrigin(initialURL, req.URL) {
				stripProbeCredentials(req, configuredHeaders, trimmedSecret)
			}
			return nil
		},
	}
}

func sameProbeOrigin(a, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	sa := strings.ToLower(a.Scheme)
	sb := strings.ToLower(b.Scheme)
	if sa != sb {
		return false
	}
	return normalizeProbeHost(sa, a.Host) == normalizeProbeHost(sb, b.Host)
}

func normalizeProbeHost(scheme, host string) string {
	h, port, err := net.SplitHostPort(host)
	if err != nil {
		h = host
		port = ""
	}
	h = strings.ToLower(strings.Trim(h, "[]"))
	if port == "" {
		switch scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		}
	}
	if port != "" {
		return net.JoinHostPort(h, port)
	}
	return h
}

func stripProbeCredentials(req *http.Request, configuredHeaders map[string]string, secretSentinel string) {
	req.Header.Del("Authorization")
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Cookie")
	req.Header.Del("X-Api-Key")
	for k := range configuredHeaders {
		if strings.EqualFold(k, "Accept") || strings.EqualFold(k, "anthropic-version") {
			continue
		}
		req.Header.Del(k)
	}
	if req.URL != nil && req.URL.RawQuery != "" {
		q := req.URL.Query()
		changed := false
		for _, k := range []string{"key", "api_key", "apikey", "token", "access_token"} {
			if q.Has(k) {
				q.Del(k)
				changed = true
			}
		}
		if secretSentinel != "" {
			for k, vals := range q {
				for _, v := range vals {
					if strings.Contains(v, secretSentinel) {
						q.Del(k)
						changed = true
						break
					}
				}
			}
		}
		if changed {
			req.URL.RawQuery = q.Encode()
		}
	}
}

func classifyProbeNetworkError(ctx context.Context, err error) error {
	if errors.Is(err, context.Canceled) || (ctx != nil && errors.Is(ctx.Err(), context.Canceled)) {
		return domain.NewError(domain.ErrCodeUpstreamError, "上游请求已取消", nil)
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return domain.NewError(domain.ErrCodeUpstreamError, "上游连接超时", nil)
	}
	return domain.NewError(domain.ErrCodeUpstreamError, "无法连接到上游服务", nil)
}

func classifyProbeHTTPError(statusCode int) error {
	var summary string
	switch statusCode {
	case http.StatusUnauthorized:
		summary = "鉴权失败"
	case http.StatusForbidden:
		summary = "拒绝访问"
	case http.StatusNotFound:
		summary = "模型列表端点不存在"
	case http.StatusTooManyRequests:
		summary = "请求过于频繁"
	case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		summary = "服务暂不可用"
	}
	if summary != "" {
		return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("上游返回 HTTP %d（%s）", statusCode, summary), nil)
	}
	return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("上游返回 HTTP %d", statusCode), nil)
}

func detectModelListProtocol(cfg domain.ProviderConfig) (kind, path, defaultFormat string) {
	lowerBase := strings.ToLower(strings.TrimSpace(cfg.BaseURL))
	switch {
	case cfg.AuthType == domain.AuthTypeQueryKey ||
		strings.Contains(lowerBase, "generativelanguage") ||
		strings.Contains(lowerBase, "/v1beta"):
		return "gemini", "/v1beta/models", "google-generative-ai"
	case cfg.AuthType == domain.AuthTypeXAPIKey ||
		strings.Contains(lowerBase, "anthropic"):
		return "anthropic", "/v1/models", "anthropic-messages"
	default:
		return "openai", "/v1/models", "openai-completions"
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
		ID               string `json:"id"`
		Name             string `json:"name"`
		DisplayName      string `json:"displayName"`
		InputTokenLimit  int    `json:"inputTokenLimit"`
		OutputTokenLimit int    `json:"outputTokenLimit"`
		Thinking         bool   `json:"thinking"`
	}

	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, errors.New("上游返回了空的模型列表响应")
	}
	if strings.HasPrefix(trimmed, "[") {
		var items []discoveredStandardItem
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, errors.New("上游返回了无效的模型列表 JSON")
		}
		return normalizeStandardModels(items, defaultFormat), nil
	}
	if !strings.HasPrefix(trimmed, "{") {
		return nil, errors.New("上游返回了无法识别的模型列表格式")
	}

	var rawObj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawObj); err != nil {
		return nil, errors.New("上游返回了无效的模型列表 JSON")
	}

	if rawModels, ok := rawObj["models"]; ok && strings.HasPrefix(strings.TrimSpace(string(rawModels)), "[") {
		var items []geminiItem
		if err := json.Unmarshal(rawModels, &items); err != nil {
			return nil, errors.New("上游返回了无效的模型列表 JSON")
		}
		out := make([]domain.DiscoveredModel, 0, len(items))
		seen := make(map[string]struct{}, len(items))
		for _, m := range items {
			rawID := strings.TrimSpace(m.Name)
			if rawID == "" {
				rawID = strings.TrimSpace(m.ID)
			}
			isGeminiPrefixed := strings.HasPrefix(rawID, "models/")
			id := strings.TrimSpace(strings.TrimPrefix(rawID, "models/"))
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
			apiFormat := defaultFormat
			if isGeminiPrefixed || defaultFormat == "google-generative-ai" || strings.HasPrefix(strings.ToLower(id), "gemini") {
				apiFormat = "google-generative-ai"
			} else if strings.HasPrefix(strings.ToLower(id), "claude") {
				apiFormat = "anthropic-messages"
			}
			out = append(out, domain.DiscoveredModel{
				ID:            id,
				Name:          name,
				Group:         deriveModelGroup(id),
				APIFormat:     apiFormat,
				ContextWindow: m.InputTokenLimit,
				MaxTokens:     m.OutputTokenLimit,
				Reasoning:     m.Thinking,
			})
		}
		return out, nil
	}

	if rawData, ok := rawObj["data"]; ok && strings.HasPrefix(strings.TrimSpace(string(rawData)), "[") {
		var items []discoveredStandardItem
		if err := json.Unmarshal(rawData, &items); err != nil {
			return nil, errors.New("上游返回了无效的模型列表 JSON")
		}
		return normalizeStandardModels(items, defaultFormat), nil
	}

	return nil, errors.New("上游返回了无法识别的模型列表格式")
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
