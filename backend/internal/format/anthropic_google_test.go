package format

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestAnthropicMessagesEncodeAndDecode(t *testing.T) {
	f := NewAnthropicMessagesFormat()
	maxTok := 2048
	req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:        domain.ModelConfig{ID: "claude-sonnet-4-5", Reasoning: true},
		SystemPrompt: "Follow specs",
		Params: domain.GenerationParams{
			MaxTokens:       &maxTok,
			ReasoningEffort: "low",
		},
		Messages: []domain.Message{
			{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Check weather"}}},
			{
				Role: domain.RoleAssistant,
				Blocks: []domain.ContentBlock{
					{Type: domain.BlockTypeThinking, Thinking: "plan", Signature: "sig1"},
					{Type: domain.BlockTypeToolCall, ID: "tu_1", Name: "weather", Arguments: json.RawMessage(`{"city":"Shanghai"}`)},
				},
			},
			{Role: domain.RoleToolResult, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeToolResult, ToolCallID: "tu_1", Content: "22C"}}},
		},
	})
	if err != nil {
		t.Fatalf("EncodeRequest failed: %v", err)
	}
	if req.Headers.Get("anthropic-version") != "2023-06-01" {
		t.Fatalf("missing anthropic-version header: %v", req.Headers)
	}
	var encoded map[string]any
	if err := json.Unmarshal(req.Body, &encoded); err != nil {
		t.Fatalf("unmarshal anthropic body: %v", err)
	}
	if encoded["system"] != "Follow specs" {
		t.Fatalf("unexpected system prompt: %v", encoded["system"])
	}
	// Low reasoning budget is 2048, so max_tokens should be auto-raised above budget.
	if encoded["max_tokens"].(float64) <= 2048 {
		t.Fatalf("expected max_tokens > thinking budget, got %v", encoded["max_tokens"])
	}

	sse := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":0}}}`,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"deep thought"}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xyz"}}`,
		``,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":0}`,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Sunny"}}`,
		``,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":1}`,
		``,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_forecast"}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"days\":3}"}}`,
		``,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":2}`,
		``,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":32}}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
	}, "\n")

	var events []domain.StreamEvent
	if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("DecodeStream failed: %v", err)
	}

	var gotThink, gotText, gotTool, gotDelta bool
	for _, ev := range events {
		if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
			switch ev.Block.Type {
			case domain.BlockTypeThinking:
				gotThink = ev.Block.Thinking == "deep thought" && ev.Block.Signature == "sig_xyz"
			case domain.BlockTypeText:
				gotText = ev.Block.Text == "Sunny"
			case domain.BlockTypeToolCall:
				gotTool = ev.Block.ID == "toolu_1" && ev.Block.Name == "get_forecast" && string(ev.Block.Arguments) == `{"days":3}`
			}
		}
		if ev.Type == domain.StreamEventMessageDelta && ev.StopReason == domain.StopReasonToolUse && ev.Usage != nil && ev.Usage.TotalTokens == 82 {
			gotDelta = true
		}
	}
	if !gotThink || !gotText || !gotTool || !gotDelta {
		t.Fatalf("missing expected anthropic stream outputs: %+v", events)
	}
}

func TestGoogleGenAIEncodeAndDecode(t *testing.T) {
	f := NewGoogleGenAIFormat()
	temp := 0.5
	maxTok := 1024
	req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:        domain.ModelConfig{ID: "gemini-2.5-flash", Reasoning: true},
		SystemPrompt: "Concise",
		Params: domain.GenerationParams{
			Temperature:     &temp,
			MaxTokens:       &maxTok,
			ReasoningEffort: "medium",
		},
		Messages: []domain.Message{
			{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Compute"}}},
			{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeToolCall, ID: "c1", Name: "calc", Arguments: json.RawMessage(`{"a":1}`)}}},
			{Role: domain.RoleToolResult, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeToolResult, ToolCallID: "c1", ToolName: "calc", Content: "2"}}},
		},
	})
	if err != nil {
		t.Fatalf("EncodeRequest failed: %v", err)
	}
	if req.DefaultPath != "/v1beta/models/{model}:streamGenerateContent" || req.Query.Get("alt") != "sse" {
		t.Fatalf("unexpected path/query: path=%q query=%v", req.DefaultPath, req.Query)
	}
	var encoded map[string]any
	if err := json.Unmarshal(req.Body, &encoded); err != nil {
		t.Fatalf("unmarshal gemini body: %v", err)
	}
	genCfg := encoded["generationConfig"].(map[string]any)
	if genCfg["maxOutputTokens"] != float64(1024) || genCfg["thinkingConfig"] == nil {
		t.Fatalf("unexpected gemini generationConfig: %+v", genCfg)
	}

	sse := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"analyzing...","thought":true}]}}]}`,
		``,
		`data: {"candidates":[{"content":{"parts":[{"text":"Result is 2."}]}}]}`,
		``,
		`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"log_result","args":{"val":2}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"thoughtsTokenCount":6,"totalTokenCount":26}}`,
		``,
	}, "\n")

	var events []domain.StreamEvent
	if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("DecodeStream failed: %v", err)
	}

	var gotThink, gotText, gotTool, gotDelta bool
	for _, ev := range events {
		if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
			switch ev.Block.Type {
			case domain.BlockTypeThinking:
				gotThink = ev.Block.Thinking == "analyzing..."
			case domain.BlockTypeText:
				gotText = ev.Block.Text == "Result is 2."
			case domain.BlockTypeToolCall:
				gotTool = ev.Block.Name == "log_result" && string(ev.Block.Arguments) == `{"val":2}`
			}
		}
		if ev.Type == domain.StreamEventMessageDelta && ev.StopReason == domain.StopReasonToolUse && ev.Usage != nil && ev.Usage.ThinkingTokens == 6 {
			gotDelta = true
		}
	}
	if !gotThink || !gotText || !gotTool || !gotDelta {
		t.Fatalf("missing expected gemini stream outputs: %+v", events)
	}
}

func TestAnthropicAndGoogleSixEffortLevelsWithoutReasoningFlag(t *testing.T) {
	ant := NewAnthropicMessagesFormat()
	gem := NewGoogleGenAIFormat()
	if ant.DefaultPath() != "/v1/messages" || gem.DefaultPath() != "/v1beta/models/{model}:streamGenerateContent" {
		t.Fatalf("unexpected default paths: ant=%q gem=%q", ant.DefaultPath(), gem.DefaultPath())
	}

	temp := 0.4
	// Anthropic: none -> no thinking block & temperature preserved.
	noneReq, err := ant.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:    domain.ModelConfig{ID: "claude-3-5", Reasoning: false},
		Params:   domain.GenerationParams{Temperature: &temp, ReasoningEffort: domain.EffortNone},
		Messages: []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}}},
	})
	if err != nil {
		t.Fatalf("anthropic none encode: %v", err)
	}
	var noneBody map[string]any
	_ = json.Unmarshal(noneReq.Body, &noneBody)
	if noneBody["thinking"] != nil || noneBody["temperature"] != temp {
		t.Fatalf("anthropic none should omit thinking and keep temperature: %+v", noneBody)
	}

	antBudgets := map[string]float64{
		domain.EffortLow:    2048,
		domain.EffortMedium: 4096,
		domain.EffortHigh:   8192,
		domain.EffortXHigh:  16384,
		domain.EffortMax:    32768,
	}
	for effort, wantBudget := range antBudgets {
		req, err := ant.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:    domain.ModelConfig{ID: "claude-3-5", Reasoning: false},
			Params:   domain.GenerationParams{ReasoningEffort: effort},
			Messages: []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}}},
		})
		if err != nil {
			t.Fatalf("anthropic %s encode: %v", effort, err)
		}
		var b map[string]any
		_ = json.Unmarshal(req.Body, &b)
		think := b["thinking"].(map[string]any)
		if think["type"] != "enabled" || think["budget_tokens"] != wantBudget {
			t.Fatalf("anthropic %s budget mismatch: got %+v want %v", effort, think, wantBudget)
		}
		if b["max_tokens"].(float64) <= wantBudget {
			t.Fatalf("anthropic %s max_tokens should exceed budget: %+v", effort, b)
		}
	}

	// Google: none -> thinkingBudget: 0; low..max -> budget; thinkingLevel override -> thinkingLevel uppercase.
	gemNoneReq, err := gem.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:    domain.ModelConfig{ID: "gemini-2.5", Reasoning: false},
		Params:   domain.GenerationParams{ReasoningEffort: domain.EffortNone},
		Messages: []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}}},
	})
	if err != nil {
		t.Fatalf("gemini none encode: %v", err)
	}
	var gemNoneBody map[string]any
	_ = json.Unmarshal(gemNoneReq.Body, &gemNoneBody)
	tcNone := gemNoneBody["generationConfig"].(map[string]any)["thinkingConfig"].(map[string]any)
	if tcNone["thinkingBudget"] != float64(0) || tcNone["includeThoughts"] != nil {
		t.Fatalf("unexpected gemini none thinkingConfig: %+v", tcNone)
	}

	gemBudgets := map[string]float64{
		domain.EffortLow:    1024,
		domain.EffortMedium: 4096,
		domain.EffortHigh:   8192,
		domain.EffortXHigh:  16384,
		domain.EffortMax:    24576,
	}
	for effort, wantBudget := range gemBudgets {
		req, err := gem.EncodeRequest(context.Background(), plugin.ChatInput{
			Model:    domain.ModelConfig{ID: "gemini-2.5", Reasoning: false},
			Params:   domain.GenerationParams{ReasoningEffort: effort},
			Messages: []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}}},
		})
		if err != nil {
			t.Fatalf("gemini %s encode: %v", effort, err)
		}
		var b map[string]any
		_ = json.Unmarshal(req.Body, &b)
		tc := b["generationConfig"].(map[string]any)["thinkingConfig"].(map[string]any)
		if tc["includeThoughts"] != true || tc["thinkingBudget"] != wantBudget {
			t.Fatalf("gemini %s budget mismatch: %+v", effort, tc)
		}
	}

	lvlReq, err := gem.EncodeRequest(context.Background(), plugin.ChatInput{
		Model: domain.ModelConfig{
			ID:        "gemini-3",
			Reasoning: false,
		},
		Compat:   domain.CompatConfig{ReasoningEffortField: "thinkingLevel"},
		Params:   domain.GenerationParams{ReasoningEffort: domain.EffortXHigh},
		Messages: []domain.Message{{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "hi"}}}},
	})
	if err != nil {
		t.Fatalf("gemini thinkingLevel encode: %v", err)
	}
	var lvlBody map[string]any
	_ = json.Unmarshal(lvlReq.Body, &lvlBody)
	tcLvl := lvlBody["generationConfig"].(map[string]any)["thinkingConfig"].(map[string]any)
	if tcLvl["includeThoughts"] != true || tcLvl["thinkingLevel"] != "XHIGH" {
		t.Fatalf("gemini thinkingLevel mismatch: %+v", tcLvl)
	}
}

func TestGoogleGenAIMergesConsecutiveUserMessages(t *testing.T) {
	gem := NewGoogleGenAIFormat()
	req, err := gem.EncodeRequest(context.Background(), plugin.ChatInput{
		Model: domain.ModelConfig{ID: "gemini-2.5"},
		Messages: []domain.Message{
			{
				Role:   domain.RoleUser,
				Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Checkpoint background"}},
			},
			{
				Role:   domain.RoleUser,
				Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Follow-up prompt"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}
	var body struct {
		Contents []struct {
			Role  string `json:"role"`
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"contents"`
	}
	if err := json.Unmarshal(req.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body.Contents) != 1 {
		t.Fatalf("expected consecutive user messages to merge into 1 content entry, got %d: %+v", len(body.Contents), body.Contents)
	}
	if body.Contents[0].Role != "user" || len(body.Contents[0].Parts) != 2 ||
		body.Contents[0].Parts[0].Text != "Checkpoint background" ||
		body.Contents[0].Parts[1].Text != "Follow-up prompt" {
		t.Fatalf("unexpected merged user parts: %+v", body.Contents[0])
	}
}
