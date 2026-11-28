package service

import (
	"context"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
)

const (
	runSubscriberBuffer = 256
	cancelIntentTTL     = time.Second
)

// ActiveRunInfo describes a currently executing background Agent run for a conversation.
type ActiveRunInfo struct {
	ConversationID       string          `json:"conversationId"`
	MessageID            string          `json:"messageId"`
	ProviderID           string          `json:"providerId"`
	ModelID              string          `json:"modelId"`
	ReplaceMessageID     string          `json:"replaceMessageId,omitempty"`
	InsertAfterMessageID string          `json:"insertAfterMessageId,omitempty"`
	PendingUserMessage   *domain.Message `json:"pendingUserMessage,omitempty"`
}

type detachedRun struct {
	mu             sync.Mutex
	info           ActiveRunInfo
	cancel         context.CancelFunc
	acc            *streamAccumulator
	started        bool
	done           bool
	doneCh         chan struct{}
	terminalEvents []domain.StreamEvent
	nextSubID      uint64
	subs           map[uint64]chan domain.StreamEvent
}

func newDetachedRun(conversationID string, cancel context.CancelFunc) *detachedRun {
	return &detachedRun{
		info: ActiveRunInfo{
			ConversationID: conversationID,
			MessageID:      domain.NewUUID(),
		},
		cancel: cancel,
		acc:    newStreamAccumulator(),
		doneCh: make(chan struct{}),
		subs:   make(map[uint64]chan domain.StreamEvent),
	}
}

func (r *detachedRun) updateInfo(fn func(*ActiveRunInfo)) {
	r.mu.Lock()
	fn(&r.info)
	r.mu.Unlock()
}

func (r *detachedRun) snapshotInfo() ActiveRunInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.info
}

func (r *detachedRun) clearPendingUser() {
	r.mu.Lock()
	r.info.PendingUserMessage = nil
	r.mu.Unlock()
}

func (r *detachedRun) publish(ev domain.StreamEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if ev.Type == domain.StreamEventMessageStart {
		r.started = true
	}
	r.acc.apply(ev)
	if ev.Type == domain.StreamEventMessageEnd || ev.Type == domain.StreamEventError {
		r.terminalEvents = append(r.terminalEvents, ev)
	}
	for id, ch := range r.subs {
		select {
		case ch <- ev:
		default:
			// Drop slow subscriber so background Agent execution is never stalled.
			close(ch)
			delete(r.subs, id)
		}
	}
	return nil
}

func (r *detachedRun) setUsage(usage *domain.Usage) {
	r.mu.Lock()
	r.acc.usage = usage
	r.mu.Unlock()
}

func (r *detachedRun) snapshotState() ([]domain.ContentBlock, *domain.Usage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.acc.blocksSlice(), r.acc.usage
}

func (r *detachedRun) finish() {
	r.mu.Lock()
	if r.done {
		r.mu.Unlock()
		return
	}
	r.done = true
	for id, ch := range r.subs {
		close(ch)
		delete(r.subs, id)
	}
	close(r.doneCh)
	r.mu.Unlock()
}

func (r *detachedRun) waitOutcome(ctx context.Context) (stopReason, errMsg string, completed bool) {
	select {
	case <-r.doneCh:
	case <-ctx.Done():
		return "", "", false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	for _, ev := range r.terminalEvents {
		if ev.Type == domain.StreamEventError {
			msg := ""
			if ev.Error != nil {
				msg = ev.Error.Message
			}
			return domain.StopReasonError, msg, true
		}
	}
	for i := len(r.terminalEvents) - 1; i >= 0; i-- {
		ev := r.terminalEvents[i]
		if ev.Type == domain.StreamEventMessageEnd && ev.RolledBack {
			return domain.StopReasonAborted, "运行已取消", true
		}
		if ev.Type == domain.StreamEventMessageEnd && ev.Message != nil {
			sr := ev.Message.StopReason
			if sr == "" && ev.Message.ErrorMessage != "" {
				sr = domain.StopReasonError
			}
			if sr == "" {
				sr = domain.StopReasonStop
			}
			return sr, ev.Message.ErrorMessage, true
		}
	}
	return domain.StopReasonAborted, "运行已取消", true
}

// snapshotEventsLocked builds a compact, protocol-standard replay sequence from the
// single streamAccumulator while holding r.mu.
func (r *detachedRun) snapshotEventsLocked() []domain.StreamEvent {
	if !r.started {
		return nil
	}
	info := r.info
	events := make([]domain.StreamEvent, 0, len(r.acc.order)*3+3)
	events = append(events, domain.StreamEvent{
		Type:           domain.StreamEventMessageStart,
		ConversationID: info.ConversationID,
		MessageID:      info.MessageID,
		ProviderID:     info.ProviderID,
		ModelID:        info.ModelID,
	})

	for _, idx := range r.acc.order {
		b := r.acc.blocks[idx]
		if b == nil {
			continue
		}
		if b.finalized != nil {
			cp := *b.finalized
			bt := cp.Type
			if bt == "" {
				bt = b.blockType
			}
			events = append(events,
				domain.StreamEvent{
					Type:           domain.StreamEventBlockStart,
					ConversationID: info.ConversationID,
					MessageID:      info.MessageID,
					ProviderID:     info.ProviderID,
					ModelID:        info.ModelID,
					Index:          domain.IntPtr(idx),
					BlockType:      bt,
					Block:          &cp,
				},
				domain.StreamEvent{
					Type:           domain.StreamEventBlockEnd,
					ConversationID: info.ConversationID,
					MessageID:      info.MessageID,
					ProviderID:     info.ProviderID,
					ModelID:        info.ModelID,
					Index:          domain.IntPtr(idx),
					BlockType:      bt,
					Block:          &cp,
				},
			)
			continue
		}

		var startBlock *domain.ContentBlock
		if b.startBlock != nil {
			cp := *b.startBlock
			startBlock = &cp
		} else if b.blockType == domain.BlockTypeToolCall {
			startBlock = &domain.ContentBlock{
				Type: domain.BlockTypeToolCall,
				ID:   b.id,
				Name: b.name,
			}
		}
		events = append(events, domain.StreamEvent{
			Type:           domain.StreamEventBlockStart,
			ConversationID: info.ConversationID,
			MessageID:      info.MessageID,
			ProviderID:     info.ProviderID,
			ModelID:        info.ModelID,
			Index:          domain.IntPtr(idx),
			BlockType:      b.blockType,
			Block:          startBlock,
		})

		if txt := b.text.String(); txt != "" {
			deltaType := domain.DeltaTypeText
			switch b.blockType {
			case domain.BlockTypeThinking:
				deltaType = domain.DeltaTypeThinking
			case domain.BlockTypeToolCall:
				deltaType = domain.DeltaTypeToolCallArgs
			}
			events = append(events, domain.StreamEvent{
				Type:           domain.StreamEventBlockDelta,
				ConversationID: info.ConversationID,
				MessageID:      info.MessageID,
				ProviderID:     info.ProviderID,
				ModelID:        info.ModelID,
				Index:          domain.IntPtr(idx),
				BlockType:      b.blockType,
				DeltaType:      deltaType,
				Delta:          txt,
			})
		}

		if sig := b.signature.String(); sig != "" {
			events = append(events, domain.StreamEvent{
				Type:           domain.StreamEventBlockDelta,
				ConversationID: info.ConversationID,
				MessageID:      info.MessageID,
				ProviderID:     info.ProviderID,
				ModelID:        info.ModelID,
				Index:          domain.IntPtr(idx),
				BlockType:      b.blockType,
				DeltaType:      domain.DeltaTypeSignature,
				Delta:          sig,
			})
		}

		if b.completed {
			events = append(events, domain.StreamEvent{
				Type:           domain.StreamEventBlockEnd,
				ConversationID: info.ConversationID,
				MessageID:      info.MessageID,
				ProviderID:     info.ProviderID,
				ModelID:        info.ModelID,
				Index:          domain.IntPtr(idx),
				BlockType:      b.blockType,
			})
		}
	}

	if r.acc.usage != nil {
		u := *r.acc.usage
		events = append(events, domain.StreamEvent{
			Type:           domain.StreamEventMessageDelta,
			ConversationID: info.ConversationID,
			MessageID:      info.MessageID,
			ProviderID:     info.ProviderID,
			ModelID:        info.ModelID,
			Usage:          &u,
			StopReason:     r.acc.stopReason,
		})
	}

	if len(r.terminalEvents) > 0 {
		events = append(events, r.terminalEvents...)
	}

	return events
}

func (r *detachedRun) subscribe(
	ctx context.Context,
	onReady func(),
	emit func(domain.StreamEvent) error,
) error {
	r.mu.Lock()
	replay := r.snapshotEventsLocked()
	if r.done {
		r.mu.Unlock()
		if onReady != nil {
			onReady()
		}
		for _, ev := range replay {
			if ctx.Err() != nil {
				return nil
			}
			if err := emit(ev); err != nil {
				return nil
			}
		}
		return nil
	}

	r.nextSubID++
	subID := r.nextSubID
	ch := make(chan domain.StreamEvent, runSubscriberBuffer)
	r.subs[subID] = ch
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		delete(r.subs, subID)
		r.mu.Unlock()
	}()

	if onReady != nil {
		onReady()
	}

	for _, ev := range replay {
		if ctx.Err() != nil {
			return nil
		}
		if err := emit(ev); err != nil {
			return nil
		}
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if err := emit(ev); err != nil {
				return nil
			}
		}
	}
}

type chatRunManager struct {
	mu            sync.Mutex
	active        map[string]*detachedRun
	cancelIntents map[string]time.Time
}

func newChatRunManager() *chatRunManager {
	return &chatRunManager{
		active:        make(map[string]*detachedRun),
		cancelIntents: make(map[string]time.Time),
	}
}

func (m *chatRunManager) pruneCancelIntentsLocked(now time.Time) {
	for id, at := range m.cancelIntents {
		if now.Sub(at) >= cancelIntentTTL {
			delete(m.cancelIntents, id)
		}
	}
}

func (m *chatRunManager) reserve(conversationID string, parentCtx context.Context) (*detachedRun, context.Context, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.active[conversationID]; exists {
		return nil, nil, domain.NewError(domain.ErrCodeConflict, "该 Agent 话题正在运行中", nil)
	}
	now := time.Now()
	m.pruneCancelIntentsLocked(now)
	if at, canceled := m.cancelIntents[conversationID]; canceled && now.Sub(at) < cancelIntentTTL {
		delete(m.cancelIntents, conversationID)
		return nil, nil, domain.NewError(domain.ErrCodeConflict, "该 Agent 话题运行已取消", nil)
	}
	runCtx, cancel := context.WithCancel(parentCtx)
	run := newDetachedRun(conversationID, cancel)
	m.active[conversationID] = run
	return run, runCtx, nil
}

func (m *chatRunManager) release(conversationID string, run *detachedRun) {
	m.mu.Lock()
	if cur, ok := m.active[conversationID]; ok && cur == run {
		delete(m.active, conversationID)
	}
	m.mu.Unlock()
	run.finish()
}

func (m *chatRunManager) subscribe(
	ctx context.Context,
	conversationID string,
	onReady func(),
	emit func(domain.StreamEvent) error,
) (bool, error) {
	m.mu.Lock()
	run := m.active[conversationID]
	m.mu.Unlock()
	if run == nil {
		return false, nil
	}
	return true, run.subscribe(ctx, onReady, emit)
}

func (m *chatRunManager) activeInfo(conversationID string) *ActiveRunInfo {
	m.mu.Lock()
	run := m.active[conversationID]
	m.mu.Unlock()
	if run == nil {
		return nil
	}
	info := run.snapshotInfo()
	return &info
}

func (m *chatRunManager) activeIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.active))
	for id := range m.active {
		ids = append(ids, id)
	}
	return ids
}

func (m *chatRunManager) cancel(conversationID string) bool {
	m.mu.Lock()
	run := m.active[conversationID]
	if run == nil {
		// Explicit stop may arrive before Prepare reserves the run. Remember the
		// intent briefly so the racing reserve cannot start a background Agent.
		m.cancelIntents[conversationID] = time.Now()
		m.pruneCancelIntentsLocked(time.Now())
		m.mu.Unlock()
		return false
	}
	m.mu.Unlock()
	run.cancel()
	return true
}

func (m *chatRunManager) cancelAndWait(ctx context.Context, conversationIDs ...string) {
	if len(conversationIDs) == 0 {
		return
	}
	seen := make(map[string]struct{}, len(conversationIDs))
	runs := make([]*detachedRun, 0, len(conversationIDs))

	m.mu.Lock()
	for _, id := range conversationIDs {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		if run := m.active[id]; run != nil {
			runs = append(runs, run)
		}
	}
	m.mu.Unlock()

	for _, run := range runs {
		run.cancel()
	}
	for _, run := range runs {
		select {
		case <-run.doneCh:
		case <-ctx.Done():
			return
		}
	}
}

func (m *chatRunManager) waitAll(ctx context.Context) error {
	m.mu.Lock()
	runs := make([]*detachedRun, 0, len(m.active))
	for _, run := range m.active {
		runs = append(runs, run)
	}
	m.mu.Unlock()

	for _, run := range runs {
		select {
		case <-run.doneCh:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// ActiveRun returns metadata for the active background Agent run of conversationID, or nil if idle.
func (s *ChatService) ActiveRun(conversationID string) *ActiveRunInfo {
	if s == nil || s.runs == nil {
		return nil
	}
	return s.runs.activeInfo(conversationID)
}

// ActiveRunConversationIDs returns conversation IDs currently executing background Agent runs.
func (s *ChatService) ActiveRunConversationIDs() []string {
	if s == nil || s.runs == nil {
		return []string{}
	}
	return s.runs.activeIDs()
}

// SubscribeRun atomically attaches to an active background Agent run.
// If no active run exists, returns attached=false without invoking onReady.
func (s *ChatService) SubscribeRun(
	ctx context.Context,
	conversationID string,
	onReady func(),
	emit func(domain.StreamEvent) error,
) (bool, error) {
	if s == nil || s.runs == nil {
		return false, nil
	}
	return s.runs.subscribe(ctx, conversationID, onReady, emit)
}

// CancelRun explicitly cancels the active background Agent run for conversationID.
func (s *ChatService) CancelRun(conversationID string) bool {
	if s == nil || s.runs == nil {
		return false
	}
	return s.runs.cancel(conversationID)
}

// CancelRunsAndWait cancels the matching active background Agent runs and waits until
// their in-flight persistence completes (or ctx expires).
func (s *ChatService) CancelRunsAndWait(ctx context.Context, conversationIDs ...string) {
	if s == nil || s.runs == nil {
		return
	}
	s.runs.cancelAndWait(ctx, conversationIDs...)
}

// Shutdown cancels all running background Agent executions and waits for persistence to converge.
func (s *ChatService) Shutdown(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if s.baseCancel != nil {
		s.baseCancel()
	}
	if s.runs == nil {
		return nil
	}
	return s.runs.waitAll(ctx)
}
