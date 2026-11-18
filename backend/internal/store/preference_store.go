package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"llmstudio/backend/internal/domain"
)

const preferencesSelect = "SELECT theme_mode, seed_color_value, enter_to_send, visual_html_render, default_html_preview, " +
	"chat_display_mode, auto_collapse_enabled, auto_collapse_thinking_on_complete, " +
	"auto_collapse_tools_on_complete, auto_create_cache, collapse_line_threshold, " +
	"collapse_char_threshold, imported " +
	"FROM user_preferences WHERE id = 1"

const preferencesUpsert = "INSERT INTO user_preferences (" +
	"id, theme_mode, seed_color_value, enter_to_send, visual_html_render, default_html_preview, " +
	"chat_display_mode, auto_collapse_enabled, auto_collapse_thinking_on_complete, " +
	"auto_collapse_tools_on_complete, auto_create_cache, collapse_line_threshold, " +
	"collapse_char_threshold, imported, updated_at" +
	") VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) " +
	"ON CONFLICT(id) DO UPDATE SET " +
	"theme_mode = excluded.theme_mode, " +
	"seed_color_value = excluded.seed_color_value, " +
	"enter_to_send = excluded.enter_to_send, " +
	"visual_html_render = excluded.visual_html_render, " +
	"default_html_preview = excluded.default_html_preview, " +
	"chat_display_mode = excluded.chat_display_mode, " +
	"auto_collapse_enabled = excluded.auto_collapse_enabled, " +
	"auto_collapse_thinking_on_complete = excluded.auto_collapse_thinking_on_complete, " +
	"auto_collapse_tools_on_complete = excluded.auto_collapse_tools_on_complete, " +
	"auto_create_cache = excluded.auto_create_cache, " +
	"collapse_line_threshold = excluded.collapse_line_threshold, " +
	"collapse_char_threshold = excluded.collapse_char_threshold, " +
	"imported = 1, " +
	"updated_at = excluded.updated_at"

// PreferenceStore persists the single-user application preferences and tracks
// whether the legacy browser preferences have already been imported.
type PreferenceStore struct {
	db *sql.DB
}

// NewPreferenceStore constructs a PreferenceStore backed by db.
func NewPreferenceStore(db *sql.DB) *PreferenceStore {
	return &PreferenceStore{db: db}
}

// Get returns the stored preferences and whether the row was already written.
// A missing row reports built-in defaults with initialized=false.
func (s *PreferenceStore) Get(ctx context.Context) (domain.Preferences, bool, error) {
	prefs, initialized, err := queryPreferences(ctx, s.db)
	if err == sql.ErrNoRows {
		return domain.DefaultPreferences(), false, nil
	}
	if err != nil {
		return domain.Preferences{}, false, fmt.Errorf("get preferences: %w", err)
	}
	return prefs, initialized, nil
}

// Update merges patch into the stored preferences and marks the row initialized.
// When onlyIfUninitialized is true the write is skipped once the row exists, so a
// late legacy import cannot overwrite committed values.
func (s *PreferenceStore) Update(ctx context.Context, patch domain.PreferencesPatch, onlyIfUninitialized bool) (domain.Preferences, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Preferences{}, false, fmt.Errorf("begin preferences update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	prefs, initialized, err := queryPreferences(ctx, tx)
	if err == sql.ErrNoRows {
		prefs, initialized = domain.DefaultPreferences(), false
	} else if err != nil {
		return domain.Preferences{}, false, fmt.Errorf("read preferences: %w", err)
	}

	if onlyIfUninitialized && initialized {
		if err := tx.Commit(); err != nil {
			return domain.Preferences{}, false, fmt.Errorf("commit preferences read: %w", err)
		}
		return prefs, true, nil
	}

	next := patch.Merge(prefs)
	if _, err := tx.ExecContext(ctx, preferencesUpsert,
		next.ThemeMode,
		int64(next.SeedColorValue),
		boolToInt(next.EnterToSend),
		boolToInt(next.VisualHTMLRender),
		boolToInt(next.DefaultHTMLPreview),
		next.ChatDisplayMode,
		boolToInt(next.AutoCollapseEnabled),
		boolToInt(next.AutoCollapseThinkingComplete),
		boolToInt(next.AutoCollapseToolsComplete),
		boolToInt(next.AutoCreateCache),
		next.CollapseLineThreshold,
		next.CollapseCharThreshold,
		formatTime(time.Now().UTC()),
	); err != nil {
		return domain.Preferences{}, false, fmt.Errorf("write preferences: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.Preferences{}, false, fmt.Errorf("commit preferences update: %w", err)
	}
	return next, true, nil
}

type preferencesQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func queryPreferences(ctx context.Context, q preferencesQuerier) (domain.Preferences, bool, error) {
	var (
		prefs         domain.Preferences
		seedColor     int64
		enterToSend   int
		visualHTML    int
		htmlPreview   int
		autoCollapse  int
		collapseThink int
		collapseTools int
		autoCache     int
		initialized   int
	)
	err := q.QueryRowContext(ctx, preferencesSelect).Scan(
		&prefs.ThemeMode,
		&seedColor,
		&enterToSend,
		&visualHTML,
		&htmlPreview,
		&prefs.ChatDisplayMode,
		&autoCollapse,
		&collapseThink,
		&collapseTools,
		&autoCache,
		&prefs.CollapseLineThreshold,
		&prefs.CollapseCharThreshold,
		&initialized,
	)
	if err != nil {
		return domain.Preferences{}, false, err
	}
	prefs.SeedColorValue = uint32(seedColor)
	prefs.EnterToSend = enterToSend != 0
	prefs.VisualHTMLRender = visualHTML != 0
	prefs.DefaultHTMLPreview = htmlPreview != 0
	prefs.AutoCollapseEnabled = autoCollapse != 0
	prefs.AutoCollapseThinkingComplete = collapseThink != 0
	prefs.AutoCollapseToolsComplete = collapseTools != 0
	prefs.AutoCreateCache = autoCache != 0
	return prefs, initialized != 0, nil
}
