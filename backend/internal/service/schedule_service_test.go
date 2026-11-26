package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/store"
)

type scheduleTestHarness struct {
	tasks      *store.ScheduledTaskStore
	convs      *store.ConversationStore
	msgs       *store.MessageStore
	providers  *store.ProviderStore
	assistants *store.AssistantStore
	chatSvc    *ChatService
	schedSvc   *ScheduleService
	prov       domain.ProviderConfig
	agentConv  domain.Conversation
	chatConv   domain.Conversation
	clockMu    sync.Mutex
	now        time.Time
}

func setupScheduleTestHarness(t *testing.T, handler http.HandlerFunc) *scheduleTestHarness {
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
	taskStore := store.NewScheduledTaskStore(db)
	prefStore := store.NewPreferenceStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)

	prov, err := provStore.Create(ctx, domain.ProviderConfig{
		Name:     "Mock Cloud",
		Adapter:  "generic-http",
		BaseURL:  upstream.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-test",
		Enabled:  true,
		Models: []domain.ModelConfig{
			{ID: "gpt-test", Name: "GPT Test", APIFormat: format.FormatIDOpenAICompletions},
		},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	agentConv, err := convStore.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Agent Target",
		ProviderID:  prov.ID,
		ModelID:     "gpt-test",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create agent conv: %v", err)
	}
	chatConv, err := convStore.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Chat Mode",
		ProviderID:  prov.ID,
		ModelID:     "gpt-test",
		Mode:        domain.ConversationModeChat,
	})
	if err != nil {
		t.Fatalf("create chat conv: %v", err)
	}

	rt := agent.NewGateway(store.NewAgentStore(db), t.TempDir(), true)
	chatSvc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithAssistants(assistStore).
		WithPreferences(NewPreferenceService(prefStore)).
		WithAgent(rt)
	t.Cleanup(func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = chatSvc.Shutdown(shutCtx)
	})

	schedSvc := NewScheduleService(taskStore, convStore, provStore, assistStore, chatSvc)
	schedSvc.pollInterval = 20 * time.Millisecond

	h := &scheduleTestHarness{
		tasks:      taskStore,
		convs:      convStore,
		msgs:       msgStore,
		providers:  provStore,
		assistants: assistStore,
		chatSvc:    chatSvc,
		schedSvc:   schedSvc,
		prov:       prov,
		agentConv:  agentConv,
		chatConv:   chatConv,
		now:        time.Date(2026, 11, 26, 8, 0, 0, 0, time.UTC),
	}
	schedSvc.nowFn = func() time.Time {
		h.clockMu.Lock()
		defer h.clockMu.Unlock()
		return h.now
	}
	return h
}

func (h *scheduleTestHarness) setNow(t time.Time) {
	h.clockMu.Lock()
	h.now = t.UTC()
	h.clockMu.Unlock()
}

func waitScheduleCondition(t *testing.T, timeout time.Duration, desc string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", desc)
}

func TestComputeNextScheduleRun(t *testing.T) {
	// 2026-11-26 16:30 UTC == 2026-11-27 00:30 Asia/Shanghai (Friday, weekday=5).
	now := time.Date(2026, 11, 26, 16, 30, 0, 0, time.UTC)

	// Next 00:15 in Asia/Shanghai must advance to 2026-11-28 00:15 (+08:00) == 2026-11-27 16:15 UTC.
	next, err := ComputeNextScheduleRun(now, 0, 15, nil, "Asia/Shanghai")
	if err != nil {
		t.Fatalf("compute daily cross-day: %v", err)
	}
	want := time.Date(2026, 11, 27, 16, 15, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("got %v, want %v", next, want)
	}

	// Only Monday (1) at 09:00 Asia/Shanghai from Friday 2026-11-27 -> Monday 2026-11-30 09:00 (+08:00) == 01:00 UTC.
	nextMon, err := ComputeNextScheduleRun(now, 9, 0, []int{1}, "Asia/Shanghai")
	if err != nil {
		t.Fatalf("compute monday: %v", err)
	}
	wantMon := time.Date(2026, 11, 30, 1, 0, 0, 0, time.UTC)
	if !nextMon.Equal(wantMon) {
		t.Fatalf("got %v, want %v", nextMon, wantMon)
	}

	if _, err := ComputeNextScheduleRun(now, 9, 0, nil, "Invalid/Zone"); err == nil {
		t.Fatal("expected invalid timezone error")
	}
}

func TestDetachedRunWaitOutcome(t *testing.T) {
	runErr := newDetachedRun("c1", func() {})
	_ = runErr.publish(domain.StreamEvent{
		Type:  domain.StreamEventError,
		Error: &domain.StreamError{Code: domain.ErrCodeUpstreamError, Message: "rate limit"},
	})
	runErr.finish()
	sr, msg, ok := runErr.waitOutcome(context.Background())
	if !ok || sr != domain.StopReasonError || msg != "rate limit" {
		t.Fatalf("unexpected error-only outcome: ok=%v sr=%q msg=%q", ok, sr, msg)
	}

	runEmpty := newDetachedRun("c2", func() {})
	runEmpty.finish()
	sr, msg, ok = runEmpty.waitOutcome(context.Background())
	if !ok || sr != domain.StopReasonAborted || msg == "" {
		t.Fatalf("expected aborted fallback on empty terminalEvents, got ok=%v sr=%q msg=%q", ok, sr, msg)
	}
}

func TestScheduleServiceValidationAndRecovery(t *testing.T) {
	ctx := context.Background()
	h := setupScheduleTestHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	})

	// Reject chat conversation.
	if _, err := h.schedSvc.Create(ctx, domain.ScheduleCreateInput{
		Name:           "Bad Chat",
		Prompt:         "hi",
		Hour:           9,
		Minute:         0,
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &h.chatConv.ID,
	}); err == nil {
		t.Fatal("expected chat mode conversation to be rejected")
	}

	// Reject bound conversation without model configured.
	noModelAgent, err := h.convs.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "No Model Agent",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create no-model conv: %v", err)
	}
	if _, err := h.schedSvc.Create(ctx, domain.ScheduleCreateInput{
		Name:           "Missing Model",
		Prompt:         "hi",
		Hour:           9,
		Minute:         0,
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &noModelAgent.ID,
	}); err == nil {
		t.Fatal("expected unconfigured model agent conversation to be rejected")
	}

	// Reject localRequest provider.
	localProv, err := h.providers.Create(ctx, domain.ProviderConfig{
		Name:         "Browser Local",
		Adapter:      "generic-http",
		BaseURL:      "https://api.example.com/v1",
		AuthType:     domain.AuthTypeBearer,
		Enabled:      true,
		LocalRequest: true,
		Models:       []domain.ModelConfig{{ID: "m-local", Name: "Local", APIFormat: format.FormatIDOpenAICompletions}},
	})
	if err != nil {
		t.Fatalf("create local provider: %v", err)
	}
	if _, err := h.schedSvc.Create(ctx, domain.ScheduleCreateInput{
		Name:       "Reject Local",
		Prompt:     "hi",
		Hour:       9,
		Minute:     0,
		BindMode:   domain.ScheduleBindModeNew,
		ProviderID: localProv.ID,
		ModelID:    "m-local",
	}); err == nil {
		t.Fatal("expected localRequest provider to be rejected")
	}

	// Create valid bound task, delete bound conversation, and recover via Update switching to new mode.
	toDeleteConv, err := h.convs.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Temp Bound",
		ProviderID:  h.prov.ID,
		ModelID:     "gpt-test",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create temp bound: %v", err)
	}
	created, err := h.schedSvc.Create(ctx, domain.ScheduleCreateInput{
		Name:           "Recoverable",
		Prompt:         "check",
		Hour:           9,
		Minute:         0,
		Timezone:       "UTC",
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &toDeleteConv.ID,
	})
	if err != nil {
		t.Fatalf("create bound task: %v", err)
	}
	if err := h.convs.Delete(ctx, toDeleteConv.ID); err != nil {
		t.Fatalf("delete conv: %v", err)
	}
	newMode := domain.ScheduleBindModeNew
	enabled := true
	recovered, err := h.schedSvc.Update(ctx, created.ID, domain.ScheduleUpdateInput{
		BindMode:   &newMode,
		ProviderID: &h.prov.ID,
		ModelID:    &h.prov.Models[0].ID,
		Enabled:    &enabled,
	})
	if err != nil {
		t.Fatalf("recover deleted bound task by switching to new mode: %v", err)
	}
	if recovered.BindMode != domain.ScheduleBindModeNew || recovered.ConversationID != nil || !recovered.Enabled || recovered.NextRunAt == nil {
		t.Fatalf("unexpected recovered task: %+v", recovered)
	}
}

func TestScheduleServiceExecutionLifecycleConflictAndShutdown(t *testing.T) {
	ctx := context.Background()
	var failNext atomic.Bool
	blockGate := make(chan struct{})
	releaseGate := make(chan struct{})
	var gateOnce sync.Once
	var hits atomic.Int32

	h := setupScheduleTestHarness(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if failNext.Load() {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":{"message":"upstream down"}}`))
			return
		}
		var body struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, m := range body.Messages {
			if m.Content == "hold-for-shutdown" {
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				if flusher, ok := w.(http.Flusher); ok {
					flusher.Flush()
				}
				gateOnce.Do(func() { close(blockGate) })
				<-releaseGate
				return
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"scheduled-done"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	})

	// 1. New mode failure cleans up orphan conversation and does not increment runCount or record lastConversationId.
	failNext.Store(true)
	h.setNow(time.Date(2026, 11, 26, 8, 29, 0, 0, time.UTC))
	newTask, err := h.schedSvc.Create(ctx, domain.ScheduleCreateInput{
		Name:       "Orphan Test",
		Prompt:     "run",
		Hour:       8,
		Minute:     30,
		Timezone:   "UTC",
		MaxRuns:    1,
		BindMode:   domain.ScheduleBindModeNew,
		ProviderID: h.prov.ID,
		ModelID:    "gpt-test",
	})
	if err != nil {
		t.Fatalf("create new task: %v", err)
	}

	h.schedSvc.Start(ctx)
	t.Cleanup(func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = h.schedSvc.Stop(shutCtx)
	})

	h.setNow(time.Date(2026, 11, 26, 8, 30, 5, 0, time.UTC))
	h.schedSvc.notifyWakeup()

	waitScheduleCondition(t, 3*time.Second, "orphan failure recorded", func() bool {
		got, err := h.schedSvc.Get(ctx, newTask.ID)
		return err == nil && got.LastStatus == domain.ScheduleStatusFailed
	})
	gotNew, _ := h.schedSvc.Get(ctx, newTask.ID)
	if gotNew.RunCount != 0 || gotNew.LastConversationID != "" {
		t.Fatalf("expected runCount=0 and empty lastConversationId on Prepare fail, got %+v", gotNew)
	}
	allConvs, _ := h.convs.List(ctx)
	if len(allConvs) != 2 { // only agentConv and chatConv
		t.Fatalf("expected orphan conversation deleted, got %d conversations", len(allConvs))
	}

	// 2. Recover upstream and re-trigger -> creates conversation, increments runCount=1, disables maxRuns=1.
	failNext.Store(false)
	h.setNow(time.Date(2026, 11, 27, 8, 30, 5, 0, time.UTC))
	h.schedSvc.notifyWakeup()
	waitScheduleCondition(t, 3*time.Second, "new task succeeded", func() bool {
		got, err := h.schedSvc.Get(ctx, newTask.ID)
		return err == nil && got.LastStatus == domain.ScheduleStatusSucceeded
	})
	gotNew, _ = h.schedSvc.Get(ctx, newTask.ID)
	if gotNew.RunCount != 1 || gotNew.Enabled || gotNew.NextRunAt != nil || gotNew.LastConversationID == "" {
		t.Fatalf("expected completed maxRuns=1 task disabled with lastConversationId, got %+v", gotNew)
	}
	msgs, err := h.msgs.ListByConversation(ctx, gotNew.LastConversationID)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("expected user+assistant messages persisted in new conv, got len=%d err=%v", len(msgs), err)
	}

	// 3. Re-enabling exhausted task without resetRunCount/higher maxRuns fails; with resetRunCount succeeds.
	en := true
	if _, err := h.schedSvc.Update(ctx, newTask.ID, domain.ScheduleUpdateInput{Enabled: &en}); err == nil {
		t.Fatal("expected re-enabling exhausted task without reset to fail")
	}
	reset := true
	if _, err := h.schedSvc.Update(ctx, newTask.ID, domain.ScheduleUpdateInput{Enabled: &en, ResetRunCount: &reset}); err != nil {
		t.Fatalf("re-enable with resetRunCount: %v", err)
	}

	// 4. Bound task + RunNow concurrency guard + 3-step shutdown while running.
	boundTask, err := h.schedSvc.Create(ctx, domain.ScheduleCreateInput{
		Name:           "Hold Run",
		Prompt:         "hold-for-shutdown",
		Hour:           10,
		Minute:         0,
		Timezone:       "UTC",
		Enabled:        func() *bool { b := false; return &b }(),
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &h.agentConv.ID,
	})
	if err != nil {
		t.Fatalf("create bound hold task: %v", err)
	}

	_, runConvID, err := h.schedSvc.RunNow(ctx, boundTask.ID)
	if err != nil || runConvID != h.agentConv.ID {
		t.Fatalf("RunNow failed: err=%v convID=%q", err, runConvID)
	}
	<-blockGate

	// Concurrent RunNow on same task must return 409 CONFLICT.
	if _, _, err := h.schedSvc.RunNow(ctx, boundTask.ID); err == nil {
		t.Fatal("expected concurrent RunNow to return conflict")
	} else if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeConflict {
		t.Fatalf("expected ErrCodeConflict, got %v", err)
	}

	// Three-step shutdown: StopScheduler -> chatSvc.Shutdown -> WaitObservers must converge cleanly without deadlock!
	h.schedSvc.StopScheduler()
	close(releaseGate)
	chatShutCtx, chatCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer chatCancel()
	if err := h.chatSvc.Shutdown(chatShutCtx); err != nil {
		t.Fatalf("chatSvc.Shutdown: %v", err)
	}
	obsCtx, obsCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer obsCancel()
	if err := h.schedSvc.WaitObservers(obsCtx); err != nil {
		t.Fatalf("WaitObservers deadlocked or failed: %v", err)
	}
	afterShut, _ := h.schedSvc.Get(ctx, boundTask.ID)
	if afterShut.LastStatus == domain.ScheduleStatusRunning {
		t.Fatalf("expected observer to persist terminal status before WaitObservers returned, got %+v", afterShut)
	}
}
