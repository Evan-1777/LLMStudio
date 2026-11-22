package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func makeValidTTF(payload string) []byte {
	// TrueType sfnt signature 0x00010000 + payload bytes
	return append([]byte{0x00, 0x01, 0x00, 0x00}, []byte(payload)...)
}

func TestCustomFontRoutesAuthCORSValidationAndETag(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	fontStore := store.NewCustomFontStore(db)
	fontSvc := service.NewCustomFontService(fontStore)
	prefSvc := service.NewPreferenceService(store.NewPreferenceStore(db))

	router := NewRouter(RouterDeps{
		Config: config.Config{
			AccessToken: "secret-tok",
			DevMode:     false,
			CORSOrigins: []string{"https://app.example.com"},
		},
		PreferenceService: prefSvc,
		CustomFontService: fontSvc,
	})

	doReq := func(method, path, token, origin string, headers map[string]string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	// 1. Missing auth is rejected on all custom font routes.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/settings/custom-font"},
		{http.MethodPut, "/api/v1/settings/custom-font"},
		{http.MethodPatch, "/api/v1/settings/custom-font"},
		{http.MethodDelete, "/api/v1/settings/custom-font"},
		{http.MethodGet, "/api/v1/settings/custom-font/file"},
	} {
		rec := doReq(tc.method, tc.path, "", "", nil, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without token: got %d, want 401", tc.method, tc.path, rec.Code)
		}
	}

	// 2. Controlled cross-origin preflight allows X-Font-Name and exposes ETag.
	preflight := doReq(http.MethodOptions, "/api/v1/settings/custom-font", "", "https://app.example.com", map[string]string{
		"Access-Control-Request-Method":  "PUT",
		"Access-Control-Request-Headers": "authorization, content-type, x-font-name",
	}, nil)
	if preflight.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", preflight.Code)
	}
	if preflight.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" {
		t.Fatalf("unexpected allow origin: %q", preflight.Header().Get("Access-Control-Allow-Origin"))
	}
	if !strings.Contains(preflight.Header().Get("Access-Control-Allow-Headers"), "X-Font-Name") {
		t.Fatalf("X-Font-Name missing from allow headers: %q", preflight.Header().Get("Access-Control-Allow-Headers"))
	}
	if !strings.Contains(preflight.Header().Get("Access-Control-Expose-Headers"), "ETag") {
		t.Fatalf("ETag missing from expose headers: %q", preflight.Header().Get("Access-Control-Expose-Headers"))
	}

	// 3. Initial GET returns font: null, file returns 404.
	initGet := doReq(http.MethodGet, "/api/v1/settings/custom-font", "secret-tok", "", nil, nil)
	if initGet.Code != http.StatusOK {
		t.Fatalf("initial GET status=%d body=%s", initGet.Code, initGet.Body.String())
	}
	var initEnv struct {
		Font *domain.CustomFontMeta `json:"font"`
	}
	if err := json.Unmarshal(initGet.Body.Bytes(), &initEnv); err != nil || initEnv.Font != nil {
		t.Fatalf("expected null font initially, got err=%v env=%+v", err, initEnv)
	}
	if file404 := doReq(http.MethodGet, "/api/v1/settings/custom-font/file", "secret-tok", "", nil, nil); file404.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on missing file, got %d", file404.Code)
	}

	// 4. Cross-origin PUT font A (with URL-encoded UTF-8 name) succeeds.
	fontABytes := makeValidTTF("font-alpha-content")
	putA := doReq(http.MethodPut, "/api/v1/settings/custom-font", "secret-tok", "https://app.example.com", map[string]string{
		"Content-Type": "font/ttf",
		"X-Font-Name":  url.PathEscape("思源 字体 A.ttf"),
	}, fontABytes)
	if putA.Code != http.StatusOK {
		t.Fatalf("PUT font A failed: %d %s", putA.Code, putA.Body.String())
	}
	if putA.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" {
		t.Fatalf("missing CORS origin on PUT response")
	}
	var envA struct {
		Font domain.CustomFontMeta `json:"font"`
	}
	if err := json.Unmarshal(putA.Body.Bytes(), &envA); err != nil {
		t.Fatalf("decode PUT A: %v", err)
	}
	if envA.Font.Name != "思源 字体 A.ttf" || !envA.Font.Enabled || envA.Font.SizeBytes != int64(len(fontABytes)) || len(envA.Font.SHA256) != 64 {
		t.Fatalf("unexpected font A meta: %+v", envA.Font)
	}

	// 5. Invalid uploads (empty, bad signature, non-ttf, oversize) are rejected and preserve font A.
	badCases := []struct {
		name     string
		fontName string
		data     []byte
		wantCode int
	}{
		{"empty", "empty.ttf", nil, http.StatusBadRequest},
		{"bad_sig", "bad.ttf", []byte("OTTObadfont"), http.StatusBadRequest},
		{"bad_ext", "font.otf", fontABytes, http.StatusBadRequest},
		{"oversize", "big.ttf", append(makeValidTTF(""), make([]byte, domain.CustomFontMaxBytes+1)...), http.StatusRequestEntityTooLarge},
	}
	for _, tc := range badCases {
		rec := doReq(http.MethodPut, "/api/v1/settings/custom-font", "secret-tok", "", map[string]string{
			"Content-Type": "font/ttf",
			"X-Font-Name":  url.PathEscape(tc.fontName),
		}, tc.data)
		if rec.Code != tc.wantCode {
			t.Fatalf("%s: got %d, want %d (%s)", tc.name, rec.Code, tc.wantCode, rec.Body.String())
		}
	}
	// Verify font A is still intact.
	afterBad := doReq(http.MethodGet, "/api/v1/settings/custom-font", "secret-tok", "", nil, nil)
	var envStillA struct {
		Font domain.CustomFontMeta `json:"font"`
	}
	_ = json.Unmarshal(afterBad.Body.Bytes(), &envStillA)
	if envStillA.Font.SHA256 != envA.Font.SHA256 || envStillA.Font.Name != "思源 字体 A.ttf" {
		t.Fatalf("font A was corrupted after rejected uploads: %+v", envStillA.Font)
	}

	// 6. GET /file returns A with ETag and Cache-Control: private, no-cache.
	getFileA := doReq(http.MethodGet, "/api/v1/settings/custom-font/file", "secret-tok", "https://app.example.com", nil, nil)
	if getFileA.Code != http.StatusOK {
		t.Fatalf("GET file A status=%d", getFileA.Code)
	}
	etagA := getFileA.Header().Get("ETag")
	if etagA != `"`+envA.Font.SHA256+`"` {
		t.Fatalf("unexpected ETag A: %q", etagA)
	}
	if cc := getFileA.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("unexpected Cache-Control: %q", cc)
	}
	if !bytes.Equal(getFileA.Body.Bytes(), fontABytes) {
		t.Fatalf("file A bytes mismatch")
	}

	// 7. Replace A with B: requesting fixed URL with A's ETag returns B + new ETag; B's ETag returns 304.
	fontBBytes := makeValidTTF("font-beta-content-v2")
	putB := doReq(http.MethodPut, "/api/v1/settings/custom-font", "secret-tok", "", map[string]string{
		"Content-Type": "font/ttf",
		"X-Font-Name":  "FontB.ttf",
	}, fontBBytes)
	if putB.Code != http.StatusOK {
		t.Fatalf("PUT font B failed: %d %s", putB.Code, putB.Body.String())
	}
	var envB struct {
		Font domain.CustomFontMeta `json:"font"`
	}
	_ = json.Unmarshal(putB.Body.Bytes(), &envB)
	etagB := `"` + envB.Font.SHA256 + `"`
	if etagB == etagA {
		t.Fatal("expected distinct ETags for A and B")
	}

	staleCheck := doReq(http.MethodGet, "/api/v1/settings/custom-font/file", "secret-tok", "", map[string]string{
		"If-None-Match": etagA,
	}, nil)
	if staleCheck.Code != http.StatusOK || staleCheck.Header().Get("ETag") != etagB || !bytes.Equal(staleCheck.Body.Bytes(), fontBBytes) {
		t.Fatalf("stale ETag A should return B: code=%d etag=%q len=%d", staleCheck.Code, staleCheck.Header().Get("ETag"), staleCheck.Body.Len())
	}

	freshCheck := doReq(http.MethodGet, "/api/v1/settings/custom-font/file", "secret-tok", "", map[string]string{
		"If-None-Match": etagB,
	}, nil)
	if freshCheck.Code != http.StatusNotModified || freshCheck.Header().Get("ETag") != etagB || freshCheck.Body.Len() != 0 {
		t.Fatalf("current ETag B should return 304: code=%d etag=%q len=%d", freshCheck.Code, freshCheck.Header().Get("ETag"), freshCheck.Body.Len())
	}

	// 8. PATCH toggles enabled only; DELETE removes record.
	patchRec := doReq(http.MethodPatch, "/api/v1/settings/custom-font", "secret-tok", "", map[string]string{
		"Content-Type": "application/json",
	}, []byte(`{"enabled":false}`))
	if patchRec.Code != http.StatusOK {
		t.Fatalf("PATCH status=%d body=%s", patchRec.Code, patchRec.Body.String())
	}
	var envPatched struct {
		Font domain.CustomFontMeta `json:"font"`
	}
	_ = json.Unmarshal(patchRec.Body.Bytes(), &envPatched)
	if envPatched.Font.Enabled || envPatched.Font.SHA256 != envB.Font.SHA256 {
		t.Fatalf("unexpected PATCH result: %+v", envPatched.Font)
	}

	delRec := doReq(http.MethodDelete, "/api/v1/settings/custom-font", "secret-tok", "", nil, nil)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("DELETE status=%d", delRec.Code)
	}
	afterDel := doReq(http.MethodGet, "/api/v1/settings/custom-font", "secret-tok", "", nil, nil)
	var envDel struct {
		Font *domain.CustomFontMeta `json:"font"`
	}
	_ = json.Unmarshal(afterDel.Body.Bytes(), &envDel)
	if envDel.Font != nil {
		t.Fatalf("expected nil font after delete, got %+v", envDel.Font)
	}
}
