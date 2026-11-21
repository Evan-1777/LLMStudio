package desktop

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NewDesktopHTTPTransport constructs a shared HTTP transport tuned for the desktop
// runtime: larger per-host idle pool, HTTP/2 attempt enabled, and environment/system
// manual proxy resolution with automatic loopback bypass.
func NewDesktopHTTPTransport() *http.Transport {
	var tr *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok && base != nil {
		tr = base.Clone()
	} else {
		tr = &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}
	}
	tr.Proxy = desktopProxyFunc
	tr.MaxIdleConns = 64
	tr.MaxIdleConnsPerHost = 16
	tr.IdleConnTimeout = 90 * time.Second
	tr.ForceAttemptHTTP2 = true
	return tr
}

var envProxyFunc = http.ProxyFromEnvironment

func desktopProxyFunc(req *http.Request) (*url.URL, error) {
	if req == nil || req.URL == nil {
		return nil, nil
	}
	if proxyURL, err := envProxyFunc(req); err != nil || proxyURL != nil {
		return proxyURL, err
	}
	if isLoopbackHost(req.URL.Hostname()) {
		return nil, nil
	}
	return platformSystemProxy(req)
}

func isLoopbackHost(host string) bool {
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "" {
		return false
	}
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

type windowsProxyConfig struct {
	enabled  bool
	fallback *url.URL
	byScheme map[string]*url.URL
	bypass   []string
}

func parseWindowsProxyConfig(proxyServer, proxyOverride string) windowsProxyConfig {
	cfg := windowsProxyConfig{}
	rawServer := strings.TrimSpace(proxyServer)
	if rawServer == "" {
		return cfg
	}

	if strings.Contains(rawServer, "=") {
		cfg.byScheme = make(map[string]*url.URL)
		for _, part := range strings.Split(rawServer, ";") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			scheme, addr, ok := strings.Cut(part, "=")
			if !ok {
				continue
			}
			scheme = strings.ToLower(strings.TrimSpace(scheme))
			if parsed := parseProxyURL(scheme, addr); parsed != nil {
				cfg.byScheme[scheme] = parsed
				if scheme == "socks" && cfg.fallback == nil {
					cfg.fallback = parsed
				}
			}
		}
		cfg.enabled = len(cfg.byScheme) > 0 || cfg.fallback != nil
	} else if parsed := parseProxyURL("http", rawServer); parsed != nil {
		cfg.fallback = parsed
		cfg.enabled = true
	}

	if strings.TrimSpace(proxyOverride) != "" {
		for _, item := range strings.FieldsFunc(proxyOverride, func(r rune) bool {
			return r == ';' || r == ','
		}) {
			rule := strings.ToLower(strings.TrimSpace(item))
			if rule != "" {
				cfg.bypass = append(cfg.bypass, rule)
			}
		}
	}
	return cfg
}

func parseProxyURL(schemeHint, rawAddr string) *url.URL {
	addr := strings.TrimSpace(rawAddr)
	if addr == "" {
		return nil
	}
	if !strings.Contains(addr, "://") {
		defaultScheme := "http"
		if schemeHint == "socks" || schemeHint == "socks5" {
			defaultScheme = "socks5"
		}
		addr = defaultScheme + "://" + addr
	}
	parsed, err := url.Parse(addr)
	if err != nil || parsed.Host == "" {
		return nil
	}
	return parsed
}

func (c windowsProxyConfig) resolve(req *http.Request) (*url.URL, error) {
	if !c.enabled || req == nil || req.URL == nil {
		return nil, nil
	}
	host := req.URL.Hostname()
	if isLoopbackHost(host) || matchProxyBypass(host, c.bypass) {
		return nil, nil
	}
	scheme := strings.ToLower(req.URL.Scheme)
	switch scheme {
	case "ws":
		scheme = "http"
	case "wss":
		scheme = "https"
	}
	if c.byScheme != nil {
		if u, ok := c.byScheme[scheme]; ok && u != nil {
			return u, nil
		}
	}
	return c.fallback, nil
}

func matchProxyBypass(host string, rules []string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" || len(rules) == 0 {
		return false
	}
	for _, rule := range rules {
		r := strings.ToLower(strings.TrimSpace(rule))
		if r == "" {
			continue
		}
		if r == "<local>" {
			if !strings.Contains(h, ".") || isLoopbackHost(h) {
				return true
			}
			continue
		}
		// Strip optional scheme or port pattern from rule if present.
		if idx := strings.Index(r, "://"); idx >= 0 {
			r = r[idx+3:]
		}
		if strings.Contains(r, "*") {
			if matchWildcard(r, h) {
				return true
			}
			continue
		}
		if r == h {
			return true
		}
	}
	return false
}

func matchWildcard(pattern, text string) bool {
	pIdx, tIdx := 0, 0
	starIdx, matchIdx := -1, 0
	for tIdx < len(text) {
		if pIdx < len(pattern) && pattern[pIdx] == text[tIdx] {
			pIdx++
			tIdx++
		} else if pIdx < len(pattern) && pattern[pIdx] == '*' {
			starIdx = pIdx
			matchIdx = tIdx
			pIdx++
		} else if starIdx != -1 {
			pIdx = starIdx + 1
			matchIdx++
			tIdx = matchIdx
		} else {
			return false
		}
	}
	for pIdx < len(pattern) && pattern[pIdx] == '*' {
		pIdx++
	}
	return pIdx == len(pattern)
}
