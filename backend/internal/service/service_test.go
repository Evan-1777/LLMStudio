package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
	"llmstudio/backend/internal/store"
)

func setupServiceTestEnv(t *testing.T) (
	*ProviderService,
	*AssistantService,
	*ConversationService,
	*PluginService,
	*ChatService,
	*store.MessageStore,
) {
	t.Helper()
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
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

	return NewProviderService(provStore, formats, adapters),
		NewAssistantService(assistStore),
		NewConversationService(convStore, msgStore).WithAssistants(assistStore),
		NewPluginService(searchReg, searchStore, mcpStore),
		NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
			WithAssistants(assistStore).
			WithSearch(searchReg, searchStore),
		msgStore
}

func TestProviderProbeAndModelDiscoveryThreeFormats(t *testing.T) {
	ctx := context.Background()
	provSvc, _, _, _, _, _ := setupServiceTestEnv(t)

	// 1. OpenAI format (/v1/models) using stored apiKey without plaintext override.
	oaiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer sk-stored-oai" {
			t.Fatalf("unexpected openai request: path=%s auth=%s", r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "gpt-4o"},
				{"id": "openai/o3-mini"},
				{"id": "standalone"},
			},
		})
	}))
	defer oaiSrv.Close()

	pOAI, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-oai",
		Name:     "OpenAI Mock",
		Adapter:  "generic-http",
		BaseURL:  oaiSrv.URL + "/v1",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-stored-oai",
		Models:   []domain.ModelConfig{{ID: "gpt-4o", Name: "GPT-4o", APIFormat: "openai-responses"}},
	})
	if err != nil {
		t.Fatalf("create pOAI: %v", err)
	}
	probeRes, err := provSvc.TestConnection(ctx, pOAI.ID, ProviderProbeInput{})
	if err != nil || !probeRes.OK || probeRes.ModelCount != 3 || probeRes.Message != "连接正常" {
		t.Fatalf("unexpected probeRes: err=%v res=%+v", err, probeRes)
	}
	models, err := provSvc.FetchUpstreamModels(ctx, pOAI.ID, ProviderProbeInput{})
	if err != nil || len(models) != 3 {
		t.Fatalf("unexpected openai models: err=%v models=%+v", err, models)
	}
	if models[0].Group != "gpt" || models[1].Group != "openai" || models[2].Group != "other" {
		t.Fatalf("unexpected group derivation: %+v", models)
	}

	// 2. Anthropic format (/v1/models + anthropic-version).
	antSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("x-api-key") != "ant-key" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Fatalf("unexpected anthropic request: path=%s headers=%v", r.URL.Path, r.Header)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "claude-sonnet-4-5", "display_name": "Claude Sonnet 4.5"},
			},
		})
	}))
	defer antSrv.Close()

	_, err = provSvc.Create(ctx, ProviderInput{
		ID:       "p-ant",
		Name:     "Anthropic Mock",
		Adapter:  "generic-http",
		BaseURL:  antSrv.URL,
		AuthType: domain.AuthTypeXAPIKey,
		APIKey:   "ant-key",
	})
	if err != nil {
		t.Fatalf("create pAnt: %v", err)
	}
	antModels, err := provSvc.FetchUpstreamModels(ctx, "p-ant", ProviderProbeInput{})
	if err != nil || len(antModels) != 1 || antModels[0].APIFormat != "anthropic-messages" || antModels[0].Name != "Claude Sonnet 4.5" {
		t.Fatalf("unexpected anthropic models: err=%v models=%+v", err, antModels)
	}

	// 3. Google Gemini format (/v1beta/models?key=...).
	gemSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" || r.URL.Query().Get("key") != "gem-key" {
			t.Fatalf("unexpected gemini request: path=%s query=%v", r.URL.Path, r.URL.Query())
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]any{
				{
					"name":             "models/gemini-2.5-flash",
					"displayName":      "Gemini 2.5 Flash",
					"inputTokenLimit":  1048576,
					"outputTokenLimit": 65536,
					"thinking":         true,
				},
			},
		})
	}))
	defer gemSrv.Close()

	_, err = provSvc.Create(ctx, ProviderInput{
		ID:       "p-gem",
		Name:     "Gemini Mock",
		Adapter:  "generic-http",
		BaseURL:  gemSrv.URL + "/v1beta",
		AuthType: domain.AuthTypeQueryKey,
		APIKey:   "gem-key",
	})
	if err != nil {
		t.Fatalf("create pGem: %v", err)
	}
	gemModels, err := provSvc.FetchUpstreamModels(ctx, "p-gem", ProviderProbeInput{})
	if err != nil || len(gemModels) != 1 || gemModels[0].ID != "gemini-2.5-flash" || !gemModels[0].Reasoning || gemModels[0].APIFormat != "google-generative-ai" {
		t.Fatalf("unexpected gemini models: err=%v models=%+v", err, gemModels)
	}
}

func TestAssistantBranchingDeleteAndUserRetryWithSearch(t *testing.T) {
	ctx := context.Background()
	provSvc, assistSvc, convSvc, pluginSvc, chatSvc, msgStore := setupServiceTestEnv(t)

	var seenPrompts []string
	var seenUserTurns int
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		seenUserTurns = 0
		for _, m := range body.Messages {
			if m.Role == "developer" || m.Role == "system" {
				seenPrompts = append(seenPrompts, fmt.Sprint(m.Content))
			}
			if m.Role == "user" {
				seenUserTurns++
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"reply\"},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer llmSrv.Close()

	_, err := provSvc.Create(ctx, ProviderInput{
		ID:       "mock-p",
		Name:     "Mock",
		Adapter:  "generic-http",
		BaseURL:  llmSrv.URL,
		AuthType: domain.AuthTypeNone,
		Models:   []domain.ModelConfig{{ID: "m1", Name: "M1", APIFormat: "openai-completions"}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	assistant, err := assistSvc.Create(ctx, AssistantInput{
		Name:              "Researcher",
		SystemPrompt:      "Cite sources.",
		DefaultProviderID: "mock-p",
		DefaultModelID:    "m1",
	})
	if err != nil {
		t.Fatalf("create assistant: %v", err)
	}
	if err := assistSvc.Delete(ctx, domain.DefaultAssistantID); err == nil {
		t.Fatal("expected deleting default assistant to fail")
	}

	// Conversation inherits assistant default provider/model.
	conv, err := convSvc.Create(ctx, CreateConversationInput{
		AssistantID: assistant.ID,
		Title:       "Research Topic",
	})
	if err != nil || conv.ProviderID != "mock-p" || conv.ModelID != "m1" {
		t.Fatalf("expected inherited provider/model, got err=%v conv=%+v", err, conv)
	}

	// Seed 3 messages and branch from message 2.
	m1, _ := msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Q1"}}})
	m2, _ := msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "A1"}}})
	m3, _ := msgStore.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Q2"}}})

	branched, err := convSvc.BranchFromMessage(ctx, conv.ID, m2.ID)
	if err != nil {
		t.Fatalf("branch failed: %v", err)
	}
	if branched.Conversation.Title != "Research Topic (分支)" || len(branched.Messages) != 2 || branched.Messages[0].ID == m1.ID {
		t.Fatalf("unexpected branch detail: %+v", branched)
	}

	// DeleteMessage removes only m3 in original conversation.
	if err := convSvc.DeleteMessage(ctx, conv.ID, m3.ID); err != nil {
		t.Fatalf("DeleteMessage failed: %v", err)
	}
	origDetail, _ := convSvc.GetDetail(ctx, conv.ID)
	if len(origDetail.Messages) != 2 {
		t.Fatalf("expected 2 messages after DeleteMessage, got %d", len(origDetail.Messages))
	}

	// Configure SearXNG search engine to test both success and error webSearch blocks.
	searchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"title": "Result 1", "url": "https://example.com/1", "content": "Snippet 1"},
			},
		})
	}))
	defer searchSrv.Close()

	enabled := true
	isDef := true
	if _, err := pluginSvc.UpdateSearchEngine(ctx, "searxng", SearchEngineUpdateInput{
		Enabled:   &enabled,
		Endpoint:  searchSrv.URL + "/search",
		IsDefault: &isDef,
	}); err != nil {
		t.Fatalf("update searxng: %v", err)
	}

	// Retry on user message m1 with webSearch=true: keeps m1, deletes m2, emits webSearch block at index 0.
	prep, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID:      conv.ID,
		RegenerateMessageID: m1.ID,
		WebSearch:           true,
	})
	if err != nil {
		t.Fatalf("Prepare user retry failed: %v", err)
	}
	var events []domain.StreamEvent
	if err := prep.Stream(ctx, func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("Stream failed: %v", err)
	}
	if seenUserTurns != 1 || len(seenPrompts) == 0 || !strings.Contains(seenPrompts[0], "Cite sources.") || !strings.Contains(seenPrompts[0], "Result 1") {
		t.Fatalf("expected assistant prompt + search results injected and user m1 kept: turns=%d prompts=%v", seenUserTurns, seenPrompts)
	}
	afterRetry, _ := convSvc.GetDetail(ctx, conv.ID)
	if len(afterRetry.Messages) != 2 || afterRetry.Messages[0].ID != m1.ID || len(afterRetry.Messages[1].Blocks) < 2 || afterRetry.Messages[1].Blocks[0].Type != domain.BlockTypeWebSearch {
		t.Fatalf("expected m1 kept and new assistant message with webSearch block, got %+v", afterRetry.Messages)
	}

	// Verify failed webSearch does not block stream and records error block.
	prepFail, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "No engine test",
		WebSearch:      true,
		SearchEngineID: "tavily", // missing required apiKey
	})
	if err != nil {
		t.Fatalf("Prepare failed-search should still proceed: %v", err)
	}
	var endMsg *domain.Message
	_ = prepFail.Stream(ctx, func(ev domain.StreamEvent) error {
		if ev.Type == domain.StreamEventMessageEnd {
			endMsg = ev.Message
		}
		return nil
	})
	if endMsg == nil || len(endMsg.Blocks) == 0 || endMsg.Blocks[0].Type != domain.BlockTypeWebSearch || !strings.Contains(string(endMsg.Blocks[0].Extra), `"error"`) {
		t.Fatalf("expected webSearch error block persisted, got %+v", endMsg)
	}
}

func TestConversationGroupsBatchAndReorder(t *testing.T) {
	ctx := context.Background()
	_, assistSvc, convSvc, _, _, msgStore := setupServiceTestEnv(t)

	otherAssist, err := assistSvc.Create(ctx, AssistantInput{Name: "Other"})
	if err != nil {
		t.Fatalf("create other assistant: %v", err)
	}
	otherConv, err := convSvc.Create(ctx, CreateConversationInput{AssistantID: otherAssist.ID, Title: "Other Conv"})
	if err != nil {
		t.Fatalf("create other conv: %v", err)
	}
	otherGroupRes, err := convSvc.CreateGroup(ctx, CreateGroupInput{AssistantID: otherAssist.ID, Name: "Other Group"})
	if err != nil {
		t.Fatalf("create other group: %v", err)
	}

	c1, _ := convSvc.Create(ctx, CreateConversationInput{AssistantID: domain.DefaultAssistantID, Title: "C1"})
	c2, _ := convSvc.Create(ctx, CreateConversationInput{AssistantID: domain.DefaultAssistantID, Title: "C2"})
	c3, _ := convSvc.Create(ctx, CreateConversationInput{AssistantID: domain.DefaultAssistantID, Title: "C3"})
	c4, _ := convSvc.Create(ctx, CreateConversationInput{AssistantID: domain.DefaultAssistantID, Title: "C4"})
	_, _ = msgStore.Create(ctx, domain.Message{ConversationID: c1.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "m1"}}})
	_, _ = msgStore.Create(ctx, domain.Message{ConversationID: c2.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "m2"}}})

	// Empty group name rejected.
	if _, err := convSvc.CreateGroup(ctx, CreateGroupInput{AssistantID: domain.DefaultAssistantID, Name: "   "}); err == nil {
		t.Fatal("expected empty group name to fail")
	}
	g1Res, err := convSvc.CreateGroup(ctx, CreateGroupInput{AssistantID: domain.DefaultAssistantID, Name: " Work "})
	if err != nil || g1Res.Group.Name != "Work" {
		t.Fatalf("create g1 failed: err=%v res=%+v", err, g1Res)
	}
	g2Res, err := convSvc.CreateGroup(ctx, CreateGroupInput{AssistantID: domain.DefaultAssistantID, Name: "Notes"})
	if err != nil {
		t.Fatalf("create g2 failed: %v", err)
	}
	renamedG1, err := convSvc.RenameGroup(ctx, g1Res.Group.ID, RenameGroupInput{Name: " Projects "})
	if err != nil || renamedG1.Group.ID != g1Res.Group.ID || renamedG1.Group.Name != "Projects" {
		t.Fatalf("rename g1 failed: err=%v res=%+v", err, renamedG1)
	}

	// Atomic batch delete: 2 valid + 1 cross-assistant ID must delete NOTHING.
	if _, err := convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID, c2.ID, otherConv.ID},
		Operation:   "delete",
	}); err == nil {
		t.Fatal("expected cross-assistant batch delete to fail")
	}
	if list, _ := convSvc.ListByAssistant(ctx, domain.DefaultAssistantID); len(list) != 4 {
		t.Fatalf("expected all 4 conversations preserved on failed batch delete, got %d", len(list))
	}

	// Move validation: omitted groupId, empty string groupId, cross-assistant groupId must fail.
	if _, err := convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID},
		Operation:   "move",
	}); err == nil {
		t.Fatal("expected move without groupId to fail")
	}
	if _, err := convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID},
		Operation:   "move",
		GroupID:     PatchField[string]{Set: true, Value: " "},
	}); err == nil {
		t.Fatal("expected move with empty groupId to fail")
	}
	if _, err := convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID},
		Operation:   "move",
		GroupID:     PatchField[string]{Set: true, Value: otherGroupRes.Group.ID},
	}); err == nil {
		t.Fatal("expected cross-assistant groupId move to fail")
	}
	if _, err := convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID},
		Operation:   "pin",
	}); err == nil {
		t.Fatal("expected pin without boolean to fail")
	}

	// Move C4, C2 (in canonical ungrouped order C4, C3, C2, C1) to g1 and deduplicate IDs.
	snap, err := convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c4.ID, c2.ID, c4.ID},
		Operation:   "move",
		GroupID:     PatchField[string]{Set: true, Value: g1Res.Group.ID},
	})
	if err != nil {
		t.Fatalf("batch move to g1 failed: %v", err)
	}
	// Canonical order: g1 (C4, C2), then ungrouped (C3, C1).
	if snap.Conversations[0].ID != c4.ID || snap.Conversations[1].ID != c2.ID ||
		snap.Conversations[2].ID != c3.ID || snap.Conversations[3].ID != c1.ID {
		t.Fatalf("unexpected order after move to g1: %+v", snap.Conversations)
	}

	// Pin C2 -> enters pinned bucket at top while keeping GroupID=g1; unpin restores to tail of g1.
	snap, err = convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c2.ID},
		Operation:   "pin",
		Pinned:      PatchField[bool]{Set: true, Value: true},
	})
	if err != nil {
		t.Fatalf("pin c2 failed: %v", err)
	}
	if !snap.Conversations[0].Pinned || snap.Conversations[0].ID != c2.ID ||
		snap.Conversations[0].GroupID == nil || *snap.Conversations[0].GroupID != g1Res.Group.ID {
		t.Fatalf("expected C2 pinned with GroupID preserved: %+v", snap.Conversations[0])
	}

	// Reorder C3 into pinned bucket before C2 (must omit groupId when pinned=true), verify C3 keeps GroupID=nil.
	snap, err = convSvc.ReorderConversations(ctx, ReorderConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c3.ID},
		Pinned:      PatchField[bool]{Set: true, Value: true},
		BeforeID:    PatchField[string]{Set: true, Value: c2.ID},
	})
	if err != nil {
		t.Fatalf("reorder into pinned bucket failed: %v", err)
	}
	if snap.Conversations[0].ID != c3.ID || !snap.Conversations[0].Pinned || snap.Conversations[0].GroupID != nil ||
		snap.Conversations[1].ID != c2.ID || !snap.Conversations[1].Pinned || *snap.Conversations[1].GroupID != g1Res.Group.ID {
		t.Fatalf("unexpected pinned order after reorder: %+v", snap.Conversations[:2])
	}

	// Unpin C2 -> returns to g1 after C4; delete g1 -> C4, C2 append to ungrouped tail after C1!
	snap, err = convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c2.ID},
		Operation:   "pin",
		Pinned:      PatchField[bool]{Set: true, Value: false},
	})
	if err != nil {
		t.Fatalf("unpin c2 failed: %v", err)
	}
	// Canonical: pinned (C3), g1 (C4, C2), ungrouped (C1).
	if snap.Conversations[0].ID != c3.ID || snap.Conversations[1].ID != c4.ID ||
		snap.Conversations[2].ID != c2.ID || snap.Conversations[3].ID != c1.ID {
		t.Fatalf("unexpected order after unpin c2: %+v", snap.Conversations)
	}

	// Move C2 to ungrouped explicitly with groupId: null, placed after C1.
	snap, err = convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c2.ID},
		Operation:   "move",
		GroupID:     PatchField[string]{Set: true, Null: true},
	})
	if err != nil {
		t.Fatalf("batch move to ungrouped failed: %v", err)
	}
	if snap.Conversations[2].ID != c1.ID || snap.Conversations[3].ID != c2.ID || snap.Conversations[3].GroupID != nil {
		t.Fatalf("expected C2 moved to ungrouped tail: %+v", snap.Conversations)
	}

	// Move C1 into g1 before C4 via reorder, then delete g1 -> C1, C4 move to ungrouped tail after C2!
	snap, err = convSvc.ReorderConversations(ctx, ReorderConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID},
		Pinned:      PatchField[bool]{Set: true, Value: false},
		GroupID:     PatchField[string]{Set: true, Value: g1Res.Group.ID},
		BeforeID:    PatchField[string]{Set: true, Value: c4.ID},
	})
	if err != nil {
		t.Fatalf("reorder c1 before c4 in g1 failed: %v", err)
	}
	delGroupRes, err := convSvc.DeleteGroup(ctx, g1Res.Group.ID)
	if err != nil {
		t.Fatalf("delete g1 failed: %v", err)
	}
	// Pinned: C3; Ungrouped: C2, C1, C4.
	if len(delGroupRes.Conversations) != 4 ||
		delGroupRes.Conversations[0].ID != c3.ID ||
		delGroupRes.Conversations[1].ID != c2.ID ||
		delGroupRes.Conversations[2].ID != c1.ID ||
		delGroupRes.Conversations[3].ID != c4.ID {
		t.Fatalf("unexpected order after DeleteGroup: %+v", delGroupRes.Conversations)
	}
	// Messages in C1 survived move & group deletion.
	if msgs, _ := msgStore.ListByConversation(ctx, c1.ID); len(msgs) != 1 {
		t.Fatalf("expected c1 message preserved, got %d", len(msgs))
	}

	// Valid batch delete removes C1 and C4 only.
	snap, err = convSvc.BatchConversations(ctx, BatchConversationsInput{
		AssistantID: domain.DefaultAssistantID,
		IDs:         []string{c1.ID, c4.ID},
		Operation:   "delete",
	})
	if err != nil || len(snap.Conversations) != 2 || len(snap.DeletedIDs) != 2 {
		t.Fatalf("batch delete failed: err=%v snap=%+v", err, snap)
	}
	_ = g2Res
}
