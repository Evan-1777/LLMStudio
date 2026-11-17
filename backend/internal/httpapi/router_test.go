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
	})
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
}
