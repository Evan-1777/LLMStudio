package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

// Stream consumes upstream response bodies across tool-use rounds, translates events via emit,
// handles cancellation, and persists the single resulting assistant message.
func (p *PreparedStream) Stream(ctx context.Context, emit func(domain.StreamEvent) error) error {
	if p.detachedRun != nil {
		return p.detachedRun.subscribe(ctx, nil, emit)
	}
	acc := newStreamAccumulator()
	applyAndEmit := func(ev domain.StreamEvent) error {
		acc.apply(ev)
		return emit(ev)
	}
	setUsage := func(u *domain.Usage) {
		acc.usage = u
	}
	snapshotState := func() ([]domain.ContentBlock, *domain.Usage) {
		return acc.blocksSlice(), acc.usage
	}
	return p.runStream(ctx, applyAndEmit, setUsage, snapshotState, false)
}

func (p *PreparedStream) runStream(
	ctx context.Context,
	applyAndEmit func(domain.StreamEvent) error,
	setUsage func(*domain.Usage),
	snapshotState func() ([]domain.ContentBlock, *domain.Usage),
	emitAbortedEnd bool,
) error {
	assistantID := p.assistantID
	if assistantID == "" {
		assistantID = domain.NewUUID()
		if graphEnabled(p.conversation) && p.replaceMessageID != "" {
			assistantID = p.replaceMessageID
		}
	}

	persistAndMaybeNotifyAbort := func() {
		blocks, usage := snapshotState()
		saved, persistErr := p.persistResult(ctx, assistantID, blocks, usage, domain.StopReasonAborted, "")
		if emitAbortedEnd && persistErr == nil {
			_ = applyAndEmit(p.newStreamEvent(domain.StreamEventMessageEnd, assistantID, func(ev *domain.StreamEvent) {
				ev.Message = &saved
			}))
		}
	}

	emitStreamError := func(code, msg string) {
		_ = applyAndEmit(p.newStreamEvent(domain.StreamEventError, assistantID, func(ev *domain.StreamEvent) {
			ev.Error = &domain.StreamError{Code: code, Message: msg}
		}))
	}

	if err := applyAndEmit(p.newStreamEvent(domain.StreamEventMessageStart, assistantID, nil)); err != nil {
		_ = p.resp.Body.Close()
		persistAndMaybeNotifyAbort()
		return err
	}

	indexOffset, err := p.emitWebSearchBlock(assistantID, applyAndEmit)
	if err != nil {
		_ = p.resp.Body.Close()
		persistAndMaybeNotifyAbort()
		return err
	}

	seenCallIDs := make(map[string]struct{})
	var cumulativeUsage *domain.Usage
	finalStopReason := domain.StopReasonStop
	resp := p.resp
	maxRounds := p.maxToolRounds
	if maxRounds <= 0 {
		maxRounds = domain.DefaultMCPMaxToolRounds
	}

	for round := 0; ; round++ {
		roundOut, decodeErr := p.decodeStreamRound(ctx, resp, round, assistantID, indexOffset, seenCallIDs, cumulativeUsage, applyAndEmit)
		_ = resp.Body.Close()

		if ctx.Err() != nil || errors.Is(decodeErr, context.Canceled) {
			persistAndMaybeNotifyAbort()
			return nil
		}
		if decodeErr != nil || roundOut.streamErrMsg != "" {
			errMsg := roundOut.streamErrMsg
			if errMsg == "" && decodeErr != nil {
				errMsg = decodeErr.Error()
			}
			blocks, usage := snapshotState()
			_, _ = p.persistResult(ctx, assistantID, blocks, usage, domain.StopReasonError, errMsg)
			if roundOut.streamErrMsg == "" {
				emitStreamError(domain.ErrCodeUpstreamError, errMsg)
			}
			return nil
		}

		cumulativeUsage = addUsage(cumulativeUsage, roundOut.usage)
		setUsage(cumulativeUsage)
		indexOffset = roundOut.maxSeenIdx + 1

		effectiveStop := roundOut.stopReason
		if effectiveStop == "" {
			if len(roundOut.calls) > 0 {
				effectiveStop = domain.StopReasonToolUse
			} else {
				effectiveStop = domain.StopReasonStop
			}
		}

		if effectiveStop != domain.StopReasonToolUse || len(roundOut.calls) == 0 {
			finalStopReason = effectiveStop
			break
		}
		if len(p.tools) == 0 && p.service.mcpClient == nil {
			finalStopReason = effectiveStop
			break
		}

		if round >= maxRounds {
			limitMsg := fmt.Sprintf("达到最大工具调用轮数上限（%d 轮）", maxRounds)
			blocks, usage := snapshotState()
			_, _ = p.persistResult(ctx, assistantID, blocks, usage, domain.StopReasonError, limitMsg)
			emitStreamError("MCP_ROUND_LIMIT", limitMsg)
			return nil
		}

		nextOffset, emitErr, aborted := p.executeRoundToolCalls(ctx, assistantID, roundOut.calls, indexOffset, applyAndEmit)
		if emitErr != nil || aborted {
			persistAndMaybeNotifyAbort()
			return emitErr
		}
		indexOffset = nextOffset

		nextResp, contErr := p.openContinuationRound(ctx, snapshotState)
		if contErr != nil {
			if ctx.Err() != nil {
				persistAndMaybeNotifyAbort()
				return nil
			}
			errMsg := contErr.Error()
			blocks, usage := snapshotState()
			_, _ = p.persistResult(ctx, assistantID, blocks, usage, domain.StopReasonError, errMsg)
			emitStreamError(domain.ErrCodeUpstreamError, errMsg)
			return nil
		}
		resp = nextResp
	}

	blocks, usage := snapshotState()
	saved, persistErr := p.persistResult(ctx, assistantID, blocks, usage, finalStopReason, "")
	if persistErr != nil {
		emitStreamError("PERSIST_FAILED", fmt.Sprintf("保存消息失败: %v", persistErr))
		return nil
	}
	return applyAndEmit(p.newStreamEvent(domain.StreamEventMessageEnd, assistantID, func(ev *domain.StreamEvent) {
		ev.Message = &saved
	}))
}

func (p *PreparedStream) newStreamEvent(evType, assistantID string, fill func(*domain.StreamEvent)) domain.StreamEvent {
	ev := domain.StreamEvent{
		Type:           evType,
		ConversationID: p.conversation.ID,
		MessageID:      assistantID,
		ProviderID:     p.provider.ID,
		ModelID:        p.model.ID,
	}
	if fill != nil {
		fill(&ev)
	}
	return ev
}

func (p *PreparedStream) emitWebSearchBlock(assistantID string, applyAndEmit func(domain.StreamEvent) error) (int, error) {
	if p.webSearchBlock == nil {
		return 0, nil
	}
	idxZero := domain.IntPtr(0)
	wsStart := p.newStreamEvent(domain.StreamEventBlockStart, assistantID, func(ev *domain.StreamEvent) {
		ev.Index = idxZero
		ev.BlockType = domain.BlockTypeWebSearch
		ev.Block = p.webSearchBlock
	})
	if err := applyAndEmit(wsStart); err != nil {
		return 0, err
	}
	wsEnd := p.newStreamEvent(domain.StreamEventBlockEnd, assistantID, func(ev *domain.StreamEvent) {
		ev.Index = idxZero
		ev.BlockType = domain.BlockTypeWebSearch
		ev.Block = p.webSearchBlock
	})
	if err := applyAndEmit(wsEnd); err != nil {
		return 0, err
	}
	return 1, nil
}

type streamRoundOutcome struct {
	streamErrMsg string
	usage        *domain.Usage
	stopReason   string
	calls        []domain.ContentBlock
	maxSeenIdx   int
}

func allocateUniqueToolCallID(rawID string, round, idx int, seen map[string]struct{}) string {
	id := strings.TrimSpace(rawID)
	if id == "" {
		id = fmt.Sprintf("call_r%d_%d", round+1, idx)
	}
	if _, exists := seen[id]; exists {
		base := fmt.Sprintf("call_r%d_%d", round+1, idx)
		id = base
		for suffix := 2; ; suffix++ {
			if _, clash := seen[id]; !clash {
				break
			}
			id = fmt.Sprintf("%s_%d", base, suffix)
		}
	}
	seen[id] = struct{}{}
	return id
}

func (p *PreparedStream) decodeStreamRound(
	ctx context.Context,
	resp *http.Response,
	round int,
	assistantID string,
	indexOffset int,
	seenCallIDs map[string]struct{},
	cumulativeUsage *domain.Usage,
	applyAndEmit func(domain.StreamEvent) error,
) (streamRoundOutcome, error) {
	out := streamRoundOutcome{maxSeenIdx: indexOffset - 1}
	roundCallIDs := make(map[int]string)

	decodeErr := p.apiFormat.DecodeStream(ctx, resp.Body, func(ev domain.StreamEvent) error {
		ev.ConversationID = p.conversation.ID
		ev.MessageID = assistantID
		ev.ProviderID = p.provider.ID
		ev.ModelID = p.model.ID
		if ev.Index != nil {
			shifted := *ev.Index + indexOffset
			ev.Index = &shifted
			if shifted > out.maxSeenIdx {
				out.maxSeenIdx = shifted
			}
		}

		if ev.Block != nil && ev.Block.Type == domain.BlockTypeToolCall && ev.Index != nil {
			bCopy := *ev.Block
			bCopy.ToolSource = p.toolBindings[bCopy.Name].source()
			idx := *ev.Index
			switch ev.Type {
			case domain.StreamEventBlockStart:
				id := allocateUniqueToolCallID(bCopy.ID, round, idx, seenCallIDs)
				roundCallIDs[idx] = id
				bCopy.ID = id
				ev.Block = &bCopy
			case domain.StreamEventBlockEnd:
				id, ok := roundCallIDs[idx]
				if !ok {
					id = allocateUniqueToolCallID(bCopy.ID, round, idx, seenCallIDs)
					roundCallIDs[idx] = id
				}
				bCopy.ID = id
				ev.Block = &bCopy
				out.calls = append(out.calls, bCopy)
			}
		}

		if ev.Type == domain.StreamEventMessageDelta {
			if ev.Usage != nil {
				u := *ev.Usage
				out.usage = &u
				ev.Usage = addUsage(addUsage(nil, cumulativeUsage), out.usage)
			}
			if ev.StopReason != "" {
				out.stopReason = ev.StopReason
			}
		}

		if ev.Type == domain.StreamEventError && ev.Error != nil {
			out.streamErrMsg = ev.Error.Message
		}
		return applyAndEmit(ev)
	})
	return out, decodeErr
}

func (p *PreparedStream) executeRoundToolCalls(
	ctx context.Context,
	assistantID string,
	calls []domain.ContentBlock,
	indexOffset int,
	applyAndEmit func(domain.StreamEvent) error,
) (int, error, bool) {
	for _, tc := range calls {
		if ctx.Err() != nil {
			return indexOffset, nil, true
		}
		trBlock, execErr := p.service.executeToolCall(ctx, p.toolBindings, tc)
		if execErr != nil || ctx.Err() != nil {
			return indexOffset, nil, true
		}
		resIdx := indexOffset
		indexOffset++
		trCopy := trBlock
		evStart := p.newStreamEvent(domain.StreamEventBlockStart, assistantID, func(ev *domain.StreamEvent) {
			ev.Index = domain.IntPtr(resIdx)
			ev.BlockType = domain.BlockTypeToolResult
			ev.Block = &trCopy
		})
		if err := applyAndEmit(evStart); err != nil {
			return indexOffset, err, false
		}
		evEnd := p.newStreamEvent(domain.StreamEventBlockEnd, assistantID, func(ev *domain.StreamEvent) {
			ev.Index = domain.IntPtr(resIdx)
			ev.BlockType = domain.BlockTypeToolResult
			ev.Block = &trCopy
		})
		if err := applyAndEmit(evEnd); err != nil {
			return indexOffset, err, false
		}
	}
	if ctx.Err() != nil {
		return indexOffset, nil, true
	}
	return indexOffset, nil, false
}

func (p *PreparedStream) openContinuationRound(
	ctx context.Context,
	snapshotState func() ([]domain.ContentBlock, *domain.Usage),
) (*http.Response, error) {
	currentBlocks, _ := snapshotState()
	nextHistory := make([]domain.Message, len(p.history)+1)
	copy(nextHistory, p.history)
	nextHistory[len(p.history)] = domain.Message{
		ConversationID: p.conversation.ID,
		Role:           domain.RoleAssistant,
		Blocks:         filterBlocksForModelHistory(currentBlocks),
		ProviderID:     p.provider.ID,
		ModelID:        p.model.ID,
	}
	activeTools := p.service.filterEnabledToolsWithBindings(ctx, p.tools, p.toolBindings)
	nextInput := plugin.ChatInput{
		ConversationID:  p.conversation.ID,
		Provider:        p.provider,
		Model:           p.model,
		SystemPrompt:    p.systemPrompt,
		Messages:        nextHistory,
		Params:          p.params,
		Compat:          p.compat,
		Tools:           activeTools,
		AutoCreateCache: p.autoCreateCache,
	}
	var usedInlineCache bool
	if p.autoCreateCache {
		curCache := p.service.cacheStore.Get(p.cacheScope)
		activeCache, nextPlan, planErr := p.service.executeCachePlan(
			ctx,
			nextInput,
			p.apiFormat,
			p.adapter,
			p.cacheScope,
			curCache,
		)
		if planErr != nil {
			return nil, planErr
		}
		nextInput.PromptCache = activeCache
		usedInlineCache = nextPlan.InlineCache
	}
	nextResp, _, openErr := p.service.encodeAndOpenMainRequest(
		ctx,
		nextInput,
		p.apiFormat,
		p.adapter,
		p.cacheScope,
		usedInlineCache,
		true,
	)
	return nextResp, openErr
}

func (p *PreparedStream) persistResult(
	ctx context.Context,
	assistantID string,
	blocks []domain.ContentBlock,
	usage *domain.Usage,
	stopReason string,
	errMsg string,
) (domain.Message, error) {
	// Detach from canceled request context so partial responses persist reliably on abort.
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()

	msg := domain.Message{
		ID:             assistantID,
		GraphWrite:     p.graphWrite,
		ConversationID: p.conversation.ID,
		Role:           domain.RoleAssistant,
		Blocks:         blocks,
		ProviderID:     p.provider.ID,
		ModelID:        p.model.ID,
		Usage:          usage,
		StopReason:     stopReason,
		ErrorMessage:   errMsg,
		CreatedAt:      time.Now().UTC(),
	}
	var (
		saved domain.Message
		err   error
	)
	switch {
	case p.replaceMessageID != "":
		saved, err = p.service.msgs.ReplaceByID(persistCtx, p.conversation.ID, p.replaceMessageID, msg)
	case p.insertAfterMessageID != "":
		saved, err = p.service.msgs.InsertAfter(persistCtx, p.conversation.ID, p.insertAfterMessageID, msg)
	default:
		saved, err = p.service.msgs.Create(persistCtx, msg)
	}
	if err != nil {
		return domain.Message{}, err
	}
	_ = p.service.convs.TouchUpdatedAt(persistCtx, p.conversation.ID, time.Now().UTC())
	return saved, nil
}

type blockAccum struct {
	blockType  string
	id         string
	name       string
	startBlock *domain.ContentBlock
	completed  bool
	text       strings.Builder
	signature  strings.Builder
	finalized  *domain.ContentBlock
}

type streamAccumulator struct {
	order      []int
	blocks     map[int]*blockAccum
	usage      *domain.Usage
	stopReason string
}

func newStreamAccumulator() *streamAccumulator {
	return &streamAccumulator{
		blocks: make(map[int]*blockAccum),
	}
}

func (a *streamAccumulator) apply(ev domain.StreamEvent) {
	switch ev.Type {
	case domain.StreamEventBlockStart:
		if ev.Index == nil {
			return
		}
		idx := *ev.Index
		if _, exists := a.blocks[idx]; !exists {
			a.order = append(a.order, idx)
			b := &blockAccum{blockType: ev.BlockType}
			if ev.Block != nil {
				cp := *ev.Block
				b.startBlock = &cp
				b.id = ev.Block.ID
				b.name = ev.Block.Name
				if b.blockType == "" {
					b.blockType = ev.Block.Type
				}
			}
			a.blocks[idx] = b
		}
	case domain.StreamEventBlockDelta:
		if ev.Index == nil {
			return
		}
		b, ok := a.blocks[*ev.Index]
		if !ok {
			b = &blockAccum{blockType: ev.BlockType}
			a.order = append(a.order, *ev.Index)
			a.blocks[*ev.Index] = b
		}
		switch ev.DeltaType {
		case domain.DeltaTypeSignature:
			b.signature.WriteString(ev.Delta)
		default:
			b.text.WriteString(ev.Delta)
		}
	case domain.StreamEventBlockEnd:
		if ev.Index == nil {
			return
		}
		b, ok := a.blocks[*ev.Index]
		if !ok {
			bt := ev.BlockType
			if bt == "" && ev.Block != nil {
				bt = ev.Block.Type
			}
			b = &blockAccum{blockType: bt}
			a.order = append(a.order, *ev.Index)
			a.blocks[*ev.Index] = b
		}
		b.completed = true
		if ev.Block != nil {
			cp := *ev.Block
			b.finalized = &cp
		}
	case domain.StreamEventMessageDelta:
		if ev.Usage != nil {
			a.usage = ev.Usage
		}
		if ev.StopReason != "" {
			a.stopReason = ev.StopReason
		}
	}
}

func (a *streamAccumulator) blocksSlice() []domain.ContentBlock {
	out := make([]domain.ContentBlock, 0, len(a.order))
	for _, idx := range a.order {
		b := a.blocks[idx]
		if b.finalized != nil {
			out = append(out, *b.finalized)
			continue
		}
		switch b.blockType {
		case domain.BlockTypeThinking:
			out = append(out, domain.ContentBlock{
				Type:      domain.BlockTypeThinking,
				Thinking:  b.text.String(),
				Signature: b.signature.String(),
			})
		case domain.BlockTypeToolCall:
			var args json.RawMessage
			if raw := strings.TrimSpace(b.text.String()); raw != "" {
				if json.Valid([]byte(raw)) {
					args = json.RawMessage(raw)
				} else if encoded, err := json.Marshal(raw); err == nil {
					args = json.RawMessage(encoded)
				}
			}
			var source string
			if b.startBlock != nil {
				source = b.startBlock.ToolSource
			}
			out = append(out, domain.ContentBlock{
				Type:       domain.BlockTypeToolCall,
				ID:         b.id,
				Name:       b.name,
				ToolSource: source,
				Arguments:  args,
			})
		default:
			if b.startBlock != nil && b.blockType != domain.BlockTypeText {
				out = append(out, *b.startBlock)
				continue
			}
			out = append(out, domain.ContentBlock{
				Type: domain.BlockTypeText,
				Text: b.text.String(),
			})
		}
	}
	return out
}
