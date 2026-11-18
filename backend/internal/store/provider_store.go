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

// ProviderStore manages ProviderConfig persistence in SQLite.
type ProviderStore struct {
	db *sql.DB
}

// NewProviderStore constructs a ProviderStore backed by db.
func NewProviderStore(db *sql.DB) *ProviderStore {
	return &ProviderStore{db: db}
}

// List returns all configured providers ordered with built-ins first, then creation time.
func (s *ProviderStore) List(ctx context.Context) ([]domain.ProviderConfig, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, adapter, base_url, auth_type, api_key, headers_json, models_json, enabled, built_in, local_request, created_at, updated_at
		FROM providers
		ORDER BY built_in DESC, created_at ASC, name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list providers: %w", err)
	}
	defer rows.Close()

	providers := make([]domain.ProviderConfig, 0)
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		providers = append(providers, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate providers: %w", err)
	}
	return providers, nil
}

// Get fetches a single provider by ID.
func (s *ProviderStore) Get(ctx context.Context, id string) (domain.ProviderConfig, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, adapter, base_url, auth_type, api_key, headers_json, models_json, enabled, built_in, local_request, created_at, updated_at, api_key_managed
		FROM providers
		WHERE id = ?
	`, id)
	p, err := scanProviderWithManaged(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ProviderConfig{}, domain.NewError(domain.ErrCodeNotFound, "provider not found", err)
	}
	if err != nil {
		return domain.ProviderConfig{}, fmt.Errorf("get provider %s: %w", id, err)
	}
	return p, nil
}

// Create inserts a new provider record.
func (s *ProviderStore) Create(ctx context.Context, p domain.ProviderConfig) (domain.ProviderConfig, error) {
	now := time.Now().UTC()
	if p.ID == "" {
		p.ID = domain.NewUUID()
	}
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	if p.UpdatedAt.IsZero() {
		p.UpdatedAt = p.CreatedAt
	}
	headersJSON, modelsJSON, err := encodeProviderJSON(p.Headers, p.Models)
	if err != nil {
		return domain.ProviderConfig{}, err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO providers (id, name, adapter, base_url, auth_type, api_key, headers_json, models_json, enabled, built_in, local_request, created_at, updated_at, api_key_managed)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Adapter, p.BaseURL, p.AuthType, p.APIKey, headersJSON, modelsJSON, boolToInt(p.Enabled), boolToInt(p.BuiltIn), boolToInt(p.LocalRequest), formatTime(p.CreatedAt), formatTime(p.UpdatedAt), boolToInt(p.APIKeyManaged() || strings.TrimSpace(p.APIKey) != ""))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return domain.ProviderConfig{}, domain.NewError(domain.ErrCodeConflict, "provider already exists", err)
		}
		return domain.ProviderConfig{}, fmt.Errorf("create provider: %w", err)
	}
	return s.Get(ctx, p.ID)
}

// EnsureBuiltIn inserts a built-in provider preset only when its ID does not yet exist.
func (s *ProviderStore) EnsureBuiltIn(ctx context.Context, p domain.ProviderConfig) error {
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	if p.UpdatedAt.IsZero() {
		p.UpdatedAt = p.CreatedAt
	}
	headersJSON, modelsJSON, err := encodeProviderJSON(p.Headers, p.Models)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO providers (id, name, adapter, base_url, auth_type, api_key, headers_json, models_json, enabled, built_in, local_request, created_at, updated_at, api_key_managed)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Adapter, p.BaseURL, p.AuthType, p.APIKey, headersJSON, modelsJSON, boolToInt(p.Enabled), boolToInt(p.BuiltIn), boolToInt(p.LocalRequest), formatTime(p.CreatedAt), formatTime(p.UpdatedAt), boolToInt(p.APIKeyManaged() || strings.TrimSpace(p.APIKey) != ""))
	if err != nil {
		return fmt.Errorf("ensure built-in provider %s: %w", p.ID, err)
	}
	return nil
}

// Update overwrites an existing provider record.
func (s *ProviderStore) Update(ctx context.Context, p domain.ProviderConfig) (domain.ProviderConfig, error) {
	p.UpdatedAt = time.Now().UTC()
	headersJSON, modelsJSON, err := encodeProviderJSON(p.Headers, p.Models)
	if err != nil {
		return domain.ProviderConfig{}, err
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE providers
		SET name = ?, adapter = ?, base_url = ?, auth_type = ?, api_key = ?, headers_json = ?, models_json = ?, enabled = ?, local_request = ?, api_key_managed = ?, updated_at = ?
		WHERE id = ?
	`, p.Name, p.Adapter, p.BaseURL, p.AuthType, p.APIKey, headersJSON, modelsJSON, boolToInt(p.Enabled), boolToInt(p.LocalRequest), boolToInt(p.APIKeyManaged()), formatTime(p.UpdatedAt), p.ID)
	if err != nil {
		return domain.ProviderConfig{}, fmt.Errorf("update provider %s: %w", p.ID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.ProviderConfig{}, fmt.Errorf("rows affected update provider %s: %w", p.ID, err)
	}
	if affected == 0 {
		return domain.ProviderConfig{}, domain.NewError(domain.ErrCodeNotFound, "provider not found", nil)
	}
	return s.Get(ctx, p.ID)
}

// Delete removes a provider by ID.
func (s *ProviderStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM providers WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete provider %s: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected delete provider %s: %w", id, err)
	}
	if affected == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "provider not found", nil)
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

// KeyImportResult reports whether an unmanaged browser credential was adopted.
type KeyImportResult int

// Key import outcomes. Zero-row updates are separated because the caller must tell
// "provider missing", "not in local request mode", and "already gateway-owned" apart.
const (
	KeyImportApplied KeyImportResult = iota
	KeyImportNotFound
	KeyImportNotEligible
	KeyImportAlreadyManaged
)

// ImportAPIKey copies a legacy browser credential into an unmanaged local-request
// provider. The conditional UPDATE is atomic: a concurrent set, clear, or import
// cannot be overwritten by a stale browser copy, and only a non-empty key is taken.
func (s *ProviderStore) ImportAPIKey(ctx context.Context, id, apiKey string) (KeyImportResult, error) {
	key := strings.TrimSpace(apiKey)
	if key == "" {
		return s.classifyKeyImport(ctx, id)
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE providers
		SET api_key = ?, api_key_managed = 1, updated_at = ?
		WHERE id = ? AND local_request = 1 AND api_key = '' AND api_key_managed = 0
	`, key, formatTime(time.Now().UTC()), id)
	if err != nil {
		return KeyImportNotFound, fmt.Errorf("import provider api key %s: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return KeyImportNotFound, fmt.Errorf("rows affected import provider api key %s: %w", id, err)
	}
	if affected == 0 {
		return s.classifyKeyImport(ctx, id)
	}
	return KeyImportApplied, nil
}

func (s *ProviderStore) classifyKeyImport(ctx context.Context, id string) (KeyImportResult, error) {
	var localRequest, managed int
	err := s.db.QueryRowContext(ctx,
		"SELECT local_request, api_key_managed FROM providers WHERE id = ?", id,
	).Scan(&localRequest, &managed)
	if errors.Is(err, sql.ErrNoRows) {
		return KeyImportNotFound, nil
	}
	if err != nil {
		return KeyImportNotFound, fmt.Errorf("classify provider api key import %s: %w", id, err)
	}
	if localRequest == 0 {
		return KeyImportNotEligible, nil
	}
	return KeyImportAlreadyManaged, nil
}

func scanProvider(row rowScanner) (domain.ProviderConfig, error) {
	return scanProviderRow(row, false)
}

func scanProviderWithManaged(row rowScanner) (domain.ProviderConfig, error) {
	return scanProviderRow(row, true)
}

func scanProviderRow(row rowScanner, withManaged bool) (domain.ProviderConfig, error) {
	var (
		p               domain.ProviderConfig
		headersJSON     string
		modelsJSON      string
		enabledInt      int
		builtInInt      int
		localRequestInt int
		createdRaw      string
		updatedRaw      string
	)
	dest := []any{
		&p.ID, &p.Name, &p.Adapter, &p.BaseURL, &p.AuthType, &p.APIKey,
		&headersJSON, &modelsJSON, &enabledInt, &builtInInt, &localRequestInt, &createdRaw, &updatedRaw,
	}
	var managedInt int
	if withManaged {
		dest = append(dest, &managedInt)
	}
	if err := row.Scan(dest...); err != nil {
		return domain.ProviderConfig{}, err
	}
	if withManaged && managedInt != 0 {
		p.MarkAPIKeyManaged()
	}
	p.Enabled = enabledInt != 0
	p.BuiltIn = builtInInt != 0
	p.LocalRequest = localRequestInt != 0

	if headersJSON != "" && headersJSON != "{}" {
		if err := json.Unmarshal([]byte(headersJSON), &p.Headers); err != nil {
			return domain.ProviderConfig{}, fmt.Errorf("decode provider headers: %w", err)
		}
	}
	if modelsJSON == "" {
		p.Models = []domain.ModelConfig{}
	} else if err := json.Unmarshal([]byte(modelsJSON), &p.Models); err != nil {
		return domain.ProviderConfig{}, fmt.Errorf("decode provider models: %w", err)
	}
	var err error
	if p.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.ProviderConfig{}, fmt.Errorf("parse provider created_at: %w", err)
	}
	if p.UpdatedAt, err = parseTime(updatedRaw); err != nil {
		return domain.ProviderConfig{}, fmt.Errorf("parse provider updated_at: %w", err)
	}
	return p, nil
}

func encodeProviderJSON(headers map[string]string, models []domain.ModelConfig) (string, string, error) {
	if headers == nil {
		headers = map[string]string{}
	}
	if models == nil {
		models = []domain.ModelConfig{}
	}
	hBytes, err := json.Marshal(headers)
	if err != nil {
		return "", "", fmt.Errorf("encode provider headers: %w", err)
	}
	mBytes, err := json.Marshal(models)
	if err != nil {
		return "", "", fmt.Errorf("encode provider models: %w", err)
	}
	return string(hBytes), string(mBytes), nil
}
