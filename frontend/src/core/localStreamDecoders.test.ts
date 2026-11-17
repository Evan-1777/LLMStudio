import { describe, expect, it } from 'vitest';
import {
  applyLocalAuth,
  fetchLocalProviderModels,
  resolveLocalProbeEndpoint,
} from './localProvider';
import {
  getLocalProviderKey,
  removeLocalProviderKey,
  setLocalProviderKey,
} from './localProviderKeys';
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

describe('localProviderKeys & localProvider', () => {
  it('stores, reads, and removes local provider API keys', () => {
    const store = window.localStorage;
    store.clear();
    expect(getLocalProviderKey('p1', store)).toBe('');
    expect(setLocalProviderKey('p1', '  sk-local-123  ', store)).toBe(true);
    expect(getLocalProviderKey('p1', store)).toBe('sk-local-123');
    expect(removeLocalProviderKey('p1', store)).toBe(true);
    expect(getLocalProviderKey('p1', store)).toBe('');
  });

  it('applies all 5 auth modes, deduplicates /v1, and rejects missing keys', () => {
    const bearer = applyLocalAuth(
      'http://127.0.0.1:11434/v1/chat/completions',
      { 'Content-Type': 'application/json' },
      'bearer',
      'sk-1',
    );
    expect(bearer.headers.Authorization).toBe('Bearer sk-1');

    const xApiKey = applyLocalAuth(
      'https://api.anthropic.com/v1/messages',
      {},
      'x-api-key',
      'ant-key',
    );
    expect(xApiKey.headers['x-api-key']).toBe('ant-key');

    const queryKey = applyLocalAuth(
      'https://generativelanguage.googleapis.com/v1beta/models/g:streamGenerateContent?alt=sse',
      {},
      'query-key',
      'gem-key',
    );
    expect(queryKey.url).toContain('key=gem-key');
    expect(queryKey.url).toContain('alt=sse');

    const headerTemplate = applyLocalAuth(
      'https://custom.local/chat',
      { Authorization: 'Token {{apiKey}}' },
      'header-key',
      'custom-secret',
    );
    expect(headerTemplate.headers.Authorization).toBe('Token custom-secret');

    const headerMeta = applyLocalAuth(
      'https://custom.local/chat',
      {},
      'header-key',
      'meta-secret',
      { 'x-auth-header': 'X-My-Token' },
    );
    expect(headerMeta.headers['X-My-Token']).toBe('meta-secret');

    const noneAuth = applyLocalAuth(
      'http://127.0.0.1:11434/v1/chat/completions',
      {},
      'none',
      '',
    );
    expect(noneAuth.headers.Authorization).toBeUndefined();

    expect(() =>
      applyLocalAuth('http://127.0.0.1:11434/v1/chat/completions', {}, 'bearer', ''),
    ).toThrow(/本地 API Key/);

    const probe = resolveLocalProbeEndpoint({
      baseURL: 'http://127.0.0.1:11434/v1',
      authType: 'none',
    });
    expect(probe.url).toBe('http://127.0.0.1:11434/v1/models');
  });

  it('parses OpenAI, Anthropic, and Gemini model listings directly', async () => {
    const oai = await fetchLocalProviderModels({
      baseURL: 'http://127.0.0.1:11434/v1',
      authType: 'none',
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }] }), {
          status: 200,
        }),
    });
    expect(oai[0].id).toBe('qwen2.5:7b');

    const gem = await fetchLocalProviderModels({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      authType: 'query-key',
      apiKey: 'gk',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                inputTokenLimit: 1000000,
                outputTokenLimit: 8192,
                thinking: true,
              },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(gem[0]).toMatchObject({
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      apiFormat: 'google-generative-ai',
      reasoning: true,
    });
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
});
