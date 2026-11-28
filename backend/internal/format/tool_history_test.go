package format

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestBuildChatToolAliasAndToollessOmission(t *testing.T) {
	used := make(map[string]struct{})
	a1 := plugin.BuildChatToolAlias("srv-alpha", "search", used)
	a2 := plugin.BuildChatToolAlias("srv-beta", "search", used)
	a3 := plugin.BuildChatToolAlias("srv-alpha", "123.weird/very-long-"+strings.Repeat("x", 80), used)

	identRe := regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`)
	for _, alias := range []string{a1, a2, a3} {
		if !identRe.MatchString(alias) {
			t.Fatalf("alias %q violates cross-provider identifier constraints", alias)
		}
	}
	if a1 == a2 {
		t.Fatalf("same-name tools across servers collided: %q", a1)
	}
	// Deterministic regardless of other active servers.
	if again := plugin.BuildChatToolAlias("srv-beta", "search", nil); again != a2 {
		t.Fatalf("alias not deterministic: %q vs %q", again, a2)
	}

	// Ensure formats omit tools and tool_choice when input.Tools is empty.
	formats := []plugin.APIFormat{
		NewOpenAICompletionsFormat(),
		NewOpenAIResponsesFormat(),
		NewAnthropicMessagesFormat(),
		NewGoogleGenAIFormat(),
	}
	for _, f := range formats {
		req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
			Model: domain.ModelConfig{ID: "m1"},
			Messages: []domain.Message{
				{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}},
			},
		})
		if err != nil {
			t.Fatalf("%s toolless EncodeRequest error: %v", f.ID(), err)
		}
		var body map[string]any
		if err := json.Unmarshal(req.Body, &body); err != nil {
			t.Fatalf("%s unmarshal error: %v", f.ID(), err)
		}
		if _, has := body["tools"]; has {
			t.Fatalf("%s unexpectedly injected tools on toolless request", f.ID())
		}
		if _, has := body["tool_choice"]; has {
			t.Fatalf("%s unexpectedly injected tool_choice on toolless request", f.ID())
		}
	}
}

func TestFourFormatsEncodeTwoRoundToolsAndCrossProtocolThinking(t *testing.T) {
	used := make(map[string]struct{})
	aliasA := plugin.BuildChatToolAlias("srv-1", "lookup", used)
	aliasB := plugin.BuildChatToolAlias("srv-2", "lookup", used)
	aliasC := plugin.BuildChatToolAlias("srv-1", "summarize", used)

	tools := []plugin.ChatTool{
		{
			Alias:       aliasA,
			ServerID:    "srv-1",
			ToolName:    "lookup",
			Description: "Lookup server 1",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}`),
		},
		{
			Alias:       aliasB,
			ServerID:    "srv-2",
			ToolName:    "lookup",
			Description: "Lookup server 2",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`),
		},
		{
			Alias:       aliasC,
			ServerID:    "srv-1",
			ToolName:    "summarize",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}}}`),
		},
	}

	buildHistory := func(nativeThink domain.ContentBlock, nativeCallSig string, nativeCallExtra json.RawMessage) []domain.Message {
		foreignUnsignedThink := domain.ContentBlock{
			Type:     domain.BlockTypeThinking,
			Thinking: "from another model without valid sig",
		}
		crossFormatThink := domain.ContentBlock{
			Type:      domain.BlockTypeThinking,
			Thinking:  "foreign sig",
			Signature: "foreign_raw_sig",
			Extra:     json.RawMessage(`{"providerFormat":"other-foreign-protocol"}`),
		}
		return []domain.Message{
			{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Compare sources"}}},
			{
				Role: domain.RoleAssistant,
				Blocks: []domain.ContentBlock{
					foreignUnsignedThink,
					crossFormatThink,
					nativeThink,
					{Type: domain.BlockTypeText, Text: "Checking both..."},
					{Type: domain.BlockTypeToolCall, ID: "call_r1_a", Name: aliasA, Arguments: json.RawMessage(`{"q":"alpha"}`), Signature: nativeCallSig, Extra: nativeCallExtra},
					{Type: domain.BlockTypeToolCall, ID: "call_r1_b", Name: aliasB, Arguments: json.RawMessage(`{"q":"beta"}`)},
					{Type: domain.BlockTypeToolResult, ToolCallID: "call_r1_a", ToolName: aliasA, Content: "res-alpha"},
					{Type: domain.BlockTypeToolResult, ToolCallID: "call_r1_b", ToolName: aliasB, Content: "res-beta", IsError: true},
					{Type: domain.BlockTypeToolCall, ID: "call_r2_c", Name: aliasC, Arguments: json.RawMessage(`{"text":"alpha+beta"}`)},
					{Type: domain.BlockTypeToolResult, ToolCallID: "call_r2_c", ToolName: aliasC, Content: "summary-ok"},
					{Type: domain.BlockTypeText, Text: "Final answer"},
				},
			},
			{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Follow up"}}},
		}
	}

	// 1. OpenAI Chat Completions
	{
		f := NewOpenAICompletionsFormat()
		req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:    domain.ModelConfig{ID: "gpt-4o"},
			Tools:    tools,
			Messages: buildHistory(domain.ContentBlock{Type: domain.BlockTypeThinking, Thinking: "ignore"}, "", nil),
		})
		if err != nil {
			t.Fatalf("openai completions encode: %v", err)
		}
		var body map[string]any
		_ = json.Unmarshal(req.Body, &body)
		encodedTools := body["tools"].([]any)
		if len(encodedTools) != 3 {
			t.Fatalf("expected 3 openai tools, got %d", len(encodedTools))
		}
		msgs := body["messages"].([]any)
		// Expect: user, assistant(r1+2 calls), tool(call_r1_a), tool(call_r1_b), assistant(r2+1 call), tool(call_r2_c), assistant("Final answer"), user("Follow up")
		if len(msgs) != 8 {
			t.Fatalf("expected 8 chronological wire messages in openai completions, got %d: %+v", len(msgs), msgs)
		}
		m1 := msgs[1].(map[string]any)
		if m1["content"] != "Checking both..." || len(m1["tool_calls"].([]any)) != 2 {
			t.Fatalf("round 1 assistant unexpectedly merged final text or lost calls: %+v", m1)
		}
		if msgs[2].(map[string]any)["tool_call_id"] != "call_r1_a" || msgs[3].(map[string]any)["tool_call_id"] != "call_r1_b" {
			t.Fatalf("round 1 tool_call_id order mismatch: %+v", msgs[2:4])
		}
		if msgs[4].(map[string]any)["tool_calls"].([]any)[0].(map[string]any)["id"] != "call_r2_c" {
			t.Fatalf("round 2 tool call missing: %+v", msgs[4])
		}
		if msgs[5].(map[string]any)["tool_call_id"] != "call_r2_c" {
			t.Fatalf("round 2 tool result mismatch: %+v", msgs[5])
		}
		if msgs[6].(map[string]any)["content"] != "Final answer" || msgs[6].(map[string]any)["tool_calls"] != nil {
			t.Fatalf("final round text should be separate assistant turn: %+v", msgs[6])
		}
	}

	// 2. OpenAI Responses
	{
		f := NewOpenAIResponsesFormat()
		nativeThink := domain.ContentBlock{
			Type:      domain.BlockTypeThinking,
			Thinking:  "resp summary",
			Signature: "enc_resp_1",
			Extra:     makeProviderExtra(FormatIDOpenAIResponses, map[string]any{"itemId": "rs_1", "encryptedContent": "enc_resp_1"}),
		}
		req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:    domain.ModelConfig{ID: "o4-mini"},
			Tools:    tools,
			Messages: buildHistory(nativeThink, "", nil),
		})
		if err != nil {
			t.Fatalf("openai responses encode: %v", err)
		}
		var body map[string]any
		_ = json.Unmarshal(req.Body, &body)
		if len(body["tools"].([]any)) != 3 {
			t.Fatalf("expected 3 responses tools")
		}
		items := body["input"].([]any)
		// Expect: user msg, reasoning(enc_resp_1), assistant msg("Checking both..."), fc(a), fc(b), fco(a), fco(b), fc(c), fco(c), assistant msg("Final answer"), user msg
		if len(items) != 11 {
			t.Fatalf("expected 11 chronological responses items (foreign/unsigned thinking omitted), got %d: %+v", len(items), items)
		}
		if items[1].(map[string]any)["type"] != "reasoning" || items[1].(map[string]any)["encrypted_content"] != "enc_resp_1" {
			t.Fatalf("missing encrypted_content on native reasoning item: %+v", items[1])
		}
		if items[5].(map[string]any)["call_id"] != "call_r1_a" || items[8].(map[string]any)["call_id"] != "call_r2_c" {
			t.Fatalf("responses function_call_output ordering broken: %+v", items)
		}
		if items[9].(map[string]any)["content"].([]any)[0].(map[string]any)["text"] != "Final answer" {
			t.Fatalf("expected Final answer at end of assistant turns, got %+v", items[9])
		}
	}

	// 3. Anthropic Messages
	{
		f := NewAnthropicMessagesFormat()
		nativeThink := domain.ContentBlock{
			Type:      domain.BlockTypeThinking,
			Thinking:  "claude step",
			Signature: "sig_ant_valid",
		}
		req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:    domain.ModelConfig{ID: "claude-sonnet-4-5"},
			Tools:    tools,
			Messages: buildHistory(nativeThink, "", nil),
		})
		if err != nil {
			t.Fatalf("anthropic encode: %v", err)
		}
		var body map[string]any
		_ = json.Unmarshal(req.Body, &body)
		if len(body["tools"].([]any)) != 3 {
			t.Fatalf("expected 3 anthropic tools")
		}
		msgs := body["messages"].([]any)
		// Expect: user, assistant(r1 thinking+text+2 tool_use), user(2 tool_result), assistant(1 tool_use), user(1 tool_result), assistant("Final answer"), user("Follow up")
		if len(msgs) != 7 {
			t.Fatalf("expected 7 anthropic turns, got %d: %+v", len(msgs), msgs)
		}
		r1Content := msgs[1].(map[string]any)["content"].([]any)
		// foreign unsigned thinking and foreign sig must be skipped; only native signed thinking + text + 2 tool_use = 4 blocks!
		if len(r1Content) != 4 || r1Content[0].(map[string]any)["signature"] != "sig_ant_valid" {
			t.Fatalf("unexpected round 1 anthropic blocks: %+v", r1Content)
		}
		r1Results := msgs[2].(map[string]any)["content"].([]any)
		if len(r1Results) != 2 || r1Results[1].(map[string]any)["is_error"] != true {
			t.Fatalf("expected tool_result is_error preserved: %+v", r1Results)
		}
	}

	// 4. Google GenAI
	{
		f := NewGoogleGenAIFormat()
		nativeThink := domain.ContentBlock{
			Type:      domain.BlockTypeThinking,
			Thinking:  "gem step",
			Signature: "gem_thought_sig",
			Extra:     makeProviderExtra(FormatIDGoogleGenAI, map[string]any{"thoughtSignature": "gem_thought_sig"}),
		}
		callExtra := makeProviderExtra(FormatIDGoogleGenAI, map[string]any{"thoughtSignature": "gem_call_sig"})
		req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:    domain.ModelConfig{ID: "gemini-2.5-pro"},
			Tools:    tools,
			Messages: buildHistory(nativeThink, "gem_call_sig", callExtra),
		})
		if err != nil {
			t.Fatalf("google encode: %v", err)
		}
		var body map[string]any
		_ = json.Unmarshal(req.Body, &body)
		decls := body["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)
		if len(decls) != 3 {
			t.Fatalf("expected 3 gemini functionDeclarations")
		}
		contents := body["contents"].([]any)
		if len(contents) != 7 {
			t.Fatalf("expected 7 gemini contents turns, got %d: %+v", len(contents), contents)
		}
		modelR1Parts := contents[1].(map[string]any)["parts"].([]any)
		if len(modelR1Parts) != 4 {
			t.Fatalf("expected 4 parts (signed thought, text, callA with sig, callB) skipping foreign thoughts, got %+v", modelR1Parts)
		}
		if modelR1Parts[0].(map[string]any)["thoughtSignature"] != "gem_thought_sig" {
			t.Fatalf("missing thoughtSignature on thought part: %+v", modelR1Parts[0])
		}
		if modelR1Parts[2].(map[string]any)["thoughtSignature"] != "gem_call_sig" {
			t.Fatalf("missing thoughtSignature on functionCall part: %+v", modelR1Parts[2])
		}
	}
}

func TestGoDecodersGoldenMultiToolAndSignatures(t *testing.T) {
	// 1. OpenAI Completions interleaved parallel tool calls across indices
	{
		f := NewOpenAICompletionsFormat()
		sse := strings.Join([]string{
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"toolA","arguments":"{\"a\":"}},{"index":1,"id":"c2","function":{"name":"toolB","arguments":"{\"b\":"}}]}}]}`,
			``,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}},{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}`,
			``,
			`data: [DONE]`,
			``,
		}, "\n")
		var ends []domain.ContentBlock
		if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
			if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
				ends = append(ends, *ev.Block)
			}
			return nil
		}); err != nil {
			t.Fatalf("openai completions decode failed: %v", err)
		}
		if len(ends) != 2 || ends[0].ID != "c1" || string(ends[0].Arguments) != `{"a":1}` || ends[1].ID != "c2" || string(ends[1].Arguments) != `{"b":2}` {
			t.Fatalf("unexpected interleaved openai completions blocks: %+v", ends)
		}
	}

	// 2. OpenAI Responses duplicate sequence + encrypted_content + completed output fallback
	{
		f := NewOpenAIResponsesFormat()
		sse := strings.Join([]string{
			`event: response.output_item.added`,
			`data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"rs_9","type":"reasoning"}}`,
			``,
			`event: response.reasoning_summary_text.delta`,
			`data: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"output_index":0,"delta":"step"}`,
			``,
			`event: response.reasoning_summary_text.delta`,
			`data: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"output_index":0,"delta":"step"}`,
			``,
			`event: response.output_item.done`,
			`data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"rs_9","type":"reasoning","encrypted_content":"enc_blob_9"}}`,
			``,
			`event: response.output_item.done`,
			`data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"rs_9","type":"reasoning","encrypted_content":"enc_blob_9"}}`,
			``,
			`event: response.completed`,
			`data: {"type":"response.completed","sequence_number":4,"response":{"status":"completed","output":[{"id":"rs_9","type":"reasoning","encrypted_content":"enc_blob_9"},{"id":"fc_9","type":"function_call","call_id":"call_resp_9","name":"echo","arguments":"{\"v\":9}"}]}}`,
			``,
		}, "\n")
		var ends []domain.ContentBlock
		if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
			if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
				ends = append(ends, *ev.Block)
			}
			return nil
		}); err != nil {
			t.Fatalf("openai responses decode failed: %v", err)
		}
		if len(ends) != 2 || ends[0].Thinking != "step" || ends[0].Signature != "enc_blob_9" || ends[1].ID != "call_resp_9" || string(ends[1].Arguments) != `{"v":9}` {
			t.Fatalf("unexpected responses decoded blocks: %+v", ends)
		}
	}

	// 3. Google GenAI thoughtSignature on thought & functionCall parts + duplicate call id
	{
		f := NewGoogleGenAIFormat()
		sse := strings.Join([]string{
			`data: {"candidates":[{"content":{"parts":[{"text":"hmm","thought":true},{"thought":true,"thoughtSignature":"sig_t1"}]}}]}`,
			``,
			`data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"g_1","name":"toolA","args":{"k":1}},"thoughtSignature":"sig_fc1"}]}}]}`,
			``,
			`data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"g_1","name":"toolA","args":{"k":1}},"thoughtSignature":"sig_fc1"}]},"finishReason":"STOP"}]}`,
			``,
		}, "\n")
		var ends []domain.ContentBlock
		if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
			if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
				ends = append(ends, *ev.Block)
			}
			return nil
		}); err != nil {
			t.Fatalf("gemini decode failed: %v", err)
		}
		if len(ends) != 2 || ends[0].Signature != "sig_t1" || ends[1].Signature != "sig_fc1" || ends[1].ID != "g_1" {
			t.Fatalf("unexpected gemini signature blocks: %+v", ends)
		}
	}
}

func encodeToolHistoryBody(t *testing.T, format plugin.APIFormat, messages []domain.Message) string {
	t.Helper()
	req, err := format.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:    domain.ModelConfig{ID: "m1"},
		Messages: messages,
	})
	if err != nil {
		t.Fatalf("%s encode: %v", format.ID(), err)
	}
	return string(req.Body)
}

func TestNormalizeMessagesForEncodingPairsStandaloneToolResults(t *testing.T) {
	messages := []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}},
		{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeToolCall, ID: "c1", Name: "lookup", Arguments: json.RawMessage(`{"q":"x"}`)},
		}},
		{Role: domain.RoleToolResult, Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeToolResult, ToolCallID: "c1", ToolName: "lookup", Content: "done"},
		}},
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "continue"}}},
	}
	formats := []plugin.APIFormat{
		NewOpenAICompletionsFormat(),
		NewOpenAIResponsesFormat(),
		NewAnthropicMessagesFormat(),
		NewGoogleGenAIFormat(),
	}
	for _, format := range formats {
		body := encodeToolHistoryBody(t, format, messages)
		if strings.Contains(body, interruptedToolResultContent) {
			t.Fatalf("%s synthesized an extra result: %s", format.ID(), body)
		}
		if got := strings.Count(body, `"c1"`); got != 2 {
			t.Fatalf("%s expected exactly one call and one result for c1, got %d: %s", format.ID(), got, body)
		}
	}
}

func TestNormalizeMessagesForEncodingSkipsEmptyBlocksInsideToolPairs(t *testing.T) {
	messages := []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}},
		{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeToolCall, ID: "c1", Name: "lookup", Arguments: json.RawMessage(`{}`)},
			{Type: domain.BlockTypeText, Text: "   "},
			{Type: domain.BlockTypeThinking, Thinking: "", Signature: ""},
			{Type: domain.BlockTypeToolResult, ToolCallID: "c1", ToolName: "lookup", Content: "done"},
		}},
	}
	normalized := normalizeMessagesForEncoding(messages)
	if len(normalized) != 2 {
		t.Fatalf("expected user and assistant messages, got %+v", normalized)
	}
	blocks := normalized[1].Blocks
	if len(blocks) != 2 || blocks[0].Type != domain.BlockTypeToolCall || blocks[1].Type != domain.BlockTypeToolResult || blocks[1].Content != "done" {
		t.Fatalf("expected paired call/result without synthetic interruption, got %+v", blocks)
	}
}

func TestNormalizeMessagesForEncodingDeduplicatesAcrossMessages(t *testing.T) {
	toolRound := func() domain.Message {
		return domain.Message{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeToolCall, ID: "c1", Name: "lookup", Arguments: json.RawMessage(`{}`)},
			{Type: domain.BlockTypeToolResult, ToolCallID: "c1", ToolName: "lookup", Content: "done"},
		}}
	}
	messages := []domain.Message{
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "one"}}},
		toolRound(),
		toolRound(),
		{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "two"}}},
	}
	formats := []plugin.APIFormat{
		NewOpenAICompletionsFormat(),
		NewOpenAIResponsesFormat(),
		NewAnthropicMessagesFormat(),
		NewGoogleGenAIFormat(),
	}
	for _, format := range formats {
		body := encodeToolHistoryBody(t, format, messages)
		if got := strings.Count(body, `"c1"`); got != 2 {
			t.Fatalf("%s duplicated call id c1, got %d: %s", format.ID(), got, body)
		}
		if !strings.Contains(body, "call_norm_") {
			t.Fatalf("%s did not renormalize the repeated call id: %s", format.ID(), body)
		}
	}
}

func TestToolArgumentsAlwaysEncodeAsObjects(t *testing.T) {
	for _, raw := range []string{"", "null", "\"text\"", "[1,2]", "123", "{\"a\":"} {
		obj := toolArgsObject(json.RawMessage(raw))
		if len(obj) != 0 {
			t.Fatalf("raw %q decoded to non-empty object %+v", raw, obj)
		}
		if got := rawArgumentsObjectString(json.RawMessage(raw)); got != "{}" {
			t.Fatalf("raw %q encoded as %q, want {}", raw, got)
		}
	}
	obj := toolArgsObject(json.RawMessage(`{"a":1}`))
	if len(obj) != 1 || obj["a"] != float64(1) {
		t.Fatalf("object args lost: %+v", obj)
	}
}
