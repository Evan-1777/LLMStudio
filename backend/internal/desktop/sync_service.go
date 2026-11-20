package desktop

import (
	"context"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
)

// TransferResult returns the imported conversation and ordered messages after upload or pull.
type TransferResult struct {
	Conversation domain.Conversation `json:"conversation"`
	Messages     []domain.Message    `json:"messages"`
}

// BatchTransferItemError records one failed item in a batch upload/pull operation.
type BatchTransferItemError struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	Conflict bool   `json:"conflict,omitempty"`
}

// BatchTransferResult summarizes succeeded and failed items in a batch transfer.
type BatchTransferResult struct {
	Direction string                   `json:"direction"`
	Succeeded []string                 `json:"succeeded"`
	Failed    []BatchTransferItemError `json:"failed"`
}

// SyncService performs conflict-aware bidirectional transfers between local SQLite and cloud gateway.
type SyncService struct {
	store *DesktopStore
	cloud *CloudClient
}

// NewSyncService constructs a SyncService.
func NewSyncService(store *DesktopStore, cloud *CloudClient) *SyncService {
	return &SyncService{store: store, cloud: cloud}
}

// UploadConversation uploads a local non-ephemeral topic to the cloud gateway.
// Groups do not migrate across domains; cloud conflicts return ErrCodeConflict unless force is true.
func (s *SyncService) UploadConversation(ctx context.Context, localConvID string, force bool) (TransferResult, error) {
	if s.cloud == nil || !s.cloud.IsConfigured() {
		return TransferResult{}, domain.NewError(domain.ErrCodeUnauthorized, "cloud gateway is not connected", nil)
	}
	id := strings.TrimSpace(localConvID)
	if id == "" {
		return TransferResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "conversation id is required", nil)
	}

	conv, err := s.store.Conversations.Get(ctx, id)
	if err != nil {
		return TransferResult{}, err
	}
	if conv.Ephemeral {
		return TransferResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "ephemeral conversations cannot be uploaded", nil)
	}
	msgs, err := s.store.Messages.ListByConversation(ctx, id)
	if err != nil {
		return TransferResult{}, err
	}

	// Groups do not cross domains; target lands in ungrouped while preserving pinned state.
	conv.GroupID = nil
	detail, err := s.cloud.ImportConversation(ctx, conv, msgs, force)
	if err != nil {
		return TransferResult{}, err
	}

	syncedAt := time.Now().UTC()
	if detail.Conversation.LastSyncedAt != nil {
		syncedAt = *detail.Conversation.LastSyncedAt
	}
	_ = s.store.MarkConversationSynced(ctx, id, detail.Conversation.SyncVersion, syncedAt)

	return TransferResult{
		Conversation: detail.Conversation,
		Messages:     detail.Messages,
	}, nil
}

// PullConversation downloads a cloud topic and imports it atomically into local SQLite.
// Groups do not migrate across domains; local conflicts return ErrCodeConflict unless force is true.
func (s *SyncService) PullConversation(ctx context.Context, cloudConvID string, force bool) (TransferResult, error) {
	if s.cloud == nil || !s.cloud.IsConfigured() {
		return TransferResult{}, domain.NewError(domain.ErrCodeUnauthorized, "cloud gateway is not connected", nil)
	}
	id := strings.TrimSpace(cloudConvID)
	if id == "" {
		return TransferResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "conversation id is required", nil)
	}

	detail, err := s.cloud.GetConversationDetail(ctx, id)
	if err != nil {
		return TransferResult{}, err
	}
	if detail.Conversation.Ephemeral {
		return TransferResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "ephemeral conversations cannot be pulled", nil)
	}

	conv := detail.Conversation
	aid := strings.TrimSpace(conv.AssistantID)
	if aid == "" {
		aid = domain.DefaultAssistantID
	}
	if aid != domain.DefaultAssistantID {
		if _, gErr := s.store.Assistants.Get(ctx, aid); gErr != nil {
			if assistants, lErr := s.cloud.ListAssistants(ctx); lErr == nil {
				_ = s.store.SyncCloudAssistants(ctx, assistants)
			}
			if _, gErr2 := s.store.Assistants.Get(ctx, aid); gErr2 != nil {
				aid = domain.DefaultAssistantID
			}
		}
	}
	conv.AssistantID = aid
	conv.GroupID = nil

	savedConv, savedMsgs, err := s.store.Conversations.ImportConversation(ctx, conv, detail.Messages, force)
	if err != nil {
		return TransferResult{}, err
	}
	return TransferResult{
		Conversation: savedConv,
		Messages:     savedMsgs,
	}, nil
}

// BatchTransfer sequentially transfers multiple conversations in the given direction ("upload" or "pull")
// without aborting remaining items on single-item failure or conflict.
func (s *SyncService) BatchTransfer(ctx context.Context, direction string, ids []string, force bool) (BatchTransferResult, error) {
	dir := strings.TrimSpace(direction)
	if dir != "upload" && dir != "pull" {
		return BatchTransferResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "direction must be upload or pull", nil)
	}
	if len(ids) == 0 {
		return BatchTransferResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "ids are required", nil)
	}

	res := BatchTransferResult{
		Direction: dir,
		Succeeded: make([]string, 0, len(ids)),
		Failed:    make([]BatchTransferItemError, 0),
	}
	seen := make(map[string]bool, len(ids))
	for _, rawID := range ids {
		id := strings.TrimSpace(rawID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true

		var err error
		if dir == "upload" {
			_, err = s.UploadConversation(ctx, id, force)
		} else {
			_, err = s.PullConversation(ctx, id, force)
		}
		if err != nil {
			itemErr := BatchTransferItemError{
				ID:      id,
				Code:    domain.ErrCodeInternalError,
				Message: err.Error(),
			}
			if appErr, ok := domain.AsAppError(err); ok {
				itemErr.Code = appErr.Code
				itemErr.Message = appErr.Message
				itemErr.Conflict = appErr.Code == domain.ErrCodeConflict
			}
			res.Failed = append(res.Failed, itemErr)
			continue
		}
		res.Succeeded = append(res.Succeeded, id)
	}
	return res, nil
}
