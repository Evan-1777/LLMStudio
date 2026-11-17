package plugin

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"sync"

	"llmstudio/backend/internal/domain"
)

// ResolvedEndpoint holds the final upstream target URL and merged auth/custom headers.
type ResolvedEndpoint struct {
	URL     string
	Headers http.Header
}

// ProviderAdapter resolves upstream URLs and injects provider-specific authentication.
type ProviderAdapter interface {
	ID() string
	DisplayName() string
	ResolveEndpoint(
		provider domain.ProviderConfig,
		model domain.ModelConfig,
		defaultPath string,
		query url.Values,
		compat domain.CompatConfig,
	) (ResolvedEndpoint, error)
}

// ProviderAdapterInfo is a read-only summary of a registered provider adapter.
type ProviderAdapterInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// ProviderRegistry manages registered ProviderAdapter plugins.
type ProviderRegistry struct {
	mu       sync.RWMutex
	adapters map[string]ProviderAdapter
}

// NewProviderRegistry creates an empty ProviderRegistry.
func NewProviderRegistry() *ProviderRegistry {
	return &ProviderRegistry{
		adapters: make(map[string]ProviderAdapter),
	}
}

// Register adds a ProviderAdapter, rejecting empty or duplicate IDs.
func (r *ProviderRegistry) Register(adapter ProviderAdapter) error {
	if adapter == nil || adapter.ID() == "" {
		return fmt.Errorf("provider adapter must have a non-empty ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.adapters[adapter.ID()]; exists {
		return fmt.Errorf("duplicate provider adapter %q", adapter.ID())
	}
	r.adapters[adapter.ID()] = adapter
	return nil
}

// MustRegister registers a ProviderAdapter and panics on failure.
func (r *ProviderRegistry) MustRegister(adapter ProviderAdapter) {
	if err := r.Register(adapter); err != nil {
		panic(err)
	}
}

// Get retrieves a ProviderAdapter by ID.
func (r *ProviderRegistry) Get(id string) (ProviderAdapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.adapters[id]
	return a, ok
}

// Has reports whether a ProviderAdapter ID is registered.
func (r *ProviderRegistry) Has(id string) bool {
	_, ok := r.Get(id)
	return ok
}

// List returns metadata for all registered provider adapters sorted by ID.
func (r *ProviderRegistry) List() []ProviderAdapterInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ProviderAdapterInfo, 0, len(r.adapters))
	for _, a := range r.adapters {
		out = append(out, ProviderAdapterInfo{
			ID:          a.ID(),
			DisplayName: a.DisplayName(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out
}
