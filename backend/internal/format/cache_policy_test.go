package format

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

// countAnthropicBreakpoints counts every cache_control marker in an encoded body.
func countAnthropicBreakpoints(body map[string]any) int {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0
	}
	return strings.Count(string(raw), `"cache_control"`)
}

func encodeCacheBody(t *testing.T, f plugin.APIFormat, input plugin.ChatInput) (plugin.EncodedRequest, map[string]any) {
	t.Helper()
	req, err := f.EncodeRequest(context.Background(), input)
	if err != nil {
		t.Fatalf("%s EncodeRequest: %v", f.ID(), err)
	}
	var body map[string]any
	if err := json.Unmarshal(req.Body, &body); err != nil {
		t.Fatalf("%s decode body: %v", f.ID(), err)
	}
	return req, body
}

func planCache(t *testing.T, f plugin.APIFormat, input plugin.ChatInput) plugin.CachePlan {
	t.Helper()
	planner, ok := f.(plugin.PromptCachePlanner)
	if !ok {
		t.Fatalf("%s does not implement PromptCachePlanner", f.ID())
	}
	plan, err := planner.PlanCache(context.Background(), input, nil)
	if err != nil {
		t.Fatalf("%s PlanCache: %v", f.ID(), err)
	}
	return plan
}

func contentParts(t *testing.T, body map[string]any, msgIndex int) []any {
	t.Helper()
	msgs, ok := body["messages"].([]any)
	if !ok || msgIndex >= len(msgs) {
		t.Fatalf("missing message #%d: %+v", msgIndex, body["messages"])
	}
	parts, ok := msgs[msgIndex].(map[string]any)["content"].([]any)
	if !ok {
		t.Fatalf("message #%d has no parts: %+v", msgIndex, msgs[msgIndex])
	}
	return parts
}

// cachedTail reports whether the last content part of a message carries a marker.
func cachedTail(parts []any) bool {
	if len(parts) == 0 {
		return false
	}
	part, _ := parts[len(parts)-1].(map[string]any)
	if part == nil {
		return false
	}
	return part["cache_control"] != nil || part["prompt_cache_breakpoint"] != nil
}

func TestAnthropicReusableBreakpoints(t *testing.T) {
	f := NewAnthropicMessagesFormat()
	tools := []plugin.ChatTool{
		{Alias: "t1", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
		{Alias: "t2", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)},
	}
	base := plugin.ChatInput{
		ConversationID:  "conv-1",
		Model:           domain.ModelConfig{ID: "claude-sonnet-4-5"},
		SystemPrompt:    "Sys",
		Tools:           tools,
		AutoCreateCache: true,
	}

	// Round 1 has a single user turn: the tail is marked so the next round can read it.
	round1 := base
	round1.Messages = []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}}}}
	_, body1 := encodeCacheBody(t, f, round1)
	if sysParts, ok := body1["system"].([]any); !ok || sysParts[0].(map[string]any)["cache_control"] == nil {
		t.Fatalf("expected marked system block: %+v", body1["system"])
	}
	if !cachedTail(contentParts(t, body1, 0)) {
		t.Fatalf("round 1 tail must be marked: %+v", body1["messages"])
	}
	if got := countAnthropicBreakpoints(body1); got != 3 {
		t.Fatalf("expected system + last tool + tail = 3 markers, got %d", got)
	}

	// Round 2 keeps the previous turn boundary marked next to the new tail.
	round2 := base
	round2.Messages = []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}}},
		{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a1"}}},
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u2"}}},
	}
	_, body2 := encodeCacheBody(t, f, round2)
	if !cachedTail(contentParts(t, body2, 0)) {
		t.Fatalf("previous turn boundary must stay marked: %+v", body2["messages"])
	}
	if !cachedTail(contentParts(t, body2, 2)) {
		t.Fatalf("current turn tail must be marked: %+v", body2["messages"])
	}
	if got := countAnthropicBreakpoints(body2); got != 4 {
		t.Fatalf("expected 4 markers, got %d", got)
	}

	// Tool flow with far more than 20 content blocks still anchors the previous boundary.
	blocks := []domain.ContentBlock{
		{Type: domain.BlockTypeThinking, Thinking: "think", Signature: "sig"},
		{Type: domain.BlockTypeToolCall, ID: "tc1", Name: "t1", Arguments: json.RawMessage(`{}`)},
	}
	for i := 0; i < 25; i++ {
		blocks = append(blocks, domain.ContentBlock{Type: domain.BlockTypeText, Text: fmt.Sprintf("chunk-%d", i)})
	}
	blocks = append(blocks, domain.ContentBlock{Type: domain.BlockTypeToolResult, ToolCallID: "tc1", ToolName: "t1", Content: "res"})
	round3 := base
	round3.Messages = []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}}},
		{Role: domain.RoleAssistant, Blocks: blocks},
	}
	_, body3 := encodeCacheBody(t, f, round3)
	encoded3 := body3["messages"].([]any)
	if len(encoded3) < 3 {
		t.Fatalf("expected assistant plus tool-result messages, got %d", len(encoded3))
	}
	anchor := contentParts(t, body3, 0)
	if anchor[0].(map[string]any)["cache_control"] == nil {
		t.Fatalf("long tool round must keep the previous boundary anchor: %+v", encoded3)
	}
	thinking := contentParts(t, body3, 1)[0].(map[string]any)
	if thinking["cache_control"] != nil || thinking["signature"] != "sig" {
		t.Fatalf("thinking block must stay unmarked and signed: %+v", thinking)
	}
	if !cachedTail(contentParts(t, body3, len(encoded3)-1)) {
		t.Fatalf("tool-result tail must be marked: %+v", encoded3)
	}
	if got := countAnthropicBreakpoints(body3); got > 4 {
		t.Fatalf("expected at most 4 markers, got %d", got)
	}
}

func TestCachePolicyMatrixAcrossFormats(t *testing.T) {
	msgs := []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hello"}}}}
	tools := []plugin.ChatTool{{Alias: "t1", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)}}
	const (
		officialCompletions = "https://api.openai.com/v1/chat/completions"
		officialResponses   = "https://api.openai.com/v1/responses"
		compatCompletions   = "https://proxy.example/v1/chat/completions"
		compatResponses     = "https://proxy.example/v1/responses"
	)

	for _, mode := range []string{"", domain.CacheModeAuto, domain.CacheModeImplicit, domain.CacheModeDisabled, domain.CacheModeExplicit} {
		for _, global := range []bool{false, true} {
			managed := mode == domain.CacheModeExplicit || ((mode == "" || mode == domain.CacheModeAuto) && global)
			compatExplicit := mode == domain.CacheModeExplicit
			t.Run(fmt.Sprintf("mode=%q/global=%v", mode, global), func(t *testing.T) {
				base := plugin.ChatInput{
					ConversationID:  "conv-1",
					Model:           domain.ModelConfig{ID: "m1"},
					SystemPrompt:    "Sys",
					Messages:        msgs,
					Tools:           tools,
					AutoCreateCache: global,
					Compat:          domain.CompatConfig{CacheMode: mode},
				}

				// Anthropic always uses inline markers, never a pre-request.
				ant := base
				ant.Model = domain.ModelConfig{ID: "claude-sonnet-4-5"}
				antFormat := NewAnthropicMessagesFormat()
				antReq, antBody := encodeCacheBody(t, antFormat, ant)
				if got := countAnthropicBreakpoints(antBody) > 0; got != managed {
					t.Fatalf("anthropic markers managed=%v but got markers=%v: %s", managed, got, antReq.Body)
				}
				if plan := planCache(t, antFormat, ant); plan.InlineCache != managed || plan.CreateRequest != nil {
					t.Fatalf("anthropic plan unexpected: %+v", plan)
				}

				// OpenAI Chat Completions: official route keys follow the preference,
				// compatibility endpoints only ever use the explicit extension.
				compFormat := NewOpenAICompletionsFormat()
				compat := base
				compat.Model = domain.ModelConfig{ID: "gpt-4.1"}
				compat.GenerationURL = compatCompletions
				_, compatBody := encodeCacheBody(t, compFormat, compat)
				if stringsContainsKey(mustJSON(t, compatBody), "prompt_cache_key") {
					t.Fatalf("compatibility endpoint must not receive prompt_cache_key: %+v", compatBody)
				}
				if stringsContainsKey(mustJSON(t, compatBody), "prompt_cache_options") != compatExplicit {
					t.Fatalf("compatibility extension unexpected for mode=%q: %+v", mode, compatBody)
				}
				if plan := planCache(t, compFormat, compat); plan.InlineCache != compatExplicit || plan.CreateRequest != nil {
					t.Fatalf("completions compatibility plan unexpected: %+v", plan)
				}

				official := base
				official.Model = domain.ModelConfig{ID: "gpt-4.1"}
				official.GenerationURL = officialCompletions
				if compatExplicit {
					official.Compat.ExtraBody = nil
				}
				_, officialBody := encodeCacheBody(t, compFormat, official)
				if stringsContainsKey(mustJSON(t, officialBody), "prompt_cache_options") || stringsContainsKey(mustJSON(t, officialBody), "prompt_cache_breakpoint") {
					t.Fatalf("official endpoint must not receive compatibility fields: %+v", officialBody)
				}
				if stringsContainsKey(mustJSON(t, officialBody), "prompt_cache_key") != managed {
					t.Fatalf("official prompt_cache_key managed=%v mismatch: %+v", managed, officialBody)
				}
				if plan := planCache(t, compFormat, official); plan.InlineCache != managed {
					t.Fatalf("official completions plan unexpected: %+v", plan)
				}

				// OpenAI Responses behaves the same across the two target kinds.
				respFormat := NewOpenAIResponsesFormat()
				respCompat := compat
				respCompat.GenerationURL = compatResponses
				_, respCompatBody := encodeCacheBody(t, respFormat, respCompat)
				if stringsContainsKey(mustJSON(t, respCompatBody), "prompt_cache_key") {
					t.Fatalf("responses compatibility endpoint must not receive prompt_cache_key: %+v", respCompatBody)
				}
				if stringsContainsKey(mustJSON(t, respCompatBody), "prompt_cache_options") != compatExplicit {
					t.Fatalf("responses compatibility extension unexpected: %+v", respCompatBody)
				}
				respOfficial := official
				respOfficial.GenerationURL = officialResponses
				_, respOfficialBody := encodeCacheBody(t, respFormat, respOfficial)
				if stringsContainsKey(mustJSON(t, respOfficialBody), "prompt_cache_options") || stringsContainsKey(mustJSON(t, respOfficialBody), "prompt_cache_breakpoint") {
					t.Fatalf("official responses must not receive compatibility fields: %+v", respOfficialBody)
				}
				if stringsContainsKey(mustJSON(t, respOfficialBody), "prompt_cache_key") != managed {
					t.Fatalf("official responses prompt_cache_key managed=%v mismatch: %+v", managed, respOfficialBody)
				}

				// Gemini owns a separate cachedContents resource only when managed.
				gem := base
				gem.Model = domain.ModelConfig{ID: "gemini-2.5-pro"}
				gemFormat := NewGoogleGenAIFormat()
				plan := planCache(t, gemFormat, gem)
				if (plan.CreateRequest != nil) != managed {
					t.Fatalf("gemini resource plan managed=%v mismatch: %+v", managed, plan)
				}
			})
		}
	}
}

func mustJSON(t *testing.T, body map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return raw
}

func TestOpenAIOfficialEndpointRecognition(t *testing.T) {
	completions := NewOpenAICompletionsFormat().DefaultPath()
	responses := NewOpenAIResponsesFormat().DefaultPath()
	cases := []struct {
		url  string
		path string
		want bool
	}{
		{"https://api.openai.com/v1/chat/completions", completions, true},
		{"https://api.openai.com/v1/chat/completions/", completions, true},
		{"https://api.openai.com:443/v1/chat/completions", completions, true},
		{"HTTPS://API.OPENAI.COM/v1/chat/completions", completions, true},
		{"https://api.openai.com/v1/responses", responses, true},
		{"https://api.openai.com/v1/chat/completions", responses, false},
		{"https://api.openai.com:8443/v1/chat/completions", completions, false},
		{"http://api.openai.com/v1/chat/completions", completions, false},
		{"https://api.openai.com.evil.example/v1/chat/completions", completions, false},
		{"https://proxy.example/v1/chat/completions", completions, false},
		{"https://api.openai.com/v2/chat/completions", completions, false},
		{"", completions, false},
	}
	for _, tc := range cases {
		if got := isOpenAIOfficialEndpoint(tc.url, tc.path); got != tc.want {
			t.Fatalf("isOpenAIOfficialEndpoint(%q, %q) = %v, want %v", tc.url, tc.path, got, tc.want)
		}
	}
}

func TestOpenAIPromptCacheKeyStabilityAndScoping(t *testing.T) {
	f := NewOpenAICompletionsFormat()
	base := plugin.ChatInput{
		ConversationID:  "conv-1",
		Provider:        domain.ProviderConfig{ID: "p1"},
		Model:           domain.ModelConfig{ID: "gpt-4.1"},
		SystemPrompt:    "Sys",
		AutoCreateCache: true,
		GenerationURL:   "https://api.openai.com/v1/chat/completions",
	}
	turn := func(text string) string {
		input := base
		input.Messages = []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: text}}}}
		_, body := encodeCacheBody(t, f, input)
		key, _ := body["prompt_cache_key"].(string)
		if key == "" {
			t.Fatalf("missing prompt_cache_key: %+v", body)
		}
		if strings.Contains(key, text) {
			t.Fatalf("routing key must not carry prompt text: %q", key)
		}
		return key
	}
	if first, second := turn("first turn"), turn("second turn"); first != second {
		t.Fatalf("routing key must stay stable across turns: %q vs %q", first, second)
	}
	other := base
	other.ConversationID = "conv-2"
	other.Messages = base.Messages
	if openAIPromptCacheKey(other, f.ID()) == openAIPromptCacheKey(base, f.ID()) {
		t.Fatal("different conversations must not share a routing key")
	}
}

func TestOpenAIOfficialRejectsCompatCacheExtension(t *testing.T) {
	extra := map[string]any{"prompt_cache_options": map[string]any{"mode": "explicit"}}
	for _, f := range []plugin.APIFormat{NewOpenAICompletionsFormat(), NewOpenAIResponsesFormat()} {
		input := plugin.ChatInput{
			ConversationID:  "conv-1",
			Model:           domain.ModelConfig{ID: "gpt-5.6"},
			SystemPrompt:    "Sys",
			Messages:        []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hello"}}}},
			AutoCreateCache: true,
			GenerationURL:   "https://api.openai.com" + f.DefaultPath(),
			Compat:          domain.CompatConfig{CacheMode: domain.CacheModeExplicit, ExtraBody: extra},
		}
		if _, err := f.EncodeRequest(context.Background(), input); err == nil {
			t.Fatalf("%s must reject compat cache extensions on the official endpoint", f.ID())
		} else if appErr, ok := domain.AsAppError(err); !ok || appErr.HTTPStatus() != 400 {
			t.Fatalf("%s expected INVALID_ARGUMENT, got %v", f.ID(), err)
		}
	}
}
