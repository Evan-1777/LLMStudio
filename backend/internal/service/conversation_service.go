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
	Ephemeral    bool                    `json:"ephemeral,omitempty"`
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

// List returns all conversations sorted by organization order.
func (s *ConversationService) List(ctx context.Context) ([]domain.Conversation, error) {
	return s.convs.List(ctx)
}

// ListByAssistant returns conversations scoped to assistantID in canonical organization order.
func (s *ConversationService) ListByAssistant(ctx context.Context, assistantID string) ([]domain.Conversation, error) {
	return s.convs.ListByAssistant(ctx, assistantID)
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
		Ephemeral:    in.Ephemeral,
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
	prevAssistantID := conv.AssistantID

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

	updated, err := s.convs.Update(ctx, conv)
	if err != nil {
		return domain.Conversation{}, err
	}
	if updated.AssistantID != prevAssistantID {
		if err := s.convs.MoveToAssistantUngroupedHead(ctx, updated.ID, updated.AssistantID); err != nil {
			return domain.Conversation{}, err
		}
		return s.convs.Get(ctx, updated.ID)
	}
	return updated, nil
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

// CreateMessageInput describes payload fields for persisting a single message (including local-request writes).
type CreateMessageInput struct {
	Role             string                `json:"role"`
	Blocks           []domain.ContentBlock `json:"blocks"`
	ProviderID       string                `json:"providerId,omitempty"`
	ModelID          string                `json:"modelId,omitempty"`
	Usage            *domain.Usage         `json:"usage,omitempty"`
	StopReason       string                `json:"stopReason,omitempty"`
	ErrorMessage     string                `json:"errorMessage,omitempty"`
	ReplaceMessageID string                `json:"replaceMessageId,omitempty"`
	AfterMessageID   string                `json:"afterMessageId,omitempty"`
}

// CreateMessageResult bundles the persisted message and updated conversation metadata.
type CreateMessageResult struct {
	Message      domain.Message      `json:"message"`
	Conversation domain.Conversation `json:"conversation"`
}

// UpdateMessage updates a persisted message's blocks in place and refreshes the conversation timestamp.
func (s *ConversationService) UpdateMessage(ctx context.Context, conversationID, messageID string, blocks []domain.ContentBlock) (domain.Message, error) {
	if _, err := s.convs.Get(ctx, conversationID); err != nil {
		return domain.Message{}, err
	}
	if len(blocks) == 0 {
		return domain.Message{}, domain.NewError(domain.ErrCodeInvalidArgument, "message blocks must not be empty", nil)
	}
	for _, b := range blocks {
		if strings.TrimSpace(b.Type) == "" {
			return domain.Message{}, domain.NewError(domain.ErrCodeInvalidArgument, "content block type is required", nil)
		}
	}
	updated, err := s.msgs.UpdateBlocks(ctx, conversationID, messageID, blocks)
	if err != nil {
		return domain.Message{}, err
	}
	if err := s.convs.TouchUpdatedAt(ctx, conversationID, time.Now().UTC()); err != nil {
		return domain.Message{}, err
	}
	return updated, nil
}

// CreateMessage persists a new, replaced, or interval-inserted message and updates conversation metadata.
func (s *ConversationService) CreateMessage(ctx context.Context, conversationID string, in CreateMessageInput) (CreateMessageResult, error) {
	conv, err := s.convs.Get(ctx, conversationID)
	if err != nil {
		return CreateMessageResult{}, err
	}
	role := strings.TrimSpace(in.Role)
	switch role {
	case domain.RoleUser, domain.RoleAssistant, domain.RoleToolResult, domain.RoleCompaction:
	default:
		return CreateMessageResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "invalid message role", nil)
	}
	blocks := in.Blocks
	if blocks == nil {
		blocks = []domain.ContentBlock{}
	}
	if role == domain.RoleUser && len(blocks) == 0 {
		return CreateMessageResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "message blocks are required for user message", nil)
	}
	if role == domain.RoleCompaction && !hasValidCompactionBlock(blocks) {
		return CreateMessageResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "compaction block with non-empty text is required for compaction message", nil)
	}
	for _, b := range blocks {
		if strings.TrimSpace(b.Type) == "" {
			return CreateMessageResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "content block type is required", nil)
		}
	}
	replaceID := strings.TrimSpace(in.ReplaceMessageID)
	afterID := strings.TrimSpace(in.AfterMessageID)
	if replaceID != "" && afterID != "" {
		return CreateMessageResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "replaceMessageId and afterMessageId are mutually exclusive", nil)
	}

	msg := domain.Message{
		ConversationID: conversationID,
		Role:           role,
		Blocks:         blocks,
		ProviderID:     strings.TrimSpace(in.ProviderID),
		ModelID:        strings.TrimSpace(in.ModelID),
		Usage:          in.Usage,
		StopReason:     strings.TrimSpace(in.StopReason),
		ErrorMessage:   in.ErrorMessage,
		CreatedAt:      time.Now().UTC(),
	}

	var saved domain.Message
	switch {
	case replaceID != "":
		saved, err = s.msgs.ReplaceByID(ctx, conversationID, replaceID, msg)
	case afterID != "":
		saved, err = s.msgs.InsertAfter(ctx, conversationID, afterID, msg)
	default:
		saved, err = s.msgs.Create(ctx, msg)
	}
	if err != nil {
		return CreateMessageResult{}, err
	}

	if saved.Role == domain.RoleUser && (conv.Title == "" || conv.Title == "New Chat") {
		msgs, listErr := s.msgs.ListByConversation(ctx, conversationID)
		if listErr == nil && countRoleMessages(msgs, domain.RoleUser) == 1 {
			if derived := deriveTitleFromBlocks(saved.Blocks); derived != "" {
				conv.Title = derived
				if updated, uErr := s.convs.Update(ctx, conv); uErr == nil {
					return CreateMessageResult{
						Message:      saved,
						Conversation: updated,
					}, nil
				}
			}
		}
	}

	if err := s.convs.TouchUpdatedAt(ctx, conversationID, time.Now().UTC()); err != nil {
		return CreateMessageResult{}, err
	}
	if latest, gErr := s.convs.Get(ctx, conversationID); gErr == nil {
		conv = latest
	}
	return CreateMessageResult{
		Message:      saved,
		Conversation: conv,
	}, nil
}

func countRoleMessages(msgs []domain.Message, role string) int {
	n := 0
	for _, m := range msgs {
		if m.Role == role {
			n++
		}
	}
	return n
}

func hasValidCompactionBlock(blocks []domain.ContentBlock) bool {
	for _, b := range blocks {
		if b.Type == domain.BlockTypeCompaction && strings.TrimSpace(b.Text) != "" {
			return true
		}
	}
	return false
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

// OrganizationSnapshot returns authoritative conversations and groups for an assistant scope.
type OrganizationSnapshot struct {
	AssistantID   string                     `json:"assistantId"`
	Conversations []domain.Conversation      `json:"conversations"`
	Groups        []domain.ConversationGroup `json:"groups"`
	DeletedIDs    []string                   `json:"deletedIds,omitempty"`
}

// GroupMutationResult returns a mutated group alongside the updated assistant snapshot.
type GroupMutationResult struct {
	Group         domain.ConversationGroup   `json:"group"`
	AssistantID   string                     `json:"assistantId"`
	Conversations []domain.Conversation      `json:"conversations"`
	Groups        []domain.ConversationGroup `json:"groups"`
}

// GroupDeleteResult returns the deleted group ID alongside the updated assistant snapshot.
type GroupDeleteResult struct {
	DeletedGroupID string                     `json:"deletedGroupId"`
	AssistantID    string                     `json:"assistantId"`
	Conversations  []domain.Conversation      `json:"conversations"`
	Groups         []domain.ConversationGroup `json:"groups"`
}

// CreateGroupInput describes payload fields for creating a conversation group.
type CreateGroupInput struct {
	AssistantID string `json:"assistantId"`
	Name        string `json:"name"`
}

// ReorderGroupsInput describes relative placement within one assistant.
type ReorderGroupsInput struct {
	AssistantID string  `json:"assistantId"`
	ID          string  `json:"id"`
	BeforeID    *string `json:"beforeId"`
}

// RenameGroupInput describes payload fields for renaming a conversation group.
type RenameGroupInput struct {
	Name string `json:"name"`
}

// BatchConversationsInput defines discriminated batch operations over assistant-scoped conversations.
type BatchConversationsInput struct {
	AssistantID string             `json:"assistantId"`
	IDs         []string           `json:"ids"`
	Operation   string             `json:"operation"`
	GroupID     PatchField[string] `json:"groupId"`
	Pinned      PatchField[bool]   `json:"pinned"`
}

// ReorderConversationsInput defines relative bucket placement for assistant-scoped conversations.
type ReorderConversationsInput struct {
	AssistantID string             `json:"assistantId"`
	IDs         []string           `json:"ids"`
	Pinned      PatchField[bool]   `json:"pinned"`
	GroupID     PatchField[string] `json:"groupId"`
	BeforeID    PatchField[string] `json:"beforeId"`
}

func (s *ConversationService) requireAssistantExists(ctx context.Context, rawAssistantID string) (string, error) {
	aid := strings.TrimSpace(rawAssistantID)
	if aid == "" {
		return "", domain.NewError(domain.ErrCodeInvalidArgument, "assistantId is required", nil)
	}
	if s.assistants != nil && aid != domain.DefaultAssistantID {
		if _, err := s.assistants.Get(ctx, aid); err != nil {
			return "", err
		}
	}
	return aid, nil
}

func deduplicateIDs(raw []string) ([]string, error) {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, id := range raw {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			return nil, domain.NewError(domain.ErrCodeInvalidArgument, "conversation id must not be empty", nil)
		}
		if !seen[trimmed] {
			seen[trimmed] = true
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "ids must not be empty", nil)
	}
	return out, nil
}

func (s *ConversationService) snapshot(ctx context.Context, assistantID string, deletedIDs []string) (OrganizationSnapshot, error) {
	convs, err := s.convs.ListByAssistant(ctx, assistantID)
	if err != nil {
		return OrganizationSnapshot{}, err
	}
	groups, err := s.convs.ListGroups(ctx, assistantID)
	if err != nil {
		return OrganizationSnapshot{}, err
	}
	return OrganizationSnapshot{
		AssistantID:   assistantID,
		Conversations: convs,
		Groups:        groups,
		DeletedIDs:    deletedIDs,
	}, nil
}

// ListGroups returns conversation groups, optionally filtered by assistantID.
func (s *ConversationService) ListGroups(ctx context.Context, assistantID string) ([]domain.ConversationGroup, error) {
	return s.convs.ListGroups(ctx, strings.TrimSpace(assistantID))
}

// CreateGroup validates and persists a new conversation group for an assistant.
func (s *ConversationService) CreateGroup(ctx context.Context, in CreateGroupInput) (GroupMutationResult, error) {
	aid, err := s.requireAssistantExists(ctx, in.AssistantID)
	if err != nil {
		return GroupMutationResult{}, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return GroupMutationResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "group name is required", nil)
	}
	group, err := s.convs.CreateGroup(ctx, aid, name)
	if err != nil {
		return GroupMutationResult{}, err
	}
	snap, err := s.snapshot(ctx, aid, nil)
	if err != nil {
		return GroupMutationResult{}, err
	}
	return GroupMutationResult{
		Group:         group,
		AssistantID:   aid,
		Conversations: snap.Conversations,
		Groups:        snap.Groups,
	}, nil
}

// ReorderGroups moves a group and returns the assistant's canonical organization.
func (s *ConversationService) ReorderGroups(ctx context.Context, in ReorderGroupsInput) (OrganizationSnapshot, error) {
	aid, err := s.requireAssistantExists(ctx, in.AssistantID)
	if err != nil {
		return OrganizationSnapshot{}, err
	}
	id := strings.TrimSpace(in.ID)
	if id == "" || (in.BeforeID != nil && strings.TrimSpace(*in.BeforeID) == "") {
		return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "group id and anchor must not be empty", nil)
	}
	if err := s.convs.ReorderGroups(ctx, aid, id, in.BeforeID); err != nil {
		return OrganizationSnapshot{}, err
	}
	return s.snapshot(ctx, aid, nil)
}

// RenameGroup validates and updates a conversation group's name.
func (s *ConversationService) RenameGroup(ctx context.Context, id string, in RenameGroupInput) (GroupMutationResult, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return GroupMutationResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "group name is required", nil)
	}
	group, err := s.convs.RenameGroup(ctx, strings.TrimSpace(id), name)
	if err != nil {
		return GroupMutationResult{}, err
	}
	snap, err := s.snapshot(ctx, group.AssistantID, nil)
	if err != nil {
		return GroupMutationResult{}, err
	}
	return GroupMutationResult{
		Group:         group,
		AssistantID:   group.AssistantID,
		Conversations: snap.Conversations,
		Groups:        snap.Groups,
	}, nil
}

// DeleteGroup removes a conversation group while preserving conversations and messages.
func (s *ConversationService) DeleteGroup(ctx context.Context, id string) (GroupDeleteResult, error) {
	gid := strings.TrimSpace(id)
	aid, err := s.convs.DeleteGroup(ctx, gid)
	if err != nil {
		return GroupDeleteResult{}, err
	}
	snap, err := s.snapshot(ctx, aid, nil)
	if err != nil {
		return GroupDeleteResult{}, err
	}
	return GroupDeleteResult{
		DeletedGroupID: gid,
		AssistantID:    aid,
		Conversations:  snap.Conversations,
		Groups:         snap.Groups,
	}, nil
}

// CleanupUngrouped removes only the current ungrouped, unpinned bucket.
func (s *ConversationService) CleanupUngrouped(ctx context.Context) ([]domain.DeletedConversation, error) {
	return s.convs.CleanupUngrouped(ctx)
}

// BatchConversations executes an atomic batch delete, move, or pin operation for an assistant.
func (s *ConversationService) BatchConversations(ctx context.Context, in BatchConversationsInput) (OrganizationSnapshot, error) {
	aid, err := s.requireAssistantExists(ctx, in.AssistantID)
	if err != nil {
		return OrganizationSnapshot{}, err
	}
	ids, err := deduplicateIDs(in.IDs)
	if err != nil {
		return OrganizationSnapshot{}, err
	}

	switch strings.TrimSpace(in.Operation) {
	case "delete":
		if err := s.convs.BatchDelete(ctx, aid, ids); err != nil {
			return OrganizationSnapshot{}, err
		}
		return s.snapshot(ctx, aid, ids)

	case "move":
		if !in.GroupID.Set {
			return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "groupId is required for move operation (use null for ungrouped)", nil)
		}
		var targetGroupID *string
		if !in.GroupID.Null {
			trimmed := strings.TrimSpace(in.GroupID.Value)
			if trimmed == "" {
				return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "groupId must not be an empty string", nil)
			}
			targetGroupID = &trimmed
		}
		if err := s.convs.BatchMove(ctx, aid, ids, targetGroupID); err != nil {
			return OrganizationSnapshot{}, err
		}
		return s.snapshot(ctx, aid, nil)

	case "pin":
		if !in.Pinned.Set || in.Pinned.Null {
			return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "pinned boolean is required for pin operation", nil)
		}
		if err := s.convs.BatchPin(ctx, aid, ids, in.Pinned.Value); err != nil {
			return OrganizationSnapshot{}, err
		}
		return s.snapshot(ctx, aid, nil)

	default:
		return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "unsupported batch operation", nil)
	}
}

// ReorderConversations places selected conversations before an optional bucket anchor atomically.
func (s *ConversationService) ReorderConversations(ctx context.Context, in ReorderConversationsInput) (OrganizationSnapshot, error) {
	aid, err := s.requireAssistantExists(ctx, in.AssistantID)
	if err != nil {
		return OrganizationSnapshot{}, err
	}
	ids, err := deduplicateIDs(in.IDs)
	if err != nil {
		return OrganizationSnapshot{}, err
	}
	if !in.Pinned.Set || in.Pinned.Null {
		return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "pinned boolean is required", nil)
	}

	var targetGroupID *string
	if in.Pinned.Value {
		if in.GroupID.Set {
			return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "groupId must be omitted when pinned is true", nil)
		}
	} else {
		if !in.GroupID.Set {
			return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "groupId is required when pinned is false (use null for ungrouped)", nil)
		}
		if !in.GroupID.Null {
			trimmed := strings.TrimSpace(in.GroupID.Value)
			if trimmed == "" {
				return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "groupId must not be an empty string", nil)
			}
			targetGroupID = &trimmed
		}
	}

	var beforeID *string
	if in.BeforeID.Set && !in.BeforeID.Null {
		trimmed := strings.TrimSpace(in.BeforeID.Value)
		if trimmed == "" {
			return OrganizationSnapshot{}, domain.NewError(domain.ErrCodeInvalidArgument, "beforeId must not be an empty string", nil)
		}
		beforeID = &trimmed
	}

	if err := s.convs.Reorder(ctx, aid, ids, in.Pinned.Value, targetGroupID, beforeID); err != nil {
		return OrganizationSnapshot{}, err
	}
	return s.snapshot(ctx, aid, nil)
}
