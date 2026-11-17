import { describe, expect, it, vi } from 'vitest';
import {
  GatewayClient,
  GatewayError,
  resolveGatewayUrl,
  validateGatewayUrl,
} from './gateway';
import { MAX_GATEWAY_BODY_BYTES } from './types';

describe('GatewayClient', () => {
  it('resolves same-origin and absolute base URLs accurately', () => {
    expect(resolveGatewayUrl('/', '/api/v1/providers')).toBe(
      '/api/v1/providers',
    );
    expect(resolveGatewayUrl('', 'healthz')).toBe('/healthz');
    expect(
      resolveGatewayUrl('https://gw.example.com/sub/', '/api/v1/assistants'),
    ).toBe('https://gw.example.com/sub/api/v1/assistants');
    expect(
      resolveGatewayUrl('https://gw.example.com/sub', '/api/v1/assistants'),
    ).toBe('https://gw.example.com/sub/api/v1/assistants');

    expect(validateGatewayUrl('/')).toBeNull();
    expect(validateGatewayUrl('https://gw.example.com')).toBeNull();
    expect(validateGatewayUrl('ftp://bad.host')).not.toBeNull();
  });

  it('sends Bearer only on protected routes, handles 204, and strips masked keys', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0', authRequired: true }),
          { status: 200 },
        );
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/v1/providers/p1') && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            provider: {
              id: 'p1',
              name: 'OpenAI',
              adapter: 'generic-http',
              baseURL: 'https://api.openai.com/v1',
              authType: 'bearer',
              apiKeyMasked: 'sk-1...89',
              apiKeySet: true,
              models: [],
              enabled: true,
              builtIn: true,
            },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const client = new GatewayClient({
      baseUrl: 'https://gw.test',
      accessToken: 'tok-secret',
      fetchImpl: fetchMock,
    });

    const health = await client.healthCheck();
    expect(health.authRequired).toBe(true);
    expect(calls[0].init?.headers).not.toHaveProperty('Authorization');

    const extraWithMasked = {
      name: 'OpenAI',
      adapter: 'generic-http',
      baseURL: 'https://api.openai.com/v1',
      authType: 'bearer',
      apiKeyMasked: 'sk-1...89',
      apiKeySet: true,
      models: [],
    };
    await client.updateProvider(
      'p1',
      extraWithMasked as unknown as Parameters<typeof client.updateProvider>[1],
    );
    const putCall = calls[1];
    expect(putCall.init?.headers).toMatchObject({
      Authorization: 'Bearer tok-secret',
      'Content-Type': 'application/json',
    });
    const sentBody = JSON.parse(String(putCall.init?.body));
    expect(sentBody).not.toHaveProperty('apiKeyMasked');
    expect(sentBody).not.toHaveProperty('apiKeySet');
    expect(sentBody).not.toHaveProperty('apiKey');

    await expect(client.deleteProvider('p1')).resolves.toBeUndefined();
    expect(calls[2].url).toBe('https://gw.test/api/v1/providers/p1');
  });

  it('parses JSON and non-JSON error responses into GatewayError and enforces 16 MiB body cap', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'UNAUTHORIZED', message: 'bad token' }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const client = new GatewayClient({
      baseUrl: '/',
      accessToken: 'tok',
      fetchImpl: fetchMock,
    });

    await expect(client.listProviders()).rejects.toMatchObject({
      name: 'GatewayError',
      code: 'UNAUTHORIZED',
      message: 'bad token',
      statusCode: 401,
    });

    await expect(client.listAssistants()).rejects.toMatchObject({
      code: 'HTTP_502',
      message: 'Bad Gateway',
      statusCode: 502,
    });

    await expect(client.listConversations()).rejects.toBeInstanceOf(
      GatewayError,
    );

    const oversized = 'a'.repeat(MAX_GATEWAY_BODY_BYTES);
    await expect(
      client.openChatStream('c1', { text: oversized }),
    ).rejects.toMatchObject({
      code: 'REQUEST_TOO_LARGE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
