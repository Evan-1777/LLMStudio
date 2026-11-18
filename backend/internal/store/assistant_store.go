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

// AssistantStore manages Assistant persistence in SQLite.
type AssistantStore struct {
	db *sql.DB
}

// NewAssistantStore constructs an AssistantStore backed by db.
func NewAssistantStore(db *sql.DB) *AssistantStore {
	return &AssistantStore{db: db}
}

// List returns all assistants with the default assistant first, followed by creation order.
func (s *AssistantStore) List(ctx context.Context) ([]domain.Assistant, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, system_prompt, default_provider_id, default_model_id, params_json, avatar_data_url, is_default, created_at, updated_at
		FROM assistants
		ORDER BY is_default DESC, created_at ASC, name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list assistants: %w", err)
	}
	defer rows.Close()

	items := make([]domain.Assistant, 0)
	for rows.Next() {
		a, err := scanAssistant(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate assistants: %w", err)
	}
	return items, nil
}

// Get fetches an assistant by ID.
func (s *AssistantStore) Get(ctx context.Context, id string) (domain.Assistant, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, system_prompt, default_provider_id, default_model_id, params_json, avatar_data_url, is_default, created_at, updated_at
		FROM assistants
		WHERE id = ?
	`, id)
	a, err := scanAssistant(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Assistant{}, domain.NewError(domain.ErrCodeNotFound, "assistant not found", err)
	}
	if err != nil {
		return domain.Assistant{}, fmt.Errorf("get assistant %s: %w", id, err)
	}
	return a, nil
}

// Create persists a new assistant record.
func (s *AssistantStore) Create(ctx context.Context, a domain.Assistant) (domain.Assistant, error) {
	now := time.Now().UTC()
	if a.ID == "" {
		a.ID = domain.NewUUID()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = now
	}
	if a.UpdatedAt.IsZero() {
		a.UpdatedAt = a.CreatedAt
	}
	paramsBytes, err := json.Marshal(a.Params)
	if err != nil {
		return domain.Assistant{}, fmt.Errorf("encode assistant params: %w", err)
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO assistants (
			id, name, system_prompt, default_provider_id, default_model_id, params_json, avatar_data_url, is_default, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, a.ID, a.Name, a.SystemPrompt, a.DefaultProviderID, a.DefaultModelID, string(paramsBytes), a.AvatarDataURL,
		boolToInt(a.IsDefault), formatTime(a.CreatedAt), formatTime(a.UpdatedAt))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return domain.Assistant{}, domain.NewError(domain.ErrCodeConflict, "assistant already exists", err)
		}
		return domain.Assistant{}, fmt.Errorf("create assistant: %w", err)
	}
	return s.Get(ctx, a.ID)
}

// Update persists changes to an existing assistant.
func (s *AssistantStore) Update(ctx context.Context, a domain.Assistant) (domain.Assistant, error) {
	a.UpdatedAt = time.Now().UTC()
	paramsBytes, err := json.Marshal(a.Params)
	if err != nil {
		return domain.Assistant{}, fmt.Errorf("encode assistant params: %w", err)
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE assistants
		SET name = ?, system_prompt = ?, default_provider_id = ?, default_model_id = ?, params_json = ?, avatar_data_url = ?, updated_at = ?
		WHERE id = ?
	`, a.Name, a.SystemPrompt, a.DefaultProviderID, a.DefaultModelID, string(paramsBytes), a.AvatarDataURL, formatTime(a.UpdatedAt), a.ID)
	if err != nil {
		return domain.Assistant{}, fmt.Errorf("update assistant %s: %w", a.ID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.Assistant{}, fmt.Errorf("rows affected update assistant %s: %w", a.ID, err)
	}
	if affected == 0 {
		return domain.Assistant{}, domain.NewError(domain.ErrCodeNotFound, "assistant not found", nil)
	}
	return s.Get(ctx, a.ID)
}

// Delete removes an assistant and reassigns its conversations to the default assistant atomically.
func (s *AssistantStore) Delete(ctx context.Context, id string) error {
	if id == domain.DefaultAssistantID {
		return domain.NewError(domain.ErrCodeInvalidArgument, "default assistant cannot be deleted", nil)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete assistant tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		UPDATE conversations
		SET assistant_id = ?,
			group_id = NULL,
			sort_order = sort_order + COALESCE((
				SELECT MAX(d.sort_order) FROM conversations d WHERE d.assistant_id = ?
			), 0) + 1000
		WHERE assistant_id = ?
	`, domain.DefaultAssistantID, domain.DefaultAssistantID, id); err != nil {
		return fmt.Errorf("reassign conversations for assistant %s: %w", id, err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM conversation_groups WHERE assistant_id = ?`, id); err != nil {
		return fmt.Errorf("delete conversation groups for assistant %s: %w", id, err)
	}

	res, err := tx.ExecContext(ctx, `DELETE FROM assistants WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete assistant %s: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected delete assistant %s: %w", id, err)
	}
	if affected == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "assistant not found", nil)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete assistant tx: %w", err)
	}
	return nil
}

func scanAssistant(row rowScanner) (domain.Assistant, error) {
	var (
		a          domain.Assistant
		paramsJSON string
		isDefault  int
		createdRaw string
		updatedRaw string
	)
	if err := row.Scan(
		&a.ID, &a.Name, &a.SystemPrompt, &a.DefaultProviderID, &a.DefaultModelID,
		&paramsJSON, &a.AvatarDataURL, &isDefault, &createdRaw, &updatedRaw,
	); err != nil {
		return domain.Assistant{}, err
	}
	a.IsDefault = isDefault != 0
	if paramsJSON != "" && paramsJSON != "{}" {
		if err := json.Unmarshal([]byte(paramsJSON), &a.Params); err != nil {
			return domain.Assistant{}, fmt.Errorf("decode assistant params: %w", err)
		}
	}
	var err error
	if a.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.Assistant{}, fmt.Errorf("parse assistant created_at: %w", err)
	}
	if a.UpdatedAt, err = parseTime(updatedRaw); err != nil {
		return domain.Assistant{}, fmt.Errorf("parse assistant updated_at: %w", err)
	}
	return a, nil
}
