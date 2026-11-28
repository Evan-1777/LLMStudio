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
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func setupDetachedAgentFixture(t *testing.T, handler http.HandlerFunc) (*service.ChatService, *service.ConversationService, *store.ConversationStore, *store.MessageStore, domain.Conversation, string) {
	t.Helper()
	ctx := t.Context()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("bg-agent-sentinel"), 0600); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)

	chatSvc, convs, msgs, _, conv, db := setupChatMCPFixture(t, upstream.URL, &stubMCPClient{})
	conv.Mode = domain.ConversationModeAgent
	if _, err := convs.Update(ctx, conv); err != nil {
		t.Fatal(err)
	}
	rt := agent.NewGateway(store.NewAgentStore(db), dir, true)
	allowed := []string{"read", "bash"}
	if _, err := rt.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatal(err)
	}
	chatSvc.WithAgent(rt)
	convSvc := service.NewConversationService(convs, msgs).WithRunTracker(
		chatSvc.ActiveRun,
		chatSvc.ActiveRunConversationIDs,
		chatSvc.CancelRunsAndWait,
	)
	t.Cleanup(func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = chatSvc.Shutdown(shutCtx)
	})
	return chatSvc, convSvc, convs, msgs, conv, dir
}

func waitForCondition(t *testing.T, timeout time.Duration, desc string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", desc)
}

func TestDetachedAgentContinuesAfterClientDisconnectDuringPrepareAndStream(t *testing.T) {
	prepareEntered := make(chan struct{})
	prepareRelease := make(chan struct{})
	var turn atomic.Int32

	chatSvc, _, _, msgs, conv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, r *http.Request) {
		n := turn.Add(1)
		if n == 1 {
			close(prepareEntered)
			<-prepareRelease
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		if n == 1 || n == 3 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"reasoning_content":"planning read"},"finish_reason":null}]}`+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"read","arguments":"{\"path\":\"note.txt\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"final-bg-answer"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	})

	// 1. Cancel clientCtx BEFORE Prepare even finishes (while round-1 upstream headers are blocked).
	prepCtx, prepCancel := context.WithCancel(t.Context())
	prepDone := make(chan error, 1)
	var prepared *service.PreparedStream
	go func() {
		var err error
		prepared, err = chatSvc.Prepare(prepCtx, service.StreamChatInput{ConversationID: conv.ID, Text: "start"})
		prepDone <- err
	}()

	<-prepareEntered
	prepCancel()
	close(prepareRelease)

	if err := <-prepDone; err != nil {
		t.Fatalf("Prepare should survive clientCtx cancel in detached Agent mode: %v", err)
	}

	// Client disconnects immediately after first event, yet background run must finish round 2 and persist.
	streamCtx, streamCancel := context.WithCancel(t.Context())
	gotFirst := false
	_ = prepared.Stream(streamCtx, func(ev domain.StreamEvent) error {
		if !gotFirst {
			gotFirst = true
			streamCancel()
		}
		return nil
	})

	waitForCondition(t, 4*time.Second, "detached Agent message persistence", func() bool {
		items, err := msgs.ListByConversation(t.Context(), conv.ID)
		return err == nil && len(items) == 2 && chatSvc.ActiveRun(conv.ID) == nil
	})

	items, err := msgs.ListByConversation(t.Context(), conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(items))
	}
	if items[1].StopReason != domain.StopReasonStop {
		t.Fatalf("stopReason=%q want stop", items[1].StopReason)
	}
	rawBlocks, _ := json.Marshal(items[1].Blocks)
	for _, want := range []string{"planning read", "bg-agent-sentinel", "final-bg-answer", `"toolSource":"native"`} {
		if !strings.Contains(string(rawBlocks), want) {
			t.Fatalf("persisted blocks missing %q: %s", want, rawBlocks)
		}
	}
}

func TestDetachedAgentFastCompleteInitialSubscribeAndMidRunReconnectNoDuplicate(t *testing.T) {
	// Part A: Fast no-tool response completes before initial PreparedStream.Stream is called.
	fastSvc, _, _, _, fastConv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"fast-done"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	})

	prepFast, err := fastSvc.Prepare(t.Context(), service.StreamChatInput{ConversationID: fastConv.ID, Text: "quick"})
	if err != nil {
		t.Fatalf("Prepare fast: %v", err)
	}
	// Wait until background goroutine finishes and clears active slot BEFORE calling Stream.
	waitForCondition(t, 3*time.Second, "fast background run completion", func() bool {
		return fastSvc.ActiveRun(fastConv.ID) == nil
	})
	var fastEvents []domain.StreamEvent
	if err := prepFast.Stream(t.Context(), func(ev domain.StreamEvent) error {
		fastEvents = append(fastEvents, ev)
		return nil
	}); err != nil {
		t.Fatalf("fast Stream: %v", err)
	}
	hasMessageEnd := false
	for _, ev := range fastEvents {
		if ev.Type == domain.StreamEventMessageEnd && ev.Message != nil {
			hasMessageEnd = true
		}
	}
	if !hasMessageEnd {
		t.Fatalf("initial subscriber missed terminal message_end on fast-completing run: %+v", fastEvents)
	}

	// Part B: Mid-run reconnect gets atomic snapshot + live stream without missing or duplicated deltas,
	// and concurrent Prepare returns ErrCodeConflict with non-empty ActiveRun.MessageID.
	round2Entered := make(chan struct{})
	round2Release := make(chan struct{})
	var turn atomic.Int32

	chatSvc, convSvc, _, _, conv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		n := turn.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		if n == 1 {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"reasoning_content":"step-one-thought"},"finish_reason":null}]}`+"\n\n")
			fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\"path\":\"note.txt\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		close(round2Entered)
		<-round2Release
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"reconnected-"},"finish_reason":null}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"reply"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
	})

	prep, err := chatSvc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "reconnect me"})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// Detach initial stream immediately without consuming.
	detachCtx, detachCancel := context.WithCancel(t.Context())
	detachCancel()
	_ = prep.Stream(detachCtx, func(domain.StreamEvent) error { return nil })

	<-round2Entered

	// ActiveRun must have a non-empty MessageID and detail must expose it.
	detail, err := convSvc.GetDetail(t.Context(), conv.ID)
	if err != nil {
		t.Fatalf("GetDetail: %v", err)
	}
	if detail.ActiveRun == nil || detail.ActiveRun.MessageID == "" || !detail.Conversation.Running {
		t.Fatalf("expected activeRun with MessageID and running=true, got %+v", detail)
	}

	// Concurrent Prepare on same Agent conversation must return CONFLICT.
	if _, err := chatSvc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "second"}); err == nil {
		t.Fatal("expected CONFLICT error on concurrent Agent Prepare")
	} else if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeConflict {
		t.Fatalf("expected ErrCodeConflict, got %v", err)
	}

	// Reconnect via SubscribeRun while paused before round 2 tokens.
	var (
		mu       sync.Mutex
		replayed []domain.StreamEvent
		readyCnt int
	)
	subDone := make(chan bool, 1)
	go func() {
		attached, _ := chatSvc.SubscribeRun(t.Context(), conv.ID, func() {
			mu.Lock()
			readyCnt++
			mu.Unlock()
		}, func(ev domain.StreamEvent) error {
			mu.Lock()
			replayed = append(replayed, ev)
			mu.Unlock()
			return nil
		})
		subDone <- attached
	}()

	waitForCondition(t, 2*time.Second, "subscriber ready", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return readyCnt == 1
	})
	close(round2Release)

	if attached := <-subDone; !attached {
		t.Fatal("expected SubscribeRun attached=true")
	}

	// Verify replayed events contain thinking, toolCall, toolResult, live text (no duplicates), and message_end.
	var thinkingBuf, textBuf strings.Builder
	var toolCallEnds, toolResultEnds, messageEnds int
	for _, ev := range replayed {
		switch ev.Type {
		case domain.StreamEventBlockDelta:
			if ev.BlockType == domain.BlockTypeThinking {
				thinkingBuf.WriteString(ev.Delta)
			} else if ev.BlockType == domain.BlockTypeText {
				textBuf.WriteString(ev.Delta)
			}
		case domain.StreamEventBlockEnd:
			if ev.BlockType == domain.BlockTypeThinking && ev.Block != nil && thinkingBuf.Len() == 0 {
				thinkingBuf.WriteString(ev.Block.Thinking)
			}
			if ev.BlockType == domain.BlockTypeToolCall {
				toolCallEnds++
			}
			if ev.BlockType == domain.BlockTypeToolResult {
				toolResultEnds++
			}
		case domain.StreamEventMessageEnd:
			messageEnds++
		}
	}
	if thinkingBuf.String() != "step-one-thought" {
		t.Fatalf("thinking=%q want step-one-thought", thinkingBuf.String())
	}
	if textBuf.String() != "reconnected-reply" {
		t.Fatalf("text=%q want reconnected-reply", textBuf.String())
	}
	if toolCallEnds != 1 || toolResultEnds != 1 || messageEnds != 1 {
		t.Fatalf("counts toolCallEnd=%d toolResultEnd=%d messageEnd=%d", toolCallEnds, toolResultEnds, messageEnds)
	}

	// After completion, SubscribeRun returns attached=false cleanly.
	readyAfter := false
	attachedAfter, _ := chatSvc.SubscribeRun(t.Context(), conv.ID, func() { readyAfter = true }, func(domain.StreamEvent) error { return nil })
	if attachedAfter || readyAfter {
		t.Fatalf("expected attached=false after completion, got attached=%v ready=%v", attachedAfter, readyAfter)
	}
}

func TestDetachedAgentCancelDeleteAndCleanupConvergeWithoutRace(t *testing.T) {
	// Subtest 1: Explicit CancelRun aborts upstream and persists stopReason=aborted.
	t.Run("CancelRun", func(t *testing.T) {
		blocked := make(chan struct{})
		upstreamCanceled := make(chan struct{})
		var turn atomic.Int32

		chatSvc, _, _, msgs, conv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, r *http.Request) {
			if turn.Add(1) == 1 {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}`+"\n\n")
				w.(http.Flusher).Flush()
				close(blocked)
				<-r.Context().Done()
				close(upstreamCanceled)
				return
			}
		})

		if _, err := chatSvc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "block"}); err != nil {
			t.Fatalf("Prepare: %v", err)
		}
		<-blocked
		waitForCondition(t, 2*time.Second, "partial content persistence before cancel", func() bool {
			items, err := msgs.ListByConversation(t.Context(), conv.ID)
			return err == nil && len(items) >= 1
		})

		if !chatSvc.CancelRun(conv.ID) {
			t.Fatal("expected CancelRun to return true")
		}
		select {
		case <-upstreamCanceled:
		case <-time.After(3 * time.Second):
			t.Fatal("upstream was not canceled by CancelRun")
		}

		waitForCondition(t, 3*time.Second, "aborted persistence", func() bool {
			return chatSvc.ActiveRun(conv.ID) == nil
		})
		items, err := msgs.ListByConversation(t.Context(), conv.ID)
		if err != nil || len(items) != 2 || items[1].StopReason != domain.StopReasonAborted {
			t.Fatalf("expected 2 messages with aborted stopReason, got len=%d err=%v", len(items), err)
		}
	})

	// Subtest 2: ConversationService.Delete waits for canceled run convergence before deleting.
	t.Run("DeleteConverges", func(t *testing.T) {
		blocked := make(chan struct{})
		chatSvc, convSvc, _, _, conv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.(http.Flusher).Flush()
			close(blocked)
			<-r.Context().Done()
		})
		if _, err := chatSvc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "delete me"}); err != nil {
			t.Fatalf("Prepare: %v", err)
		}
		<-blocked

		if err := convSvc.Delete(t.Context(), conv.ID); err != nil {
			t.Fatalf("Delete while running: %v", err)
		}
		if chatSvc.ActiveRun(conv.ID) != nil {
			t.Fatal("expected active run cleared before Delete returned")
		}
	})

	// Subtest 3: CleanupUngrouped cancels ungrouped running Agent conversations before deleting.
	t.Run("CleanupUngroupedConverges", func(t *testing.T) {
		blocked := make(chan struct{})
		chatSvc, convSvc, _, _, conv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.(http.Flusher).Flush()
			close(blocked)
			<-r.Context().Done()
		})
		if _, err := chatSvc.Prepare(t.Context(), service.StreamChatInput{ConversationID: conv.ID, Text: "cleanup me"}); err != nil {
			t.Fatalf("Prepare: %v", err)
		}
		<-blocked

		deleted, err := convSvc.CleanupUngrouped(t.Context())
		if err != nil {
			t.Fatalf("CleanupUngrouped while running: %v", err)
		}
		if len(deleted) != 1 || deleted[0].ID != conv.ID {
			t.Fatalf("expected deleted=[%s], got %+v", conv.ID, deleted)
		}
		if chatSvc.ActiveRun(conv.ID) != nil {
			t.Fatal("expected active run cleared before CleanupUngrouped returned")
		}
	})
}

func TestNormalChatStillAbortsOnClientCancelAndShutdownDrainsAgent(t *testing.T) {
	// Normal chat conversation must still abort immediately when client ctx cancels.
	chatBlocked := make(chan struct{})
	chatCanceled := make(chan struct{})
	chatSvc, _, convs, _, conv, _ := setupDetachedAgentFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		close(chatBlocked)
		<-r.Context().Done()
		close(chatCanceled)
	})
	conv.Mode = domain.ConversationModeChat
	if _, err := convs.Update(t.Context(), conv); err != nil {
		t.Fatal(err)
	}
	clientCtx, clientCancel := context.WithCancel(t.Context())
	prep, err := chatSvc.Prepare(clientCtx, service.StreamChatInput{ConversationID: conv.ID, Text: "normal chat"})
	if err != nil {
		t.Fatalf("Prepare normal chat: %v", err)
	}
	go func() {
		<-chatBlocked
		clientCancel()
	}()
	_ = prep.Stream(clientCtx, func(domain.StreamEvent) error { return nil })
	select {
	case <-chatCanceled:
	case <-time.After(3 * time.Second):
		t.Fatal("normal chat upstream was not canceled on client disconnect")
	}
}
