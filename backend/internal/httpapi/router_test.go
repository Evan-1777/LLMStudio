package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func setupTestRouter(t *testing.T, token string, devMode bool) http.Handler {
	t.Helper()
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	providerStore := store.NewProviderStore(db)
	assistantStore := store.NewAssistantStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	searchStore := store.NewSearchConfigStore(db)
	mcpStore := store.NewMCPServerStore(db)
	prefStore := store.NewPreferenceStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	formats.MustRegister(format.NewOpenAIResponsesFormat())
	formats.MustRegister(format.NewAnthropicMessagesFormat())
	formats.MustRegister(format.NewGoogleGenAIFormat())

	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	searchReg := plugin.NewSearchRegistry()
	searchReg.MustRegister(search.NewTavilyEngine(nil))
	searchReg.MustRegister(search.NewSearXNGEngine(nil))

	return NewRouter(RouterDeps{
		Config: config.Config{
			AccessToken: token,
			DevMode:     devMode,
			CORSOrigins: []string{"*"},
		},
		Formats:             formats,
		Adapters:            adapters,
		ProviderService:     service.NewProviderService(providerStore, formats, adapters),
		AssistantService:    service.NewAssistantService(assistantStore),
		ConversationService: service.NewConversationService(convStore, msgStore).WithAssistants(assistantStore),
		PluginService:       service.NewPluginService(searchReg, searchStore, mcpStore),
		ChatService: service.NewChatService(providerStore, convStore, msgStore, formats, adapters, &http.Client{}).
			WithAssistants(assistantStore).
			WithSearch(searchReg, searchStore),
		PreferenceService: service.NewPreferenceService(prefStore),
		StorageService:    service.NewStorageService(store.NewStorageMaintenance(db, ":memory:")),
	})
}

func TestStorageEndpoints(t *testing.T) {
	const tok = "test-token"
	router := setupTestRouter(t, tok, false)

	if rec := doJSONReq(t, router, http.MethodGet, "/api/v1/storage", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /storage status=%d", rec.Code)
	}
	rec := doJSONReq(t, router, http.MethodGet, "/api/v1/storage", tok, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /storage status=%d body=%s", rec.Code, rec.Body.String())
	}
	var usage domain.StorageUsage
	if err := json.Unmarshal(rec.Body.Bytes(), &usage); err != nil {
		t.Fatalf("decode storage usage: %v", err)
	}
	if usage.Compactable || usage.TotalBytes != 0 {
		t.Fatalf("memory test database must not report compactable files: %+v", usage)
	}
	rec = doJSONReq(t, router, http.MethodPost, "/api/v1/storage/compact", tok, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("compaction of a memory database must fail with 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func doJSONReq(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func fetchPreferences(t *testing.T, h http.Handler, token string) (domain.Preferences, bool) {
	t.Helper()
	rec := doJSONReq(t, h, http.MethodGet, "/api/v1/settings", token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /settings status=%d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Preferences domain.Preferences `json:"preferences"`
		Initialized bool               `json:"initialized"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode settings envelope: %v", err)
	}
	return envelope.Preferences, envelope.Initialized
}

func TestProviderAPIKeyImportEndpoint(t *testing.T) {
	const tok = "test-token"
	router := setupTestRouter(t, tok, false)

	createRec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers", tok, map[string]any{
		"id": "local-provider", "name": "Local", "adapter": "generic-http",
		"baseURL": "https://example.com", "authType": "bearer", "localRequest": true,
	})
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create provider status=%d body=%s", createRec.Code, createRec.Body.String())
	}
	doJSONReq(t, router, http.MethodPost, "/api/v1/providers", tok, map[string]any{
		"id": "forward-provider", "name": "Forward", "adapter": "generic-http",
		"baseURL": "https://example.com", "authType": "bearer",
	})

	if rec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers/local-provider/keys/import", "", map[string]any{"apiKey": "sk-x"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated import status=%d", rec.Code)
	}

	rec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers/local-provider/keys/import", tok, map[string]any{"apiKey": "sk-browser"})
	if rec.Code != http.StatusOK {
		t.Fatalf("import status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "\"applied\":true") {
		t.Fatalf("expected applied=true, body=%s", body)
	}
	if strings.Contains(body, "sk-browser") {
		t.Fatalf("import response leaked the credential: %s", body)
	}

	// Replaying the import reports "already managed" without overwriting.
	replay := doJSONReq(t, router, http.MethodPost, "/api/v1/providers/local-provider/keys/import", tok, map[string]any{"apiKey": "sk-second"})
	if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), "\"applied\":false") {
		t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body.String())
	}
	list := doJSONReq(t, router, http.MethodGet, "/api/v1/providers", tok, nil)
	if !strings.Contains(list.Body.String(), "sk-b...wser") {
		t.Fatalf("provider list lost the adopted key mask: %s", list.Body.String())
	}

	// Ineligible and missing providers have distinct, credential-free errors.
	if rec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers/forward-provider/keys/import", tok, map[string]any{"apiKey": "sk-x"}); rec.Code != http.StatusConflict {
		t.Fatalf("forward import status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers/missing/keys/import", tok, map[string]any{"apiKey": "sk-x"}); rec.Code != http.StatusNotFound {
		t.Fatalf("missing import status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers/local-provider/keys/import", tok, map[string]any{"apiKey": "  "}); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty import status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProviderReorderEndpoint(t *testing.T) {
	const tok = "test-token"
	const path = "/api/v1/providers"
	const secret = "example-test-credential"
	router := setupTestRouter(t, tok, false)
	for _, id := range []string{"a", "b", "c"} {
		rec := doJSONReq(t, router, http.MethodPost, path, tok, map[string]any{
			"id": id, "name": id, "adapter": "generic-http", "baseURL": "https://example.com", "authType": "bearer", "apiKey": secret,
		})
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %s: %s", id, rec.Body.String())
		}
	}
	timestamps := map[string]time.Time{}
	check := func(rec *httptest.ResponseRecorder, want string) {
		t.Helper()
		if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), secret) || strings.Contains(rec.Body.String(), "\"apiKey\"") {
			t.Fatalf("response %d: %s", rec.Code, rec.Body.String())
		}
		var body struct{ Providers []domain.ProviderConfig }
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		got := ""
		for _, p := range body.Providers {
			got += p.ID
			if ts, ok := timestamps[p.ID]; ok && ts != p.UpdatedAt {
				t.Fatalf("reorder changed timestamp for %s", p.ID)
			}
			timestamps[p.ID] = p.UpdatedAt
		}
		if got != want {
			t.Fatalf("order %s, want %s", got, want)
		}
	}
	check(doJSONReq(t, router, http.MethodGet, path, tok, nil), "abc")
	for _, tc := range []struct {
		id     string
		before any
		want   string
	}{{"c", "a", "cab"}, {"b", "a", "cba"}, {"c", nil, "bac"}, {"a", "c", "bac"}} {
		check(doJSONReq(t, router, http.MethodPost, path+"/reorder", tok, map[string]any{"id": tc.id, "beforeId": tc.before}), tc.want)
	}
	for _, tc := range []struct {
		token, id string
		before    any
		status    int
	}{{"", "b", nil, 401}, {tok, "x", nil, 404}, {tok, "b", "x", 404}, {tok, "", nil, 400}} {
		rec := doJSONReq(t, router, http.MethodPost, path+"/reorder", tc.token, map[string]any{"id": tc.id, "beforeId": tc.before})
		if rec.Code != tc.status {
			t.Fatalf("status %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
		}
	}
	check(doJSONReq(t, router, http.MethodGet, path, tok, nil), "bac")
}

func TestPreferenceEndpoints(t *testing.T) {
	const tok = "test-token"
	router := setupTestRouter(t, tok, false)

	if rec := doJSONReq(t, router, http.MethodGet, "/api/v1/settings", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /settings status=%d", rec.Code)
	}

	prefs, initialized := fetchPreferences(t, router, tok)
	if initialized {
		t.Fatal("expected fresh gateway to report initialized=false")
	}
	if prefs != domain.DefaultPreferences() {
		t.Fatalf("unexpected defaults: %+v", prefs)
	}

	rec := doJSONReq(t, router, http.MethodPatch, "/api/v1/settings", tok, map[string]any{
		"themeMode":               "dark",
		"enterToSend":             false,
		"composerReasoningEffort": "high",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH /settings status=%d body=%s", rec.Code, rec.Body.String())
	}
	var patched struct {
		Preferences domain.Preferences `json:"preferences"`
		Initialized bool               `json:"initialized"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &patched); err != nil {
		t.Fatalf("decode PATCH response: %v", err)
	}
	if !patched.Initialized || patched.Preferences.ThemeMode != domain.ThemeModeDark || patched.Preferences.EnterToSend {
		t.Fatalf("unexpected PATCH response: %+v", patched)
	}
	if patched.Preferences.SeedColorValue != domain.DefaultAppleBlue || patched.Preferences.CollapseLineThreshold != 24 {
		t.Fatalf("partial PATCH overwrote untouched defaults: %+v", patched.Preferences)
	}

	// A later single-field update must not reset previously committed fields.
	if rec := doJSONReq(t, router, http.MethodPatch, "/api/v1/settings", tok, map[string]any{
		"collapseLineThreshold": 40,
	}); rec.Code != http.StatusOK {
		t.Fatalf("second PATCH status=%d body=%s", rec.Code, rec.Body.String())
	}
	prefs, initialized = fetchPreferences(t, router, tok)
	if !initialized || prefs.ThemeMode != domain.ThemeModeDark || prefs.EnterToSend || prefs.CollapseLineThreshold != 40 || prefs.ComposerReasoningEffort != domain.EffortHigh {
		t.Fatalf("settings not preserved across updates: %+v initialized=%v", prefs, initialized)
	}

	// The two auto-collapse switches use an "On" suffix in the wire contract and
	// must not be silently dropped by the patch decoder.
	if rec := doJSONReq(t, router, http.MethodPatch, "/api/v1/settings", tok, map[string]any{
		"autoCollapseThinkingOnComplete": false,
		"autoCollapseToolsOnComplete":    false,
	}); rec.Code != http.StatusOK {
		t.Fatalf("collapse PATCH status=%d body=%s", rec.Code, rec.Body.String())
	}
	prefs, _ = fetchPreferences(t, router, tok)
	if prefs.AutoCollapseThinkingComplete || prefs.AutoCollapseToolsComplete {
		t.Fatalf("auto-collapse preferences were dropped: %+v", prefs)
	}

	if rec := doJSONReq(t, router, http.MethodPatch, "/api/v1/settings", tok, map[string]any{"composerReasoningEffort": "none"}); rec.Code != http.StatusOK {
		t.Fatalf("explicit none status=%d body=%s", rec.Code, rec.Body.String())
	}
	legacy := domain.DefaultPreferences()
	legacy.ComposerReasoningEffort = domain.EffortMax
	if rec := doJSONReq(t, router, http.MethodPost, "/api/v1/settings/import", tok, legacy); rec.Code != http.StatusOK {
		t.Fatalf("legacy import status=%d body=%s", rec.Code, rec.Body.String())
	}
	if prefs, _ := fetchPreferences(t, router, tok); prefs.ComposerReasoningEffort != domain.EffortNone {
		t.Fatalf("legacy import overwrote explicit none: %+v", prefs)
	}

	invalid := []map[string]any{
		{"composerReasoningEffort": "ultra"},
		{"themeMode": "sepia"},
		{"chatDisplayMode": "grid"},
		{"collapseLineThreshold": 1},
		{"collapseCharThreshold": 999999},
		{"seedColorValue": -1},
		{"enterToSend": "yes"},
		{"fontFamily": "comic"},
		{"fontSize": 11},
		{"fontSize": 23},
	}
	for _, body := range invalid {
		if rec := doJSONReq(t, router, http.MethodPatch, "/api/v1/settings", tok, body); rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %v, got status=%d body=%s", body, rec.Code, rec.Body.String())
		}
	}

	rec = doJSONReq(t, router, http.MethodPatch, "/api/v1/settings", tok, map[string]any{
		"fontFamily":             "serif",
		"fontSize":               18,
		"builtinTimeToolEnabled": true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH typography/builtin tool status=%d body=%s", rec.Code, rec.Body.String())
	}
	var typoEnv struct {
		Preferences domain.Preferences `json:"preferences"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &typoEnv)
	if typoEnv.Preferences.FontFamily != domain.FontFamilySerif || typoEnv.Preferences.FontSize != 18 || !typoEnv.Preferences.BuiltinTimeToolEnabled {
		t.Fatalf("unexpected patch result: %+v", typoEnv.Preferences)
	}
}

func TestRouterEndpointsAndStreamCancellation(t *testing.T) {
	const tok = "test-token"
	router := setupTestRouter(t, tok, false)

	// 1. GET /api/v1/formats
	rec := doJSONReq(t, router, http.MethodGet, "/api/v1/formats", tok, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /formats status=%d body=%s", rec.Code, rec.Body.String())
	}
	var fmtResp struct {
		Formats  []plugin.FormatInfo          `json:"formats"`
		Adapters []plugin.ProviderAdapterInfo `json:"adapters"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &fmtResp)
	if len(fmtResp.Formats) != 4 || len(fmtResp.Adapters) != 1 || fmtResp.Formats[0].DefaultPath == "" {
		t.Fatalf("expected 4 formats with defaultPath and 1 adapter, got %+v", fmtResp)
	}

	// 2. Mock upstream SSE server (supports both fast completion and cancelable slow stream).
	blockCh := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)

		if r.Header.Get("X-Test-Slow") == "1" {
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Partial \"}}]}\n\n")
			flusher.Flush()
			select {
			case <-r.Context().Done():
			case <-blockCh:
			case <-time.After(3 * time.Second):
			}
			return
		}

		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n")
		flusher.Flush()
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()
	defer close(blockCh)

	// 3. Invalid model format rejected with 400.
	badRec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers", tok, map[string]any{
		"name":     "Bad",
		"adapter":  "generic-http",
		"baseURL":  upstream.URL,
		"authType": "bearer",
		"apiKey":   "sk-1234567890",
		"models":   []map[string]any{{"id": "m1", "name": "M1", "apiFormat": "does-not-exist"}},
	})
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid apiFormat, got %d: %s", badRec.Code, badRec.Body.String())
	}

	// 4. Create provider, verify redaction + PUT preserves key, then clearApiKey clears it.
	createProvRec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers", tok, map[string]any{
		"id":       "mock-p",
		"name":     "Mock Provider",
		"adapter":  "generic-http",
		"baseURL":  upstream.URL,
		"authType": "bearer",
		"apiKey":   "sk-secret-9999",
		"models": []map[string]any{
			{"id": "mock-model", "name": "Mock", "apiFormat": "openai-completions"},
		},
	})
	if createProvRec.Code != http.StatusCreated {
		t.Fatalf("POST /providers status=%d body=%s", createProvRec.Code, createProvRec.Body.String())
	}
	if strings.Contains(createProvRec.Body.String(), "sk-secret-9999") {
		t.Fatalf("plaintext key leaked in POST response: %s", createProvRec.Body.String())
	}

	putKeepRec := doJSONReq(t, router, http.MethodPut, "/api/v1/providers/mock-p", tok, map[string]any{
		"name":     "Mock Provider Renamed",
		"adapter":  "generic-http",
		"baseURL":  upstream.URL,
		"authType": "bearer",
		"models": []map[string]any{
			{"id": "mock-model", "name": "Mock", "apiFormat": "openai-completions"},
		},
	})
	if putKeepRec.Code != http.StatusOK || !strings.Contains(putKeepRec.Body.String(), `"apiKeySet":true`) {
		t.Fatalf("PUT without apiKey should keep key: status=%d body=%s", putKeepRec.Code, putKeepRec.Body.String())
	}

	putClearRec := doJSONReq(t, router, http.MethodPut, "/api/v1/providers/mock-p", tok, map[string]any{
		"name":        "Mock Provider Renamed",
		"adapter":     "generic-http",
		"baseURL":     upstream.URL,
		"authType":    "none",
		"clearApiKey": true,
		"models": []map[string]any{
			{"id": "mock-model", "name": "Mock", "apiFormat": "openai-completions"},
		},
	})
	if putClearRec.Code != http.StatusOK || !strings.Contains(putClearRec.Body.String(), `"apiKeySet":false`) {
		t.Fatalf("PUT with clearApiKey should clear key: status=%d body=%s", putClearRec.Code, putClearRec.Body.String())
	}

	// 5. Create conversation + PATCH clearing params via null.
	temp := 0.8
	convRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations", tok, map[string]any{
		"title":        "Demo",
		"providerId":   "mock-p",
		"modelId":      "mock-model",
		"systemPrompt": "Stay brief",
		"params":       map[string]any{"temperature": temp, "reasoningEffort": "low"},
	})
	if convRec.Code != http.StatusCreated {
		t.Fatalf("POST /conversations status=%d body=%s", convRec.Code, convRec.Body.String())
	}
	var convWrap struct {
		Conversation domain.Conversation `json:"conversation"`
	}
	_ = json.Unmarshal(convRec.Body.Bytes(), &convWrap)
	convID := convWrap.Conversation.ID

	patchRec := doJSONReq(t, router, http.MethodPatch, "/api/v1/conversations/"+convID, tok, map[string]any{
		"params": map[string]any{"temperature": nil, "reasoningEffort": ""},
	})
	if patchRec.Code != http.StatusOK {
		t.Fatalf("PATCH /conversations status=%d body=%s", patchRec.Code, patchRec.Body.String())
	}
	var patchedWrap struct {
		Conversation domain.Conversation `json:"conversation"`
	}
	_ = json.Unmarshal(patchRec.Body.Bytes(), &patchedWrap)
	if patchedWrap.Conversation.SystemPrompt != "Stay brief" || patchedWrap.Conversation.Params.Temperature != nil || patchedWrap.Conversation.Params.ReasoningEffort != "" {
		t.Fatalf("PATCH did not preserve systemPrompt or clear null params: %+v", patchedWrap.Conversation)
	}

	// 6. Normal SSE stream via real httptest.Server.
	gw := httptest.NewServer(router)
	defer gw.Close()

	streamBody, _ := json.Marshal(map[string]any{"text": "Hi"})
	req, _ := http.NewRequest(http.MethodPost, gw.URL+"/api/v1/conversations/"+convID+"/messages/stream", bytes.NewReader(streamBody))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d", resp.StatusCode)
	}
	scanner := bufio.NewScanner(resp.Body)
	var sseText strings.Builder
	for scanner.Scan() {
		sseText.WriteString(scanner.Text())
		sseText.WriteByte('\n')
	}
	resp.Body.Close()
	if !strings.Contains(sseText.String(), `"type":"message_end"`) || !strings.Contains(sseText.String(), `"Hello "`) {
		t.Fatalf("unexpected SSE output: %s", sseText.String())
	}

	// Verify GET /conversations/{id} includes persisted user + assistant messages.
	detailRec := doJSONReq(t, router, http.MethodGet, "/api/v1/conversations/"+convID, tok, nil)
	if detailRec.Code != http.StatusOK {
		t.Fatalf("GET detail status=%d", detailRec.Code)
	}
	var detail service.ConversationDetail
	_ = json.Unmarshal(detailRec.Body.Bytes(), &detail)
	if len(detail.Messages) != 2 || detail.Messages[1].StopReason != domain.StopReasonStop {
		t.Fatalf("expected 2 persisted messages, got %+v", detail.Messages)
	}

	// 7. Update provider to trigger slow stream and verify client cancellation saves partial response with stopReason == "aborted".
	_ = doJSONReq(t, router, http.MethodPut, "/api/v1/providers/mock-p", tok, map[string]any{
		"name":     "Mock Slow",
		"adapter":  "generic-http",
		"baseURL":  upstream.URL,
		"authType": "none",
		"headers":  map[string]string{"X-Test-Slow": "1"},
		"models":   []map[string]any{{"id": "mock-model", "name": "Mock", "apiFormat": "openai-completions"}},
	})

	cancelCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	slowReqBody, _ := json.Marshal(map[string]any{"text": "Stream slowly"})
	slowReq, _ := http.NewRequestWithContext(cancelCtx, http.MethodPost, gw.URL+"/api/v1/conversations/"+convID+"/messages/stream", bytes.NewReader(slowReqBody))
	slowReq.Header.Set("Authorization", "Bearer "+tok)
	slowReq.Header.Set("Content-Type", "application/json")
	slowResp, err := http.DefaultClient.Do(slowReq)
	if err != nil {
		t.Fatalf("slow stream request failed: %v", err)
	}
	sc := bufio.NewScanner(slowResp.Body)
	for sc.Scan() {
		if strings.Contains(sc.Text(), "Partial ") {
			cancel()
			break
		}
	}
	slowResp.Body.Close()

	// Wait briefly for server goroutine to finish persisting aborted message.
	var abortedFound bool
	for range 20 {
		checkRec := doJSONReq(t, router, http.MethodGet, "/api/v1/conversations/"+convID, tok, nil)
		_ = json.Unmarshal(checkRec.Body.Bytes(), &detail)
		if len(detail.Messages) == 4 && detail.Messages[3].StopReason == domain.StopReasonAborted {
			abortedFound = true
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !abortedFound {
		t.Fatalf("expected aborted partial message to be persisted, got %+v", detail.Messages)
	}

	// 8. Assistants, MCP servers, message delete, and branch endpoints.
	assistRec := doJSONReq(t, router, http.MethodPost, "/api/v1/assistants", tok, map[string]any{
		"name":         "Reviewer",
		"systemPrompt": "Review code",
	})
	if assistRec.Code != http.StatusCreated {
		t.Fatalf("POST /assistants status=%d body=%s", assistRec.Code, assistRec.Body.String())
	}
	var assistWrap struct {
		Assistant domain.Assistant `json:"assistant"`
	}
	_ = json.Unmarshal(assistRec.Body.Bytes(), &assistWrap)
	if delDef := doJSONReq(t, router, http.MethodDelete, "/api/v1/assistants/default", tok, nil); delDef.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 deleting default assistant, got %d", delDef.Code)
	}
	if delCustom := doJSONReq(t, router, http.MethodDelete, "/api/v1/assistants/"+assistWrap.Assistant.ID, tok, nil); delCustom.Code != http.StatusNoContent {
		t.Fatalf("expected 204 deleting custom assistant, got %d", delCustom.Code)
	}

	branchRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/"+convID+"/messages/"+detail.Messages[1].ID+"/branch", tok, nil)
	if branchRec.Code != http.StatusCreated {
		t.Fatalf("POST /branch status=%d body=%s", branchRec.Code, branchRec.Body.String())
	}
	var branched service.ConversationDetail
	_ = json.Unmarshal(branchRec.Body.Bytes(), &branched)
	if len(branched.Messages) != 2 || !strings.HasSuffix(branched.Conversation.Title, "(分支)") {
		t.Fatalf("unexpected branch detail: %+v", branched)
	}

	delMsgRec := doJSONReq(t, router, http.MethodDelete, "/api/v1/conversations/"+convID+"/messages/"+detail.Messages[3].ID, tok, nil)
	if delMsgRec.Code != http.StatusNoContent {
		t.Fatalf("DELETE message status=%d body=%s", delMsgRec.Code, delMsgRec.Body.String())
	}

	mcpRec := doJSONReq(t, router, http.MethodPost, "/api/v1/mcp/servers", tok, map[string]any{
		"name":      "local-mcp",
		"transport": "stdio",
		"command":   "npx",
		"args":      []string{"-y", "mcp-server"},
	})
	if mcpRec.Code != http.StatusCreated {
		t.Fatalf("POST /mcp/servers status=%d body=%s", mcpRec.Code, mcpRec.Body.String())
	}

	// 9. Conversation groups, batch, reorder endpoints + auth enforcement + rank stability across TouchUpdatedAt.
	unauthRec := doJSONReq(t, router, http.MethodGet, "/api/v1/conversation-groups?assistantId=default", "", nil)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on unauthenticated group list, got %d", unauthRec.Code)
	}

	grpRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversation-groups", tok, map[string]any{
		"assistantId": "default",
		"name":        "Research",
	})
	if grpRec.Code != http.StatusCreated {
		t.Fatalf("POST /conversation-groups status=%d body=%s", grpRec.Code, grpRec.Body.String())
	}
	var grpOut struct {
		Group domain.ConversationGroup `json:"group"`
	}
	_ = json.Unmarshal(grpRec.Body.Bytes(), &grpOut)

	badMoveRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/batch", tok, map[string]any{
		"assistantId": "default",
		"ids":         []string{convID},
		"operation":   "move",
	})
	if badMoveRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for move omitting groupId, got %d", badMoveRec.Code)
	}

	goodMoveRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/batch", tok, map[string]any{
		"assistantId": "default",
		"ids":         []string{convID},
		"operation":   "move",
		"groupId":     grpOut.Group.ID,
	})
	if goodMoveRec.Code != http.StatusOK {
		t.Fatalf("move to group status=%d body=%s", goodMoveRec.Code, goodMoveRec.Body.String())
	}

	badPinnedReorder := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/reorder", tok, map[string]any{
		"assistantId": "default",
		"ids":         []string{convID},
		"pinned":      true,
		"groupId":     nil,
	})
	if badPinnedReorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when pinned=true includes groupId, got %d", badPinnedReorder.Code)
	}

	// Reorder convID and branched conversation inside ungrouped, then send a message on second item and verify order doesn't revert.
	unpinRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/reorder", tok, map[string]any{
		"assistantId": "default",
		"ids":         []string{convID},
		"pinned":      false,
		"groupId":     nil,
	})
	if unpinRec.Code != http.StatusOK {
		t.Fatalf("reorder ungrouped status=%d body=%s", unpinRec.Code, unpinRec.Body.String())
	}
	var snap struct {
		Conversations []domain.Conversation `json:"conversations"`
	}
	_ = json.Unmarshal(unpinRec.Body.Bytes(), &snap)
	if len(snap.Conversations) != 2 || snap.Conversations[0].ID != branched.Conversation.ID || snap.Conversations[1].ID != convID {
		t.Fatalf("expected [branched, convID], got %+v", snap.Conversations)
	}
	// Create a message on the second item (convID) -> TouchUpdatedAt must NOT pull convID ahead of branched!
	msgCreateRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/"+convID+"/messages", tok, map[string]any{
		"role":   "user",
		"blocks": []map[string]any{{"type": "text", "text": "keep order"}},
	})
	if msgCreateRec.Code != http.StatusCreated {
		t.Fatalf("create message status=%d body=%s", msgCreateRec.Code, msgCreateRec.Body.String())
	}
	listAfterMsgRec := doJSONReq(t, router, http.MethodGet, "/api/v1/conversations?assistantId=default", tok, nil)
	_ = json.Unmarshal(listAfterMsgRec.Body.Bytes(), &snap)
	if snap.Conversations[0].ID != branched.Conversation.ID || snap.Conversations[1].ID != convID {
		t.Fatalf("expected order preserved after message touch, got %+v", snap.Conversations)
	}

	delGrpRec := doJSONReq(t, router, http.MethodDelete, "/api/v1/conversation-groups/"+grpOut.Group.ID, tok, nil)
	if delGrpRec.Code != http.StatusOK {
		t.Fatalf("DELETE /conversation-groups status=%d body=%s", delGrpRec.Code, delGrpRec.Body.String())
	}
}

func TestRuntimeCredentialEndpointsAndConversationImport(t *testing.T) {
	const tok = "cred-secret-token"
	router := setupTestRouter(t, tok, false)

	// Seed provider and search engine with API keys.
	provRec := doJSONReq(t, router, http.MethodPost, "/api/v1/providers", tok, map[string]any{
		"id":       "prov-cred",
		"name":     "OpenAI",
		"adapter":  "generic-http",
		"baseURL":  "https://api.openai.com/v1",
		"authType": "bearer",
		"apiKey":   "sk-live-very-secret-key",
		"models":   []map[string]any{{"id": "gpt-4o", "name": "GPT-4o", "apiFormat": "openai-completions"}},
	})
	if provRec.Code != http.StatusCreated {
		t.Fatalf("create provider status=%d body=%s", provRec.Code, provRec.Body.String())
	}
	searchRec := doJSONReq(t, router, http.MethodPut, "/api/v1/plugins/search/tavily", tok, map[string]any{
		"enabled": true,
		"apiKey":  "tvly-secret-token",
	})
	if searchRec.Code != http.StatusOK {
		t.Fatalf("update search status=%d body=%s", searchRec.Code, searchRec.Body.String())
	}

	// Unauthenticated credential requests must be rejected with 401.
	if rec := doJSONReq(t, router, http.MethodGet, "/api/v1/providers/prov-cred/credential", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauth provider credential, got %d", rec.Code)
	}
	if rec := doJSONReq(t, router, http.MethodGet, "/api/v1/plugins/search/tavily/credential", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauth search credential, got %d", rec.Code)
	}

	// Authenticated credential fetches return raw key + Cache-Control: no-store.
	provCredRec := doJSONReq(t, router, http.MethodGet, "/api/v1/providers/prov-cred/credential", tok, nil)
	if provCredRec.Code != http.StatusOK {
		t.Fatalf("GET provider credential status=%d body=%s", provCredRec.Code, provCredRec.Body.String())
	}
	if cc := provCredRec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("expected Cache-Control=no-store, got %q", cc)
	}
	var provCred struct {
		ProviderID string `json:"providerId"`
		APIKey     string `json:"apiKey"`
		UpdatedAt  string `json:"updatedAt"`
	}
	_ = json.Unmarshal(provCredRec.Body.Bytes(), &provCred)
	if provCred.ProviderID != "prov-cred" || provCred.APIKey != "sk-live-very-secret-key" || provCred.UpdatedAt == "" {
		t.Fatalf("unexpected provider credential payload: %+v", provCred)
	}

	searchCredRec := doJSONReq(t, router, http.MethodGet, "/api/v1/plugins/search/tavily/credential", tok, nil)
	if searchCredRec.Code != http.StatusOK || searchCredRec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("GET search credential failed: status=%d cc=%q", searchCredRec.Code, searchCredRec.Header().Get("Cache-Control"))
	}
	if !strings.Contains(searchCredRec.Body.String(), "tvly-secret-token") {
		t.Fatalf("expected search credential apiKey, got %s", searchCredRec.Body.String())
	}

	// Standard list endpoints remain masked.
	listProv := doJSONReq(t, router, http.MethodGet, "/api/v1/providers", tok, nil)
	if strings.Contains(listProv.Body.String(), "sk-live-very-secret-key") {
		t.Fatalf("GET /providers leaked raw apiKey: %s", listProv.Body.String())
	}
	listSearch := doJSONReq(t, router, http.MethodGet, "/api/v1/plugins/search", tok, nil)
	if strings.Contains(listSearch.Body.String(), "tvly-secret-token") {
		t.Fatalf("GET /plugins/search leaked raw apiKey: %s", listSearch.Body.String())
	}

	// Conversation import: ephemeral rejected, missing assistant falls back to default, conflict + force.
	if badEph := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/import", tok, map[string]any{
		"conversation": map[string]any{"id": "eph-1", "title": "Temp", "ephemeral": true},
		"messages":     []any{},
	}); badEph.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ephemeral import, got %d", badEph.Code)
	}

	t0 := time.Now().UTC().Add(-time.Hour)
	impRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/import", tok, map[string]any{
		"conversation": map[string]any{
			"id":          "imp-http-1",
			"assistantId": "missing-assistant",
			"title":       "Imported HTTP",
			"createdAt":   t0.Format(time.RFC3339Nano),
			"updatedAt":   t0.Format(time.RFC3339Nano),
		},
		"messages": []map[string]any{
			{
				"id":        "imp-m1",
				"role":      "user",
				"blocks":    []map[string]any{{"type": "text", "text": "hello import"}},
				"createdAt": t0.Format(time.RFC3339Nano),
			},
		},
	})
	if impRec.Code != http.StatusOK {
		t.Fatalf("POST /conversations/import status=%d body=%s", impRec.Code, impRec.Body.String())
	}
	var detail struct {
		Conversation domain.Conversation `json:"conversation"`
		Messages     []domain.Message    `json:"messages"`
	}
	_ = json.Unmarshal(impRec.Body.Bytes(), &detail)
	if detail.Conversation.AssistantID != domain.DefaultAssistantID || len(detail.Messages) != 1 {
		t.Fatalf("unexpected imported detail: %+v", detail)
	}

	// Add a cloud message so target is newer -> subsequent import without force returns 409.
	addMsgRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/imp-http-1/messages", tok, map[string]any{
		"role":   "assistant",
		"blocks": []map[string]any{{"type": "text", "text": "cloud reply"}},
	})
	if addMsgRec.Code != http.StatusCreated {
		t.Fatalf("create cloud message status=%d body=%s", addMsgRec.Code, addMsgRec.Body.String())
	}
	conflictRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/import", tok, map[string]any{
		"conversation": detail.Conversation,
		"messages":     detail.Messages,
	})
	if conflictRec.Code != http.StatusConflict {
		t.Fatalf("expected 409 CONFLICT on stale import, got %d body=%s", conflictRec.Code, conflictRec.Body.String())
	}

	forcedRec := doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/import", tok, map[string]any{
		"conversation": detail.Conversation,
		"messages":     detail.Messages,
		"force":        true,
	})
	if forcedRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on forced import, got %d body=%s", forcedRec.Code, forcedRec.Body.String())
	}
}
