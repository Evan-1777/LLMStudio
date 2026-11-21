package desktop

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestNewDesktopHTTPTransportDefaults(t *testing.T) {
	tr := NewDesktopHTTPTransport()
	if tr.MaxIdleConns != 64 || tr.MaxIdleConnsPerHost != 16 || tr.IdleConnTimeout != 90*time.Second || !tr.ForceAttemptHTTP2 {
		t.Fatalf("unexpected transport pool settings: %+v", tr)
	}
	if tr.Proxy == nil {
		t.Fatal("expected Proxy func to be set")
	}
}

func TestDesktopProxyFuncEnvPriorityAndLoopbackBypass(t *testing.T) {
	orig := envProxyFunc
	t.Cleanup(func() { envProxyFunc = orig })

	wantEnv, _ := url.Parse("http://127.0.0.1:8888")
	envProxyFunc = func(*http.Request) (*url.URL, error) {
		return wantEnv, nil
	}

	req, _ := http.NewRequest(http.MethodGet, "https://api.example.com/v1/models", nil)
	got, err := desktopProxyFunc(req)
	if err != nil {
		t.Fatalf("desktopProxyFunc error: %v", err)
	}
	if got == nil || got.String() != "http://127.0.0.1:8888" {
		t.Fatalf("expected env proxy http://127.0.0.1:8888, got %v", got)
	}

	// Clear proxy env and verify loopback hosts never receive a proxy.
	envProxyFunc = func(*http.Request) (*url.URL, error) {
		return nil, nil
	}
	for _, rawURL := range []string{
		"http://127.0.0.1:8080/healthz",
		"http://localhost:8080/healthz",
		"http://[::1]:8080/healthz",
	} {
		loopReq, _ := http.NewRequest(http.MethodGet, rawURL, nil)
		loopProxy, loopErr := desktopProxyFunc(loopReq)
		if loopErr != nil || loopProxy != nil {
			t.Fatalf("expected direct connection for %s, got proxy=%v err=%v", rawURL, loopProxy, loopErr)
		}
	}
}

func TestParseWindowsProxyConfigAndBypassRules(t *testing.T) {
	// Single address form applies to both http and https.
	single := parseWindowsProxyConfig("127.0.0.1:7890", "<local>;*.internal.corp;192.168.*;exact.bypass.test")
	for _, tc := range []struct {
		url      string
		want     string
	}{
		{"https://api.openai.com/v1/chat/completions", "http://127.0.0.1:7890"},
		{"http://example.com/test", "http://127.0.0.1:7890"},
		{"http://intranet/api", ""},
		{"https://svc.internal.corp/v1", ""},
		{"http://192.168.1.50:8080/v1", ""},
		{"https://exact.bypass.test/a", ""},
		{"http://127.0.0.1:9000/local", ""},
		{"http://localhost:3000/local", ""},
	} {
		req, _ := http.NewRequest(http.MethodGet, tc.url, nil)
		got, err := single.resolve(req)
		if err != nil {
			t.Fatalf("resolve(%s) error: %v", tc.url, err)
		}
		gotStr := ""
		if got != nil {
			gotStr = got.String()
		}
		if gotStr != tc.want {
			t.Fatalf("resolve(%s) = %q, want %q", tc.url, gotStr, tc.want)
		}
	}

	// Per-scheme mapping form.
	mapped := parseWindowsProxyConfig("http=127.0.0.1:7890;https=http://127.0.0.1:7891", "*.local,10.*")
	httpReq, _ := http.NewRequest(http.MethodGet, "http://example.org", nil)
	httpsReq, _ := http.NewRequest(http.MethodGet, "https://example.org", nil)
	bypassReq, _ := http.NewRequest(http.MethodGet, "https://nas.local", nil)

	if u, _ := mapped.resolve(httpReq); u == nil || u.String() != "http://127.0.0.1:7890" {
		t.Fatalf("unexpected http mapped proxy: %v", u)
	}
	if u, _ := mapped.resolve(httpsReq); u == nil || u.String() != "http://127.0.0.1:7891" {
		t.Fatalf("unexpected https mapped proxy: %v", u)
	}
	if u, _ := mapped.resolve(bypassReq); u != nil {
		t.Fatalf("expected *.local to bypass proxy, got %v", u)
	}
}
