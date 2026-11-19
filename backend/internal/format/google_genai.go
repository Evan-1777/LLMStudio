package format

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	FormatIDGoogleGenAI      = "google-generative-ai"
	geminiCachedContentsPath = "/v1beta/cachedContents"
)

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
		CacheMode:            domain.CacheModeAuto,
	}
}

// geminiCacheManaged reports whether the gateway may own an explicit
// cachedContents resource for this generation.
func geminiCacheManaged(input plugin.ChatInput, compat domain.CompatConfig) bool {
	return resolveCachePolicy(input, compat).autoManaged()
}

type geminiCacheInputs struct {
	contents    []map[string]any
	systemObj   map[string]any
	toolsObj    []map[string]any
	toolConfig  any
	systemHash  string
	toolsHash   string
	prefixCount int
	prefixHash  string
	planKey     string
}

func hashCanonicalJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func prepareGeminiCacheInputs(input plugin.ChatInput, compat domain.CompatConfig) geminiCacheInputs {
	contents := buildGeminiContents(input.Messages)
	systemObj := buildGeminiSystem(input.SystemPrompt)
	toolsObj := buildGeminiTools(input.Tools)
	var toolConfig any
	if len(compat.ExtraBody) > 0 {
		if tc, ok := compat.ExtraBody["toolConfig"]; ok {
			toolConfig = tc
		}
	}
	systemHash := hashCanonicalJSON(struct {
		System     map[string]any `json:"system,omitempty"`
		ToolConfig any            `json:"toolConfig,omitempty"`
	}{System: systemObj, ToolConfig: toolConfig})
	toolsHash := hashCanonicalJSON(toolsObj)

	prefixCount := -1
	if len(contents) >= 2 {
		prefixCount = len(contents) - 1
	} else if len(contents) == 1 && (systemObj != nil || len(toolsObj) > 0 || toolConfig != nil) {
		prefixCount = 0
	}

	var prefixHash, planKey string
	if prefixCount >= 0 {
		prefixHash = hashCanonicalJSON(contents[:prefixCount])
		planKey = hashCanonicalJSON(struct {
			Model       string `json:"model"`
			SystemHash  string `json:"systemHash"`
			ToolsHash   string `json:"toolsHash"`
			PrefixHash  string `json:"prefixHash"`
			PrefixCount int    `json:"prefixCount"`
		}{
			Model:       input.Model.ID,
			SystemHash:  systemHash,
			ToolsHash:   toolsHash,
			PrefixHash:  prefixHash,
			PrefixCount: prefixCount,
		})
	}
	return geminiCacheInputs{
		contents:    contents,
		systemObj:   systemObj,
		toolsObj:    toolsObj,
		toolConfig:  toolConfig,
		systemHash:  systemHash,
		toolsHash:   toolsHash,
		prefixCount: prefixCount,
		prefixHash:  prefixHash,
		planKey:     planKey,
	}
}

func (f *GoogleGenAIFormat) PlanCache(_ context.Context, input plugin.ChatInput, current *plugin.PromptCacheState) (plugin.CachePlan, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	if !geminiCacheManaged(input, compat) {
		return plugin.CachePlan{}, nil
	}
	if hasExtraBodyKey(compat.ExtraBody, "cachedContent") {
		return plugin.CachePlan{}, nil
	}
	if current != nil && current.Unsupported {
		return plugin.CachePlan{ReuseState: current}, nil
	}

	prep := prepareGeminiCacheInputs(input, compat)
	if len(prep.contents) == 0 {
		return plugin.CachePlan{}, nil
	}

	// Prefer reusing any non-expired cache whose exact prefix matches current context.
	if current != nil && current.ResourceName != "" {
		expired := !current.ExpireTime.IsZero() && !time.Now().UTC().Before(current.ExpireTime)
		if !expired &&
			current.SystemHash == prep.systemHash &&
			current.ToolsHash == prep.toolsHash &&
			current.PrefixCount >= 0 &&
			current.PrefixCount < len(prep.contents) &&
			hashCanonicalJSON(prep.contents[:current.PrefixCount]) == current.PrefixHash {
			return plugin.CachePlan{ReuseState: current}, nil
		}
	}

	if prep.prefixCount < 0 {
		return plugin.CachePlan{}, nil
	}
	if current != nil && current.FailedPrefixHash != "" && current.FailedPrefixHash == prep.planKey {
		return plugin.CachePlan{ReuseState: current}, nil
	}

	modelName := strings.TrimSpace(input.Model.ID)
	if !strings.HasPrefix(modelName, "models/") && !strings.HasPrefix(modelName, "tunedModels/") {
		modelName = "models/" + modelName
	}
	createBody := map[string]any{
		"model": modelName,
	}
	if prep.systemObj != nil {
		createBody["systemInstruction"] = prep.systemObj
	}
	if len(prep.toolsObj) > 0 {
		createBody["tools"] = prep.toolsObj
	}
	if prep.toolConfig != nil {
		createBody["toolConfig"] = prep.toolConfig
	}
	if prep.prefixCount > 0 {
		createBody["contents"] = prep.contents[:prep.prefixCount]
	}

	payload, err := json.Marshal(createBody)
	if err != nil {
		return plugin.CachePlan{}, err
	}
	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")
	return plugin.CachePlan{
		PlanKey: prep.planKey,
		CreateRequest: &plugin.EncodedRequest{
			Method:      http.MethodPost,
			DefaultPath: geminiCachedContentsPath,
			Headers:     headers,
			Body:        payload,
		},
	}, nil
}

func (f *GoogleGenAIFormat) ResolveCache(_ context.Context, input plugin.ChatInput, plan plugin.CachePlan, res plugin.CacheResolutionInput) (plugin.CacheResolutionResult, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	prep := prepareGeminiCacheInputs(input, compat)

	if res.StatusCode >= 200 && res.StatusCode < 300 {
		var created struct {
			Name       string `json:"name"`
			ExpireTime string `json:"expireTime"`
		}
		if err := json.Unmarshal(res.Body, &created); err != nil || strings.TrimSpace(created.Name) == "" {
			return plugin.CacheResolutionResult{
				Degrade: true,
				State:   &plugin.PromptCacheState{FailedPrefixHash: prep.planKey},
			}, nil
		}
		var exp time.Time
		if ts := strings.TrimSpace(created.ExpireTime); ts != "" {
			if parsed, pErr := time.Parse(time.RFC3339Nano, ts); pErr == nil {
				exp = parsed.UTC()
			}
		}
		return plugin.CacheResolutionResult{
			State: &plugin.PromptCacheState{
				ResourceName: strings.TrimSpace(created.Name),
				PrefixHash:   prep.prefixHash,
				PrefixCount:  prep.prefixCount,
				ToolsHash:    prep.toolsHash,
				SystemHash:   prep.systemHash,
				ExpireTime:   exp,
			},
		}, nil
	}

	msg := extractGeminiErrorMsg(res.StatusCode, res.Body)
	lower := strings.ToLower(msg)
	if res.StatusCode == http.StatusUnauthorized ||
		res.StatusCode == http.StatusForbidden ||
		res.StatusCode == http.StatusTooManyRequests ||
		strings.Contains(lower, "api key") ||
		strings.Contains(lower, "api_key") ||
		strings.Contains(lower, "permission") ||
		strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "quota") {
		return plugin.CacheResolutionResult{
			HardError: domain.NewError(domain.ErrCodeUpstreamError, msg, nil),
		}, nil
	}

	if res.StatusCode == http.StatusBadRequest ||
		res.StatusCode == http.StatusNotFound ||
		res.StatusCode == http.StatusUnprocessableEntity ||
		res.StatusCode == http.StatusNotImplemented {
		if isGeminiSmallPrefixError(lower) {
			return plugin.CacheResolutionResult{
				Degrade: true,
				State:   &plugin.PromptCacheState{FailedPrefixHash: prep.planKey},
			}, nil
		}
		return plugin.CacheResolutionResult{
			Degrade: true,
			State:   &plugin.PromptCacheState{Unsupported: true},
		}, nil
	}

	return plugin.CacheResolutionResult{
		HardError: domain.NewError(domain.ErrCodeUpstreamError, msg, nil),
	}, nil
}

func (f *GoogleGenAIFormat) ClassifyCacheError(statusCode int, body []byte, used *plugin.PromptCacheState) plugin.CacheFailureAction {
	if used == nil || used.ResourceName == "" {
		return plugin.CacheFailureAction{}
	}
	if statusCode != http.StatusNotFound && statusCode != http.StatusBadRequest && statusCode != http.StatusForbidden {
		return plugin.CacheFailureAction{}
	}
	lower := strings.ToLower(string(body))
	if strings.Contains(lower, "api key") || strings.Contains(lower, "api_key") || strings.Contains(lower, "invalid key") {
		return plugin.CacheFailureAction{}
	}
	if strings.Contains(lower, "cachedcontent") ||
		strings.Contains(lower, "cached_content") ||
		strings.Contains(lower, "not found") ||
		strings.Contains(lower, "expired") ||
		strings.Contains(lower, "does not exist") {
		if strings.Contains(lower, "unsupported") || strings.Contains(lower, "not supported") {
			return plugin.CacheFailureAction{MarkUnsupported: true, RetryWithoutCache: true}
		}
		return plugin.CacheFailureAction{InvalidateScope: true, ReplanCache: true}
	}
	return plugin.CacheFailureAction{}
}

func isGeminiSmallPrefixError(lower string) bool {
	for _, kw := range []string{
		"too small",
		"too short",
		"minimum",
		"min_tokens",
		"less than",
		"at least",
		"token count",
		"total_token_count",
	} {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

func extractGeminiErrorMsg(statusCode int, body []byte) string {
	var env struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err == nil && env.Error != nil && strings.TrimSpace(env.Error.Message) != "" {
		return fmt.Sprintf("upstream returned HTTP %d: %s", statusCode, strings.TrimSpace(env.Error.Message))
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		trimmed = http.StatusText(statusCode)
	}
	return fmt.Sprintf("upstream returned HTTP %d: %s", statusCode, trimmed)
}

func buildGeminiSystem(systemPrompt string) map[string]any {
	if strings.TrimSpace(systemPrompt) == "" {
		return nil
	}
	return map[string]any{
		"parts": []map[string]any{
			{"text": systemPrompt},
		},
	}
}

func buildGeminiTools(tools []plugin.ChatTool) []map[string]any {
	if len(tools) == 0 {
		return nil
	}
	decls := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		decl := map[string]any{
			"name":       t.Alias,
			"parameters": plugin.NormalizeToolSchema(t.InputSchema),
		}
		if desc := strings.TrimSpace(t.Description); desc != "" {
			decl["description"] = desc
		}
		decls = append(decls, decl)
	}
	return []map[string]any{{"functionDeclarations": decls}}
}

func buildGeminiContents(messages []domain.Message) []map[string]any {
	contents := make([]map[string]any, 0, len(messages))
	appendContent := func(role string, parts []map[string]any) {
		if len(parts) == 0 {
			return
		}
		if n := len(contents); n > 0 && contents[n-1]["role"] == role {
			existing, _ := contents[n-1]["parts"].([]map[string]any)
			contents[n-1]["parts"] = append(existing, parts...)
			return
		}
		contents = append(contents, map[string]any{
			"role":  role,
			"parts": parts,
		})
	}
	for _, msg := range messages {
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
			appendContent("user", parts)

		case domain.RoleAssistant:
			var modelParts []map[string]any
			var toolParts []map[string]any
			flushModel := func() {
				if len(modelParts) > 0 {
					appendContent("model", modelParts)
					modelParts = nil
				}
			}
			flushToolResults := func() {
				if len(toolParts) > 0 {
					appendContent("user", toolParts)
					toolParts = nil
				}
			}
			for _, b := range msg.Blocks {
				switch b.Type {
				case domain.BlockTypeThinking:
					if sig := extractThoughtSignature(b, FormatIDGoogleGenAI); sig != "" {
						flushToolResults()
						part := map[string]any{
							"thought":          true,
							"thoughtSignature": sig,
						}
						if b.Thinking != "" {
							part["text"] = b.Thinking
						}
						modelParts = append(modelParts, part)
					}
				case domain.BlockTypeText:
					if b.Text != "" {
						flushToolResults()
						modelParts = append(modelParts, map[string]any{"text": b.Text})
					}
				case domain.BlockTypeToolCall:
					flushToolResults()
					fnCall := map[string]any{
						"name": b.Name,
						"args": toolArgsObject(b.Arguments),
					}
					if b.ID != "" {
						fnCall["id"] = b.ID
					}
					part := map[string]any{"functionCall": fnCall}
					if sig := extractThoughtSignature(b, FormatIDGoogleGenAI); sig != "" {
						part["thoughtSignature"] = sig
					}
					modelParts = append(modelParts, part)
				case domain.BlockTypeToolResult:
					flushModel()
					toolParts = append(toolParts, encodeGeminiFunctionResponse(b))
				}
			}
			flushModel()
			flushToolResults()

		case domain.RoleToolResult:
			var parts []map[string]any
			for _, b := range msg.Blocks {
				if b.Type == domain.BlockTypeToolResult {
					parts = append(parts, encodeGeminiFunctionResponse(b))
				}
			}
			appendContent("user", parts)
		}
	}
	return contents
}

func (f *GoogleGenAIFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := MergeCompat(f.DefaultCompat(), input.Compat)
	params := resolveGenerationParams(input.Model, input.Params)

	contents := buildGeminiContents(input.Messages)
	usingCachedContent := geminiCacheManaged(input, compat) &&
		input.PromptCache != nil &&
		!input.PromptCache.Unsupported &&
		input.PromptCache.ResourceName != "" &&
		input.PromptCache.PrefixCount >= 0 &&
		input.PromptCache.PrefixCount < len(contents)

	body := map[string]any{}
	if usingCachedContent {
		body["cachedContent"] = input.PromptCache.ResourceName
		body["contents"] = contents[input.PromptCache.PrefixCount:]
	} else {
		body["contents"] = contents
		if sys := buildGeminiSystem(input.SystemPrompt); sys != nil {
			body["systemInstruction"] = sys
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
	if !usingCachedContent {
		if toolsObj := buildGeminiTools(input.Tools); len(toolsObj) > 0 {
			body["tools"] = toolsObj
		}
	}
	if len(compat.ExtraBody) > 0 {
		if usingCachedContent {
			filteredExtra := make(map[string]any, len(compat.ExtraBody))
			for k, v := range compat.ExtraBody {
				if k == "systemInstruction" || k == "tools" || k == "toolConfig" {
					continue
				}
				filteredExtra[k] = v
			}
			if len(filteredExtra) > 0 {
				MergeBodyMap(body, filteredExtra)
			}
		} else {
			MergeBodyMap(body, compat.ExtraBody)
		}
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
	text := formatToolResultContent(b)
	respPayload := map[string]any{}
	if b.IsError {
		respPayload["error"] = text
	} else {
		respPayload["content"] = text
	}
	fnResp := map[string]any{
		"name":     name,
		"response": respPayload,
	}
	if b.ToolCallID != "" {
		fnResp["id"] = b.ToolCallID
	}
	return map[string]any{
		"functionResponse": fnResp,
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
				Text             string `json:"text"`
				Thought          bool   `json:"thought"`
				ThoughtSignature string `json:"thoughtSignature"`
				FunctionCall     *struct {
					ID   string          `json:"id"`
					Name string          `json:"name"`
					Args json.RawMessage `json:"args"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount        int `json:"promptTokenCount"`
		CachedContentTokenCount int `json:"cachedContentTokenCount"`
		CandidatesTokenCount    int `json:"candidatesTokenCount"`
		ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
		TotalTokenCount         int `json:"totalTokenCount"`
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
		thinkSig      strings.Builder
		activeTextIdx = -1
		textBuf       strings.Builder
		hasToolCall   bool
		toolCounter   int
		seenCallIDs   = make(map[string]struct{})
		finalUsage    *domain.Usage
		stopReason    string
		emittedError  bool
	)

	closeThinking := func() error {
		if activeThink < 0 {
			return nil
		}
		block := domain.ContentBlock{
			Type:     domain.BlockTypeThinking,
			Thinking: thinkBuf.String(),
		}
		if sig := thinkSig.String(); sig != "" {
			block.Signature = sig
			block.Extra = makeProviderExtra(FormatIDGoogleGenAI, map[string]any{
				"thoughtSignature": sig,
			})
		}
		err := emitBlockEnd(emit, activeThink, block)
		activeThink = -1
		thinkBuf.Reset()
		thinkSig.Reset()
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
				InputTokens:          u.PromptTokenCount,
				OutputTokens:         u.CandidatesTokenCount,
				ThinkingTokens:       u.ThoughtsTokenCount,
				CacheReadInputTokens: u.CachedContentTokenCount,
				TotalTokens:          total,
			}
		}

		if len(chunk.Candidates) == 0 {
			return nil
		}
		cand := chunk.Candidates[0]

		for _, part := range cand.Content.Parts {
			if part.Thought && (part.Text != "" || part.ThoughtSignature != "") {
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
				if part.Text != "" {
					thinkBuf.WriteString(part.Text)
					if err := emitBlockDelta(emit, activeThink, domain.BlockTypeThinking, domain.DeltaTypeThinking, part.Text); err != nil {
						return err
					}
				}
				if part.ThoughtSignature != "" {
					thinkSig.Reset()
					thinkSig.WriteString(part.ThoughtSignature)
					if err := emitBlockDelta(emit, activeThink, domain.BlockTypeThinking, domain.DeltaTypeSignature, part.ThoughtSignature); err != nil {
						return err
					}
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
				if part.FunctionCall.ID != "" {
					if _, dup := seenCallIDs[part.FunctionCall.ID]; dup {
						continue
					}
					seenCallIDs[part.FunctionCall.ID] = struct{}{}
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
				startBlock := &domain.ContentBlock{
					Type: domain.BlockTypeToolCall,
					ID:   callID,
					Name: part.FunctionCall.Name,
				}
				endBlock := domain.ContentBlock{
					Type:      domain.BlockTypeToolCall,
					ID:        callID,
					Name:      part.FunctionCall.Name,
					Arguments: argsRaw,
				}
				if part.ThoughtSignature != "" {
					startBlock.Signature = part.ThoughtSignature
					endBlock.Signature = part.ThoughtSignature
					extra := makeProviderExtra(FormatIDGoogleGenAI, map[string]any{
						"thoughtSignature": part.ThoughtSignature,
					})
					startBlock.Extra = extra
					endBlock.Extra = extra
				}
				if err := emit(domain.StreamEvent{
					Type:      domain.StreamEventBlockStart,
					Index:     domain.IntPtr(idx),
					BlockType: domain.BlockTypeToolCall,
					Block:     startBlock,
				}); err != nil {
					return err
				}
				if err := emitBlockDelta(emit, idx, domain.BlockTypeToolCall, domain.DeltaTypeToolCallArgs, string(argsRaw)); err != nil {
					return err
				}
				if err := emitBlockEnd(emit, idx, endBlock); err != nil {
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
