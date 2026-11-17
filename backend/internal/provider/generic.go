package provider

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	// AdapterGenericHTTP is the default HTTP provider adapter ID.
	AdapterGenericHTTP = "generic-http"
	customAuthMetaKey  = "x-auth-header"
)

// GenericHTTPAdapter resolves upstream URLs and injects bearer, header, or query auth.
type GenericHTTPAdapter struct{}

// NewGenericHTTPAdapter creates a GenericHTTPAdapter.
func NewGenericHTTPAdapter() *GenericHTTPAdapter {
	return &GenericHTTPAdapter{}
}

func (a *GenericHTTPAdapter) ID() string          { return AdapterGenericHTTP }
func (a *GenericHTTPAdapter) DisplayName() string { return "Generic HTTP" }

func (a *GenericHTTPAdapter) ResolveEndpoint(
	provider domain.ProviderConfig,
	model domain.ModelConfig,
	defaultPath string,
	query url.Values,
	compat domain.CompatConfig,
) (plugin.ResolvedEndpoint, error) {
	parsedBase, err := url.Parse(strings.TrimSpace(provider.BaseURL))
	if err != nil || parsedBase.Scheme == "" || parsedBase.Host == "" {
		return plugin.ResolvedEndpoint{}, domain.NewError(
			domain.ErrCodeInvalidArgument,
			"invalid provider baseURL",
			err,
		)
	}

	targetPath := defaultPath
	if strings.TrimSpace(compat.PathOverride) != "" {
		targetPath = strings.TrimSpace(compat.PathOverride)
	}
	if model.ID != "" {
		targetPath = strings.ReplaceAll(targetPath, "{model}", url.PathEscape(model.ID))
	}

	// Handle optional embedded query parameters inside PathOverride (e.g. ?alt=sse).
	var pathQuery url.Values
	if idx := strings.Index(targetPath, "?"); idx >= 0 {
		if q, qErr := url.ParseQuery(targetPath[idx+1:]); qErr == nil {
			pathQuery = q
		}
		targetPath = targetPath[:idx]
	}

	parsedBase.Path = joinEndpointPath(parsedBase.Path, targetPath)

	mergedQuery := parsedBase.Query()
	for k, vals := range query {
		mergedQuery.Del(k)
		for _, v := range vals {
			mergedQuery.Add(k, v)
		}
	}
	for k, vals := range pathQuery {
		mergedQuery.Del(k)
		for _, v := range vals {
			mergedQuery.Add(k, v)
		}
	}

	headers := make(http.Header)
	var customAuthHeader string
	for k, v := range provider.Headers {
		if strings.EqualFold(k, customAuthMetaKey) {
			customAuthHeader = strings.TrimSpace(v)
			continue
		}
		headers.Set(k, v)
	}
	for k, v := range compat.ExtraHeaders {
		if strings.EqualFold(k, customAuthMetaKey) {
			customAuthHeader = strings.TrimSpace(v)
			continue
		}
		headers.Set(k, v)
	}

	authType := strings.TrimSpace(provider.AuthType)
	if authType == "" {
		authType = domain.AuthTypeBearer
	}
	apiKey := strings.TrimSpace(provider.APIKey)

	if authType != domain.AuthTypeNone && apiKey == "" {
		return plugin.ResolvedEndpoint{}, domain.NewError(
			domain.ErrCodeInvalidArgument,
			fmt.Sprintf("provider %q API key is required for authType %q", provider.Name, authType),
			nil,
		)
	}

	switch authType {
	case domain.AuthTypeNone:
		// No credential injection.
	case domain.AuthTypeBearer:
		headers.Set("Authorization", "Bearer "+apiKey)
	case domain.AuthTypeXAPIKey:
		headers.Set("x-api-key", apiKey)
	case domain.AuthTypeQueryKey:
		mergedQuery.Set("key", apiKey)
	case domain.AuthTypeHeaderKey:
		applyCustomHeaderAuth(headers, customAuthHeader, apiKey)
	default:
		return plugin.ResolvedEndpoint{}, domain.NewError(
			domain.ErrCodeInvalidArgument,
			fmt.Sprintf("unsupported authType %q", authType),
			nil,
		)
	}

	parsedBase.RawQuery = mergedQuery.Encode()
	return plugin.ResolvedEndpoint{
		URL:     parsedBase.String(),
		Headers: headers,
	}, nil
}

func applyCustomHeaderAuth(headers http.Header, customAuthHeader, apiKey string) {
	replacedTemplate := false
	for k, vals := range headers {
		for i, v := range vals {
			if strings.Contains(v, "{{apiKey}}") {
				vals[i] = strings.ReplaceAll(v, "{{apiKey}}", apiKey)
				replacedTemplate = true
			}
		}
		headers[k] = vals
	}
	if replacedTemplate {
		return
	}
	if customAuthHeader != "" {
		headers.Set(customAuthHeader, apiKey)
		return
	}
	for k, vals := range headers {
		if len(vals) == 1 && strings.TrimSpace(vals[0]) == "" {
			headers.Set(k, apiKey)
			return
		}
	}
	headers.Set("X-API-Key", apiKey)
}

func joinEndpointPath(basePath, targetPath string) string {
	baseTrim := strings.TrimRight(basePath, "/")
	if targetPath == "" {
		if baseTrim == "" {
			return "/"
		}
		return baseTrim
	}
	if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	// Avoid duplicating trailing version prefix such as /v1 + /v1/chat/completions.
	for _, prefix := range []string{"/v1", "/v1beta"} {
		if strings.HasSuffix(baseTrim, prefix) && strings.HasPrefix(targetPath, prefix+"/") {
			targetPath = strings.TrimPrefix(targetPath, prefix)
			break
		}
	}
	if baseTrim == "" {
		return targetPath
	}
	return baseTrim + targetPath
}
