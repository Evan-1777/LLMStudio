package format

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const FormatIDOpenAICompletions = "openai-completions"

// OpenAICompletionsFormat implements the OpenAI Chat Completions (/v1/chat/completions) protocol.
type OpenAICompletionsFormat struct{}

// NewOpenAICompletionsFormat creates an OpenAI Chat Completions format plugin.
func NewOpenAICompletionsFormat() *OpenAICompletionsFormat {
	return &OpenAICompletionsFormat{}
}

func (f *OpenAICompletionsFormat) ID() string          { return FormatIDOpenAICompletions }
func (f *OpenAICompletionsFormat) DisplayName() string { return "OpenAI Chat Completions" }
func (f *OpenAICompletionsFormat) DefaultPath() string { return "/v1/chat/completions" }

func (f *OpenAICompletionsFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{
		MaxTokensField:        "max_completion_tokens",
		SupportsDeveloperRole: domain.BoolPtr(true),
		SupportsStreamOptions: domain.BoolPtr(true),
		ThinkingFormat:        "openai",
		ReasoningEffortField:  "reasoning_effort",
		CacheMode:             domain.CacheModeAuto,
	}
}

func (f *OpenAICompletionsFormat) PlanCache(_ context.Context, input plugin.ChatInput, current *plugin.PromptCacheState) (plugin.CachePlan, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	inline := f.appliesCacheFields(input, compat) && !cacheStateUnsupported(current)
	return plugin.CachePlan{
		ReuseState:  current,
		InlineCache: inline,
	}, nil
}

// appliesCacheFields reports whether this format adds its own cache fields for
// the resolved generation target. Documented OpenAI endpoints follow the shared
// preference; compatibility endpoints only honour an explicit model mode.
func (f *OpenAICompletionsFormat) appliesCacheFields(input plugin.ChatInput, compat domain.CompatConfig) bool {
	policy := resolveCachePolicy(input, compat)
	if isOpenAIOfficialEndpoint(input.GenerationURL, f.DefaultPath()) {
		return policy.autoManaged()
	}
	return policy.explicitOnly()
}

func (f *OpenAICompletionsFormat) ResolveCache(_ context.Context, _ plugin.ChatInput, _ plugin.CachePlan, _ plugin.CacheResolutionInput) (plugin.CacheResolutionResult, error) {
	return plugin.CacheResolutionResult{}, nil
}

func (f *OpenAICompletionsFormat) ClassifyCacheError(statusCode int, body []byte, _ *plugin.PromptCacheState) plugin.CacheFailureAction {
	return classifyInlineCacheError(statusCode, body, "prompt_cache_options", "prompt_cache_breakpoint", "prompt_cache")
}

func (f *OpenAICompletionsFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)
	policy := resolveCachePolicy(input, compat)
	cacheFields := policy.autoManaged() && !cacheStateUnsupported(input.PromptCache)
	compatFields := policy.explicitOnly() && !cacheStateUnsupported(input.PromptCache)

	messages := make([]map[string]any, 0, len(input.Messages)+1)
	hasSystem := false
	if strings.TrimSpace(input.SystemPrompt) != "" {
		sysRole := "system"
		if compat.DeveloperRoleSupported() {
			sysRole = "developer"
		}
		messages = append(messages, map[string]any{
			"role":    sysRole,
			"content": input.SystemPrompt,
		})
		hasSystem = true
	}

	for _, msg := range input.Messages {
		switch msg.Role {
		case domain.RoleUser:
			if encoded, ok := encodeOpenAIUserMessage(msg.Blocks); ok {
				messages = append(messages, encoded)
			}
			for _, tr := range extractToolResults(msg.Blocks) {
				messages = append(messages, tr)
			}
		case domain.RoleAssistant:
			messages = append(messages, encodeOpenAIAssistantTurns(msg.Blocks)...)
		case domain.RoleToolResult:
			for _, tr := range extractToolResults(msg.Blocks) {
				messages = append(messages, tr)
			}
		}
	}

	body := map[string]any{
		"model":    input.Model.ID,
		"messages": messages,
		"stream":   true,
	}
	if compat.StreamOptionsSupported() {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if params.Temperature != nil {
		body["temperature"] = *params.Temperature
	}
	if params.MaxTokens != nil && *params.MaxTokens > 0 {
		maxField := compat.MaxTokensField
		if maxField == "" {
			maxField = "max_completion_tokens"
		}
		body[maxField] = *params.MaxTokens
	}
	if effort := strings.ToLower(strings.TrimSpace(params.ReasoningEffort)); effort != "" {
		effortField := compat.ReasoningEffortField
		if effortField == "" {
			effortField = "reasoning_effort"
		}
		setNestedField(body, effortField, effort)
	}
	if len(input.Tools) > 0 {
		encodedTools := make([]map[string]any, 0, len(input.Tools))
		for _, t := range input.Tools {
			fn := map[string]any{
				"name":       t.Alias,
				"parameters": plugin.NormalizeToolSchema(t.InputSchema),
			}
			if desc := strings.TrimSpace(t.Description); desc != "" {
				fn["description"] = desc
			}
			encodedTools = append(encodedTools, map[string]any{
				"type":     "function",
				"function": fn,
			})
		}
		body["tools"] = encodedTools
	}
	if isOpenAIOfficialEndpoint(input.GenerationURL, f.DefaultPath()) {
		if policy.mode == domain.CacheModeExplicit && (hasExtraBodyKey(compat.ExtraBody, "prompt_cache_options") || hasExtraBodyKey(compat.ExtraBody, "prompt_cache_breakpoint")) {
			return plugin.EncodedRequest{}, domain.NewError(
				domain.ErrCodeInvalidArgument,
				"prompt_cache_options/prompt_cache_breakpoint are not supported on the OpenAI API; remove them from compat.extraBody",
				nil,
			)
		}
		if cacheFields {
			body["prompt_cache_key"] = openAIPromptCacheKey(input, f.ID())
		}
	} else if compatFields {
		if !hasExtraBodyKey(compat.ExtraBody, "prompt_cache_options") {
			body["prompt_cache_options"] = map[string]any{"mode": "explicit"}
		}
		if !hasExtraBodyKey(compat.ExtraBody, "messages") {
			applyOpenAICompletionsCacheBreakpoints(messages, hasSystem)
		}
	}
	if len(compat.ExtraBody) > 0 {
		MergeBodyMap(body, compat.ExtraBody)
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return plugin.EncodedRequest{}, err
	}
	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")
	return plugin.EncodedRequest{
		Method:      http.MethodPost,
		DefaultPath: f.DefaultPath(),
		Headers:     headers,
		Body:        payload,
	}, nil
}

func applyOpenAICompletionsCacheBreakpoints(messages []map[string]any, hasSystem bool) {
	if len(messages) == 0 {
		return
	}
	attach := func(msg map[string]any) bool {
		switch c := msg["content"].(type) {
		case string:
			if strings.TrimSpace(c) == "" {
				return false
			}
			msg["content"] = []map[string]any{{
				"type":                    "text",
				"text":                    c,
				"prompt_cache_breakpoint": map[string]any{"mode": "explicit"},
			}}
			return true
		case []map[string]any:
			if len(c) == 0 {
				return false
			}
			if _, exists := c[len(c)-1]["prompt_cache_breakpoint"]; !exists {
				c[len(c)-1]["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
			}
			return true
		default:
			return false
		}
	}

	startIdx := 0
	if hasSystem {
		attach(messages[0])
		startIdx = 1
	}
	for i := len(messages) - 2; i >= startIdx; i-- {
		if attach(messages[i]) {
			return
		}
	}
}

func encodeOpenAIUserMessage(blocks []domain.ContentBlock) (map[string]any, bool) {
	hasImage := false
	var textParts []string
	parts := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		switch b.Type {
		case domain.BlockTypeText:
			textParts = append(textParts, b.Text)
			parts = append(parts, map[string]any{"type": "text", "text": b.Text})
		case domain.BlockTypeImage:
			if u := imageBlockDataURL(b); u != "" {
				hasImage = true
				parts = append(parts, map[string]any{
					"type":      "image_url",
					"image_url": map[string]any{"url": u},
				})
			}
		}
	}
	if len(parts) == 0 {
		return nil, false
	}
	if !hasImage {
		return map[string]any{
			"role":    "user",
			"content": strings.Join(textParts, "\n"),
		}, true
	}
	return map[string]any{
		"role":    "user",
		"content": parts,
	}, true
}

func encodeOpenAIAssistantTurns(blocks []domain.ContentBlock) []map[string]any {
	var out []map[string]any
	var textBuilder strings.Builder
	var toolCalls []map[string]any

	flushAssistant := func() {
		if textBuilder.Len() == 0 && len(toolCalls) == 0 {
			return
		}
		msg := map[string]any{"role": "assistant"}
		if textBuilder.Len() > 0 {
			msg["content"] = textBuilder.String()
		} else {
			msg["content"] = nil
		}
		if len(toolCalls) > 0 {
			msg["tool_calls"] = toolCalls
		}
		out = append(out, msg)
		textBuilder.Reset()
		toolCalls = nil
	}

	for _, b := range blocks {
		switch b.Type {
		case domain.BlockTypeText:
			textBuilder.WriteString(b.Text)
		case domain.BlockTypeToolCall:
			toolCalls = append(toolCalls, map[string]any{
				"id":   b.ID,
				"type": "function",
				"function": map[string]any{
					"name":      b.Name,
					"arguments": rawArgumentsString(b.Arguments),
				},
			})
		case domain.BlockTypeToolResult:
			flushAssistant()
			out = append(out, map[string]any{
				"role":         "tool",
				"tool_call_id": b.ToolCallID,
				"content":      formatToolResultContent(b),
			})
		}
	}
	flushAssistant()
	return out
}

func extractToolResults(blocks []domain.ContentBlock) []map[string]any {
	var out []map[string]any
	for _, b := range blocks {
		if b.Type != domain.BlockTypeToolResult {
			continue
		}
		out = append(out, map[string]any{
			"role":         "tool",
			"tool_call_id": b.ToolCallID,
			"content":      formatToolResultContent(b),
		})
	}
	return out
}

type openAICompletionsChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			Reasoning        string `json:"reasoning"`
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
		// DeepSeek-compatible endpoints report cache hits and misses at the top
		// level; pointers keep an explicit zero apart from an omitted field.
		PromptCacheHitTokens  *int `json:"prompt_cache_hit_tokens"`
		PromptCacheMissTokens *int `json:"prompt_cache_miss_tokens"`
		PromptTokensDetails   *struct {
			CachedTokens        int `json:"cached_tokens"`
			CacheWriteTokens    int `json:"cache_write_tokens"`
			CacheCreationTokens int `json:"cache_creation_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionTokensDetails *struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Code    any    `json:"code"`
	} `json:"error"`
}

func (f *OpenAICompletionsFormat) DecodeStream(ctx context.Context, body io.Reader, emit func(domain.StreamEvent) error) error {
	type toolBlockState struct {
		blockIdx int
		id       string
		name     string
		args     strings.Builder
		closed   bool
	}

	var (
		nextBlockIdx  int
		activeTextIdx = -1
		textBuf       strings.Builder
		activeThink   = -1
		thinkBuf      strings.Builder
		toolStates    = make(map[int]*toolBlockState)
		toolOrder     []int
		stopReason    string
		finalUsage    *domain.Usage
		emittedEnd    bool
	)

	closeThinking := func() error {
		if activeThink < 0 {
			return nil
		}
		err := emitBlockEnd(emit, activeThink, domain.ContentBlock{
			Type:     domain.BlockTypeThinking,
			Thinking: thinkBuf.String(),
		})
		activeThink = -1
		thinkBuf.Reset()
		return err
	}

	closeText := func() error {
		if activeTextIdx < 0 {
			return nil
		}
		err := emitBlockEnd(emit, activeTextIdx, domain.ContentBlock{
			Type: domain.BlockTypeText,
			Text: textBuf.String(),
		})
		activeTextIdx = -1
		textBuf.Reset()
		return err
	}

	closeAllOpen := func() error {
		if err := closeThinking(); err != nil {
			return err
		}
		if err := closeText(); err != nil {
			return err
		}
		for _, tcIdx := range toolOrder {
			st := toolStates[tcIdx]
			if st.closed {
				continue
			}
			st.closed = true
			if err := emitBlockEnd(emit, st.blockIdx, domain.ContentBlock{
				Type:      domain.BlockTypeToolCall,
				ID:        st.id,
				Name:      st.name,
				Arguments: rawArgumentsJSON(st.args.String()),
			}); err != nil {
				return err
			}
		}
		return nil
	}

	finalizeStream := func() error {
		if emittedEnd {
			return nil
		}
		emittedEnd = true
		if err := closeAllOpen(); err != nil {
			return err
		}
		if stopReason == "" {
			if len(toolOrder) > 0 {
				stopReason = domain.StopReasonToolUse
			} else {
				stopReason = domain.StopReasonStop
			}
		}
		return emit(domain.StreamEvent{
			Type:       domain.StreamEventMessageDelta,
			Usage:      finalUsage,
			StopReason: stopReason,
		})
	}

	err := ScanSSE(ctx, body, func(frame SSEFrame) error {
		data := strings.TrimSpace(frame.Data)
		if data == "" {
			return nil
		}
		if data == "[DONE]" {
			return finalizeStream()
		}

		var chunk openAICompletionsChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return nil
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return emit(domain.StreamEvent{
				Type: domain.StreamEventError,
				Error: &domain.StreamError{
					Code:    domain.ErrCodeUpstreamError,
					Message: chunk.Error.Message,
				},
			})
		}

		if chunk.Usage != nil {
			promptTokens := chunk.Usage.PromptTokens
			hit := chunk.Usage.PromptCacheHitTokens
			miss := chunk.Usage.PromptCacheMissTokens
			if promptTokens == 0 && hit != nil && miss != nil {
				// DeepSeek-compatible endpoints may omit prompt_tokens; the hit
				// plus miss split reconstructs the input total. A miss is an
				// uncached prompt, never a cache write.
				promptTokens = *hit + *miss
			}
			total := chunk.Usage.TotalTokens
			if total == 0 {
				total = promptTokens + chunk.Usage.CompletionTokens
			}
			u := &domain.Usage{
				InputTokens:  promptTokens,
				OutputTokens: chunk.Usage.CompletionTokens,
				TotalTokens:  total,
			}
			if chunk.Usage.PromptTokensDetails != nil {
				u.CacheReadInputTokens = chunk.Usage.PromptTokensDetails.CachedTokens
				if chunk.Usage.PromptTokensDetails.CacheWriteTokens > 0 {
					u.CacheCreationInputTokens = chunk.Usage.PromptTokensDetails.CacheWriteTokens
				} else {
					u.CacheCreationInputTokens = chunk.Usage.PromptTokensDetails.CacheCreationTokens
				}
			} else if hit != nil {
				// Never add the compatible field on top of a reported detail.
				u.CacheReadInputTokens = *hit
			}
			if chunk.Usage.CompletionTokensDetails != nil {
				u.ThinkingTokens = chunk.Usage.CompletionTokensDetails.ReasoningTokens
			}
			finalUsage = u
		}

		if len(chunk.Choices) == 0 {
			return nil
		}
		choice := chunk.Choices[0]

		reasoningDelta := choice.Delta.ReasoningContent
		if reasoningDelta == "" {
			reasoningDelta = choice.Delta.Reasoning
		}
		if reasoningDelta != "" {
			if err := closeText(); err != nil {
				return err
			}
			if activeThink < 0 {
				activeThink = nextBlockIdx
				nextBlockIdx++
				if err := emit(domain.StreamEvent{
					Type:      domain.StreamEventBlockStart,
					Index:     domain.IntPtr(activeThink),
					BlockType: domain.BlockTypeThinking,
				}); err != nil {
					return err
				}
			}
			thinkBuf.WriteString(reasoningDelta)
			if err := emitBlockDelta(emit, activeThink, domain.BlockTypeThinking, domain.DeltaTypeThinking, reasoningDelta); err != nil {
				return err
			}
		}

		if choice.Delta.Content != "" {
			if err := closeThinking(); err != nil {
				return err
			}
			if activeTextIdx < 0 {
				activeTextIdx = nextBlockIdx
				nextBlockIdx++
				if err := emit(domain.StreamEvent{
					Type:      domain.StreamEventBlockStart,
					Index:     domain.IntPtr(activeTextIdx),
					BlockType: domain.BlockTypeText,
				}); err != nil {
					return err
				}
			}
			textBuf.WriteString(choice.Delta.Content)
			if err := emitBlockDelta(emit, activeTextIdx, domain.BlockTypeText, domain.DeltaTypeText, choice.Delta.Content); err != nil {
				return err
			}
		}

		for _, tc := range choice.Delta.ToolCalls {
			if err := closeThinking(); err != nil {
				return err
			}
			if err := closeText(); err != nil {
				return err
			}
			st, exists := toolStates[tc.Index]
			if exists && tc.ID != "" && st.id != "" && tc.ID != st.id {
				// Broken proxy reused tool index for a brand-new call id: close prior slot cleanly.
				if !st.closed {
					st.closed = true
					if err := emitBlockEnd(emit, st.blockIdx, domain.ContentBlock{
						Type:      domain.BlockTypeToolCall,
						ID:        st.id,
						Name:      st.name,
						Arguments: rawArgumentsJSON(st.args.String()),
					}); err != nil {
						return err
					}
				}
				exists = false
			}
			if !exists {
				st = &toolBlockState{
					blockIdx: nextBlockIdx,
					id:       tc.ID,
					name:     tc.Function.Name,
				}
				nextBlockIdx++
				toolStates[tc.Index] = st
				toolOrder = append(toolOrder, tc.Index)
				if err := emit(domain.StreamEvent{
					Type:      domain.StreamEventBlockStart,
					Index:     domain.IntPtr(st.blockIdx),
					BlockType: domain.BlockTypeToolCall,
					Block: &domain.ContentBlock{
						Type: domain.BlockTypeToolCall,
						ID:   st.id,
						Name: st.name,
					},
				}); err != nil {
					return err
				}
			} else {
				if st.id == "" && tc.ID != "" {
					st.id = tc.ID
				}
				if st.name == "" && tc.Function.Name != "" {
					st.name = tc.Function.Name
				}
			}
			if tc.Function.Arguments != "" {
				st.args.WriteString(tc.Function.Arguments)
				if err := emitBlockDelta(emit, st.blockIdx, domain.BlockTypeToolCall, domain.DeltaTypeToolCallArgs, tc.Function.Arguments); err != nil {
					return err
				}
			}
		}

		if choice.FinishReason != "" {
			stopReason = mapOpenAIFinishReason(choice.FinishReason)
		}
		return nil
	})
	if err != nil {
		return err
	}
	return finalizeStream()
}

func mapOpenAIFinishReason(reason string) string {
	switch reason {
	case "length":
		return domain.StopReasonLength
	case "tool_calls", "function_call":
		return domain.StopReasonToolUse
	default:
		return domain.StopReasonStop
	}
}
