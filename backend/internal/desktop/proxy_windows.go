//go:build windows

package desktop

import (
	"net/http"
	"net/url"
	"sync"
	"time"

	"golang.org/x/sys/windows/registry"
)

const (
	windowsInternetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`
	windowsProxyCacheTTL       = 10 * time.Second
)

var windowsProxyState = struct {
	mu        sync.Mutex
	fetchedAt time.Time
	cfg       windowsProxyConfig
}{}

func platformSystemProxy(req *http.Request) (*url.URL, error) {
	cfg := loadCachedWindowsProxyConfig()
	return cfg.resolve(req)
}

func loadCachedWindowsProxyConfig() windowsProxyConfig {
	windowsProxyState.mu.Lock()
	defer windowsProxyState.mu.Unlock()
	if !windowsProxyState.fetchedAt.IsZero() && time.Since(windowsProxyState.fetchedAt) < windowsProxyCacheTTL {
		return windowsProxyState.cfg
	}
	cfg := readWindowsProxyRegistry()
	windowsProxyState.cfg = cfg
	windowsProxyState.fetchedAt = time.Now()
	return cfg
}

func readWindowsProxyRegistry() windowsProxyConfig {
	key, err := registry.OpenKey(registry.CURRENT_USER, windowsInternetSettingsKey, registry.QUERY_VALUE)
	if err != nil {
		return windowsProxyConfig{}
	}
	defer key.Close()

	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err != nil || enabled == 0 {
		return windowsProxyConfig{}
	}
	server, _, _ := key.GetStringValue("ProxyServer")
	override, _, _ := key.GetStringValue("ProxyOverride")
	return parseWindowsProxyConfig(server, override)
}
