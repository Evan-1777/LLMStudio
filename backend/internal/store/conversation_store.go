package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
)

// ConversationStore manages Conversation persistence in SQLite.
type ConversationStore struct {
	db *sql.DB
}

// NewConversationStore constructs a ConversationStore backed by db.
func NewConversationStore(db *sql.DB) *ConversationStore {
	return &ConversationStore{db: db}
}

const conversationSelectCols = `
	c.id, c.assistant_id, c.title, c.provider_id, c.model_id, c.system_prompt, c.params_json,
	c.sync_enabled, c.sync_state, c.sync_version, c.last_synced_at, c.created_at, c.updated_at,
	c.group_id, c.pinned, c.sort_order, c.ephemeral, c.mode
`

const conversationOrderByClause = `
	ORDER BY
		c.pinned DESC,
		CASE WHEN c.pinned = 1 THEN 0 WHEN c.group_id IS NULL OR g.id IS NULL THEN 1 ELSE 0 END ASC,
		CASE WHEN c.pinned = 1 THEN 0 ELSE COALESCE(g.sort_order, 0) END ASC,
		CASE WHEN c.pinned = 1 THEN '' ELSE COALESCE(g.created_at, '') END ASC,
		CASE WHEN c.pinned = 1 THEN '' ELSE COALESCE(c.group_id, '') END ASC,
		c.sort_order ASC,
		c.id ASC
`

// List returns all conversations sorted by pinned bucket, group order, ungrouped bucket, and manual sort_order.
func (s *ConversationStore) List(ctx context.Context) ([]domain.Conversation, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+conversationSelectCols+`
		FROM conversations c
		LEFT JOIN conversation_groups g ON c.group_id = g.id
		WHERE c.ephemeral = 0
	`+conversationOrderByClause)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()

	convs := make([]domain.Conversation, 0)
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		convs = append(convs, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate conversations: %w", err)
	}
	return convs, nil
}

// ListByAssistant returns conversations belonging to assistantID in canonical organization order.
func (s *ConversationStore) ListByAssistant(ctx context.Context, assistantID string) ([]domain.Conversation, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+conversationSelectCols+`
		FROM conversations c
		LEFT JOIN conversation_groups g ON c.group_id = g.id
		WHERE c.assistant_id = ? AND c.ephemeral = 0
	`+conversationOrderByClause, assistantID)
	if err != nil {
		return nil, fmt.Errorf("list conversations by assistant %s: %w", assistantID, err)
	}
	defer rows.Close()

	convs := make([]domain.Conversation, 0)
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		convs = append(convs, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate conversations by assistant %s: %w", assistantID, err)
	}
	return convs, nil
}

// Get fetches a conversation by ID.
func (s *ConversationStore) Get(ctx context.Context, id string) (domain.Conversation, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+conversationSelectCols+`
		FROM conversations c
		WHERE c.id = ?
	`, id)
	c, err := scanConversation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Conversation{}, domain.NewError(domain.ErrCodeNotFound, "conversation not found", err)
	}
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("get conversation %s: %w", id, err)
	}
	return c, nil
}

// Create persists a new conversation at the head of its target bucket (ungrouped head by default).
func (s *ConversationStore) Create(ctx context.Context, c domain.Conversation) (domain.Conversation, error) {
	now := time.Now().UTC()
	if c.ID == "" {
		c.ID = domain.NewUUID()
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = now
	}
	if c.UpdatedAt.IsZero() {
		c.UpdatedAt = c.CreatedAt
	}
	domain.NewConversationDefaults(&c)
	if !domain.ValidConversationMode(c.Mode) {
		return domain.Conversation{}, domain.NewError(domain.ErrCodeInvalidArgument, "mode must be chat or agent", nil)
	}

	paramsBytes, err := json.Marshal(c.Params)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("encode conversation params: %w", err)
	}
	var lastSynced sql.NullString
	if c.LastSyncedAt != nil {
		lastSynced = sql.NullString{String: formatTime(*c.LastSyncedAt), Valid: true}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("begin create conversation tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var groupID sql.NullString
	if c.GroupID != nil && *c.GroupID != "" {
		groupID = sql.NullString{String: *c.GroupID, Valid: true}
	}

	nextHead, err := nextConversationHeadSortOrder(ctx, tx, c.AssistantID, c.Pinned, groupID)
	if err != nil {
		return domain.Conversation{}, err
	}
	c.SortOrder = nextHead

	_, err = tx.ExecContext(ctx, `
		INSERT INTO conversations (
			id, assistant_id, title, provider_id, model_id, system_prompt, params_json,
			sync_enabled, sync_state, sync_version, last_synced_at, created_at, updated_at,
			group_id, pinned, sort_order, ephemeral, mode
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, c.ID, c.AssistantID, c.Title, c.ProviderID, c.ModelID, c.SystemPrompt, string(paramsBytes),
		boolToInt(c.SyncEnabled), c.SyncState, c.SyncVersion, lastSynced, formatTime(c.CreatedAt), formatTime(c.UpdatedAt),
		groupID, boolToInt(c.Pinned), c.SortOrder, boolToInt(c.Ephemeral), c.Mode)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("create conversation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.Conversation{}, fmt.Errorf("commit create conversation tx: %w", err)
	}
	return s.Get(ctx, c.ID)
}

func nextConversationHeadSortOrder(ctx context.Context, tx *sql.Tx, assistantID string, pinned bool, groupID sql.NullString) (int, error) {
	var nextHead int
	switch {
	case pinned:
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 1
		`, assistantID).Scan(&nextHead); err != nil {
			return 0, fmt.Errorf("compute pinned head sort_order: %w", err)
		}
	case groupID.Valid:
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 0 AND group_id = ?
		`, assistantID, groupID.String).Scan(&nextHead); err != nil {
			return 0, fmt.Errorf("compute group head sort_order: %w", err)
		}
	default:
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 0 AND group_id IS NULL
		`, assistantID).Scan(&nextHead); err != nil {
			return 0, fmt.Errorf("compute ungrouped head sort_order: %w", err)
		}
	}
	return nextHead, nil
}

// ImportConversation atomically inserts or overwrites a conversation and its full message history.
// When an existing record has newer unsynced edits and force is false, it returns ErrCodeConflict.
func (s *ConversationStore) ImportConversation(
	ctx context.Context,
	conv domain.Conversation,
	messages []domain.Message,
	force bool,
) (domain.Conversation, []domain.Message, error) {
	if conv.Ephemeral {
		return domain.Conversation{}, nil, domain.NewError(domain.ErrCodeInvalidArgument, "ephemeral conversations cannot be imported", nil)
	}
	now := time.Now().UTC()
	conv.ID = strings.TrimSpace(conv.ID)
	if conv.ID == "" {
		conv.ID = domain.NewUUID()
	}
	if conv.CreatedAt.IsZero() {
		conv.CreatedAt = now
	}
	if conv.UpdatedAt.IsZero() {
		conv.UpdatedAt = conv.CreatedAt
	}
	conv.AssistantID = strings.TrimSpace(conv.AssistantID)
	domain.NewConversationDefaults(&conv)
	if !domain.ValidConversationMode(conv.Mode) {
		return domain.Conversation{}, nil, domain.NewError(domain.ErrCodeInvalidArgument, "mode must be chat or agent", nil)
	}

	syncTime := now
	if conv.UpdatedAt.After(syncTime) {
		syncTime = conv.UpdatedAt
	}
	paramsBytes, err := json.Marshal(conv.Params)
	if err != nil {
		return domain.Conversation{}, nil, fmt.Errorf("encode conversation params: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Conversation{}, nil, fmt.Errorf("begin import conversation tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		existing domain.Conversation
		exists   bool
	)
	row := tx.QueryRowContext(ctx, `
		SELECT `+conversationSelectCols+`
		FROM conversations c
		WHERE c.id = ?
	`, conv.ID)
	existing, err = scanConversation(row)
	switch {
	case err == nil:
		exists = true
		if !force {
			hasNewerTarget := existing.SyncState == domain.SyncStatePending ||
				existing.LastSyncedAt == nil ||
				existing.UpdatedAt.After(*existing.LastSyncedAt) ||
				existing.UpdatedAt.After(conv.UpdatedAt)
			if hasNewerTarget {
				return domain.Conversation{}, nil, domain.NewError(domain.ErrCodeConflict, "target conversation has newer unsynced changes", nil)
			}
		}
	case errors.Is(err, sql.ErrNoRows):
	default:
		return domain.Conversation{}, nil, fmt.Errorf("lookup import conversation %s: %w", conv.ID, err)
	}

	var groupArg sql.NullString
	if conv.GroupID != nil && strings.TrimSpace(*conv.GroupID) != "" {
		gid := strings.TrimSpace(*conv.GroupID)
		var present int
		gErr := tx.QueryRowContext(ctx, `
			SELECT 1 FROM conversation_groups WHERE id = ? AND assistant_id = ?
		`, gid, conv.AssistantID).Scan(&present)
		switch {
		case gErr == nil:
			groupArg = sql.NullString{String: gid, Valid: true}
		case errors.Is(gErr, sql.ErrNoRows):
			conv.GroupID = nil
		default:
			return domain.Conversation{}, nil, fmt.Errorf("verify import group %s: %w", gid, gErr)
		}
	} else {
		conv.GroupID = nil
	}

	syncVersion := conv.SyncVersion
	if exists && existing.SyncVersion > syncVersion {
		syncVersion = existing.SyncVersion
	}
	syncVersion++

	if exists {
		if _, err := tx.ExecContext(ctx, `
			UPDATE conversations
			SET assistant_id = ?, title = ?, provider_id = ?, model_id = ?, system_prompt = ?, params_json = ?,
				sync_enabled = ?, sync_state = ?, sync_version = ?, last_synced_at = ?,
				created_at = ?, updated_at = ?, group_id = ?, pinned = ?, ephemeral = 0, mode = ?
			WHERE id = ?
		`, conv.AssistantID, conv.Title, conv.ProviderID, conv.ModelID, conv.SystemPrompt, string(paramsBytes),
			boolToInt(conv.SyncEnabled), domain.SyncStateSynced, syncVersion, formatTime(syncTime),
			formatTime(conv.CreatedAt), formatTime(conv.UpdatedAt), groupArg, boolToInt(conv.Pinned), conv.Mode, conv.ID); err != nil {
			return domain.Conversation{}, nil, fmt.Errorf("update imported conversation %s: %w", conv.ID, err)
		}
	} else {
		nextHead, err := nextConversationHeadSortOrder(ctx, tx, conv.AssistantID, conv.Pinned, groupArg)
		if err != nil {
			return domain.Conversation{}, nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO conversations (
				id, assistant_id, title, provider_id, model_id, system_prompt, params_json,
				sync_enabled, sync_state, sync_version, last_synced_at, created_at, updated_at,
				group_id, pinned, sort_order, ephemeral, mode
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
		`, conv.ID, conv.AssistantID, conv.Title, conv.ProviderID, conv.ModelID, conv.SystemPrompt, string(paramsBytes),
			boolToInt(conv.SyncEnabled), domain.SyncStateSynced, syncVersion, formatTime(syncTime),
			formatTime(conv.CreatedAt), formatTime(conv.UpdatedAt), groupArg, boolToInt(conv.Pinned), nextHead, conv.Mode); err != nil {
			return domain.Conversation{}, nil, fmt.Errorf("insert imported conversation %s: %w", conv.ID, err)
		}
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE conversation_id = ?`, conv.ID); err != nil {
		return domain.Conversation{}, nil, fmt.Errorf("clear imported conversation messages %s: %w", conv.ID, err)
	}
	for i, m := range messages {
		if strings.TrimSpace(m.ID) == "" {
			m.ID = domain.NewUUID()
		}
		if m.CreatedAt.IsZero() {
			m.CreatedAt = conv.CreatedAt.Add(time.Duration(i) * time.Microsecond)
		}
		blocksJSON, usageJSON, err := encodeMessagePayloads(m.Blocks, m.Usage)
		if err != nil {
			return domain.Conversation{}, nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO messages (
				id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, m.ID, conv.ID, m.Role, blocksJSON, m.ProviderID, m.ModelID, usageJSON, m.StopReason, m.ErrorMessage, formatTime(m.CreatedAt)); err != nil {
			return domain.Conversation{}, nil, fmt.Errorf("insert imported message %s: %w", m.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return domain.Conversation{}, nil, fmt.Errorf("commit import conversation tx: %w", err)
	}

	savedConv, err := s.Get(ctx, conv.ID)
	if err != nil {
		return domain.Conversation{}, nil, err
	}
	savedMsgs, err := NewMessageStore(s.db).ListByConversation(ctx, conv.ID)
	if err != nil {
		return domain.Conversation{}, nil, err
	}
	return savedConv, savedMsgs, nil
}

// Update persists mutable conversation settings including the reserved sync_enabled flag,
// intentionally leaving sync_state and sync_version untouched until remote sync is implemented.
func (s *ConversationStore) Update(ctx context.Context, c domain.Conversation) (domain.Conversation, error) {
	c.UpdatedAt = time.Now().UTC()
	domain.NewConversationDefaults(&c)
	if !domain.ValidConversationMode(c.Mode) {
		return domain.Conversation{}, domain.NewError(domain.ErrCodeInvalidArgument, "mode must be chat or agent", nil)
	}
	paramsBytes, err := json.Marshal(c.Params)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("encode conversation params: %w", err)
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE conversations
		SET assistant_id = ?, title = ?, provider_id = ?, model_id = ?, system_prompt = ?, params_json = ?, sync_enabled = ?, updated_at = ?, mode = ?
		WHERE id = ?
	`, c.AssistantID, c.Title, c.ProviderID, c.ModelID, c.SystemPrompt, string(paramsBytes), boolToInt(c.SyncEnabled), formatTime(c.UpdatedAt), c.Mode, c.ID)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("update conversation %s: %w", c.ID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("rows affected update conversation %s: %w", c.ID, err)
	}
	if affected == 0 {
		return domain.Conversation{}, domain.NewError(domain.ErrCodeNotFound, "conversation not found", nil)
	}
	return s.Get(ctx, c.ID)
}

// TouchUpdatedAt bumps the conversation's updated_at timestamp monotonically.
func (s *ConversationStore) TouchUpdatedAt(ctx context.Context, id string, updatedAt time.Time) error {
	ts := formatTime(updatedAt)
	_, err := s.db.ExecContext(ctx, `
		UPDATE conversations
		SET updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
		WHERE id = ?
	`, ts, ts, id)
	if err != nil {
		return fmt.Errorf("touch conversation %s: %w", id, err)
	}
	return nil
}

// Delete removes a conversation by ID; SQLite ON DELETE CASCADE removes child messages.
func (s *ConversationStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM conversations WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete conversation %s: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected delete conversation %s: %w", id, err)
	}
	if affected == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "conversation not found", nil)
	}
	return nil
}

// CleanupEphemeral removes all ephemeral conversations; SQLite ON DELETE CASCADE removes child messages.
func (s *ConversationStore) CleanupEphemeral(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM conversations WHERE ephemeral = 1`)
	if err != nil {
		return 0, fmt.Errorf("cleanup ephemeral conversations: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("rows affected cleanup ephemeral conversations: %w", err)
	}
	return affected, nil
}

func scanConversation(row rowScanner) (domain.Conversation, error) {
	var (
		c            domain.Conversation
		paramsJSON   string
		syncEnabled  int
		lastSynced   sql.NullString
		createdRaw   string
		updatedRaw   string
		groupID      sql.NullString
		pinnedInt    int
		ephemeralInt int
	)
	if err := row.Scan(
		&c.ID, &c.AssistantID, &c.Title, &c.ProviderID, &c.ModelID, &c.SystemPrompt, &paramsJSON,
		&syncEnabled, &c.SyncState, &c.SyncVersion, &lastSynced, &createdRaw, &updatedRaw,
		&groupID, &pinnedInt, &c.SortOrder, &ephemeralInt, &c.Mode,
	); err != nil {
		return domain.Conversation{}, err
	}
	domain.NewConversationDefaults(&c)
	c.SyncEnabled = syncEnabled != 0
	c.Pinned = pinnedInt != 0
	c.Ephemeral = ephemeralInt != 0
	if groupID.Valid && groupID.String != "" {
		gid := groupID.String
		c.GroupID = &gid
	}
	if paramsJSON != "" && paramsJSON != "{}" {
		if err := json.Unmarshal([]byte(paramsJSON), &c.Params); err != nil {
			return domain.Conversation{}, fmt.Errorf("decode conversation params: %w", err)
		}
	}
	if lastSynced.Valid && lastSynced.String != "" {
		t, err := parseTime(lastSynced.String)
		if err != nil {
			return domain.Conversation{}, fmt.Errorf("parse last_synced_at: %w", err)
		}
		c.LastSyncedAt = &t
	}
	var err error
	if c.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.Conversation{}, fmt.Errorf("parse conversation created_at: %w", err)
	}
	if c.UpdatedAt, err = parseTime(updatedRaw); err != nil {
		return domain.Conversation{}, fmt.Errorf("parse conversation updated_at: %w", err)
	}
	return c, nil
}
