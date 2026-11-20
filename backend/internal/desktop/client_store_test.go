package desktop

import (
	"context"
	"path/filepath"
	"testing"
)

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
