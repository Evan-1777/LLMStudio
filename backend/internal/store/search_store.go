package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"llmstudio/backend/internal/domain"
)

// SearchConfigStore manages persisted SearchEngineConfig records in SQLite.
type SearchConfigStore struct {
	db *sql.DB
}

// NewSearchConfigStore constructs a SearchConfigStore backed by db.
func NewSearchConfigStore(db *sql.DB) *SearchConfigStore {
	return &SearchConfigStore{db: db}
}

// List returns all persisted search engine configurations.
func (s *SearchConfigStore) List(ctx context.Context) ([]domain.SearchEngineConfig, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT engine_id, enabled, endpoint, api_key, max_results, is_default, updated_at
		FROM search_configs
		ORDER BY is_default DESC, engine_id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list search configs: %w", err)
	}
	defer rows.Close()

	items := make([]domain.SearchEngineConfig, 0)
	for rows.Next() {
		cfg, err := scanSearchConfig(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, cfg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate search configs: %w", err)
	}
	return items, nil
}

// Get fetches a single search engine configuration by engine ID.
func (s *SearchConfigStore) Get(ctx context.Context, engineID string) (domain.SearchEngineConfig, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT engine_id, enabled, endpoint, api_key, max_results, is_default, updated_at
		FROM search_configs
		WHERE engine_id = ?
	`, engineID)
	cfg, err := scanSearchConfig(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SearchEngineConfig{}, domain.NewError(domain.ErrCodeNotFound, "search config not found", err)
	}
	if err != nil {
		return domain.SearchEngineConfig{}, fmt.Errorf("get search config %s: %w", engineID, err)
	}
	return cfg, nil
}

// Upsert inserts or updates a search engine configuration, clearing other defaults when IsDefault is set.
func (s *SearchConfigStore) Upsert(ctx context.Context, cfg domain.SearchEngineConfig) (domain.SearchEngineConfig, error) {
	if cfg.MaxResults <= 0 {
		cfg.MaxResults = 5
	}
	cfg.UpdatedAt = time.Now().UTC()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.SearchEngineConfig{}, fmt.Errorf("begin upsert search config tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if cfg.IsDefault {
		if _, err := tx.ExecContext(ctx, `UPDATE search_configs SET is_default = 0 WHERE engine_id != ?`, cfg.EngineID); err != nil {
			return domain.SearchEngineConfig{}, fmt.Errorf("clear default search engine: %w", err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO search_configs (engine_id, enabled, endpoint, api_key, max_results, is_default, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(engine_id) DO UPDATE SET
			enabled = excluded.enabled,
			endpoint = excluded.endpoint,
			api_key = excluded.api_key,
			max_results = excluded.max_results,
			is_default = excluded.is_default,
			updated_at = excluded.updated_at
	`, cfg.EngineID, boolToInt(cfg.Enabled), cfg.Endpoint, cfg.APIKey, cfg.MaxResults, boolToInt(cfg.IsDefault), formatTime(cfg.UpdatedAt)); err != nil {
		return domain.SearchEngineConfig{}, fmt.Errorf("upsert search config %s: %w", cfg.EngineID, err)
	}

	if err := tx.Commit(); err != nil {
		return domain.SearchEngineConfig{}, fmt.Errorf("commit upsert search config tx: %w", err)
	}
	return s.Get(ctx, cfg.EngineID)
}

// Delete removes a search engine configuration by engine ID.
func (s *SearchConfigStore) Delete(ctx context.Context, engineID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM search_configs WHERE engine_id = ?`, engineID)
	if err != nil {
		return fmt.Errorf("delete search config %s: %w", engineID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected delete search config %s: %w", engineID, err)
	}
	if affected == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "search config not found", nil)
	}
	return nil
}

func scanSearchConfig(row rowScanner) (domain.SearchEngineConfig, error) {
	var (
		cfg        domain.SearchEngineConfig
		enabledInt int
		defaultInt int
		updatedRaw string
	)
	if err := row.Scan(
		&cfg.EngineID, &enabledInt, &cfg.Endpoint, &cfg.APIKey,
		&cfg.MaxResults, &defaultInt, &updatedRaw,
	); err != nil {
		return domain.SearchEngineConfig{}, err
	}
	cfg.Enabled = enabledInt != 0
	cfg.IsDefault = defaultInt != 0
	var err error
	if cfg.UpdatedAt, err = parseTime(updatedRaw); err != nil {
		return domain.SearchEngineConfig{}, fmt.Errorf("parse search config updated_at: %w", err)
	}
	return cfg, nil
}
