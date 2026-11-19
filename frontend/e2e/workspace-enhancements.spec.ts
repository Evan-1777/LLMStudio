import {
  E2E_TOKEN,
  connectWithToken,
  expect,
  seedMockProviderViaApi,
  test,
} from './fixtures';

async function apiJson<T>(
  appUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${appUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${E2E_TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

test.describe('Workspace Enhancements', () => {
  test('scroll-bottom button stays 32x32 circle, instant 0ms response with delayed upstream, and context usage popover', async ({
    appUrl,
    upstream,
    page,
  }) => {
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url, [
      {
        id: 'mock-chat',
        name: 'Mock Chat',
        apiFormat: 'openai-completions',
        contextWindow: 128000,
        reasoning: true,
        inputModalities: ['text'],
      },
    ]);
    const created = await apiJson<{ conversation: { id: string } }>(
      appUrl,
      '/api/v1/conversations',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Scroll & Delay Topic',
          providerId,
          modelId: 'mock-chat',
        }),
      },
    );
    const convId = created.conversation.id;
    for (let i = 0; i < 16; i++) {
      await apiJson(
        appUrl,
        `/api/v1/conversations/${encodeURIComponent(convId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            role: i % 2 === 0 ? 'user' : 'assistant',
            blocks: [
              {
                type: 'text',
                text: `Line ${i}: `.repeat(18) + '\n\nMore detail paragraph.',
              },
            ],
            providerId,
            modelId: 'mock-chat',
            ...(i % 2 === 1
              ? {
                  usage: {
                    inputTokens: 1200,
                    outputTokens: 300,
                    totalTokens: 1500,
                  },
                  stopReason: 'stop',
                }
              : {}),
          }),
        },
      );
    }

    await connectWithToken(page, appUrl);
    await page.locator('.wb-topic-row__btn', { hasText: 'Scroll & Delay Topic' }).click();
    const scroller = page.locator('.wb-chat-scroll');
    await expect(page.getByText('More detail paragraph.').last()).toBeVisible();

    // Scroll up to reveal the scroll-to-bottom button and verify circular geometry.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    const scrollBtn = page.getByRole('button', { name: '回到底部' });
    await expect(scrollBtn).toBeVisible();
    const btnBox = (await scrollBtn.boundingBox())!;
    expect(Math.abs(btnBox.width - 32)).toBeLessThanOrEqual(1);
    expect(Math.abs(btnBox.height - 32)).toBeLessThanOrEqual(1);
    await scrollBtn.click();
    await expect(scrollBtn).toBeHidden();

    // Context usage ring shows accurate token breakdown popover.
    const ctxBtn = page.locator('.wb-ctx-ring-btn');
    await expect(ctxBtn).toBeVisible();
    await ctxBtn.hover();
    const popover = page.getByRole('dialog', { name: '上下文占用明细' });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('1,500');
    await expect(popover).toContainText('128K');

    // Delayed upstream (600ms) -> 0ms instant waiting placeholder & stop button, plus retry in-place swap.
    upstream.firstByteDelayMs = 600;
    const composer = page.getByLabel('消息输入框');
    await composer.fill('Delayed prompt check');
    await page.getByRole('button', { name: '发送消息' }).click();

    await expect(composer).toHaveValue('');
    await expect(page.getByText('Delayed prompt check')).toBeVisible();
    await expect(page.getByText('等待响应')).toBeVisible();
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
    await expect(page.getByText(/Reply #\d+ to: Delayed prompt check/)).toBeVisible();

    // Retry replaces reply in-place immediately with waiting spinner before 600ms upstream responds.
    await page.getByRole('button', { name: '重试消息' }).last().click();
    await page.getByRole('dialog').getByRole('button', { name: '重新生成' }).click();
    await expect(page.getByText('等待响应')).toBeVisible();
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
    await expect(page.getByText(/Reply #\d+ to: Delayed prompt check/).last()).toBeVisible();
  });

  test('ephemeral conversation runs multi-turn off-URL and deletes on exit or settings navigation', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    let capturedTempId = '';
    page.on('response', async (res) => {
      if (
        res.url().includes('/api/v1/conversations') &&
        res.request().method() === 'POST' &&
        res.status() === 201
      ) {
        try {
          const data = (await res.json()) as { conversation?: { id: string; ephemeral?: boolean } };
          if (data.conversation?.ephemeral) {
            capturedTempId = data.conversation.id;
          }
        } catch {
          // ignore
        }
      }
    });

    await page.getByRole('button', { name: '临时会话' }).click();
    await expect(page.locator('.wb-temp-badge')).toHaveText('临时会话');
    expect(page.url()).not.toContain('/chat/');

    await page.getByLabel('消息输入框').fill('Ephemeral turn 1');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Reply #\d+ to: Ephemeral turn 1/)).toBeVisible();
    expect(capturedTempId).toBeTruthy();
    expect(page.url()).not.toContain(capturedTempId);

    // Multi-turn works without adding to the sidebar.
    await page.getByLabel('消息输入框').fill('Ephemeral turn 2');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Reply #\d+ to: Ephemeral turn 2/)).toBeVisible();
    await expect(page.locator('.wb-topic-row__title')).toHaveCount(0);

    // Exiting temporary mode deletes server conversation immediately (404).
    await page.getByRole('button', { name: '退出临时会话' }).click();
    await expect.poll(async () => {
      const r = await fetch(`${appUrl}/api/v1/conversations/${encodeURIComponent(capturedTempId)}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      });
      return r.status;
    }).toBe(404);
  });

  test('manual chat width persists across reloads and in-page sync pulls remote changes without refresh', async ({
    appUrl,
    upstream,
    page,
  }) => {
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url, [
      {
        id: 'mock-chat',
        name: 'Mock Chat',
        apiFormat: 'openai-completions',
        contextWindow: 128000,
        reasoning: true,
        inputModalities: ['text'],
      },
    ]);
    const conv = await apiJson<{ conversation: { id: string } }>(
      appUrl,
      '/api/v1/conversations',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Sync Target Topic',
          providerId,
          modelId: 'mock-chat',
        }),
      },
    );
    const convId = conv.conversation.id;

    await page.setViewportSize({ width: 1440, height: 900 });
    await connectWithToken(page, appUrl);
    await page.locator('.wb-topic-row__btn', { hasText: 'Sync Target Topic' }).click();

    // Test manual width toggle -> drag wider -> persist -> disable restores 780px.
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('switch', { name: '手动调整对话宽度' }).click();
    await page.getByRole('button', { name: '返回工作台' }).click();

    const rightEdge = page.locator('.wb-width-edge--right');
    await expect(rightEdge).toBeVisible();
    const inner = page.locator('.wb-chat-inner');
    const beforeW = (await inner.boundingBox())!.width;

    const edgeBox = (await rightEdge.boundingBox())!;
    const cx = edgeBox.x + edgeBox.width / 2;
    const cy = edgeBox.y + edgeBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 6 });
    await page.mouse.up();

    const afterDragW = (await inner.boundingBox())!.width;
    expect(afterDragW).toBeGreaterThan(beforeW + 80);

    await page.reload({ waitUntil: 'networkidle' });
    const reloadedW = (await inner.boundingBox())!.width;
    expect(Math.abs(reloadedW - afterDragW)).toBeLessThanOrEqual(4);

    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('switch', { name: '手动调整对话宽度' }).click();
    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.locator('.wb-width-edge--right')).toHaveCount(0);
    expect((await inner.boundingBox())!.width).toBeLessThanOrEqual(781);

    // Simulate another device creating a topic and appending a message to current topic.
    await apiJson(appUrl, '/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({
        title: 'From Other Device',
        providerId,
        modelId: 'mock-chat',
      }),
    });
    await apiJson(
      appUrl,
      `/api/v1/conversations/${encodeURIComponent(convId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Synced message from mobile' }],
          stopReason: 'stop',
        }),
      },
    );

    await page.getByRole('button', { name: '刷新服务端数据' }).click();
    await expect(page.locator('.wb-topic-row__btn', { hasText: 'From Other Device' })).toBeVisible();
    await expect(page.getByText('Synced message from mobile')).toBeVisible();
  });
});
