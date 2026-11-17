package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
	c.group_id, c.pinned, c.sort_order
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
		WHERE c.assistant_id = ?
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

	var nextHead int
	switch {
	case c.Pinned:
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 1
		`, c.AssistantID).Scan(&nextHead); err != nil {
			return domain.Conversation{}, fmt.Errorf("compute pinned head sort_order: %w", err)
		}
	case groupID.Valid:
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 0 AND group_id = ?
		`, c.AssistantID, groupID.String).Scan(&nextHead); err != nil {
			return domain.Conversation{}, fmt.Errorf("compute group head sort_order: %w", err)
		}
	default:
		if err := tx.QueryRowContext(ctx, `
			SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 0 AND group_id IS NULL
		`, c.AssistantID).Scan(&nextHead); err != nil {
			return domain.Conversation{}, fmt.Errorf("compute ungrouped head sort_order: %w", err)
		}
	}
	c.SortOrder = nextHead

	_, err = tx.ExecContext(ctx, `
		INSERT INTO conversations (
			id, assistant_id, title, provider_id, model_id, system_prompt, params_json,
			sync_enabled, sync_state, sync_version, last_synced_at, created_at, updated_at,
			group_id, pinned, sort_order
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, c.ID, c.AssistantID, c.Title, c.ProviderID, c.ModelID, c.SystemPrompt, string(paramsBytes),
		boolToInt(c.SyncEnabled), c.SyncState, c.SyncVersion, lastSynced, formatTime(c.CreatedAt), formatTime(c.UpdatedAt),
		groupID, boolToInt(c.Pinned), c.SortOrder)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("create conversation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.Conversation{}, fmt.Errorf("commit create conversation tx: %w", err)
	}
	return s.Get(ctx, c.ID)
}

// Update persists mutable conversation settings including the reserved sync_enabled flag,
// intentionally leaving sync_state and sync_version untouched until remote sync is implemented.
func (s *ConversationStore) Update(ctx context.Context, c domain.Conversation) (domain.Conversation, error) {
	c.UpdatedAt = time.Now().UTC()
	domain.NewConversationDefaults(&c)
	paramsBytes, err := json.Marshal(c.Params)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("encode conversation params: %w", err)
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE conversations
		SET assistant_id = ?, title = ?, provider_id = ?, model_id = ?, system_prompt = ?, params_json = ?, sync_enabled = ?, updated_at = ?
		WHERE id = ?
	`, c.AssistantID, c.Title, c.ProviderID, c.ModelID, c.SystemPrompt, string(paramsBytes), boolToInt(c.SyncEnabled), formatTime(c.UpdatedAt), c.ID)
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

func scanConversation(row rowScanner) (domain.Conversation, error) {
	var (
		c           domain.Conversation
		paramsJSON  string
		syncEnabled int
		lastSynced  sql.NullString
		createdRaw  string
		updatedRaw  string
		groupID     sql.NullString
		pinnedInt   int
	)
	if err := row.Scan(
		&c.ID, &c.AssistantID, &c.Title, &c.ProviderID, &c.ModelID, &c.SystemPrompt, &paramsJSON,
		&syncEnabled, &c.SyncState, &c.SyncVersion, &lastSynced, &createdRaw, &updatedRaw,
		&groupID, &pinnedInt, &c.SortOrder,
	); err != nil {
		return domain.Conversation{}, err
	}
	domain.NewConversationDefaults(&c)
	c.SyncEnabled = syncEnabled != 0
	c.Pinned = pinnedInt != 0
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
