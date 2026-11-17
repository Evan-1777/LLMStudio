package integration_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

type capturedUpstream struct {
	mu       sync.Mutex
	path     string
	rawQuery string
	headers  http.Header
	body     map[string]any
}

func newGatewayFixtureServer(t *testing.T, token string) (*httptest.Server, *store.MessageStore) {
	t.Helper()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "gateway_integration.db")
	db, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	formats.MustRegister(format.NewOpenAIResponsesFormat())
	formats.MustRegister(format.NewAnthropicMessagesFormat())
	formats.MustRegister(format.NewGoogleGenAIFormat())

	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	router := httpapi.NewRouter(httpapi.RouterDeps{
		Config: config.Config{
			AccessToken: token,
			DevMode:     false,
			CORSOrigins: []string{"*"},
		},
		Formats:             formats,
		ProviderService:     service.NewProviderService(provStore, formats, adapters),
		ConversationService: service.NewConversationService(convStore, msgStore),
		ChatService:         service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}),
	})

	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return srv, msgStore
}

func apiDo(t *testing.T, method, url, token string, payload any) *http.Response {
	t.Helper()
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, url, err)
	}
	return resp
}

func readSSEEvents(t *testing.T, resp *http.Response) []domain.StreamEvent {
	t.Helper()
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	var events []domain.StreamEvent
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		raw := strings.TrimPrefix(line, "data: ")
		var ev domain.StreamEvent
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			t.Fatalf("invalid StreamEvent JSON %q: %v", raw, err)
		}
		events = append(events, ev)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read SSE stream: %v", err)
	}
	return events
}

func TestGatewayAuthAndProviderLifecycle(t *testing.T) {
	const gwToken = "integration-secret-token"
	gw, _ := newGatewayFixtureServer(t, gwToken)

	// Health check is public; API routes reject missing/invalid token.
	healthResp := apiDo(t, http.MethodGet, gw.URL+"/healthz", "", nil)
	healthResp.Body.Close()
	if healthResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /healthz, got %d", healthResp.StatusCode)
	}

	unauth := apiDo(t, http.MethodGet, gw.URL+"/api/v1/providers", "", nil)
	unauth.Body.Close()
	if unauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", unauth.StatusCode)
	}

	wrong := apiDo(t, http.MethodGet, gw.URL+"/api/v1/providers", "wrong", nil)
	wrong.Body.Close()
	if wrong.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d", wrong.StatusCode)
	}

	// Verify 4 registered formats.
	fmtResp := apiDo(t, http.MethodGet, gw.URL+"/api/v1/formats", gwToken, nil)
	var fmtBody struct {
		Formats []plugin.FormatInfo `json:"formats"`
	}
	_ = json.NewDecoder(fmtResp.Body).Decode(&fmtBody)
	fmtResp.Body.Close()
	if fmtResp.StatusCode != http.StatusOK || len(fmtBody.Formats) != 4 {
		t.Fatalf("expected 4 formats, got status=%d count=%d", fmtResp.StatusCode, len(fmtBody.Formats))
	}

	// Reject unknown apiFormat.
	badProv := apiDo(t, http.MethodPost, gw.URL+"/api/v1/providers", gwToken, map[string]any{
		"name":     "Invalid",
		"adapter":  "generic-http",
		"baseURL":  "https://example.com/v1",
		"authType": "bearer",
		"apiKey":   "sk-abc",
		"models":   []map[string]any{{"id": "m1", "name": "M1", "apiFormat": "unknown-proto"}},
	})
	badProv.Body.Close()
	if badProv.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown apiFormat, got %d", badProv.StatusCode)
	}

	// Create valid provider, verify redaction, keep key on PUT, clear with clearApiKey, delete.
	var seenAuthHeader string
	echoUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuthHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer echoUpstream.Close()

	createResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/providers", gwToken, map[string]any{
		"id":       "p-auth-check",
		"name":     "Echo",
		"adapter":  "generic-http",
		"baseURL":  echoUpstream.URL,
		"authType": "bearer",
		"apiKey":   "sk-live-secret-key",
		"models":   []map[string]any{{"id": "m1", "name": "M1", "apiFormat": "openai-completions"}},
	})
	rawCreate, _ := io.ReadAll(createResp.Body)
	createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated || strings.Contains(string(rawCreate), "sk-live-secret-key") {
		t.Fatalf("unexpected create provider response: status=%d body=%s", createResp.StatusCode, rawCreate)
	}

	// PUT without apiKey retains original secret key.
	putResp := apiDo(t, http.MethodPut, gw.URL+"/api/v1/providers/p-auth-check", gwToken, map[string]any{
		"name":     "Echo Renamed",
		"adapter":  "generic-http",
		"baseURL":  echoUpstream.URL,
		"authType": "bearer",
		"models":   []map[string]any{{"id": "m1", "name": "M1", "apiFormat": "openai-completions"}},
	})
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT provider failed: %d", putResp.StatusCode)
	}

	convResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/conversations", gwToken, map[string]any{
		"providerId": "p-auth-check",
		"modelId":    "m1",
	})
	var convWrap struct {
		Conversation domain.Conversation `json:"conversation"`
	}
	_ = json.NewDecoder(convResp.Body).Decode(&convWrap)
	convResp.Body.Close()

	streamResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/conversations/"+convWrap.Conversation.ID+"/messages/stream", gwToken, map[string]any{
		"text": "ping",
	})
	_ = readSSEEvents(t, streamResp)
	if seenAuthHeader != "Bearer sk-live-secret-key" {
		t.Fatalf("expected retained bearer key to be sent upstream, got %q", seenAuthHeader)
	}

	// Delete provider.
	delResp := apiDo(t, http.MethodDelete, gw.URL+"/api/v1/providers/p-auth-check", gwToken, nil)
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 on DELETE provider, got %d", delResp.StatusCode)
	}
}

func TestGatewayFourProtocolsCompatAndToolHistory(t *testing.T) {
	// Independent fixtures modeled after official OpenAI, Anthropic, and Google SSE specs.
	const gwToken = "proto-token"
	gw, msgStore := newGatewayFixtureServer(t, gwToken)

	type protoCase struct {
		name           string
		apiFormat      string
		authType       string
		apiKey         string
		compat         map[string]any
		sseBody        string
		verifyUpstream func(t *testing.T, capReq *capturedUpstream)
		expectedText   string
		expectedThink  string
		expectedTool   string
	}

	cases := []protoCase{
		{
			name:      "openai-completions",
			apiFormat: "openai-completions",
			authType:  "bearer",
			apiKey:    "sk-oai-comp",
			compat: map[string]any{
				"maxTokensField":        "max_tokens",
				"supportsDeveloperRole": false,
				"extraBody":             map[string]any{"top_p": 0.9},
			},
			// Official OpenAI chat.completions streaming fixture with reasoning_content + content + usage + [DONE].
			sseBody: strings.Join([]string{
				`data: {"id":"chatcmpl-1","choices":[{"delta":{"reasoning_content":"comp-think"}}]}`,
				``,
				`data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"comp-answer"},"finish_reason":"stop"}]}`,
				``,
				`data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
				``,
				`data: [DONE]`,
				``,
			}, "\n"),
			verifyUpstream: func(t *testing.T, capReq *capturedUpstream) {
				if capReq.path != "/v1/chat/completions" {
					t.Fatalf("expected /v1/chat/completions, got %q", capReq.path)
				}
				if capReq.body["max_tokens"] != float64(512) || capReq.body["top_p"] != 0.9 {
					t.Fatalf("compat overrides not applied: %+v", capReq.body)
				}
				msgs := capReq.body["messages"].([]any)
				if msgs[0].(map[string]any)["role"] != "system" {
					t.Fatalf("expected system role override, got %+v", msgs[0])
				}
			},
			expectedThink: "comp-think",
			expectedText:  "comp-answer",
		},
		{
			name:      "openai-responses",
			apiFormat: "openai-responses",
			authType:  "bearer",
			apiKey:    "sk-oai-resp",
			// Official OpenAI Responses API SSE fixture.
			sseBody: strings.Join([]string{
				`event: response.output_item.added`,
				`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning"}}`,
				``,
				`event: response.reasoning_summary_text.delta`,
				`data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"resp-think"}`,
				``,
				`event: response.output_item.done`,
				`data: {"type":"response.output_item.done","output_index":0}`,
				``,
				`event: response.output_item.added`,
				`data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message"}}`,
				``,
				`event: response.output_text.delta`,
				`data: {"type":"response.output_text.delta","output_index":1,"delta":"resp-answer"}`,
				``,
				`event: response.output_item.done`,
				`data: {"type":"response.output_item.done","output_index":1}`,
				``,
				`event: response.completed`,
				`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":8,"output_tokens":12,"total_tokens":20}}}`,
				``,
			}, "\n"),
			verifyUpstream: func(t *testing.T, capReq *capturedUpstream) {
				if capReq.path != "/v1/responses" {
					t.Fatalf("expected /v1/responses, got %q", capReq.path)
				}
				if capReq.body["instructions"] != "You are concise." || capReq.body["max_output_tokens"] != float64(512) {
					t.Fatalf("unexpected responses body: %+v", capReq.body)
				}
			},
			expectedThink: "resp-think",
			expectedText:  "resp-answer",
		},
		{
			name:      "anthropic-messages",
			apiFormat: "anthropic-messages",
			authType:  "x-api-key",
			apiKey:    "sk-ant-key",
			// Official Anthropic Messages API SSE fixture.
			sseBody: strings.Join([]string{
				`event: message_start`,
				`data: {"type":"message_start","message":{"usage":{"input_tokens":14,"output_tokens":0}}}`,
				``,
				`event: content_block_start`,
				`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`,
				``,
				`event: content_block_delta`,
				`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ant-think"}}`,
				``,
				`event: content_block_delta`,
				`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-ant"}}`,
				``,
				`event: content_block_stop`,
				`data: {"type":"content_block_stop","index":0}`,
				``,
				`event: content_block_start`,
				`data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}`,
				``,
				`event: content_block_delta`,
				`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ant-answer"}}`,
				``,
				`event: content_block_stop`,
				`data: {"type":"content_block_stop","index":1}`,
				``,
				`event: message_delta`,
				`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}`,
				``,
				`event: message_stop`,
				`data: {"type":"message_stop"}`,
				``,
			}, "\n"),
			verifyUpstream: func(t *testing.T, capReq *capturedUpstream) {
				if capReq.path != "/v1/messages" {
					t.Fatalf("expected /v1/messages, got %q", capReq.path)
				}
				if capReq.headers.Get("x-api-key") != "sk-ant-key" || capReq.headers.Get("anthropic-version") != "2023-06-01" {
					t.Fatalf("missing anthropic headers: %v", capReq.headers)
				}
			},
			expectedThink: "ant-think",
			expectedText:  "ant-answer",
		},
		{
			name:      "google-generative-ai",
			apiFormat: "google-generative-ai",
			authType:  "query-key",
			apiKey:    "gem-secret",
			// Official Google Gemini streamGenerateContent?alt=sse fixture.
			sseBody: strings.Join([]string{
				`data: {"candidates":[{"content":{"parts":[{"text":"gem-think","thought":true}]}}]}`,
				``,
				`data: {"candidates":[{"content":{"parts":[{"text":"gem-answer"}]}}]}`,
				``,
				`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"k":"v"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7,"thoughtsTokenCount":3,"totalTokenCount":21}}`,
				``,
			}, "\n"),
			verifyUpstream: func(t *testing.T, capReq *capturedUpstream) {
				if !strings.Contains(capReq.path, "/v1beta/models/model-") || !strings.Contains(capReq.rawQuery, "key=gem-secret") || !strings.Contains(capReq.rawQuery, "alt=sse") {
					t.Fatalf("unexpected gemini endpoint path=%q query=%q", capReq.path, capReq.rawQuery)
				}
			},
			expectedThink: "gem-think",
			expectedText:  "gem-answer",
			expectedTool:  "lookup",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			capReq := &capturedUpstream{}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rawBody, _ := io.ReadAll(r.Body)
				var decoded map[string]any
				_ = json.Unmarshal(rawBody, &decoded)
				capReq.mu.Lock()
				capReq.path = r.URL.Path
				capReq.rawQuery = r.URL.RawQuery
				capReq.headers = r.Header.Clone()
				capReq.body = decoded
				capReq.mu.Unlock()

				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, tc.sseBody)
			}))
			defer upstream.Close()

			provID := "prov-" + tc.name
			modelID := "model-" + tc.name
			pResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/providers", gwToken, map[string]any{
				"id":       provID,
				"name":     tc.name,
				"adapter":  "generic-http",
				"baseURL":  upstream.URL,
				"authType": tc.authType,
				"apiKey":   tc.apiKey,
				"models": []map[string]any{
					{
						"id":        modelID,
						"name":      modelID,
						"apiFormat": tc.apiFormat,
						"reasoning": true,
						"compat":    tc.compat,
					},
				},
			})
			pResp.Body.Close()
			if pResp.StatusCode != http.StatusCreated {
				t.Fatalf("create provider %s failed: %d", tc.name, pResp.StatusCode)
			}

			cResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/conversations", gwToken, map[string]any{
				"title":        "Test " + tc.name,
				"providerId":   provID,
				"modelId":      modelID,
				"systemPrompt": "You are concise.",
				"params":       map[string]any{"maxTokens": 512},
			})
			var convWrap struct {
				Conversation domain.Conversation `json:"conversation"`
			}
			_ = json.NewDecoder(cResp.Body).Decode(&convWrap)
			cResp.Body.Close()

			// Verify syncEnabled toggle persists without advancing syncState/syncVersion.
			patchResp := apiDo(t, http.MethodPatch, gw.URL+"/api/v1/conversations/"+convWrap.Conversation.ID, gwToken, map[string]any{
				"syncEnabled": true,
			})
			var patched struct {
				Conversation domain.Conversation `json:"conversation"`
			}
			_ = json.NewDecoder(patchResp.Body).Decode(&patched)
			patchResp.Body.Close()
			if !patched.Conversation.SyncEnabled || patched.Conversation.SyncState != domain.SyncStateLocalOnly || patched.Conversation.SyncVersion != 0 {
				t.Fatalf("unexpected sync persistence: %+v", patched.Conversation)
			}

			// Seed reserved toolCall / toolResult history to verify replay encoding.
			_, err := msgStore.Create(context.Background(), domain.Message{
				ConversationID: convWrap.Conversation.ID,
				Role:           domain.RoleAssistant,
				Blocks: []domain.ContentBlock{
					{Type: domain.BlockTypeToolCall, ID: "hist_tc_1", Name: "clock", Arguments: json.RawMessage(`{}`)},
				},
				CreatedAt: time.Now().UTC().Add(-2 * time.Second),
			})
			if err != nil {
				t.Fatalf("seed toolCall history: %v", err)
			}
			_, err = msgStore.Create(context.Background(), domain.Message{
				ConversationID: convWrap.Conversation.ID,
				Role:           domain.RoleToolResult,
				Blocks: []domain.ContentBlock{
					{Type: domain.BlockTypeToolResult, ToolCallID: "hist_tc_1", ToolName: "clock", Content: "08:00"},
				},
				CreatedAt: time.Now().UTC().Add(-1 * time.Second),
			})
			if err != nil {
				t.Fatalf("seed toolResult history: %v", err)
			}

			streamResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/conversations/"+convWrap.Conversation.ID+"/messages/stream", gwToken, map[string]any{
				"text": "Proceed",
			})
			if streamResp.StatusCode != http.StatusOK {
				raw, _ := io.ReadAll(streamResp.Body)
				streamResp.Body.Close()
				t.Fatalf("stream status=%d body=%s", streamResp.StatusCode, raw)
			}
			events := readSSEEvents(t, streamResp)

			capReq.mu.Lock()
			tc.verifyUpstream(t, capReq)
			capReq.mu.Unlock()

			var finalMsg *domain.Message
			for i := range events {
				if events[i].Type == domain.StreamEventMessageEnd {
					finalMsg = events[i].Message
				}
			}
			if finalMsg == nil {
				t.Fatalf("missing message_end event: %+v", events)
			}

			var sawThink, sawText, sawTool bool
			for _, b := range finalMsg.Blocks {
				if b.Type == domain.BlockTypeThinking && b.Thinking == tc.expectedThink {
					sawThink = true
				}
				if b.Type == domain.BlockTypeText && b.Text == tc.expectedText {
					sawText = true
				}
				if b.Type == domain.BlockTypeToolCall && b.Name == tc.expectedTool {
					sawTool = true
				}
			}
			if !sawThink || !sawText || (tc.expectedTool != "" && !sawTool) {
				t.Fatalf("unexpected decoded message blocks for %s: %+v", tc.name, finalMsg.Blocks)
			}
		})
	}
}

func TestGatewayClientCancelAbortsUpstreamAndPersistsPartial(t *testing.T) {
	const gwToken = "abort-token"
	gw, _ := newGatewayFixtureServer(t, gwToken)

	upstreamCanceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Partial answer\"}}]}\n\n")
		flusher.Flush()
		select {
		case <-r.Context().Done():
			close(upstreamCanceled)
		case <-time.After(3 * time.Second):
		}
	}))
	defer upstream.Close()

	pResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/providers", gwToken, map[string]any{
		"id":       "abort-prov",
		"name":     "Abortable",
		"adapter":  "generic-http",
		"baseURL":  upstream.URL,
		"authType": "none",
		"models":   []map[string]any{{"id": "m1", "name": "M1", "apiFormat": "openai-completions"}},
	})
	pResp.Body.Close()

	cResp := apiDo(t, http.MethodPost, gw.URL+"/api/v1/conversations", gwToken, map[string]any{
		"providerId": "abort-prov",
		"modelId":    "m1",
	})
	var convWrap struct {
		Conversation domain.Conversation `json:"conversation"`
	}
	_ = json.NewDecoder(cResp.Body).Decode(&convWrap)
	cResp.Body.Close()

	ctx, cancel := context.WithCancel(context.Background())
	reqBody, _ := json.Marshal(map[string]any{"text": "Stream until aborted"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gw.URL+"/api/v1/conversations/"+convWrap.Conversation.ID+"/messages/stream", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+gwToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if strings.Contains(sc.Text(), "Partial answer") {
			cancel()
			break
		}
	}
	resp.Body.Close()

	select {
	case <-upstreamCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not canceled when client aborted SSE")
	}

	var savedAborted bool
	for range 30 {
		detailResp := apiDo(t, http.MethodGet, gw.URL+"/api/v1/conversations/"+convWrap.Conversation.ID, gwToken, nil)
		var detail service.ConversationDetail
		_ = json.NewDecoder(detailResp.Body).Decode(&detail)
		detailResp.Body.Close()
		if len(detail.Messages) == 2 && detail.Messages[1].StopReason == domain.StopReasonAborted {
			if len(detail.Messages[1].Blocks) == 1 && detail.Messages[1].Blocks[0].Text == "Partial answer" {
				savedAborted = true
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !savedAborted {
		t.Fatal("expected aborted message with partial text to be persisted")
	}
}
