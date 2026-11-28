package service

import (
	"context"
	"testing"
	"time"
)

func TestReserveCancelIntentOnlyBlocksInFlightRequest(t *testing.T) {
	m := newChatRunManager()

	requestStartedAt := time.Now()
	time.Sleep(2 * time.Millisecond)
	if m.cancel("c1") {
		t.Fatal("cancel on idle conversation must record an intent")
	}
	if run, _, err := m.reserve("c1", context.Background(), requestStartedAt); err == nil || run != nil {
		t.Fatalf("request in flight before cancel must be blocked, got run=%v err=%v", run, err)
	}

	// A resend that starts after the cancel is a new intent and must not inherit
	// the consumed cancel window.
	run, _, err := m.reserve("c1", context.Background(), time.Now())
	if err != nil || run == nil {
		t.Fatalf("request started after cancel must be allowed, got run=%v err=%v", run, err)
	}
	m.release("c1", run)
}
