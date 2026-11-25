package plugin

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"sync"
)

// SearchResult represents a single web search hit returned by a SearchEngine plugin.
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// SearchQueryInput supplies query and runtime configuration to a SearchEngine plugin.
type SearchQueryInput struct {
	Query      string
	Endpoint   string
	APIKey     string
	MaxResults int
}

// SearchEngine defines an orthogonal web search backend plugin.
type SearchEngine interface {
	ID() string
	DisplayName() string
	DefaultEndpoint() string
	RequiresAPIKey() bool
	Search(ctx context.Context, input SearchQueryInput) ([]SearchResult, error)
}

// SearchEngineInfo describes public metadata for a registered SearchEngine plugin.
type SearchEngineInfo struct {
	ID              string `json:"id"`
	DisplayName     string `json:"displayName"`
	DefaultEndpoint string `json:"defaultEndpoint"`
	RequiresAPIKey  bool   `json:"requiresApiKey"`
}

// SearchRegistry manages registered SearchEngine plugins safely across goroutines.
type SearchRegistry struct {
	mu      sync.RWMutex
	engines map[string]SearchEngine
}

// NewSearchRegistry creates an empty SearchRegistry.
func NewSearchRegistry() *SearchRegistry {
	return &SearchRegistry{
		engines: make(map[string]SearchEngine),
	}
}

// Register adds a SearchEngine to the registry, rejecting nil or duplicate IDs.
func (r *SearchRegistry) Register(engine SearchEngine) error {
	if engine == nil || engine.ID() == "" {
		return fmt.Errorf("search engine plugin must have a non-empty ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.engines[engine.ID()]; exists {
		return fmt.Errorf("duplicate search engine plugin %q", engine.ID())
	}
	r.engines[engine.ID()] = engine
	return nil
}

// MustRegister registers a SearchEngine and panics if registration fails.
func (r *SearchRegistry) MustRegister(engine SearchEngine) {
	if err := r.Register(engine); err != nil {
		panic(err)
	}
}

// Get retrieves a SearchEngine by ID.
func (r *SearchRegistry) Get(id string) (SearchEngine, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.engines[id]
	return e, ok
}

// Has reports whether a search engine ID is registered.
func (r *SearchRegistry) Has(id string) bool {
	_, ok := r.Get(id)
	return ok
}

// List returns metadata for all registered search engines sorted by ID.
func (r *SearchRegistry) List() []SearchEngineInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]SearchEngineInfo, 0, len(r.engines))
	for _, e := range r.engines {
		out = append(out, SearchEngineInfo{
			ID:              e.ID(),
			DisplayName:     e.DisplayName(),
			DefaultEndpoint: e.DefaultEndpoint(),
			RequiresAPIKey:  e.RequiresAPIKey(),
		})
	}
	slices.SortFunc(out, func(a, b SearchEngineInfo) int {
		return cmp.Compare(a.ID, b.ID)
	})
	return out
}
