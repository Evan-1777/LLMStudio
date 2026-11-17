import {
  E2E_TOKEN,
  connectWithToken,
  expect,
  seedMockProviderViaApi,
  test,
} from './fixtures';

test.describe('Chat Lifecycle, Abort, Retry, Branch, and Delete', () => {
  test('verifies streaming with reasoning + search, abort persistence, prepare/EOF error recovery, non-duplicating user retry, branch, and single delete', async ({
    appUrl,
    upstream,
    page,
  }) => {
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url);

    // Enable SearXNG pointing at mock upstream.
    const searchResp = await fetch(`${appUrl}/api/v1/plugins/search/searxng`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${E2E_TOKEN}`,
      },
      body: JSON.stringify({
        enabled: true,
        isDefault: true,
        endpoint: `${upstream.url}/search`,
        maxResults: 3,
      }),
    });
    expect(searchResp.ok).toBe(true);

    await connectWithToken(page, appUrl);

    // Select Mock Chat explicitly via ModelPicker.
    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    // 1. Send with reasoning effort high + web search enabled.
    await page.getByRole('button', { name: /思考强度/ }).click();
    await page.getByRole('radio', { name: '高', exact: true }).click();
    await page.getByRole('button', { name: '开启联网搜索' }).click();

    const composer = page.getByLabel('消息输入框');
    await composer.fill('First turn question');
    await page.getByRole('button', { name: '发送消息' }).click();

    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();
    await expect(page.getByText(/思考过程/)).toBeVisible();
    await expect(page.getByText(/联网搜索/)).toBeVisible();

    // Verify reasoning_effort was sent to upstream.
    expect(upstream.lastChatBodies[0]?.reasoning_effort).toBe('high');

    // Capture created conversation ID from URL and verify reload persistence.
    await expect(page).toHaveURL(/\/chat\/.+/);
    const convId = new URL(page.url()).pathname.split('/').pop()!;
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();

    // 2. Abort streaming: receive partial content first, click stop, verify upstream disconnect & Go aborted record.
    await composer.fill('[SLOW_ABORT] please stream slowly');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Partial streamed answer/)).toBeVisible();
    await page.getByRole('button', { name: '停止生成' }).click();

    await expect.poll(() => upstream.abortedCount, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('已停止')).toBeVisible();

    // Poll Go API directly (no fixed sleep) to verify Go persisted aborted stopReason.
    await expect
      .poll(
        async () => {
          const detailRes = await fetch(
            `${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`,
            { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
          );
          const detail = (await detailRes.json()) as {
            messages: Array<{ role: string; stopReason?: string }>;
          };
          const last = detail.messages[detail.messages.length - 1];
          return last?.stopReason;
        },
        { timeout: 5000 },
      )
      .toBe('aborted');

    // Reload to get clean server IDs after abort.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('已停止')).toBeVisible();

    // 3. Prepare failure keeps history intact; incomplete EOF reports error instead of success.
    await composer.fill('[PREPARE_FAIL]');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();

    await composer.fill('[MID_EOF]');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('alert')).toContainText(/EOF|意外中断/);

    // 4. User-message retry on the first user turn must NOT duplicate user message.
    await page.reload({ waitUntil: 'networkidle' });
    const retryButtons = page.getByRole('button', { name: '重试消息' });
    await retryButtons.first().click();
    const confirmRetry = page.getByRole('dialog');
    await expect(confirmRetry.getByText(/保留这条用户消息/)).toBeVisible();
    await confirmRetry.getByRole('button', { name: '重新生成' }).click();

    await expect(page.getByText(/Reply #\d+ to:/)).toBeVisible();

    // Confirm via Go API that there is only 1 user message + 1 assistant message (no duplicate user message).
    await expect
      .poll(async () => {
        const res = await fetch(
          `${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`,
          { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
        );
        const detail = (await res.json()) as {
          messages: Array<{ id: string; role: string }>;
        };
        return detail.messages.map((m) => m.role).join(',');
      })
      .toBe('user,assistant');

    // Add a second turn so branch vs original divergence and single-message delete can be verified.
    await composer.fill('Second turn question');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    // Reload to ensure all 4 messages have final server IDs.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    const originalDetailBeforeBranch = (await (
      await fetch(`${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      })
    ).json()) as { messages: Array<{ id: string }> };
    expect(originalDetailBeforeBranch.messages).toHaveLength(4);
    const originalIds = new Set(originalDetailBeforeBranch.messages.map((m) => m.id));

    // 5. Branch from the FIRST assistant message -> new URL, 2 messages with newly assigned IDs; original retains 4 messages.
    const branchButtons = page.getByRole('button', { name: '从此处分支' });
    await branchButtons.first().click();
    await expect(page).not.toHaveURL(new RegExp(`${convId}$`));
    const branchId = new URL(page.url()).pathname.split('/').pop()!;
    expect(branchId).not.toBe(convId);
    expect(providerId).toBeTruthy();

    const branchDetail = (await (
      await fetch(`${appUrl}/api/v1/conversations/${encodeURIComponent(branchId)}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      })
    ).json()) as { messages: Array<{ id: string }> };
    expect(branchDetail.messages).toHaveLength(2);
    for (const m of branchDetail.messages) {
      expect(originalIds.has(m.id)).toBe(false);
    }

    // Navigate back to original conversation: all 4 messages remain intact.
    await page.goto(`${appUrl}/chat/${encodeURIComponent(convId)}`, {
      waitUntil: 'networkidle',
    });
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    // 6. Single-message delete removes ONLY the first user message; subsequent messages stay after reload.
    await page.getByRole('button', { name: '删除消息' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();

    await expect
      .poll(async () => {
        const res = await fetch(
          `${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`,
          { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
        );
        const detail = (await res.json()) as { messages: Array<{ id: string }> };
        return detail.messages.length;
      })
      .toBe(3);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    // 7. Assistant-message retry replaces the target assistant reply and truncates trailing turns.
    await page.getByRole('button', { name: '重试消息' }).first().click();
    const confirmAsstRetry = page.getByRole('dialog');
    await expect(confirmAsstRetry.getByText(/替换当前回复及其后的所有历史消息/)).toBeVisible();
    await confirmAsstRetry.getByRole('button', { name: '重新生成' }).click();

    await expect
      .poll(async () => {
        const res = await fetch(
          `${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`,
          { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
        );
        const detail = (await res.json()) as { messages: Array<{ role: string }> };
        return detail.messages.map((m) => m.role).join(',');
      })
      .toBe('assistant');
  });
});
