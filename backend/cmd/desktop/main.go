package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"llmstudio/backend/internal/desktop"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/mcp"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
)

const appVersion = "1.5.0"

// DesktopRuntimeInfo exposes runtime paths and version to the frontend via MyGo IPC.
type DesktopRuntimeInfo struct {
	Platform string `json:"platform"`
	DataMode string `json:"dataMode"`
	DataDir  string `json:"dataDir"`
	DBPath   string `json:"dbPath"`
	Version  string `json:"version"`
}

// DesktopBridge exposes minimal native desktop actions to the React webview.
type DesktopBridge struct {
	paths desktop.StoragePaths
}

// OpenDataDir opens the active local data directory in the OS file explorer.
func (b *DesktopBridge) OpenDataDir() error {
	return mygo.Shell.OpenPath(b.paths.DataDir)
}

// GetRuntimeInfo returns runtime mode and local storage metadata.
func (b *DesktopBridge) GetRuntimeInfo() DesktopRuntimeInfo {
	return DesktopRuntimeInfo{
		Platform: runtime.GOOS,
		DataMode: string(b.paths.Mode),
		DataDir:  b.paths.DataDir,
		DBPath:   b.paths.DBPath,
		Version:  appVersion,
	}
}

type desktopRuntime struct {
	Store     *desktop.DesktopStore
	MCPRun    *mcp.Runtime
	CredCache *desktop.MemoryCredentialCache
	Server    *desktop.Server
}

func (r *desktopRuntime) Close() {
	if r == nil {
		return
	}
	if r.Server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = r.Server.Shutdown(ctx)
		cancel()
	}
	if r.CredCache != nil {
		r.CredCache.ClearAll()
	}
	if r.MCPRun != nil {
		_ = r.MCPRun.Close()
	}
	if r.Store != nil {
		_ = r.Store.Close()
	}
}

func defaultInstalledUserDataDir() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "LLMStudio")
	}
	return filepath.Join(".", "data")
}

func startDesktopRuntime(paths desktop.StoragePaths) (*desktopRuntime, error) {
	ctx := context.Background()
	store, err := desktop.OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		return nil, err
	}

	conn, err := store.GetConnection(ctx)
	if err != nil {
		_ = store.Close()
		return nil, err
	}

	cloud := desktop.NewCloudClient(conn.GatewayBaseURL, conn.AccessToken)
	credCache := desktop.NewMemoryCredentialCache(cloud)
	store.SetMemoryCacheInvalidator(credCache.ClearAll)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	formats.MustRegister(format.NewOpenAIResponsesFormat())
	formats.MustRegister(format.NewAnthropicMessagesFormat())
	formats.MustRegister(format.NewGoogleGenAIFormat())

	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	searchEngines := plugin.NewSearchRegistry()
	searchEngines.MustRegister(search.NewTavilyEngine(nil))
	searchEngines.MustRegister(search.NewSearXNGEngine(nil))

	mcpRuntime := mcp.NewRuntime()
	compositeTools := desktop.NewCompositeToolRuntime(store.MCPs, mcpRuntime, cloud)
	httpClient := &http.Client{}
	chatEngine := desktop.NewDesktopChatEngine(store, cloud, credCache, formats, adapters, searchEngines, compositeTools, httpClient)
	syncSvc := desktop.NewSyncService(store, cloud)

	srv, err := desktop.NewServer(desktop.ServerConfig{
		Paths:          paths,
		Store:          store,
		Cloud:          cloud,
		CredCache:      credCache,
		Formats:        formats,
		Adapters:       adapters,
		SearchReg:      searchEngines,
		LocalMCPClient: mcpRuntime,
		CompositeTools: compositeTools,
		ChatEngine:     chatEngine,
		SyncService:    syncSvc,
		DevMode:        mygo.IsDev(),
		Version:        appVersion,
	})
	if err != nil {
		_ = mcpRuntime.Close()
		_ = store.Close()
		return nil, err
	}
	if err := srv.ListenAndServe(); err != nil {
		_ = mcpRuntime.Close()
		_ = store.Close()
		return nil, err
	}

	return &desktopRuntime{
		Store:     store,
		MCPRun:    mcpRuntime,
		CredCache: credCache,
		Server:    srv,
	}, nil
}

func buildDesktopPreloadScript(apiBaseURL, sessionToken string, mode desktop.DataMode, version string) string {
	payload := struct {
		APIBaseURL   string `json:"apiBaseUrl"`
		SessionToken string `json:"sessionToken"`
		Platform     string `json:"platform"`
		DataMode     string `json:"dataMode"`
		Version      string `json:"version"`
	}{
		APIBaseURL:   apiBaseURL,
		SessionToken: sessionToken,
		Platform:     runtime.GOOS,
		DataMode:     string(mode),
		Version:      version,
	}
	raw, _ := json.Marshal(payload)
	return "window.__LLMSTUDIO_DESKTOP__ = Object.freeze(" + string(raw) + ");"
}

func main() {
	mygo.App.SetName("LLMStudio")
	mygo.App.SetVersion(appVersion)

	exePath, _ := os.Executable()
	paths := desktop.ResolveStoragePaths(exePath, defaultInstalledUserDataDir())
	if err := desktop.ApplyPortableRuntimeEnv(paths); err != nil {
		log.Fatalf("desktop storage init failed: %v", err)
	}
	if paths.Mode == desktop.DataModePortable {
		mygo.App.SetPath(mygo.PathUserData, paths.MyGoUserDataDir)
		mygo.App.SetPath(mygo.PathCache, paths.MyGoCacheDir)
		mygo.App.SetPath(mygo.PathLogs, paths.MyGoLogsDir)
	}

	if !mygo.App.RequestSingleInstanceLock() {
		return
	}

	var (
		mu      sync.Mutex
		mainWin *mygo.Window
		rt      *desktopRuntime
		once    sync.Once
	)

	mygo.App.OnSecondInstance(func(_ []string, _ string) {
		mu.Lock()
		w := mainWin
		mu.Unlock()
		if w != nil {
			w.Show()
			w.Focus()
		}
	})

	mygo.Bind(&DesktopBridge{paths: paths})

	mygo.App.WhenReady(func() {
		started, err := startDesktopRuntime(paths)
		if err != nil {
			log.Fatalf("desktop runtime start failed: %v", err)
		}
		mu.Lock()
		rt = started
		mu.Unlock()

		preload := buildDesktopPreloadScript(started.Server.BaseURL(), started.Server.Token(), paths.Mode, appVersion)
		w := mygo.NewWindow(mygo.WindowOptions{
			Title:           "LLMStudio",
			URL:             "/",
			Width:           1280,
			Height:          820,
			MinWidth:        820,
			MinHeight:       600,
			TitleBarStyle:   mygo.TitleBarHidden,
			TitleBarHeight:  40,
			BackgroundColor: "light-dark(#f5f5f7, #111113)",
			Page: mygo.PageOptions{
				PreloadScript: preload,
			},
		})
		mu.Lock()
		mainWin = w
		mu.Unlock()
	})

	shutdown := func() {
		once.Do(func() {
			mu.Lock()
			active := rt
			rt = nil
			mu.Unlock()
			active.Close()
		})
	}
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
		shutdown()
	})
	mygo.App.OnQuit(func() {
		shutdown()
	})

	if err := mygo.App.Run(); err != nil {
		shutdown()
		log.Fatal(err)
	}
}
