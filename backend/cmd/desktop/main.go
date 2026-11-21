package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
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

// DesktopClientSettings is the native client behavior shown in client settings.
type DesktopClientSettings struct {
	CloseToTray   bool `json:"closeToTray"`
	TrayAvailable bool `json:"trayAvailable"`
}

// DesktopBridge exposes minimal native desktop actions to the React webview.
type DesktopBridge struct {
	paths desktop.StoragePaths

	storeMu sync.RWMutex
	store   *desktop.DesktopStore
	tray    atomic.Pointer[mygo.Tray]

	closeToTray atomic.Bool
}

// OpenDataDir opens the active local data directory in the OS file explorer.
func (b *DesktopBridge) OpenDataDir() error {
	return mygo.Shell.OpenPath(b.paths.DataDir)
}

// GetClientSettings returns the confirmed tray behavior and current availability.
func (b *DesktopBridge) GetClientSettings() (DesktopClientSettings, error) {
	if b.getStore() == nil {
		return DesktopClientSettings{}, errors.New("桌面客户端设置尚未就绪")
	}
	return b.currentSettings(), nil
}

// SetCloseToTray persists the close button behavior before publishing it to the
// native close callback. Rejected writes leave the running behavior unchanged.
func (b *DesktopBridge) SetCloseToTray(ctx context.Context, value bool) (DesktopClientSettings, error) {
	store := b.getStore()
	if store == nil {
		return DesktopClientSettings{}, errors.New("桌面客户端设置尚未就绪")
	}
	if value && !b.trayUsable() {
		return b.currentSettings(), errors.New("系统托盘不可用，无法启用最小化到托盘")
	}
	if err := store.SetCloseToTray(ctx, value); err != nil {
		return b.currentSettings(), fmt.Errorf("保存关闭设置失败: %w", err)
	}
	b.closeToTray.Store(value)
	return b.currentSettings(), nil
}

func (b *DesktopBridge) attachStore(store *desktop.DesktopStore, closeToTray bool) {
	b.storeMu.Lock()
	b.store = store
	b.storeMu.Unlock()
	b.closeToTray.Store(closeToTray)
}

func (b *DesktopBridge) getStore() *desktop.DesktopStore {
	b.storeMu.RLock()
	defer b.storeMu.RUnlock()
	return b.store
}

func (b *DesktopBridge) currentSettings() DesktopClientSettings {
	return DesktopClientSettings{
		CloseToTray:   b.closeToTray.Load(),
		TrayAvailable: b.trayUsable(),
	}
}

// trayUsable confirms the notification area actually holds the icon. Windows
// reports no error from Shell_NotifyIconW, so an empty bounds means hiding the
// window could strand it.
func (b *DesktopBridge) trayUsable() bool {
	tray := b.tray.Load()
	return tray != nil && tray.Bounds() != (mygo.Rectangle{})
}

// shouldHideOnClose decides whether a close request becomes a tray hide.
func shouldHideOnClose(closeToTray, trayAvailable, quitting bool) bool {
	return closeToTray && trayAvailable && !quitting
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

	store.SetCredentialProtector(desktop.PlatformCredentialProtector())
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

	desktopTransport := desktop.NewDesktopHTTPTransport()

	searchEngines := plugin.NewSearchRegistry()
	searchEngines.MustRegister(search.NewTavilyEngine(&http.Client{Transport: desktopTransport}))
	searchEngines.MustRegister(search.NewSearXNGEngine(&http.Client{Transport: desktopTransport}))

	mcpRuntime := mcp.NewRuntime(mcp.WithHTTPClient(&http.Client{
		Timeout:   5 * time.Minute,
		Transport: desktopTransport,
	}))
	compositeTools := desktop.NewCompositeToolRuntime(store.MCPs, mcpRuntime, cloud)
	httpClient := &http.Client{Transport: desktopTransport}
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
		mu       sync.Mutex
		mainWin  *mygo.Window
		rt       *desktopRuntime
		once     sync.Once
		tray     atomic.Pointer[mygo.Tray]
		quitting atomic.Bool
	)

	bridge := &DesktopBridge{paths: paths}

	restoreMainWindow := func() {
		mu.Lock()
		w := mainWin
		mu.Unlock()
		if w == nil {
			return
		}
		if w.IsMinimized() {
			w.Restore()
		}
		w.Show()
		w.Focus()
	}

	mygo.App.OnSecondInstance(func(_ []string, _ string) {
		restoreMainWindow()
	})
	mygo.App.OnBeforeQuit(func(_ *mygo.QuitEvent) {
		quitting.Store(true)
	})

	mygo.Bind(bridge)

	mygo.App.WhenReady(func() {
		started, err := startDesktopRuntime(paths)
		if err != nil {
			log.Fatalf("desktop runtime start failed: %v", err)
		}
		mu.Lock()
		rt = started
		mu.Unlock()

		closeToTray, err := started.Store.GetCloseToTray(context.Background())
		if err != nil {
			log.Printf("desktop close setting read failed: %v", err)
		}
		bridge.attachStore(started.Store, closeToTray)

		preload := buildDesktopPreloadScript(started.Server.BaseURL(), started.Server.Token(), paths.Mode, appVersion)
		w := mygo.NewWindow(mygo.WindowOptions{
			Title:           "LLMStudio",
			URL:             "/",
			Width:           1280,
			Height:          820,
			MinWidth:        820,
			MinHeight:       600,
			TitleBarStyle:   mygo.TitleBarHidden,
			TitleBarHeight:  32,
			BackgroundColor: "light-dark(#f5f5f7, #111113)",
			Page: mygo.PageOptions{
				PreloadScript: preload,
			},
		})
		w.OnClose(func(e *mygo.CloseEvent) {
			if shouldHideOnClose(bridge.closeToTray.Load(), bridge.trayUsable(), quitting.Load()) {
				e.PreventDefault()
				w.Hide()
			}
		})

		mu.Lock()
		mainWin = w
		mu.Unlock()

		icon, err := mygo.Shell.FileIcon(exePath, 32)
		if err != nil {
			log.Printf("desktop tray icon unavailable: %v", err)
			return
		}
		createdTray, err := mygo.NewTray(mygo.TrayOptions{
			ID:      "llmstudio",
			Icon:    icon,
			ToolTip: "LLMStudio",
			Menu: mygo.NewMenu([]*mygo.MenuItem{
				{Label: "打开", Click: func(*mygo.MenuItem, *mygo.Window) { restoreMainWindow() }},
				mygo.Separator(),
				{Label: "结束", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
			}),
		})
		if err != nil {
			log.Printf("desktop tray unavailable: %v", err)
			return
		}
		createdTray.OnClick(restoreMainWindow)
		tray.Store(createdTray)
		bridge.tray.Store(createdTray)
	})

	shutdown := func() {
		once.Do(func() {
			if t := tray.Swap(nil); t != nil {
				t.Destroy()
			}
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
