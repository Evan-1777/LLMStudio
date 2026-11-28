package desktop

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testProtector struct{ cipher.AEAD }

func newTestProtector(t *testing.T, seed byte) testProtector {
	t.Helper()
	block, err := aes.NewCipher(bytes.Repeat([]byte{seed}, 32))
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCMWithRandomNonce(block)
	if err != nil {
		t.Fatal(err)
	}
	return testProtector{aead}
}
func (p testProtector) Protect(b []byte) ([]byte, error)   { return p.Seal(nil, nil, b, nil), nil }
func (p testProtector) Unprotect(b []byte) ([]byte, error) { return p.Open(nil, nil, b, nil) }

func TestDesktopProviderKeyStorage(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "credentials.db")
	open := func() *DesktopStore {
		s, err := OpenDesktopStore(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Close() })
		return s
	}
	s := open()
	conn, err := s.SaveConnection(ctx, "https://example.test", "token-a")
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := s.SaveConnection(ctx, " https://example.test/ ", " token-a ")
	if err != nil || !repeat.UpdatedAt.Equal(conn.UpdatedAt) {
		t.Fatal("same normalized connection advanced generation")
	}
	const key = "fake-model-key-not-on-disk"
	version := time.Now().UTC()
	s.saveProviderKey(ctx, "model", version, key)
	var rows int
	if err := s.DB.QueryRow(`SELECT count(*) FROM desktop_provider_credentials`).Scan(&rows); err != nil || rows != 0 {
		t.Fatal("stored key without a protector")
	}
	s.SetCredentialProtector(newTestProtector(t, 1))
	s.saveProviderKey(ctx, "model", version, key)
	for _, file := range []string{path, path + "-wal"} {
		data, err := os.ReadFile(file)
		if os.IsNotExist(err) && file != path {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(key)) {
			t.Fatal("found plaintext in SQLite")
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = open()
	s.SetCredentialProtector(newTestProtector(t, 2))
	if s.loadProviderKey(ctx, "model", version) != "" {
		t.Fatal("wrong protector decrypted key")
	}
	s.SetCredentialProtector(newTestProtector(t, 1))
	if s.loadProviderKey(ctx, "model", version) != key || s.loadProviderKey(ctx, "model", version.Add(time.Second)) != "" {
		t.Fatal("reopen or version check failed")
	}
	if _, err := s.SaveConnection(ctx, "https://example.test", "token-b"); err != nil {
		t.Fatal(err)
	}
	if s.loadProviderKey(ctx, "model", version) != "" {
		t.Fatal("previous connection key survived")
	}
	s.saveProviderKey(ctx, "model", version, key)
	if err := s.ClearLocalCache(ctx); err != nil {
		t.Fatal(err)
	}
	if s.loadProviderKey(ctx, "model", version) != "" {
		t.Fatal("cache clear retained key")
	}
}

func TestDesktopCachedPreferencesNormalizeNewTopicDefaults(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old-prefs.db")
	s, err := OpenDesktopStore(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	legacy := `{"themeMode":"dark","seedColorValue":4281553408,"enterToSend":false}`
	if _, err := s.DB.Exec(
		`INSERT INTO desktop_cache(key, value_json, updated_at) VALUES(?,?,?)`,
		cacheKeyPreferences, legacy, time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		t.Fatal(err)
	}
	prefs, ok, err := s.LoadCachedPreferences(ctx)
	if err != nil || !ok {
		t.Fatalf("load legacy cached preferences: ok=%v err=%v", ok, err)
	}
	if prefs.ThemeMode != "dark" || prefs.EnterToSend {
		t.Fatalf("legacy fields not preserved: %+v", prefs)
	}
	if prefs.DefaultTopicMode != "chat" || prefs.LastProviderID != "" || prefs.LastModelID != "" {
		t.Fatalf("new fields did not fall back to defaults: %+v", prefs)
	}
}

func TestDesktopUpgradeRetiresUnboundProviderMetadata(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := OpenDesktopStore(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveCachedProviders(ctx, []CachedProvider{{ID: "unbound-legacy-provider"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`DROP TABLE desktop_provider_credentials`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenDesktopStore(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if providers, err := s.LoadCachedProviders(ctx); err != nil || len(providers) != 0 {
		t.Fatalf("legacy provider snapshot survived upgrade: %v", err)
	}
}

func TestCloseToTrayPersistsAcrossReopenAndIgnoresCloudState(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "desktop-settings.db")

	open := func() *DesktopStore {
		t.Helper()
		store, err := OpenDesktopStore(ctx, dbPath)
		if err != nil {
			t.Fatalf("OpenDesktopStore: %v", err)
		}
		t.Cleanup(func() { _ = store.Close() })
		return store
	}

	store := open()
	value, err := store.GetCloseToTray(ctx)
	if err != nil {
		t.Fatalf("GetCloseToTray empty: %v", err)
	}
	if value {
		t.Fatal("close to tray should default to false")
	}

	if err := store.SetCloseToTray(ctx, true); err != nil {
		t.Fatalf("SetCloseToTray true: %v", err)
	}
	if err := store.ClearLocalCache(ctx); err != nil {
		t.Fatalf("ClearLocalCache: %v", err)
	}
	if err := store.DisconnectCloud(ctx); err != nil {
		t.Fatalf("DisconnectCloud: %v", err)
	}
	value, err = store.GetCloseToTray(ctx)
	if err != nil || !value {
		t.Fatalf("close to tray after cache clear/disconnect = %v, %v; want true", value, err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	reopened := open()
	value, err = reopened.GetCloseToTray(ctx)
	if err != nil || !value {
		t.Fatalf("close to tray after reopen = %v, %v; want true", value, err)
	}
	if err := reopened.SetCloseToTray(ctx, false); err != nil {
		t.Fatalf("SetCloseToTray false: %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatalf("close reopened store: %v", err)
	}

	third := open()
	value, err = third.GetCloseToTray(ctx)
	if err != nil {
		t.Fatalf("GetCloseToTray after second reopen: %v", err)
	}
	if value {
		t.Fatal("close to tray should be false after explicit reset")
	}
}
