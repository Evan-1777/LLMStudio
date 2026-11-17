import http from 'node:http';
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
    setFailProbe(v: boolean) {
      failHttpProbe = v;
    },
    resetTurns() {
      bumpCount = 0;
      flowTurn = 0;
      llmCalls.length = 0;
    },
    async close() {
      sseClientRes?.end();
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

test.describe('MCP End-to-End Integration', () => {
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

      await page.getByRole('button', { name: '探测 mcp-http' }).click();
      await expect(page.getByText(/已连通 · 2 个工具/)).toBeVisible();
      await expect(page.getByText('bump_state', { exact: true })).toBeVisible();
      await expect(page.getByText('safe_note', { exact: true })).toBeVisible();
      await expect(page.getByText('只读', { exact: true })).toBeVisible();

      mockSrv.setFailProbe(true);
      await page.getByRole('button', { name: '探测 mcp-http' }).click();
      await expect(page.getByText('探测失败', { exact: true })).toBeVisible();
      await expect(page.getByText(/401/)).toBeVisible();
      mockSrv.setFailProbe(false);

      // 2. Forward multi-round execution (2 calls R1 -> 1 call R2 -> final text R3), single collapsed summary, manual reopen & XSS immunity
      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Fwd Chat' }).click();
      await page.getByLabel('消息输入框').fill('[FORWARD_MULTI]');
      await page.getByLabel('发送消息').click();

      await expect(
        page.getByText('MCP Final Reply (count=2)', { exact: true }),
      ).toBeVisible();
      // Collapsed by default because autoCollapseToolsOnComplete=true.
      const traceToggle = page.getByRole('button', { name: /工具调用/ });
      await expect(traceToggle).toHaveCount(1);
      await expect(traceToggle).toHaveAttribute('aria-expanded', 'false');

      // Expand and inspect rounds + embedded resource + unexecuted script tag.
      await traceToggle.click();
      await expect(page.getByText('第 1 轮', { exact: true })).toBeVisible();
      await expect(page.getByText('第 2 轮', { exact: true })).toBeVisible();
      await expect(page.getByText('count=2', { exact: true })).toBeVisible();
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
      await expect(page.getByText('60 in · 20 out')).toBeVisible();

      // 3. Disable mcp-sse server -> next model call no longer sees echo_sse tool.
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: 'MCP 配置' }).click();
      await page.getByRole('switch', { name: '启用 mcp-sse' }).click();
      await expect(page.getByText('配置已停用')).toBeVisible();

      // Turn OFF autoCollapseToolsOnComplete and verify narrow mobile 375px scrolling.
      await page.getByRole('button', { name: '外观与显示' }).click();
      await page.getByRole('switch', { name: '工具执行完成后自动折叠' }).click();

      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByLabel('消息输入框').fill('[LONG_TOOL]');
      await page.getByLabel('发送消息').click();
      await expect(page.getByText('Long tool complete')).toBeVisible();

      const traceBody = page.locator('.tool-trace-body').last();
      await expect(traceBody).toBeVisible();
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
      await page.evaluate(() => {
        localStorage.setItem(
          'llmstudio.localProviderKeys.v1',
          JSON.stringify({ 'mcp-local-prov': 'sk-e2e-browser-local-key' }),
        );
      });
      await page.reload({ waitUntil: 'networkidle' });

      mockSrv.resetTurns();
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Local Chat' }).click();
      await page.getByLabel('消息输入框').fill('[LOCAL_MULTI]');
      await page.getByLabel('发送消息').click();

      await expect(page.getByText('MCP Final Reply (count=2)')).toBeVisible();
      expect(
        mockSrv.llmCalls.some(
          (c) => c.auth === 'Bearer sk-e2e-browser-local-key',
        ),
      ).toBe(true);

      // Ensure browser key is absent from SQLite conversation detail API response.
      const match = page.url().match(/\/chat\/([^/?]+)/);
      const localConvId = match?.[1] ?? '';
      expect(localConvId).toBeTruthy();
      const detailRes = await fetch(
        `${appUrl}/api/v1/conversations/${encodeURIComponent(localConvId)}`,
        { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
      );
      const rawDetail = await detailRes.text();
      expect(rawDetail).not.toContain('sk-e2e-browser-local-key');
      const parsedDetail = JSON.parse(rawDetail) as {
        messages: Array<{ role: string; blocks: unknown[]; usage?: { totalTokens: number } }>;
      };
      expect(parsedDetail.messages).toHaveLength(2);
      expect(parsedDetail.messages[1].usage?.totalTokens).toBe(80);
    } finally {
      await mockSrv.close();
    }
  });
});
