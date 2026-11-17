package service

import (
	"context"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

// AssistantInput describes create or update fields for an Assistant preset.
type AssistantInput struct {
	ID                string                  `json:"id,omitempty"`
	Name              string                  `json:"name"`
	SystemPrompt      string                  `json:"systemPrompt"`
	DefaultProviderID string                  `json:"defaultProviderId"`
	DefaultModelID    string                  `json:"defaultModelId"`
	Params            domain.GenerationParams `json:"params"`
}

// AssistantService manages assistant presets and enforces default assistant invariants.
type AssistantService struct {
	store *store.AssistantStore
}

// NewAssistantService constructs an AssistantService.
func NewAssistantService(store *store.AssistantStore) *AssistantService {
	return &AssistantService{store: store}
}

// List returns all configured assistants.
func (s *AssistantService) List(ctx context.Context) ([]domain.Assistant, error) {
	return s.store.List(ctx)
}

// Get returns a single assistant by ID.
func (s *AssistantService) Get(ctx context.Context, id string) (domain.Assistant, error) {
	return s.store.Get(ctx, id)
}

// Create validates and persists a new assistant.
func (s *AssistantService) Create(ctx context.Context, in AssistantInput) (domain.Assistant, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return domain.Assistant{}, domain.NewError(domain.ErrCodeInvalidArgument, "assistant name is required", nil)
	}
	return s.store.Create(ctx, domain.Assistant{
		ID:                strings.TrimSpace(in.ID),
		Name:              name,
		SystemPrompt:      in.SystemPrompt,
		DefaultProviderID: strings.TrimSpace(in.DefaultProviderID),
		DefaultModelID:    strings.TrimSpace(in.DefaultModelID),
		Params:            in.Params,
		IsDefault:         false,
	})
}

// Update validates and updates an existing assistant.
func (s *AssistantService) Update(ctx context.Context, id string, in AssistantInput) (domain.Assistant, error) {
	existing, err := s.store.Get(ctx, id)
	if err != nil {
		return domain.Assistant{}, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return domain.Assistant{}, domain.NewError(domain.ErrCodeInvalidArgument, "assistant name is required", nil)
	}
	existing.Name = name
	existing.SystemPrompt = in.SystemPrompt
	existing.DefaultProviderID = strings.TrimSpace(in.DefaultProviderID)
	existing.DefaultModelID = strings.TrimSpace(in.DefaultModelID)
	existing.Params = in.Params
	return s.store.Update(ctx, existing)
}

// Delete removes a non-default assistant and reassigns its conversations to the default assistant.
func (s *AssistantService) Delete(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == domain.DefaultAssistantID {
		return domain.NewError(domain.ErrCodeInvalidArgument, "default assistant cannot be deleted", nil)
	}
	return s.store.Delete(ctx, id)
}
