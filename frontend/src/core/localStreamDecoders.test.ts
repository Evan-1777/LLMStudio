import { describe, expect, it } from 'vitest';
import { readLegacyProviderKeys } from './localProviderKeys';
import { decodeUpstreamSseStream } from './localStreamDecoders';
import type { StreamEvent } from './types';

function sseStreamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split across arbitrary UTF-8 chunk boundaries to match streaming reads.
      const step = 17;
      for (let i = 0; i < bytes.length; i += step) {
        controller.enqueue(bytes.slice(i, i + step));
      }
      controller.close();
    },
  });
}

describe('legacy browser provider credentials', () => {
  it('reads a trimmed legacy key map and ignores malformed entries', () => {
    const store = window.localStorage;
    store.clear();
    store.setItem(
      'llmstudio.localProviderKeys.v1',
      JSON.stringify({ p1: '  sk-local-123  ', p2: 42, p3: '' }),
    );
    expect(readLegacyProviderKeys(store)).toEqual({ p1: 'sk-local-123' });

    store.setItem('llmstudio.localProviderKeys.v1', 'not-json');
    expect(readLegacyProviderKeys(store)).toEqual({});
  });
});

describe('decodeUpstreamSseStream golden parity with Go formats', () => {
  const meta = {
    conversationId: 'c1',
    messageId: 'm1',
    providerId: 'p1',
    modelId: 'model-1',
  };

  it('decodes openai-completions golden fixture identically to Go', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"step 1 "}}]}',
      '',
      'data: {"choices":[{"delta":{"reasoning":"step 2"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"calc","arguments":"{\\"x\\":"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":5}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const events: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'openai-completions',
      sseStreamFromText(sse),
      meta,
      (ev) => events.push(ev),
    );

    const ends = events.filter((e) => e.type === 'block_end');
    expect(ends).toHaveLength(3);
    expect(ends[0].block).toEqual({ type: 'thinking', thinking: 'step 1 step 2' });
    expect(ends[1].block).toEqual({ type: 'text', text: 'Answer' });
    expect(ends[2].block).toEqual({
      type: 'toolCall',
      id: 'call_9',
      name: 'calc',
      arguments: { x: 1 },
    });
    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta?.stopReason).toBe('toolUse');
    expect(delta?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      thinkingTokens: 5,
    });
  });

  it('decodes openai-responses golden fixture identically to Go', async () => {
    const sse = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning"}}',
      '',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking..."}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":1,"delta":"Hello world"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":1}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_item","type":"function_call","call_id":"call_abc","name":"search"}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\\"q\\":\\"go\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":2}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":15,"output_tokens":25,"total_tokens":40,"output_tokens_details":{"reasoning_tokens":7}}}}',
      '',
    ].join('\n');

    const events: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'openai-responses',
      sseStreamFromText(sse),
      meta,
      (ev) => events.push(ev),
    );

    const ends = events.filter((e) => e.type === 'block_end');
    expect(ends[0].block).toEqual({ type: 'thinking', thinking: 'thinking...' });
    expect(ends[1].block).toEqual({ type: 'text', text: 'Hello world' });
    expect(ends[2].block).toEqual({
      type: 'toolCall',
      id: 'call_abc',
      name: 'search',
      arguments: { q: 'go' },
    });
    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta?.stopReason).toBe('toolUse');
    expect(delta?.usage).toEqual({
      inputTokens: 15,
      outputTokens: 25,
      totalTokens: 40,
      thinkingTokens: 7,
    });
  });

  it('decodes anthropic-messages golden fixture identically to Go', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"deep thought"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xyz"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Sunny"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_forecast"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"days\\":3}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":2}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":32}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const events: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'anthropic-messages',
      sseStreamFromText(sse),
      meta,
      (ev) => events.push(ev),
    );

    const ends = events.filter((e) => e.type === 'block_end');
    expect(ends[0].block).toEqual({
      type: 'thinking',
      thinking: 'deep thought',
      signature: 'sig_xyz',
    });
    expect(ends[1].block).toEqual({ type: 'text', text: 'Sunny' });
    expect(ends[2].block).toEqual({
      type: 'toolCall',
      id: 'toolu_1',
      name: 'get_forecast',
      arguments: { days: 3 },
    });
    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta?.stopReason).toBe('toolUse');
    expect(delta?.usage).toEqual({
      inputTokens: 50,
      outputTokens: 32,
      totalTokens: 82,
    });
  });

  it('decodes google-generative-ai golden fixture identically to Go', async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"analyzing...","thought":true}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"Result is 2."}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"log_result","args":{"val":2}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"thoughtsTokenCount":6,"totalTokenCount":26}}',
      '',
    ].join('\n');

    const events: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'google-generative-ai',
      sseStreamFromText(sse),
      meta,
      (ev) => events.push(ev),
    );

    const ends = events.filter((e) => e.type === 'block_end');
    expect(ends[0].block).toEqual({ type: 'thinking', thinking: 'analyzing...' });
    expect(ends[1].block).toEqual({ type: 'text', text: 'Result is 2.' });
    expect(ends[2].block).toEqual({
      type: 'toolCall',
      id: 'call_1',
      name: 'log_result',
      arguments: { val: 2 },
    });
    const delta = events.find((e) => e.type === 'message_delta');
    expect(delta?.stopReason).toBe('toolUse');
    expect(delta?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      thinkingTokens: 6,
      totalTokens: 26,
    });
  });

  it('decodes interleaved parallel tool calls, duplicate sequence/chunks, Responses completed fallback, and Gemini signatures identically to Go', async () => {
    // 1. OpenAI Completions interleaved parallel tool calls
    const oaiSse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"toolA","arguments":"{\\"a\\":"}},{"index":1,"id":"c2","function":{"name":"toolB","arguments":"{\\"b\\":"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}},{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const oaiEvents: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'openai-completions',
      sseStreamFromText(oaiSse),
      meta,
      (ev) => oaiEvents.push(ev),
    );
    expect(
      oaiEvents.filter((e) => e.type === 'block_end').map((e) => e.block),
    ).toEqual([
      { type: 'toolCall', id: 'c1', name: 'toolA', arguments: { a: 1 } },
      { type: 'toolCall', id: 'c2', name: 'toolB', arguments: { b: 2 } },
    ]);

    // 2. OpenAI Responses duplicate sequence + encrypted_content + response.completed output fallback
    const respSse = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"rs_9","type":"reasoning"}}',
      '',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"output_index":0,"delta":"step"}',
      '',
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"output_index":0,"delta":"step"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"rs_9","type":"reasoning","encrypted_content":"enc_blob_9"}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"id":"rs_9","type":"reasoning","encrypted_content":"enc_blob_9"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","sequence_number":4,"response":{"status":"completed","output":[{"id":"rs_9","type":"reasoning","encrypted_content":"enc_blob_9"},{"id":"fc_9","type":"function_call","call_id":"call_resp_9","name":"echo","arguments":"{\\"v\\":9}"}]}}',
      '',
    ].join('\n');
    const respEvents: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'openai-responses',
      sseStreamFromText(respSse),
      meta,
      (ev) => respEvents.push(ev),
    );
    expect(
      respEvents.filter((e) => e.type === 'block_end').map((e) => e.block),
    ).toEqual([
      {
        type: 'thinking',
        thinking: 'step',
        signature: 'enc_blob_9',
        extra: {
          providerFormat: 'openai-responses',
          itemId: 'rs_9',
          encryptedContent: 'enc_blob_9',
        },
      },
      { type: 'toolCall', id: 'call_resp_9', name: 'echo', arguments: { v: 9 } },
    ]);
    expect(
      respEvents.find((e) => e.type === 'message_delta')?.stopReason,
    ).toBe('toolUse');

    // 3. Google GenAI thoughtSignature + functionCall thoughtSignature + duplicate call ID
    const gemSse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"hmm","thought":true},{"thought":true,"thoughtSignature":"sig_t1"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"g_1","name":"toolA","args":{"k":1}},"thoughtSignature":"sig_fc1"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"g_1","name":"toolA","args":{"k":1}},"thoughtSignature":"sig_fc1"}]},"finishReason":"STOP"}]}',
      '',
    ].join('\n');
    const gemEvents: StreamEvent[] = [];
    await decodeUpstreamSseStream(
      'google-generative-ai',
      sseStreamFromText(gemSse),
      meta,
      (ev) => gemEvents.push(ev),
    );
    expect(
      gemEvents.filter((e) => e.type === 'block_end').map((e) => e.block),
    ).toEqual([
      {
        type: 'thinking',
        thinking: 'hmm',
        signature: 'sig_t1',
        extra: {
          providerFormat: 'google-generative-ai',
          thoughtSignature: 'sig_t1',
        },
      },
      {
        type: 'toolCall',
        id: 'g_1',
        name: 'toolA',
        arguments: { k: 1 },
        signature: 'sig_fc1',
        extra: {
          providerFormat: 'google-generative-ai',
          thoughtSignature: 'sig_fc1',
        },
      },
    ]);
  });

  it('normalizes cache read/creation tokens across all 4 formats identically to Go without fabricating missing values', async () => {
    const collectUsage = async (apiFormat: string, sse: string) => {
      const evs: StreamEvent[] = [];
      await decodeUpstreamSseStream(apiFormat, sseStreamFromText(sse), meta, (ev) => evs.push(ev));
      return evs.find((e) => e.type === 'message_delta')?.usage;
    };

    expect(
      await collectUsage(
        'openai-completions',
        [
          'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
          '',
          'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":120}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 120,
      totalTokens: 1050,
    });

    expect(
      await collectUsage(
        'openai-responses',
        [
          'event: response.completed',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":500,"output_tokens":30,"total_tokens":530,"input_tokens_details":{"cached_tokens":400,"cache_creation_tokens":60}}}}',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      inputTokens: 500,
      outputTokens: 30,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 60,
      totalTokens: 530,
    });

    expect(
      await collectUsage(
        'anthropic-messages',
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":200,"cache_read_input_tokens":750,"output_tokens":0}}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadInputTokens: 750,
      cacheCreationInputTokens: 200,
      totalTokens: 1040,
    });

    expect(
      await collectUsage(
        'google-generative-ai',
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":900,"cachedContentTokenCount":700,"candidatesTokenCount":25,"totalTokenCount":925}}',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      inputTokens: 900,
      outputTokens: 25,
      cacheReadInputTokens: 700,
      totalTokens: 925,
    });
  });
});
