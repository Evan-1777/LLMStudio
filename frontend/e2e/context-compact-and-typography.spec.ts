import http from 'node:http';
import {
  connectWithToken,
  E2E_TOKEN,
  expect,
  test,
} from './fixtures';

interface MockCall {
  auth: string;
  body: Record<string, unknown>;
}

async function startCompactAndMcpMockServer() {
  const llmCalls: MockCall[] = [];

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, x-api-key, anthropic-version',
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/mcp-http') {
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      const rpc = JSON.parse((await readBody(req)) || '{}') as {
        id?: unknown;
        method?: string;
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', 'compact-e2e-mcp');
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
                  name: 'web_fetch_doc',
                  description: 'Mock search fetch tool',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          }),
        );
        return;
      }
      if (rpc.method === 'tools/call') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{ type: 'text', text: 'Fetched doc snippet' }],
              structuredContent: { title: 'Doc', relevance: 0.98 },
            },
          }),
        );
        return;
      }
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<
        string,
        unknown
      >;
      llmCalls.push({
        auth: req.headers.authorization || '',
        body,
      });

      const messages = Array.isArray(body.messages)
        ? (body.messages as Array<{ role?: string; content?: unknown }>)
        : [];
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastUserStr = JSON.stringify(lastUser ?? {});
      const toolCount = messages.filter((m) => m.role === 'tool').length;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      if (lastUserStr.includes('## 核心目标与约束')) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 'hidden compaction reasoning',
                  content: '## 核心目标与约束\n保留E2E压缩目标与上下文',
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 2000,
              completion_tokens: 100,
              total_tokens: 2100,
            },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      if (lastUserStr.includes('[MCP_SEARCH]') && tools.length > 0) {
        const alias = String(
          (tools[0] as { function?: { name?: string } })?.function?.name ?? '',
        );
        if (toolCount === 0) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_s1',
                        function: { name: alias, arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100}}\n\n',
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        if (toolCount === 1) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_s2',
                        function: { name: alias, arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4500,"completion_tokens":150,"total_tokens":4650}}\n\n',
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        res.write(
          'data: {"choices":[{"delta":{"content":"MCP multi-round complete\\n\\n```ts\\nconst ok = true;\\n```"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8000,"completion_tokens":200,"total_tokens":8200}}\n\n',
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: `Reply to ${messages.length} msgs\n\n\`\`\`ts\nconst answer = 42;\n\`\`\``,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 50,
            total_tokens: 550,
          },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
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
    throw new Error('failed to bind mock server');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    llmCalls,
    async close() {
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
    throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

test.describe('Context Stats, Compaction Checkpoints, and Typography', () => {
  test('verifies multi-round MCP context stats, gateway & local compaction checkpoints, projection, undo, and responsive typography', async ({
    appUrl,
    page,
  }) => {
    const mock = await startCompactAndMcpMockServer();
    try {
      await apiPost(appUrl, '/api/v1/providers', {
        id: 'prov-fwd',
        name: 'Forwarded Provider',
        adapter: 'generic-http',
        baseURL: mock.baseUrl,
        authType: 'bearer',
        apiKey: 'sk-fwd-secret',
        enabled: true,
        localRequest: false,
        models: [
          {
            id: 'mock-fwd',
            name: 'Mock Forwarded',
            apiFormat: 'openai-completions',
            contextWindow: 128000,
          },
        ],
      });

      await apiPost(appUrl, '/api/v1/providers', {
        id: 'prov-local',
        name: 'Local Direct Provider',
        adapter: 'generic-http',
        baseURL: mock.baseUrl,
        authType: 'bearer',
        apiKey: 'sk-local-direct',
        enabled: true,
        localRequest: true,
        models: [
          {
            id: 'mock-local',
            name: 'Mock Local',
            apiFormat: 'openai-completions',
            contextWindow: 128000,
          },
        ],
      });

      await apiPost(appUrl, '/api/v1/mcp/servers', {
        id: 'mcp-search',
        name: 'Search MCP',
        transport: 'streamable-http',
        endpoint: `${mock.baseUrl}/mcp-http`,
        enabled: true,
      });

      await connectWithToken(page, appUrl);

      // 1. Multi-round MCP tool context accuracy (Scenario 1).
      const composer = page.getByLabel('消息输入框');
      await composer.fill('TURN_ONE_UNIQUE_MARKER initial prompt');
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText(/Reply to 1 msgs/)).toBeVisible();

      await composer.fill('[MCP_SEARCH] run multi-round');
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText('MCP multi-round complete')).toBeVisible();

      const ringBtn = page.locator('.wb-ctx-ring-btn');
      await ringBtn.click();
      const popover = page.getByRole('dialog', { name: '上下文占用明细' });
      await expect(popover).toBeVisible();
      // Last round occupancy is 8,200 (not 13,950 multi-round sum); cumulative session total is 550 + 13,950 = 14,500.
      await expect(popover).toContainText('8,200');
      await expect(popover).toContainText('14,500');

      // 2. Gateway compaction, checkpoint card, projection, and undo (Scenario 2 - forwarded path).
      await popover.getByRole('button', { name: '压缩上下文' }).click();
      const checkpointCard = page.getByRole('region', { name: '压缩检查点' });
      await expect(checkpointCard).toBeVisible();
      await expect(checkpointCard).toContainText('已折叠 2 条');

      // Original Turn 1 remains visible (non-destructive).
      await expect(
        page.getByLabel('对话消息').getByText('TURN_ONE_UNIQUE_MARKER initial prompt'),
      ).toBeVisible();

      // Context occupancy dropped significantly below 8,200 while cumulative total gained 2,100 -> 16,600.
      await expect(popover).toContainText('16,600');
      await expect(popover).not.toContainText('8,200');

      // Expand summary card.
      const togglePill = checkpointCard.getByRole('button', { name: /上下文已压缩/ });
      await togglePill.click();
      await expect(togglePill).toHaveAttribute('aria-expanded', 'true');
      await expect(checkpointCard).toContainText('保留E2E压缩目标与上下文');

      // Subsequent chat sends only checkpoint + retained tail (never TURN_ONE_UNIQUE_MARKER).
      const callsBeforePost = mock.llmCalls.length;
      await composer.fill('[POST_COMPACT] next question');
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText(/Reply to 8 msgs/)).toBeVisible();
      const postCompactPayload = JSON.stringify(mock.llmCalls[callsBeforePost].body);
      expect(postCompactPayload).toContain('保留E2E压缩目标与上下文');
      expect(postCompactPayload).not.toContain('TURN_ONE_UNIQUE_MARKER');

      // Delete checkpoint -> ConfirmDialog -> history restored.
      await checkpointCard.getByRole('button', { name: '删除压缩检查点' }).click();
      const confirmDialog = page.getByRole('dialog', { name: '删除压缩检查点' });
      await expect(confirmDialog).toContainText('删除后将恢复此前历史消息进入上下文。');
      await confirmDialog.getByRole('button', { name: '删除' }).click();
      await expect(checkpointCard).toBeHidden();

      // 3. Browser-direct localRequest compaction path (Scenario 2 - localRequest path).
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.locator('.wb-model-btn').click();
      await page.getByText('Mock Local').click();

      await composer.fill('LOCAL_FIRST_TURN');
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText(/Reply to 1 msgs/).last()).toBeVisible();

      await composer.fill('LOCAL_SECOND_TURN');
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText(/Reply to 3 msgs/).last()).toBeVisible();

      const localPreCount = mock.llmCalls.length;
      await ringBtn.click();
      await popover.getByRole('button', { name: '压缩上下文' }).click();
      await expect(page.getByRole('region', { name: '压缩检查点' })).toBeVisible();
      // Browser directly posted to mock upstream with credential envelope.
      expect(mock.llmCalls.length).toBeGreaterThan(localPreCount);
      expect(mock.llmCalls[mock.llmCalls.length - 1].auth).toBe('Bearer sk-local-direct');

      // 4. Typography & Theme & 375px narrow viewport verification (Scenario 3).
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: '外观与显示' }).click();

      await page.getByRole('radio', { name: '深色', exact: true }).click();
      await page.getByRole('radio', { name: '衬线', exact: true }).click();
      for (let i = 0; i < 4; i++) {
        await page.getByRole('button', { name: '增大字号' }).click();
      }
      await expect(page.locator('.st-font-size-value')).toHaveText('18 px');

      // Reload verifies first-paint + server sync persistence.
      await page.reload({ waitUntil: 'networkidle' });
      const htmlAttrs = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        fontFamily: document.documentElement.dataset.fontFamily,
        fontSizeBase: document.documentElement.style.getPropertyValue('--font-size-base'),
      }));
      expect(htmlAttrs).toEqual({
        theme: 'dark',
        fontFamily: 'serif',
        fontSizeBase: '18px',
      });

      // Return to workbench topic and verify computed prose & monospace code block + 375px responsive layout.
      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.locator('.wb-topic-row__btn').first().click();
      await expect(page.locator('.prose').first()).toBeVisible();

      const typoMetrics = await page.evaluate(() => {
        const prose = document.querySelector('.prose');
        const codePre = document.querySelector('.code-pre');
        return {
          proseFontSize: prose ? getComputedStyle(prose).fontSize : '',
          proseFontFamily: prose ? getComputedStyle(prose).fontFamily : '',
          codeFontFamily: codePre ? getComputedStyle(codePre).fontFamily : '',
        };
      });
      expect(typoMetrics.proseFontSize).toBe('18.5px');
      expect(typoMetrics.proseFontFamily.toLowerCase()).toContain('serif');
      expect(typoMetrics.codeFontFamily.toLowerCase()).toMatch(/mono|menlo|consolas/);

      // 375px narrow viewport: zero horizontal overflow and touch draft >= 18.5px.
      await page.setViewportSize({ width: 375, height: 812 });
      const overflowCheck = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        draftFontSize: parseFloat(
          getComputedStyle(document.querySelector('.wb-draft')!).fontSize,
        ),
      }));
      expect(overflowCheck.scrollWidth).toBeLessThanOrEqual(overflowCheck.clientWidth);
      expect(overflowCheck.draftFontSize).toBeGreaterThanOrEqual(18);
    } finally {
      await mock.close();
    }
  });
});
