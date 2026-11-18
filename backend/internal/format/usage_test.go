package format

import (
	"context"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func decodeUsageEvent(t *testing.T, f plugin.APIFormat, sse string) *domain.Usage {
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

func TestCacheUsageCompatibleFieldsAndSplitFrames(t *testing.T) {
	// 1. DeepSeek-compatible endpoints may omit prompt_tokens and report the split
	// at the top level; a miss is uncached input, never a cache write.
	deepseek := decodeUsageEvent(t, NewOpenAICompletionsFormat(), strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
		"",
		`data: {"choices":[],"usage":{"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":100,"completion_tokens":20}}`,
		"",
		`data: [DONE]`,
		"",
	}, "\n"))
	if deepseek == nil || deepseek.InputTokens != 1000 || deepseek.CacheReadInputTokens != 900 || deepseek.CacheCreationInputTokens != 0 || deepseek.OutputTokens != 20 || deepseek.TotalTokens != 1020 {
		t.Fatalf("unexpected deepseek-compatible usage: %+v", deepseek)
	}

	// 2. A reported prompt_tokens_details block wins; candidate fields are never summed.
	both := decodeUsageEvent(t, NewOpenAICompletionsFormat(), strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
		"",
		`data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"total_tokens":1020,"prompt_cache_hit_tokens":950,"prompt_tokens_details":{"cached_tokens":800}}}`,
		"",
		`data: [DONE]`,
		"",
	}, "\n"))
	if both == nil || both.CacheReadInputTokens != 800 {
		t.Fatalf("reported detail must not be double counted: %+v", both)
	}

	// 3. A later Anthropic frame that only carries the cached read keeps the
	// uncached input and creation counts from the first frame.
	split := decodeUsageEvent(t, NewAnthropicMessagesFormat(), strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":200,"cache_read_input_tokens":750,"output_tokens":0}}}`,
		"",
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"cache_read_input_tokens":800}}`,
		"",
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		"",
	}, "\n"))
	if split == nil || split.InputTokens != 1050 || split.CacheReadInputTokens != 800 || split.CacheCreationInputTokens != 200 {
		t.Fatalf("split anthropic frames must merge into the input total: %+v", split)
	}

	// 4. An explicit zero replaces the cached read instead of keeping a stale value.
	explicitZero := decodeUsageEvent(t, NewAnthropicMessagesFormat(), strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":200,"cache_read_input_tokens":750,"output_tokens":0}}}`,
		"",
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"cache_read_input_tokens":0,"output_tokens":40}}`,
		"",
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		"",
	}, "\n"))
	if explicitZero == nil || explicitZero.InputTokens != 250 || explicitZero.CacheReadInputTokens != 0 || explicitZero.CacheCreationInputTokens != 200 || explicitZero.OutputTokens != 40 {
		t.Fatalf("explicit zero must be preserved: %+v", explicitZero)
	}
}
