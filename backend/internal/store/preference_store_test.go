package store

import (
	"context"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/domain"
)

func TestPreferenceStoreDefaultsPartialUpdateAndLegacyImport(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "prefs.db")

	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	prefs := NewPreferenceStore(db)

	got, initialized, err := prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get defaults: %v", err)
	}
	if initialized {
		t.Fatal("expected a fresh database to report initialized=false")
	}
	if got != domain.DefaultPreferences() || got.MCPMaxToolRounds != 20 {
		t.Fatalf("unexpected defaults: %+v", got)
	}

	for _, rounds := range []int{0, 101} {
		_, _, err := prefs.Update(ctx, domain.PreferencesPatch{MCPMaxToolRounds: &rounds}, false, validatePrefs)
		if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeInvalidArgument {
			t.Fatalf("round limit %d: got %v, want invalid argument", rounds, err)
		}
	}
	rounds := 30
	theme := domain.ThemeModeDark
	enter := false
	if _, initialized, err = prefs.Update(ctx, domain.PreferencesPatch{ThemeMode: &theme, EnterToSend: &enter, MCPMaxToolRounds: &rounds}, false, validatePrefs); err != nil {
		t.Fatalf("partial update: %v", err)
	} else if !initialized {
		t.Fatal("expected update to report initialized=true")
	}

	got, initialized, err = prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get after update: %v", err)
	}
	if !initialized {
		t.Fatal("expected persisted row to report initialized=true")
	}
	if got.ThemeMode != domain.ThemeModeDark || got.EnterToSend || got.MCPMaxToolRounds != rounds {
		t.Fatalf("update not applied: %+v", got)
	}
	if got.SeedColorValue != domain.DefaultAppleBlue || got.CollapseLineThreshold != 24 || got.ChatDisplayMode != domain.ChatDisplayBubble {
		t.Fatalf("partial update overwrote untouched fields: %+v", got)
	}

	// Explicitly disabling a default-on flag must survive a restart.
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	db, err = OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	prefs = NewPreferenceStore(db)

	preview := false
	if _, _, err := prefs.Update(ctx, domain.PreferencesPatch{DefaultHTMLPreview: &preview}, false, validatePrefs); err != nil {
		t.Fatalf("explicit false update: %v", err)
	}
	got, _, err = prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get after explicit false: %v", err)
	}
	if got.ThemeMode != domain.ThemeModeDark || got.EnterToSend || got.MCPMaxToolRounds != rounds {
		t.Fatalf("restart lost previous values: %+v", got)
	}

	// A late legacy import is ignored once the row is initialized.
	legacy := domain.DefaultPreferences()
	legacy.ThemeMode = domain.ThemeModeLight
	stored, initialized, err := prefs.Update(ctx, patchFromPreferences(legacy), true, validatePrefs)
	if err != nil {
		t.Fatalf("legacy import on initialized row: %v", err)
	}
	if !initialized || stored.ThemeMode != domain.ThemeModeDark {
		t.Fatalf("legacy import overwrote committed values: %+v", stored)
	}

	// Resetting import state lets the next legacy import apply exactly once.
	if _, err := db.ExecContext(ctx, "UPDATE user_preferences SET imported = 0"); err != nil {
		t.Fatalf("reset imported flag: %v", err)
	}
	stored, _, err = prefs.Update(ctx, patchFromPreferences(legacy), true, validatePrefs)
	if err != nil {
		t.Fatalf("legacy import: %v", err)
	}
	if stored.ThemeMode != domain.ThemeModeLight {
		t.Fatalf("legacy import not applied: %+v", stored)
	}
	stored, _, err = prefs.Update(ctx, domain.PreferencesPatch{ThemeMode: &theme}, true, validatePrefs)
	if err != nil {
		t.Fatalf("second legacy import: %v", err)
	}
	if stored.ThemeMode != domain.ThemeModeLight {
		t.Fatalf("legacy import replayed: %+v", stored)
	}

	// Chat width defaults, partial update and range validation.
	if stored.ChatWidthMode != domain.ChatWidthDefault || stored.ChatManualWidth != domain.DefaultChatManualWidth {
		t.Fatalf("unexpected chat width defaults: mode=%q width=%d", stored.ChatWidthMode, stored.ChatManualWidth)
	}
	badWidthMode := "wide"
	if _, _, err := prefs.Update(ctx, domain.PreferencesPatch{ChatWidthMode: &badWidthMode}, false, validatePrefs); err == nil {
		t.Fatal("expected invalid chatWidthMode to fail validation")
	}
	for _, badWidth := range []int{300, 5000} {
		w := badWidth
		if _, _, err := prefs.Update(ctx, domain.PreferencesPatch{ChatManualWidth: &w}, false, validatePrefs); err == nil {
			t.Fatalf("expected out-of-range chatManualWidth %d to fail", badWidth)
		}
	}
	manualMode := " MANUAL "
	manualWidth := 1120
	updated, _, err := prefs.Update(ctx, domain.PreferencesPatch{
		ChatWidthMode:   &manualMode,
		ChatManualWidth: &manualWidth,
	}, false, validatePrefs)
	if err != nil {
		t.Fatalf("update chat width prefs: %v", err)
	}
	if updated.ChatWidthMode != domain.ChatWidthManual || updated.ChatManualWidth != 1120 {
		t.Fatalf("unexpected persisted width prefs: %+v", updated)
	}

	// Typography defaults, partial update and validation.
	if stored.FontFamily != domain.FontFamilySystem || stored.FontSize != domain.DefaultFontSize {
		t.Fatalf("unexpected typography defaults: family=%q size=%d", stored.FontFamily, stored.FontSize)
	}
	badFont := "comic"
	if _, _, err := prefs.Update(ctx, domain.PreferencesPatch{FontFamily: &badFont}, false, validatePrefs); err == nil {
		t.Fatal("expected invalid fontFamily to fail validation")
	}
	for _, badSize := range []int{11, 23} {
		sz := badSize
		if _, _, err := prefs.Update(ctx, domain.PreferencesPatch{FontSize: &sz}, false, validatePrefs); err == nil {
			t.Fatalf("expected out-of-range fontSize %d to fail validation", badSize)
		}
	}
	kai := " kai "
	fontSize := 18
	typoUpdated, _, err := prefs.Update(ctx, domain.PreferencesPatch{
		FontFamily: &kai,
		FontSize:   &fontSize,
	}, false, validatePrefs)
	if err != nil {
		t.Fatalf("update typography prefs: %v", err)
	}
	if typoUpdated.FontFamily != domain.FontFamilyKai || typoUpdated.FontSize != 18 {
		t.Fatalf("unexpected persisted typography prefs: %+v", typoUpdated)
	}

	if stored.BuiltinTimeToolEnabled {
		t.Fatal("expected builtinTimeToolEnabled default false")
	}
	enableTime := true
	timeUpdated, _, err := prefs.Update(ctx, domain.PreferencesPatch{BuiltinTimeToolEnabled: &enableTime}, false, validatePrefs)
	if err != nil {
		t.Fatalf("enable builtinTimeToolEnabled: %v", err)
	}
	if !timeUpdated.BuiltinTimeToolEnabled {
		t.Fatal("expected builtinTimeToolEnabled persisted true")
	}

	if !stored.MathRenderEnabled {
		t.Fatal("expected mathRenderEnabled default true")
	}
	disableMath := false
	mathUpdated, _, err := prefs.Update(ctx, domain.PreferencesPatch{MathRenderEnabled: &disableMath}, false, validatePrefs)
	if err != nil {
		t.Fatalf("disable mathRenderEnabled: %v", err)
	}
	if mathUpdated.MathRenderEnabled {
		t.Fatal("expected mathRenderEnabled persisted false")
	}
	// Unrelated partial update must not overwrite explicit false with default true.
	nextSize := 16
	afterOther, _, err := prefs.Update(ctx, domain.PreferencesPatch{FontSize: &nextSize}, false, validatePrefs)
	if err != nil || afterOther.MathRenderEnabled {
		t.Fatalf("expected mathRenderEnabled to stay false after unrelated patch, got %+v err=%v", afterOther, err)
	}
	// Reopening database preserves explicit false.
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	db, err = OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen sqlite for mathRenderEnabled: %v", err)
	}
	prefs = NewPreferenceStore(db)
	reloaded, _, err := prefs.Get(ctx)
	if err != nil || reloaded.MathRenderEnabled {
		t.Fatalf("expected mathRenderEnabled false after reopen, got %+v err=%v", reloaded, err)
	}
}

func TestMigration005BackfillsManagedAPIKeys(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "legacy.db")

	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	// Replaying the full migration set on a fresh database must keep legacy
	// non-empty keys managed and legacy empty keys unmanaged.
	providers := NewProviderStore(db)
	if _, err := providers.Create(ctx, domain.ProviderConfig{
		ID: "with-key", Name: "With Key", Adapter: "generic-http",
		BaseURL: "https://example.com", AuthType: domain.AuthTypeBearer, APIKey: "sk-legacy",
	}); err != nil {
		t.Fatalf("create provider with key: %v", err)
	}
	if _, err := providers.Create(ctx, domain.ProviderConfig{
		ID: "without-key", Name: "Without Key", Adapter: "generic-http",
		BaseURL: "https://example.com", AuthType: domain.AuthTypeBearer,
	}); err != nil {
		t.Fatalf("create provider without key: %v", err)
	}

	// Simulate an upgrade path: drop the migration record plus column, then re-apply.
	if _, err := db.ExecContext(ctx, "DELETE FROM schema_migrations WHERE version = '005_user_preferences.sql'"); err != nil {
		t.Fatalf("reset migration record: %v", err)
	}
	if _, err := db.ExecContext(ctx, "ALTER TABLE providers DROP COLUMN api_key_managed"); err != nil {
		t.Fatalf("drop column: %v", err)
	}
	if err := RunMigrations(ctx, db); err != nil {
		t.Fatalf("re-run migrations: %v", err)
	}

	assertManaged := func(id string, want bool) {
		t.Helper()
		var managed int
		if err := db.QueryRowContext(ctx, "SELECT api_key_managed FROM providers WHERE id = ?", id).Scan(&managed); err != nil {
			t.Fatalf("read api_key_managed for %s: %v", id, err)
		}
		if (managed != 0) != want {
			t.Fatalf("provider %s api_key_managed=%d, want %v", id, managed, want)
		}
	}
	assertManaged("with-key", true)
	assertManaged("without-key", false)
}

func validatePrefs(p domain.Preferences) error {
	return p.Validate()
}

func patchFromPreferences(p domain.Preferences) domain.PreferencesPatch {
	return domain.PreferencesPatch{
		ThemeMode:             &p.ThemeMode,
		SeedColorValue:        &p.SeedColorValue,
		EnterToSend:           &p.EnterToSend,
		VisualHTMLRender:      &p.VisualHTMLRender,
		DefaultHTMLPreview:    &p.DefaultHTMLPreview,
		ChatDisplayMode:       &p.ChatDisplayMode,
		AutoCollapseEnabled:   &p.AutoCollapseEnabled,
		AutoCreateCache:       &p.AutoCreateCache,
		CollapseLineThreshold: &p.CollapseLineThreshold,
		CollapseCharThreshold: &p.CollapseCharThreshold,
		UserAvatarDataURL:     &p.UserAvatarDataURL,
	}
}
