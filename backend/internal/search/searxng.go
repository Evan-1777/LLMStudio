package search

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const searxngDefaultEndpoint = "http://localhost:8888/search"

// SearXNGEngine implements plugin.SearchEngine against a self-hosted SearXNG JSON endpoint.
type SearXNGEngine struct {
	client *http.Client
}

// NewSearXNGEngine creates a SearXNGEngine using client (or a 10s default client when nil).
func NewSearXNGEngine(client *http.Client) *SearXNGEngine {
	if client == nil {
		client = &http.Client{Timeout: defaultHTTPTimeout}
	}
	return &SearXNGEngine{client: client}
}

func (e *SearXNGEngine) ID() string              { return "searxng" }
func (e *SearXNGEngine) DisplayName() string     { return "SearXNG" }
func (e *SearXNGEngine) DefaultEndpoint() string { return searxngDefaultEndpoint }
func (e *SearXNGEngine) RequiresAPIKey() bool    { return false }

type searxngResponse struct {
	Results []struct {
		Title   string `json:"title"`
		URL     string `json:"url"`
		Content string `json:"content"`
		Snippet string `json:"snippet"`
	} `json:"results"`
}

func (e *SearXNGEngine) Search(ctx context.Context, input plugin.SearchQueryInput) ([]plugin.SearchResult, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "search query must not be empty", nil)
	}
	endpoint := strings.TrimSpace(input.Endpoint)
	if endpoint == "" {
		endpoint = searxngDefaultEndpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "invalid searxng endpoint", err)
	}
	q := parsed.Query()
	q.Set("q", query)
	q.Set("format", "json")
	parsed.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "invalid searxng request", err)
	}
	req.Header.Set("Accept", "application/json")
	if key := strings.TrimSpace(input.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("searxng request failed: %v", err), err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "failed to read searxng response", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("searxng returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body))), nil)
	}

	var decoded searxngResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "invalid searxng response payload", err)
	}

	maxResults := input.MaxResults
	if maxResults <= 0 {
		maxResults = 5
	}
	out := make([]plugin.SearchResult, 0, len(decoded.Results))
	for _, r := range decoded.Results {
		snippet := strings.TrimSpace(r.Content)
		if snippet == "" {
			snippet = strings.TrimSpace(r.Snippet)
		}
		out = append(out, plugin.SearchResult{
			Title:   strings.TrimSpace(r.Title),
			URL:     strings.TrimSpace(r.URL),
			Snippet: snippet,
		})
		if len(out) >= maxResults {
			break
		}
	}
	return out, nil
}
