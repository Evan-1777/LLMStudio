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

// MessageStore manages Message persistence in SQLite.
type MessageStore struct {
	db *sql.DB
}

// NewMessageStore constructs a MessageStore backed by db.
func NewMessageStore(db *sql.DB) *MessageStore {
	return &MessageStore{db: db}
}

// ListByConversation returns messages belonging to conversationID in chronological order.
func (s *MessageStore) ListByConversation(ctx context.Context, conversationID string) ([]domain.Message, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
		FROM messages
		WHERE conversation_id = ?
		ORDER BY created_at ASC, rowid ASC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()

	msgs := make([]domain.Message, 0)
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate messages: %w", err)
	}
	return msgs, nil
}

// Get fetches a single message by ID.
func (s *MessageStore) Get(ctx context.Context, id string) (domain.Message, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
		FROM messages
		WHERE id = ?
	`, id)
	m, err := scanMessage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Message{}, domain.NewError(domain.ErrCodeNotFound, "message not found", err)
	}
	if err != nil {
		return domain.Message{}, fmt.Errorf("get message %s: %w", id, err)
	}
	return m, nil
}

// Create inserts a new message into SQLite and updates the parent conversation timestamp.
func (s *MessageStore) Create(ctx context.Context, m domain.Message) (domain.Message, error) {
	if m.ID == "" {
		m.ID = domain.NewUUID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	blocks := m.Blocks
	if blocks == nil {
		blocks = []domain.ContentBlock{}
	}
	blocksBytes, err := json.Marshal(blocks)
	if err != nil {
		return domain.Message{}, fmt.Errorf("encode message blocks: %w", err)
	}
	var usageJSON sql.NullString
	if m.Usage != nil {
		usageBytes, err := json.Marshal(m.Usage)
		if err != nil {
			return domain.Message{}, fmt.Errorf("encode message usage: %w", err)
		}
		usageJSON = sql.NullString{String: string(usageBytes), Valid: true}
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO messages (
			id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, m.ID, m.ConversationID, m.Role, string(blocksBytes), m.ProviderID, m.ModelID, usageJSON, m.StopReason, m.ErrorMessage, formatTime(m.CreatedAt))
	if err != nil {
		return domain.Message{}, fmt.Errorf("create message: %w", err)
	}
	return s.Get(ctx, m.ID)
}

// DeleteFrom deletes the specified target message and all messages that follow it in the conversation.
func (s *MessageStore) DeleteFrom(ctx context.Context, conversationID, fromMessageID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin deleteFrom tx: %w", err)
	}

	var (
		targetRowID     int64
		targetCreatedAt string
	)
	err = tx.QueryRowContext(ctx, `
		SELECT rowid, created_at
		FROM messages
		WHERE id = ? AND conversation_id = ?
	`, fromMessageID, conversationID).Scan(&targetRowID, &targetCreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return domain.NewError(domain.ErrCodeNotFound, "target message not found in conversation", err)
	}
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("lookup target message: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		DELETE FROM messages
		WHERE conversation_id = ?
		  AND (created_at > ? OR (created_at = ? AND rowid >= ?))
	`, conversationID, targetCreatedAt, targetCreatedAt, targetRowID); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("delete messages from %s: %w", fromMessageID, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit deleteFrom tx: %w", err)
	}
	return nil
}

func scanMessage(row rowScanner) (domain.Message, error) {
	var (
		m          domain.Message
		blocksJSON string
		usageJSON  sql.NullString
		createdRaw string
	)
	if err := row.Scan(
		&m.ID, &m.ConversationID, &m.Role, &blocksJSON, &m.ProviderID, &m.ModelID,
		&usageJSON, &m.StopReason, &m.ErrorMessage, &createdRaw,
	); err != nil {
		return domain.Message{}, err
	}
	if blocksJSON == "" {
		m.Blocks = []domain.ContentBlock{}
	} else if err := json.Unmarshal([]byte(blocksJSON), &m.Blocks); err != nil {
		return domain.Message{}, fmt.Errorf("decode message blocks: %w", err)
	}
	if usageJSON.Valid && usageJSON.String != "" {
		var u domain.Usage
		if err := json.Unmarshal([]byte(usageJSON.String), &u); err != nil {
			return domain.Message{}, fmt.Errorf("decode message usage: %w", err)
		}
		m.Usage = &u
	}
	var err error
	if m.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.Message{}, fmt.Errorf("parse message created_at: %w", err)
	}
	return m, nil
}
