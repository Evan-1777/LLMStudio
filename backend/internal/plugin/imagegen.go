package plugin

import (
	"context"
	"encoding/json"

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
