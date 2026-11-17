package format

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestScanSSE(t *testing.T) {
	raw := ": keepalive\r\n" +
		"event: custom\r\n" +
		"data: line1\r\n" +
		"data: line2\r\n\r\n" +
		"data: [DONE]\n\n"

	var frames []SSEFrame
	err := ScanSSE(context.Background(), strings.NewReader(raw), func(f SSEFrame) error {
		frames = append(frames, f)
		return nil
	})
	if err != nil {
		t.Fatalf("ScanSSE failed: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("expected 2 frames, got %d", len(frames))
	}
	if frames[0].Event != "custom" || frames[0].Data != "line1\nline2" {
		t.Fatalf("unexpected first frame: %+v", frames[0])
	}
	if frames[1].Data != "[DONE]" {
		t.Fatalf("unexpected second frame: %+v", frames[1])
	}

	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ScanSSE(canceledCtx, strings.NewReader("data: hi\n\n"), func(SSEFrame) error { return nil }); err == nil {
		t.Fatal("expected canceled context error")
	}
}

func TestOpenAICompletionsEncodeAndDecode(t *testing.T) {
	f := NewOpenAICompletionsFormat()
	temp := 0.2
	maxTok := 1024

	req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model: domain.ModelConfig{ID: "deepseek-r1"},
		SystemPrompt: "Be helpful.",
		Params: domain.GenerationParams{
			Temperature:     &temp,
			MaxTokens:       &maxTok,
			ReasoningEffort: "high",
		},
		Compat: domain.CompatConfig{
			MaxTokensField:        "max_tokens",
			SupportsDeveloperRole: domain.BoolPtr(false),
			SupportsStreamOptions: domain.BoolPtr(false),
			ExtraBody:             map[string]any{"top_p": 0.95},
		},
		Messages: []domain.Message{
			{
				Role: domain.RoleUser,
				Blocks: []domain.ContentBlock{
					{Type: domain.BlockTypeText, Text: "Look at this"},
					{Type: domain.BlockTypeImage, MimeType: "image/png", Data: "AAAA"},
				},
			},
			{
				Role: domain.RoleAssistant,
				Blocks: []domain.ContentBlock{
					{Type: domain.BlockTypeToolCall, ID: "call_1", Name: "get_time", Arguments: json.RawMessage(`{"tz":"UTC"}`)},
				},
			},
			{
				Role: domain.RoleToolResult,
				Blocks: []domain.ContentBlock{
					{Type: domain.BlockTypeToolResult, ToolCallID: "call_1", Content: "12:00Z"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("EncodeRequest failed: %v", err)
	}

	var encoded map[string]any
	if err := json.Unmarshal(req.Body, &encoded); err != nil {
		t.Fatalf("unmarshal encoded body: %v", err)
	}
	if encoded["max_tokens"] != float64(1024) || encoded["stream_options"] != nil || encoded["top_p"] != 0.95 {
		t.Fatalf("compat overrides did not apply cleanly: %+v", encoded)
	}
	msgs := encoded["messages"].([]any)
	if msgs[0].(map[string]any)["role"] != "system" {
		t.Fatalf("expected system role when SupportsDeveloperRole=false, got %+v", msgs[0])
	}
	if msgs[2].(map[string]any)["role"] != "assistant" || msgs[3].(map[string]any)["role"] != "tool" {
		t.Fatalf("expected assistant toolCall + tool message, got %+v", msgs)
	}

	sse := strings.Join([]string{
		`data: {"choices":[{"delta":{"reasoning_content":"step 1 "}}]}`,
		``,
		`data: {"choices":[{"delta":{"reasoning":"step 2"}}]}`,
		``,
		`data: {"choices":[{"delta":{"content":"Answer"}}]}`,
		``,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"calc","arguments":"{\"x\":"}}]}}]}`,
		``,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}`,
		``,
		`data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":5}}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	var events []domain.StreamEvent
	if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("DecodeStream failed: %v", err)
	}

	var gotThinking, gotText, gotToolCall bool
	var finalDelta *domain.StreamEvent
	for i := range events {
		ev := &events[i]
		if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
			switch ev.Block.Type {
			case domain.BlockTypeThinking:
				gotThinking = ev.Block.Thinking == "step 1 step 2"
			case domain.BlockTypeText:
				gotText = ev.Block.Text == "Answer"
			case domain.BlockTypeToolCall:
				gotToolCall = ev.Block.ID == "call_9" && ev.Block.Name == "calc" && string(ev.Block.Arguments) == `{"x":1}`
			}
		}
		if ev.Type == domain.StreamEventMessageDelta {
			finalDelta = ev
		}
	}
	if !gotThinking || !gotText || !gotToolCall {
		t.Fatalf("missing expected decoded blocks: events=%+v", events)
	}
	if finalDelta == nil || finalDelta.StopReason != domain.StopReasonToolUse || finalDelta.Usage == nil || finalDelta.Usage.ThinkingTokens != 5 {
		t.Fatalf("unexpected final message_delta: %+v", finalDelta)
	}
}

func TestOpenAIResponsesEncodeAndDecode(t *testing.T) {
	f := NewOpenAIResponsesFormat()
	maxTok := 2048
	req, err := f.EncodeRequest(context.Background(), plugin.ChatInput{
		Model:        domain.ModelConfig{ID: "gpt-4.1"},
		SystemPrompt: "System rule",
		Params: domain.GenerationParams{
			MaxTokens:       &maxTok,
			ReasoningEffort: "medium",
		},
		Messages: []domain.Message{
			{Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Hi"}}},
			{Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeToolCall, ID: "fc_1", Name: "ping", Arguments: json.RawMessage(`{}`)}}},
			{Role: domain.RoleToolResult, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeToolResult, ToolCallID: "fc_1", Content: "pong"}}},
		},
	})
	if err != nil {
		t.Fatalf("EncodeRequest failed: %v", err)
	}
	var encoded map[string]any
	if err := json.Unmarshal(req.Body, &encoded); err != nil {
		t.Fatalf("unmarshal responses body: %v", err)
	}
	if encoded["instructions"] != "System rule" || encoded["max_output_tokens"] != float64(2048) {
		t.Fatalf("unexpected encoded responses body: %+v", encoded)
	}
	if encoded["reasoning"].(map[string]any)["effort"] != "medium" {
		t.Fatalf("missing reasoning.effort: %+v", encoded["reasoning"])
	}

	sse := strings.Join([]string{
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning"}}`,
		``,
		`event: response.reasoning_summary_text.delta`,
		`data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking..."}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","output_index":0}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message"}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","output_index":1,"delta":"Hello world"}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","output_index":1}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_item","type":"function_call","call_id":"call_abc","name":"search"}}`,
		``,
		`event: response.function_call_arguments.delta`,
		`data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\"q\":\"go\"}"}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","output_index":2}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":15,"output_tokens":25,"total_tokens":40,"output_tokens_details":{"reasoning_tokens":7}}}}`,
		``,
	}, "\n")

	var events []domain.StreamEvent
	if err := f.DecodeStream(context.Background(), strings.NewReader(sse), func(ev domain.StreamEvent) error {
		events = append(events, ev)
		return nil
	}); err != nil {
		t.Fatalf("DecodeStream failed: %v", err)
	}

	var gotThink, gotText, gotTool, gotDone bool
	for _, ev := range events {
		if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
			switch ev.Block.Type {
			case domain.BlockTypeThinking:
				gotThink = ev.Block.Thinking == "thinking..."
			case domain.BlockTypeText:
				gotText = ev.Block.Text == "Hello world"
			case domain.BlockTypeToolCall:
				gotTool = ev.Block.ID == "call_abc" && ev.Block.Name == "search" && string(ev.Block.Arguments) == `{"q":"go"}`
			}
		}
		if ev.Type == domain.StreamEventMessageDelta && ev.StopReason == domain.StopReasonToolUse && ev.Usage != nil && ev.Usage.TotalTokens == 40 {
			gotDone = true
		}
	}
	if !gotThink || !gotText || !gotTool || !gotDone {
		t.Fatalf("missing expected responses events: %+v", events)
	}
}
