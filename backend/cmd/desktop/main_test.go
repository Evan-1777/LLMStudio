package main

import (
	"context"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/desktop"
)

func TestShouldHideOnClose(t *testing.T) {
	cases := []struct {
		name          string
		closeToTray   bool
		trayAvailable bool
		quitting      bool
		want          bool
	}{
		{name: "default exit", closeToTray: false, trayAvailable: true, want: false},
		{name: "tray unavailable", closeToTray: true, trayAvailable: false, want: false},
		{name: "explicit quit", closeToTray: true, trayAvailable: true, quitting: true, want: false},
		{name: "hide to tray", closeToTray: true, trayAvailable: true, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldHideOnClose(tc.closeToTray, tc.trayAvailable, tc.quitting); got != tc.want {
				t.Fatalf("shouldHideOnClose(%v, %v, %v) = %v, want %v", tc.closeToTray, tc.trayAvailable, tc.quitting, got, tc.want)
			}
		})
	}
}

func TestSetCloseToTrayWriteFailureKeepsPublishedValue(t *testing.T) {
	ctx := context.Background()
	store, err := desktop.OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "desktop.db"))
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}

	bridge := &DesktopBridge{}
	bridge.attachStore(store, true)
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	settings, err := bridge.SetCloseToTray(ctx, false)
	if err == nil {
		t.Fatal("SetCloseToTray on a closed store should fail")
	}
	if !bridge.closeToTray.Load() {
		t.Fatal("failed write must not publish a new close behavior")
	}
	if !settings.CloseToTray {
		t.Fatal("failed write should report the last confirmed value")
	}
}
