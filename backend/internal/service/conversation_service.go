package service

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

// PatchField tracks field presence and explicit JSON null for partial PATCH updates.
type PatchField[T any] struct {
	Set   bool
	Null  bool
	Value T
}

func (p *PatchField[T]) UnmarshalJSON(data []byte) error {
	p.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		p.Null = true
		var zero T
		p.Value = zero
		return nil
	}
	p.Null = false
	return json.Unmarshal(data, &p.Value)
}

// CreateConversationInput describes payload fields for creating a conversation.
type CreateConversationInput struct {
	AssistantID  string                  `json:"assistantId"`
	Title        string                  `json:"title"`
	ProviderID   string                  `json:"providerId"`
	ModelID      string                  `json:"modelId"`
	SystemPrompt string                  `json:"systemPrompt"`
	Params       domain.GenerationParams `json:"params"`
}

// PatchParamsInput supports clearing individual generation parameters when explicitly set to null or empty.
type PatchParamsInput struct {
	Temperature     PatchField[float64] `json:"temperature"`
	MaxTokens       PatchField[int]     `json:"maxTokens"`
	ReasoningEffort PatchField[string]  `json:"reasoningEffort"`
}

// PatchConversationInput supports partial conversation updates with explicit null clearing.
type PatchConversationInput struct {
	AssistantID  PatchField[string]           `json:"assistantId"`
	Title        PatchField[string]           `json:"title"`
	ProviderID   PatchField[string]           `json:"providerId"`
	ModelID      PatchField[string]           `json:"modelId"`
	SystemPrompt PatchField[string]           `json:"systemPrompt"`
	Params       PatchField[PatchParamsInput] `json:"params"`
	SyncEnabled  PatchField[bool]             `json:"syncEnabled"`
}

// ConversationDetail bundles a conversation with its ordered messages.
type ConversationDetail struct {
	Conversation domain.Conversation `json:"conversation"`
	Messages     []domain.Message    `json:"messages"`
}

// ConversationService manages conversations and inline message history loading.
type ConversationService struct {
	convs      *store.ConversationStore
	msgs       *store.MessageStore
	assistants *store.AssistantStore
}

// NewConversationService constructs a ConversationService.
func NewConversationService(convs *store.ConversationStore, msgs *store.MessageStore) *ConversationService {
	return &ConversationService{
		convs: convs,
		msgs:  msgs,
	}
}

// WithAssistants injects an optional AssistantStore to inherit default model presets on creation.
func (s *ConversationService) WithAssistants(assistants *store.AssistantStore) *ConversationService {
	s.assistants = assistants
	return s
}

// List returns all conversations sorted by update time descending.
func (s *ConversationService) List(ctx context.Context) ([]domain.Conversation, error) {
	return s.convs.List(ctx)
}

// Create persists a new conversation, inheriting default provider/model from its assistant when omitted.
func (s *ConversationService) Create(ctx context.Context, in CreateConversationInput) (domain.Conversation, error) {
	assistantID := strings.TrimSpace(in.AssistantID)
	if assistantID == "" {
		assistantID = domain.DefaultAssistantID
	}
	providerID := strings.TrimSpace(in.ProviderID)
	modelID := strings.TrimSpace(in.ModelID)

	if s.assistants != nil {
		if assistant, err := s.assistants.Get(ctx, assistantID); err == nil {
			if providerID == "" && assistant.DefaultProviderID != "" {
				providerID = assistant.DefaultProviderID
			}
			if modelID == "" && assistant.DefaultModelID != "" {
				modelID = assistant.DefaultModelID
			}
		} else if assistantID != domain.DefaultAssistantID {
			return domain.Conversation{}, err
		}
	}

	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "New Chat"
	}
	return s.convs.Create(ctx, domain.Conversation{
		AssistantID:  assistantID,
		Title:        title,
		ProviderID:   providerID,
		ModelID:      modelID,
		SystemPrompt: in.SystemPrompt,
		Params:       in.Params,
	})
}

// GetDetail returns the conversation and its ordered message list.
func (s *ConversationService) GetDetail(ctx context.Context, id string) (ConversationDetail, error) {
	conv, err := s.convs.Get(ctx, id)
	if err != nil {
		return ConversationDetail{}, err
	}
	msgs, err := s.msgs.ListByConversation(ctx, id)
	if err != nil {
		return ConversationDetail{}, err
	}
	return ConversationDetail{
		Conversation: conv,
		Messages:     msgs,
	}, nil
}

// Patch applies partial updates to a conversation, clearing nullable params when explicitly requested.
func (s *ConversationService) Patch(ctx context.Context, id string, in PatchConversationInput) (domain.Conversation, error) {
	conv, err := s.convs.Get(ctx, id)
	if err != nil {
		return domain.Conversation{}, err
	}

	if in.AssistantID.Set {
		if in.AssistantID.Null || strings.TrimSpace(in.AssistantID.Value) == "" {
			conv.AssistantID = domain.DefaultAssistantID
		} else {
			aid := strings.TrimSpace(in.AssistantID.Value)
			if s.assistants != nil {
				if _, err := s.assistants.Get(ctx, aid); err != nil {
					return domain.Conversation{}, err
				}
			}
			conv.AssistantID = aid
		}
	}
	if in.Title.Set {
		if in.Title.Null || strings.TrimSpace(in.Title.Value) == "" {
			conv.Title = "New Chat"
		} else {
			conv.Title = strings.TrimSpace(in.Title.Value)
		}
	}
	if in.ProviderID.Set {
		if in.ProviderID.Null {
			conv.ProviderID = ""
		} else {
			conv.ProviderID = strings.TrimSpace(in.ProviderID.Value)
		}
	}
	if in.ModelID.Set {
		if in.ModelID.Null {
			conv.ModelID = ""
		} else {
			conv.ModelID = strings.TrimSpace(in.ModelID.Value)
		}
	}
	if in.SystemPrompt.Set {
		if in.SystemPrompt.Null {
			conv.SystemPrompt = ""
		} else {
			conv.SystemPrompt = in.SystemPrompt.Value
		}
	}
	if in.SyncEnabled.Set && !in.SyncEnabled.Null {
		conv.SyncEnabled = in.SyncEnabled.Value
	}
	if in.Params.Set {
		if in.Params.Null {
			conv.Params = domain.GenerationParams{}
		} else {
			applyPatchParams(&conv.Params, in.Params.Value)
		}
	}

	return s.convs.Update(ctx, conv)
}

func applyPatchParams(dst *domain.GenerationParams, patch PatchParamsInput) {
	if patch.Temperature.Set {
		if patch.Temperature.Null {
			dst.Temperature = nil
		} else {
			v := patch.Temperature.Value
			dst.Temperature = &v
		}
	}
	if patch.MaxTokens.Set {
		if patch.MaxTokens.Null {
			dst.MaxTokens = nil
		} else {
			v := patch.MaxTokens.Value
			dst.MaxTokens = &v
		}
	}
	if patch.ReasoningEffort.Set {
		if patch.ReasoningEffort.Null {
			dst.ReasoningEffort = ""
		} else {
			dst.ReasoningEffort = strings.TrimSpace(patch.ReasoningEffort.Value)
		}
	}
}

// Delete deletes a conversation and cascades to its messages.
func (s *ConversationService) Delete(ctx context.Context, id string) error {
	return s.convs.Delete(ctx, id)
}

// DeleteMessage removes a single message from a conversation and refreshes updated_at.
func (s *ConversationService) DeleteMessage(ctx context.Context, conversationID, messageID string) error {
	if _, err := s.convs.Get(ctx, conversationID); err != nil {
		return err
	}
	if err := s.msgs.DeleteByID(ctx, conversationID, messageID); err != nil {
		return err
	}
	return s.convs.TouchUpdatedAt(ctx, conversationID, time.Now().UTC())
}

// BranchFromMessage clones a conversation and its history up to messageID (inclusive) into a new conversation.
func (s *ConversationService) BranchFromMessage(ctx context.Context, conversationID, messageID string) (ConversationDetail, error) {
	orig, err := s.convs.Get(ctx, conversationID)
	if err != nil {
		return ConversationDetail{}, err
	}
	msgs, err := s.msgs.ListUpTo(ctx, conversationID, messageID)
	if err != nil {
		return ConversationDetail{}, err
	}

	branched, err := s.convs.Create(ctx, domain.Conversation{
		AssistantID:  orig.AssistantID,
		Title:        orig.Title + " (分支)",
		ProviderID:   orig.ProviderID,
		ModelID:      orig.ModelID,
		SystemPrompt: orig.SystemPrompt,
		Params:       orig.Params,
	})
	if err != nil {
		return ConversationDetail{}, err
	}

	cloned := make([]domain.Message, 0, len(msgs))
	baseTime := time.Now().UTC()
	for i, m := range msgs {
		saved, err := s.msgs.Create(ctx, domain.Message{
			ConversationID: branched.ID,
			Role:           m.Role,
			Blocks:         m.Blocks,
			ProviderID:     m.ProviderID,
			ModelID:        m.ModelID,
			Usage:          m.Usage,
			StopReason:     m.StopReason,
			ErrorMessage:   m.ErrorMessage,
			CreatedAt:      baseTime.Add(time.Duration(i) * time.Microsecond),
		})
		if err != nil {
			return ConversationDetail{}, err
		}
		cloned = append(cloned, saved)
	}
	return ConversationDetail{
		Conversation: branched,
		Messages:     cloned,
	}, nil
}
