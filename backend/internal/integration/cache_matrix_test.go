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
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/mcp"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

type matrixSearchStub struct {
	hits *atomic.Int32
}

func (s matrixSearchStub) ID() string              { return "tavily" }
func (s matrixSearchStub) DisplayName() string     { return "Matrix Search" }
func (s matrixSearchStub) DefaultEndpoint() string { return "https://search.local" }
func (s matrixSearchStub) RequiresAPIKey() bool    { return false }
func (s matrixSearchStub) Search(_ context.Context, in plugin.SearchQueryInput) ([]plugin.SearchResult, error) {
	n := s.hits.Add(1)
	return []plugin.SearchResult{{
		Title:   fmt.Sprintf("Search #%d", n),
		URL:     "https://docs.example/search",
		Snippet: "Query=" + in.Query,
	}}, nil
}

func TestCachingFourFormatsTwoPathsAndMCPCoexistenceMatrix(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "cache_matrix.db")
	db, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	assistStore := store.NewAssistantStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	searchStore := store.NewSearchConfigStore(db)
	mcpStore := store.NewMCPServerStore(db)

	if _, err := searchStore.Upsert(ctx, domain.SearchEngineConfig{
		EngineID:   "tavily",
		Enabled:    true,
		Endpoint:   "https://search.local",
		MaxResults: 3,
		IsDefault:  true,
	}); err != nil {
		t.Fatalf("upsert search config: %v", err)
	}

	var searchHits atomic.Int32
	searchReg := plugin.NewSearchRegistry()
	searchReg.MustRegister(matrixSearchStub{hits: &searchHits})

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	formats.MustRegister(format.NewOpenAIResponsesFormat())
	formats.MustRegister(format.NewAnthropicMessagesFormat())
	formats.MustRegister(format.NewGoogleGenAIFormat())

	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	rt := mcp.NewRuntime()
	defer func() { _ = rt.Close() }()

	const gwToken = "cache-matrix-token"
	buildRouter := func() http.Handler {
		return httpapi.NewRouter(httpapi.RouterDeps{
			Config: config.Config{
				AccessToken: gwToken,
				DevMode:     false,
				CORSOrigins: []string{"*"},
			},
			Formats:             formats,
			Adapters:            adapters,
			ProviderService:     service.NewProviderService(provStore, formats, adapters),
			AssistantService:    service.NewAssistantService(assistStore),
			ConversationService: service.NewConversationService(convStore, msgStore).WithAssistants(assistStore),
			PluginService:       service.NewPluginService(searchReg, searchStore, mcpStore).WithMCPClient(rt),
			ChatService: service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
				WithAssistants(assistStore).
				WithSearch(searchReg, searchStore).
				WithMCP(mcpStore, rt),
		})
	}

	// Two independent gateway servers sharing ONLY SQLite (proves stateless localRequest continuation).
	gwA := httptest.NewServer(buildRouter())
	defer gwA.Close()
	gwB := httptest.NewServer(buildRouter())
	defer gwB.Close()

	// Real Streamable HTTP MCP server with 2 tools and dynamic schema toggle.
	var (
		mcpMu           sync.Mutex
		mcpToolCalls    int
		includeExtraArg bool
	)
	mcpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var rpc struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&rpc)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "cache-mcp-sess")
		if len(rpc.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		switch rpc.Method {
		case "initialize":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      rpc.ID,
				"result": map[string]any{
					"protocolVersion": "2025-11-25",
					"capabilities":    map[string]any{"tools": map[string]any{}},
					"serverInfo":      map[string]any{"name": "cache-mcp", "version": "1.0"},
				},
			})
		case "tools/list":
			mcpMu.Lock()
			extra := includeExtraArg
			mcpMu.Unlock()
			props := map[string]any{"x": map[string]any{"type": "string"}}
			if extra {
				props["y"] = map[string]any{"type": "string"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      rpc.ID,
				"result": map[string]any{
					"tools": []map[string]any{
						{
							"name":        "step_tool",
							"description": "Stateful step tool",
							"inputSchema": map[string]any{"type": "object", "properties": props},
						},
					},
				},
			})
		case "tools/call":
			mcpMu.Lock()
			mcpToolCalls++
			callNo := mcpToolCalls
			mcpMu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      rpc.ID,
				"result": map[string]any{
					"content": []map[string]any{
						{"type": "text", "text": fmt.Sprintf("tool-res-%d(%v)", callNo, rpc.Params.Arguments["x"])},
					},
				},
			})
		}
	}))
	defer mcpSrv.Close()

	// Helper to call gateway JSON API.
	callGW := func(baseURL, method, path string, body any, out any) int {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req, _ := http.NewRequest(method, baseURL+path, &buf)
		req.Header.Set("Authorization", "Bearer "+gwToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s failed: %v", method, path, err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if out != nil && len(raw) > 0 {
			_ = json.Unmarshal(raw, out)
		}
		return resp.StatusCode
	}

	// Register MCP server (disabled initially for basic 4-format checks, enabled for MCP+cache test).
	var mcpCreated struct {
		Server domain.MCPServerConfig `json:"server"`
	}
	if code := callGW(gwA.URL, http.MethodPost, "/api/v1/mcp/servers", map[string]any{
		"name":      "Cache MCP",
		"transport": domain.MCPTransportStreamableHTTP,
		"endpoint":  mcpSrv.URL,
		"enabled":   false,
	}, &mcpCreated); code != http.StatusCreated {
		t.Fatalf("create mcp server status=%d", code)
	}

	// Mock multi-format upstream server tracking bodies and cache creations.
	var (
		upMu           sync.Mutex
		gemCreates     int
		gemGenerates   int
		gemMode        string // "normal", "small", "unsupported", "auth", "ratelimit", "expire_once"
		gemStore       = make(map[string]map[string]any)
		oaiChatBodies  []map[string]any
		oaiRespBodies  []map[string]any
		antBodies      []map[string]any
		gemBodies      []map[string]any
	)
	gemMode = "normal"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)

		switch {
		case r.URL.Path == "/v1/messages":
			upMu.Lock()
			antBodies = append(antBodies, body)
			upMu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, strings.Join([]string{
				`event: message_start`,
				`data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":40,"cache_read_input_tokens":50,"output_tokens":0}}}`,
				``,
				`event: content_block_start`,
				`data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}`,
				``,
				`event: content_block_delta`,
				`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ant-ok"}}`,
				``,
				`event: content_block_stop`,
				`data: {"type":"content_block_stop","index":0}`,
				``,
				`event: message_delta`,
				`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}`,
				``,
				`event: message_stop`,
				`data: {"type":"message_stop"}`,
				``,
			}, "\n"))

		case r.URL.Path == "/v1/chat/completions":
			upMu.Lock()
			oaiChatBodies = append(oaiChatBodies, body)
			upMu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, strings.Join([]string{
				`data: {"choices":[{"delta":{"content":"chat-ok"},"finish_reason":"stop"}]}`,
				``,
				`data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":70,"cache_write_tokens":20}}}`,
				``,
				`data: [DONE]`,
				``,
			}, "\n"))

		case r.URL.Path == "/v1/responses":
			upMu.Lock()
			oaiRespBodies = append(oaiRespBodies, body)
			upMu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, strings.Join([]string{
				`event: response.output_item.added`,
				`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"m1","type":"message"}}`,
				``,
				`event: response.output_text.delta`,
				`data: {"type":"response.output_text.delta","output_index":0,"delta":"resp-ok"}`,
				``,
				`event: response.output_item.done`,
				`data: {"type":"response.output_item.done","output_index":0}`,
				``,
				`event: response.completed`,
				`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":80,"output_tokens":12,"total_tokens":92,"input_tokens_details":{"cached_tokens":60,"cache_creation_tokens":10}}}}`,
				``,
			}, "\n"))

		case r.URL.Path == "/v1beta/cachedContents":
			upMu.Lock()
			mode := gemMode
			upMu.Unlock()
			switch mode {
			case "small":
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":{"message":"total token count too small"}}`)
				return
			case "unsupported":
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"message":"cachedContents unsupported"}}`)
				return
			case "auth":
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":{"message":"invalid api key"}}`)
				return
			case "ratelimit":
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = io.WriteString(w, `{"error":{"message":"rate limit exceeded"}}`)
				return
			}
			upMu.Lock()
			gemCreates++
			cid := fmt.Sprintf("cachedContents/mat-%d", gemCreates)
			gemStore[cid] = body
			upMu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":       cid,
				"expireTime": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano),
			})

		case strings.HasPrefix(r.URL.Path, "/v1beta/models/"):
			upMu.Lock()
			gemGenerates++
			gNo := gemGenerates
			mode := gemMode
			gemBodies = append(gemBodies, body)
			upMu.Unlock()

			if mode == "expire_once" {
				upMu.Lock()
				gemMode = "normal"
				upMu.Unlock()
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"message":"CachedContent not found"}}`)
				return
			}

			// Count functionResponse parts before checking mid-loop expiry trigger.
			fnRespCount := 0
			if contents, ok := body["contents"].([]any); ok {
				for _, c := range contents {
					for _, p := range c.(map[string]any)["parts"].([]any) {
						if p.(map[string]any)["functionResponse"] != nil {
							fnRespCount++
						}
					}
				}
			}
			if mode == "expire_on_fnresp1" && fnRespCount == 1 {
				upMu.Lock()
				gemMode = "normal"
				upMu.Unlock()
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"message":"CachedContent not found"}}`)
				return
			}

			// Verify cachedContent vs tools exclusivity when cachedContent is present.
			if ref, _ := body["cachedContent"].(string); ref != "" {
				if _, hasTools := body["tools"]; hasTools {
					t.Fatalf("main Gemini request #%d sent tools alongside cachedContent=%s", gNo, ref)
				}
				if _, hasSys := body["systemInstruction"]; hasSys {
					t.Fatalf("main Gemini request #%d sent systemInstruction alongside cachedContent=%s", gNo, ref)
				}
			}

			// Inspect whether MCP tools are active (via cached store or request body).
			hasTools := body["tools"] != nil
			if ref, _ := body["cachedContent"].(string); ref != "" {
				upMu.Lock()
				if cached, ok := gemStore[ref]; ok && cached["tools"] != nil {
					hasTools = true
				}
				upMu.Unlock()
			}

			w.Header().Set("Content-Type", "text/event-stream")
			if hasTools && fnRespCount == 0 {
				var toolName string
				upMu.Lock()
				if ref, _ := body["cachedContent"].(string); ref != "" {
					toolName = gemStore[ref]["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)["name"].(string)
				} else {
					toolName = body["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)["name"].(string)
				}
				upMu.Unlock()
				_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"id\":\"gc_1\",\"name\":%q,\"args\":{\"x\":\"r1\"}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":200,\"cachedContentTokenCount\":150,\"candidatesTokenCount\":10,\"totalTokenCount\":210}}\n\n", toolName)
				return
			}
			if hasTools && fnRespCount == 1 {
				var toolName string
				upMu.Lock()
				if ref, _ := body["cachedContent"].(string); ref != "" {
					toolName = gemStore[ref]["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)["name"].(string)
				} else {
					toolName = body["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)["name"].(string)
				}
				upMu.Unlock()
				_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"id\":\"gc_2\",\"name\":%q,\"args\":{\"x\":\"r2\"}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":250,\"cachedContentTokenCount\":150,\"candidatesTokenCount\":10,\"totalTokenCount\":260}}\n\n", toolName)
				return
			}
			_, _ = fmt.Fprint(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gem-final\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":300,\"cachedContentTokenCount\":150,\"candidatesTokenCount\":20,\"totalTokenCount\":320}}\n\n")

		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	// Create providers & models for all 4 formats (including OpenAI explicit via PUT + GET).
	var pAntResp struct{ Provider domain.ProviderConfig }
	if code := callGW(gwA.URL, http.MethodPost, "/api/v1/providers", map[string]any{
		"name": "Ant", "adapter": "generic-http", "baseURL": upstream.URL, "authType": "x-api-key", "apiKey": "ak-1",
		"models": []map[string]any{{"id": "claude-sonnet", "name": "Claude", "apiFormat": "anthropic-messages"}},
	}, &pAntResp); code != http.StatusCreated {
		t.Fatalf("create ant provider=%d", code)
	}

	var pOaiResp struct{ Provider domain.ProviderConfig }
	if code := callGW(gwA.URL, http.MethodPost, "/api/v1/providers", map[string]any{
		"name": "OAI", "adapter": "generic-http", "baseURL": upstream.URL, "authType": "bearer", "apiKey": "ok-1",
		"models": []map[string]any{
			{"id": "gpt-implicit", "name": "GPT Implicit", "apiFormat": "openai-completions"},
			{"id": "gpt-explicit", "name": "GPT Explicit", "apiFormat": "openai-completions", "compat": map[string]any{"cacheMode": "explicit"}},
			{"id": "resp-implicit", "name": "Resp Implicit", "apiFormat": "openai-responses"},
			{"id": "resp-explicit", "name": "Resp Explicit", "apiFormat": "openai-responses", "compat": map[string]any{"cacheMode": "explicit"}},
		},
	}, &pOaiResp); code != http.StatusCreated {
		t.Fatalf("create oai provider=%d", code)
	}
	// Verify GET read-back preserves explicit cacheMode.
	var pOaiList struct{ Providers []domain.ProviderConfig }
	callGW(gwA.URL, http.MethodGet, "/api/v1/providers", nil, &pOaiList)
	var gotExplicit string
	for _, p := range pOaiList.Providers {
		if p.ID == pOaiResp.Provider.ID {
			gotExplicit = p.Models[1].Compat.CacheMode
		}
	}
	if gotExplicit != domain.CacheModeExplicit {
		t.Fatalf("expected persisted cacheMode explicit on GET /providers, got %q", gotExplicit)
	}

	var pGemResp struct{ Provider domain.ProviderConfig }
	if code := callGW(gwA.URL, http.MethodPost, "/api/v1/providers", map[string]any{
		"name": "Gem", "adapter": "generic-http", "baseURL": upstream.URL + "/v1beta", "authType": "query-key", "apiKey": "gk-1",
		"models": []map[string]any{{"id": "gemini-2.5-pro", "name": "Gemini", "apiFormat": "google-generative-ai"}},
	}, &pGemResp); code != http.StatusCreated {
		t.Fatalf("create gem provider=%d", code)
	}

	var pGemLocalResp struct{ Provider domain.ProviderConfig }
	if code := callGW(gwA.URL, http.MethodPost, "/api/v1/providers", map[string]any{
		"name": "GemLocal", "adapter": "generic-http", "baseURL": upstream.URL + "/v1beta", "authType": "query-key", "localRequest": true,
		"models": []map[string]any{{"id": "gemini-2.5-pro", "name": "Gemini Local", "apiFormat": "google-generative-ai"}},
	}, &pGemLocalResp); code != http.StatusCreated {
		t.Fatalf("create local gem provider=%d", code)
	}

	// Helper to stream server-forward chat and collect message_end event.
	streamForward := func(convID, provID, modelID, text string, autoCache bool) (int, domain.Message) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{
			"providerId":      provID,
			"modelId":         modelID,
			"text":            text,
			"autoCreateCache": autoCache,
		})
		req, _ := http.NewRequest(http.MethodPost, gwA.URL+"/api/v1/conversations/"+convID+"/messages/stream", bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+gwToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("stream request error: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return resp.StatusCode, domain.Message{}
		}
		var endMsg domain.Message
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "data: ") {
				var ev domain.StreamEvent
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) == nil && ev.Type == domain.StreamEventMessageEnd && ev.Message != nil {
					endMsg = *ev.Message
				}
			}
		}
		return resp.StatusCode, endMsg
	}

	newConv := func(provID, modelID, sys string) string {
		var out struct{ Conversation domain.Conversation }
		callGW(gwA.URL, http.MethodPost, "/api/v1/conversations", map[string]any{
			"providerId": provID, "modelId": modelID, "systemPrompt": sys,
		}, &out)
		return out.Conversation.ID
	}

	// 1. Anthropic autoCreateCache off vs on.
	cAnt := newConv(pAntResp.Provider.ID, "claude-sonnet", "AntSys")
	_, _ = streamForward(cAnt, pAntResp.Provider.ID, "claude-sonnet", "off", false)
	_, antMsg := streamForward(cAnt, pAntResp.Provider.ID, "claude-sonnet", "on", true)
	if antMsg.Usage == nil || antMsg.Usage.InputTokens != 100 || antMsg.Usage.CacheReadInputTokens != 50 || antMsg.Usage.CacheCreationInputTokens != 40 {
		t.Fatalf("unexpected anthropic usage: %+v", antMsg.Usage)
	}
	upMu.Lock()
	if antBodies[0]["system"].(string) != "AntSys" {
		t.Fatalf("expected plain string system when autoCreateCache=false")
	}
	if _, isArr := antBodies[1]["system"].([]any); !isArr {
		t.Fatalf("expected array cache_control system when autoCreateCache=true")
	}
	upMu.Unlock()

	// 2. OpenAI Chat & Responses: default implicit vs persisted explicit compat.
	cOai := newConv(pOaiResp.Provider.ID, "gpt-implicit", "OaiSys")
	_, _ = streamForward(cOai, pOaiResp.Provider.ID, "gpt-implicit", "imp", true)
	_, oaiMsg := streamForward(cOai, pOaiResp.Provider.ID, "gpt-explicit", "exp", true)
	if oaiMsg.Usage == nil || oaiMsg.Usage.CacheReadInputTokens != 70 || oaiMsg.Usage.CacheCreationInputTokens != 20 {
		t.Fatalf("unexpected openai chat usage: %+v", oaiMsg.Usage)
	}
	_, _ = streamForward(cOai, pOaiResp.Provider.ID, "resp-implicit", "r-imp", true)
	_, respMsg := streamForward(cOai, pOaiResp.Provider.ID, "resp-explicit", "r-exp", true)
	if respMsg.Usage == nil || respMsg.Usage.CacheReadInputTokens != 60 || respMsg.Usage.CacheCreationInputTokens != 10 {
		t.Fatalf("unexpected openai responses usage: %+v", respMsg.Usage)
	}
	upMu.Lock()
	if oaiChatBodies[0]["prompt_cache_options"] != nil || oaiChatBodies[1]["prompt_cache_options"] == nil {
		t.Fatalf("openai chat implicit vs explicit mismatch: %+v", oaiChatBodies)
	}
	if oaiRespBodies[0]["prompt_cache_options"] != nil || oaiRespBodies[1]["prompt_cache_options"] == nil {
		t.Fatalf("openai responses implicit vs explicit mismatch: %+v", oaiRespBodies)
	}
	upMu.Unlock()

	// 3. Gemini server-forward: create once -> reuse -> error separation (401/429 fail, 400/404 degrade).
	cGem := newConv(pGemResp.Provider.ID, "gemini-2.5-pro", "GemSys")
	_, _ = streamForward(cGem, pGemResp.Provider.ID, "gemini-2.5-pro", "t1", false) // off
	upMu.Lock()
	if gemCreates != 0 {
		t.Fatalf("autoCreateCache=false must not create cache")
	}
	upMu.Unlock()
	_, _ = streamForward(cGem, pGemResp.Provider.ID, "gemini-2.5-pro", "t2", true)
	_, _ = streamForward(cGem, pGemResp.Provider.ID, "gemini-2.5-pro", "t3", true)
	upMu.Lock()
	if gemCreates != 1 {
		t.Fatalf("expected 1 Gemini create across 2 turns, got %d", gemCreates)
	}
	upMu.Unlock()

	// Auth (401) and RateLimit (429) must fail visibly, not fallback!
	for _, errMode := range []string{"auth", "ratelimit"} {
		upMu.Lock()
		gemMode = errMode
		genBefore := gemGenerates
		upMu.Unlock()
		var pTmp struct{ Provider domain.ProviderConfig }
		callGW(gwA.URL, http.MethodPost, "/api/v1/providers", map[string]any{
			"name": "Gem-" + errMode, "adapter": "generic-http", "baseURL": upstream.URL + "/v1beta", "authType": "query-key", "apiKey": "gk-" + errMode,
			"models": []map[string]any{{"id": "gemini-2.5-pro", "name": "Gem", "apiFormat": "google-generative-ai"}},
		}, &pTmp)
		cTmp := newConv(pTmp.Provider.ID, "gemini-2.5-pro", "Sys")
		code, _ := streamForward(cTmp, pTmp.Provider.ID, "gemini-2.5-pro", "hi", true)
		upMu.Lock()
		genAfter := gemGenerates
		upMu.Unlock()
		if code == http.StatusOK || genAfter != genBefore {
			t.Fatalf("mode %s must fail before main generate: status=%d gen=%d->%d", errMode, code, genBefore, genAfter)
		}
	}
	upMu.Lock()
	gemMode = "normal"
	upMu.Unlock()

	// 4. Enable MCP server -> 2-round multi-tool + Gemini explicit caching + mid-loop expiry (no tool replay!).
	callGW(gwA.URL, http.MethodPut, "/api/v1/mcp/servers/"+mcpCreated.Server.ID, map[string]any{
		"name": "Cache MCP", "transport": domain.MCPTransportStreamableHTTP, "endpoint": mcpSrv.URL, "enabled": true,
	}, nil)

	cMCP := newConv(pGemResp.Provider.ID, "gemini-2.5-pro", "MCPSys")
	upMu.Lock()
	createsBeforeMCP := gemCreates
	upMu.Unlock()
	code, mcpEndMsg := streamForward(cMCP, pGemResp.Provider.ID, "gemini-2.5-pro", "run tools", true)
	if code != http.StatusOK || mcpEndMsg.ID == "" {
		t.Fatalf("MCP+cache stream failed: code=%d msg=%+v", code, mcpEndMsg)
	}
	mcpMu.Lock()
	callsAfterFirst := mcpToolCalls
	mcpMu.Unlock()
	upMu.Lock()
	createsAfterMCP := gemCreates
	upMu.Unlock()
	if callsAfterFirst != 2 {
		t.Fatalf("expected 2 MCP tool executions across 2 rounds, got %d", callsAfterFirst)
	}
	if createsAfterMCP != createsBeforeMCP+1 {
		t.Fatalf("expected exactly 1 cache create across all 3 Gemini rounds, got %d", createsAfterMCP-createsBeforeMCP)
	}
	if mcpEndMsg.Usage == nil || mcpEndMsg.Usage.CacheReadInputTokens != 450 {
		t.Fatalf("expected summed CacheReadInputTokens=450 (150*3), got %+v", mcpEndMsg.Usage)
	}

	// Change MCP tool schema -> invalidates cache and creates a new one!
	mcpMu.Lock()
	includeExtraArg = true
	mcpMu.Unlock()
	_ = rt.CloseServer(mcpCreated.Server.ID) // clear cached tool list on runtime so updated schema is discovered
	code, _ = streamForward(cMCP, pGemResp.Provider.ID, "gemini-2.5-pro", "after schema change", true)
	if code != http.StatusOK {
		t.Fatalf("after schema change status = %d", code)
	}
	upMu.Lock()
	createsAfterSchema := gemCreates
	upMu.Unlock()
	if createsAfterSchema != createsAfterMCP+1 {
		t.Fatalf("expected tool schema change to create new cache, got %d vs %d", createsAfterSchema, createsAfterMCP)
	}

	// Mid-loop Gemini cachedContent expiry (404 on round 2) degrades cleanly without replaying MCP tool 1.
	cMCPExp := newConv(pGemResp.Provider.ID, "gemini-2.5-pro", "MCPSysExp")
	mcpMu.Lock()
	callsBeforeExp := mcpToolCalls
	mcpMu.Unlock()
	upMu.Lock()
	gemMode = "expire_on_fnresp1"
	upMu.Unlock()
	code, expMsg := streamForward(cMCPExp, pGemResp.Provider.ID, "gemini-2.5-pro", "expire mid loop", true)
	if code != http.StatusOK || expMsg.ID == "" {
		t.Fatalf("mid-loop expiry MCP stream failed: code=%d msg=%+v", code, expMsg)
	}
	mcpMu.Lock()
	callsAfterExp := mcpToolCalls
	mcpMu.Unlock()
	if callsAfterExp-callsBeforeExp != 2 {
		t.Fatalf("expected exactly 2 MCP executions (no replay on round 2 expiry), got %d", callsAfterExp-callsBeforeExp)
	}

	// 5. Stateless localRequest Gemini + webSearch across two independent gateways (gwA -> gwB):
	//    search hits once, cache creates once, user persists once.
	cLocal := newConv(pGemLocalResp.Provider.ID, "gemini-2.5-pro", "LocalSys")
	searchHits.Store(0)
	upMu.Lock()
	createsBeforeLocal := gemCreates
	upMu.Unlock()

	var prep1 service.PreparedLocalRequest
	if c := callGW(gwA.URL, http.MethodPost, "/api/v1/conversations/"+cLocal+"/messages/prepare-local", map[string]any{
		"text":            "local cached search",
		"webSearch":       true,
		"autoCreateCache": true,
	}, &prep1); c != http.StatusOK || prep1.CacheStep == nil || prep1.WebSearchBlock == nil {
		t.Fatalf("gwA prepare-local 1 unexpected: status=%d prep=%+v", c, prep1)
	}
	// Browser executes CacheStep directly against upstream with local key.
	cReq, _ := http.NewRequest(prep1.CacheStep.Request.Method, prep1.CacheStep.Request.URL+"?key=browser-local-key", bytes.NewReader(prep1.CacheStep.Request.Body))
	cReq.Header.Set("Content-Type", "application/json")
	cResp, err := http.DefaultClient.Do(cReq)
	if err != nil {
		t.Fatalf("browser cache create failed: %v", err)
	}
	var cParsed struct {
		Name       string `json:"name"`
		ExpireTime string `json:"expireTime"`
	}
	_ = json.NewDecoder(cResp.Body).Decode(&cParsed)
	_ = cResp.Body.Close()

	// Call gwB (completely separate ChatService instance!) with preparedSearch + cacheResolution.
	var prep2 service.PreparedLocalRequest
	if c := callGW(gwB.URL, http.MethodPost, "/api/v1/conversations/"+cLocal+"/messages/prepare-local", map[string]any{
		"text":            "local cached search",
		"webSearch":       true,
		"autoCreateCache": true,
		"preparedSearch":  map[string]any{"block": prep1.WebSearchBlock},
		"cacheResolution": map[string]any{
			"planKey": prep1.CacheStep.PlanKey,
			"status":  cResp.StatusCode,
			"result": map[string]any{
				"name":       cParsed.Name,
				"expireTime": cParsed.ExpireTime,
			},
		},
	}, &prep2); c != http.StatusOK || prep2.CacheStep != nil || prep2.CacheState == nil {
		t.Fatalf("gwB prepare-local 2 unexpected: status=%d prep=%+v", c, prep2)
	}
	if searchHits.Load() != 1 {
		t.Fatalf("expected exactly 1 web search across stateless prepare-local steps, got %d", searchHits.Load())
	}
	upMu.Lock()
	if gemCreates != createsBeforeLocal+1 {
		t.Fatalf("expected 1 local cache create, got %d", gemCreates-createsBeforeLocal)
	}
	upMu.Unlock()
}
