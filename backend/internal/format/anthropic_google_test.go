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
