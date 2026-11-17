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
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/mcp"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

type matrixEnv struct {
	gw        *httptest.Server
	token     string
	msgStore  *store.MessageStore
	mcpStore  *store.MCPServerStore
	provStore *store.ProviderStore
	mcpClient plugin.MCPClientBoundary
}

func newMCPMatrixEnv(t *testing.T, customMCP plugin.MCPClientBoundary) *matrixEnv {
	t.Helper()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "mcp_matrix.db")
	db, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	provStore := store.NewProviderStore(db)
	assistStore := store.NewAssistantStore(db)
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

	mcpClient := customMCP
	if mcpClient == nil {
		rt := mcp.NewRuntime()
		t.Cleanup(func() { _ = rt.Close() })
		mcpClient = rt
	}

	const gwToken = "matrix-gw-token"
	router := httpapi.NewRouter(httpapi.RouterDeps{
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
		PluginService:       service.NewPluginService(searchReg, searchStore, mcpStore).WithMCPClient(mcpClient),
		ChatService: service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
			WithAssistants(assistStore).
			WithSearch(searchReg, searchStore).
			WithMCP(mcpStore, mcpClient),
	})
	gw := httptest.NewServer(router)
	t.Cleanup(gw.Close)

	return &matrixEnv{
		gw:        gw,
		token:     gwToken,
		msgStore:  msgStore,
		mcpStore:  mcpStore,
		provStore: provStore,
		mcpClient: mcpClient,
	}
}

func TestMCPThreeRealTransportsEndToEnd(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}

	// 1. Real Streamable HTTP stateful MCP server.
	httpCartCount := 0
	httpMCPSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "real-http-sess-1")
		if len(req.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		switch req.Method {
		case "initialize":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"protocolVersion": "2025-11-25",
					"capabilities":    map[string]any{"tools": map[string]any{}},
				},
			})
		case "tools/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"tools": []plugin.MCPToolDescriptor{
						{Name: "cart_add", Description: "Add item to stateful cart", InputSchema: json.RawMessage(`{"type":"object"}`)},
					},
				},
			})
		case "tools/call":
			if r.Header.Get("Mcp-Session-Id") != "real-http-sess-1" {
				http.Error(w, "missing session id", http.StatusBadRequest)
				return
			}
			httpCartCount++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": plugin.MCPCallToolResult{
					Content:           []plugin.MCPToolContent{{Type: "text", Text: fmt.Sprintf("cart=%d", httpCartCount)}},
					StructuredContent: json.RawMessage(fmt.Sprintf(`{"cartCount":%d}`, httpCartCount)),
				},
			})
		}
	}))
	defer httpMCPSrv.Close()

	// 2. Real Legacy SSE MCP server (with same-name tool "lookup"!).
	var sseMu sync.Mutex
	var sseCh chan string
	legacySSESrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sse" {
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)
			sseMu.Lock()
			sseCh = make(chan string, 8)
			ch := sseCh
			sseMu.Unlock()
			_, _ = fmt.Fprint(w, "event: endpoint\ndata: /msg\n\n")
			flusher.Flush()
			for {
				select {
				case msg := <-ch:
					_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
					flusher.Flush()
				case <-r.Context().Done():
					return
				}
			}
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if len(req.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		var payload []byte
		switch req.Method {
		case "initialize":
			payload, _ = json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"protocolVersion": "2024-11-05",
					"capabilities":    map[string]any{"tools": map[string]any{}},
				},
			})
		case "tools/list":
			payload, _ = json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"tools": []plugin.MCPToolDescriptor{
						{Name: "lookup", Description: "Legacy SSE lookup", InputSchema: json.RawMessage(`{"type":"object"}`)},
					},
				},
			})
		case "tools/call":
			payload, _ = json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": plugin.MCPCallToolResult{
					Content: []plugin.MCPToolContent{{Type: "text", Text: "sse-lookup-hit"}},
				},
			})
		}
		sseMu.Lock()
		ch := sseCh
		sseMu.Unlock()
		ch <- string(payload)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer func() {
		legacySSESrv.CloseClientConnections()
		legacySSESrv.Close()
	}()

	// Create env after httptest servers so t.Cleanup closes MCP runtime BEFORE servers wait on idle connections.
	env := newMCPMatrixEnv(t, nil)
	defer env.mcpClient.Close()

	// Seed 3 MCP servers (stdio + sse + streamable-http) via HTTP API.
	seedMCP := func(body map[string]any) string {
		r := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/mcp/servers", env.token, body)
		defer r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create mcp server status=%d", r.StatusCode)
		}
		var res struct {
			Server domain.MCPServerConfig `json:"server"`
		}
		_ = json.NewDecoder(r.Body).Decode(&res)
		return res.Server.ID
	}

	stdioID := seedMCP(map[string]any{
		"name":      "real-stdio",
		"transport": domain.MCPTransportStdio,
		"command":   exe,
		"args":      []string{"-test.run=^TestMCPIntegrationHelperProcess$"},
		"env":       map[string]string{"LLMSTUDIO_INTEGRATION_MCP_HELPER": "1"},
		"enabled":   true,
	})
	sseID := seedMCP(map[string]any{
		"name":      "real-sse",
		"transport": domain.MCPTransportSSE,
		"endpoint":  legacySSESrv.URL + "/sse",
		"enabled":   true,
	})
	httpID := seedMCP(map[string]any{
		"name":      "real-http",
		"transport": domain.MCPTransportStreamableHTTP,
		"endpoint":  httpMCPSrv.URL,
		"enabled":   true,
	})

	// Probe all 3 real transports through HTTP /test.
	for _, id := range []string{stdioID, sseID, httpID} {
		probeResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/mcp/servers/"+id+"/test", env.token, map[string]any{})
		var probe service.MCPServerTestResult
		_ = json.NewDecoder(probeResp.Body).Decode(&probe)
		probeResp.Body.Close()
		if probeResp.StatusCode != http.StatusOK || !probe.OK || probe.ToolCount == 0 {
			t.Fatalf("probe failed for %s: status=%d probe=%+v", id, probeResp.StatusCode, probe)
		}
	}

	// Mock LLM exercising stateful stdio + sse + streamable-http across 2 tool rounds -> final answer.
	turn := 0
	var seenToolOutputs []string
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		turn++
		w.Header().Set("Content-Type", "text/event-stream")
		tools := body["tools"].([]any)
		aliasByPrefix := func(prefix string) string {
			for _, item := range tools {
				fn := item.(map[string]any)["function"].(map[string]any)
				name := fn["name"].(string)
				desc, _ := fn["description"].(string)
				if strings.Contains(desc, prefix) || strings.HasPrefix(name, prefix) {
					return name
				}
			}
			t.Fatalf("tool matching %q not declared in %+v", prefix, tools)
			return ""
		}

		switch turn {
		case 1:
			stdioLookup := aliasByPrefix("Stdio lookup")
			sseLookup := aliasByPrefix("Legacy SSE lookup")
			httpCart := aliasByPrefix("cart_add")
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"r1_stdio\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"r1_sse\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}},{\"index\":2,\"id\":\"r1_http\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}}]}}]}\n\n", stdioLookup, sseLookup, httpCart)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		case 2:
			stdioCounter := aliasByPrefix("stdio_counter")
			httpCart := aliasByPrefix("cart_add")
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"r2_stdio\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"n\\\":4}\"}},{\"index\":1,\"id\":\"r2_http\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}}]}}]}\n\n", stdioCounter, httpCart)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":6,\"total_tokens\":26}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		default:
			for _, m := range body["messages"].([]any) {
				mm := m.(map[string]any)
				if mm["role"] == "tool" {
					seenToolOutputs = append(seenToolOutputs, fmt.Sprint(mm["content"]))
				}
			}
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"All 3 transports succeeded\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":9,\"total_tokens\":39}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		}
	}))
	defer llmSrv.Close()

	provResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/providers", env.token, map[string]any{
		"name":     "Matrix Forward",
		"adapter":  "generic-http",
		"baseURL":  llmSrv.URL,
		"authType": "bearer",
		"apiKey":   "sk-fwd",
		"models":   []map[string]any{{"id": "gpt-m", "name": "GPT M", "apiFormat": "openai-completions"}},
	})
	var pWrap struct{ Provider domain.ProviderConfig `json:"provider"` }
	_ = json.NewDecoder(provResp.Body).Decode(&pWrap)
	provResp.Body.Close()

	convResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations", env.token, map[string]any{
		"assistantId": "default",
		"providerId":  pWrap.Provider.ID,
		"modelId":     "gpt-m",
	})
	var cWrap struct{ Conversation domain.Conversation `json:"conversation"` }
	_ = json.NewDecoder(convResp.Body).Decode(&cWrap)
	convResp.Body.Close()

	events := openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+cWrap.Conversation.ID+"/messages/stream", env.token, map[string]any{
		"text": "Run all 3 MCP transports",
	})
	var msgStarts, msgEnds int
	var finalMsg *domain.Message
	for _, ev := range events {
		if ev.Type == domain.StreamEventMessageStart {
			msgStarts++
		}
		if ev.Type == domain.StreamEventMessageEnd {
			msgEnds++
			finalMsg = ev.Message
		}
	}
	if msgStarts != 1 || msgEnds != 1 || finalMsg == nil {
		t.Fatalf("expected 1 start & 1 end, got %d/%d", msgStarts, msgEnds)
	}
	if finalMsg.Usage == nil || finalMsg.Usage.TotalTokens != 80 {
		t.Fatalf("expected 3-round summed totalTokens=80, got %+v", finalMsg.Usage)
	}
	if httpCartCount != 2 {
		t.Fatalf("expected Streamable HTTP session reused for cart_count=2, got %d", httpCartCount)
	}
	joinedOutputs := strings.Join(seenToolOutputs, " | ")
	if !strings.Contains(joinedOutputs, "stdio-lookup-hit") || !strings.Contains(joinedOutputs, "sse-lookup-hit") || !strings.Contains(joinedOutputs, "stdio-count=4") || !strings.Contains(joinedOutputs, "cart=2") {
		t.Fatalf("missing expected stateful outputs across 3 transports: %q", joinedOutputs)
	}

	// Verify DB holds 1 user + 1 assistant message cleanly.
	detailResp := apiDo(t, http.MethodGet, env.gw.URL+"/api/v1/conversations/"+cWrap.Conversation.ID, env.token, nil)
	var detail service.ConversationDetail
	_ = json.NewDecoder(detailResp.Body).Decode(&detail)
	detailResp.Body.Close()
	if len(detail.Messages) != 2 {
		t.Fatalf("expected 2 DB messages, got %d", len(detail.Messages))
	}
}

type deterministicMatrixMCP struct {
	mu      sync.Mutex
	enabled map[string]bool
	calls   []string
	counter map[string]int
}

func (m *deterministicMatrixMCP) ID() string { return "deterministic-matrix-mcp" }

func (m *deterministicMatrixMCP) ListTools(_ context.Context, srv domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	switch srv.ID {
	case "mem-a":
		return []plugin.MCPToolDescriptor{
			{Name: "fetch", Description: "Fetch A", InputSchema: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}}}`)},
			{Name: "commit_step", Description: "Commit stateful", InputSchema: json.RawMessage(`{"type":"object"}`)},
		}, nil
	case "mem-b":
		return []plugin.MCPToolDescriptor{
			{Name: "fetch", Description: "Fetch B", InputSchema: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}}}`)},
		}, nil
	default:
		return []plugin.MCPToolDescriptor{}, nil
	}
}

func (m *deterministicMatrixMCP) CallTool(_ context.Context, srv domain.MCPServerConfig, name string, args json.RawMessage) (plugin.MCPCallToolResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, srv.ID+":"+name)
	if name == "commit_step" {
		m.counter[srv.ID]++
		if strings.Contains(string(args), `"fail":true`) {
			return plugin.MCPCallToolResult{
				Content: []plugin.MCPToolContent{{Type: "text", Text: "soft-tool-error"}},
				IsError: true,
			}, nil
		}
		return plugin.MCPCallToolResult{
			Content: []plugin.MCPToolContent{{Type: "text", Text: fmt.Sprintf("step=%d", m.counter[srv.ID])}},
		}, nil
	}
	return plugin.MCPCallToolResult{
		Content: []plugin.MCPToolContent{{Type: "text", Text: srv.ID + "-hit"}},
	}, nil
}

func (m *deterministicMatrixMCP) CloseServer(string) error { return nil }
func (m *deterministicMatrixMCP) Close() error             { return nil }

func TestMCPFourFormatsForwardAndLocalRequestMatrix(t *testing.T) {
	memMCP := &deterministicMatrixMCP{
		enabled: map[string]bool{"mem-a": true, "mem-b": true},
		counter: make(map[string]int),
	}
	env := newMCPMatrixEnv(t, memMCP)
	ctx := context.Background()

	_, _ = env.mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "mem-a", Name: "Mem A", Transport: domain.MCPTransportStdio, Command: "mem", Enabled: true,
	})
	_, _ = env.mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "mem-b", Name: "Mem B", Transport: domain.MCPTransportStdio, Command: "mem", Enabled: true,
	})

	// Compute deterministic aliases directly matching server bindings.
	aliasFetchA := plugin.BuildChatToolAlias("mem-a", "fetch", nil)
	aliasCommitA := plugin.BuildChatToolAlias("mem-a", "commit_step", nil)
	aliasFetchB := plugin.BuildChatToolAlias("mem-b", "fetch", nil)

	var (
		upMu       sync.Mutex
		upTurns    = make(map[string]int)
		upAuthSeen []string
		upBodies   = make(map[string][]map[string]any)
	)

	upSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upMu.Lock()
		if auth := r.Header.Get("Authorization"); auth != "" {
			upAuthSeen = append(upAuthSeen, auth)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		// Key turn counter by request header X-Cell-Key or path+model for parallel isolation.
		cellKey := r.URL.Path + ":" + fmt.Sprint(body["model"])
		upTurns[cellKey]++
		turn := upTurns[cellKey]
		upBodies[cellKey] = append(upBodies[cellKey], body)
		upMu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")

		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			switch turn {
			case 1:
				_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"oai_1\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"id\\\":\\\"a\\\"}\"}},{\"index\":1,\"id\":\"oai_2\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"id\\\":\\\"b\\\"}\"}}]}}]}\n\n", aliasFetchA, aliasFetchB)
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n")
				_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			case 2:
				_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"oai_3\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"fail\\\":true}\"}}]}}]}\n\n", aliasCommitA)
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":15,\"completion_tokens\":5,\"total_tokens\":20}}\n\n")
				_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			default:
				_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok-completions-t%d\"}}]}\n\n", turn)
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":25,\"completion_tokens\":10,\"total_tokens\":35}}\n\n")
				_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			}

		case strings.HasSuffix(r.URL.Path, "/responses"):
			switch turn {
			case 1:
				_, _ = fmt.Fprintf(w, "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_a\",\"type\":\"function_call\",\"call_id\":\"resp_1\",\"name\":%q}}\n\n", aliasFetchA)
				_, _ = fmt.Fprint(w, "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{}\"}\n\n")
				_, _ = fmt.Fprint(w, "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0}\n\n")
				_, _ = fmt.Fprintf(w, "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_b\",\"type\":\"function_call\",\"call_id\":\"resp_2\",\"name\":%q}}\n\n", aliasFetchB)
				_, _ = fmt.Fprint(w, "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{}\"}\n\n")
				_, _ = fmt.Fprint(w, "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":1}\n\n")
				_, _ = fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n")
			case 2:
				_, _ = fmt.Fprintf(w, "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_c\",\"type\":\"function_call\",\"call_id\":\"resp_3\",\"name\":%q}}\n\n", aliasCommitA)
				_, _ = fmt.Fprint(w, "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"arguments\":\"{\\\"fail\\\":false}\"}}\n\n")
				_, _ = fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":15,\"output_tokens\":5,\"total_tokens\":20}}}\n\n")
			default:
				_, _ = fmt.Fprint(w, "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_1\",\"type\":\"message\"}}\n\n")
				_, _ = fmt.Fprintf(w, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"ok-responses-t%d\"}\n\n", turn)
				_, _ = fmt.Fprint(w, "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0}\n\n")
				_, _ = fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":25,\"output_tokens\":10,\"total_tokens\":35}}}\n\n")
			}

		case strings.HasSuffix(r.URL.Path, "/messages"):
			switch turn {
			case 1:
				_, _ = fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\n")
				_, _ = fmt.Fprintf(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"ant_1\",\"name\":%q}}\n\n", aliasFetchA)
				_, _ = fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
				_, _ = fmt.Fprintf(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"ant_2\",\"name\":%q}}\n\n", aliasFetchB)
				_, _ = fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n")
				_, _ = fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n")
				_, _ = fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			case 2:
				_, _ = fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":15,\"output_tokens\":0}}}\n\n")
				_, _ = fmt.Fprintf(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"ant_3\",\"name\":%q}}\n\n", aliasCommitA)
				_, _ = fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
				_, _ = fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n")
				_, _ = fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			default:
				_, _ = fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"output_tokens\":0}}}\n\n")
				_, _ = fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n")
				_, _ = fmt.Fprintf(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok-anthropic-t%d\"}}\n\n", turn)
				_, _ = fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
				_, _ = fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":10}}\n\n")
				_, _ = fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			}

		case strings.Contains(r.URL.Path, ":streamGenerateContent"):
			switch turn {
			case 1:
				_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"g-plan\",\"thought\":true,\"thoughtSignature\":\"gsig-1\"},{\"functionCall\":{\"id\":\"gem_1\",\"name\":%q,\"args\":{}},\"thoughtSignature\":\"gsig-fc1\"},{\"functionCall\":{\"id\":\"gem_2\",\"name\":%q,\"args\":{}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5,\"totalTokenCount\":15}}\n\n", aliasFetchA, aliasFetchB)
			case 2:
				_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":%q,\"args\":{}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":15,\"candidatesTokenCount\":5,\"totalTokenCount\":20}}\n\n", aliasCommitA)
			default:
				_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok-gemini-t%d\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":25,\"candidatesTokenCount\":10,\"totalTokenCount\":35}}\n\n", turn)
			}
		}
	}))
	defer upSrv.Close()

	formatsList := []struct {
		name      string
		apiFormat string
		modelBase string
	}{
		{"comp", format.FormatIDOpenAICompletions, "m-comp"},
		{"resp", format.FormatIDOpenAIResponses, "m-resp"},
		{"anth", format.FormatIDAnthropicMessages, "m-anth"},
		{"gem", format.FormatIDGoogleGenAI, "m-gem"},
	}

	// Create forward provider and localRequest provider.
	createProv := func(id string, localReq bool) {
		var models []map[string]any
		for _, fc := range formatsList {
			suffix := "fwd"
			if localReq {
				suffix = "loc"
			}
			models = append(models, map[string]any{
				"id":        fc.modelBase + "-" + suffix,
				"name":      fc.name,
				"apiFormat": fc.apiFormat,
			})
		}
		body := map[string]any{
			"id":           id,
			"name":         id,
			"adapter":      "generic-http",
			"baseURL":      upSrv.URL,
			"authType":     "bearer",
			"localRequest": localReq,
			"models":       models,
		}
		if !localReq {
			body["apiKey"] = "sk-server-only"
		}
		resp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/providers", env.token, body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create prov %s status=%d", id, resp.StatusCode)
		}
	}
	createProv("prov-fwd", false)
	createProv("prov-loc", true)

	// Load plugin format decoders to exercise browser-side direct execution accurately in Go integration.
	reg := plugin.NewFormatRegistry()
	reg.MustRegister(format.NewOpenAICompletionsFormat())
	reg.MustRegister(format.NewOpenAIResponsesFormat())
	reg.MustRegister(format.NewAnthropicMessagesFormat())
	reg.MustRegister(format.NewGoogleGenAIFormat())

	for _, fc := range formatsList {
		// 1. Forward cell
		t.Run("forward/"+fc.name, func(t *testing.T) {
			memMCP.calls = nil
			modelID := fc.modelBase + "-fwd"
			convResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations", env.token, map[string]any{
				"assistantId": "default",
				"providerId":  "prov-fwd",
				"modelId":     modelID,
			})
			var cWrap struct{ Conversation domain.Conversation `json:"conversation"` }
			_ = json.NewDecoder(convResp.Body).Decode(&cWrap)
			convResp.Body.Close()

			events := openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+cWrap.Conversation.ID+"/messages/stream", env.token, map[string]any{
				"text": "matrix forward " + fc.name,
			})
			var finalMsg *domain.Message
			var starts, ends int
			for _, ev := range events {
				if ev.Type == domain.StreamEventMessageStart {
					starts++
				}
				if ev.Type == domain.StreamEventMessageEnd {
					ends++
					finalMsg = ev.Message
				}
			}
			if starts != 1 || ends != 1 || finalMsg == nil {
				t.Fatalf("expected 1 start/end, got %d/%d", starts, ends)
			}
			if finalMsg.Usage == nil || finalMsg.Usage.TotalTokens != 70 {
				t.Fatalf("expected summed 3-round tokens=70, got %+v", finalMsg.Usage)
			}
			if len(memMCP.calls) != 3 {
				t.Fatalf("expected 3 MCP calls across 2 tool rounds, got %v", memMCP.calls)
			}

			// Follow-up turn + branch verification
			follow := openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+cWrap.Conversation.ID+"/messages/stream", env.token, map[string]any{
				"text": "follow up",
			})
			if len(follow) == 0 {
				t.Fatalf("follow up empty")
			}
			branchResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations/"+cWrap.Conversation.ID+"/messages/"+finalMsg.ID+"/branch", env.token, map[string]any{})
			var branched service.ConversationDetail
			_ = json.NewDecoder(branchResp.Body).Decode(&branched)
			branchResp.Body.Close()
			if branchResp.StatusCode != http.StatusCreated || len(branched.Messages) != 2 {
				t.Fatalf("branch expected 2 msgs, got status=%d len=%d", branchResp.StatusCode, len(branched.Messages))
			}
		})

		// 2. LocalRequest cell (browser client orchestrating prepare-local + direct upstream + /tools/execute + localContinuation + createMessage)
		t.Run("localRequest/"+fc.name, func(t *testing.T) {
			memMCP.calls = nil
			modelID := fc.modelBase + "-loc"
			apiFmt, _ := reg.Get(fc.apiFormat)
			convResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations", env.token, map[string]any{
				"assistantId": "default",
				"providerId":  "prov-loc",
				"modelId":     modelID,
			})
			var cWrap struct{ Conversation domain.Conversation `json:"conversation"` }
			_ = json.NewDecoder(convResp.Body).Decode(&cWrap)
			convResp.Body.Close()
			convID := cWrap.Conversation.ID

			// Prepare Round 1
			prep1Resp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations/"+convID+"/messages/prepare-local", env.token, map[string]any{
				"text": "matrix local " + fc.name,
			})
			var prepReq service.PreparedLocalRequest
			_ = json.NewDecoder(prep1Resp.Body).Decode(&prepReq)
			prep1Resp.Body.Close()
			if _, hasAuth := prepReq.Headers["Authorization"]; hasAuth {
				t.Fatalf("gateway unexpectedly injected Authorization on localRequest")
			}

			// Persist user message once accepted
			uSave := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations/"+convID+"/messages", env.token, map[string]any{
				"role":   "user",
				"blocks": []map[string]any{{"type": "text", "text": "matrix local " + fc.name}},
			})
			var uSaved struct{ Message domain.Message `json:"message"` }
			_ = json.NewDecoder(uSave.Body).Decode(&uSaved)
			uSave.Body.Close()

			var allBlocks []domain.ContentBlock
			var totalUsage domain.Usage
			seenCallIDs := map[string]bool{}

			for round := 0; round < 3; round++ {
				req, _ := http.NewRequest(prepReq.Method, prepReq.URL, bytes.NewReader(prepReq.Body))
				for k, v := range prepReq.Headers {
					req.Header.Set(k, v)
				}
				// Client injects browser-only secret key cleanly!
				req.Header.Set("Authorization", "Bearer sk-browser-only-"+fc.name)
				upResp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatalf("direct upstream call round %d: %v", round, err)
				}

				var roundCalls []domain.ContentBlock
				var roundStop string
				if err := apiFmt.DecodeStream(ctx, upResp.Body, func(ev domain.StreamEvent) error {
					if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
						b := *ev.Block
						if b.Type == domain.BlockTypeToolCall {
							if b.ID == "" || seenCallIDs[b.ID] {
								b.ID = fmt.Sprintf("loc_r%d_%d", round+1, len(allBlocks))
							}
							seenCallIDs[b.ID] = true
							roundCalls = append(roundCalls, b)
						}
						allBlocks = append(allBlocks, b)
					}
					if ev.Type == domain.StreamEventMessageDelta {
						if ev.Usage != nil {
							totalUsage.InputTokens += ev.Usage.InputTokens
							totalUsage.OutputTokens += ev.Usage.OutputTokens
							totalUsage.ThinkingTokens += ev.Usage.ThinkingTokens
							totalUsage.TotalTokens += ev.Usage.TotalTokens
						}
						if ev.StopReason != "" {
							roundStop = ev.StopReason
						}
					}
					return nil
				}); err != nil {
					_ = upResp.Body.Close()
					t.Fatalf("decode local round %d: %v", round, err)
				}
				_ = upResp.Body.Close()

				if roundStop != domain.StopReasonToolUse {
					break
				}

				execPayload := make([]map[string]any, 0, len(roundCalls))
				for _, c := range roundCalls {
					execPayload = append(execPayload, map[string]any{
						"id":        c.ID,
						"name":      c.Name,
						"arguments": json.RawMessage(c.Arguments),
					})
				}
				toolEvents := openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+convID+"/tools/execute", env.token, map[string]any{
					"calls": execPayload,
				})
				for _, tev := range toolEvents {
					if tev.Type == domain.StreamEventBlockEnd && tev.Block != nil {
						allBlocks = append(allBlocks, *tev.Block)
					}
				}

				contResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations/"+convID+"/messages/prepare-local", env.token, map[string]any{
					"localContinuation": map[string]any{
						"userMessageId": uSaved.Message.ID,
						"blocks":        allBlocks,
					},
				})
				_ = json.NewDecoder(contResp.Body).Decode(&prepReq)
				contResp.Body.Close()
			}

			// Single assistant message persist
			aSave := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations/"+convID+"/messages", env.token, map[string]any{
				"role":       "assistant",
				"providerId": "prov-loc",
				"modelId":    modelID,
				"blocks":     allBlocks,
				"usage":      totalUsage,
				"stopReason": "stop",
			})
			aSave.Body.Close()
			if aSave.StatusCode != http.StatusCreated {
				t.Fatalf("assistant save failed: %d", aSave.StatusCode)
			}

			detailResp := apiDo(t, http.MethodGet, env.gw.URL+"/api/v1/conversations/"+convID, env.token, nil)
			rawDetail, _ := io.ReadAll(detailResp.Body)
			detailResp.Body.Close()
			if strings.Contains(string(rawDetail), "sk-browser-only") {
				t.Fatalf("browser local key leaked into gateway DB response!")
			}
			var detail service.ConversationDetail
			_ = json.Unmarshal(rawDetail, &detail)
			if len(detail.Messages) != 2 || detail.Messages[1].Usage == nil || detail.Messages[1].Usage.TotalTokens != 70 {
				t.Fatalf("expected 2 DB msgs with summed usage 70, got %+v", detail)
			}
			if len(memMCP.calls) != 3 {
				t.Fatalf("expected 3 MCP calls on localRequest %s, got %v", fc.name, memMCP.calls)
			}
		})
	}

	// Verify browser keys did reach upstream directly on localRequest tests.
	upMu.Lock()
	authSummary := strings.Join(upAuthSeen, ",")
	upMu.Unlock()
	if !strings.Contains(authSummary, "sk-browser-only-gem") || !strings.Contains(authSummary, "sk-browser-only-comp") {
		t.Fatalf("expected browser-only auth headers directly on upstream, saw %s", authSummary)
	}
}

func TestMCPDisableAndIntermediateRetryMatrix(t *testing.T) {
	memMCP := &deterministicMatrixMCP{
		enabled: map[string]bool{"mem-a": true, "mem-b": true},
		counter: make(map[string]int),
	}
	env := newMCPMatrixEnv(t, memMCP)
	ctx := context.Background()

	_, _ = env.mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "mem-a", Name: "Mem A", Transport: domain.MCPTransportStdio, Command: "mem", Enabled: true,
	})
	_, _ = env.mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "mem-b", Name: "Mem B", Transport: domain.MCPTransportStdio, Command: "mem", Enabled: true,
	})

	var (
		mu             sync.Mutex
		seenToolCounts []int
	)
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		toolList, _ := body["tools"].([]any)
		mu.Lock()
		seenToolCounts = append(seenToolCounts, len(toolList))
		mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Retry ok\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer llmSrv.Close()

	provResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/providers", env.token, map[string]any{
		"name": "P", "adapter": "generic-http", "baseURL": llmSrv.URL, "authType": "bearer", "apiKey": "sk",
		"models": []map[string]any{{"id": "m1", "name": "M1", "apiFormat": "openai-completions"}},
	})
	var pWrap struct{ Provider domain.ProviderConfig `json:"provider"` }
	_ = json.NewDecoder(provResp.Body).Decode(&pWrap)
	provResp.Body.Close()

	convResp := apiDo(t, http.MethodPost, env.gw.URL+"/api/v1/conversations", env.token, map[string]any{
		"assistantId": "default", "providerId": pWrap.Provider.ID, "modelId": "m1",
	})
	var cWrap struct{ Conversation domain.Conversation `json:"conversation"` }
	_ = json.NewDecoder(convResp.Body).Decode(&cWrap)
	convResp.Body.Close()
	convID := cWrap.Conversation.ID

	// Turn 1 sees 3 tools (2 on mem-a + 1 on mem-b).
	_ = openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+convID+"/messages/stream", env.token, map[string]any{"text": "First"})
	// Append tail turn.
	_ = openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+convID+"/messages/stream", env.token, map[string]any{"text": "Second"})

	// Disable mem-b -> Turn 3 (intermediate retry of First) sees only 2 tools AND preserves Second+reply tail!
	updResp := apiDo(t, http.MethodPut, env.gw.URL+"/api/v1/mcp/servers/mem-b", env.token, map[string]any{
		"name": "Mem B", "transport": domain.MCPTransportStdio, "command": "mem", "enabled": false,
	})
	updResp.Body.Close()

	detResp := apiDo(t, http.MethodGet, env.gw.URL+"/api/v1/conversations/"+convID, env.token, nil)
	var detBefore service.ConversationDetail
	_ = json.NewDecoder(detResp.Body).Decode(&detBefore)
	detResp.Body.Close()
	if len(detBefore.Messages) != 4 {
		t.Fatalf("expected 4 msgs before intermediate retry, got %d", len(detBefore.Messages))
	}

	_ = openAndCollectSSE(t, env.gw.URL+"/api/v1/conversations/"+convID+"/messages/stream", env.token, map[string]any{
		"regenerateMessageId": detBefore.Messages[1].ID,
	})

	detAfterResp := apiDo(t, http.MethodGet, env.gw.URL+"/api/v1/conversations/"+convID, env.token, nil)
	var detAfter service.ConversationDetail
	_ = json.NewDecoder(detAfterResp.Body).Decode(&detAfter)
	detAfterResp.Body.Close()
	if len(detAfter.Messages) != 4 || detAfter.Messages[2].ID != detBefore.Messages[2].ID || detAfter.Messages[3].ID != detBefore.Messages[3].ID {
		t.Fatalf("intermediate retry must not truncate downstream history: %+v", detAfter.Messages)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seenToolCounts) != 3 || seenToolCounts[0] != 3 || seenToolCounts[2] != 2 {
		t.Fatalf("expected tool count to drop from 3 to 2 after disabling mem-b, saw %v", seenToolCounts)
	}
}

func openAndCollectSSE(t *testing.T, url, token string, body any) []domain.StreamEvent {
	t.Helper()
	resp := apiDo(t, http.MethodPost, url, token, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s status=%d body=%s", url, resp.StatusCode, raw)
	}

	var events []domain.StreamEvent
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var ev domain.StreamEvent
		if err := json.Unmarshal([]byte(payload), &ev); err == nil {
			events = append(events, ev)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("read SSE %s: %v", url, err)
	}
	return events
}

// TestMCPIntegrationHelperProcess runs as child stdio MCP server when LLMSTUDIO_INTEGRATION_MCP_HELPER=1.
func TestMCPIntegrationHelperProcess(t *testing.T) {
	if os.Getenv("LLMSTUDIO_INTEGRATION_MCP_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	write := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = fmt.Fprintf(os.Stdout, "%s\n", b)
	}
	counter := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}
		if len(req.ID) == 0 {
			continue
		}
		switch req.Method {
		case "initialize":
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"protocolVersion": "2025-11-25",
					"capabilities":    map[string]any{"tools": map[string]any{}},
				},
			})
		case "tools/list":
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"tools": []plugin.MCPToolDescriptor{
						{Name: "lookup", Description: "Stdio lookup", InputSchema: json.RawMessage(`{"type":"object"}`)},
						{Name: "stdio_counter", Description: "stdio_counter", InputSchema: json.RawMessage(`{"type":"object","properties":{"n":{"type":"integer"}}}`)},
					},
				},
			})
		case "tools/call":
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &p)
			if p.Name == "stdio_counter" {
				var a struct{ N int `json:"n"` }
				_ = json.Unmarshal(p.Arguments, &a)
				counter += a.N
				write(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(req.ID),
					"result": plugin.MCPCallToolResult{
						Content: []plugin.MCPToolContent{{Type: "text", Text: "stdio-count=" + strconv.Itoa(counter)}},
					},
				})
				continue
			}
			write(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": plugin.MCPCallToolResult{
					Content: []plugin.MCPToolContent{{Type: "text", Text: "stdio-lookup-hit"}},
				},
			})
		}
	}
	time.Sleep(5 * time.Millisecond)
}
