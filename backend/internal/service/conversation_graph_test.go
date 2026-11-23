package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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
