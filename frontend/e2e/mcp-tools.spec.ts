import http from 'node:http';
import type { Locator } from '@playwright/test';
import {
  connectWithToken,
  E2E_TOKEN,
  expect,
  test,
} from './fixtures';

interface CapturedLLMCall {
  path: string;
  auth: string;
  toolNames: string[];
  body: Record<string, unknown>;
}

async function startE2EMcpAndLlmServer() {
  let failHttpProbe = false;
  let bumpCount = 0;
  let sseClientRes: http.ServerResponse | null = null;
  const llmCalls: CapturedLLMCall[] = [];
  let flowTurn = 0;
  const mcpCalls: string[] = [];
  let roundGate: Promise<void> | undefined;
  let releaseRound: (() => void) | undefined;
  let attemptedAlias = '';

  const cors = (res: http.ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, x-api-key, anthropic-version',
    );
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    // 1. Streamable HTTP MCP Server (/mcp-http)
    if (url.pathname === '/mcp-http') {
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (failHttpProbe) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('unauthorized probe');
        return;
      }
      const rpc = JSON.parse((await readBody(req)) || '{}') as {
        id?: unknown;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', 'e2e-mcp-http-1');
      if (rpc.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (rpc.method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
            },
          }),
        );
        return;
      }
      if (rpc.method === 'tools/list') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                {
                  name: 'bump_state',
                  description: 'Stateful bump counter',
                  inputSchema: {
                    type: 'object',
                    properties: { delta: { type: 'integer' } },
                  },
                },
                {
                  name: 'safe_note',
                  description: 'Returns text, html payload, and embedded resource',
                  inputSchema: { type: 'object' },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          }),
        );
        return;
      }
      if (rpc.method === 'tools/call') {
        const name = rpc.params?.name;
        if (name) mcpCalls.push(name);
        if (name === 'bump_state') {
          bumpCount += Number(rpc.params?.arguments?.delta ?? 1);
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                content: [{ type: 'text', text: `count=${bumpCount}` }],
                structuredContent: { count: bumpCount },
              },
            }),
          );
          return;
        }
        if (rpc.params?.arguments?.fail) {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: 'tool execution failed intentionally' }],
              },
            }),
          );
          return;
        }
        if (rpc.params?.arguments?.long) {
          const lines = Array.from(
            { length: 45 },
            (_, i) => `Tool output line ${i + 1}: long diagnostic text block.`,
          ).join('\n');
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { content: [{ type: 'text', text: lines }] },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: '<script>window.__mcpE2EXss=1</script>safe-note-text',
                },
                {
                  type: 'resource',
                  resource: {
                    uri: 'doc://guide',
                    mimeType: 'text/plain',
                    text: 'Embedded guide content',
                  },
                },
              ],
            },
          }),
        );
        return;
      }
    }

    // 2. Legacy SSE MCP Server (/mcp-sse + /mcp-post)
    if (url.pathname === '/mcp-sse' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseClientRes = res;
      res.write('event: endpoint\ndata: /mcp-post\n\n');
      req.on('close', () => {
        if (sseClientRes === res) sseClientRes = null;
      });
      return;
    }
    if (url.pathname === '/mcp-post' && req.method === 'POST') {
      const rpc = JSON.parse((await readBody(req)) || '{}') as {
        id?: unknown;
        method?: string;
      };
      if (rpc.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown = {};
      if (rpc.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} } };
      } else if (rpc.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'echo_sse',
              description: 'Legacy SSE echo',
              inputSchema: { type: 'object' },
            },
          ],
        };
      } else if (rpc.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'sse-echo-ok' }] };
      }
      sseClientRes?.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`,
      );
      res.writeHead(202);
      res.end();
      return;
    }

    // 3. Multi-round CORS Mock LLM Endpoint (/v1/chat/completions)
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<
        string,
        unknown
      >;
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const toolNames = tools.map((t) =>
        String(
          ((t as { function?: { name?: string } }).function?.name) ?? '',
        ),
      );
      llmCalls.push({
        path: url.pathname,
        auth: req.headers.authorization || '',
        toolNames,
        body,
      });

      const rawMsgs = JSON.stringify(body.messages ?? []);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
      const latestUser = messages.findLast((msg) => msg.role === 'user');
      if (JSON.stringify(latestUser ?? {}).includes('[POLICY_CHECK]')) {
        if (!messages.some((msg) => msg.role === 'tool' && String(msg.content).includes('disabled'))) {
          const noteAlias = toolNames.find((name) => name.startsWith('safe_note'));
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'disabled-attempt', function: { name: attemptedAlias, arguments: '{}' } },
            { index: 1, id: 'enabled-sibling', function: { name: noteAlias, arguments: '{}' } },
          ] } }] }) + '\n\n');
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Tool policy confirmed"},"finish_reason":"stop"}]}\n\n');
        }
        res.end('data: [DONE]\n\n');
        return;
      }

      if (JSON.stringify(latestUser ?? {}).includes('[FAILED_TOOL]')) {
        if (!messages.some((msg) => msg.role === 'tool')) {
          const safeAlias =
            toolNames.find((n) => n.startsWith('safe_note')) || toolNames[0];
          res.write(
            'data: ' +
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'tc_fail_1',
                          function: { name: safeAlias, arguments: '{"fail":true}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              }) +
              '\n\n',
          );
        } else {
          res.write(
            'data: {"choices":[{"delta":{"content":"Handled tool failure"},"finish_reason":"stop"}]}\n\n',
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }

      if (JSON.stringify(latestUser ?? {}).includes('[ROUND_LIMIT]')) {
        const alias = toolNames.find((name) => name.startsWith('bump_state'));
        const reasoning = messages[messages.length - 1]?.role === 'tool' ? 'Second attempt' : 'First attempt';
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: reasoning.replace(' ', '-'), function: { name: alias, arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }

      if (rawMsgs.includes('[LONG_TOOL]') && !rawMsgs.includes('Tool output line 1:')) {
        const safeAlias =
          toolNames.find((n) => n.startsWith('safe_note')) || toolNames[0];
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc_long',
                      function: { name: safeAlias, arguments: '{"long":true}' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (rawMsgs.includes('[LONG_TOOL]')) {
        await roundGate;
        res.write(
          'data: {"choices":[{"delta":{"content":"Long tool complete"},"finish_reason":"stop"}]}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (
        (rawMsgs.includes('[FORWARD_MULTI]') || rawMsgs.includes('[LOCAL_MULTI]')) &&
        toolNames.length >= 2
      ) {
        flowTurn += 1;
        const bumpAlias = toolNames.find((n) => n.startsWith('bump_state'))!;
        const noteAlias = toolNames.find((n) => n.startsWith('safe_note'))!;
        attemptedAlias = bumpAlias;
        if (flowTurn % 3 === 1) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tc_r1_bump',
                        function: { name: bumpAlias, arguments: '{"delta":1}' },
                      },
                      {
                        index: 1,
                        id: 'tc_r1_note',
                        function: { name: noteAlias, arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n',
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (flowTurn % 3 === 2) {
          await roundGate;
          res.write('data: {"choices":[{"delta":{"content":"Checking the next step."}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"reasoning_content":"Second round reasoning"}}]}\n\n');
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tc_r2_bump',
                        function: { name: bumpAlias, arguments: '{"delta":1}' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26}}\n\n',
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: `MCP Final Reply (count=${bumpCount})` },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.write(
        'data: {"choices":[{"delta":{"content":"Followup plain reply"},"finish_reason":"stop"}]}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('bad mock server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    llmCalls,
    mcpCalls,
    holdRound() { roundGate = new Promise<void>((resolve) => { releaseRound = resolve; }); },
    releaseRound() { releaseRound?.(); roundGate = undefined; },
    setFailProbe(v: boolean) {
      failHttpProbe = v;
    },
    resetTurns() {
      bumpCount = 0;
      flowTurn = 0;
      llmCalls.length = 0;
    },
    async close() {
      releaseRound?.();
      sseClientRes?.end();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function apiPost(appUrl: string, path: string, body: unknown) {
  const res = await fetch(`${appUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${E2E_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function badgeContrast(badge: Locator) {
  return badge.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const layers: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      layers.unshift(getComputedStyle(node).backgroundColor);
    }
    for (const layer of layers) {
      ctx.fillStyle = layer;
      ctx.fillRect(0, 0, 1, 1);
    }
    const luminance = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3), (byte) => {
      const value = byte / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const background = luminance();
    ctx.fillStyle = getComputedStyle(element).color;
    ctx.fillRect(0, 0, 1, 1);
    const foreground = luminance();
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

test.describe('MCP End-to-End Integration', () => {
  test('composer MCP policy reaches forward, browser-direct and retry requests', async ({ page, appUrl }) => {
    const mock = await startE2EMcpAndLlmServer();
    try {
      await apiPost(appUrl, '/api/v1/mcp/servers', {
        name: 'mcp-http', transport: 'streamable-http', endpoint: mock.baseUrl + '/mcp-http', enabled: true,
      });
      for (const localRequest of [false, true]) {
        const id = localRequest ? 'composer-direct' : 'composer-forward';
        await apiPost(appUrl, '/api/v1/providers', {
          id, name: id, adapter: 'generic-http', baseURL: mock.baseUrl, authType: 'bearer', apiKey: 'key',
          localRequest, enabled: true, models: [{ id, name: id, apiFormat: 'openai-completions' }],
        });
      }
      await connectWithToken(page, appUrl);
      await expect(page.getByRole('button', { name: '选择搜索引擎' })).toHaveCount(0);
      for (const [model, route] of [['composer-forward', 'stream'], ['composer-direct', 'prepare-local']]) {
        await page.getByRole('button', { name: '新建话题' }).click();
        await page.getByRole('button', { name: '选择模型' }).click();
        await page.getByRole('option', { name: model }).click();
        const off = page.getByRole('button', { name: '关闭 MCP 工具' });
        const on = page.getByRole('button', { name: '开启 MCP 工具' });
        if (await on.isVisible()) await on.click();
        await expect(off).toHaveAttribute('aria-pressed', 'true');
        const waitRequest = () => page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/messages/' + route));
        const send = async (label: string) => {
          const expected = mock.llmCalls.length + 1;
          const request = waitRequest();
          await page.getByLabel('消息输入框').fill(label);
          await page.getByRole('button', { name: '发送消息' }).click();
          const body = (await request).postDataJSON() as { mcpToolsEnabled?: boolean };
          await expect.poll(() => mock.llmCalls.length).toBe(expected);
          await expect(page.getByRole('button', { name: '对话缩略图' })).toBeEnabled();
          return { body, tools: mock.llmCalls.at(-1)?.toolNames ?? [] };
        };
        const enabled = await send('MCP enabled');
        expect(enabled.body.mcpToolsEnabled).toBe(true);
        expect(enabled.tools.some((name) => name.startsWith('safe_note'))).toBe(true);
        await off.click();
        await expect(on).toHaveAttribute('aria-pressed', 'false');
        const disabled = await send('MCP disabled');
        expect(disabled.body.mcpToolsEnabled).toBe(false);
        expect(disabled.tools).toEqual([]);
        const expected = mock.llmCalls.length + 1;
        const retry = waitRequest();
        const lastReply = page.locator('.wb-asst-msg, .wb-feed-msg--asst').last();
        await lastReply.hover();
        await lastReply.getByRole('button', { name: '重试消息' }).click();
        await page.getByRole('dialog').getByRole('button', { name: '重新生成', exact: true }).click();
        expect((await retry).postDataJSON()).toMatchObject({ mcpToolsEnabled: false, regenerateMessageId: expect.any(String) });
        await expect.poll(() => mock.llmCalls.length).toBe(expected);
        expect(mock.llmCalls.at(-1)?.toolNames).toEqual([]);
        await expect(page.getByRole('button', { name: '对话缩略图' })).toBeEnabled();
      }
    } finally {
      await mock.close();
    }
  });

  test('probes MCP catalog, executes forward & localRequest multi-round traces safely, respects disable and mobile scroll', async ({
    page,
    appUrl,
  }) => {
    const mockSrv = await startE2EMcpAndLlmServer();
    try {
      // Seed MCP servers (streamable-http + sse) and forward provider pointing to our mock server.
      await apiPost(appUrl, '/api/v1/mcp/servers', {
        name: 'mcp-http',
        transport: 'streamable-http',
        endpoint: `${mockSrv.baseUrl}/mcp-http`,
        enabled: true,
      });
      await apiPost(appUrl, '/api/v1/mcp/servers', {
        name: 'mcp-sse',
        transport: 'sse',
        endpoint: `${mockSrv.baseUrl}/mcp-sse`,
        enabled: true,
      });
      await apiPost(appUrl, '/api/v1/providers', {
        id: 'mcp-fwd-prov',
        name: 'MCP Forward',
        adapter: 'generic-http',
        baseURL: mockSrv.baseUrl,
        authType: 'bearer',
        apiKey: 'sk-forward-secret',
        enabled: true,
        models: [
          { id: 'fwd-chat', name: 'Fwd Chat', apiFormat: 'openai-completions' },
        ],
      });

      await connectWithToken(page, appUrl);

      // 1. Settings -> MCP probe (success vs real 401 failure)
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: 'MCP 配置' }).click();
      await expect(page.getByText('mcp-http', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: '拉取工具 mcp-http' }).click();
      const connected = page.getByText(/已连通 · 2 个工具/);
      await expect(connected).toBeVisible();
      for (const colorScheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme });
        await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
        expect(await badgeContrast(connected)).toBeGreaterThanOrEqual(4.5);
      }
      await expect(page.getByText('bump_state', { exact: true })).toBeVisible();
      await expect(page.getByText('safe_note', { exact: true })).toBeVisible();
      const noteDetails = page.locator('summary').filter({ hasText: /^safe_note$/ });
      await expect(noteDetails.locator('..')).not.toHaveAttribute('open', '');
      await noteDetails.focus();
      await noteDetails.press('Enter');
      await expect(page.getByText('只读', { exact: true })).toBeVisible();

      mockSrv.setFailProbe(true);
      await page.getByRole('button', { name: '拉取工具 mcp-http' }).click();
      await expect(page.getByText('拉取失败', { exact: true })).toBeVisible();
      await expect(page.getByText(/401/)).toBeVisible();
      mockSrv.setFailProbe(false);

      // 2. Forward multi-round execution (2 calls R1 -> 1 call R2 -> final text R3), single collapsed summary, manual reopen & XSS immunity
      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Fwd Chat' }).click();
      mockSrv.holdRound();
      await page.getByLabel('消息输入框').fill('[FORWARD_MULTI]');
      await page.getByLabel('发送消息').click();

      const trace1 = page.getByRole('button', { name: /工具调用 · 第 1 轮/ });
      const trace2 = page.getByRole('button', { name: /工具调用 · 第 2 轮/ });
      await expect(trace1).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
      await expect(page.getByText('MCP Final Reply (count=2)', { exact: true })).toHaveCount(0);
      await trace1.click();
      mockSrv.releaseRound();
      await expect(page.getByText('MCP Final Reply (count=2)', { exact: true })).toBeVisible();
      const timeline = page.getByRole('button', { name: /思考与工具 · 2 轮.*完成/ });
      await expect(timeline).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByText('Checking the next step.')).toBeHidden();
      await timeline.click();
      await expect(page.getByText('Checking the next step.')).toBeVisible();
      await expect(trace1).toHaveAttribute('aria-expanded', 'true');
      await expect(trace2).toHaveAttribute('aria-expanded', 'false');
      const toolDetails = page.locator('.tool-trace-entry > summary');
      await expect(toolDetails).toHaveCount(2);
      const successBadge = page.locator('.tool-trace-entry__status--success').first();
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await badgeContrast(successBadge)).toBeGreaterThanOrEqual(4.5);
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await badgeContrast(successBadge)).toBeGreaterThanOrEqual(4.5);
      for (const tool of await toolDetails.all()) await tool.click();
      await expect(page.getByText('count=1', { exact: true })).toBeVisible();
      await expect(page.getByText(/doc:\/\/guide/)).toBeVisible();
      await expect(
        page.getByText('<script>window.__mcpE2EXss=1</script>safe-note-text', {
          exact: true,
        }),
      ).toBeVisible();
      const xssVal = await page.evaluate(
        () => (window as unknown as { __mcpE2EXss?: unknown }).__mcpE2EXss,
      );
      expect(xssVal).toBeUndefined();

      // Reload persists single assistant message with 60 in / 20 out (summed 3 rounds) cleanly.
      await page.reload({ waitUntil: 'networkidle' });
      await expect(
        page.getByText('MCP Final Reply (count=2)', { exact: true }),
      ).toBeVisible();
      await expect(timeline).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: 'Token 用量' }).hover();
      await expect(page.getByRole('dialog', { name: 'Token 用量明细' })).toContainText('80');
      await page.keyboard.press('Escape');

      // 3. Disable mcp-sse server -> next model call no longer sees echo_sse tool.
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: 'MCP 配置' }).click();
      await page.getByRole('switch', { name: '启用 mcp-sse' }).click();
      await expect(page.getByRole('switch', { name: '启用 mcp-sse' })).not.toBeChecked();

      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole('button', { name: '拉取工具 mcp-http' }).click();
      const bumpSwitch = page.getByRole('switch', { name: '启用 bump_state（mcp-http）' });
      await expect(bumpSwitch).toBeChecked();
      await bumpSwitch.focus();
      await bumpSwitch.press('Space');
      await expect(bumpSwitch).not.toBeChecked();
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '拉取工具 mcp-http' }).click();
      await expect(bumpSwitch).toBeVisible();
      await expect(bumpSwitch).not.toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

      const checkToolPolicy = async () => {
        const firstRequest = mockSrv.llmCalls.length;
        const firstToolCall = mockSrv.mcpCalls.length;
        await page.getByLabel('消息输入框').fill('[POLICY_CHECK]');
        await page.getByLabel('发送消息').click();
        await expect(page.getByText('Tool policy confirmed')).toBeVisible();
        const requests = mockSrv.llmCalls.slice(firstRequest);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.toolNames).toHaveLength(1);
          expect(request.toolNames[0]).toMatch(/^safe_note/);
        }
        expect(mockSrv.mcpCalls.slice(firstToolCall)).toEqual(['safe_note']);
      };

      // Turn off auto-collapse in settings, then check narrow-screen scrolling.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole('button', { name: '外观与显示' }).click();
      const toolCollapseSwitch = page.getByRole('switch', {
        name: '工具执行完成后自动折叠',
      });
      const collapsePrefsPatch = page.waitForResponse(
        (res) =>
          res.url().endsWith('/api/v1/settings') &&
          res.request().method() === 'PATCH',
      );
      await toolCollapseSwitch.click();
      await collapsePrefsPatch;
      await expect(toolCollapseSwitch).not.toBeChecked();

      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      await checkToolPolicy();
      mockSrv.holdRound();
      await page.getByLabel('消息输入框').fill('[LONG_TOOL]');
      await page.getByLabel('发送消息').click();
      const longRound = page.getByRole('button', { name: '工具调用 · 第 1 轮 · 1 次 · 完成' }).last();
      await expect(longRound).toHaveAttribute('aria-expanded', 'true');
      mockSrv.releaseRound();
      const longReply = page.locator('article').filter({ hasText: 'Long tool complete' });
      await expect(longReply).toBeVisible();
      await expect(longReply.getByRole('button', { name: /工具调用/ })).toHaveAttribute('aria-expanded', 'true');

      const traceBody = longReply.locator('.tool-trace-body');
      await traceBody.locator('summary').click();
      const scrollMetrics = await traceBody.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowX:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      }));
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(
        scrollMetrics.clientHeight,
      );
      expect(scrollMetrics.clientHeight).toBeLessThanOrEqual(270);
      expect(scrollMetrics.overflowX).toBe(false);

      // Verify disabled echo_sse tool absent on the latest LLM request.
      const lastTools =
        mockSrv.llmCalls[mockSrv.llmCalls.length - 1]?.toolNames ?? [];
      expect(lastTools.some((t) => t.startsWith('echo_sse'))).toBe(false);

      // 4. True-Go localRequest=true browser-direct multi-round MCP flow.
      await page.setViewportSize({ width: 1280, height: 800 });
      await apiPost(appUrl, '/api/v1/providers', {
        id: 'mcp-local-prov',
        name: 'MCP Local Direct',
        adapter: 'generic-http',
        baseURL: mockSrv.baseUrl,
        authType: 'bearer',
        // The gateway owns direct-request credentials; the browser receives a
        // per-request envelope instead of reading a local key.
        apiKey: 'sk-gateway-local-key',
        localRequest: true,
        enabled: true,
        models: [
          {
            id: 'local-chat',
            name: 'Local Chat',
            apiFormat: 'openai-completions',
          },
        ],
      });
      await page.reload({ waitUntil: 'networkidle' });

      mockSrv.resetTurns();
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Local Chat' }).click();
      await checkToolPolicy();

      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: 'MCP 配置' }).click();
      await page.getByRole('button', { name: '拉取工具 mcp-http' }).click();
      await expect(bumpSwitch).toBeVisible();
      await bumpSwitch.click();
      await expect(bumpSwitch).toBeChecked();
      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Local Chat' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('slider', { name: 'Reasoning' }).fill('3');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: '选择模型' })).toHaveText(/High/);
      mockSrv.resetTurns();
      await page.getByLabel('消息输入框').fill('[LOCAL_MULTI]');
      await page.getByLabel('发送消息').click();

      await expect(page.getByText('MCP Final Reply (count=2)')).toBeVisible();
      expect(
        mockSrv.llmCalls.some((c) => c.auth === 'Bearer sk-gateway-local-key'),
      ).toBe(true);

      expect(mockSrv.llmCalls).toHaveLength(3);
      expect(mockSrv.llmCalls.every((call) => call.body.reasoning_effort === 'high')).toBe(true);

      // Ensure browser key is absent from SQLite conversation detail API response.
      const match = page.url().match(/\/chat\/([^/?]+)/);
      const localConvId = match?.[1] ?? '';
      expect(localConvId).toBeTruthy();
      const detailRes = await fetch(
        `${appUrl}/api/v1/conversations/${encodeURIComponent(localConvId)}`,
        { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
      );
      const rawDetail = await detailRes.text();
      expect(rawDetail).not.toContain('sk-gateway-local-key');
      const parsedDetail = JSON.parse(rawDetail) as {
        messages: Array<{ role: string; blocks: unknown[]; usage?: { totalTokens: number } }>;
      };
      expect(parsedDetail.messages).toHaveLength(2);
      expect(parsedDetail.messages[1].usage?.totalTokens).toBe(80);

      const settings = '/api/v1/settings';
      const headers = { Authorization: `Bearer ${E2E_TOKEN}` };
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: 'MCP 配置' }).click();
      const rounds = page.getByRole('spinbutton', { name: '最大工具调用轮次' });
      await expect(rounds).toHaveValue('20');
      for (const value of [0, 101]) {
        const response = await page.request.patch(`${appUrl}${settings}`, { headers, data: { mcpMaxToolRounds: value } });
        expect(response.status()).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      const patch = page.waitForResponse((res) => res.url().endsWith(settings) && res.request().method() === 'PATCH');
      await rounds.fill('1');
      await rounds.press('Enter');
      expect((await patch).ok()).toBe(true);
      await page.reload({ waitUntil: 'networkidle' });
      await expect(rounds).toHaveValue('1');
      await page.getByRole('button', { name: '外观与显示' }).click();
      const collapsePatch = page.waitForResponse((res) => res.url().endsWith(settings) && res.request().method() === 'PATCH');
      await toolCollapseSwitch.click();
      expect((await collapsePatch).ok()).toBe(true);
      await page.getByRole('button', { name: '返回工作台' }).click();

      for (const model of ['Fwd Chat', 'Local Chat']) {
        await page.getByRole('button', { name: '新建话题' }).click();
        await page.getByRole('button', { name: '选择模型' }).click();
        await page.getByRole('option', { name: model }).click();
        const beforeTools = mockSrv.mcpCalls.length;
        const beforeLlm = mockSrv.llmCalls.length;
        const saved = model === 'Local Chat' ? page.waitForResponse((response) =>
          response.url().endsWith('/messages') && response.request().method() === 'POST' &&
          response.request().postDataJSON()?.role === 'assistant',
        ) : null;
        await page.getByLabel('消息输入框').fill('[ROUND_LIMIT]');
        await page.getByLabel('发送消息').click();
        await expect(page.getByRole('article').getByText('达到最大工具调用轮数上限（1 轮）')).toBeVisible();
        if (saved) expect((await saved).ok()).toBe(true);
        expect(mockSrv.mcpCalls.length - beforeTools).toBe(1);
        expect(mockSrv.llmCalls.length - beforeLlm).toBe(2);
        const errorTrace = page.getByRole('button', { name: /思考与工具 · 2 轮.*未完成/ });
        await expect(errorTrace).toHaveAttribute('aria-expanded', 'false');
        await page.reload({ waitUntil: 'networkidle' });
        await expect(errorTrace).toHaveAttribute('aria-expanded', 'false');
        await errorTrace.click();
        await expect(page.getByRole('button', { name: '思考过程' })).toHaveCount(2);
        for (const thought of await page.getByRole('button', { name: '思考过程' }).all()) {
          await expect(thought).toHaveAttribute('aria-expanded', 'false');
        }
        await expect(page.getByRole('button', { name: /第 1 轮.*完成/ })).toHaveAttribute('aria-expanded', 'false');
      }

      // Failed tool call round auto-collapses when complete and stays collapsed across reload.
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Fwd Chat' }).click();
      await page.getByLabel('消息输入框').fill('[FAILED_TOOL]');
      await page.getByLabel('发送消息').click();
      await expect(page.getByText('Handled tool failure')).toBeVisible();
      const failedRound = page.getByRole('button', { name: /工具调用 · 第 1 轮 · 1 次 · 1 个失败/ }).last();
      await expect(failedRound).toHaveAttribute('aria-expanded', 'false');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByText('Handled tool failure')).toBeVisible();
      await expect(failedRound).toHaveAttribute('aria-expanded', 'false');
      await failedRound.click();
      await expect(failedRound).toHaveAttribute('aria-expanded', 'true');
      await page.locator('.tool-trace-entry > summary').last().click();
      await expect(page.getByText('tool execution failed intentionally')).toBeVisible();
    } finally {
      await mockSrv.close();
    }
  });

  test('内置时区时间工具开关持久化及无外部服务调用闭环', async ({
    page,
    appUrl,
  }) => {
    await connectWithToken(page, appUrl);
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: 'MCP 配置' }).click();

    await expect(page.getByRole('heading', { name: '内置工具' })).toBeVisible();
    await expect(page.getByText('get_current_time')).toBeVisible();

    const toggle = page.getByRole('switch', { name: '启用当前日期与时间工具' });
    await expect(toggle).not.toBeChecked();

    const patch = page.waitForResponse(
      (res) => res.url().endsWith('/api/v1/settings') && res.request().method() === 'PATCH',
    );
    await toggle.click();
    expect((await patch).ok()).toBe(true);
    await expect(toggle).toBeChecked();
    await expect(page.getByText('已启用')).toBeVisible();

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('switch', { name: '启用当前日期与时间工具' })).toBeChecked();

    await page.getByText('工具定义').click();
    await expect(page.getByText(/"timezone"/)).toBeVisible();
  });
});
