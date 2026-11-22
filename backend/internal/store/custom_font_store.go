package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"llmstudio/backend/internal/domain"
)

// CustomFontStore persists the single cloud custom font row.
type CustomFontStore struct {
	db *sql.DB
}

// NewCustomFontStore constructs a CustomFontStore backed by db.
func NewCustomFontStore(db *sql.DB) *CustomFontStore {
	return &CustomFontStore{db: db}
}

// GetMeta reads font metadata without loading the binary BLOB.
// Returns (nil, nil) when no font is stored.
func (s *CustomFontStore) GetMeta(ctx context.Context) (*domain.CustomFontMeta, error) {
	var (
		meta       domain.CustomFontMeta
		enabled    int
		updatedRaw string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT name, enabled, sha256, size_bytes, updated_at
		FROM custom_font
		WHERE id = 1
	`).Scan(&meta.Name, &enabled, &meta.SHA256, &meta.SizeBytes, &updatedRaw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get custom font metadata: %w", err)
	}
	meta.Enabled = enabled != 0
	if parsed, pErr := parseTime(updatedRaw); pErr == nil {
		meta.UpdatedAt = parsed
	}
	return &meta, nil
}

// GetFile reads font metadata and binary bytes from the same row.
// Returns (nil, nil) when no font is stored.
func (s *CustomFontStore) GetFile(ctx context.Context) (*domain.CustomFontRecord, error) {
	var (
		rec        domain.CustomFontRecord
		enabled    int
		updatedRaw string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT name, enabled, sha256, size_bytes, data, updated_at
		FROM custom_font
		WHERE id = 1
	`).Scan(&rec.Name, &enabled, &rec.SHA256, &rec.SizeBytes, &rec.Data, &updatedRaw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get custom font file: %w", err)
	}
	rec.Enabled = enabled != 0
	if parsed, pErr := parseTime(updatedRaw); pErr == nil {
		rec.UpdatedAt = parsed
	}
	return &rec, nil
}

// Put replaces the single custom font row atomically.
func (s *CustomFontStore) Put(
	ctx context.Context,
	name string,
	data []byte,
	sha256Hex string,
	enabled bool,
) (domain.CustomFontMeta, error) {
	now := time.Now().UTC()
	sizeBytes := int64(len(data))
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO custom_font (id, name, enabled, sha256, size_bytes, data, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			enabled = excluded.enabled,
			sha256 = excluded.sha256,
			size_bytes = excluded.size_bytes,
			data = excluded.data,
			updated_at = excluded.updated_at
	`, name, boolToInt(enabled), sha256Hex, sizeBytes, data, formatTime(now))
	if err != nil {
		return domain.CustomFontMeta{}, fmt.Errorf("put custom font: %w", err)
	}
	return domain.CustomFontMeta{
		Name:      name,
		Enabled:   enabled,
		SHA256:    sha256Hex,
		SizeBytes: sizeBytes,
		UpdatedAt: now,
	}, nil
}

// SetEnabled updates only the enabled flag and timestamp on the stored font row.
func (s *CustomFontStore) SetEnabled(ctx context.Context, enabled bool) (domain.CustomFontMeta, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.CustomFontMeta{}, fmt.Errorf("begin set custom font enabled: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	res, err := tx.ExecContext(ctx, `
		UPDATE custom_font
		SET enabled = ?, updated_at = ?
		WHERE id = 1
	`, boolToInt(enabled), formatTime(now))
	if err != nil {
		return domain.CustomFontMeta{}, fmt.Errorf("update custom font enabled: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.CustomFontMeta{}, fmt.Errorf("custom font rows affected: %w", err)
	}
	if affected == 0 {
		return domain.CustomFontMeta{}, domain.NewError(domain.ErrCodeNotFound, "custom font not found", nil)
	}

	var (
		meta       domain.CustomFontMeta
		enabledInt int
		updatedRaw string
	)
	if err := tx.QueryRowContext(ctx, `
		SELECT name, enabled, sha256, size_bytes, updated_at
		FROM custom_font
		WHERE id = 1
	`).Scan(&meta.Name, &enabledInt, &meta.SHA256, &meta.SizeBytes, &updatedRaw); err != nil {
		return domain.CustomFontMeta{}, fmt.Errorf("read updated custom font metadata: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.CustomFontMeta{}, fmt.Errorf("commit custom font enabled: %w", err)
	}
	meta.Enabled = enabledInt != 0
	if parsed, pErr := parseTime(updatedRaw); pErr == nil {
		meta.UpdatedAt = parsed
	}
	return meta, nil
}

// Delete removes the single custom font row if present.
func (s *CustomFontStore) Delete(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM custom_font WHERE id = 1`); err != nil {
		return fmt.Errorf("delete custom font: %w", err)
	}
	return nil
}
