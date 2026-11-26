package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
)

func TestScheduledTaskStoreCRUDClaimAndTrigger(t *testing.T) {
	ctx := context.Background()
	db, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "schedules.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	convs := NewConversationStore(db)
	tasks := NewScheduledTaskStore(db)

	conv, err := convs.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Agent Monitor",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	now := time.Date(2026, 11, 26, 8, 30, 0, 0, time.UTC)
	dueAt := now.Add(-10 * time.Second)
	overdueAt := now.Add(-10 * time.Minute)
	futureAt := now.Add(time.Hour)

	tDue, err := tasks.Create(ctx, domain.ScheduledTask{
		Name:           "Due Bound",
		Prompt:         "Check status",
		Enabled:        true,
		Hour:           8,
		Minute:         30,
		Weekdays:       []int{},
		Timezone:       "UTC",
		MaxRuns:        1,
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &conv.ID,
		AssistantID:    domain.DefaultAssistantID,
		NextRunAt:      &dueAt,
	})
	if err != nil {
		t.Fatalf("create due task: %v", err)
	}
	if tDue.ConversationTitle != "Agent Monitor" {
		t.Fatalf("expected joined conversation title, got %q", tDue.ConversationTitle)
	}

	tOverdue, err := tasks.Create(ctx, domain.ScheduledTask{
		Name:        "Overdue New",
		Prompt:      "Daily report",
		Enabled:     true,
		Hour:        8,
		Minute:      20,
		Weekdays:    []int{1, 3, 5},
		Timezone:    "UTC",
		BindMode:    domain.ScheduleBindModeNew,
		AssistantID: domain.DefaultAssistantID,
		ProviderID:  "p1",
		ModelID:     "m1",
		NextRunAt:   &overdueAt,
	})
	if err != nil {
		t.Fatalf("create overdue task: %v", err)
	}

	if _, err := tasks.Create(ctx, domain.ScheduledTask{
		Name:        "Future Task",
		Prompt:      "Later",
		Enabled:     true,
		Hour:        9,
		Minute:      30,
		Weekdays:    []int{},
		Timezone:    "UTC",
		BindMode:    domain.ScheduleBindModeNew,
		AssistantID: domain.DefaultAssistantID,
		NextRunAt:   &futureAt,
	}); err != nil {
		t.Fatalf("create future task: %v", err)
	}

	// Filter list by conversationID.
	filtered, err := tasks.List(ctx, conv.ID)
	if err != nil || len(filtered) != 1 || filtered[0].ID != tDue.ID {
		t.Fatalf("expected 1 filtered task, got %+v (err=%v)", filtered, err)
	}

	// ClaimDue claims tDue, advances tOverdue without triggering, and skips Future Task.
	computeNext := func(_ domain.ScheduledTask, ref time.Time) *time.Time {
		n := ref.Add(24 * time.Hour)
		return &n
	}
	claimed, err := tasks.ClaimDue(ctx, now, 2*time.Minute, computeNext)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(claimed) != 1 || claimed[0].ID != tDue.ID {
		t.Fatalf("expected only tDue claimed, got %+v", claimed)
	}
	if claimed[0].RunCount != 0 || claimed[0].LastStatus != domain.ScheduleStatusRunning {
		t.Fatalf("expected run_count=0 and status=running before dispatch confirmation, got %+v", claimed[0])
	}

	// Second immediate ClaimDue must return empty (running & next_run_at advanced).
	secondClaim, err := tasks.ClaimDue(ctx, now, 2*time.Minute, computeNext)
	if err != nil || len(secondClaim) != 0 {
		t.Fatalf("expected empty second claim, got %+v (err=%v)", secondClaim, err)
	}

	// Overdue task must have next_run_at advanced without incrementing run_count.
	gotOverdue, err := tasks.Get(ctx, tOverdue.ID)
	if err != nil {
		t.Fatalf("get overdue: %v", err)
	}
	if gotOverdue.RunCount != 0 || gotOverdue.LastStatus != "" || gotOverdue.NextRunAt == nil || !gotOverdue.NextRunAt.After(now) {
		t.Fatalf("unexpected overdue task state: %+v", gotOverdue)
	}

	// Concurrent manual run while running must fail with ErrCodeConflict.
	if _, err := tasks.MarkManualRunStart(ctx, tDue.ID, now); err == nil {
		t.Fatal("expected MarkManualRunStart to conflict while running")
	} else if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeConflict {
		t.Fatalf("expected CONFLICT error, got %v", err)
	}

	// MarkRunDispatched increments run_count and disables max_runs=1 task.
	if err := tasks.MarkRunDispatched(ctx, tDue.ID, conv.ID, now); err != nil {
		t.Fatalf("mark run dispatched: %v", err)
	}
	gotDue, err := tasks.Get(ctx, tDue.ID)
	if err != nil {
		t.Fatalf("get due: %v", err)
	}
	if gotDue.RunCount != 1 || gotDue.Enabled || gotDue.NextRunAt != nil || gotDue.LastConversationID != conv.ID {
		t.Fatalf("expected exhausted task disabled after dispatch, got %+v", gotDue)
	}

	// RecoverInterruptedRuns marks running rows as failed on restart.
	nRecovered, err := tasks.RecoverInterruptedRuns(ctx, now.Add(time.Minute))
	if err != nil || nRecovered != 1 {
		t.Fatalf("expected 1 recovered interrupted run, got n=%d err=%v", nRecovered, err)
	}
	gotDue, _ = tasks.Get(ctx, tDue.ID)
	if gotDue.LastStatus != domain.ScheduleStatusFailed || gotDue.LastError != "服务重启中断" {
		t.Fatalf("unexpected recovered state: %+v", gotDue)
	}

	// Manual run on idle task succeeds, then delete bound conversation triggers BEFORE DELETE trigger.
	if _, err := tasks.MarkManualRunStart(ctx, tDue.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("mark manual start: %v", err)
	}
	if err := tasks.RecordRunOutcome(ctx, tDue.ID, domain.ScheduleStatusSucceeded, "", conv.ID); err != nil {
		t.Fatalf("record outcome: %v", err)
	}
	gotBeforeDelete, _ := tasks.Get(ctx, tDue.ID)
	beforeDelUpdate := gotBeforeDelete.UpdatedAt
	time.Sleep(5 * time.Millisecond)
	if err := convs.Delete(ctx, conv.ID); err != nil {
		t.Fatalf("delete bound conversation: %v", err)
	}
	afterConvDelete, err := tasks.Get(ctx, tDue.ID)
	if err != nil {
		t.Fatalf("get after conv delete: %v", err)
	}
	if afterConvDelete.ConversationID != nil || afterConvDelete.Enabled || afterConvDelete.NextRunAt != nil ||
		afterConvDelete.LastError != "绑定话题已删除" || !afterConvDelete.UpdatedAt.After(beforeDelUpdate) {
		t.Fatalf("trigger did not cleanly disable/update task: %+v", afterConvDelete)
	}

	if err := tasks.Delete(ctx, tDue.ID); err != nil {
		t.Fatalf("delete task: %v", err)
	}
	if _, err := tasks.Get(ctx, tDue.ID); err == nil {
		t.Fatal("expected ErrCodeNotFound after delete")
	}
}
