package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	"llmstudio/backend/internal/domain"
)

// ImageGenRequest defines the reserved contract for standalone image generation plugins.
type ImageGenRequest struct {
	ProviderID string          `json:"providerId"`
	ModelID    string          `json:"modelId"`
	Prompt     string          `json:"prompt"`
	Size       string          `json:"size,omitempty"`
	Count      int             `json:"count,omitempty"`
	Extra      json.RawMessage `json:"extra,omitempty"`
}

// ImageGenerator is the reserved extension boundary for standalone image generation,
// intentionally decoupled from chat streaming and HTTP routes in the current milestone.
type ImageGenerator interface {
	ID() string
	DisplayName() string
	Generate(ctx context.Context, req ImageGenRequest) ([]domain.ContentBlock, error)
}

// ImageGenRegistry manages registered ImageGenerator plugins.
type ImageGenRegistry struct {
	mu         sync.RWMutex
	generators map[string]ImageGenerator
}

// NewImageGenRegistry creates an empty ImageGenRegistry.
func NewImageGenRegistry() *ImageGenRegistry {
	return &ImageGenRegistry{
		generators: make(map[string]ImageGenerator),
	}
}

// Register adds an ImageGenerator, rejecting empty or duplicate IDs.
func (r *ImageGenRegistry) Register(gen ImageGenerator) error {
	if gen == nil || gen.ID() == "" {
		return fmt.Errorf("image generator must have a non-empty ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.generators[gen.ID()]; exists {
		return fmt.Errorf("duplicate image generator %q", gen.ID())
	}
	r.generators[gen.ID()] = gen
	return nil
}

// Get retrieves an ImageGenerator by ID.
func (r *ImageGenRegistry) Get(id string) (ImageGenerator, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	g, ok := r.generators[id]
	return g, ok
}

// List returns registered image generator IDs sorted alphabetically.
func (r *ImageGenRegistry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.generators))
	for id := range r.generators {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
