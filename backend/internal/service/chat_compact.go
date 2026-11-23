package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const compactionCheckpointPreamble = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint."

const compactionInstruction = `请仅基于以上对话内容生成一份结构化交接摘要，用于压缩历史上下文并保持后续任务无缝衔接。

要求：
- 不要回答最新问题，不要调用任何工具，不要输出寒暄、开场白或推理过程。
- 沿用对话的主要语言。
- 严格按以下 5 个 Markdown 章节组织输出，忠实保留精确标识、参数、路径、代码片段、报错与关键数值，未涉及的章节写“无”：

## 核心目标与约束
（保留原始目标、明确约束与关键原话）

## 关键结论与决策
（已确定的方案、决策理由与已排除选项）

## 已完成进展与事实
（已验证结果、检索结论、来源链接与产出）

## 关键上下文与状态
（精确标识、参数、路径、代码片段、报错信息与关键数值）

## 待办与下一步
（未决问题与后续动作）`

// CompactionMeta records the snapshot boundary and token savings of a compaction checkpoint.
type CompactionMeta struct {
	SnapshotLastMessageID string `json:"snapshotLastMessageId"`
	CompactedCount        int    `json:"compactedCount"`
	BeforeTokens          int    `json:"beforeTokens"`
	AfterTokens           int    `json:"afterTokens"`
}

// CompactConversationInput supplies parameters for server-side or prepared-local conversation compaction.
type CompactConversationInput struct {
	ConversationID     string `json:"-"`
	ProviderID         string `json:"providerId,omitempty"`
	ModelID            string `json:"modelId,omitempty"`
	CredentialEnvelope bool   `json:"credentialEnvelope,omitempty"`
}

// CompactConversationResult returns the created checkpoint message and refreshed conversation detail.
type CompactConversationResult struct {
	Message      domain.Message      `json:"message"`
	Conversation domain.Conversation `json:"conversation"`
	Messages     []domain.Message    `json:"messages"`
	Meta         CompactionMeta      `json:"meta"`
}

// PreparedLocalCompactPlan exposes split metadata needed by browser-direct compaction persistence.
type PreparedLocalCompactPlan struct {
	InsertAfterMessageID  string `json:"insertAfterMessageId,omitempty"`
	SnapshotLastMessageID string `json:"snapshotLastMessageId"`
	CompactedCount        int    `json:"compactedCount"`
	KeptCount             int    `json:"keptCount"`
	BeforeTokens          int    `json:"beforeTokens"`
}

// PreparedLocalCompactRequest holds the pre-encoded compaction request for browser-direct execution.
type PreparedLocalCompactRequest struct {
	Request      PreparedLocalHTTPRequest `json:"request"`
	ProviderID   string                   `json:"providerId"`
	ModelID      string                   `json:"modelId"`
	APIFormat    string                   `json:"apiFormat"`
	SystemPrompt string                   `json:"systemPrompt,omitempty"`
	Plan         PreparedLocalCompactPlan `json:"plan"`
}

type compactionPlan struct {
	activeStart           int
	contentStart          int
	compactedSpan         []domain.Message
	promptMessages        []domain.Message
	keptMessages          []domain.Message
	insertAfterMessageID  string
	snapshotLastMessageID string
	compactedCount        int
	keptCount             int
	beforeTokens          int
}

type preparedCompactionUpstream struct {
	up        conversationUpstreamContext
	plan      compactionPlan
	chatInput plugin.ChatInput
}

func compactionCheckpointText(m domain.Message) string {
	for _, b := range m.Blocks {
		if b.Type == domain.BlockTypeCompaction && strings.TrimSpace(b.Text) != "" {
			return b.Text
		}
	}
	for _, b := range m.Blocks {
		if b.Type == domain.BlockTypeText && strings.TrimSpace(b.Text) != "" {
			return b.Text
		}
	}
	return ""
}

// projectModelHistory projects a stored conversation timeline into the effective window seen by the model:
// if a compaction checkpoint exists, everything before the latest checkpoint is discarded and the checkpoint
// itself is presented as a structured user context message followed by subsequent turns.
func projectModelHistory(history []domain.Message) []domain.Message {
	lastIdx := -1
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == domain.RoleCompaction {
			lastIdx = i
			break
		}
	}
	if lastIdx < 0 {
		return history
	}
	checkpoint := history[lastIdx]
	projected := make([]domain.Message, 0, len(history)-lastIdx)
	projected = append(projected, domain.Message{
		ID:             checkpoint.ID,
		ConversationID: checkpoint.ConversationID,
		Role:           domain.RoleUser,
		Blocks: []domain.ContentBlock{{
			Type: domain.BlockTypeText,
			Text: compactionCheckpointPreamble + "\n\n" + compactionCheckpointText(checkpoint),
		}},
		CreatedAt: checkpoint.CreatedAt,
	})
	for _, m := range history[lastIdx+1:] {
		cp := m
		cp.Blocks = filterBlocksForModelHistory(m.Blocks)
		projected = append(projected, cp)
	}
	return projected
}

// ponytail: mirrors frontend estimateTextTokens (ASCII/3.5 + non-ASCII/1.5); swap together with TS if BPE is added.
func estimateTextTokens(text string) int {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0
	}
	asciiUnits := 0
	nonAsciiUnits := 0
	for _, r := range trimmed {
		if r <= 0x7f {
			asciiUnits++
		} else {
			nonAsciiUnits++
		}
	}
	est := int(math.Ceil(float64(asciiUnits)/3.5 + float64(nonAsciiUnits)/1.5))
	if est < 1 {
		return 1
	}
	return est
}

func toolResultTextForEstimate(b domain.ContentBlock) string {
	contentStr := b.Content
	if len(b.Extra) > 0 {
		var extraObj struct {
			StructuredContent json.RawMessage `json:"structuredContent"`
		}
		if err := json.Unmarshal(b.Extra, &extraObj); err == nil {
			sc := strings.TrimSpace(string(extraObj.StructuredContent))
			if sc != "" && sc != "null" && !strings.Contains(contentStr, sc) {
				if contentStr == "" {
					contentStr = sc
				} else {
					contentStr = contentStr + "\n" + sc
				}
			}
		}
	}
	return contentStr
}

func estimateBlockTokens(b domain.ContentBlock) int {
	switch b.Type {
	case domain.BlockTypeText:
		return estimateTextTokens(b.Text)
	case domain.BlockTypeThinking:
		return estimateTextTokens(b.Thinking)
	case domain.BlockTypeCompaction:
		return estimateTextTokens(b.Text)
	case domain.BlockTypeToolCall:
		args := strings.TrimSpace(string(b.Arguments))
		return estimateTextTokens(b.Name + " " + args)
	case domain.BlockTypeToolResult:
		return estimateTextTokens(b.ToolName + " " + toolResultTextForEstimate(b))
	case domain.BlockTypeImage:
		return 1024
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			return 0
		}
		return estimateTextTokens(string(raw))
	}
}

func estimateMessageTokens(m domain.Message) int {
	tokens := 4
	for _, b := range m.Blocks {
		tokens += estimateBlockTokens(b)
	}
	return tokens
}

func estimateMessagesTokens(systemPrompt string, msgs []domain.Message) int {
	tokens := 0
	if strings.TrimSpace(systemPrompt) != "" {
		tokens += estimateTextTokens(systemPrompt) + 4
	}
	for _, m := range msgs {
		tokens += estimateMessageTokens(m)
	}
	return tokens
}

func messageHasToolResultBlocks(m domain.Message) bool {
	for _, b := range m.Blocks {
		if b.Type == domain.BlockTypeToolResult {
			return true
		}
	}
	return false
}

func estimateCompactionBeforeTokens(systemPrompt string, history []domain.Message, plan compactionPlan) int {
	for i := len(history) - 1; i >= plan.contentStart; i-- {
		m := history[i]
		if m.Role != domain.RoleAssistant || m.Usage == nil {
			continue
		}
		var anchorTokens int
		switch {
		case m.Usage.ContextTokens > 0:
			anchorTokens = m.Usage.ContextTokens
		case !messageHasToolResultBlocks(m):
			if sum := m.Usage.InputTokens + m.Usage.OutputTokens; sum > 0 {
				anchorTokens = sum
			} else if m.Usage.TotalTokens > 0 {
				anchorTokens = m.Usage.TotalTokens
			}
		}
		if anchorTokens > 0 {
			trailing := 0
			for j := i + 1; j < len(history); j++ {
				trailing += estimateMessageTokens(history[j])
			}
			return anchorTokens + trailing
		}
	}
	return estimateMessagesTokens(systemPrompt, history[plan.activeStart:])
}

func selectCompactionPlan(history []domain.Message) (compactionPlan, error) {
	lastCompactIdx := -1
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == domain.RoleCompaction {
			lastCompactIdx = i
			break
		}
	}
	activeStart := max(0, lastCompactIdx)
	contentStart := lastCompactIdx + 1
	activeContent := history[contentStart:]
	if len(activeContent) < 2 {
		return compactionPlan{}, domain.NewError(domain.ErrCodeInvalidArgument, "当前有效对话内容过少，至少需要一轮完整对话才可压缩", nil)
	}

	var turnStarts []int
	for i := contentStart; i < len(history); i++ {
		if history[i].Role == domain.RoleUser || len(turnStarts) == 0 {
			turnStarts = append(turnStarts, i)
		}
	}

	plan := compactionPlan{
		activeStart:           activeStart,
		contentStart:          contentStart,
		snapshotLastMessageID: history[len(history)-1].ID,
	}
	if len(turnStarts) >= 2 {
		lastTurnStart := turnStarts[len(turnStarts)-1]
		plan.keptMessages = history[lastTurnStart:]
		plan.compactedSpan = history[activeStart:lastTurnStart]
		plan.insertAfterMessageID = plan.compactedSpan[len(plan.compactedSpan)-1].ID
		plan.compactedCount = lastTurnStart - contentStart
		plan.keptCount = len(history) - lastTurnStart
	} else {
		plan.compactedSpan = history[activeStart:]
		plan.keptMessages = nil
		plan.insertAfterMessageID = ""
		plan.compactedCount = len(history) - contentStart
		plan.keptCount = 0
	}
	plan.promptMessages = projectModelHistory(plan.compactedSpan)
	plan.beforeTokens = estimateCompactionBeforeTokens("", history, plan)
	return plan, nil
}

// A shared successor cannot be reparented without changing another branch. In
// that case summarize the whole active path and append the checkpoint instead.
func selectCompactionPlanForBranch(conv domain.Conversation, all, history []domain.Message) (compactionPlan, error) {
	plan, err := selectCompactionPlan(history)
	if err != nil || !graphEnabled(conv) || plan.insertAfterMessageID == "" {
		return plan, err
	}
	suffix := make(map[string]bool, len(plan.keptMessages))
	for _, m := range plan.keptMessages {
		suffix[m.ID] = true
	}
	shared := conv.GraphState.ActiveBranchID != ""
	for _, m := range all {
		if suffix[m.ParentID] && !suffix[m.ID] {
			shared = true
			break
		}
	}
	for _, slot := range conv.GraphState.Branches {
		if suffix[slot.ParentMessageID] {
			shared = true
			break
		}
	}
	if shared {
		plan.insertAfterMessageID = ""
		plan.compactedSpan = history[plan.activeStart:]
		plan.promptMessages = projectModelHistory(plan.compactedSpan)
		plan.compactedCount += plan.keptCount
		plan.keptCount, plan.keptMessages = 0, nil
	}
	return plan, nil
}

func buildCompactionChatInput(up conversationUpstreamContext, promptMessages []domain.Message) plugin.ChatInput {
	msgs := make([]domain.Message, len(promptMessages)+1)
	copy(msgs, promptMessages)
	msgs[len(promptMessages)] = domain.Message{
		ConversationID: up.conversation.ID,
		Role:           domain.RoleUser,
		Blocks: []domain.ContentBlock{{
			Type: domain.BlockTypeText,
			Text: compactionInstruction,
		}},
		CreatedAt: time.Now().UTC(),
	}

	params := up.params
	params.ReasoningEffort = ""

	return plugin.ChatInput{
		ConversationID:  up.conversation.ID,
		Provider:        up.provider,
		Model:           up.model,
		SystemPrompt:    up.systemPrompt,
		Messages:        msgs,
		Params:          params,
		Compat:          up.compat,
		Tools:           nil,
		AutoCreateCache: false,
		GenerationURL:   up.generationURL,
		PromptCache:     nil,
	}
}

func (s *ChatService) prepareCompactionUpstream(ctx context.Context, in CompactConversationInput, allowMissingLocalKey bool) (preparedCompactionUpstream, error) {
	up, err := s.resolveConversationUpstreamContext(ctx, in.ConversationID, in.ProviderID, in.ModelID, domain.GenerationParams{}, allowMissingLocalKey)
	if err != nil {
		return preparedCompactionUpstream{}, err
	}
	history, err := s.msgs.ListByConversation(ctx, up.conversation.ID)
	if err != nil {
		return preparedCompactionUpstream{}, err
	}
	all := history
	history = resolveActiveBranchPath(up.conversation, all)
	plan, err := selectCompactionPlanForBranch(up.conversation, all, history)
	if err != nil {
		return preparedCompactionUpstream{}, err
	}
	plan.beforeTokens = estimateCompactionBeforeTokens(up.systemPrompt, history, plan)
	chatInput := buildCompactionChatInput(up, plan.promptMessages)
	return preparedCompactionUpstream{
		up:        up,
		plan:      plan,
		chatInput: chatInput,
	}, nil
}

func extractCompactionSummaryText(blocks []domain.ContentBlock) string {
	var parts []string
	for _, b := range blocks {
		if b.Type == domain.BlockTypeText && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// Compact summarizes earlier conversation history into a non-destructive checkpoint message.
func (s *ChatService) Compact(ctx context.Context, in CompactConversationInput) (CompactConversationResult, error) {
	prep, err := s.prepareCompactionUpstream(ctx, in, false)
	if err != nil {
		return CompactConversationResult{}, err
	}

	resp, _, err := s.encodeAndOpenMainRequest(
		ctx,
		prep.chatInput,
		prep.up.apiFormat,
		prep.up.adapter,
		plugin.PromptCacheScope{},
		false,
		false,
	)
	if err != nil {
		return CompactConversationResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()

	acc := newStreamAccumulator()
	var streamErrMsg string
	decodeErr := prep.up.apiFormat.DecodeStream(ctx, resp.Body, func(ev domain.StreamEvent) error {
		acc.apply(ev)
		if ev.Type == domain.StreamEventError && ev.Error != nil {
			streamErrMsg = ev.Error.Message
		}
		return nil
	})
	if ctx.Err() != nil {
		return CompactConversationResult{}, domain.NewError(domain.ErrCodeUpstreamError, "request canceled", ctx.Err())
	}
	if decodeErr != nil || streamErrMsg != "" {
		msg := strings.TrimSpace(streamErrMsg)
		if msg == "" && decodeErr != nil {
			msg = decodeErr.Error()
		}
		return CompactConversationResult{}, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("compaction failed: %s", msg), decodeErr)
	}

	summary := extractCompactionSummaryText(acc.blocksSlice())
	if summary == "" {
		return CompactConversationResult{}, domain.NewError(domain.ErrCodeUpstreamError, "compaction returned empty summary", nil)
	}

	compactionPlaceholder := domain.Message{
		Role: domain.RoleCompaction,
		Blocks: []domain.ContentBlock{{
			Type: domain.BlockTypeCompaction,
			Text: summary,
		}},
	}
	afterMsgs := make([]domain.Message, 0, 1+len(prep.plan.keptMessages))
	afterMsgs = append(afterMsgs, compactionPlaceholder)
	afterMsgs = append(afterMsgs, prep.plan.keptMessages...)
	afterTokens := estimateMessagesTokens(prep.up.systemPrompt, afterMsgs)

	meta := CompactionMeta{
		SnapshotLastMessageID: prep.plan.snapshotLastMessageID,
		CompactedCount:        prep.plan.compactedCount,
		BeforeTokens:          prep.plan.beforeTokens,
		AfterTokens:           afterTokens,
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return CompactConversationResult{}, domain.NewError(domain.ErrCodeInternalError, "encode compaction metadata failed", err)
	}

	checkpoint := domain.Message{
		ConversationID: prep.up.conversation.ID,
		Role:           domain.RoleCompaction,
		Blocks: []domain.ContentBlock{{
			Type:  domain.BlockTypeCompaction,
			Text:  summary,
			Extra: metaJSON,
		}},
		ProviderID: prep.up.provider.ID,
		ModelID:    prep.up.model.ID,
		Usage:      acc.usage,
		StopReason: domain.StopReasonStop,
		CreatedAt:  time.Now().UTC(),
	}

	if graphEnabled(prep.up.conversation) && prep.plan.insertAfterMessageID == "" {
		checkpoint.GraphWrite = &domain.MessageGraphWrite{ParentID: &prep.plan.snapshotLastMessageID, ConsumeBranchID: prep.up.conversation.GraphState.ActiveBranchID}
	}
	var saved domain.Message
	if prep.plan.insertAfterMessageID != "" {
		saved, err = s.msgs.InsertAfter(ctx, prep.up.conversation.ID, prep.plan.insertAfterMessageID, checkpoint)
	} else {
		saved, err = s.msgs.Create(ctx, checkpoint)
	}
	if err != nil {
		return CompactConversationResult{}, err
	}

	_ = s.convs.TouchUpdatedAt(ctx, prep.up.conversation.ID, time.Now().UTC())
	updatedConv := prep.up.conversation
	if latest, gErr := s.convs.Get(ctx, prep.up.conversation.ID); gErr == nil {
		updatedConv = latest
	}
	orderedMsgs, err := s.msgs.ListByConversation(ctx, prep.up.conversation.ID)
	if err != nil {
		return CompactConversationResult{}, err
	}

	return CompactConversationResult{
		Message:      saved,
		Conversation: updatedConv,
		Messages:     orderedMsgs,
		Meta:         meta,
	}, nil
}

// PrepareLocalCompact validates inputs and pre-encodes an upstream compaction request for browser-direct execution.
func (s *ChatService) PrepareLocalCompact(ctx context.Context, in CompactConversationInput) (PreparedLocalCompactRequest, error) {
	prep, err := s.prepareCompactionUpstream(ctx, in, true)
	if err != nil {
		return PreparedLocalCompactRequest{}, err
	}

	authType := strings.TrimSpace(prep.up.provider.AuthType)
	if authType == "" {
		authType = domain.AuthTypeBearer
	}

	encoded, encErr := prep.up.apiFormat.EncodeRequest(ctx, prep.chatInput)
	if encErr != nil {
		if appErr, ok := domain.AsAppError(encErr); ok {
			return PreparedLocalCompactRequest{}, appErr
		}
		return PreparedLocalCompactRequest{}, domain.NewError(domain.ErrCodeInternalError, "encode compaction request failed", encErr)
	}

	endpoint, epErr := prep.up.adapter.ResolveEndpoint(
		localEndpointProvider(prep.up.provider, prep.up.resolveProv, in.CredentialEnvelope),
		prep.up.model,
		encoded.DefaultPath,
		encoded.Query,
		prep.up.compat,
	)
	if epErr != nil {
		return PreparedLocalCompactRequest{}, epErr
	}

	body := json.RawMessage(encoded.Body)
	if len(body) == 0 {
		body = json.RawMessage("{}")
	}

	return PreparedLocalCompactRequest{
		Request: PreparedLocalHTTPRequest{
			Method:   encoded.Method,
			URL:      endpoint.URL,
			Headers:  headersToStringMap(mergeRequestHeaders(encoded.Headers, endpoint.Headers)),
			Body:     body,
			AuthType: authType,
		},
		ProviderID:   prep.up.provider.ID,
		ModelID:      prep.up.model.ID,
		APIFormat:    prep.up.apiFormat.ID(),
		SystemPrompt: prep.up.systemPrompt,
		Plan: PreparedLocalCompactPlan{
			InsertAfterMessageID:  prep.plan.insertAfterMessageID,
			SnapshotLastMessageID: prep.plan.snapshotLastMessageID,
			CompactedCount:        prep.plan.compactedCount,
			KeptCount:             prep.plan.keptCount,
			BeforeTokens:          prep.plan.beforeTokens,
		},
	}, nil
}
