package plugin

import (
	"context"

	"llmstudio/backend/internal/domain"
)

// SyncState enumerates the reserved synchronization lifecycle states of a conversation.
type SyncState string

const (
	SyncStateLocalOnly SyncState = domain.SyncStateLocalOnly
	SyncStatePending   SyncState = domain.SyncStatePending
	SyncStateSynced    SyncState = domain.SyncStateSynced
	SyncStateConflict  SyncState = domain.SyncStateConflict
)

// ValidSyncState reports whether state is a recognized SyncState value.
func ValidSyncState(state string) bool {
	switch SyncState(state) {
	case SyncStateLocalOnly, SyncStatePending, SyncStateSynced, SyncStateConflict:
		return true
	default:
		return false
	}
}

// ConversationSyncBoundary reserves the selective per-conversation sync extension point
// without implementing remote sync or automatic version progression yet.
type ConversationSyncBoundary interface {
	Push(ctx context.Context, conversation domain.Conversation, messages []domain.Message) (domain.Conversation, error)
	Pull(ctx context.Context, conversationID string, sinceVersion int64) ([]domain.Message, int64, error)
}
