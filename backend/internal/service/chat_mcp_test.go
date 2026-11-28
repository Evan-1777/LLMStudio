package service_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

type stubMCPClient struct {
	mu         sync.Mutex
	toolsBySrv map[string][]plugin.MCPToolDescriptor
	calls      []string
	callFunc   func(ctx context.Context, server domain.MCPServerConfig, name string, arguments json.RawMessage) (plugin.MCPCallToolResult, error)
	closedIDs  []string
	listCalls  int
}

func (c *stubMCPClient) ID() string { return "stub-mcp" }

func (c *stubMCPClient) ListTools(_ context.Context, server domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listCalls++
	return append([]plugin.MCPToolDescriptor(nil), c.toolsBySrv[server.ID]...), nil
}

func (c *stubMCPClient) CallTool(ctx context.Context, server domain.MCPServerConfig, name string, arguments json.RawMessage) (plugin.MCPCallToolResult, error) {
	c.mu.Lock()
	c.calls = append(c.calls, server.ID+":"+name)
	fn := c.callFunc
	c.mu.Unlock()
	if fn != nil {
		return fn(ctx, server, name, arguments)
	}
	return plugin.MCPCallToolResult{
		Content: []plugin.MCPToolContent{{Type: "text", Text: server.ID + ":" + name + "=" + string(arguments)}},
	}, nil
}

func (c *stubMCPClient) CloseServer(id string) error {
	c.mu.Lock()
	c.closedIDs = append(c.closedIDs, id)
	c.mu.Unlock()
	return nil
}

func (c *stubMCPClient) Close() error { return nil }

func setupChatMCPFixture(t *testing.T, baseURL string, stubMCP *stubMCPClient) (*service.ChatService, *store.ConversationStore, *store.MessageStore, *store.MCPServerStore, domain.Conversation, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	mcpStore := store.NewMCPServerStore(db)

	_, err = provStore.Create(ctx, domain.ProviderConfig{
		ID:       "prov-1",
		Name:     "Fake OpenAI",
		Adapter:  provider.AdapterGenericHTTP,
		BaseURL:  baseURL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-test",
		Enabled:  true,
		Models: []domain.ModelConfig{
			{ID: "gpt-test", Name: "GPT Test", APIFormat: format.FormatIDOpenAICompletions},
		},
	})
	if err != nil {
		t.Fatalf("Create provider: %v", err)
	}

	conv, err := convStore.Create(ctx, domain.Conversation{
		ID:          "conv-1",
		AssistantID: domain.DefaultAssistantID,
		Title:       "MCP Test",
		ProviderID:  "prov-1",
		ModelID:     "gpt-test",
	})
	if err != nil {
		t.Fatalf("Create conv: %v", err)
	}

	svc := service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithMCP(mcpStore, stubMCP)
	return svc, convStore, msgStore, mcpStore, conv, db
}

func TestRequestMCPDisabledSkipsDiscoveryAndKeepsNativeTools(t *testing.T) {
	ctx := t.Context()
	stub := &stubMCPClient{toolsBySrv: map[string][]plugin.MCPToolDescriptor{
		"mcp": {{Name: "test_tool", InputSchema: json.RawMessage("{\"type\":\"object\"}")}},
	}}
	type requestBody struct {
		Tools []struct{ Function struct{ Name string } }
	}
	captured := make(chan requestBody, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body requestBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		captured <- body
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	svc, convStore, _, mcpStore, conv, db := setupChatMCPFixture(t, upstream.URL, stub)
	prefs := domain.DefaultPreferences()
	prefs.BuiltinTimeToolEnabled = true
	svc.WithPreferences(&countingPreferenceLookup{prefs: prefs})
	if _, err := mcpStore.Create(ctx, domain.MCPServerConfig{ID: "mcp", Name: "MCP", Transport: domain.MCPTransportStdio, Command: "mock", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	prepare := func(flag *bool) []string {
		t.Helper()
		prep, err := svc.PrepareLocal(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "hello", MCPToolsEnabled: flag})
		if err != nil {
			t.Fatal(err)
		}
		var payload requestBody
		if err := json.Unmarshal(prep.Body, &payload); err != nil {
			t.Fatal(err)
		}
		names := make([]string, 0, len(payload.Tools))
		for _, tool := range payload.Tools {
			names = append(names, tool.Function.Name)
		}
		return names
	}
	disabled := false
	if names := prepare(&disabled); len(names) != 0 || stub.listCalls != 0 {
		t.Fatalf("disabled MCP: tools=%v; discoveries=%d", names, stub.listCalls)
	}
	if names := prepare(nil); len(names) != 2 || stub.listCalls != 1 {
		t.Fatalf("default MCP: tools=%v; discoveries=%d", names, stub.listCalls)
	}
	conv.Mode = domain.ConversationModeAgent
	if _, err := convStore.Update(ctx, conv); err != nil {
		t.Fatal(err)
	}
	runtime := agent.NewGateway(store.NewAgentStore(db), t.TempDir(), true)
	allowed := []string{"read"}
	if _, err := runtime.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatal(err)
	}
	svc.WithAgent(runtime)
	prep, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "native only", MCPToolsEnabled: &disabled})
	if err != nil {
		t.Fatal(err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	tools := (<-captured).Tools
	if len(tools) != 1 || tools[0].Function.Name != "read" || stub.listCalls != 1 {
		t.Fatalf("native agent tools with MCP disabled: %+v; discoveries=%d", tools, stub.listCalls)
	}
}

func TestAgentAndSameNamedMCPShareRoundWithoutSharingPermission(t *testing.T) {
	ctx := t.Context()
	alias := plugin.BuildChatToolAlias("srv-a", "read", nil)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("native-marker"), 0600); err != nil {
		t.Fatal(err)
	}
	var runtime *agent.Runtime
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools    []struct{ Function struct{ Name string } }
			Messages []struct{ Role, Content string }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		if calls == 1 {
			if len(body.Tools) != 2 || body.Tools[0].Function.Name != "read" || body.Tools[1].Function.Name != alias {
				t.Errorf("first tools: %+v", body.Tools)
			}
			// Revoke after discovery; executing the already-advertised name must recheck.
			none := []string{}
			if _, err := runtime.UpdateSettings(r.Context(), agent.SettingsPatch{AllowedTools: &none}); err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			fmt.Fprintf(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"n","function":{"name":"read","arguments":%q}},{"index":1,"id":"m","function":{"name":%q,"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n", `{"path":"note.txt"}`, alias)
			return
		}
		if len(body.Tools) != 1 || body.Tools[0].Function.Name != alias {
			t.Errorf("continuation tools: %+v", body.Tools)
		}
		if n := len(body.Messages); n < 3 || !strings.Contains(body.Messages[n-2].Content, "disabled") || !strings.Contains(body.Messages[n-1].Content, "srv-a:read") {
			t.Errorf("tool results: %+v", body.Messages)
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	stub := &stubMCPClient{toolsBySrv: map[string][]plugin.MCPToolDescriptor{"srv-a": {{Name: "read", InputSchema: json.RawMessage(`{"type":"object"}`)}}}}
	svc, convs, msgs, mcp, conv, db := setupChatMCPFixture(t, upstream.URL, stub)
	conv.Mode = domain.ConversationModeAgent
	if _, err := convs.Update(ctx, conv); err != nil {
		t.Fatal(err)
	}
	if _, err := mcp.Create(ctx, domain.MCPServerConfig{ID: "srv-a", Name: "test MCP", Transport: domain.MCPTransportStdio, Command: "mock", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	runtime = agent.NewGateway(store.NewAgentStore(db), dir, true)
	allowed := []string{"read"}
	if _, err := runtime.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatal(err)
	}
	svc.WithAgent(runtime)
	prep, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "check tools"})
	if err != nil {
		t.Fatal(err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	history, err := msgs.ListByConversation(ctx, conv.ID)
	if err != nil || len(history) != 2 {
		t.Fatalf("history %d: %v", len(history), err)
	}
	var results []domain.ContentBlock
	for _, block := range history[1].Blocks {
		if block.Type == domain.BlockTypeToolResult {
			results = append(results, block)
		}
	}
	if len(results) != 2 || results[0].ToolSource != "native" || !results[0].IsError || strings.Contains(results[0].Content, "native-marker") || results[1].ToolSource != "mcp" || results[1].IsError {
		t.Fatalf("results: %+v", results)
	}
	if _, err = db.ExecContext(ctx, "UPDATE agent_settings SET allowed_tools_json = 'invalid'"); err != nil {
		t.Fatal(err)
	}
	if p, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "reject invalid policy"}); err == nil || p != nil {
		t.Fatal("bad policy did not fail closed")
	}
}

func TestChatServiceMultiRoundToolsSequentialSinglePersistAndReplay(t *testing.T) {
	ctx := context.Background()

	var mu sync.Mutex
	var llmRequests []map[string]any
	llmTurn := 0

	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		llmTurn++
		turn := llmTurn
		llmRequests = append(llmRequests, body)
		mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		tools := body["tools"].([]any)
		aliasLookupA := tools[0].(map[string]any)["function"].(map[string]any)["name"].(string)
		aliasSummarizeA := tools[1].(map[string]any)["function"].(map[string]any)["name"].(string)
		aliasLookupB := tools[2].(map[string]any)["function"].(map[string]any)["name"].(string)

		switch turn {
		case 1:
			// Round 1: invoke two tools with same original name on 2 servers -> distinct aliases.
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c_r1_0\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"q\\\":\\\"a\\\"}\"}},{\"index\":1,\"id\":\"c_r1_1\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"q\\\":\\\"b\\\"}\"}}]}}]}\n\n", aliasLookupA, aliasLookupB)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		case 2:
			// Round 2: invoke third tool.
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c_r2_0\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"sum\\\":true}\"}}]}}]}\n\n", aliasSummarizeA)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":7,\"total_tokens\":27}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		default:
			// Round 3 (and follow-up turn 4): final text.
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Done turn %d\"}}]}\n\n", turn)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":8,\"total_tokens\":38}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		}
		flusher.Flush()
	}))
	defer llmSrv.Close()

	stubMCP := &stubMCPClient{
		toolsBySrv: map[string][]plugin.MCPToolDescriptor{
			"srv-a": {
				{Name: "lookup", Description: "A lookup", InputSchema: json.RawMessage(`{"type":"object"}`)},
				{Name: "summarize", Description: "Summarize", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
			"srv-b": {
				{Name: "lookup", Description: "B lookup", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
		},
	}

	svc, _, msgStore, mcpStore, conv, _ := setupChatMCPFixture(t, llmSrv.URL, stubMCP)
	for _, id := range []string{"srv-a", "srv-b"} {
		if _, err := mcpStore.Create(ctx, domain.MCPServerConfig{
			ID:        id,
			Name:      id,
			Transport: domain.MCPTransportStdio,
			Command:   "mock",
			Enabled:   true,
		}); err != nil {
			t.Fatalf("Create mcp %s: %v", id, err)
		}
	}

	prep, err := svc.Prepare(ctx, service.StreamChatInput{
		ConversationID: conv.ID,
		Text:           "Run 3 tools",
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	var events []domain.StreamEvent
	if err := prep.Stream(ctx, func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("Stream: %v", err)
	}

	// Verify 3 LLM requests, 3 sequential tool calls, 1 message_start, 1 message_end.
	mu.Lock()
	if llmTurn != 3 {
		t.Fatalf("expected 3 LLM requests, got %d", llmTurn)
	}
	req3Msgs := llmRequests[2]["messages"].([]any)
	mu.Unlock()
	if len(req3Msgs) < 6 {
		t.Fatalf("expected round 3 request to replay round 1 + round 2 turns, got %+v", req3Msgs)
	}

	if len(stubMCP.calls) != 3 || stubMCP.calls[0] != "srv-a:lookup" || stubMCP.calls[1] != "srv-b:lookup" || stubMCP.calls[2] != "srv-a:summarize" {
		t.Fatalf("unexpected sequential MCP tool calls: %v", stubMCP.calls)
	}

	var starts, ends int
	var finalMsg *domain.Message
	var deltaContextTokens []int
	for _, ev := range events {
		switch ev.Type {
		case domain.StreamEventMessageStart:
			starts++
		case domain.StreamEventMessageDelta:
			if ev.Usage != nil {
				deltaContextTokens = append(deltaContextTokens, ev.Usage.ContextTokens)
			}
		case domain.StreamEventMessageEnd:
			ends++
			finalMsg = ev.Message
		}
	}
	if starts != 1 || ends != 1 || finalMsg == nil {
		t.Fatalf("expected 1 message_start & 1 message_end, got starts=%d ends=%d", starts, ends)
	}
	if finalMsg.Usage == nil || finalMsg.Usage.InputTokens != 60 || finalMsg.Usage.OutputTokens != 20 || finalMsg.Usage.TotalTokens != 80 || finalMsg.Usage.ContextTokens != 38 {
		t.Fatalf("expected cumulative summed usage (60/20/80) with last-round contextTokens=38, got %+v", finalMsg.Usage)
	}
	if len(deltaContextTokens) != 3 || deltaContextTokens[0] != 15 || deltaContextTokens[1] != 27 || deltaContextTokens[2] != 38 {
		t.Fatalf("expected per-round message_delta contextTokens [15 27 38], got %v", deltaContextTokens)
	}

	// DB must contain exactly 1 user + 1 assistant message, replayable on next user turn.
	msgs, err := msgStore.ListByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("ListByConversation: %v", err)
	}
	if len(msgs) != 2 || len(msgs[1].Blocks) != 7 {
		t.Fatalf("expected 2 DB msgs and 7 chronological assistant blocks (2 calls+2 res+1 call+1 res+text), got len=%d blocks=%+v", len(msgs), msgs)
	}

	prepNext, err := svc.Prepare(ctx, service.StreamChatInput{
		ConversationID: conv.ID,
		Text:           "Next turn",
	})
	if err != nil {
		t.Fatalf("Prepare next turn: %v", err)
	}
	if err := prepNext.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream next turn: %v", err)
	}
	mu.Lock()
	followUpMsgs := llmRequests[3]["messages"].([]any)
	mu.Unlock()
	if len(followUpMsgs) < 7 {
		t.Fatalf("expected follow-up request to replay full multi-round assistant history, got %+v", followUpMsgs)
	}
}

func TestChatServiceMCPErrorsAbortRoundLimitAndMidHistoryPreserve(t *testing.T) {
	ctx := context.Background()

	// 1. Failing tool + unknown alias keeps sibling tools running; mid-tool abort preserves partial trajectory cleanly.
	llmTurn := 0
	var seenToolContents []string
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		llmTurn++
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)

		if llmTurn == 1 {
			tools := body["tools"].([]any)
			aliasGood := tools[0].(map[string]any)["function"].(map[string]any)["name"].(string)
			aliasBroken := tools[1].(map[string]any)["function"].(map[string]any)["name"].(string)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"bad_1\",\"function\":{\"name\":\"unknown_alias\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"err_2\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}},{\"index\":2,\"id\":\"ok_3\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}}]}}]}\n\n", aliasBroken, aliasGood)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		} else {
			for _, m := range body["messages"].([]any) {
				mm := m.(map[string]any)
				if mm["role"] == "tool" {
					seenToolContents = append(seenToolContents, fmt.Sprint(mm["content"]))
				}
			}
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Recovered\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		}
		flusher.Flush()
	}))
	defer llmSrv.Close()

	stubMCP := &stubMCPClient{
		toolsBySrv: map[string][]plugin.MCPToolDescriptor{
			"srv-1": {
				{Name: "good_tool", InputSchema: json.RawMessage(`{"type":"object"}`)},
				{Name: "broken_tool", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
		},
		callFunc: func(_ context.Context, _ domain.MCPServerConfig, name string, _ json.RawMessage) (plugin.MCPCallToolResult, error) {
			if name == "broken_tool" {
				return plugin.MCPCallToolResult{}, errors.New("mcp disconnected")
			}
			return plugin.MCPCallToolResult{Content: []plugin.MCPToolContent{{Type: "text", Text: "good-output"}}}, nil
		},
	}

	svc, _, msgStore, mcpStore, conv, _ := setupChatMCPFixture(t, llmSrv.URL, stubMCP)
	_, _ = mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "srv-1", Name: "srv-1", Transport: domain.MCPTransportStdio, Command: "mock", Enabled: true,
	})

	prep, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "Test errors"})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	// Every sibling result is reported once; tool results are keyed by call ID, so
	// their replay order is not part of the contract.
	joined := strings.Join(seenToolContents, "|")
	if len(seenToolContents) != 3 ||
		!strings.Contains(joined, "unknown") ||
		!strings.Contains(joined, "mcp disconnected") ||
		!strings.Contains(joined, "good-output") {
		t.Fatalf("expected all 3 tool results (2 errors + 1 ok sibling), got %v", seenToolContents)
	}

	// Test mid-history retry preserves downstream tail message!
	allMsgs, _ := msgStore.ListByConversation(ctx, conv.ID)
	tailUser, _ := msgStore.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Tail keeps intact"}},
		CreatedAt:      time.Now().UTC(),
	})
	llmTurn = 10 // ensure immediate stop
	regenPrep, err := svc.Prepare(ctx, service.StreamChatInput{
		ConversationID:      conv.ID,
		RegenerateMessageID: allMsgs[1].ID,
	})
	if err != nil {
		t.Fatalf("Prepare regen: %v", err)
	}
	if err := regenPrep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream regen: %v", err)
	}
	afterRegen, _ := msgStore.ListByConversation(ctx, conv.ID)
	if len(afterRegen) != 3 || afterRegen[2].ID != tailUser.ID {
		t.Fatalf("mid-history regen truncated downstream messages: %+v", afterRegen)
	}
}

func TestMCPDisabledToolsKeepSiblingAliasesAndRejectExecution(t *testing.T) {
	ctx := t.Context()
	stub := &stubMCPClient{toolsBySrv: map[string][]plugin.MCPToolDescriptor{
		"srv-a": {{Name: "read"}, {Name: "search"}},
		"srv-b": {{Name: "read"}},
	}}
	svc, _, _, mcps, conv, _ := setupChatMCPFixture(t, "http://127.0.0.1:1/v1", stub)
	cfg := service.NewPluginService(nil, nil, mcps).WithMCPClient(stub)
	for _, id := range []string{"srv-a", "srv-b"} {
		if _, err := cfg.CreateMCPServer(ctx, service.MCPServerInput{ID: id, Name: id, Command: "mock"}); err != nil {
			t.Fatal(err)
		}
	}
	aliases := func() string {
		t.Helper()
		prep, err := svc.PrepareLocal(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "list tools"})
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Tools []struct{ Function struct{ Name string } }
		}
		if err := json.Unmarshal(prep.Body, &body); err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, tool := range body.Tools {
			names = append(names, tool.Function.Name)
		}
		return strings.Join(names, ",")
	}
	before := strings.Split(aliases(), ",")
	if len(before) != 3 {
		t.Fatalf("expected three aliases, got %v", before)
	}
	if _, err := cfg.UpdateMCPServer(ctx, "srv-a", service.MCPServerInput{DisabledTools: []string{"read"}}); err != nil {
		t.Fatal(err)
	}
	if got := aliases(); got != strings.Join(before[1:], ",") {
		t.Fatalf("sibling aliases changed: %s -> %s", strings.Join(before, ","), got)
	}
	var results []bool
	var calls []service.ToolCallInput
	for _, name := range before {
		calls = append(calls, service.ToolCallInput{ID: name, Name: name})
	}
	if err := svc.ExecuteTools(ctx, service.ExecuteToolsInput{ConversationID: conv.ID, Calls: calls}, func(e domain.StreamEvent) error {
		if e.Type == domain.StreamEventBlockEnd {
			results = append(results, e.Block.IsError)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(results) != "[true false false]" || strings.Join(stub.calls, ",") != "srv-a:search,srv-b:read" || len(stub.closedIDs) != 0 {
		t.Fatalf("results=%v calls=%v closed=%v", results, stub.calls, stub.closedIDs)
	}
}

func TestChatServiceMCPRoundLimitAbortAndPersistFailure(t *testing.T) {
	ctx := context.Background()

	// Always request another tool round to exercise the cutoff.
	llmCalls := 0
	var llmSrv *httptest.Server
	llmSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCalls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tools := body["tools"].([]any)
		alias := tools[0].(map[string]any)["function"].(map[string]any)["name"].(string)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"loop_call\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}}]}}]}\n\n", alias)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer llmSrv.Close()

	stubMCP := &stubMCPClient{
		toolsBySrv: map[string][]plugin.MCPToolDescriptor{
			"srv-1": {{Name: "step", InputSchema: json.RawMessage(`{"type":"object"}`)}},
		},
	}
	svc, _, _, mcpStore, conv, db := setupChatMCPFixture(t, llmSrv.URL, stubMCP)
	_, _ = mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "srv-1", Name: "srv-1", Transport: domain.MCPTransportStdio, Command: "mock", Enabled: true,
	})

	prefs := service.NewPreferenceService(store.NewPreferenceStore(db))
	for _, rounds := range []int{domain.DefaultMCPMaxToolRounds, 3, 12} {
		t.Run(fmt.Sprint(rounds), func(t *testing.T) {
			stubMCP.calls = nil
			if rounds != domain.DefaultMCPMaxToolRounds {
				if _, _, err := prefs.Update(ctx, domain.PreferencesPatch{MCPMaxToolRounds: &rounds}); err != nil {
					t.Fatal(err)
				}
				svc.WithPreferences(prefs)
			}
			prep, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "Loop forever"})
			if err != nil {
				t.Fatalf("Prepare loop: %v", err)
			}
			var gotEvents []domain.StreamEvent
			if err := prep.Stream(ctx, func(ev domain.StreamEvent) error {
				gotEvents = append(gotEvents, ev)
				return nil
			}); err != nil {
				t.Fatalf("Stream loop: %v", err)
			}
			if len(stubMCP.calls) != rounds {
				t.Fatalf("expected exactly %d tool rounds executed before limit, got %d", rounds, len(stubMCP.calls))
			}
			var sawLimitErr, sawMsgEnd bool
			for _, ev := range gotEvents {
				if ev.Type == domain.StreamEventError && ev.Error != nil && ev.Error.Code == "MCP_ROUND_LIMIT" && strings.Contains(ev.Error.Message, fmt.Sprintf("%d 轮", rounds)) {
					sawLimitErr = true
				}
				if ev.Type == domain.StreamEventMessageEnd {
					sawMsgEnd = true
				}
			}
			if !sawLimitErr || sawMsgEnd {
				t.Fatalf("expected MCP_ROUND_LIMIT error and no fake message_end: sawLimit=%v sawEnd=%v", sawLimitErr, sawMsgEnd)
			}
		})
	}

	// Test mid-tool abort stops subsequent calls & next model request.
	stubMCP.calls = nil
	llmCallsBeforeAbort := llmCalls
	reqCtx, cancelReq := context.WithCancel(ctx)
	stubMCP.callFunc = func(_ context.Context, _ domain.MCPServerConfig, _ string, _ json.RawMessage) (plugin.MCPCallToolResult, error) {
		cancelReq()
		return plugin.MCPCallToolResult{}, context.Canceled
	}
	abortPrep, err := svc.Prepare(reqCtx, service.StreamChatInput{ConversationID: conv.ID, Text: "Abort during tool"})
	if err != nil {
		t.Fatalf("Prepare abort: %v", err)
	}
	_ = abortPrep.Stream(reqCtx, func(domain.StreamEvent) error { return nil })
	if len(stubMCP.calls) != 1 || llmCalls != llmCallsBeforeAbort+1 {
		t.Fatalf("abort must prevent extra LLM/tool calls: calls=%d llmDelta=%d", len(stubMCP.calls), llmCalls-llmCallsBeforeAbort)
	}
}

func TestChatServiceFinalPersistFailureEmitsErrorNotMessageEnd(t *testing.T) {
	ctx := context.Background()
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello world\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer llmSrv.Close()

	svc, _, _, _, conv, db := setupChatMCPFixture(t, llmSrv.URL, &stubMCPClient{})
	prep, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "Persist fail test"})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	var events []domain.StreamEvent
	closed := false
	if err := prep.Stream(ctx, func(ev domain.StreamEvent) error {
		events = append(events, ev)
		// Close SQLite after the first content block so the user prompt is already
		// persisted and only the final assistant write fails.
		if !closed && ev.Type == domain.StreamEventBlockDelta {
			closed = true
			_ = db.Close()
		}
		return nil
	}); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	var sawPersistErr, sawFakeEnd bool
	for _, ev := range events {
		if ev.Type == domain.StreamEventError && ev.Error != nil && ev.Error.Code == "PERSIST_FAILED" {
			sawPersistErr = true
		}
		if ev.Type == domain.StreamEventMessageEnd {
			sawFakeEnd = true
		}
	}
	if !sawPersistErr || sawFakeEnd {
		t.Fatalf("expected PERSIST_FAILED error and no fake message_end: events=%+v", events)
	}
}

type countingPreferenceLookup struct {
	calls int
	mu    sync.Mutex
	prefs domain.Preferences
}

func (c *countingPreferenceLookup) Get(context.Context) (domain.Preferences, bool, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	return c.prefs, true, nil
}

type delayedMCPClient struct {
	stubMCPClient
	delay time.Duration
}

func (d *delayedMCPClient) ListTools(ctx context.Context, server domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(d.delay):
	}
	return d.stubMCPClient.ListTools(ctx, server)
}

func TestChatServicePrepareReadsPreferencesOnceAndDiscoversToolsConcurrently(t *testing.T) {
	ctx := context.Background()

	var capturedTools []any
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		capturedTools, _ = body["tools"].([]any)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer llmSrv.Close()

	mcpClient := &delayedMCPClient{
		delay: 80 * time.Millisecond,
		stubMCPClient: stubMCPClient{
			toolsBySrv: map[string][]plugin.MCPToolDescriptor{
				"srv-1": {{Name: "tool_one", InputSchema: json.RawMessage(`{"type":"object"}`)}},
				"srv-2": {{Name: "tool_two", InputSchema: json.RawMessage(`{"type":"object"}`)}},
				"srv-3": {{Name: "tool_three", InputSchema: json.RawMessage(`{"type":"object"}`)}},
			},
		},
	}

	svc, _, _, mcpStore, conv, _ := setupChatMCPFixture(t, llmSrv.URL, &mcpClient.stubMCPClient)
	svc.WithMCP(mcpStore, mcpClient)
	prefLookup := &countingPreferenceLookup{prefs: domain.DefaultPreferences()}
	svc.WithPreferences(prefLookup)

	for _, id := range []string{"srv-3", "srv-1", "srv-2"} {
		if _, err := mcpStore.Create(ctx, domain.MCPServerConfig{
			ID: id, Name: id, Transport: domain.MCPTransportStdio, Command: "mock", Enabled: true,
		}); err != nil {
			t.Fatalf("create mcp %s: %v", id, err)
		}
	}

	start := time.Now()
	prep, err := svc.Prepare(ctx, service.StreamChatInput{
		ConversationID: conv.ID,
		Text:           "hello",
	})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	_ = prep.Stream(ctx, func(domain.StreamEvent) error { return nil })

	prefLookup.mu.Lock()
	prefCalls := prefLookup.calls
	prefLookup.mu.Unlock()
	if prefCalls != 1 {
		t.Fatalf("expected PreferenceLookup.Get called exactly once during Prepare, got %d", prefCalls)
	}
	// 3 servers x 80ms each concurrently should complete well below serial 240ms.
	if elapsed >= 200*time.Millisecond {
		t.Fatalf("expected concurrent MCP discovery < 200ms, took %v", elapsed)
	}
	if len(capturedTools) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(capturedTools))
	}
	// Deterministic ordering by sorted server ID: srv-1, srv-2, srv-3.
	var names []string
	for _, raw := range capturedTools {
		fn := raw.(map[string]any)["function"].(map[string]any)
		names = append(names, fn["name"].(string))
	}
	for i, wantSuffix := range []string{"tool_one", "tool_two", "tool_three"} {
		if !strings.Contains(names[i], wantSuffix) {
			t.Fatalf("expected deterministic tool order [%s] at index %d, got %v", wantSuffix, i, names)
		}
	}
}

func TestChatServiceRollsBackUserMessageWhenNoAssistantOutput(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"error\":{\"code\":\"bad_request\",\"message\":\"upstream exploded\"}}\n\n")
	}))
	defer upstream.Close()

	svc, _, msgs, _, conv, _ := setupChatMCPFixture(t, upstream.URL, &stubMCPClient{})
	prep, err := svc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "rollback me"})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	var events []domain.StreamEvent
	if err := prep.Stream(t.Context(), func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("Stream: %v", err)
	}

	items, err := msgs.ListByConversation(t.Context(), conv.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected zero persisted messages on empty rollback, got %d: %+v", len(items), items)
	}
	var sawRollback bool
	for _, ev := range events {
		if ev.Type == domain.StreamEventError && ev.RolledBack && ev.Message == nil {
			sawRollback = true
		}
	}
	if !sawRollback {
		t.Fatalf("expected rolledBack error event, got %+v", events)
	}
}

func TestChatServiceErrorAfterPartialOutputKeepsSavedMessage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Part 1\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"error\":{\"code\":\"upstream_error\",\"message\":\"stream broke\"}}\n\n")
	}))
	defer upstream.Close()

	svc, _, msgs, _, conv, _ := setupChatMCPFixture(t, upstream.URL, &stubMCPClient{})
	prep, err := svc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "keep me"})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	var events []domain.StreamEvent
	if err := prep.Stream(t.Context(), func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("Stream: %v", err)
	}

	items, err := msgs.ListByConversation(t.Context(), conv.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected user + partial assistant, got %d: %+v", len(items), items)
	}
	if items[1].StopReason != domain.StopReasonError || !hasTextBlock(items[1].Blocks, "Part 1") {
		t.Fatalf("unexpected assistant persistence: %+v", items[1])
	}
	var errorEvent *domain.StreamEvent
	for i := range events {
		if events[i].Type == domain.StreamEventError {
			errorEvent = &events[i]
		}
	}
	if errorEvent == nil || errorEvent.RolledBack || errorEvent.Message == nil || errorEvent.Message.ID != items[1].ID {
		t.Fatalf("expected non-rollback error carrying saved message, got %+v", events)
	}
}

func hasTextBlock(blocks []domain.ContentBlock, want string) bool {
	for _, b := range blocks {
		if b.Type == domain.BlockTypeText && b.Text == want {
			return true
		}
	}
	return false
}
