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

const FormatIDOpenAIResponses = "openai-responses"

// OpenAIResponsesFormat implements the OpenAI Responses (/v1/responses) protocol.
type OpenAIResponsesFormat struct{}

// NewOpenAIResponsesFormat creates an OpenAI Responses format plugin.
func NewOpenAIResponsesFormat() *OpenAIResponsesFormat {
	return &OpenAIResponsesFormat{}
}

func (f *OpenAIResponsesFormat) ID() string          { return FormatIDOpenAIResponses }
func (f *OpenAIResponsesFormat) DisplayName() string { return "OpenAI Responses" }
func (f *OpenAIResponsesFormat) DefaultPath() string { return "/v1/responses" }

func (f *OpenAIResponsesFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{
		MaxTokensField:       "max_output_tokens",
		ThinkingFormat:       "openai",
		ReasoningEffortField: "reasoning.effort",
	}
}

func (f *OpenAIResponsesFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)

	items := make([]map[string]any, 0, len(input.Messages))
	for _, msg := range input.Messages {
		switch msg.Role {
		case domain.RoleUser:
			if parts := encodeResponsesUserParts(msg.Blocks); len(parts) > 0 {
				items = append(items, map[string]any{
					"type":    "message",
					"role":    "user",
					"content": parts,
				})
			}
			for _, b := range msg.Blocks {
				if b.Type == domain.BlockTypeToolResult {
					items = append(items, map[string]any{
						"type":    "function_call_output",
						"call_id": b.ToolCallID,
						"output":  b.Content,
					})
				}
			}
		case domain.RoleAssistant:
			var textParts []map[string]any
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeText:
					textParts = append(textParts, map[string]any{
						"type": "output_text",
						"text": b.Text,
					})
				case domain.BlockTypeToolCall:
					if len(textParts) > 0 {
						items = append(items, map[string]any{
							"type":    "message",
							"role":    "assistant",
							"content": textParts,
						})
						textParts = nil
					}
					items = append(items, map[string]any{
						"type":      "function_call",
						"call_id":   b.ID,
						"name":      b.Name,
						"arguments": rawArgumentsString(b.Arguments),
					})
				}
			}
			if len(textParts) > 0 {
				items = append(items, map[string]any{
					"type":    "message",
					"role":    "assistant",
					"content": textParts,
				})
			}
		case domain.RoleToolResult:
			for _, b := range msg.Blocks {
				if b.Type == domain.BlockTypeToolResult {
					items = append(items, map[string]any{
						"type":    "function_call_output",
						"call_id": b.ToolCallID,
						"output":  b.Content,
					})
				}
			}
		}
	}

	body := map[string]any{
		"model":  input.Model.ID,
		"input":  items,
		"stream": true,
	}
	if strings.TrimSpace(input.SystemPrompt) != "" {
		body["instructions"] = input.SystemPrompt
	}
	if params.Temperature != nil {
		body["temperature"] = *params.Temperature
	}
	if params.MaxTokens != nil && *params.MaxTokens > 0 {
		maxField := compat.MaxTokensField
		if maxField == "" {
			maxField = "max_output_tokens"
		}
		body[maxField] = *params.MaxTokens
	}
	if effort := strings.ToLower(strings.TrimSpace(params.ReasoningEffort)); effort != "" {
		effortField := compat.ReasoningEffortField
		if effortField == "" {
			effortField = "reasoning.effort"
		}
		setNestedField(body, effortField, effort)
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

func encodeResponsesUserParts(blocks []domain.ContentBlock) []map[string]any {
	parts := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		switch b.Type {
		case domain.BlockTypeText:
			parts = append(parts, map[string]any{
				"type": "input_text",
				"text": b.Text,
			})
		case domain.BlockTypeImage:
			if u := imageBlockDataURL(b); u != "" {
				parts = append(parts, map[string]any{
					"type":      "input_image",
					"image_url": u,
				})
			}
		}
	}
	return parts
}

type responsesStreamPayload struct {
	Type        string `json:"type"`
	OutputIndex int    `json:"output_index"`
	ItemID      string `json:"item_id"`
	Delta       string `json:"delta"`
	Item        *struct {
		ID        string `json:"id"`
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	Response *struct {
		Status string `json:"status"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Usage *struct {
			InputTokens         int `json:"input_tokens"`
			OutputTokens        int `json:"output_tokens"`
			TotalTokens         int `json:"total_tokens"`
			OutputTokensDetails *struct {
				ReasoningTokens int `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	} `json:"response"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (f *OpenAIResponsesFormat) DecodeStream(ctx context.Context, body io.Reader, emit func(domain.StreamEvent) error) error {
	type itemState struct {
		blockIdx  int
		blockType string
		callID    string
		name      string
		buf       strings.Builder
		closed    bool
	}

	var (
		nextBlockIdx int
		items        = make(map[int]*itemState)
		itemOrder    []int
		hasToolCall  bool
		emittedEnd   bool
		emittedError bool
	)

	ensureItem := func(outputIdx int, blockType, callID, name string) (*itemState, error) {
		if st, ok := items[outputIdx]; ok {
			if st.callID == "" && callID != "" {
				st.callID = callID
			}
			if st.name == "" && name != "" {
				st.name = name
			}
			return st, nil
		}
		st := &itemState{
			blockIdx:  nextBlockIdx,
			blockType: blockType,
			callID:    callID,
			name:      name,
		}
		nextBlockIdx++
		items[outputIdx] = st
		itemOrder = append(itemOrder, outputIdx)
		var initBlock *domain.ContentBlock
		if blockType == domain.BlockTypeToolCall {
			hasToolCall = true
			initBlock = &domain.ContentBlock{
				Type: domain.BlockTypeToolCall,
				ID:   callID,
				Name: name,
			}
		}
		if err := emit(domain.StreamEvent{
			Type:      domain.StreamEventBlockStart,
			Index:     domain.IntPtr(st.blockIdx),
			BlockType: blockType,
			Block:     initBlock,
		}); err != nil {
			return nil, err
		}
		return st, nil
	}

	closeItem := func(st *itemState) error {
		if st == nil || st.closed {
			return nil
		}
		st.closed = true
		var b domain.ContentBlock
		switch st.blockType {
		case domain.BlockTypeThinking:
			b = domain.ContentBlock{Type: domain.BlockTypeThinking, Thinking: st.buf.String()}
		case domain.BlockTypeToolCall:
			b = domain.ContentBlock{
				Type:      domain.BlockTypeToolCall,
				ID:        st.callID,
				Name:      st.name,
				Arguments: rawArgumentsJSON(st.buf.String()),
			}
		default:
			b = domain.ContentBlock{Type: domain.BlockTypeText, Text: st.buf.String()}
		}
		return emitBlockEnd(emit, st.blockIdx, b)
	}

	closeRemaining := func() error {
		for _, idx := range itemOrder {
			if err := closeItem(items[idx]); err != nil {
				return err
			}
		}
		return nil
	}

	if err := ScanSSE(ctx, body, func(frame SSEFrame) error {
		data := strings.TrimSpace(frame.Data)
		if data == "" || data == "[DONE]" {
			return nil
		}
		var payload responsesStreamPayload
		if err := json.Unmarshal([]byte(data), &payload); err != nil {
			return nil
		}
		evType := payload.Type
		if evType == "" {
			evType = frame.Event
		}

		switch evType {
		case "response.output_item.added":
			if payload.Item == nil {
				return nil
			}
			switch payload.Item.Type {
			case "reasoning":
				_, err := ensureItem(payload.OutputIndex, domain.BlockTypeThinking, "", "")
				return err
			case "message":
				_, err := ensureItem(payload.OutputIndex, domain.BlockTypeText, "", "")
				return err
			case "function_call":
				callID := payload.Item.CallID
				if callID == "" {
					callID = payload.Item.ID
				}
				_, err := ensureItem(payload.OutputIndex, domain.BlockTypeToolCall, callID, payload.Item.Name)
				return err
			}

		case "response.output_text.delta":
			if payload.Delta == "" {
				return nil
			}
			st, err := ensureItem(payload.OutputIndex, domain.BlockTypeText, "", "")
			if err != nil {
				return err
			}
			st.buf.WriteString(payload.Delta)
			return emitBlockDelta(emit, st.blockIdx, domain.BlockTypeText, domain.DeltaTypeText, payload.Delta)

		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if payload.Delta == "" {
				return nil
			}
			st, err := ensureItem(payload.OutputIndex, domain.BlockTypeThinking, "", "")
			if err != nil {
				return err
			}
			st.buf.WriteString(payload.Delta)
			return emitBlockDelta(emit, st.blockIdx, domain.BlockTypeThinking, domain.DeltaTypeThinking, payload.Delta)

		case "response.function_call_arguments.delta":
			if payload.Delta == "" {
				return nil
			}
			st, err := ensureItem(payload.OutputIndex, domain.BlockTypeToolCall, payload.ItemID, "")
			if err != nil {
				return err
			}
			st.buf.WriteString(payload.Delta)
			return emitBlockDelta(emit, st.blockIdx, domain.BlockTypeToolCall, domain.DeltaTypeToolCallArgs, payload.Delta)

		case "response.output_item.done":
			st, ok := items[payload.OutputIndex]
			if !ok {
				return nil
			}
			if payload.Item != nil && st.blockType == domain.BlockTypeToolCall {
				if payload.Item.CallID != "" {
					st.callID = payload.Item.CallID
				}
				if payload.Item.Name != "" {
					st.name = payload.Item.Name
				}
				if st.buf.Len() == 0 && payload.Item.Arguments != "" {
					st.buf.WriteString(payload.Item.Arguments)
				}
			}
			return closeItem(st)

		case "response.completed", "response.incomplete":
			if emittedEnd {
				return nil
			}
			emittedEnd = true
			if err := closeRemaining(); err != nil {
				return err
			}
			var usage *domain.Usage
			stopReason := domain.StopReasonStop
			if evType == "response.incomplete" {
				stopReason = domain.StopReasonLength
			} else if hasToolCall {
				stopReason = domain.StopReasonToolUse
			}
			if payload.Response != nil {
				if payload.Response.Status == "incomplete" {
					stopReason = domain.StopReasonLength
				}
				if payload.Response.Usage != nil {
					usage = &domain.Usage{
						InputTokens:  payload.Response.Usage.InputTokens,
						OutputTokens: payload.Response.Usage.OutputTokens,
						TotalTokens:  payload.Response.Usage.TotalTokens,
					}
					if payload.Response.Usage.OutputTokensDetails != nil {
						usage.ThinkingTokens = payload.Response.Usage.OutputTokensDetails.ReasoningTokens
					}
				}
			}
			return emit(domain.StreamEvent{
				Type:       domain.StreamEventMessageDelta,
				Usage:      usage,
				StopReason: stopReason,
			})

		case "response.failed", "error":
			emittedError = true
			msg := "upstream responses error"
			if payload.Error != nil && payload.Error.Message != "" {
				msg = payload.Error.Message
			} else if payload.Response != nil && payload.Response.Error != nil && payload.Response.Error.Message != "" {
				msg = payload.Response.Error.Message
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
	if !emittedEnd && !emittedError && len(itemOrder) > 0 {
		if err := closeRemaining(); err != nil {
			return err
		}
		stopReason := domain.StopReasonStop
		if hasToolCall {
			stopReason = domain.StopReasonToolUse
		}
		return emit(domain.StreamEvent{
			Type:       domain.StreamEventMessageDelta,
			StopReason: stopReason,
		})
	}
	return nil
}
