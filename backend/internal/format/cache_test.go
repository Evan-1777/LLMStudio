package format

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestAnthropicInlinePromptCaching(t *testing.T) {
	f := NewAnthropicMessagesFormat()
	tools := []plugin.ChatTool{
		{Alias: "t1", Description: "first", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
		{Alias: "t2", Description: "second", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
	}
	msgs := []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Hello"}}},
		{
			Role: domain.RoleAssistant,
			Blocks: []domain.ContentBlock{
				{Type: domain.BlockTypeThinking, Thinking: "thought", Signature: "sig_valid"},
				{Type: domain.BlockTypeText, Text: "Reply 1"},
			},
		},
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Current turn"}}},
	}

	// 1. Disabled globally -> plain system string, no cache_control anywhere.
	offReq, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "claude-sonnet-4-5"},
		SystemPrompt:    "Be concise.",
		Messages:        msgs,
		Tools:           tools,
		AutoCreateCache: false,
	})
	if err != nil {
		t.Fatalf("off EncodeRequest: %v", err)
	}
	var offBody map[string]any
	_ = json.Unmarshal(offReq.Body, &offBody)
	if _, ok := offBody["system"].(string); !ok {
		t.Fatalf("expected plain string system when cache off, got %T", offBody["system"])
	}
	if stringsContainsKey(offReq.Body, "cache_control") {
		t.Fatalf("unexpected cache_control when AutoCreateCache=false: %s", offReq.Body)
	}

	// 2. Manual ExtraBody preserved even when AutoCreateCache=false.
	manualReq, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "claude-sonnet-4-5"},
		SystemPrompt:    "Be concise.",
		Messages:        msgs,
		AutoCreateCache: false,
		Compat: domain.CompatConfig{
			ExtraBody: map[string]any{
				"system": []map[string]any{{"type": "text", "text": "Manual", "cache_control": map[string]any{"type": "ephemeral"}}},
			},
		},
	})
	if err != nil {
		t.Fatalf("manual EncodeRequest: %v", err)
	}
	if !stringsContainsKey(manualReq.Body, "cache_control") {
		t.Fatalf("expected user manual ExtraBody cache_control preserved: %s", manualReq.Body)
	}

	// 3. AutoCreateCache=true with implicit or disabled skips cache_control.
	for _, mode := range []string{domain.CacheModeImplicit, domain.CacheModeDisabled} {
		req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:           domain.ModelConfig{ID: "claude-sonnet-4-5"},
			SystemPrompt:    "Sys",
			Messages:        msgs,
			Tools:           tools,
			AutoCreateCache: true,
			Compat:          domain.CompatConfig{CacheMode: mode},
		})
		if err != nil {
			t.Fatalf("%s EncodeRequest: %v", mode, err)
		}
		if stringsContainsKey(req.Body, "cache_control") {
			t.Fatalf("unexpected cache_control under mode=%s: %s", mode, req.Body)
		}
	}

	// 4. AutoCreateCache=true + auto -> breakpoints on system, last tool, and stable prefix before last user turn (not on thinking or current turn).
	onReq, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "claude-sonnet-4-5"},
		SystemPrompt:    "System instructions",
		Messages:        msgs,
		Tools:           tools,
		AutoCreateCache: true,
	})
	if err != nil {
		t.Fatalf("on EncodeRequest: %v", err)
	}
	var onBody map[string]any
	_ = json.Unmarshal(onReq.Body, &onBody)

	sysArr, ok := onBody["system"].([]any)
	if !ok || len(sysArr) != 1 || sysArr[0].(map[string]any)["cache_control"] == nil {
		t.Fatalf("expected cache_control on system array block: %+v", onBody["system"])
	}
	encodedTools := onBody["tools"].([]any)
	if encodedTools[0].(map[string]any)["cache_control"] != nil || encodedTools[1].(map[string]any)["cache_control"] == nil {
		t.Fatalf("expected cache_control only on last tool: %+v", encodedTools)
	}
	encodedMsgs := onBody["messages"].([]any)
	assistantParts := encodedMsgs[1].(map[string]any)["content"].([]any)
	if assistantParts[0].(map[string]any)["cache_control"] != nil || assistantParts[0].(map[string]any)["signature"] != "sig_valid" {
		t.Fatalf("thinking block must not receive cache_control or lose signature: %+v", assistantParts[0])
	}
	if assistantParts[1].(map[string]any)["cache_control"] == nil {
		t.Fatalf("expected cache_control on stable assistant text prefix: %+v", assistantParts[1])
	}
	lastUserParts := encodedMsgs[2].(map[string]any)["content"].([]any)
	if lastUserParts[0].(map[string]any)["cache_control"] != nil {
		t.Fatalf("current turn user input must not be marked with cache_control: %+v", lastUserParts[0])
	}

	// 5. No system prompt -> omits system, still adds valid tool + history breakpoints.
	noSysReq, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "claude-sonnet-4-5"},
		Messages:        msgs,
		Tools:           tools,
		AutoCreateCache: true,
	})
	if err != nil {
		t.Fatalf("noSys EncodeRequest: %v", err)
	}
	var noSysBody map[string]any
	_ = json.Unmarshal(noSysReq.Body, &noSysBody)
	if _, hasSys := noSysBody["system"]; hasSys {
		t.Fatalf("expected no system key when SystemPrompt empty: %+v", noSysBody)
	}
}

func TestOpenAICompletionsAndResponsesPromptCaching(t *testing.T) {
	comp := NewOpenAICompletionsFormat()
	resp := NewOpenAIResponsesFormat()

	tools := []plugin.ChatTool{
		{Alias: "lookup", Description: "lookup", InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`)},
	}
	msgs := []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "First question"}}},
		{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "First answer"}}},
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Follow up"}}},
	}

	// 1. Default auto/implicit on unknown OpenAI-compatible endpoints adds NO prompt_cache_* fields.
	for _, mode := range []string{"", domain.CacheModeAuto, domain.CacheModeImplicit, domain.CacheModeDisabled} {
		cReq, err := comp.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:           domain.ModelConfig{ID: "gpt-4.1"},
			SystemPrompt:    "Sys",
			Messages:        msgs,
			Tools:           tools,
			AutoCreateCache: true,
			Compat:          domain.CompatConfig{CacheMode: mode},
		})
		if err != nil {
			t.Fatalf("comp mode=%s err=%v", mode, err)
		}
		if stringsContainsKey(cReq.Body, "prompt_cache_options") || stringsContainsKey(cReq.Body, "prompt_cache_breakpoint") || stringsContainsKey(cReq.Body, "cache_control") {
			t.Fatalf("completions mode=%s unexpectedly added cache fields: %s", mode, cReq.Body)
		}

		rReq, err := resp.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:           domain.ModelConfig{ID: "gpt-4.1"},
			SystemPrompt:    "Sys",
			Messages:        msgs,
			Tools:           tools,
			AutoCreateCache: true,
			Compat:          domain.CompatConfig{CacheMode: mode},
		})
		if err != nil {
			t.Fatalf("resp mode=%s err=%v", mode, err)
		}
		if stringsContainsKey(rReq.Body, "prompt_cache_options") || stringsContainsKey(rReq.Body, "prompt_cache_breakpoint") || stringsContainsKey(rReq.Body, "cache_control") {
			t.Fatalf("responses mode=%s unexpectedly added cache fields: %s", mode, rReq.Body)
		}
	}

	// 2. Explicit mode on Chat Completions uses messages[*].content[*].type="text" + prompt_cache_breakpoint.
	cExpReq, err := comp.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "gpt-5.6"},
		SystemPrompt:    "System rules",
		Messages:        msgs,
		Tools:           tools,
		AutoCreateCache: true,
		Compat:          domain.CompatConfig{CacheMode: domain.CacheModeExplicit},
	})
	if err != nil {
		t.Fatalf("comp explicit err=%v", err)
	}
	var cBody map[string]any
	_ = json.Unmarshal(cExpReq.Body, &cBody)
	if cBody["prompt_cache_options"].(map[string]any)["mode"] != "explicit" {
		t.Fatalf("missing prompt_cache_options.mode=explicit: %+v", cBody)
	}
	if _, hasInput := cBody["input"]; hasInput {
		t.Fatalf("completions must not copy responses input field")
	}
	cMsgs := cBody["messages"].([]any)
	sysPart := cMsgs[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	if sysPart["type"] != "text" || sysPart["prompt_cache_breakpoint"] == nil {
		t.Fatalf("expected Chat Completions text part with prompt_cache_breakpoint on system: %+v", sysPart)
	}
	histPart := cMsgs[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	if histPart["prompt_cache_breakpoint"] == nil {
		t.Fatalf("expected prompt_cache_breakpoint on stable assistant history: %+v", histPart)
	}
	if _, isStr := cMsgs[3].(map[string]any)["content"].(string); !isStr {
		t.Fatalf("trailing user message should remain un-breakpointed string: %+v", cMsgs[3])
	}

	// 3. Explicit mode on Responses API uses input[*] items with type="input_text"/"output_text" + developer role.
	rExpReq, err := resp.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "gpt-5.6"},
		SystemPrompt:    "System rules",
		Messages:        msgs,
		Tools:           tools,
		AutoCreateCache: true,
		Compat:          domain.CompatConfig{CacheMode: domain.CacheModeExplicit},
	})
	if err != nil {
		t.Fatalf("resp explicit err=%v", err)
	}
	var rBody map[string]any
	_ = json.Unmarshal(rExpReq.Body, &rBody)
	if rBody["prompt_cache_options"].(map[string]any)["mode"] != "explicit" {
		t.Fatalf("missing prompt_cache_options on responses: %+v", rBody)
	}
	if _, hasMsgs := rBody["messages"]; hasMsgs {
		t.Fatalf("responses must not copy completions messages field")
	}
	if _, hasInstr := rBody["instructions"]; hasInstr {
		t.Fatalf("responses explicit should move system into developer input item rather than duplicating instructions: %+v", rBody)
	}
	rItems := rBody["input"].([]any)
	if rItems[0].(map[string]any)["role"] != "developer" {
		t.Fatalf("expected leading developer item in responses input: %+v", rItems[0])
	}
	rSysPart := rItems[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	if rSysPart["type"] != "input_text" || rSysPart["prompt_cache_breakpoint"] == nil {
		t.Fatalf("expected input_text with prompt_cache_breakpoint on responses developer item: %+v", rSysPart)
	}
	rHistPart := rItems[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	if rHistPart["type"] != "output_text" || rHistPart["prompt_cache_breakpoint"] == nil {
		t.Fatalf("expected output_text with prompt_cache_breakpoint on responses history item: %+v", rHistPart)
	}

	// 4. Without system prompt in Responses explicit: no empty developer item, breakpoint still placed on history.
	rNoSysReq, err := resp.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "gpt-5.6"},
		Messages:        msgs,
		AutoCreateCache: true,
		Compat:          domain.CompatConfig{CacheMode: domain.CacheModeExplicit},
	})
	if err != nil {
		t.Fatalf("resp noSys err=%v", err)
	}
	var rNoSysBody map[string]any
	_ = json.Unmarshal(rNoSysReq.Body, &rNoSysBody)
	rNoSysItems := rNoSysBody["input"].([]any)
	if len(rNoSysItems) != 3 || rNoSysItems[1].(map[string]any)["content"].([]any)[0].(map[string]any)["prompt_cache_breakpoint"] == nil {
		t.Fatalf("expected 3 items with history breakpoint when no system prompt: %+v", rNoSysItems)
	}
}

func TestGoogleGenAICachePlanningMutuallyExclusiveAndPrefix(t *testing.T) {
	f := NewGoogleGenAIFormat()
	tools := []plugin.ChatTool{
		{Alias: "get_weather", Description: "weather", InputSchema: json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}}}`)},
	}
	msgs := []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Hello"}}},
		{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Hi!"}}},
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Weather in NYC?"}}},
	}
	compat := domain.CompatConfig{
		PathOverride: "/v1beta/models/{model}:customGenerate",
		ExtraBody: map[string]any{
			"toolConfig":      map[string]any{"functionCallingConfig": map[string]any{"mode": "AUTO"}},
			"safetySettings":  []map[string]any{{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}},
		},
	}

	input := plugin.ChatInput{
		Model:           domain.ModelConfig{ID: "gemini-2.5-pro"},
		SystemPrompt:    "Be precise.",
		Messages:        msgs,
		Tools:           tools,
		Compat:          compat,
		AutoCreateCache: true,
	}

	plan, err := f.PlanCache(context.Background(), input, nil)
	if err != nil || plan.CreateRequest == nil {
		t.Fatalf("expected cache create request, plan=%+v err=%v", plan, err)
	}
	if plan.CreateRequest.DefaultPath != "/v1beta/cachedContents" {
		t.Fatalf("unexpected cache create path %q", plan.CreateRequest.DefaultPath)
	}
	var createBody map[string]any
	_ = json.Unmarshal(plan.CreateRequest.Body, &createBody)
	if createBody["model"] != "models/gemini-2.5-pro" || createBody["systemInstruction"] == nil || createBody["tools"] == nil || createBody["toolConfig"] == nil {
		t.Fatalf("missing cached fields in create body: %+v", createBody)
	}
	cachedContents := createBody["contents"].([]any)
	if len(cachedContents) != 2 {
		t.Fatalf("expected 2 prefix contents in cache create, got %d", len(cachedContents))
	}

	resolved, err := f.ResolveCache(context.Background(), input, plan, plugin.CacheResolutionInput{
		StatusCode: 200,
		Body:       []byte(`{"name":"cachedContents/c1","expireTime":"2099-01-01T00:00:00Z"}`),
		PlanKey:    plan.PlanKey,
	})
	if err != nil || resolved.HardError != nil || resolved.Degrade || resolved.State == nil {
		t.Fatalf("unexpected ResolveCache result: %+v err=%v", resolved, err)
	}

	// Main request must include cachedContent and suffix ONLY, omitting systemInstruction/tools/toolConfig while keeping safetySettings.
	input.PromptCache = resolved.State
	mainReq, err := f.EncodeRequest(context.Background(), input)
	if err != nil {
		t.Fatalf("main EncodeRequest failed: %v", err)
	}
	var mainBody map[string]any
	_ = json.Unmarshal(mainReq.Body, &mainBody)
	if mainBody["cachedContent"] != "cachedContents/c1" {
		t.Fatalf("missing cachedContent ref: %+v", mainBody)
	}
	for _, forbidden := range []string{"systemInstruction", "tools", "toolConfig"} {
		if _, exists := mainBody[forbidden]; exists {
			t.Fatalf("main body must omit mutually exclusive field %q when cachedContent set: %+v", forbidden, mainBody)
		}
	}
	if mainBody["safetySettings"] == nil {
		t.Fatalf("expected non-conflicting ExtraBody field safetySettings preserved")
	}
	suffixContents := mainBody["contents"].([]any)
	if len(suffixContents) != 1 {
		t.Fatalf("expected 1 uncached suffix content, got %d", len(suffixContents))
	}

	// Appending another turn still matches exact prefix -> PlanCache reuses state without creating new request.
	inputNext := input
	inputNext.Messages = append(append([]domain.Message{}, msgs...),
		domain.Message{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Sunny"}}},
		domain.Message{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Tomorrow?"}}},
	)
	reusePlan, err := f.PlanCache(context.Background(), inputNext, resolved.State)
	if err != nil || reusePlan.CreateRequest != nil || reusePlan.ReuseState == nil || reusePlan.ReuseState.ResourceName != "cachedContents/c1" {
		t.Fatalf("expected cache reuse on extended conversation, got %+v err=%v", reusePlan, err)
	}

	// Changing tool schema or editing prefix invalidates reuse -> plans new CreateRequest.
	inputEdited := inputNext
	inputEdited.Messages = append([]domain.Message{}, inputNext.Messages...)
	inputEdited.Messages[0] = domain.Message{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Edited Hello"}}}
	replan, err := f.PlanCache(context.Background(), inputEdited, resolved.State)
	if err != nil || replan.CreateRequest == nil {
		t.Fatalf("expected prefix edit to invalidate old cache and plan new create: %+v err=%v", replan, err)
	}
}

func TestFourFormatsCacheUsageDecoding(t *testing.T) {
	decodeUsage := func(f plugin.APIFormat, sse string) *domain.Usage {
		t.Helper()
		var got *domain.Usage
		if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
			if ev.Type == domain.StreamEventMessageDelta && ev.Usage != nil {
				got = ev.Usage
			}
			return nil
		}); err != nil {
			t.Fatalf("%s DecodeStream: %v", f.ID(), err)
		}
		return got
	}

	// 1. OpenAI Chat Completions: prompt_tokens already includes cached_tokens; cache_write_tokens also parsed.
	oaiChat := decodeUsage(NewOpenAICompletionsFormat(), strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
		``,
		`data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":120}}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n"))
	if oaiChat == nil || oaiChat.InputTokens != 1000 || oaiChat.OutputTokens != 50 || oaiChat.CacheReadInputTokens != 800 || oaiChat.CacheCreationInputTokens != 120 || oaiChat.TotalTokens != 1050 {
		t.Fatalf("unexpected openai chat cache usage: %+v", oaiChat)
	}

	// 2. OpenAI Responses: input_tokens already includes cached_tokens; cache_creation_tokens alias supported.
	oaiResp := decodeUsage(NewOpenAIResponsesFormat(), strings.Join([]string{
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"output_tokens":30,"total_tokens":530,"input_tokens_details":{"cached_tokens":400,"cache_creation_tokens":60}}}}`,
		``,
	}, "\n"))
	if oaiResp == nil || oaiResp.InputTokens != 500 || oaiResp.OutputTokens != 30 || oaiResp.CacheReadInputTokens != 400 || oaiResp.CacheCreationInputTokens != 60 || oaiResp.TotalTokens != 530 {
		t.Fatalf("unexpected openai responses cache usage: %+v", oaiResp)
	}

	// 3. Anthropic Messages: input_tokens excludes cached portions -> summed into unified InputTokens.
	ant := decodeUsage(NewAnthropicMessagesFormat(), strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":200,"cache_read_input_tokens":750,"output_tokens":0}}}`,
		``,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
	}, "\n"))
	if ant == nil || ant.InputTokens != 1000 || ant.OutputTokens != 40 || ant.CacheReadInputTokens != 750 || ant.CacheCreationInputTokens != 200 || ant.TotalTokens != 1040 {
		t.Fatalf("unexpected anthropic cache usage: %+v", ant)
	}

	// 4. Google Gemini: promptTokenCount already includes cachedContentTokenCount.
	gem := decodeUsage(NewGoogleGenAIFormat(), strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":900,"cachedContentTokenCount":700,"candidatesTokenCount":25,"totalTokenCount":925}}`,
		``,
	}, "\n"))
	if gem == nil || gem.InputTokens != 900 || gem.OutputTokens != 25 || gem.CacheReadInputTokens != 700 || gem.CacheCreationInputTokens != 0 || gem.TotalTokens != 925 {
		t.Fatalf("unexpected gemini cache usage: %+v", gem)
	}

	// 5. Missing cache fields remain zero and omitted from JSON (no fabricated zero-hit claims).
	uncached := decodeUsage(NewOpenAICompletionsFormat(), strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
		``,
		`data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n"))
	raw, _ := json.Marshal(uncached)
	if strings.Contains(string(raw), "cacheReadInputTokens") || strings.Contains(string(raw), "cacheCreationInputTokens") {
		t.Fatalf("expected absent cache tokens omitted from JSON, got %s", raw)
	}
}

func stringsContainsKey(raw []byte, substr string) bool {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	b, _ := json.Marshal(m)
	return len(b) > 0 && containsSubstr(string(b), `"`+substr+`"`)
}

func containsSubstr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
