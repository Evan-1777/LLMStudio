import http from 'node:http';
import {
  connectWithToken,
  E2E_TOKEN,
  expect,
  test,
} from './fixtures';

async function apiPost(
  appUrl: string,
  path: string,
  body: Record<string, unknown>,
) {
  const res = await fetch(`${appUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${E2E_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function startCacheE2EServer() {
  let cacheCreateCount = 0;
  let geminiGenCount = 0;
  let openaiGenCount = 0;
  let mcpToolCalls = 0;
  const geminiAuthKeys: string[] = [];
  const geminiMainBodies: Array<Record<string, unknown>> = [];
  const openaiBodies: Array<Record<string, unknown>> = [];
  const cachedStore = new Map<string, Record<string, unknown>>();

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
    const rawBody = await readBody(req);
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

    if (url.pathname === '/mcp-http') {
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', 'cache-e2e-mcp');
      if (body.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body.method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
            },
          }),
        );
        return;
      }
      if (body.method === 'tools/list') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'calc_cache',
                  description: 'Compute cached result',
                  inputSchema: {
                    type: 'object',
                    properties: { n: { type: 'integer' } },
                  },
                },
              ],
            },
          }),
        );
        return;
      }
      if (body.method === 'tools/call') {
        mcpToolCalls += 1;
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: `mcp-val-${mcpToolCalls}` }],
            },
          }),
        );
        return;
      }
    }

    if (url.pathname === '/v1beta/cachedContents') {
      cacheCreateCount += 1;
      geminiAuthKeys.push(url.searchParams.get('key') || '');
      const name = `cachedContents/e2e-${cacheCreateCount}`;
      cachedStore.set(name, body);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          name,
          expireTime: '2099-01-01T00:00:00Z',
        }),
      );
      return;
    }

    if (url.pathname.startsWith('/v1beta/models/')) {
      geminiGenCount += 1;
      geminiAuthKeys.push(url.searchParams.get('key') || '');
      geminiMainBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      const contents = Array.isArray(body.contents) ? body.contents : [];
      let fnRespCount = 0;
      for (const c of contents) {
        const parts = (c as { parts?: Array<Record<string, unknown>> }).parts ?? [];
        for (const p of parts) {
          if (p.functionResponse) fnRespCount += 1;
        }
      }

      const cachedRef = typeof body.cachedContent === 'string' ? body.cachedContent : '';
      const cachedPayload = cachedRef ? cachedStore.get(cachedRef) : undefined;
      const toolsSource =
        (body.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>) ??
        (cachedPayload?.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>);
      const toolName = toolsSource?.[0]?.functionDeclarations?.[0]?.name ?? '';

      if (toolName && fnRespCount === 0) {
        res.end(
          `data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"e2e_c1","name":"${toolName}","args":{"n":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":200,"cachedContentTokenCount":140,"candidatesTokenCount":10,"totalTokenCount":210}}\n\n`,
        );
        return;
      }
      res.end(
        `data: {"candidates":[{"content":{"parts":[{"text":"gemini-cached-reply-${geminiGenCount}"}]}, "finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":260,"cachedContentTokenCount":140,"candidatesTokenCount":15,"totalTokenCount":275}}\n\n`,
      );
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      openaiGenCount += 1;
      openaiBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        [
          'data: {"choices":[{"delta":{"content":"openai-explicit-ok"},"finish_reason":"stop"}]}',
          '',
          'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":18,"total_tokens":138,"prompt_tokens_details":{"cached_tokens":80,"cache_write_tokens":20}}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    getStats: () => ({
      cacheCreateCount,
      geminiGenCount,
      openaiGenCount,
      mcpToolCalls,
      geminiAuthKeys,
      geminiMainBodies,
      openaiBodies,
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe('Prompt caching, persisted cacheMode, and localRequest MCP E2E', () => {
  test('toggles autoCreateCache, persists explicit cacheMode, and runs browser-direct Gemini cache + MCP tool round', async ({
    page,
    appUrl,
  }) => {
    const mock = await startCacheE2EServer();
    try {
      await apiPost(appUrl, '/api/v1/providers', {
        id: 'oai-cache-e2e',
        name: 'OpenAI Cache E2E',
        adapter: 'generic-http',
        baseURL: mock.baseUrl,
        authType: 'bearer',
        apiKey: 'sk-oai-e2e',
        enabled: true,
        models: [{ id: 'gpt-5.6', name: 'GPT 5.6', apiFormat: 'openai-completions' }],
      });
      await apiPost(appUrl, '/api/v1/mcp/servers', {
        name: 'Cache E2E MCP',
        transport: 'streamable-http',
        endpoint: `${mock.baseUrl}/mcp-http`,
        enabled: true,
      });

      await connectWithToken(page, appUrl);

      // 1. Default autoCreateCache is OFF -> sending OpenAI request adds no prompt_cache_options.
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'GPT 5.6' }).click();
      await page.getByLabel('消息输入框').fill('Before cache enabled');
      await page.getByLabel('发送消息').click();
      await expect(page.getByText('openai-explicit-ok')).toBeVisible();
      expect(mock.getStats().openaiBodies[0]?.prompt_cache_options).toBeUndefined();

      // 2. Enable autoCreateCache in Connection settings & configure explicit cacheMode via ModelEditor.
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: '连接', exact: true }).click();
      const cacheSwitch = page.getByRole('switch', { name: '自动创建缓存' });
      await expect(cacheSwitch).not.toBeChecked();
      await cacheSwitch.click();
      await expect(cacheSwitch).toBeChecked();

      await page.getByRole('button', { name: '模型服务' }).click();
      await page.getByRole('button', { name: /OpenAI Cache E2E/ }).click();
      await page.getByRole('button', { name: '编辑 GPT 5.6' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('协议兼容覆盖').click();
      await dialog.getByLabel('cacheMode').selectOption('explicit');
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).toBeHidden();

      // Re-open and edit display name only -> cacheMode=explicit survives.
      await page.getByRole('button', { name: '编辑 GPT 5.6' }).click();
      await expect(dialog.getByLabel('cacheMode')).toHaveValue('explicit');
      await dialog.getByLabel('显示名称').fill('GPT 5.6 Explicit');
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).toBeHidden();

      // 3. Create localRequest Gemini provider via UI (local key stored only in browser).
      await page.getByRole('button', { name: '添加供应商' }).click();
      const addProvDialog = page.getByRole('dialog');
      await addProvDialog.getByLabel('名称').fill('Local Gemini Cache');
      await addProvDialog.getByLabel('API 地址').fill(`${mock.baseUrl}/v1beta`);
      await addProvDialog.getByLabel('鉴权方式').selectOption('query-key');
      await addProvDialog.getByLabel('API Key').fill('e2e-gem-local-key');
      await addProvDialog.getByRole('switch', { name: '本地请求' }).click();
      await addProvDialog.getByRole('button', { name: '添加' }).click();
      await expect(addProvDialog).toBeHidden();

      await page.getByRole('button', { name: '添加模型' }).last().click();
      const gemModelDialog = page.getByRole('dialog');
      await gemModelDialog.getByLabel('Model ID').fill('gemini-2.5-pro');
      await gemModelDialog.getByLabel('显示名称').fill('Gemini 2.5 Local Cache');
      await gemModelDialog.getByLabel('API Format').selectOption('google-generative-ai');
      await gemModelDialog.getByRole('button', { name: '保存' }).click();
      await expect(gemModelDialog).toBeHidden();

      // 4. Send with OpenAI explicit model -> prompt_cache_options.mode='explicit' sent.
      await page.getByRole('button', { name: '返回工作台' }).click();
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'GPT 5.6 Explicit' }).click();

      await page.getByLabel('消息输入框').fill('Test OpenAI explicit cache');
      await page.getByLabel('发送消息').click();
      await expect(page.getByText('openai-explicit-ok')).toBeVisible();
      expect(mock.getStats().openaiBodies[1]?.prompt_cache_options).toEqual({
        mode: 'explicit',
      });

      // 5. Switch to Local Gemini Cache -> browser creates cache with local key + runs MCP tool round + reuses cache.
      await page.getByRole('button', { name: '新建话题' }).click();
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Gemini 2.5 Local Cache' }).click();

      await page.getByLabel('消息输入框').fill('Run Gemini cached MCP');
      await page.getByLabel('发送消息').click();
      await expect(page.getByText('gemini-cached-reply-2')).toBeVisible();

      let stats = mock.getStats();
      expect(stats.cacheCreateCount).toBe(1);
      expect(stats.mcpToolCalls).toBe(1);
      expect(stats.geminiGenCount).toBe(2);
      expect(stats.geminiAuthKeys.every((k) => k === 'e2e-gem-local-key')).toBe(true);
      expect(stats.geminiMainBodies[0].tools).toBeUndefined();
      expect(stats.geminiMainBodies[0].cachedContent).toBe('cachedContents/e2e-1');

      // Ensure local key never leaked into SQLite conversation detail API response.
      const match = page.url().match(/\/chat\/([^/?]+)/);
      const localConvId = match?.[1] ?? '';
      expect(localConvId).toBeTruthy();
      const detailRes = await fetch(
        `${appUrl}/api/v1/conversations/${encodeURIComponent(localConvId)}`,
        { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
      );
      expect(await detailRes.text()).not.toContain('e2e-gem-local-key');

      // Turn 2 reuses cachedContents/e2e-1 without creating another cache.
      await page.getByLabel('消息输入框').fill('Second cached turn');
      await page.getByLabel('发送消息').click();
      await expect(page.getByText('gemini-cached-reply-3')).toBeVisible();
      stats = mock.getStats();
      expect(stats.cacheCreateCount).toBe(1);

      // Verify on-demand cache read token display & reload persistence.
      const usageTrigger = page.getByRole('button', { name: '查看 Token 用量详情' }).first();
      await expect(usageTrigger).toContainText('缓存读 280');
      await usageTrigger.click();
      await expect(page.getByText('缓存读取')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByText('gemini-cached-reply-3')).toBeVisible();
      await page.getByRole('link', { name: '设置' }).click();
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.getByRole('switch', { name: '自动创建缓存' })).toBeChecked();
    } finally {
      await mock.close();
    }
  });
});
