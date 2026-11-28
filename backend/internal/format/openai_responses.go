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
		CacheMode:            domain.CacheModeAuto,
	}
}

func (f *OpenAIResponsesFormat) PlanCache(_ context.Context, input plugin.ChatInput, current *plugin.PromptCacheState) (plugin.CachePlan, error) {
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
func (f *OpenAIResponsesFormat) appliesCacheFields(input plugin.ChatInput, compat domain.CompatConfig) bool {
	policy := resolveCachePolicy(input, compat)
	if isOpenAIOfficialEndpoint(input.GenerationURL, f.DefaultPath()) {
		return policy.autoManaged()
	}
	return policy.explicitOnly()
}

func (f *OpenAIResponsesFormat) ResolveCache(_ context.Context, _ plugin.ChatInput, _ plugin.CachePlan, _ plugin.CacheResolutionInput) (plugin.CacheResolutionResult, error) {
	return plugin.CacheResolutionResult{}, nil
}

func (f *OpenAIResponsesFormat) ClassifyCacheError(statusCode int, body []byte, _ *plugin.PromptCacheState) plugin.CacheFailureAction {
	return classifyInlineCacheError(statusCode, body, "prompt_cache_options", "prompt_cache_breakpoint", "prompt_cache")
}

func (f *OpenAIResponsesFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)
	policy := resolveCachePolicy(input, compat)
	officialEndpoint := isOpenAIOfficialEndpoint(input.GenerationURL, f.DefaultPath())
	cacheFields := policy.autoManaged() && !cacheStateUnsupported(input.PromptCache)
	compatFields := policy.explicitOnly() && !cacheStateUnsupported(input.PromptCache)

	items := make([]map[string]any, 0, len(input.Messages))
	for _, msg := range normalizeMessagesForEncoding(input.Messages) {
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
						"output":  formatToolResultContent(b),
					})
				}
			}
		case domain.RoleAssistant:
			itemStart := len(items)
			var textParts []map[string]any
			flushAssistantText := func() {
				if len(textParts) == 0 {
					return
				}
				items = append(items, map[string]any{
					"type":    "message",
					"role":    "assistant",
					"content": textParts,
				})
				textParts = nil
			}
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeThinking:
					if enc := extractThoughtSignature(b, FormatIDOpenAIResponses); enc != "" {
						flushAssistantText()
						prov := parseBlockProvenance(b.Extra)
						item := map[string]any{
							"type":              "reasoning",
							"encrypted_content": enc,
						}
						if prov.ItemID != "" {
							item["id"] = prov.ItemID
						}
						if b.Thinking != "" {
							item["summary"] = []map[string]any{{
								"type": "summary_text",
								"text": b.Thinking,
							}}
						}
						items = append(items, item)
					}
				case domain.BlockTypeText:
					textParts = append(textParts, map[string]any{
						"type": "output_text",
						"text": b.Text,
					})
				case domain.BlockTypeToolCall:
					flushAssistantText()
					items = append(items, map[string]any{
						"type":      "function_call",
						"call_id":   b.ID,
						"name":      b.Name,
						"arguments": rawArgumentsObjectString(b.Arguments),
					})
				case domain.BlockTypeToolResult:
					flushAssistantText()
					items = append(items, map[string]any{
						"type":    "function_call_output",
						"call_id": b.ToolCallID,
						"output":  formatToolResultContent(b),
					})
				}
			}
			flushAssistantText()
			if itemStart < len(items) {
				onlyReasoning := true
				for _, item := range items[itemStart:] {
					if item["type"] != "reasoning" {
						onlyReasoning = false
						break
					}
				}
				if onlyReasoning {
					items = items[:itemStart]
				}
			}
		case domain.RoleToolResult:
			for _, b := range msg.Blocks {
				if b.Type == domain.BlockTypeToolResult {
					items = append(items, map[string]any{
						"type":    "function_call_output",
						"call_id": b.ToolCallID,
						"output":  formatToolResultContent(b),
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
	hasSysItem := false
	if strings.TrimSpace(input.SystemPrompt) != "" {
		if !officialEndpoint && compatFields && !hasExtraBodyKey(compat.ExtraBody, "instructions") && !hasExtraBodyKey(compat.ExtraBody, "input") {
			sysRole := "developer"
			if compat.SupportsDeveloperRole != nil && !*compat.SupportsDeveloperRole {
				sysRole = "system"
			}
			sysItem := map[string]any{
				"type": "message",
				"role": sysRole,
				"content": []map[string]any{{
					"type":                    "input_text",
					"text":                    input.SystemPrompt,
					"prompt_cache_breakpoint": map[string]any{"mode": "explicit"},
				}},
			}
			items = append([]map[string]any{sysItem}, items...)
			body["input"] = items
			hasSysItem = true
		} else {
			body["instructions"] = input.SystemPrompt
		}
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
	if len(input.Tools) > 0 {
		encodedTools := make([]map[string]any, 0, len(input.Tools))
		for _, t := range input.Tools {
			toolObj := map[string]any{
				"type":       "function",
				"name":       t.Alias,
				"parameters": plugin.NormalizeToolSchema(t.InputSchema),
			}
			if desc := strings.TrimSpace(t.Description); desc != "" {
				toolObj["description"] = desc
			}
			encodedTools = append(encodedTools, toolObj)
		}
		body["tools"] = encodedTools
	}
	if officialEndpoint {
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
		if !hasExtraBodyKey(compat.ExtraBody, "input") {
			startIdx := 0
			if hasSysItem {
				startIdx = 1
			}
			applyOpenAIResponsesCacheBreakpoint(items, startIdx)
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

func applyOpenAIResponsesCacheBreakpoint(items []map[string]any, startIdx int) {
	for i := len(items) - 2; i >= startIdx; i-- {
		parts, ok := items[i]["content"].([]map[string]any)
		if !ok || len(parts) == 0 {
			continue
		}
		if _, exists := parts[len(parts)-1]["prompt_cache_breakpoint"]; !exists {
			parts[len(parts)-1]["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
		}
		return
	}
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

type responsesStreamItem struct {
	ID               string `json:"id"`
	Type             string `json:"type"`
	CallID           string `json:"call_id"`
	Name             string `json:"name"`
	Arguments        string `json:"arguments"`
	EncryptedContent string `json:"encrypted_content"`
	Summary          []struct {
		Text string `json:"text"`
	} `json:"summary"`
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
}

type responsesStreamPayload struct {
	Type           string               `json:"type"`
	SequenceNumber *int                 `json:"sequence_number,omitempty"`
	OutputIndex    int                  `json:"output_index"`
	ItemID         string               `json:"item_id"`
	Delta          string               `json:"delta"`
	Text           string               `json:"text"`
	Arguments      string               `json:"arguments"`
	Item           *responsesStreamItem `json:"item"`
	Response       *struct {
		Status string                `json:"status"`
		Output []responsesStreamItem `json:"output"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Usage *struct {
			InputTokens        int `json:"input_tokens"`
			OutputTokens       int `json:"output_tokens"`
			TotalTokens        int `json:"total_tokens"`
			InputTokensDetails *struct {
				CachedTokens        int `json:"cached_tokens"`
				CacheWriteTokens    int `json:"cache_write_tokens"`
				CacheCreationTokens int `json:"cache_creation_tokens"`
			} `json:"input_tokens_details"`
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
		blockIdx         int
		blockType        string
		itemID           string
		callID           string
		name             string
		encryptedContent string
		buf              strings.Builder
		closed           bool
	}

	var (
		nextBlockIdx int
		items        = make(map[int]*itemState)
		itemOrder    []int
		seenSeq      = make(map[int]struct{})
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

	applyItemSnapshot := func(st *itemState, item *responsesStreamItem) {
		if st == nil || item == nil {
			return
		}
		if item.ID != "" && st.itemID == "" {
			st.itemID = item.ID
		}
		if item.EncryptedContent != "" {
			st.encryptedContent = item.EncryptedContent
		}
		switch st.blockType {
		case domain.BlockTypeToolCall:
			if item.CallID != "" {
				st.callID = item.CallID
			}
			if item.Name != "" {
				st.name = item.Name
			}
			if st.buf.Len() == 0 && item.Arguments != "" {
				st.buf.WriteString(item.Arguments)
			}
		case domain.BlockTypeThinking:
			if st.buf.Len() == 0 && len(item.Summary) > 0 {
				for _, s := range item.Summary {
					st.buf.WriteString(s.Text)
				}
			}
		default:
			if st.buf.Len() == 0 && len(item.Content) > 0 {
				for _, c := range item.Content {
					st.buf.WriteString(c.Text)
				}
			}
		}
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
			if st.encryptedContent != "" {
				b.Signature = st.encryptedContent
				b.Extra = makeProviderExtra(FormatIDOpenAIResponses, map[string]any{
					"itemId":           st.itemID,
					"encryptedContent": st.encryptedContent,
				})
			}
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
		if payload.SequenceNumber != nil {
			if _, dup := seenSeq[*payload.SequenceNumber]; dup {
				return nil
			}
			seenSeq[*payload.SequenceNumber] = struct{}{}
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
			var blockType, callID, name string
			switch payload.Item.Type {
			case "reasoning":
				blockType = domain.BlockTypeThinking
			case "message":
				blockType = domain.BlockTypeText
			case "function_call":
				blockType = domain.BlockTypeToolCall
				callID = payload.Item.CallID
				if callID == "" {
					callID = payload.Item.ID
				}
				name = payload.Item.Name
			default:
				return nil
			}
			st, err := ensureItem(payload.OutputIndex, blockType, callID, name)
			if err != nil {
				return err
			}
			if payload.Item.ID != "" {
				st.itemID = payload.Item.ID
			}
			if payload.Item.EncryptedContent != "" {
				st.encryptedContent = payload.Item.EncryptedContent
			}
			return nil

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

		case "response.output_text.done":
			if st, ok := items[payload.OutputIndex]; ok && st.buf.Len() == 0 && payload.Text != "" {
				st.buf.WriteString(payload.Text)
			}
			return nil

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

		case "response.reasoning_summary_text.done", "response.reasoning_text.done":
			if st, ok := items[payload.OutputIndex]; ok && st.buf.Len() == 0 && payload.Text != "" {
				st.buf.WriteString(payload.Text)
			}
			return nil

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

		case "response.function_call_arguments.done":
			if st, ok := items[payload.OutputIndex]; ok && st.buf.Len() == 0 && payload.Arguments != "" {
				st.buf.WriteString(payload.Arguments)
			}
			return nil

		case "response.output_item.done":
			st, ok := items[payload.OutputIndex]
			if !ok {
				if payload.Item == nil {
					return nil
				}
				var blockType string
				switch payload.Item.Type {
				case "reasoning":
					blockType = domain.BlockTypeThinking
				case "message":
					blockType = domain.BlockTypeText
				case "function_call":
					blockType = domain.BlockTypeToolCall
				default:
					return nil
				}
				callID := payload.Item.CallID
				if callID == "" {
					callID = payload.Item.ID
				}
				var err error
				st, err = ensureItem(payload.OutputIndex, blockType, callID, payload.Item.Name)
				if err != nil {
					return err
				}
			}
			applyItemSnapshot(st, payload.Item)
			return closeItem(st)

		case "response.completed", "response.incomplete":
			if emittedEnd {
				return nil
			}
			emittedEnd = true
			if payload.Response != nil {
				for outIdx := range payload.Response.Output {
					item := payload.Response.Output[outIdx]
					st, ok := items[outIdx]
					if !ok {
						var bt string
						switch item.Type {
						case "reasoning":
							bt = domain.BlockTypeThinking
						case "message":
							bt = domain.BlockTypeText
						case "function_call":
							bt = domain.BlockTypeToolCall
						default:
							continue
						}
						cid := item.CallID
						if cid == "" {
							cid = item.ID
						}
						var err error
						st, err = ensureItem(outIdx, bt, cid, item.Name)
						if err != nil {
							return err
						}
					}
					applyItemSnapshot(st, &item)
				}
			}
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
					ru := payload.Response.Usage
					total := ru.TotalTokens
					if total == 0 {
						total = ru.InputTokens + ru.OutputTokens
					}
					usage = &domain.Usage{
						InputTokens:  ru.InputTokens,
						OutputTokens: ru.OutputTokens,
						TotalTokens:  total,
					}
					if ru.InputTokensDetails != nil {
						usage.CacheReadInputTokens = ru.InputTokensDetails.CachedTokens
						if ru.InputTokensDetails.CacheWriteTokens > 0 {
							usage.CacheCreationInputTokens = ru.InputTokensDetails.CacheWriteTokens
						} else {
							usage.CacheCreationInputTokens = ru.InputTokensDetails.CacheCreationTokens
						}
					}
					if ru.OutputTokensDetails != nil {
						usage.ThinkingTokens = ru.OutputTokensDetails.ReasoningTokens
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
