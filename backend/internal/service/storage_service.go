package service

import (
	"context"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

// StorageService exposes the database footprint and online compaction.
type StorageService struct {
	maintenance *store.StorageMaintenance
}

// NewStorageService constructs a StorageService.
func NewStorageService(maintenance *store.StorageMaintenance) *StorageService {
	return &StorageService{maintenance: maintenance}
}

// Usage reports the current database footprint.
func (s *StorageService) Usage(ctx context.Context) (domain.StorageUsage, error) {
	return s.maintenance.Usage(ctx)
}

// Compact reclaims unused database space.
func (s *StorageService) Compact(ctx context.Context) (domain.StorageCompactResult, error) {
	return s.maintenance.Compact(ctx)
}
