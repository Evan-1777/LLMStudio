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

func (f *OpenAICompletionsFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{
		MaxTokensField:        "max_completion_tokens",
		SupportsDeveloperRole: domain.BoolPtr(true),
		SupportsStreamOptions: domain.BoolPtr(true),
		ThinkingFormat:        "openai",
		ReasoningEffortField:  "reasoning_effort",
	}
}

func (f *OpenAICompletionsFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)

	messages := make([]map[string]any, 0, len(input.Messages)+1)
	if strings.TrimSpace(input.SystemPrompt) != "" {
		sysRole := "system"
		if compat.DeveloperRoleSupported() {
			sysRole = "developer"
		}
		messages = append(messages, map[string]any{
			"role":    sysRole,
			"content": input.SystemPrompt,
		})
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
			if encoded, ok := encodeOpenAIAssistantMessage(msg.Blocks); ok {
				messages = append(messages, encoded)
			}
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
	if params.ReasoningEffort != "" {
		effortField := compat.ReasoningEffortField
		if effortField == "" {
			effortField = "reasoning_effort"
		}
		setNestedField(body, effortField, params.ReasoningEffort)
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
		DefaultPath: "/v1/chat/completions",
		Headers:     headers,
		Body:        payload,
	}, nil
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

func encodeOpenAIAssistantMessage(blocks []domain.ContentBlock) (map[string]any, bool) {
	var textBuilder strings.Builder
	var toolCalls []map[string]any
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
		}
	}
	if textBuilder.Len() == 0 && len(toolCalls) == 0 {
		return nil, false
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
	return msg, true
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
			"content":      b.Content,
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
		PromptTokens            int `json:"prompt_tokens"`
		CompletionTokens        int `json:"completion_tokens"`
		TotalTokens             int `json:"total_tokens"`
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
			u := &domain.Usage{
				InputTokens:  chunk.Usage.PromptTokens,
				OutputTokens: chunk.Usage.CompletionTokens,
				TotalTokens:  chunk.Usage.TotalTokens,
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
