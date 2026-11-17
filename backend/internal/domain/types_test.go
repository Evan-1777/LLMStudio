package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestContentBlockRoundTrip(t *testing.T) {
	msg := Message{
		ID:             NewUUID(),
		ConversationID: NewUUID(),
		Role:           RoleAssistant,
		ProviderID:     "openai",
		ModelID:        "gpt-5",
		StopReason:     StopReasonToolUse,
		Usage: &Usage{
			InputTokens:    120,
			OutputTokens:   45,
			ThinkingTokens: 18,
			TotalTokens:    183,
		},
		CreatedAt: time.Date(2026, 11, 17, 8, 0, 0, 0, time.UTC),
		Blocks: []ContentBlock{
			{
				Type:      BlockTypeThinking,
				Thinking:  "analyzing weather query",
				Signature: "sig_abc",
			},
			{
				Type: BlockTypeText,
				Text: "Let me check that.",
			},
			{
				Type:     BlockTypeImage,
				MimeType: "image/png",
				URL:      "https://example.com/chart.png",
			},
			{
				Type:      BlockTypeToolCall,
				ID:        "call_1",
				Name:      "lookup_weather",
				Arguments: json.RawMessage(`{"city":"Beijing"}`),
			},
			{
				Type:       BlockTypeToolResult,
				ToolCallID: "call_1",
				ToolName:   "lookup_weather",
				Content:    `{"tempC":18}`,
				IsError:    false,
			},
			{
				Type:  "imageGen",
				Extra: json.RawMessage(`{"prompt":"sunset","seed":42}`),
			},
		},
	}

	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var decoded Message
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if len(decoded.Blocks) != len(msg.Blocks) {
		t.Fatalf("expected %d blocks, got %d", len(msg.Blocks), len(decoded.Blocks))
	}
	if decoded.Blocks[0].Signature != "sig_abc" || decoded.Blocks[0].Thinking != "analyzing weather query" {
		t.Fatalf("thinking block mismatch: %+v", decoded.Blocks[0])
	}
	if decoded.Blocks[2].MimeType != "image/png" || decoded.Blocks[2].URL != "https://example.com/chart.png" {
		t.Fatalf("image block mismatch: %+v", decoded.Blocks[2])
	}
	if decoded.Blocks[3].ID != "call_1" || string(decoded.Blocks[3].Arguments) != `{"city":"Beijing"}` {
		t.Fatalf("toolCall block mismatch: %+v", decoded.Blocks[3])
	}
	if decoded.Blocks[4].ToolCallID != "call_1" || decoded.Blocks[4].ToolName != "lookup_weather" {
		t.Fatalf("toolResult block mismatch: %+v", decoded.Blocks[4])
	}
	if decoded.Blocks[5].Type != "imageGen" || string(decoded.Blocks[5].Extra) != `{"prompt":"sunset","seed":42}` {
		t.Fatalf("extra block mismatch: %+v", decoded.Blocks[5])
	}
}

func TestProviderConfigRedactionAndModelConfig(t *testing.T) {
	inputJSON := `{
		"id": "custom-openai",
		"name": "Custom OpenAI",
		"adapter": "generic-http",
		"baseURL": "https://api.example.com/v1",
		"authType": "bearer",
		"apiKey": "sk-secret-1234567890",
		"enabled": true,
		"models": [
			{
				"id": "gpt-4o",
				"name": "GPT-4o",
				"apiFormat": "openai-completions",
				"contextWindow": 128000,
				"maxTokens": 16384,
				"reasoning": false,
				"inputModalities": ["text", "image"],
				"compat": {
					"maxTokensField": "max_completion_tokens",
					"supportsDeveloperRole": true,
					"supportsStreamOptions": false
				}
			}
		]
	}`

	var cfg ProviderConfig
	if err := json.Unmarshal([]byte(inputJSON), &cfg); err != nil {
		t.Fatalf("unmarshal provider failed: %v", err)
	}
	if cfg.APIKey != "sk-secret-1234567890" {
		t.Fatalf("expected APIKey to be parsed on unmarshal, got %q", cfg.APIKey)
	}
	if len(cfg.Models) != 1 || cfg.Models[0].APIFormat != "openai-completions" {
		t.Fatalf("unexpected parsed models: %+v", cfg.Models)
	}
	if !cfg.Models[0].Compat.DeveloperRoleSupported() || cfg.Models[0].Compat.StreamOptionsSupported() {
		t.Fatalf("unexpected compat booleans: %+v", cfg.Models[0].Compat)
	}

	outBytes, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal provider failed: %v", err)
	}
	outStr := string(outBytes)
	if strings.Contains(outStr, "sk-secret-1234567890") {
		t.Fatalf("plaintext API key leaked in JSON output: %s", outStr)
	}
	if !strings.Contains(outStr, `"apiKeySet":true`) || !strings.Contains(outStr, `"apiKeyMasked":"sk-s...7890"`) {
		t.Fatalf("missing masked key fields in JSON output: %s", outStr)
	}
}

func TestConversationSyncDefaultsAndStreamEventZeroIndex(t *testing.T) {
	var conv Conversation
	NewConversationDefaults(&conv)
	if conv.SyncEnabled || conv.SyncState != SyncStateLocalOnly || conv.SyncVersion != 0 || conv.LastSyncedAt != nil {
		t.Fatalf("unexpected conversation sync defaults: %+v", conv)
	}

	ev := StreamEvent{
		Type:      StreamEventBlockDelta,
		Index:     IntPtr(0),
		DeltaType: DeltaTypeText,
		Delta:     "hi",
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal StreamEvent failed: %v", err)
	}
	if !strings.Contains(string(raw), `"index":0`) {
		t.Fatalf("expected index:0 to be serialized, got %s", string(raw))
	}
}
