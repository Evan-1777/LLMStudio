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
	blocksJSON, usageJSON, err := encodeMessagePayloads(m.Blocks, m.Usage)
	if err != nil {
		return domain.Message{}, err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO messages (
			id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, m.ID, m.ConversationID, m.Role, blocksJSON, m.ProviderID, m.ModelID, usageJSON, m.StopReason, m.ErrorMessage, formatTime(m.CreatedAt))
	if err != nil {
		return domain.Message{}, fmt.Errorf("create message: %w", err)
	}
	return s.Get(ctx, m.ID)
}

// UpdateBlocks updates blocks_json of an existing message in place while preserving its identity and order.
func (s *MessageStore) UpdateBlocks(ctx context.Context, conversationID, messageID string, blocks []domain.ContentBlock) (domain.Message, error) {
	blocksJSON, _, err := encodeMessagePayloads(blocks, nil)
	if err != nil {
		return domain.Message{}, err
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE messages
		SET blocks_json = ?
		WHERE id = ? AND conversation_id = ?
	`, blocksJSON, messageID, conversationID)
	if err != nil {
		return domain.Message{}, fmt.Errorf("update message %s: %w", messageID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.Message{}, fmt.Errorf("rows affected update message %s: %w", messageID, err)
	}
	if affected == 0 {
		return domain.Message{}, domain.NewError(domain.ErrCodeNotFound, "message not found in conversation", nil)
	}
	return s.Get(ctx, messageID)
}

// ReplaceByID overwrites a message in place while preserving its original created_at and SQLite rowid.
func (s *MessageStore) ReplaceByID(ctx context.Context, conversationID, targetMessageID string, next domain.Message) (domain.Message, error) {
	if next.ID == "" {
		next.ID = domain.NewUUID()
	}
	blocksJSON, usageJSON, err := encodeMessagePayloads(next.Blocks, next.Usage)
	if err != nil {
		return domain.Message{}, err
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE messages
		SET id = ?, role = ?, blocks_json = ?, provider_id = ?, model_id = ?, usage_json = ?, stop_reason = ?, error_message = ?
		WHERE id = ? AND conversation_id = ?
	`, next.ID, next.Role, blocksJSON, next.ProviderID, next.ModelID, usageJSON, next.StopReason, next.ErrorMessage, targetMessageID, conversationID)
	if err != nil {
		return domain.Message{}, fmt.Errorf("replace message %s: %w", targetMessageID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.Message{}, fmt.Errorf("rows affected replace message %s: %w", targetMessageID, err)
	}
	if affected == 0 {
		return domain.Message{}, domain.NewError(domain.ErrCodeNotFound, "message not found in conversation", nil)
	}
	return s.Get(ctx, next.ID)
}

// InsertAfter inserts next immediately after afterMessageID within the conversation's chronological order.
func (s *MessageStore) InsertAfter(ctx context.Context, conversationID, afterMessageID string, next domain.Message) (domain.Message, error) {
	if next.ID == "" {
		next.ID = domain.NewUUID()
	}
	blocksJSON, usageJSON, err := encodeMessagePayloads(next.Blocks, next.Usage)
	if err != nil {
		return domain.Message{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Message{}, fmt.Errorf("begin insertAfter tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		afterRowID      int64
		afterCreatedRaw string
	)
	err = tx.QueryRowContext(ctx, `
		SELECT rowid, created_at
		FROM messages
		WHERE id = ? AND conversation_id = ?
	`, afterMessageID, conversationID).Scan(&afterRowID, &afterCreatedRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Message{}, domain.NewError(domain.ErrCodeNotFound, "anchor message not found in conversation", err)
	}
	if err != nil {
		return domain.Message{}, fmt.Errorf("lookup anchor message: %w", err)
	}
	afterCreatedAt, err := parseTime(afterCreatedRaw)
	if err != nil {
		return domain.Message{}, fmt.Errorf("parse anchor created_at: %w", err)
	}

	var nextCreatedRaw string
	err = tx.QueryRowContext(ctx, `
		SELECT created_at
		FROM messages
		WHERE conversation_id = ?
		  AND (created_at > ? OR (created_at = ? AND rowid > ?))
		ORDER BY created_at ASC, rowid ASC
		LIMIT 1
	`, conversationID, afterCreatedRaw, afterCreatedRaw, afterRowID).Scan(&nextCreatedRaw)

	var insertAt time.Time
	switch {
	case errors.Is(err, sql.ErrNoRows):
		now := time.Now().UTC()
		candidate := afterCreatedAt.Add(time.Microsecond)
		if now.After(candidate) {
			insertAt = now
		} else {
			insertAt = candidate
		}
	case err != nil:
		return domain.Message{}, fmt.Errorf("lookup following message: %w", err)
	default:
		nextCreatedAt, pErr := parseTime(nextCreatedRaw)
		if pErr != nil {
			return domain.Message{}, fmt.Errorf("parse following created_at: %w", pErr)
		}
		gap := nextCreatedAt.Sub(afterCreatedAt)
		if gap >= 2*time.Nanosecond {
			insertAt = afterCreatedAt.Add(gap / 2)
		} else {
			if err := shiftMessagesForward(ctx, tx, conversationID, afterCreatedRaw, afterRowID, 2*time.Millisecond); err != nil {
				return domain.Message{}, err
			}
			insertAt = afterCreatedAt.Add(time.Millisecond)
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO messages (
			id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, next.ID, conversationID, next.Role, blocksJSON, next.ProviderID, next.ModelID, usageJSON, next.StopReason, next.ErrorMessage, formatTime(insertAt)); err != nil {
		return domain.Message{}, fmt.Errorf("insert message after %s: %w", afterMessageID, err)
	}
	if err := tx.Commit(); err != nil {
		return domain.Message{}, fmt.Errorf("commit insertAfter tx: %w", err)
	}
	return s.Get(ctx, next.ID)
}

func shiftMessagesForward(ctx context.Context, tx *sql.Tx, conversationID, afterCreatedRaw string, afterRowID int64, delta time.Duration) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, created_at
		FROM messages
		WHERE conversation_id = ?
		  AND (created_at > ? OR (created_at = ? AND rowid > ?))
		ORDER BY created_at ASC, rowid ASC
	`, conversationID, afterCreatedRaw, afterCreatedRaw, afterRowID)
	if err != nil {
		return fmt.Errorf("query messages to shift: %w", err)
	}
	type rowItem struct {
		id        string
		createdAt time.Time
	}
	var toShift []rowItem
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan message to shift: %w", err)
		}
		t, err := parseTime(raw)
		if err != nil {
			_ = rows.Close()
			return fmt.Errorf("parse created_at to shift: %w", err)
		}
		toShift = append(toShift, rowItem{id: id, createdAt: t.Add(delta)})
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate messages to shift: %w", err)
	}
	_ = rows.Close()

	for _, item := range toShift {
		if _, err := tx.ExecContext(ctx, `UPDATE messages SET created_at = ? WHERE id = ?`, formatTime(item.createdAt), item.id); err != nil {
			return fmt.Errorf("shift message %s: %w", item.id, err)
		}
	}
	return nil
}

func encodeMessagePayloads(blocks []domain.ContentBlock, usage *domain.Usage) (string, sql.NullString, error) {
	if blocks == nil {
		blocks = []domain.ContentBlock{}
	}
	blocksBytes, err := json.Marshal(blocks)
	if err != nil {
		return "", sql.NullString{}, fmt.Errorf("encode message blocks: %w", err)
	}
	var usageJSON sql.NullString
	if usage != nil {
		usageBytes, err := json.Marshal(usage)
		if err != nil {
			return "", sql.NullString{}, fmt.Errorf("encode message usage: %w", err)
		}
		usageJSON = sql.NullString{String: string(usageBytes), Valid: true}
	}
	return string(blocksBytes), usageJSON, nil
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

// DeleteByID deletes a single message in a conversation without removing subsequent messages.
func (s *MessageStore) DeleteByID(ctx context.Context, conversationID, messageID string) error {
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM messages
		WHERE id = ? AND conversation_id = ?
	`, messageID, conversationID)
	if err != nil {
		return fmt.Errorf("delete message %s: %w", messageID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected delete message %s: %w", messageID, err)
	}
	if affected == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "message not found in conversation", nil)
	}
	return nil
}

// ListUpTo returns messages in chronological order up to and including upToMessageID.
func (s *MessageStore) ListUpTo(ctx context.Context, conversationID, upToMessageID string) ([]domain.Message, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin listUpTo tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		targetRowID     int64
		targetCreatedAt string
	)
	err = tx.QueryRowContext(ctx, `
		SELECT rowid, created_at
		FROM messages
		WHERE id = ? AND conversation_id = ?
	`, upToMessageID, conversationID).Scan(&targetRowID, &targetCreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.NewError(domain.ErrCodeNotFound, "target message not found in conversation", err)
	}
	if err != nil {
		return nil, fmt.Errorf("lookup target message: %w", err)
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT id, conversation_id, role, blocks_json, provider_id, model_id, usage_json, stop_reason, error_message, created_at
		FROM messages
		WHERE conversation_id = ?
		  AND (created_at < ? OR (created_at = ? AND rowid <= ?))
		ORDER BY created_at ASC, rowid ASC
	`, conversationID, targetCreatedAt, targetCreatedAt, targetRowID)
	if err != nil {
		return nil, fmt.Errorf("list messages up to %s: %w", upToMessageID, err)
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
		return nil, fmt.Errorf("iterate messages up to %s: %w", upToMessageID, err)
	}
	return msgs, nil
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
