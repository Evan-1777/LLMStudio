import { describe, expect, it, vi } from 'vitest';
import { GatewayClient } from './gateway';
import {
  executeLocalModelProbe,
  parseDiscoveredModelsPayload,
} from './localModelProbe';

describe('localModelProbe (TASK-006)', () => {
  it('parses valid array, data[], and Gemini models[] while rejecting unrecognized shapes', () => {
    const arr = parseDiscoveredModelsPayload(
      JSON.stringify([{ id: 'gpt-4.1' }, { id: 'claude-3-7-sonnet' }]),
      'openai-completions',
    );
    expect(arr.map((m) => [m.id, m.apiFormat])).toEqual([
      ['gpt-4.1', 'openai-completions'],
      ['claude-3-7-sonnet', 'anthropic-messages'],
    ]);

    const gem = parseDiscoveredModelsPayload(
      JSON.stringify({
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            inputTokenLimit: 1048576,
            thinking: true,
          },
        ],
      }),
      'google-generative-ai',
    );
    expect(gem).toHaveLength(1);
    expect(gem[0]).toMatchObject({
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      apiFormat: 'google-generative-ai',
      reasoning: true,
    });

    expect(() =>
      parseDiscoveredModelsPayload(
        JSON.stringify({ tags: [{ name: 'llama3' }] }),
        'openai-completions',
      ),
    ).toThrow('无法识别的模型列表格式');
  });

  it('uses prepare-local envelope to fetch browser-direct upstream and distinguishes HTTP 502, connection error, and redirect rejection', async () => {
    const envelope = {
      method: 'GET',
      url: 'http://127.0.0.1:11434/v1/models',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer sk-local-secret',
      },
      authType: 'bearer',
      protocol: 'openai',
      defaultFormat: 'openai-completions',
    };

    // 1. Success directly from browser.
    const okFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/providers/p-local/models/prepare-local')) {
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      if (url === envelope.url) {
        expect(init?.redirect).toBe('manual');
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Bearer sk-local-secret');
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen2.5:7b' }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const okClient = new GatewayClient({
      baseUrl: 'https://gw.example',
      accessToken: 'tok',
      fetchImpl: okFetch,
    });
    const res = await executeLocalModelProbe(okClient, 'p-local');
    expect(res.models.map((m) => m.id)).toEqual(['qwen2.5:7b']);

    // 2. Upstream HTTP 502 returns safe status summary without raw HTML or secrets.
    const html502Fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models/prepare-local')) {
        return new Response(JSON.stringify(envelope), { status: 200 });
      }
      return new Response('<html>502 secret sk-local-secret</html>', {
        status: 502,
      });
    });
    const err502 = await executeLocalModelProbe(
      new GatewayClient({
        baseUrl: 'https://gw.example',
        accessToken: 'tok',
        fetchImpl: html502Fetch,
      }),
      'p-local',
    ).catch((e) => e);
    expect(err502.message).toContain('502');
    expect(err502.message).not.toContain('<html>');
    expect(err502.message).not.toContain('sk-local-secret');

    // 3. Network failure (no readable response) reports connection failure without claiming CORS.
    const netFailFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models/prepare-local')) {
        return new Response(JSON.stringify(envelope), { status: 200 });
      }
      throw new TypeError('Failed to fetch');
    });
    const errNet = await executeLocalModelProbe(
      new GatewayClient({
        baseUrl: 'https://gw.example',
        accessToken: 'tok',
        fetchImpl: netFailFetch,
      }),
      'p-local',
    ).catch((e) => e);
    expect(errNet.message).toBe('无法连接到上游服务');
    expect(errNet.message.toLowerCase()).not.toContain('cors');
    expect(errNet.message).not.toBe(err502.message);

    // 4. Cross-origin redirect is rejected without following.
    const redirFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models/prepare-local')) {
        return new Response(JSON.stringify(envelope), { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://other.example/v1/models' },
      });
    });
    await expect(
      executeLocalModelProbe(
        new GatewayClient({
          baseUrl: 'https://gw.example',
          accessToken: 'tok',
          fetchImpl: redirFetch,
        }),
        'p-local',
      ),
    ).rejects.toThrow('重定向');

    // 5. User abort propagates AbortError silently.
    const ctrl = new AbortController();
    const abortFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/models/prepare-local')) {
        return new Response(JSON.stringify(envelope), { status: 200 });
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const pending = executeLocalModelProbe(
      new GatewayClient({
        baseUrl: 'https://gw.example',
        accessToken: 'tok',
        fetchImpl: abortFetch,
      }),
      'p-local',
      ctrl.signal,
    );
    setTimeout(() => ctrl.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
