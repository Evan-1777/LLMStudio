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

// List returns all conversations sorted by most recently updated first.
func (s *ConversationStore) List(ctx context.Context) ([]domain.Conversation, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, title, provider_id, model_id, system_prompt, params_json,
		       sync_enabled, sync_state, sync_version, last_synced_at, created_at, updated_at
		FROM conversations
		ORDER BY updated_at DESC, rowid DESC
	`)
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

// Get fetches a conversation by ID.
func (s *ConversationStore) Get(ctx context.Context, id string) (domain.Conversation, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, title, provider_id, model_id, system_prompt, params_json,
		       sync_enabled, sync_state, sync_version, last_synced_at, created_at, updated_at
		FROM conversations
		WHERE id = ?
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

// Create persists a new conversation with canonical sync defaults.
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

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO conversations (
			id, title, provider_id, model_id, system_prompt, params_json,
			sync_enabled, sync_state, sync_version, last_synced_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, c.ID, c.Title, c.ProviderID, c.ModelID, c.SystemPrompt, string(paramsBytes),
		boolToInt(c.SyncEnabled), c.SyncState, c.SyncVersion, lastSynced, formatTime(c.CreatedAt), formatTime(c.UpdatedAt))
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("create conversation: %w", err)
	}
	return s.Get(ctx, c.ID)
}

// Update persists mutable conversation settings including the reserved sync_enabled flag,
// intentionally leaving sync_state and sync_version untouched until remote sync is implemented.
func (s *ConversationStore) Update(ctx context.Context, c domain.Conversation) (domain.Conversation, error) {
	c.UpdatedAt = time.Now().UTC()
	paramsBytes, err := json.Marshal(c.Params)
	if err != nil {
		return domain.Conversation{}, fmt.Errorf("encode conversation params: %w", err)
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE conversations
		SET title = ?, provider_id = ?, model_id = ?, system_prompt = ?, params_json = ?, sync_enabled = ?, updated_at = ?
		WHERE id = ?
	`, c.Title, c.ProviderID, c.ModelID, c.SystemPrompt, string(paramsBytes), boolToInt(c.SyncEnabled), formatTime(c.UpdatedAt), c.ID)
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

// TouchUpdatedAt bumps the conversation's updated_at timestamp.
func (s *ConversationStore) TouchUpdatedAt(ctx context.Context, id string, updatedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE conversations SET updated_at = ? WHERE id = ?`, formatTime(updatedAt), id)
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
		c            domain.Conversation
		paramsJSON   string
		syncEnabled  int
		lastSynced   sql.NullString
		createdRaw   string
		updatedRaw   string
	)
	if err := row.Scan(
		&c.ID, &c.Title, &c.ProviderID, &c.ModelID, &c.SystemPrompt, &paramsJSON,
		&syncEnabled, &c.SyncState, &c.SyncVersion, &lastSynced, &createdRaw, &updatedRaw,
	); err != nil {
		return domain.Conversation{}, err
	}
	c.SyncEnabled = syncEnabled != 0
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
