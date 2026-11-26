package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestScheduleRoutesCRUDAuthAndRunNow(t *testing.T) {
	const token = "sched-token"
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	provStore := store.NewProviderStore(db)
	assistStore := store.NewAssistantStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	prefStore := store.NewPreferenceStore(db)
	taskStore := store.NewScheduledTaskStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"http-ok"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()

	prov, err := provStore.Create(ctx, domain.ProviderConfig{
		Name:     "Cloud Prov",
		Adapter:  "generic-http",
		BaseURL:  upstream.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-1",
		Enabled:  true,
		Models:   []domain.ModelConfig{{ID: "m1", Name: "M1", APIFormat: format.FormatIDOpenAICompletions}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	agentConv, err := convStore.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Agent Conv",
		ProviderID:  prov.ID,
		ModelID:     "m1",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}

	rt := agent.NewGateway(store.NewAgentStore(db), t.TempDir(), true)
	chatSvc := service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithAssistants(assistStore).
		WithPreferences(service.NewPreferenceService(prefStore)).
		WithAgent(rt)
	schedSvc := service.NewScheduleService(taskStore, convStore, provStore, assistStore, chatSvc)
	t.Cleanup(func() {
		_ = chatSvc.Shutdown(context.Background())
		_ = schedSvc.WaitObservers(context.Background())
	})

	router := NewRouter(RouterDeps{
		Config:          config.Config{AccessToken: token},
		ScheduleService: schedSvc,
	})

	// Unauthorized blocked.
	if rec := doJSONReq(t, router, http.MethodGet, "/api/v1/schedules", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", rec.Code)
	}

	// Create bound schedule.
	rec := doJSONReq(t, router, http.MethodPost, "/api/v1/schedules", token, domain.ScheduleCreateInput{
		Name:           "Morning Brief",
		Prompt:         "Summarize tasks",
		Hour:           8,
		Minute:         30,
		Weekdays:       []int{1, 3, 5},
		Timezone:       "Asia/Shanghai",
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &agentConv.ID,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store cache-control, got %q", rec.Header().Get("Cache-Control"))
	}
	var createRes struct {
		Schedule domain.ScheduledTask `json:"schedule"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &createRes); err != nil {
		t.Fatal(err)
	}

	// List filtered by conversationId.
	listRec := doJSONReq(t, router, http.MethodGet, "/api/v1/schedules?conversationId="+agentConv.ID, token, nil)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listRec.Code, listRec.Body.String())
	}
	var listRes struct {
		Schedules []domain.ScheduledTask `json:"schedules"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listRes); err != nil {
		t.Fatal(err)
	}
	if len(listRes.Schedules) != 1 || listRes.Schedules[0].ID != createRes.Schedule.ID {
		t.Fatalf("unexpected list result: %+v", listRes.Schedules)
	}

	// Patch name & hour.
	newName := "Updated Brief"
	newHour := 9
	patchRec := doJSONReq(t, router, http.MethodPatch, "/api/v1/schedules/"+createRes.Schedule.ID, token, domain.ScheduleUpdateInput{
		Name: &newName,
		Hour: &newHour,
	})
	if patchRec.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", patchRec.Code, patchRec.Body.String())
	}

	// RunNow triggers background run and returns conversationId.
	runRec := doJSONReq(t, router, http.MethodPost, "/api/v1/schedules/"+createRes.Schedule.ID+"/run", token, nil)
	if runRec.Code != http.StatusOK {
		t.Fatalf("run status=%d body=%s", runRec.Code, runRec.Body.String())
	}
	var runRes struct {
		Schedule       domain.ScheduledTask `json:"schedule"`
		ConversationID string               `json:"conversationId"`
	}
	if err := json.Unmarshal(runRec.Body.Bytes(), &runRes); err != nil {
		t.Fatal(err)
	}
	if runRes.ConversationID != agentConv.ID {
		t.Fatalf("expected conversationId %q, got %q", agentConv.ID, runRes.ConversationID)
	}

	_ = chatSvc.Shutdown(context.Background())
	_ = schedSvc.WaitObservers(context.Background())

	// Delete returns 204.
	delRec := doJSONReq(t, router, http.MethodDelete, "/api/v1/schedules/"+createRes.Schedule.ID, token, nil)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", delRec.Code, delRec.Body.String())
	}
}
