package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

// CustomFontService manages validation and persistence of the gateway custom font.
type CustomFontService struct {
	store *store.CustomFontStore
}

// NewCustomFontService constructs a CustomFontService.
func NewCustomFontService(store *store.CustomFontStore) *CustomFontService {
	return &CustomFontService{store: store}
}

// GetMeta returns metadata for the stored font, or nil when none exists.
func (s *CustomFontService) GetMeta(ctx context.Context) (*domain.CustomFontMeta, error) {
	return s.store.GetMeta(ctx)
}

// GetFile returns metadata and raw bytes read from the same database row.
func (s *CustomFontService) GetFile(ctx context.Context) (*domain.CustomFontRecord, error) {
	return s.store.GetFile(ctx)
}

// Put validates and stores a TrueType font, replacing any previous font only after validation succeeds.
func (s *CustomFontService) Put(ctx context.Context, name string, data []byte) (domain.CustomFontMeta, error) {
	cleanName, err := domain.ValidateCustomFont(name, data)
	if err != nil {
		return domain.CustomFontMeta{}, err
	}
	sum := sha256.Sum256(data)
	return s.store.Put(ctx, cleanName, data, hex.EncodeToString(sum[:]), true)
}

// SetEnabled toggles whether the stored font is active.
func (s *CustomFontService) SetEnabled(ctx context.Context, enabled bool) (domain.CustomFontMeta, error) {
	return s.store.SetEnabled(ctx, enabled)
}

// Delete removes the stored font record.
func (s *CustomFontService) Delete(ctx context.Context) error {
	return s.store.Delete(ctx)
}
