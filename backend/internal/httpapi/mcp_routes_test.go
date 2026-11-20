package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

func TestMCPProbeToolsAuthAndSessionInvalidation(t *testing.T) {
	db, err := store.OpenSQLite(t.Context(), ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()

	searchReg := plugin.NewSearchRegistry()
	searchReg.MustRegister(search.NewTavilyEngine(nil))
	pluginSvc := service.NewPluginService(
		searchReg,
		store.NewSearchConfigStore(db),
		store.NewMCPServerStore(db),
	).WithMCPClient(mcpRuntime)

	router := httpapi.NewRouter(httpapi.RouterDeps{
		Config: config.Config{
			AccessToken: "secret-gateway-token",
			DevMode:     false,
		},
		PluginService: pluginSvc,
	})
	gw := httptest.NewServer(router)
	defer gw.Close()

	// Remote mock MCP Streamable HTTP server with toggleable tools & 401 failure endpoint.
	var emptyTools bool
	var deleteCalls int
	mcpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/unauth" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodDelete {
			deleteCalls++
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "gw-mcp-sess")
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
			tools := []plugin.MCPToolDescriptor{
				{Name: "search_docs", Description: "Search docs", InputSchema: json.RawMessage(`{"type":"object"}`)},
			}
			if emptyTools {
				tools = []plugin.MCPToolDescriptor{}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result":  map[string]any{"tools": tools},
			})
		}
	}))
	defer mcpSrv.Close()

	doReq := func(method, path string, body any, withAuth bool) *http.Response {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req, err := http.NewRequest(method, gw.URL+path, &buf)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if withAuth {
			req.Header.Set("Authorization", "Bearer secret-gateway-token")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("Do(%s %s): %v", method, path, err)
		}
		return resp
	}

	// Create saved MCP server.
	createResp := doReq(http.MethodPost, "/api/v1/mcp/servers", map[string]any{
		"name":      "docs-mcp",
		"transport": domain.MCPTransportStreamableHTTP,
		"endpoint":  mcpSrv.URL + "/ok",
		"enabled":   true,
	}, true)
	defer createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create status=%d", createResp.StatusCode)
	}
	var created struct {
		Server domain.MCPServerConfig `json:"server"`
	}
	_ = json.NewDecoder(createResp.Body).Decode(&created)
	id := created.Server.ID
	if created.Server.DisabledTools == nil || len(created.Server.DisabledTools) != 0 {
		t.Fatalf("expected empty disabledTools, got %#v", created.Server.DisabledTools)
	}
	updateTools := func(body map[string]any, want string) {
		t.Helper()
		resp := doReq(http.MethodPut, "/api/v1/mcp/servers/"+id, body, true)
		defer resp.Body.Close()
		var updated struct{ Server domain.MCPServerConfig }
		if err := json.NewDecoder(resp.Body).Decode(&updated); err != nil || resp.StatusCode != http.StatusOK || updated.Server.DisabledTools == nil || strings.Join(updated.Server.DisabledTools, ",") != want {
			t.Fatalf("PUT server: status=%d tools=%v err=%v", resp.StatusCode, updated.Server.DisabledTools, err)
		}
	}
	updateTools(map[string]any{"disabledTools": []string{"search_docs", "read_doc", "search_docs"}}, "read_doc,search_docs")
	updateTools(map[string]any{"name": "docs-mcp"}, "read_doc,search_docs")

	// Auth protection enforced on /tools and /test.
	if unauthTools := doReq(http.MethodGet, "/api/v1/mcp/servers/"+id+"/tools", nil, false); unauthTools.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without bearer on /tools, got %d", unauthTools.StatusCode)
	} else {
		_ = unauthTools.Body.Close()
	}
	if unauthTest := doReq(http.MethodPost, "/api/v1/mcp/servers/"+id+"/test", nil, false); unauthTest.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without bearer on /test, got %d", unauthTest.StatusCode)
	} else {
		_ = unauthTest.Body.Close()
	}

	// Probe returns 1 tool.
	testResp := doReq(http.MethodPost, "/api/v1/mcp/servers/"+id+"/test", nil, true)
	defer testResp.Body.Close()
	if testResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on test, got %d", testResp.StatusCode)
	}
	var testBody service.MCPServerTestResult
	_ = json.NewDecoder(testResp.Body).Decode(&testBody)
	if !testBody.OK || testBody.ToolCount != 1 || len(testBody.Tools) != 1 || testBody.Tools[0].Name != "search_docs" {
		t.Fatalf("unexpected probe response: %+v", testBody)
	}

	updateTools(map[string]any{"disabledTools": []string{}}, "")

	// Valid empty tool list returns tools: [] and toolCount: 0 cleanly.
	emptyTools = true
	emptyResp := doReq(http.MethodPost, "/api/v1/mcp/servers/"+id+"/test", nil, true)
	defer emptyResp.Body.Close()
	if emptyResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on valid empty test, got %d", emptyResp.StatusCode)
	}
	var rawEmpty map[string]any
	_ = json.NewDecoder(emptyResp.Body).Decode(&rawEmpty)
	arr, ok := rawEmpty["tools"].([]any)
	if !ok || len(arr) != 0 {
		t.Fatalf("expected explicit empty tools JSON array [], got %#v", rawEmpty)
	}

	// Update to 401 endpoint invalidates old session and fails explicitly instead of fake 0 tools.
	updResp := doReq(http.MethodPut, "/api/v1/mcp/servers/"+id, map[string]any{
		"name":      "docs-mcp",
		"transport": domain.MCPTransportStreamableHTTP,
		"endpoint":  mcpSrv.URL + "/unauth",
		"enabled":   true,
	}, true)
	_ = updResp.Body.Close()
	if updResp.StatusCode != http.StatusOK {
		t.Fatalf("update status=%d", updResp.StatusCode)
	}

	failTest := doReq(http.MethodPost, "/api/v1/mcp/servers/"+id+"/test", nil, true)
	defer failTest.Body.Close()
	if failTest.StatusCode == http.StatusOK {
		t.Fatalf("expected 401 upstream probe to fail instead of returning 200")
	}
	var errBody map[string]string
	_ = json.NewDecoder(failTest.Body).Decode(&errBody)
	if !strings.Contains(errBody["message"], "401") {
		t.Fatalf("expected 401 message in error response, got %+v", errBody)
	}

	// Disabling invalidates and rejects /tools and subsequent calls.
	disableResp := doReq(http.MethodPut, "/api/v1/mcp/servers/"+id, map[string]any{
		"name":      "docs-mcp",
		"transport": domain.MCPTransportStreamableHTTP,
		"endpoint":  mcpSrv.URL + "/ok",
		"enabled":   false,
	}, true)
	_ = disableResp.Body.Close()
	toolsDisabled := doReq(http.MethodGet, "/api/v1/mcp/servers/"+id+"/tools", nil, true)
	_ = toolsDisabled.Body.Close()
	if toolsDisabled.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when probing disabled server, got %d", toolsDisabled.StatusCode)
	}

	// Re-enable, open session via /tools, then DELETE must close live MCP session too.
	enableResp := doReq(http.MethodPut, "/api/v1/mcp/servers/"+id, map[string]any{
		"name":      "docs-mcp",
		"transport": domain.MCPTransportStreamableHTTP,
		"endpoint":  mcpSrv.URL + "/ok",
		"enabled":   true,
	}, true)
	_ = enableResp.Body.Close()
	toolsResp := doReq(http.MethodGet, "/api/v1/mcp/servers/"+id+"/tools", nil, true)
	_ = toolsResp.Body.Close()
	if toolsResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on re-enabled /tools, got %d", toolsResp.StatusCode)
	}
	deletesBefore := deleteCalls
	delResp := doReq(http.MethodDelete, "/api/v1/mcp/servers/"+id, nil, true)
	_ = delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 on delete, got %d", delResp.StatusCode)
	}
	if deleteCalls <= deletesBefore {
		t.Fatalf("expected DELETE /api/v1/mcp/servers/{id} to terminate live MCP session")
	}
}

func TestExecuteToolsAndLocalContinuationRoutes(t *testing.T) {
	ctx := t.Context()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()

	// Remote MCP server tracking calls cleanly.
	var mcpCalls []string
	mcpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
						{Name: "get_note", InputSchema: json.RawMessage(`{"type":"object"}`)},
					},
				},
			})
		case "tools/call":
			var p struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &p)
			mcpCalls = append(mcpCalls, p.Name)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": plugin.MCPCallToolResult{
					Content: []plugin.MCPToolContent{{Type: "text", Text: "note-body"}},
				},
			})
		}
	}))
	defer mcpSrv.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	mcpStore := store.NewMCPServerStore(db)

	_, err = provStore.Create(ctx, domain.ProviderConfig{
		ID:           "loc-p",
		Name:         "Local Provider",
		Adapter:      provider.AdapterGenericHTTP,
		BaseURL:      "http://browser-local.example/v1",
		AuthType:     domain.AuthTypeBearer,
		LocalRequest: true,
		Enabled:      true,
		Models:       []domain.ModelConfig{{ID: "qwen", Name: "Qwen", APIFormat: format.FormatIDOpenAICompletions}},
	})
	if err != nil {
		t.Fatalf("Create provider: %v", err)
	}
	conv1, _ := convStore.Create(ctx, domain.Conversation{
		ID: "conv-1", AssistantID: domain.DefaultAssistantID, ProviderID: "loc-p", ModelID: "qwen",
	})
	conv2, _ := convStore.Create(ctx, domain.Conversation{
		ID: "conv-2", AssistantID: domain.DefaultAssistantID, ProviderID: "loc-p", ModelID: "qwen",
	})
	userMsg, _ := msgStore.Create(ctx, domain.Message{
		ConversationID: conv1.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Find my note"}},
	})
	_, _ = msgStore.Create(ctx, domain.Message{
		ConversationID: conv2.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Other conv user"}},
	})

	_, _ = mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "mcp-1", Name: "mcp-1", Transport: domain.MCPTransportStreamableHTTP, Endpoint: mcpSrv.URL, Enabled: true,
	})

	chatSvc := service.NewChatService(provStore, convStore, msgStore, formats, adapters, http.DefaultClient).
		WithMCP(mcpStore, mcpRuntime)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Config:      config.Config{AccessToken: "gw-tok", DevMode: false},
		ChatService: chatSvc,
	})
	gw := httptest.NewServer(router)
	defer gw.Close()

	doAuthPost := func(path string, body any) *http.Response {
		var buf bytes.Buffer
		_ = json.NewEncoder(&buf).Encode(body)
		req, _ := http.NewRequest(http.MethodPost, gw.URL+path, &buf)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer gw-tok")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		return resp
	}

	// 1. Discover declared alias via prepare-local round 1.
	prepResp := doAuthPost("/api/v1/conversations/"+conv1.ID+"/messages/prepare-local", map[string]any{
		"providerId": "loc-p",
		"modelId":    "qwen",
		"text":       "Find my note",
	})
	defer prepResp.Body.Close()
	if prepResp.StatusCode != http.StatusOK {
		t.Fatalf("prepare-local status=%d", prepResp.StatusCode)
	}
	var prep1 struct {
		Body map[string]any `json:"body"`
	}
	_ = json.NewDecoder(prepResp.Body).Decode(&prep1)
	alias := prep1.Body["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)["name"].(string)

	// 2. Execute enabled alias + unknown alias via /tools/execute -> SSE block events.
	unauthExec, _ := http.Post(gw.URL+"/api/v1/conversations/"+conv1.ID+"/tools/execute", "application/json", strings.NewReader(`{"calls":[{"id":"c1","name":"`+alias+`","arguments":{}}]}`))
	if unauthExec.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on unauth /tools/execute, got %d", unauthExec.StatusCode)
	}
	_ = unauthExec.Body.Close()

	execResp := doAuthPost("/api/v1/conversations/"+conv1.ID+"/tools/execute", map[string]any{
		"calls": []map[string]any{
			{"id": "c1", "name": alias, "arguments": map[string]any{}},
			{"id": "c2", "name": "evil_unknown_tool", "arguments": map[string]any{}},
		},
	})
	defer execResp.Body.Close()
	if execResp.StatusCode != http.StatusOK {
		t.Fatalf("tools/execute status=%d", execResp.StatusCode)
	}
	var execBody bytes.Buffer
	_, _ = execBody.ReadFrom(execResp.Body)
	execStr := execBody.String()
	if !strings.Contains(execStr, "note-body") || !strings.Contains(execStr, "unknown or disabled tool") {
		t.Fatalf("unexpected tools/execute SSE stream: %s", execStr)
	}
	if len(mcpCalls) != 1 || mcpCalls[0] != "get_note" {
		t.Fatalf("unknown alias should not reach MCP server, calls=%v", mcpCalls)
	}

	// 3. Reject cross-conversation userMessageId on localContinuation!
	conv2Msgs, _ := msgStore.ListByConversation(ctx, conv2.ID)
	badCont := doAuthPost("/api/v1/conversations/"+conv1.ID+"/messages/prepare-local", map[string]any{
		"providerId": "loc-p",
		"modelId":    "qwen",
		"localContinuation": map[string]any{
			"userMessageId": conv2Msgs[0].ID,
			"blocks":        []map[string]any{{"type": "toolCall", "id": "c1", "name": alias, "arguments": map[string]any{}}},
		},
	})
	_ = badCont.Body.Close()
	if badCont.StatusCode == http.StatusOK {
		t.Fatalf("expected cross-conversation userMessageId rejection, got 200")
	}

	// 4. Valid localContinuation encodes assistant turn + tool result cleanly without mutating DB!
	msgsBeforeCont, _ := msgStore.ListByConversation(ctx, conv1.ID)
	goodCont := doAuthPost("/api/v1/conversations/"+conv1.ID+"/messages/prepare-local", map[string]any{
		"providerId": "loc-p",
		"modelId":    "qwen",
		"localContinuation": map[string]any{
			"userMessageId": userMsg.ID,
			"blocks": []map[string]any{
				{"type": "toolCall", "id": "c1", "name": alias, "arguments": map[string]any{}},
				{"type": "toolResult", "toolCallId": "c1", "toolName": alias, "content": "note-body"},
			},
		},
	})
	defer goodCont.Body.Close()
	if goodCont.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on valid localContinuation, got %d", goodCont.StatusCode)
	}
	var prep2 struct {
		Body map[string]any `json:"body"`
	}
	_ = json.NewDecoder(goodCont.Body).Decode(&prep2)
	wireMsgs := prep2.Body["messages"].([]any)
	if len(wireMsgs) != 3 || wireMsgs[2].(map[string]any)["role"] != "tool" {
		t.Fatalf("expected [user, assistant(toolCall), tool(toolResult)] in prepare-local round 2, got %+v", wireMsgs)
	}
	msgsAfterCont, _ := msgStore.ListByConversation(ctx, conv1.ID)
	if len(msgsAfterCont) != len(msgsBeforeCont) {
		t.Fatalf("prepare-local continuation must not mutate SQLite messages")
	}
}

func TestStatelessMCPToolsExecuteEndpoint(t *testing.T) {
	ctx := t.Context()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()

	var executed []string
	mcpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		if len(req.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		switch req.Method {
		case "initialize":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result":  map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{"tools": map[string]any{}}},
			})
		case "tools/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"tools": []plugin.MCPToolDescriptor{
						{Name: "get_note", Description: "Get note", InputSchema: json.RawMessage(`{"type":"object"}`)},
						{Name: "blocked_tool", Description: "Blocked", InputSchema: json.RawMessage(`{"type":"object"}`)},
					},
				},
			})
		case "tools/call":
			executed = append(executed, req.Params.Name)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result": map[string]any{
					"content": []map[string]any{{"type": "text", "text": "stateless-" + req.Params.Name}},
				},
			})
		}
	}))
	defer mcpSrv.Close()

	mcpStore := store.NewMCPServerStore(db)
	_, _ = mcpStore.Create(ctx, domain.MCPServerConfig{
		ID:            "cloud-srv",
		Name:          "cloud-srv",
		Transport:     domain.MCPTransportStreamableHTTP,
		Endpoint:      mcpSrv.URL,
		Enabled:       true,
		DisabledTools: []string{"blocked_tool"},
	})
	_, _ = mcpStore.Create(ctx, domain.MCPServerConfig{
		ID:        "disabled-srv",
		Name:      "disabled-srv",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  mcpSrv.URL,
		Enabled:   false,
	})

	searchReg := plugin.NewSearchRegistry()
	pluginSvc := service.NewPluginService(searchReg, store.NewSearchConfigStore(db), mcpStore).WithMCPClient(mcpRuntime)
	router := httpapi.NewRouter(httpapi.RouterDeps{
		Config:        config.Config{AccessToken: "stateless-tok", DevMode: false},
		PluginService: pluginSvc,
	})
	gw := httptest.NewServer(router)
	defer gw.Close()

	post := func(accept string, payload any) *http.Response {
		var buf bytes.Buffer
		_ = json.NewEncoder(&buf).Encode(payload)
		req, _ := http.NewRequest(http.MethodPost, gw.URL+"/api/v1/mcp/tools/execute", &buf)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer stateless-tok")
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST /mcp/tools/execute: %v", err)
		}
		return resp
	}

	// 1. Direct serverId + toolName call (no conversationId), including disabled tool and disabled server checks.
	resp := post("", map[string]any{
		"calls": []map[string]any{
			{"id": "c1", "serverId": "cloud-srv", "toolName": "get_note", "arguments": map[string]any{}},
			{"id": "c2", "serverId": "cloud-srv", "toolName": "blocked_tool", "arguments": map[string]any{}},
			{"id": "c3", "serverId": "disabled-srv", "toolName": "get_note", "arguments": map[string]any{}},
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stateless execute status=%d", resp.StatusCode)
	}
	var jsonOut struct {
		ToolResults []domain.ContentBlock `json:"toolResults"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&jsonOut); err != nil {
		t.Fatalf("decode jsonOut: %v", err)
	}
	if len(jsonOut.ToolResults) != 3 {
		t.Fatalf("expected 3 toolResults, got %+v", jsonOut.ToolResults)
	}
	if jsonOut.ToolResults[0].IsError || jsonOut.ToolResults[0].Content != "stateless-get_note" {
		t.Fatalf("unexpected enabled tool result: %+v", jsonOut.ToolResults[0])
	}
	if !jsonOut.ToolResults[1].IsError || !strings.Contains(jsonOut.ToolResults[1].Content, "disabled") {
		t.Fatalf("expected disabled tool error, got %+v", jsonOut.ToolResults[1])
	}
	if !jsonOut.ToolResults[2].IsError || !strings.Contains(jsonOut.ToolResults[2].Content, "disabled") {
		t.Fatalf("expected disabled server error, got %+v", jsonOut.ToolResults[2])
	}

	// 2. Alias fallback over SSE.
	alias := plugin.BuildChatToolAlias("cloud-srv", "get_note", nil)
	sseResp := post("text/event-stream", map[string]any{
		"calls": []map[string]any{
			{"id": "c4", "name": alias, "arguments": map[string]any{}},
		},
	})
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK {
		t.Fatalf("SSE execute status=%d", sseResp.StatusCode)
	}
	var sseBuf bytes.Buffer
	_, _ = sseBuf.ReadFrom(sseResp.Body)
	if !strings.Contains(sseBuf.String(), "stateless-get_note") || !strings.Contains(sseBuf.String(), "event: block_end") {
		t.Fatalf("unexpected SSE output: %s", sseBuf.String())
	}
	if len(executed) != 2 {
		t.Fatalf("expected exactly 2 actual MCP calls, got %v", executed)
	}
}
