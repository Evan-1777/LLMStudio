package format

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const FormatIDGoogleGenAI = "google-generative-ai"

// GoogleGenAIFormat implements the Google Generative AI (Gemini streamGenerateContent) protocol.
type GoogleGenAIFormat struct{}

// NewGoogleGenAIFormat creates a Google Generative AI format plugin.
func NewGoogleGenAIFormat() *GoogleGenAIFormat {
	return &GoogleGenAIFormat{}
}

func (f *GoogleGenAIFormat) ID() string          { return FormatIDGoogleGenAI }
func (f *GoogleGenAIFormat) DisplayName() string { return "Google Generative AI" }
func (f *GoogleGenAIFormat) DefaultPath() string {
	return "/v1beta/models/{model}:streamGenerateContent"
}

func (f *GoogleGenAIFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{
		MaxTokensField:       "maxOutputTokens",
		ThinkingFormat:       "gemini",
		ReasoningEffortField: "thinkingConfig",
	}
}

func (f *GoogleGenAIFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)

	contents := make([]map[string]any, 0, len(input.Messages))
	for _, msg := range input.Messages {
		switch msg.Role {
		case domain.RoleUser:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeText:
					parts = append(parts, map[string]any{"text": b.Text})
				case domain.BlockTypeImage:
					if p, ok := encodeGeminiImage(b); ok {
						parts = append(parts, p)
					}
				case domain.BlockTypeToolResult:
					parts = append(parts, encodeGeminiFunctionResponse(b))
				}
			}
			if len(parts) > 0 {
				contents = append(contents, map[string]any{
					"role":  "user",
					"parts": parts,
				})
			}

		case domain.RoleAssistant:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeText:
					parts = append(parts, map[string]any{"text": b.Text})
				case domain.BlockTypeToolCall:
					var argsObj any = map[string]any{}
					if len(b.Arguments) > 0 {
						_ = json.Unmarshal(b.Arguments, &argsObj)
					}
					parts = append(parts, map[string]any{
						"functionCall": map[string]any{
							"name": b.Name,
							"args": argsObj,
						},
					})
				}
			}
			if len(parts) > 0 {
				contents = append(contents, map[string]any{
					"role":  "model",
					"parts": parts,
				})
			}

		case domain.RoleToolResult:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				if b.Type == domain.BlockTypeToolResult {
					parts = append(parts, encodeGeminiFunctionResponse(b))
				}
			}
			if len(parts) > 0 {
				contents = append(contents, map[string]any{
					"role":  "user",
					"parts": parts,
				})
			}
		}
	}

	body := map[string]any{
		"contents": contents,
	}
	if strings.TrimSpace(input.SystemPrompt) != "" {
		body["systemInstruction"] = map[string]any{
			"parts": []map[string]any{
				{"text": input.SystemPrompt},
			},
		}
	}

	genConfig := make(map[string]any)
	if params.Temperature != nil {
		genConfig["temperature"] = *params.Temperature
	}
	if params.MaxTokens != nil && *params.MaxTokens > 0 {
		maxField := compat.MaxTokensField
		if maxField == "" {
			maxField = "maxOutputTokens"
		}
		genConfig[maxField] = *params.MaxTokens
	}
	if effort := strings.ToLower(strings.TrimSpace(params.ReasoningEffort)); effort != "" {
		thinkField := compat.ReasoningEffortField
		if thinkField == "" || thinkField == "thinkingLevel" {
			thinkField = "thinkingConfig"
		}
		if effort == domain.EffortNone {
			genConfig[thinkField] = map[string]any{
				"thinkingBudget": 0,
			}
		} else if compat.ReasoningEffortField == "thinkingLevel" {
			genConfig["thinkingConfig"] = map[string]any{
				"includeThoughts": true,
				"thinkingLevel":   strings.ToUpper(effort),
			}
		} else {
			genConfig[thinkField] = map[string]any{
				"includeThoughts": true,
				"thinkingBudget":  geminiThinkingBudget(effort),
			}
		}
	}
	if len(genConfig) > 0 {
		body["generationConfig"] = genConfig
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
	query := url.Values{"alt": []string{"sse"}}
	return plugin.EncodedRequest{
		Method:      http.MethodPost,
		DefaultPath: f.DefaultPath(),
		Query:       query,
		Headers:     headers,
		Body:        payload,
	}, nil
}

func encodeGeminiImage(b domain.ContentBlock) (map[string]any, bool) {
	if strings.TrimSpace(b.Data) != "" {
		mime := strings.TrimSpace(b.MimeType)
		if mime == "" {
			mime = "image/png"
		}
		return map[string]any{
			"inlineData": map[string]any{
				"mimeType": mime,
				"data":     b.Data,
			},
		}, true
	}
	if strings.TrimSpace(b.URL) != "" {
		mime := strings.TrimSpace(b.MimeType)
		if mime == "" {
			mime = "image/png"
		}
		return map[string]any{
			"fileData": map[string]any{
				"mimeType": mime,
				"fileUri":  strings.TrimSpace(b.URL),
			},
		}, true
	}
	return nil, false
}

func encodeGeminiFunctionResponse(b domain.ContentBlock) map[string]any {
	name := b.ToolName
	if name == "" {
		name = "tool"
	}
	return map[string]any{
		"functionResponse": map[string]any{
			"name": name,
			"response": map[string]any{
				"content": b.Content,
			},
		},
	}
}

func geminiThinkingBudget(effort string) int {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case domain.EffortLow:
		return 1024
	case domain.EffortHigh:
		return 8192
	case domain.EffortXHigh:
		return 16384
	case domain.EffortMax:
		return 24576
	default:
		return 4096
	}
}

type geminiStreamChunk struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text         string `json:"text"`
				Thought      bool   `json:"thought"`
				FunctionCall *struct {
					ID   string          `json:"id"`
					Name string          `json:"name"`
					Args json.RawMessage `json:"args"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
		ThoughtsTokenCount   int `json:"thoughtsTokenCount"`
		TotalTokenCount      int `json:"totalTokenCount"`
	} `json:"usageMetadata"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (f *GoogleGenAIFormat) DecodeStream(ctx context.Context, body io.Reader, emit func(domain.StreamEvent) error) error {
	var (
		nextBlockIdx  int
		activeThink   = -1
		thinkBuf      strings.Builder
		activeTextIdx = -1
		textBuf       strings.Builder
		hasToolCall   bool
		toolCounter   int
		finalUsage    *domain.Usage
		stopReason    string
		emittedError  bool
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

	err := ScanSSE(ctx, body, func(frame SSEFrame) error {
		data := strings.TrimSpace(frame.Data)
		if data == "" || data == "[DONE]" {
			return nil
		}
		var chunk geminiStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return nil
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			emittedError = true
			return emit(domain.StreamEvent{
				Type: domain.StreamEventError,
				Error: &domain.StreamError{
					Code:    domain.ErrCodeUpstreamError,
					Message: chunk.Error.Message,
				},
			})
		}

		if chunk.UsageMetadata != nil {
			u := chunk.UsageMetadata
			total := u.TotalTokenCount
			if total == 0 {
				total = u.PromptTokenCount + u.CandidatesTokenCount + u.ThoughtsTokenCount
			}
			finalUsage = &domain.Usage{
				InputTokens:    u.PromptTokenCount,
				OutputTokens:   u.CandidatesTokenCount,
				ThinkingTokens: u.ThoughtsTokenCount,
				TotalTokens:    total,
			}
		}

		if len(chunk.Candidates) == 0 {
			return nil
		}
		cand := chunk.Candidates[0]

		for _, part := range cand.Content.Parts {
			if part.Thought && part.Text != "" {
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
				thinkBuf.WriteString(part.Text)
				if err := emitBlockDelta(emit, activeThink, domain.BlockTypeThinking, domain.DeltaTypeThinking, part.Text); err != nil {
					return err
				}
				continue
			}

			if part.Text != "" {
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
				textBuf.WriteString(part.Text)
				if err := emitBlockDelta(emit, activeTextIdx, domain.BlockTypeText, domain.DeltaTypeText, part.Text); err != nil {
					return err
				}
			}

			if part.FunctionCall != nil {
				if err := closeThinking(); err != nil {
					return err
				}
				if err := closeText(); err != nil {
					return err
				}
				hasToolCall = true
				toolCounter++
				callID := part.FunctionCall.ID
				if callID == "" {
					callID = fmt.Sprintf("call_%d", toolCounter)
				}
				idx := nextBlockIdx
				nextBlockIdx++
				argsRaw := part.FunctionCall.Args
				if len(argsRaw) == 0 {
					argsRaw = json.RawMessage(`{}`)
				}
				if err := emit(domain.StreamEvent{
					Type:      domain.StreamEventBlockStart,
					Index:     domain.IntPtr(idx),
					BlockType: domain.BlockTypeToolCall,
					Block: &domain.ContentBlock{
						Type: domain.BlockTypeToolCall,
						ID:   callID,
						Name: part.FunctionCall.Name,
					},
				}); err != nil {
					return err
				}
				if err := emitBlockDelta(emit, idx, domain.BlockTypeToolCall, domain.DeltaTypeToolCallArgs, string(argsRaw)); err != nil {
					return err
				}
				if err := emitBlockEnd(emit, idx, domain.ContentBlock{
					Type:      domain.BlockTypeToolCall,
					ID:        callID,
					Name:      part.FunctionCall.Name,
					Arguments: argsRaw,
				}); err != nil {
					return err
				}
			}
		}

		if cand.FinishReason != "" {
			stopReason = mapGeminiFinishReason(cand.FinishReason)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if emittedError {
		return nil
	}
	if err := closeThinking(); err != nil {
		return err
	}
	if err := closeText(); err != nil {
		return err
	}
	if hasToolCall && (stopReason == "" || stopReason == domain.StopReasonStop) {
		stopReason = domain.StopReasonToolUse
	}
	if stopReason == "" {
		stopReason = domain.StopReasonStop
	}
	return emit(domain.StreamEvent{
		Type:       domain.StreamEventMessageDelta,
		Usage:      finalUsage,
		StopReason: stopReason,
	})
}

func mapGeminiFinishReason(reason string) string {
	switch reason {
	case "MAX_TOKENS":
		return domain.StopReasonLength
	default:
		return domain.StopReasonStop
	}
}
