package mcp

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
)

const (
	maxHTTPResponseBodyBytes = 16 * 1024 * 1024 // 16MB cap for JSON responses and buffered reads
	maxErrorSnippetBytes     = 512
	deleteSessionTimeout     = 2 * time.Second
)

func parseEndpointURL(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "MCP server endpoint is required", nil)
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("invalid MCP endpoint URL: %v", err), err)
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || strings.TrimSpace(u.Host) == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "MCP endpoint must be a valid http or https URL", nil)
	}
	u.Scheme = scheme
	return u, nil
}

func sameOrigin(a, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	sa := strings.ToLower(a.Scheme)
	sb := strings.ToLower(b.Scheme)
	if sa != sb {
		return false
	}
	return normalizedOriginHost(sa, a.Host) == normalizedOriginHost(sb, b.Host)
}

func normalizedOriginHost(scheme, host string) string {
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

func newScopedHTTPClient(base *http.Client, baseURL *url.URL, server domain.MCPServerConfig, timeout time.Duration) *http.Client {
	var rt http.RoundTripper
	if base != nil {
		rt = base.Transport
	}
	return &http.Client{
		Transport: rt,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after 10 redirects")
			}
			if !sameOrigin(baseURL, req.URL) {
				stripSensitiveHeaders(req.Header, server.Headers)
			}
			return nil
		},
	}
}

func stripSensitiveHeaders(h http.Header, configured map[string]string) {
	h.Del("Authorization")
	h.Del("Proxy-Authorization")
	h.Del("Cookie")
	h.Del("Mcp-Session-Id")
	for k := range configured {
		h.Del(k)
	}
}

func applyConfiguredHeaders(req *http.Request, baseURL *url.URL, server domain.MCPServerConfig) {
	if !sameOrigin(baseURL, req.URL) {
		return
	}
	for k, v := range server.Headers {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		req.Header.Set(key, v)
	}
}

func readErrorSnippet(r io.Reader, server domain.MCPServerConfig) string {
	if r == nil {
		return ""
	}
	raw, _ := io.ReadAll(io.LimitReader(r, maxErrorSnippetBytes))
	return redactSecrets(string(raw), server)
}

func httpStatusError(server domain.MCPServerConfig, statusCode int, statusText string, body io.Reader) error {
	snippet := readErrorSnippet(body, server)
	msg := fmt.Sprintf("MCP server %q returned HTTP %d %s", server.Name, statusCode, strings.TrimSpace(statusText))
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		msg = fmt.Sprintf("MCP authentication failed for %q (HTTP %d)", server.Name, statusCode)
	}
	if snippet != "" {
		msg += ": " + snippet
	}
	return domain.NewError(domain.ErrCodeUpstreamError, msg, nil)
}
