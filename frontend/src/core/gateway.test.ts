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

  it('serializes conversation groups, batch move with explicit groupId:null, and reorder omitting groupId when pinned', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });

      if (url.includes('/api/v1/conversation-groups?assistantId=coder')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                id: 'g1',
                assistantId: 'coder',
                name: 'Work',
                sortOrder: 1,
                createdAt: '2026-11-17T00:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          assistantId: 'coder',
          conversations: [],
          groups: [],
          deletedIds: ['c1'],
        }),
        { status: 200 },
      );
    });

    const client = new GatewayClient({
      baseUrl: 'https://gw.test',
      accessToken: 'tok',
      fetchImpl: fetchMock,
    });

    const groups = await client.listConversationGroups('coder');
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Work');

    await client.batchConversations({
      assistantId: 'coder',
      ids: ['c1', 'c2'],
      operation: 'move',
      groupId: null,
    });
    expect(calls[1]).toEqual({
      method: 'POST',
      url: 'https://gw.test/api/v1/conversations/batch',
      body: {
        assistantId: 'coder',
        ids: ['c1', 'c2'],
        operation: 'move',
        groupId: null,
      },
    });
    expect('groupId' in (calls[1].body as Record<string, unknown>)).toBe(true);

    await client.reorderConversations({
      assistantId: 'coder',
      ids: ['c1'],
      pinned: true,
      beforeId: 'c2',
    });
    expect(calls[2].body).toEqual({
      assistantId: 'coder',
      ids: ['c1'],
      pinned: true,
      beforeId: 'c2',
    });
    expect('groupId' in (calls[2].body as Record<string, unknown>)).toBe(false);

    await client.reorderConversations({
      assistantId: 'coder',
      ids: ['c1'],
      pinned: false,
      groupId: null,
      beforeId: null,
    });
    expect(calls[3].body).toEqual({
      assistantId: 'coder',
      ids: ['c1'],
      pinned: false,
      groupId: null,
      beforeId: null,
    });
  });

  it('whitelists localContinuation on prepareLocalChat and exposes MCP probe/execute endpoints', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/tools/execute')) {
        return new Response('event: block_start\ndata: {}\n\n', { status: 200 });
      }
      if (url.endsWith('/mcp/servers/s1/test')) {
        return new Response(
          JSON.stringify({ ok: true, serverId: 's1', toolCount: 0, latencyMs: 5, message: 'ok', tools: [] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/mcp/servers/s1/tools')) {
        return new Response(JSON.stringify({ tools: [{ name: 't1' }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ method: 'POST', url: 'https://up', headers: {}, body: {}, authType: 'bearer' }),
        { status: 200 },
      );
    });

    const client = new GatewayClient({
      baseUrl: 'https://gw.test',
      accessToken: 'tok',
      fetchImpl: fetchMock,
    });

    await client.prepareLocalChat('c1', {
      providerId: 'p1',
      modelId: 'm1',
      localContinuation: {
        userMessageId: 'u1',
        blocks: [{ type: 'toolCall', id: 'tc1', name: 't1', arguments: {} }],
      },
    });
    expect(calls[0].body).toEqual({
      providerId: 'p1',
      modelId: 'm1',
      localContinuation: {
        userMessageId: 'u1',
        blocks: [{ type: 'toolCall', id: 'tc1', name: 't1', arguments: {} }],
      },
    });

    await client.openToolExecutionStream('c1', [{ id: 'tc1', name: 't1', arguments: { x: 1 } }]);
    expect(calls[1].url).toBe('https://gw.test/api/v1/conversations/c1/tools/execute');
    expect(calls[1].body).toEqual({ calls: [{ id: 'tc1', name: 't1', arguments: { x: 1 } }] });

    const tools = await client.listMcpServerTools('s1');
    expect(tools).toEqual([{ name: 't1' }]);
    const probe = await client.testMcpServer('s1');
    expect(probe.ok).toBe(true);
    expect(probe.tools).toEqual([]);

    await client.updateProvider('p1', {
      name: 'OpenAI',
      adapter: 'generic-http',
      baseURL: 'https://api.openai.com/v1',
      authType: 'bearer',
      models: [
        { id: 'm-explicit', name: 'M Explicit', apiFormat: 'openai-completions', compat: { cacheMode: 'explicit' } },
        { id: 'm-auto', name: 'M Auto', apiFormat: 'openai-completions', compat: { cacheMode: 'auto' } },
        { id: 'm-unset', name: 'M Unset', apiFormat: 'openai-completions' },
      ],
    });
    const provSent = JSON.parse(String(calls[4].body ? JSON.stringify(calls[4].body) : '{}'));
    expect(provSent.models[0].compat.cacheMode).toBe('explicit');
    expect(provSent.models[1].compat.cacheMode).toBe('auto');
    expect(provSent.models[2].compat).toBeUndefined();

    await client.openChatStream('c1', {
      providerId: 'p1',
      modelId: 'm-explicit',
      text: 'hi',
    });
    expect(calls[5].body).toMatchObject({
      providerId: 'p1',
      modelId: 'm-explicit',
      text: 'hi',
    });

    await client.prepareLocalChat('c1', {
      providerId: 'p1',
      modelId: 'm-explicit',
      text: 'hi',
      preparedSearch: { block: null },
      cacheState: { resourceName: 'cachedContents/1', prefixCount: 0 },
      cacheResolution: {
        planKey: 'pk-1',
        status: 200,
        result: { name: 'cachedContents/1' },
      },
    });
    expect(calls[6].body).toMatchObject({
      preparedSearch: { block: null },
      cacheState: { resourceName: 'cachedContents/1', prefixCount: 0 },
      cacheResolution: {
        planKey: 'pk-1',
        status: 200,
        result: { name: 'cachedContents/1' },
      },
    });
  });

  it('serializes scheduled task endpoints and preserves scope=cloud query parameter', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const sampleTask = {
      id: 'sched_1',
      name: '晨间简报',
      prompt: '总结待办',
      enabled: true,
      hour: 8,
      minute: 30,
      weekdays: [1, 3, 5],
      timezone: 'Asia/Shanghai',
      maxRuns: 0,
      runCount: 0,
      bindMode: 'new' as const,
      assistantId: 'asst_1',
      providerId: 'prov_1',
      modelId: 'gpt-4o',
      lastStatus: '' as const,
      createdAt: '2026-11-26T00:00:00Z',
      updatedAt: '2026-11-26T00:00:00Z',
    };

    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (method === 'GET') {
        return new Response(JSON.stringify({ schedules: [sampleTask] }), { status: 200 });
      }
      if (url.includes('/run')) {
        return new Response(
          JSON.stringify({ schedule: sampleTask, conversationId: 'conv_run' }),
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ schedule: sampleTask }), {
        status: method === 'POST' ? 201 : 200,
      });
    });

    const client = new GatewayClient({
      baseUrl: 'https://gw.test',
      accessToken: 'tok',
      fetchImpl: fetchMock,
    });

    const listed = await client.listScheduledTasks('conv_1', undefined, 'cloud');
    expect(listed).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://gw.test/api/v1/schedules?conversationId=conv_1&scope=cloud',
      body: undefined,
    });

    await client.createScheduledTask(
      {
        name: '晨间简报',
        prompt: '总结待办',
        hour: 8,
        minute: 30,
        weekdays: [1, 3, 5],
        timezone: 'Asia/Shanghai',
        bindMode: 'new',
        assistantId: 'asst_1',
        providerId: 'prov_1',
        modelId: 'gpt-4o',
      },
      undefined,
      'cloud',
    );
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe('https://gw.test/api/v1/schedules?scope=cloud');
    expect(calls[1].body).toMatchObject({ name: '晨间简报', hour: 8, minute: 30 });

    await client.updateScheduledTask(
      'sched_1',
      { enabled: false, resetRunCount: true },
      undefined,
      'cloud',
    );
    expect(calls[2]).toEqual({
      method: 'PATCH',
      url: 'https://gw.test/api/v1/schedules/sched_1?scope=cloud',
      body: { enabled: false, resetRunCount: true },
    });

    const runResult = await client.runScheduledTaskNow('sched_1', undefined, 'cloud');
    expect(runResult.conversationId).toBe('conv_run');
    expect(calls[3]).toEqual({
      method: 'POST',
      url: 'https://gw.test/api/v1/schedules/sched_1/run?scope=cloud',
      body: {},
    });

    await client.deleteScheduledTask('sched_1', undefined, 'cloud');
    expect(calls[4]).toEqual({
      method: 'DELETE',
      url: 'https://gw.test/api/v1/schedules/sched_1?scope=cloud',
      body: undefined,
    });
  });
});
