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

const (
	FormatIDAnthropicMessages = "anthropic-messages"
	anthropicAPIVersion       = "2023-06-01"
	defaultAnthropicMaxTokens = 4096
)

// AnthropicMessagesFormat implements the Anthropic Messages (/v1/messages) protocol.
type AnthropicMessagesFormat struct{}

// NewAnthropicMessagesFormat creates an Anthropic Messages format plugin.
func NewAnthropicMessagesFormat() *AnthropicMessagesFormat {
	return &AnthropicMessagesFormat{}
}

func (f *AnthropicMessagesFormat) ID() string          { return FormatIDAnthropicMessages }
func (f *AnthropicMessagesFormat) DisplayName() string { return "Anthropic Messages" }
func (f *AnthropicMessagesFormat) DefaultPath() string { return "/v1/messages" }

func (f *AnthropicMessagesFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{
		MaxTokensField: "max_tokens",
		ThinkingFormat: "anthropic",
	}
}

func (f *AnthropicMessagesFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)

	maxTokens := defaultAnthropicMaxTokens
	if params.MaxTokens != nil && *params.MaxTokens > 0 {
		maxTokens = *params.MaxTokens
	}

	var encodedMsgs []map[string]any
	appendMsg := func(role string, blocks []map[string]any) {
		if len(blocks) == 0 {
			return
		}
		if n := len(encodedMsgs); n > 0 && encodedMsgs[n-1]["role"] == role {
			existing := encodedMsgs[n-1]["content"].([]map[string]any)
			encodedMsgs[n-1]["content"] = append(existing, blocks...)
			return
		}
		encodedMsgs = append(encodedMsgs, map[string]any{
			"role":    role,
			"content": blocks,
		})
	}

	for _, msg := range input.Messages {
		switch msg.Role {
		case domain.RoleUser:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeText:
					parts = append(parts, map[string]any{"type": "text", "text": b.Text})
				case domain.BlockTypeImage:
					if imgPart, ok := encodeAnthropicImage(b); ok {
						parts = append(parts, imgPart)
					}
				case domain.BlockTypeToolResult:
					parts = append(parts, encodeAnthropicToolResult(b))
				}
			}
			appendMsg("user", parts)

		case domain.RoleAssistant:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeThinking:
					if b.Thinking != "" {
						part := map[string]any{
							"type":     "thinking",
							"thinking": b.Thinking,
						}
						if b.Signature != "" {
							part["signature"] = b.Signature
						}
						parts = append(parts, part)
					}
				case domain.BlockTypeText:
					parts = append(parts, map[string]any{"type": "text", "text": b.Text})
				case domain.BlockTypeToolCall:
					var argsObj any = map[string]any{}
					if len(b.Arguments) > 0 {
						_ = json.Unmarshal(b.Arguments, &argsObj)
					}
					parts = append(parts, map[string]any{
						"type":  "tool_use",
						"id":    b.ID,
						"name":  b.Name,
						"input": argsObj,
					})
				}
			}
			appendMsg("assistant", parts)

		case domain.RoleToolResult:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				if b.Type == domain.BlockTypeToolResult {
					parts = append(parts, encodeAnthropicToolResult(b))
				}
			}
			appendMsg("user", parts)
		}
	}

	body := map[string]any{
		"model":    input.Model.ID,
		"messages": encodedMsgs,
		"stream":   true,
	}
	if strings.TrimSpace(input.SystemPrompt) != "" {
		body["system"] = input.SystemPrompt
	}

	effort := strings.ToLower(strings.TrimSpace(params.ReasoningEffort))
	thinkingEnabled := false
	if effort != "" && effort != domain.EffortNone {
		budget := anthropicThinkingBudget(effort)
		if maxTokens <= budget {
			maxTokens = budget + 1024
		}
		body["thinking"] = map[string]any{
			"type":          "enabled",
			"budget_tokens": budget,
		}
		thinkingEnabled = true
	}

	maxField := compat.MaxTokensField
	if maxField == "" {
		maxField = "max_tokens"
	}
	body[maxField] = maxTokens

	if params.Temperature != nil && !thinkingEnabled {
		body["temperature"] = *params.Temperature
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
	headers.Set("anthropic-version", anthropicAPIVersion)
	return plugin.EncodedRequest{
		Method:      http.MethodPost,
		DefaultPath: f.DefaultPath(),
		Headers:     headers,
		Body:        payload,
	}, nil
}

func encodeAnthropicImage(b domain.ContentBlock) (map[string]any, bool) {
	if strings.TrimSpace(b.Data) != "" {
		mime := strings.TrimSpace(b.MimeType)
		if mime == "" {
			mime = "image/png"
		}
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": mime,
				"data":       b.Data,
			},
		}, true
	}
	if strings.TrimSpace(b.URL) != "" {
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type": "url",
				"url":  strings.TrimSpace(b.URL),
			},
		}, true
	}
	return nil, false
}

func encodeAnthropicToolResult(b domain.ContentBlock) map[string]any {
	part := map[string]any{
		"type":        "tool_result",
		"tool_use_id": b.ToolCallID,
		"content":     b.Content,
	}
	if b.IsError {
		part["is_error"] = true
	}
	return part
}

func anthropicThinkingBudget(effort string) int {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case domain.EffortLow:
		return 2048
	case domain.EffortHigh:
		return 8192
	case domain.EffortXHigh:
		return 16384
	case domain.EffortMax:
		return 32768
	default:
		return 4096
	}
}

type anthropicStreamEvent struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		Usage *struct {
			InputTokens              int `json:"input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			OutputTokens             int `json:"output_tokens"`
		} `json:"usage"`
	} `json:"message"`
	ContentBlock *struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"content_block"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		Signature   string `json:"signature"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage *struct {
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func (f *AnthropicMessagesFormat) DecodeStream(ctx context.Context, body io.Reader, emit func(domain.StreamEvent) error) error {
	type blockState struct {
		blockIdx  int
		blockType string
		id        string
		name      string
		buf       strings.Builder
		signature strings.Builder
		closed    bool
	}

	var (
		nextBlockIdx int
		blocks       = make(map[int]*blockState)
		blockOrder   []int
		usage        = &domain.Usage{}
		hasUsage     bool
		stopReason   string
		hasToolCall  bool
		emittedEnd   bool
		emittedError bool
	)

	closeBlock := func(st *blockState) error {
		if st == nil || st.closed {
			return nil
		}
		st.closed = true
		var b domain.ContentBlock
		switch st.blockType {
		case domain.BlockTypeThinking:
			b = domain.ContentBlock{
				Type:      domain.BlockTypeThinking,
				Thinking:  st.buf.String(),
				Signature: st.signature.String(),
			}
		case domain.BlockTypeToolCall:
			b = domain.ContentBlock{
				Type:      domain.BlockTypeToolCall,
				ID:        st.id,
				Name:      st.name,
				Arguments: rawArgumentsJSON(st.buf.String()),
			}
		default:
			b = domain.ContentBlock{
				Type: domain.BlockTypeText,
				Text: st.buf.String(),
			}
		}
		return emitBlockEnd(emit, st.blockIdx, b)
	}

	finalize := func() error {
		if emittedEnd || emittedError {
			return nil
		}
		emittedEnd = true
		for _, idx := range blockOrder {
			if err := closeBlock(blocks[idx]); err != nil {
				return err
			}
		}
		if stopReason == "" {
			if hasToolCall {
				stopReason = domain.StopReasonToolUse
			} else {
				stopReason = domain.StopReasonStop
			}
		}
		var outUsage *domain.Usage
		if hasUsage {
			usage.TotalTokens = usage.InputTokens + usage.OutputTokens
			outUsage = usage
		}
		return emit(domain.StreamEvent{
			Type:       domain.StreamEventMessageDelta,
			Usage:      outUsage,
			StopReason: stopReason,
		})
	}

	if err := ScanSSE(ctx, body, func(frame SSEFrame) error {
		data := strings.TrimSpace(frame.Data)
		if data == "" {
			return nil
		}
		var ev anthropicStreamEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil
		}
		evType := ev.Type
		if evType == "" {
			evType = frame.Event
		}

		switch evType {
		case "message_start":
			if ev.Message != nil && ev.Message.Usage != nil {
				u := ev.Message.Usage
				usage.InputTokens = u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
				usage.OutputTokens = u.OutputTokens
				hasUsage = true
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				return nil
			}
			var blockType string
			var initBlock *domain.ContentBlock
			switch ev.ContentBlock.Type {
			case "thinking":
				blockType = domain.BlockTypeThinking
			case "tool_use":
				blockType = domain.BlockTypeToolCall
				hasToolCall = true
				initBlock = &domain.ContentBlock{
					Type: domain.BlockTypeToolCall,
					ID:   ev.ContentBlock.ID,
					Name: ev.ContentBlock.Name,
				}
			default:
				blockType = domain.BlockTypeText
			}
			st := &blockState{
				blockIdx:  nextBlockIdx,
				blockType: blockType,
				id:        ev.ContentBlock.ID,
				name:      ev.ContentBlock.Name,
			}
			nextBlockIdx++
			blocks[ev.Index] = st
			blockOrder = append(blockOrder, ev.Index)
			return emit(domain.StreamEvent{
				Type:      domain.StreamEventBlockStart,
				Index:     domain.IntPtr(st.blockIdx),
				BlockType: blockType,
				Block:     initBlock,
			})

		case "content_block_delta":
			st, ok := blocks[ev.Index]
			if !ok || ev.Delta == nil {
				return nil
			}
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					st.buf.WriteString(ev.Delta.Text)
					return emitBlockDelta(emit, st.blockIdx, st.blockType, domain.DeltaTypeText, ev.Delta.Text)
				}
			case "thinking_delta":
				if ev.Delta.Thinking != "" {
					st.buf.WriteString(ev.Delta.Thinking)
					return emitBlockDelta(emit, st.blockIdx, st.blockType, domain.DeltaTypeThinking, ev.Delta.Thinking)
				}
			case "signature_delta":
				if ev.Delta.Signature != "" {
					st.signature.WriteString(ev.Delta.Signature)
					return emitBlockDelta(emit, st.blockIdx, st.blockType, domain.DeltaTypeSignature, ev.Delta.Signature)
				}
			case "input_json_delta":
				if ev.Delta.PartialJSON != "" {
					st.buf.WriteString(ev.Delta.PartialJSON)
					return emitBlockDelta(emit, st.blockIdx, st.blockType, domain.DeltaTypeToolCallArgs, ev.Delta.PartialJSON)
				}
			}

		case "content_block_stop":
			if st, ok := blocks[ev.Index]; ok {
				return closeBlock(st)
			}

		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != "" {
				stopReason = mapAnthropicStopReason(ev.Delta.StopReason)
			}
			if ev.Usage != nil {
				usage.OutputTokens = ev.Usage.OutputTokens
				hasUsage = true
			}

		case "message_stop":
			return finalize()

		case "error":
			emittedError = true
			msg := "upstream anthropic error"
			if ev.Error != nil && ev.Error.Message != "" {
				msg = ev.Error.Message
			}
			return emit(domain.StreamEvent{
				Type: domain.StreamEventError,
				Error: &domain.StreamError{
					Code:    domain.ErrCodeUpstreamError,
					Message: msg,
				},
			})
		}
		return nil
	}); err != nil {
		return err
	}
	if len(blockOrder) > 0 && !emittedEnd && !emittedError {
		return finalize()
	}
	return nil
}

func mapAnthropicStopReason(reason string) string {
	switch reason {
	case "max_tokens":
		return domain.StopReasonLength
	case "tool_use":
		return domain.StopReasonToolUse
	default:
		return domain.StopReasonStop
	}
}
