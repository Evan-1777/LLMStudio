package store

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/domain"
)

func avatarDataURL(t *testing.T, size int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	img.Set(0, 0, color.RGBA{R: 250, G: 180, B: 40, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func openTestStore(t *testing.T) *struct {
	prefs      *PreferenceStore
	assistants *AssistantStore
} {
	t.Helper()
	ctx := context.Background()
	db, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "avatars.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &struct {
		prefs      *PreferenceStore
		assistants *AssistantStore
	}{prefs: NewPreferenceStore(db), assistants: NewAssistantStore(db)}
}

func TestAssistantAvatarRoundTrip(t *testing.T) {
	ctx := context.Background()
	st := openTestStore(t)

	avatar := avatarDataURL(t, 48)
	first, err := st.assistants.Create(ctx, domain.Assistant{ID: "a1", Name: "Alpha", AvatarDataURL: avatar})
	if err != nil {
		t.Fatalf("create assistant: %v", err)
	}
	if first.AvatarDataURL != avatar {
		t.Fatalf("avatar not stored on create: %q", first.AvatarDataURL)
	}

	second, err := st.assistants.Create(ctx, domain.Assistant{ID: "a2", Name: "Beta"})
	if err != nil {
		t.Fatalf("create second assistant: %v", err)
	}
	if second.AvatarDataURL != "" {
		t.Fatalf("new assistant should start without an avatar: %q", second.AvatarDataURL)
	}

	// Renaming one assistant keeps its avatar; siblings are untouched.
	loaded, err := st.assistants.Get(ctx, "a1")
	if err != nil {
		t.Fatalf("get assistant: %v", err)
	}
	loaded.Name = "Alpha Renamed"
	updated, err := st.assistants.Update(ctx, loaded)
	if err != nil {
		t.Fatalf("update assistant: %v", err)
	}
	if updated.Name != "Alpha Renamed" || updated.AvatarDataURL != avatar {
		t.Fatalf("avatar lost on update: %+v", updated)
	}
	sibling, err := st.assistants.Get(ctx, "a2")
	if err != nil {
		t.Fatalf("get sibling: %v", err)
	}
	if sibling.AvatarDataURL != "" {
		t.Fatalf("sibling avatar changed: %q", sibling.AvatarDataURL)
	}

	// An empty string clears the stored avatar.
	loaded.AvatarDataURL = ""
	cleared, err := st.assistants.Update(ctx, loaded)
	if err != nil {
		t.Fatalf("clear avatar: %v", err)
	}
	if cleared.AvatarDataURL != "" {
		t.Fatalf("avatar not cleared: %q", cleared.AvatarDataURL)
	}
}

func TestPreferenceAvatarAndDisjointPatches(t *testing.T) {
	ctx := context.Background()
	st := openTestStore(t)

	avatar := avatarDataURL(t, 64)
	if _, _, err := st.prefs.Update(ctx, domain.PreferencesPatch{UserAvatarDataURL: &avatar}, false, validatePrefs); err != nil {
		t.Fatalf("store user avatar: %v", err)
	}

	// A later patch for a disjoint field must not disturb the avatar.
	theme := domain.ThemeModeDark
	if _, _, err := st.prefs.Update(ctx, domain.PreferencesPatch{ThemeMode: &theme}, false, validatePrefs); err != nil {
		t.Fatalf("patch theme: %v", err)
	}
	prefs, _, err := st.prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get preferences: %v", err)
	}
	if prefs.UserAvatarDataURL != avatar || prefs.ThemeMode != domain.ThemeModeDark {
		t.Fatalf("disjoint patch lost a field: %+v", prefs)
	}

	// A replayed legacy import cannot resurrect or erase the stored avatar.
	legacy := domain.DefaultPreferences()
	legacy.ThemeMode = domain.ThemeModeLight
	if _, _, err := st.prefs.Update(ctx, patchFromPreferences(legacy), true, validatePrefs); err != nil {
		t.Fatalf("legacy import: %v", err)
	}
	prefs, _, err = st.prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get after legacy import: %v", err)
	}
	if prefs.UserAvatarDataURL != avatar || prefs.ThemeMode != domain.ThemeModeDark {
		t.Fatalf("legacy import changed committed values: %+v", prefs)
	}

	// Invalid avatar input is rejected before the row is written.
	invalid := "data:image/png;base64,bm90LWEtcG5n"
	if _, _, err := st.prefs.Update(ctx, domain.PreferencesPatch{UserAvatarDataURL: &invalid}, false, validatePrefs); err == nil {
		t.Fatal("expected invalid avatar to be rejected")
	}
	prefs, _, err = st.prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get after rejected write: %v", err)
	}
	if prefs.UserAvatarDataURL != avatar {
		t.Fatalf("rejected write altered the stored avatar: %q", prefs.UserAvatarDataURL)
	}

	empty := ""
	if _, _, err := st.prefs.Update(ctx, domain.PreferencesPatch{UserAvatarDataURL: &empty}, false, validatePrefs); err != nil {
		t.Fatalf("clear user avatar: %v", err)
	}
	prefs, _, err = st.prefs.Get(ctx)
	if err != nil {
		t.Fatalf("get after clear: %v", err)
	}
	if prefs.UserAvatarDataURL != "" {
		t.Fatalf("avatar not cleared: %q", prefs.UserAvatarDataURL)
	}
}
