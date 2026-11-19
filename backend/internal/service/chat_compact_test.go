package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/store"
)

type compactStubMCPClient struct {
	calls []string
}

func (c *compactStubMCPClient) ID() string { return "compact-stub-mcp" }

func (c *compactStubMCPClient) ListTools(_ context.Context, _ domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	return []plugin.MCPToolDescriptor{
		{Name: "lookup", Description: "Lookup info", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}, nil
}

func (c *compactStubMCPClient) CallTool(_ context.Context, srv domain.MCPServerConfig, name string, _ json.RawMessage) (plugin.MCPCallToolResult, error) {
	c.calls = append(c.calls, srv.ID+":"+name)
	return plugin.MCPCallToolResult{
		Content: []plugin.MCPToolContent{{Type: "text", Text: "mcp result ok"}},
	}, nil
}

func (c *compactStubMCPClient) CloseServer(string) error { return nil }
func (c *compactStubMCPClient) Close() error             { return nil }

func TestSelectCompactionPlanAndEstimators(t *testing.T) {
	if _, err := selectCompactionPlan([]domain.Message{
		{ID: "u1", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}},
	}); err == nil {
		t.Fatal("expected <2 messages to fail")
	}

	singleTurn := []domain.Message{
		{ID: "u1", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "find files"}}},
		{ID: "a1", Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "found 10"}}},
	}
	plan1, err := selectCompactionPlan(singleTurn)
	if err != nil {
		t.Fatalf("single-turn selectCompactionPlan: %v", err)
	}
	if plan1.keptCount != 0 || plan1.insertAfterMessageID != "" || plan1.compactedCount != 2 {
		t.Fatalf("unexpected single-turn plan: %+v", plan1)
	}
	if len(plan1.compactedSpan) != 2 || len(plan1.promptMessages) != 2 || plan1.promptMessages[0].ID != "u1" || plan1.promptMessages[1].ID != "a1" {
		t.Fatalf("expected compactedSpan & promptMessages to preserve complete single-turn messages, span=%+v prompt=%+v", plan1.compactedSpan, plan1.promptMessages)
	}

	multiTurn := []domain.Message{
		{ID: "u1", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "q1"}}},
		{ID: "a1", Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ans1"}}},
		{ID: "u2", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "q2"}}},
		{ID: "a2", Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ans2"}}},
		{ID: "u3", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "q3"}}},
		{ID: "a3", Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ans3"}}, Usage: &domain.Usage{InputTokens: 1000, OutputTokens: 200, TotalTokens: 1200, ContextTokens: 1200}},
	}
	planMulti, err := selectCompactionPlan(multiTurn)
	if err != nil {
		t.Fatalf("multi-turn selectCompactionPlan: %v", err)
	}
	if planMulti.insertAfterMessageID != "a2" || planMulti.snapshotLastMessageID != "a3" || planMulti.compactedCount != 4 || planMulti.keptCount != 2 {
		t.Fatalf("unexpected multi-turn plan: %+v", planMulti)
	}
	if len(planMulti.keptMessages) != 2 || planMulti.keptMessages[0].ID != "u3" {
		t.Fatalf("expected last turn [u3 a3] retained, got %+v", planMulti.keptMessages)
	}

	// Secondary compaction collapses prior checkpoint + intermediate messages while excluding checkpoint from compactedCount.
	secondary := []domain.Message{
		multiTurn[0], multiTurn[1],
		{ID: "c1", Role: domain.RoleCompaction, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeCompaction, Text: "## 核心目标与约束\nold summary"}}},
		multiTurn[2], multiTurn[3], multiTurn[4], multiTurn[5],
	}
	plan2, err := selectCompactionPlan(secondary)
	if err != nil {
		t.Fatalf("secondary selectCompactionPlan: %v", err)
	}
	if plan2.compactedCount != 2 || plan2.insertAfterMessageID != "a2" || plan2.keptCount != 2 {
		t.Fatalf("unexpected secondary compaction plan: %+v", plan2)
	}
	if len(plan2.promptMessages) != 3 || plan2.promptMessages[0].Role != domain.RoleUser || !strings.Contains(plan2.promptMessages[0].Blocks[0].Text, "old summary") {
		t.Fatalf("expected projected prior checkpoint at start of promptMessages, got %+v", plan2.promptMessages)
	}

	// Verify isomorphic estimator parity: "hello 世界" -> ceil(6/3.5 + 2/1.5) = ceil(1.714 + 1.333) = 4.
	if got := estimateTextTokens("hello 世界"); got != 4 {
		t.Fatalf("estimateTextTokens(%q) = %d, want 4", "hello 世界", got)
	}

	maxTok := 2048
	up := conversationUpstreamContext{
		conversation: domain.Conversation{ID: "c1"},
		provider:     domain.ProviderConfig{ID: "p1"},
		model:        domain.ModelConfig{ID: "m1"},
		systemPrompt: "Be concise",
		params:       domain.GenerationParams{MaxTokens: &maxTok, ReasoningEffort: domain.EffortHigh},
		compat:       domain.CompatConfig{MaxTokensField: "max_tokens"},
		generationURL: "https://api.openai.com/v1/chat/completions",
	}
	chatIn := buildCompactionChatInput(up, planMulti.promptMessages)
	if chatIn.Tools != nil || chatIn.AutoCreateCache || chatIn.PromptCache != nil || chatIn.Params.ReasoningEffort != "" {
		t.Fatalf("unexpected buildCompactionChatInput flags: %+v", chatIn)
	}
	if chatIn.Compat.MaxTokensField != "max_tokens" || chatIn.GenerationURL != "https://api.openai.com/v1/chat/completions" {
		t.Fatalf("expected Compat and GenerationURL preserved, got compat=%+v url=%q", chatIn.Compat, chatIn.GenerationURL)
	}
	lastMsg := chatIn.Messages[len(chatIn.Messages)-1]
	if lastMsg.Role != domain.RoleUser || !strings.Contains(lastMsg.Blocks[0].Text, "## 核心目标与约束") {
		t.Fatalf("expected trailing compactionInstruction prompt, got %+v", lastMsg)
	}
}

func TestChatServiceCompactAndProjectionWithMCPAndUndo(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	var capturedBodies []map[string]any
	mode := "compact" // "compact" | "fail" | "empty" | "chat_mcp"
	chatRound := 0

	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		curMode := mode
		capturedBodies = append(capturedBodies, body)
		if curMode == "chat_mcp" {
			chatRound++
		}
		round := chatRound
		mu.Unlock()

		if curMode == "fail" {
			http.Error(w, "upstream down", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)

		switch curMode {
		case "empty":
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking only\"},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		case "compact":
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"internal thoughts\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"## 核心目标与约束\\n保留历史约束\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":500,\"completion_tokens\":80,\"total_tokens\":580}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		case "chat_mcp":
			if round == 1 {
				tools := body["tools"].([]any)
				alias := tools[0].(map[string]any)["function"].(map[string]any)["name"].(string)
				_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}}]}}]}\n\n", alias)
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":300,\"completion_tokens\":20,\"total_tokens\":320}}\n\n")
			} else {
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Final reply after MCP\"}}]}\n\n")
				_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":400,\"completion_tokens\":30,\"total_tokens\":430}}\n\n")
			}
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		}
		flusher.Flush()
	}))
	defer llmSrv.Close()

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	mcpStore := store.NewMCPServerStore(db)
	mcpClient := &compactStubMCPClient{}

	_, err = provStore.Create(ctx, domain.ProviderConfig{
		ID:       "prov-1",
		Name:     "Fake OpenAI",
		Adapter:  provider.AdapterGenericHTTP,
		BaseURL:  llmSrv.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-secret",
		Enabled:  true,
		Models: []domain.ModelConfig{
			{ID: "gpt-test", Name: "GPT Test", APIFormat: format.FormatIDOpenAICompletions, Compat: domain.CompatConfig{MaxTokensField: "max_tokens"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mcpStore.Create(ctx, domain.MCPServerConfig{
		ID: "srv1", Name: "srv1", Transport: domain.MCPTransportStdio, Command: "mock", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	conv, err := convStore.Create(ctx, domain.Conversation{
		ID:          "conv-compact",
		AssistantID: domain.DefaultAssistantID,
		Title:       "Compact Topic",
		ProviderID:  "prov-1",
		ModelID:     "gpt-test",
		SystemPrompt: "System guide",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Seed 2 turns (4 messages).
	seed := []domain.Message{
		{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ANCIENT_USER_TURN"}}},
		{ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ANCIENT_ASSISTANT_TURN"}}, Usage: &domain.Usage{InputTokens: 100, OutputTokens: 50, TotalTokens: 150, ContextTokens: 150}},
		{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "RETAINED_USER_TURN"}}},
		{ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "RETAINED_ASSISTANT_TURN"}}, Usage: &domain.Usage{InputTokens: 800, OutputTokens: 100, TotalTokens: 900, ContextTokens: 900}},
	}
	for _, m := range seed {
		if _, err := msgStore.Create(ctx, m); err != nil {
			t.Fatal(err)
		}
	}

	svc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).WithMCP(mcpStore, mcpClient)
	convSvc := NewConversationService(convStore, msgStore)

	// 1. Upstream failure and empty summary must not mutate SQLite.
	mode = "fail"
	if _, err := svc.Compact(ctx, CompactConversationInput{ConversationID: conv.ID}); err == nil {
		t.Fatal("expected upstream failure error")
	}
	mode = "empty"
	if _, err := svc.Compact(ctx, CompactConversationInput{ConversationID: conv.ID}); err == nil {
		t.Fatal("expected empty summary error")
	}
	if afterFail, _ := msgStore.ListByConversation(ctx, conv.ID); len(afterFail) != 4 {
		t.Fatalf("expected 4 untouched messages on failed compact, got %d", len(afterFail))
	}

	// 2. Successful gateway compaction.
	mode = "compact"
	mu.Lock()
	capturedBodies = nil
	mu.Unlock()

	res, err := svc.Compact(ctx, CompactConversationInput{ConversationID: conv.ID})
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if res.Message.Role != domain.RoleCompaction || res.Meta.CompactedCount != 2 || res.Meta.BeforeTokens != 900 || res.Meta.AfterTokens <= 0 {
		t.Fatalf("unexpected Compact result: msg=%+v meta=%+v", res.Message, res.Meta)
	}
	if len(res.Messages) != 5 || res.Messages[2].Role != domain.RoleCompaction {
		t.Fatalf("expected checkpoint inserted between turn 1 and retained turn 2, got %+v", res.Messages)
	}
	if strings.Contains(res.Message.Blocks[0].Text, "internal thoughts") {
		t.Fatalf("thinking block leaked into compaction summary: %q", res.Message.Blocks[0].Text)
	}

	// Verify compaction request carried no tools and included system + turn 1 + compactionInstruction.
	mu.Lock()
	compactReqBody := capturedBodies[0]
	capturedBodies = nil
	mu.Unlock()
	if _, hasTools := compactReqBody["tools"]; hasTools {
		t.Fatalf("compaction request must not include tools, got %+v", compactReqBody["tools"])
	}

	// 3. Subsequent chat with 2-round MCP tool calls must only send checkpoint + retained tail + new turn in BOTH rounds.
	mode = "chat_mcp"
	prep, err := svc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, Text: "NEW_QUESTION"})
	if err != nil {
		t.Fatalf("Prepare post-compact: %v", err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream post-compact: %v", err)
	}

	mu.Lock()
	if len(capturedBodies) != 2 {
		mu.Unlock()
		t.Fatalf("expected 2 LLM requests for 2-round MCP, got %d", len(capturedBodies))
	}
	round1JSON, _ := json.Marshal(capturedBodies[0])
	round2JSON, _ := json.Marshal(capturedBodies[1])
	mu.Unlock()

	for roundIdx, raw := range []string{string(round1JSON), string(round2JSON)} {
		if strings.Contains(raw, "ANCIENT_USER_TURN") || strings.Contains(raw, "ANCIENT_ASSISTANT_TURN") {
			t.Fatalf("round %d unexpectedly leaked pre-checkpoint history: %s", roundIdx+1, raw)
		}
		if !strings.Contains(raw, "保留历史约束") || !strings.Contains(raw, "RETAINED_USER_TURN") || !strings.Contains(raw, "NEW_QUESTION") {
			t.Fatalf("round %d missing checkpoint or retained tail: %s", roundIdx+1, raw)
		}
	}

	// 4. Deleting checkpoint restores full history in next upstream request.
	if err := convSvc.DeleteMessage(ctx, conv.ID, res.Message.ID); err != nil {
		t.Fatalf("DeleteMessage checkpoint: %v", err)
	}
	mu.Lock()
	capturedBodies = nil
	chatRound = 1 // skip tool round for quick final reply
	mu.Unlock()
	prepRestored, err := svc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, Text: "AFTER_UNDO"})
	if err != nil {
		t.Fatalf("Prepare after undo: %v", err)
	}
	_ = prepRestored.Stream(ctx, func(domain.StreamEvent) error { return nil })
	mu.Lock()
	restoredJSON, _ := json.Marshal(capturedBodies[0])
	mu.Unlock()
	if !strings.Contains(string(restoredJSON), "ANCIENT_USER_TURN") {
		t.Fatalf("expected deleting checkpoint to restore original history, got %s", restoredJSON)
	}
}

func TestPrepareLocalCompactAndCreateMessage(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)

	_, err = provStore.Create(ctx, domain.ProviderConfig{
		ID:           "local-p",
		Name:         "Local Provider",
		Adapter:      provider.AdapterGenericHTTP,
		BaseURL:      "http://127.0.0.1:11434",
		AuthType:     domain.AuthTypeBearer,
		APIKey:       "sk-local-secret",
		Enabled:      true,
		LocalRequest: true,
		Models: []domain.ModelConfig{
			{ID: "qwen", Name: "Qwen", APIFormat: format.FormatIDOpenAICompletions},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	conv, err := convStore.Create(ctx, domain.Conversation{
		ID: "conv-local", AssistantID: domain.DefaultAssistantID, Title: "New Chat", ProviderID: "local-p", ModelID: "qwen",
	})
	if err != nil {
		t.Fatal(err)
	}
	m1, _ := msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}}})
	m2, _ := msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a1"}}})
	_, _ = msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u2"}}})
	m4, _ := msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a2"}}})
	_ = m1

	svc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{})
	noCred, err := svc.PrepareLocalCompact(ctx, CompactConversationInput{ConversationID: conv.ID, CredentialEnvelope: false})
	if err != nil {
		t.Fatalf("PrepareLocalCompact no-cred: %v", err)
	}
	if noCred.Request.Headers["Authorization"] != "" {
		t.Fatalf("expected credential-free prepare-local-compact to omit Authorization, got %+v", noCred.Request.Headers)
	}
	if noCred.Plan.InsertAfterMessageID != m2.ID || noCred.Plan.SnapshotLastMessageID != m4.ID || noCred.Plan.CompactedCount != 2 {
		t.Fatalf("unexpected prepare-local plan: %+v", noCred.Plan)
	}

	withCred, err := svc.PrepareLocalCompact(ctx, CompactConversationInput{ConversationID: conv.ID, CredentialEnvelope: true})
	if err != nil {
		t.Fatalf("PrepareLocalCompact with-cred: %v", err)
	}
	if withCred.Request.Headers["Authorization"] != "Bearer sk-local-secret" {
		t.Fatalf("expected credential envelope Authorization header, got %+v", withCred.Request.Headers)
	}

	convSvc := NewConversationService(convStore, msgStore)
	if _, err := convSvc.CreateMessage(ctx, conv.ID, CreateMessageInput{
		Role:   domain.RoleCompaction,
		Blocks: []domain.ContentBlock{{Type: domain.BlockTypeCompaction, Text: "   "}},
	}); err == nil {
		t.Fatal("expected blank compaction block text to fail")
	}

	created, err := convSvc.CreateMessage(ctx, conv.ID, CreateMessageInput{
		Role:           domain.RoleCompaction,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeCompaction, Text: "## 核心目标与约束\nok"}},
		AfterMessageID: m2.ID,
		Usage:          &domain.Usage{InputTokens: 200, OutputTokens: 40, TotalTokens: 240},
	})
	if err != nil {
		t.Fatalf("CreateMessage compaction: %v", err)
	}
	if created.Conversation.Title != "New Chat" || created.Message.Role != domain.RoleCompaction {
		t.Fatalf("unexpected CreateMessage compaction result: %+v", created)
	}
}
