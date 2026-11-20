package desktop

import (
	"os"
	"path/filepath"
	"strings"
)

// DataMode identifies whether the desktop client runs in portable or installed mode.
type DataMode string

const (
	DataModePortable  DataMode = "portable"
	DataModeInstalled DataMode = "installed"
)

const localDBFileName = "llmstudio-local.db"

// StoragePaths describes all isolated runtime directories for the desktop client.
type StoragePaths struct {
	Mode            DataMode `json:"mode"`
	DataDir         string   `json:"dataDir"`
	DBPath          string   `json:"dbPath"`
	WebViewDataDir  string   `json:"webViewDataDir,omitempty"`
	MyGoUserDataDir string   `json:"myGoUserDataDir,omitempty"`
	MyGoCacheDir    string   `json:"myGoCacheDir,omitempty"`
	MyGoLogsDir     string   `json:"myGoLogsDir,omitempty"`
}

// ResolveStoragePaths resolves portable vs installed directories from the executable
// directory marker (.portable or portable.flag) and default user data directory.
func ResolveStoragePaths(exePath string, defaultUserDataDir string) StoragePaths {
	exe := strings.TrimSpace(exePath)
	if exe == "" {
		if resolved, err := os.Executable(); err == nil {
			exe = resolved
		}
	}
	if exe != "" {
		if realExe, err := filepath.EvalSymlinks(exe); err == nil {
			exe = realExe
		}
		exeDir := filepath.Dir(exe)
		if hasPortableMarker(exeDir) {
			dataDir := filepath.Join(exeDir, "data")
			return StoragePaths{
				Mode:            DataModePortable,
				DataDir:         dataDir,
				DBPath:          filepath.Join(dataDir, localDBFileName),
				WebViewDataDir:  filepath.Join(dataDir, "webview2"),
				MyGoUserDataDir: filepath.Join(dataDir, "mygo", "user-data"),
				MyGoCacheDir:    filepath.Join(dataDir, "mygo", "cache"),
				MyGoLogsDir:     filepath.Join(dataDir, "mygo", "logs"),
			}
		}
	}

	dataDir := strings.TrimSpace(defaultUserDataDir)
	if dataDir == "" {
		if cfgDir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(cfgDir) != "" {
			dataDir = filepath.Join(cfgDir, "LLMStudio")
		} else {
			dataDir = filepath.Join(".", "data")
		}
	} else {
		dataDir = filepath.Clean(dataDir)
	}
	return StoragePaths{
		Mode:    DataModeInstalled,
		DataDir: dataDir,
		DBPath:  filepath.Join(dataDir, localDBFileName),
	}
}

func hasPortableMarker(exeDir string) bool {
	for _, name := range []string{".portable", "portable.flag"} {
		if info, err := os.Stat(filepath.Join(exeDir, name)); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}

// EnsureStorageDirs creates all required directories for paths.
func EnsureStorageDirs(paths StoragePaths) error {
	for _, dir := range []string{
		paths.DataDir,
		paths.WebViewDataDir,
		paths.MyGoUserDataDir,
		paths.MyGoCacheDir,
		paths.MyGoLogsDir,
	} {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// ApplyPortableRuntimeEnv creates runtime directories and configures WEBVIEW2_USER_DATA_FOLDER
// in portable mode unless already overridden externally.
func ApplyPortableRuntimeEnv(paths StoragePaths) error {
	if err := EnsureStorageDirs(paths); err != nil {
		return err
	}
	if paths.Mode == DataModePortable && paths.WebViewDataDir != "" && strings.TrimSpace(os.Getenv("WEBVIEW2_USER_DATA_FOLDER")) == "" {
		return os.Setenv("WEBVIEW2_USER_DATA_FOLDER", paths.WebViewDataDir)
	}
	return nil
}
