package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	tavilyDefaultEndpoint = "https://api.tavily.com/search"
	defaultHTTPTimeout    = 10 * time.Second
)

// TavilyEngine implements plugin.SearchEngine against the Tavily Search API.
type TavilyEngine struct {
	client *http.Client
}

// NewTavilyEngine creates a TavilyEngine using client (or a 10s default client when nil).
func NewTavilyEngine(client *http.Client) *TavilyEngine {
	if client == nil {
		client = &http.Client{Timeout: defaultHTTPTimeout}
	}
	return &TavilyEngine{client: client}
}

func (e *TavilyEngine) ID() string              { return "tavily" }
func (e *TavilyEngine) DisplayName() string     { return "Tavily Search" }
func (e *TavilyEngine) DefaultEndpoint() string { return tavilyDefaultEndpoint }
func (e *TavilyEngine) RequiresAPIKey() bool    { return true }

type tavilyRequest struct {
	APIKey     string `json:"api_key"`
	Query      string `json:"query"`
	MaxResults int    `json:"max_results"`
}

type tavilyResponse struct {
	Results []struct {
		Title   string `json:"title"`
		URL     string `json:"url"`
		Content string `json:"content"`
		Snippet string `json:"snippet"`
	} `json:"results"`
}

func (e *TavilyEngine) Search(ctx context.Context, input plugin.SearchQueryInput) ([]plugin.SearchResult, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "search query must not be empty", nil)
	}
	apiKey := strings.TrimSpace(input.APIKey)
	if apiKey == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "tavily api key is required", nil)
	}
	endpoint := strings.TrimSpace(input.Endpoint)
	if endpoint == "" {
		endpoint = tavilyDefaultEndpoint
	}
	maxResults := input.MaxResults
	if maxResults <= 0 {
		maxResults = 5
	}

	payload, err := json.Marshal(tavilyRequest{
		APIKey:     apiKey,
		Query:      query,
		MaxResults: maxResults,
	})
	if err != nil {
		return nil, fmt.Errorf("encode tavily request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "invalid tavily endpoint", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("tavily request failed: %v", err), err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "failed to read tavily response", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("tavily returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body))), nil)
	}

	var decoded tavilyResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "invalid tavily response payload", err)
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
