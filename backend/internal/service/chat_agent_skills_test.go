package service_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestChatServiceAgentInstructionsAndSkillToolAndPrefixStability(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("Workspace rule: always cite path."), 0600); err != nil {
		t.Fatal(err)
	}
	skillDir := filepath.Join(dir, ".agent", "skills", "deploy-check")
	if err := os.MkdirAll(filepath.Join(skillDir, "references"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: deploy-check\ndescription: Verify deployment readiness.\n---\n# Deploy Check\nRun smoke checks first.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "references", "checklist.md"), []byte("item 1"), 0600); err != nil {
		t.Fatal(err)
	}

	type capturedReq struct {
		System string
		Tools  []string
	}
	var mu sync.Mutex
	var captured []capturedReq
	turn := 0

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		var sys string
		for _, m := range body.Messages {
			if m.Role == "system" || m.Role == "developer" {
				sys = m.Content
				break
			}
		}
		var toolNames []string
		for _, tl := range body.Tools {
			toolNames = append(toolNames, tl.Function.Name)
		}
		mu.Lock()
		turn++
		curTurn := turn
		captured = append(captured, capturedReq{System: sys, Tools: toolNames})
		mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		if curTurn == 1 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_skill","function":{"name":"skill","arguments":"{\"name\":\"deploy-check\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		// Echo whether skill result reached upstream in tool role message.
		last := body.Messages[len(body.Messages)-1]
		if last.Role == "tool" && strings.Contains(last.Content, "Run smoke checks first.") {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"skill-verified"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"plain-reply"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	svc, convs, msgs, _, conv, db := setupChatMCPFixture(t, upstream.URL, &stubMCPClient{})
	conv.Mode = domain.ConversationModeAgent
	conv.SystemPrompt = "Base system prompt."
	if _, err := convs.Update(ctx, conv); err != nil {
		t.Fatal(err)
	}
	rt := agent.NewGateway(store.NewAgentStore(db), dir, true)
	allowed := []string{"skill"}
	if _, err := rt.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatal(err)
	}
	svc.WithAgent(rt)

	// 1. First Agent turn triggers skill tool call and continuation.
	prep, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "check deploy"})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}

	history, err := msgs.ListByConversation(ctx, conv.ID)
	if err != nil || len(history) != 2 {
		t.Fatalf("history len=%d err=%v", len(history), err)
	}
	var sawNativeSkillResult, sawFinalText bool
	for _, b := range history[1].Blocks {
		if b.Type == domain.BlockTypeToolResult && b.ToolSource == "native" && b.ToolName == "skill" && !b.IsError && strings.Contains(b.Content, "Run smoke checks first.") {
			sawNativeSkillResult = true
		}
		if b.Type == domain.BlockTypeText && strings.Contains(b.Text, "skill-verified") {
			sawFinalText = true
		}
	}
	if !sawNativeSkillResult || !sawFinalText {
		t.Fatalf("unexpected persisted blocks: %+v", history[1].Blocks)
	}

	// Verify SystemPrompt & Tools are byte-identical across round 1 and round 2.
	if len(captured) != 2 {
		t.Fatalf("expected 2 upstream requests, got %d", len(captured))
	}
	if !strings.Contains(captured[0].System, "Base system prompt.") ||
		!strings.Contains(captured[0].System, "Workspace rule: always cite path.") ||
		!strings.Contains(captured[0].System, "<available_skills>") {
		t.Fatalf("unexpected system prompt: %q", captured[0].System)
	}
	if captured[0].System != captured[1].System || strings.Join(captured[0].Tools, ",") != strings.Join(captured[1].Tools, ",") {
		t.Fatalf("prompt/tools drifted across rounds: r1=%+v r2=%+v", captured[0], captured[1])
	}

	// 2. Second separate turn keeps exact same system prompt prefix.
	prep2, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "second turn"})
	if err != nil {
		t.Fatalf("Prepare turn 2: %v", err)
	}
	if err := prep2.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream turn 2: %v", err)
	}
	if len(captured) != 3 || captured[2].System != captured[0].System {
		t.Fatalf("system prompt not stable across turns: %q vs %q", captured[0].System, captured[2].System)
	}

	// 3. Turning injectAgentMd off omits AGENTS.md while keeping base prompt and skills.
	off := false
	if _, err := rt.UpdateSettings(ctx, agent.SettingsPatch{InjectAgentMD: &off}); err != nil {
		t.Fatal(err)
	}
	prep3, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "no agent md"})
	if err != nil {
		t.Fatalf("Prepare turn 3: %v", err)
	}
	if err := prep3.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream turn 3: %v", err)
	}
	if strings.Contains(captured[3].System, "Workspace rule") || !strings.Contains(captured[3].System, "<available_skills>") {
		t.Fatalf("unexpected system prompt with injectAgentMd=false: %q", captured[3].System)
	}

	// 4. Ordinary chat topic never receives AGENTS.md or skills.
	chatConv, err := convs.Create(context.Background(), domain.Conversation{
		ID:          "conv-chat",
		AssistantID: domain.DefaultAssistantID,
		Title:       "Chat",
		ProviderID:  "prov-1",
		ModelID:     "gpt-test",
		Mode:        domain.ConversationModeChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	on := true
	if _, err := rt.UpdateSettings(ctx, agent.SettingsPatch{InjectAgentMD: &on}); err != nil {
		t.Fatal(err)
	}
	prepChat, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: chatConv.ID, Text: "hello"})
	if err != nil {
		t.Fatalf("Prepare chat: %v", err)
	}
	if err := prepChat.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream chat: %v", err)
	}
	if captured[4].System != "" || len(captured[4].Tools) != 0 {
		t.Fatalf("chat topic received agent context: %+v", captured[4])
	}
}
