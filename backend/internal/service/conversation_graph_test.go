package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/store"
)

func TestGraphUpstreamAndCompactionIsolation(t *testing.T) {
	ctx := t.Context()
	requests := make(chan []string, 4)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []struct {
				Role    string
				Content string
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		var text []string
		for _, msg := range input.Messages {
			if msg.Role != "system" {
				text = append(text, msg.Content)
			}
		}
		requests <- text
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"result"},"finish_reason":"stop"}]}

data: [DONE]

`)
	}))
	defer up.Close()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	ps, cs, ms := store.NewProviderStore(db), store.NewConversationStore(db), store.NewMessageStore(db)
	_, err = ps.Create(ctx, domain.ProviderConfig{ID: "provider", Name: "Test upstream", Adapter: provider.AdapterGenericHTTP, BaseURL: up.URL, AuthType: domain.AuthTypeBearer, APIKey: "test", Enabled: true, Models: []domain.ModelConfig{{ID: "model", APIFormat: format.FormatIDOpenAICompletions}}})
	must(err)
	conv, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "Graph", ProviderID: "provider", ModelID: "model"})
	must(err)
	for i, id := range []string{"U1", "A1", "U2", "A2", "U3", "A3"} {
		role := domain.RoleUser
		if i%2 == 1 {
			role = domain.RoleAssistant
		}
		_, err := ms.Create(ctx, domain.Message{ID: id, ConversationID: conv.ID, Role: role, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: id}}})
		must(err)
	}
	mutate := func(in store.GraphMutationInput) { t.Helper(); must(cs.ApplyGraphMutation(ctx, conv.ID, in)) }
	fork := "A1"
	mutate(store.GraphMutationInput{Op: "reparent", MessageID: "U3", ParentID: &fork})
	formats, adapters := plugin.NewFormatRegistry(), plugin.NewProviderRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters.MustRegister(provider.NewGenericHTTPAdapter())
	svc := NewChatService(ps, cs, ms, formats, adapters, up.Client())
	prep, err := svc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, Text: "follow"})
	must(err)
	must(prep.Stream(ctx, func(domain.StreamEvent) error { return nil }))
	if got := <-requests; !slices.Equal(got, []string{"U1", "A1", "U3", "A3", "follow"}) {
		t.Fatalf("wrong branch history: %v", got)
	}
	compact, err := svc.Compact(ctx, CompactConversationInput{ConversationID: conv.ID})
	must(err)
	if got := <-requests; slices.Contains(got, "U2") || slices.Contains(got, "A2") {
		t.Fatalf("compaction leaked sibling: %v", got)
	}
	if compact.Message.ParentID != "A3" {
		t.Fatalf("checkpoint did not splice selected branch: %+v", compact.Message)
	}
	mutate(store.GraphMutationInput{Op: "activateBranch", LeafMessageID: "A2"})
	prep, err = svc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, Text: "sibling"})
	must(err)
	must(prep.Stream(ctx, func(domain.StreamEvent) error { return nil }))
	if got := <-requests; !slices.Equal(got, []string{"U1", "A1", "U2", "A2", "sibling"}) {
		t.Fatalf("compaction modified sibling: %v", got)
	}
	// Regenerating a user on the selected branch replaces its child in place.
	regen, err := svc.PrepareLocal(ctx, StreamChatInput{ConversationID: conv.ID, RegenerateMessageID: "U2"})
	must(err)
	if regen.ReplaceMessageID != "A2" || regen.InsertAfterMessageID != "" {
		t.Fatalf("bad retry target: %+v", regen)
	}
	svcConv := NewConversationService(cs, ms)
	cloned, err := svcConv.BranchFromMessage(ctx, conv.ID, "A2")
	must(err)
	var cloneTexts []string
	for _, msg := range cloned.Messages {
		cloneTexts = append(cloneTexts, msg.Blocks[0].Text)
	}
	if !slices.Equal(cloneTexts, []string{"U1", "A1", "U2", "A2"}) {
		t.Fatalf("clone leaked other branches: %v", cloneTexts)
	}

	mutate(store.GraphMutationInput{Op: "createBranch", Activate: true})
	local, err := svc.PrepareLocal(ctx, StreamChatInput{ConversationID: conv.ID, Text: "blank"})
	must(err)
	if local.ParentID == nil || *local.ParentID != "" || local.ConsumeBranchID == "" {
		t.Fatalf("bad browser write anchor: %+v", local)
	}
	var body struct {
		Messages []struct {
			Role    string
			Content string
		}
	}
	must(json.Unmarshal(local.Body, &body))
	var users []string
	for _, msg := range body.Messages {
		if msg.Role == "user" {
			users = append(users, msg.Content)
		}
	}
	if !slices.Equal(users, []string{"blank"}) {
		t.Fatalf("blank branch inherited history: %v", users)
	}

	mutate(store.GraphMutationInput{Op: "createBranch", ParentMessageID: "U2", Activate: true})
	prep, err = svc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, RegenerateMessageID: "U2"})
	must(err)
	must(prep.Stream(ctx, func(domain.StreamEvent) error { return nil }))
	if got := <-requests; !slices.Equal(got, []string{"U1", "A1", "U2"}) {
		t.Fatalf("branch retry included a sibling: %v", got)
	}
	detail, err := svcConv.GetDetail(ctx, conv.ID)
	must(err)
	path := resolveActiveBranchPath(detail.Conversation, detail.Messages)
	if len(path) != 4 || path[3].ParentID != "U2" || path[3].ID == "A2" || detail.Conversation.GraphState.ActiveBranchID == "" {
		t.Fatalf("retry did not advance its own branch anchor: %+v", path)
	}
}

type fakeSearchEngine struct {
	lastQuery string
}

func (f *fakeSearchEngine) ID() string              { return "fake-search" }
func (f *fakeSearchEngine) DisplayName() string     { return "Fake Search" }
func (f *fakeSearchEngine) DefaultEndpoint() string { return "https://search.example" }
func (f *fakeSearchEngine) RequiresAPIKey() bool    { return false }
func (f *fakeSearchEngine) Search(_ context.Context, in plugin.SearchQueryInput) ([]plugin.SearchResult, error) {
	f.lastQuery = in.Query
	return []plugin.SearchResult{{Title: "Result", URL: "https://example.com", Snippet: "search-snippet"}}, nil
}

func TestExpandSideReferencesSingleNodeScope(t *testing.T) {
	all := []domain.Message{
		{ID: "U1", ConversationID: "c1", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}}},
		{ID: "A1", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "U1", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a1"}}},
		{ID: "U2", ConversationID: "c1", Role: domain.RoleUser, ParentID: "A1", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u2"}},
			GraphMeta: &domain.MessageGraphMeta{SideRefs: []domain.MessageSideRef{
				{SourceMessageID: "A2", Side: "left", Scope: domain.SideRefScopeNode},
				{SourceMessageID: "U2", Side: "right", Scope: domain.SideRefScopeNode},
				{SourceMessageID: "A1", Side: "right", Scope: domain.SideRefScopeNode},
			}}},
		{ID: "A2", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "U2", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a2"}}},
	}
	active := []domain.Message{all[0], all[1], all[2], all[3]}
	expanded := expandSideReferences(all, active)
	if len(expanded) != 5 {
		t.Fatalf("expected 5 messages, got %d", len(expanded))
	}
	// Main ancestors are skipped, and only the single node itself is injected
	// (no A2 walk up to U2), so A1 must not appear.
	want := "<reference_materials>\na2\n</reference_materials>"
	if got := expanded[3].Blocks[0].Text; got != want {
		t.Fatalf("node scope text mismatch:\ngot:  %q\nwant: %q", got, want)
	}
	if strings.Contains(expanded[3].Blocks[0].Text, "a1") || strings.Contains(expanded[3].Blocks[0].Text, "u2") {
		t.Fatalf("node scope leaked ancestors: %q", expanded[3].Blocks[0].Text)
	}
}

func TestExpandSideReferencesAndFourProtocols(t *testing.T) {
	ctx := t.Context()
	// Unit test expandSideReferences directly:
	// Main: U1 -> A1 -> U2 -> A2
	// Forked branch off A1: U3 -> A3 (with nested sideRef to A5 that must NOT be expanded recursively)
	// Independent branch: U4 -> A4
	// Empty-assistant branch: U6 (user only)
	all := []domain.Message{
		{ID: "U1", ConversationID: "c1", Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}}},
		{ID: "A1", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "U1", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "shared-a1"}}},
		{ID: "U2", ConversationID: "c1", Role: domain.RoleUser, ParentID: "A1", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u2"}},
			GraphMeta: &domain.MessageGraphMeta{SideRefs: []domain.MessageSideRef{
				{SourceMessageID: "A3", Side: "left"},
				{SourceMessageID: "A4", Side: "right"},
				{SourceMessageID: "U6", Side: "left"},
			}}},
		{ID: "A2", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "U2", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a2"}}},
		{ID: "U3", ConversationID: "c1", Role: domain.RoleUser, ParentID: "A1", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ignored-u3"}}},
		{ID: "A3", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "U3", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "fork-a3"}},
			GraphMeta: &domain.MessageGraphMeta{SideRefs: []domain.MessageSideRef{{SourceMessageID: "A5"}}}},
		{ID: "U4", ConversationID: "c1", Role: domain.RoleUser, ParentID: "", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "ignored-u4"}}},
		{ID: "A4", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "U4", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "indep-a4"}}},
		{ID: "A5", ConversationID: "c1", Role: domain.RoleAssistant, ParentID: "", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "nested-a5-must-not-appear"}}},
		{ID: "U6", ConversationID: "c1", Role: domain.RoleUser, ParentID: "", Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "user-only-u6"}}},
	}
	active := []domain.Message{all[0], all[1], all[2], all[3]}
	expanded := expandSideReferences(all, active)
	if len(expanded) != 5 {
		t.Fatalf("expected 5 messages (4 main + 1 ref), got %d", len(expanded))
	}
	refMsg := expanded[3]
	if refMsg.Role != domain.RoleUser || len(refMsg.Blocks) != 1 {
		t.Fatalf("unexpected refMsg: %+v", refMsg)
	}
	wantRef := "<reference_materials>\nfork-a3\n\n---\n\nindep-a4\n</reference_materials>"
	if refMsg.Blocks[0].Text != wantRef {
		t.Fatalf("ref text mismatch:\ngot:  %q\nwant: %q", refMsg.Blocks[0].Text, wantRef)
	}

	// Verify all 4 protocol encoders accept the expanded history with consecutive User messages.
	prov := domain.ProviderConfig{ID: "p", BaseURL: "https://example.com", AuthType: domain.AuthTypeBearer, APIKey: "k"}
	allFormats := []plugin.APIFormat{
		format.NewOpenAICompletionsFormat(),
		format.NewOpenAIResponsesFormat(),
		format.NewAnthropicMessagesFormat(),
		format.NewGoogleGenAIFormat(),
	}
	for _, f := range allFormats {
		req, err := f.EncodeRequest(ctx, plugin.ChatInput{
			ConversationID: "c1",
			Provider:       prov,
			Model:          domain.ModelConfig{ID: "m1", APIFormat: f.ID()},
			Messages:       expanded,
		})
		if err != nil {
			t.Fatalf("format %s encode failed: %v", f.ID(), err)
		}
		if !slices.Contains([]bool{true}, len(req.Body) > 0) || !containsBytes(req.Body, "fork-a3") || !containsBytes(req.Body, "indep-a4") {
			t.Fatalf("format %s body missing reference_materials: %s", f.ID(), string(req.Body))
		}
	}

	// End-to-end Prepare + WebSearch + Compact with sideRefs.
	var captured []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		captured = body.Messages
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer up.Close()

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ps, cs, ms := store.NewProviderStore(db), store.NewConversationStore(db), store.NewMessageStore(db)
	searchCfgStore := store.NewSearchConfigStore(db)
	_, _ = ps.Create(ctx, domain.ProviderConfig{
		ID: "p1", Name: "P", Adapter: provider.AdapterGenericHTTP, BaseURL: up.URL, AuthType: domain.AuthTypeBearer, APIKey: "k", Enabled: true,
		Models: []domain.ModelConfig{{ID: "m1", APIFormat: format.FormatIDOpenAICompletions}},
	})
	_, _ = searchCfgStore.Upsert(ctx, domain.SearchEngineConfig{EngineID: "fake-search", Enabled: true, IsDefault: true})
	conv, _ := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "SR", ProviderID: "p1", ModelID: "m1"})
	_, _ = ms.Create(ctx, domain.Message{ID: "u1", ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "real-user-question"}}})
	_, _ = ms.Create(ctx, domain.Message{ID: "a1", ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "main-a1"}}, Usage: &domain.Usage{ContextTokens: 100}})
	_, _ = ms.Create(ctx, domain.Message{ID: "u2", ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "side-u2"}}})
	_, _ = ms.Create(ctx, domain.Message{ID: "a2", ConversationID: conv.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "side-assistant-insight"}}})

	// Disconnect u2 to make (u2->a2) an independent branch, keep main leaf at a1, attach a2 to u1.
	empty := ""
	_ = cs.ApplyGraphMutation(ctx, conv.ID, store.GraphMutationInput{Op: "reparent", MessageID: "u2", ParentID: &empty})
	_ = cs.ApplyGraphMutation(ctx, conv.ID, store.GraphMutationInput{Op: "activateBranch", LeafMessageID: "a1"})
	_ = cs.ApplyGraphMutation(ctx, conv.ID, store.GraphMutationInput{Op: "addSideRef", MessageID: "u1", SourceMessageID: "a2", Side: "left"})

	formats, adapters := plugin.NewFormatRegistry(), plugin.NewProviderRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters.MustRegister(provider.NewGenericHTTPAdapter())
	searchReg := plugin.NewSearchRegistry()
	fakeSearch := &fakeSearchEngine{}
	searchReg.MustRegister(fakeSearch)
	svc := NewChatService(ps, cs, ms, formats, adapters, up.Client()).WithSearch(searchReg, searchCfgStore)

	// Regenerate u1 with WebSearch=true: query must be "real-user-question" and search results attached to u1 (NOT <reference_materials>).
	prep, err := svc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, RegenerateMessageID: "u1", WebSearch: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if fakeSearch.lastQuery != "real-user-question" {
		t.Fatalf("web search query hijacked: got %q", fakeSearch.lastQuery)
	}
	if len(captured) != 2 || captured[0].Role != "user" || !containsString(captured[0].Content, "search-snippet") || containsString(captured[0].Content, "<reference_materials>") {
		t.Fatalf("search context misattached: %+v", captured)
	}
	if captured[1].Role != "user" || !containsString(captured[1].Content, "<reference_materials>") || containsString(captured[1].Content, "search-snippet") {
		t.Fatalf("reference_materials polluted: %+v", captured)
	}

	// Compact must include side-ref in promptMessages and beforeTokens must account for side-ref on anchor a1.
	_ = cs.ApplyGraphMutation(ctx, conv.ID, store.GraphMutationInput{Op: "addSideRef", MessageID: "a1", SourceMessageID: "a2", Side: "right"})
	prepCompact, err := svc.prepareCompactionUpstream(ctx, CompactConversationInput{ConversationID: conv.ID}, false)
	if err != nil {
		t.Fatal(err)
	}
	if prepCompact.plan.beforeTokens <= 100 {
		t.Fatalf("expected beforeTokens > 100 when anchor a1 has sideRef, got %d", prepCompact.plan.beforeTokens)
	}
	foundRefInCompact := false
	for _, m := range prepCompact.plan.promptMessages {
		for _, b := range m.Blocks {
			if containsString(b.Text, "side-assistant-insight") {
				foundRefInCompact = true
			}
		}
	}
	if !foundRefInCompact {
		t.Fatalf("compaction promptMessages missing side-ref content: %+v", prepCompact.plan.promptMessages)
	}
}

func containsBytes(b []byte, sub string) bool {
	return containsString(string(b), sub)
}

func containsString(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexString(s, sub) >= 0)
}

func indexString(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
