package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveStoragePathsAndPortableEnv(t *testing.T) {
	base := t.TempDir()
	exeDir := filepath.Join(base, "app")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatalf("mkdir exeDir: %v", err)
	}
	exePath := filepath.Join(exeDir, "LLMStudio.exe")
	defaultUserDir := filepath.Join(base, "appdata", "LLMStudio")

	// Installed mode without marker.
	installed := ResolveStoragePaths(exePath, defaultUserDir)
	if installed.Mode != DataModeInstalled {
		t.Fatalf("expected installed mode, got %q", installed.Mode)
	}
	if installed.DataDir != defaultUserDir || installed.DBPath != filepath.Join(defaultUserDir, localDBFileName) {
		t.Fatalf("unexpected installed paths: %+v", installed)
	}
	if installed.WebViewDataDir != "" || installed.MyGoUserDataDir != "" {
		t.Fatalf("expected installed mode to defer webview/mygo dirs to OS defaults: %+v", installed)
	}
	if err := ApplyPortableRuntimeEnv(installed); err != nil {
		t.Fatalf("ApplyPortableRuntimeEnv installed: %v", err)
	}
	if info, err := os.Stat(installed.DataDir); err != nil || !info.IsDir() {
		t.Fatalf("expected installed data dir to be created: %v", err)
	}

	// Portable mode with .portable marker isolates data, WebView2, and MyGo directories under <exeDir>/data.
	marker := filepath.Join(exeDir, ".portable")
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatalf("write .portable: %v", err)
	}
	portable := ResolveStoragePaths(exePath, defaultUserDir)
	wantData := filepath.Join(exeDir, "data")
	if portable.Mode != DataModePortable || portable.DataDir != wantData {
		t.Fatalf("unexpected portable paths: %+v", portable)
	}
	if portable.WebViewDataDir != filepath.Join(wantData, "webview2") ||
		portable.MyGoUserDataDir != filepath.Join(wantData, "mygo", "user-data") ||
		portable.MyGoCacheDir != filepath.Join(wantData, "mygo", "cache") ||
		portable.MyGoLogsDir != filepath.Join(wantData, "mygo", "logs") {
		t.Fatalf("incomplete portable isolation dirs: %+v", portable)
	}

	t.Setenv("WEBVIEW2_USER_DATA_FOLDER", "")
	if err := ApplyPortableRuntimeEnv(portable); err != nil {
		t.Fatalf("ApplyPortableRuntimeEnv portable: %v", err)
	}
	if got := os.Getenv("WEBVIEW2_USER_DATA_FOLDER"); got != portable.WebViewDataDir {
		t.Fatalf("expected WEBVIEW2_USER_DATA_FOLDER=%q, got %q", portable.WebViewDataDir, got)
	}
	for _, dir := range []string{portable.DataDir, portable.WebViewDataDir, portable.MyGoUserDataDir, portable.MyGoCacheDir, portable.MyGoLogsDir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Fatalf("expected portable dir %q to exist: %v", dir, err)
		}
	}
}
