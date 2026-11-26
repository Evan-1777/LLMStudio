package service_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestChatServiceAgentScheduleToolEndToEndAndDesktopIsolation(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()

	var (
		mu       sync.Mutex
		turn     int
		seenTools [][]string
		createdID string
	)

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
		var names []string
		for _, tl := range body.Tools {
			names = append(names, tl.Function.Name)
		}
		mu.Lock()
		turn++
		cur := turn
		seenTools = append(seenTools, names)
		mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		switch cur {
		case 1:
			// Unauthorized turn: should finish directly without calling schedule.
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"no-schedule-tool"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
		case 2:
			// Authorized turn 1: create schedule (omitting bind_current_topic -> defaults to true).
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_create","function":{"name":"schedule","arguments":"{\"action\":\"create\",\"name\":\"晨报\",\"prompt\":\"整理今日待办\",\"hour\":8,\"minute\":30,\"timezone\":\"Asia/Shanghai\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		case 3:
			last := body.Messages[len(body.Messages)-1]
			var payload struct {
				Schedule domain.ScheduledTask `json:"schedule"`
			}
			if err := json.Unmarshal([]byte(last.Content), &payload); err == nil {
				mu.Lock()
				createdID = payload.Schedule.ID
				mu.Unlock()
			}
			// Authorized turn 2: list current_topic_only=true.
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_list","function":{"name":"schedule","arguments":"{\"action\":\"list\",\"current_topic_only\":true}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		case 4:
			// Authorized turn 3: update name & hour.
			mu.Lock()
			id := createdID
			mu.Unlock()
			args, _ := json.Marshal(map[string]any{"action": "update", "id": id, "name": "早报", "hour": 9})
			fmt.Fprintf(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_upd","function":{"name":"schedule","arguments":%q}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n", string(args))
		case 5:
			// Authorized turn 4: create with bind_current_topic=false (inherits topic assistant/provider/model).
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_new","function":{"name":"schedule","arguments":"{\"action\":\"create\",\"name\":\"独立日报\",\"prompt\":\"生成日报\",\"hour\":18,\"minute\":0,\"bind_current_topic\":false}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		default:
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"schedule-complete"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
		}
	}))
	defer upstream.Close()

	chatSvc, convs, _, _, conv, db := setupChatMCPFixture(t, upstream.URL, &stubMCPClient{})
	conv.Mode = domain.ConversationModeAgent
	if _, err := convs.Update(ctx, conv); err != nil {
		t.Fatal(err)
	}

	provStore := store.NewProviderStore(db)
	assistStore := store.NewAssistantStore(db)
	schedStore := store.NewScheduledTaskStore(db)
	rt := agent.NewGateway(store.NewAgentStore(db), dir, true)
	schedSvc := service.NewScheduleService(schedStore, convs, provStore, assistStore, chatSvc)
	rt.WithScheduler(schedSvc)
	chatSvc.WithAgent(rt)
	t.Cleanup(func() {
		_ = chatSvc.Shutdown(context.Background())
		_ = schedSvc.WaitObservers(context.Background())
	})

	// 1. Desktop runtime never advertises or allows "schedule".
	desktopRT := agent.NewDesktop(store.NewAgentStore(db))
	desktopSettings, err := desktopRT.Settings(ctx)
	if err != nil {
		t.Fatalf("desktop settings: %v", err)
	}
	if slices.Contains(desktopSettings.AvailableTools, "schedule") {
		t.Fatalf("desktop runtime must not expose schedule in AvailableTools: %v", desktopSettings.AvailableTools)
	}
	badTools := []string{"schedule"}
	if _, err := desktopRT.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &badTools}); err == nil {
		t.Fatal("expected desktop runtime to reject enabling schedule tool")
	}

	// 2. Gateway runtime advertises "schedule" in AvailableTools, but omits it from model tools when not allowed.
	gwSettings, err := rt.Settings(ctx)
	if err != nil {
		t.Fatalf("gateway settings: %v", err)
	}
	if !slices.Contains(gwSettings.AvailableTools, "schedule") {
		t.Fatalf("expected schedule in gateway AvailableTools: %v", gwSettings.AvailableTools)
	}

	ps1, err := chatSvc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "turn1"})
	if err != nil {
		t.Fatalf("Prepare turn1: %v", err)
	}
	if err := ps1.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream turn1: %v", err)
	}
	if slices.Contains(seenTools[0], "schedule") {
		t.Fatalf("unauthorized schedule tool leaked into model request: %v", seenTools[0])
	}

	// 3. Authorize "schedule" -> model creates bound task, lists, updates, and creates unbound task inheriting conv model.
	allowed := []string{"schedule"}
	if _, err := rt.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatalf("enable schedule tool: %v", err)
	}
	ps2, err := chatSvc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "设置定时任务"})
	if err != nil {
		t.Fatalf("Prepare turn2: %v", err)
	}
	if err := ps2.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream turn2: %v", err)
	}
	if !slices.Contains(seenTools[1], "schedule") {
		t.Fatalf("expected schedule tool exposed when authorized: %v", seenTools[1])
	}

	allTasks, err := schedSvc.List(ctx, "")
	if err != nil || len(allTasks) != 2 {
		t.Fatalf("expected 2 persisted tasks, got %+v (err=%v)", allTasks, err)
	}
	boundTasks, err := schedSvc.List(ctx, conv.ID)
	if err != nil || len(boundTasks) != 1 {
		t.Fatalf("expected 1 task bound to current topic, got %+v (err=%v)", boundTasks, err)
	}
	if boundTasks[0].Name != "早报" || boundTasks[0].Hour != 9 || boundTasks[0].BindMode != domain.ScheduleBindModeConversation {
		t.Fatalf("unexpected updated bound task: %+v", boundTasks[0])
	}

	// Verify the unbound task inherited conv's assistant/provider/model, and delete via tool Execute.
	var unboundID string
	for _, tk := range allTasks {
		if tk.BindMode == domain.ScheduleBindModeNew {
			unboundID = tk.ID
			if tk.AssistantID != conv.AssistantID || tk.ProviderID != conv.ProviderID || tk.ModelID != conv.ModelID {
				t.Fatalf("unbound task did not inherit topic model/assistant: %+v", tk)
			}
		}
	}
	if unboundID == "" {
		t.Fatal("missing unbound task")
	}
	delArgs, _ := json.Marshal(map[string]any{"action": "delete", "id": unboundID})
	if _, err := rt.Execute(ctx, conv.ID, "schedule", delArgs); err != nil {
		t.Fatalf("delete via tool Execute: %v", err)
	}
	remaining, _ := schedSvc.List(ctx, "")
	if len(remaining) != 1 || remaining[0].ID != boundTasks[0].ID {
		t.Fatalf("expected only bound task remaining after delete, got %+v", remaining)
	}
}
