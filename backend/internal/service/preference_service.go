package service

import (
	"context"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

// PreferenceService manages the single-user application preferences persisted by the gateway.
type PreferenceService struct {
	store *store.PreferenceStore
}

// NewPreferenceService constructs a PreferenceService.
func NewPreferenceService(store *store.PreferenceStore) *PreferenceService {
	return &PreferenceService{store: store}
}

// Get returns the stored preferences and whether they were previously written.
func (s *PreferenceService) Get(ctx context.Context) (domain.Preferences, bool, error) {
	return s.store.Get(ctx)
}

// Update applies a partial preference update. Only the requested fields reach the
// store, so the merge, validation and write stay in one transaction.
func (s *PreferenceService) Update(ctx context.Context, patch domain.PreferencesPatch) (domain.Preferences, bool, error) {
	return s.store.Update(ctx, patch, false, validatePreferences)
}

// ImportLegacy seeds preferences from legacy browser storage exactly once.
// The legacy payload cannot set the avatar, composer reasoning or MCP round limit.
func (s *PreferenceService) ImportLegacy(ctx context.Context, input domain.Preferences) (domain.Preferences, bool, error) {
	input.UserAvatarDataURL = ""
	return s.store.Update(ctx, fullPatch(input.Normalize()), true, validatePreferences)
}

func validatePreferences(p domain.Preferences) error {
	return p.Validate()
}

// fullPatch converts validated preferences into the complete field patch used for persistence.
func fullPatch(next domain.Preferences) domain.PreferencesPatch {
	return domain.PreferencesPatch{
		ThemeMode:                    &next.ThemeMode,
		SeedColorValue:               &next.SeedColorValue,
		EnterToSend:                  &next.EnterToSend,
		VisualHTMLRender:             &next.VisualHTMLRender,
		DefaultHTMLPreview:           &next.DefaultHTMLPreview,
		ChatDisplayMode:              &next.ChatDisplayMode,
		AutoCollapseEnabled:          &next.AutoCollapseEnabled,
		AutoCollapseThinkingComplete: &next.AutoCollapseThinkingComplete,
		AutoCollapseToolsComplete:    &next.AutoCollapseToolsComplete,
		AutoCreateCache:              &next.AutoCreateCache,
		CollapseLineThreshold:        &next.CollapseLineThreshold,
		CollapseCharThreshold:        &next.CollapseCharThreshold,
		UserAvatarDataURL:            &next.UserAvatarDataURL,
	}
}
