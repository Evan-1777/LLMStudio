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
    await expect(
      page.getByRole('button', { name: /联网搜索 · First turn question/ }),
    ).toBeVisible();

    // Verify reasoning_effort was sent to upstream.
    expect(upstream.lastChatBodies[0]?.reasoning_effort).toBe('high');

    // Capture created conversation ID from URL and verify reload persistence.
    await expect(page).toHaveURL(/\/chat\/.+/);
    const convId = new URL(page.url()).pathname.split('/').pop()!;
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();
    await expect(page.getByRole('button', { name: '思考强度 (高)' })).toBeVisible();

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

    // 4. User-message retry on the first user turn must NOT duplicate user message AND preserves trailing turns.
    await page.reload({ waitUntil: 'networkidle' });
    const beforeUserRetryDetail = (await (
      await fetch(`${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      })
    ).json()) as {
      conversation: { updatedAt: string };
      messages: Array<{ id: string; role: string }>;
    };
    expect(beforeUserRetryDetail.messages).toHaveLength(6);

    const retryButtons = page.getByRole('button', { name: '重试消息' });
    await retryButtons.first().click();
    const confirmRetry = page.getByRole('dialog');
    await expect(confirmRetry.getByText(/保留这条用户消息/)).toBeVisible();
    await confirmRetry.getByRole('button', { name: '重新生成' }).click();

    await expect(
      page.getByText(/Reply #(?:[2-9]|\d{2,}) to: First turn question/),
    ).toBeVisible();

    expect(upstream.lastChatBodies.at(-1)?.reasoning_effort).toBe('high');

    // Confirm via Go API that only index 1 was replaced, trailing turns stayed, and updatedAt moved forward.
    await expect
      .poll(async () => {
        const res = await fetch(
          `${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`,
          { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
        );
        const detail = (await res.json()) as {
          conversation: { updatedAt: string };
          messages: Array<{ id: string; role: string }>;
        };
        if (detail.messages[1]?.id === beforeUserRetryDetail.messages[1]?.id) {
          return 'waiting';
        }
        return detail.messages.map((m) => m.role).join(',');
      })
      .toBe('user,assistant,user,assistant,user,assistant');

    // Add a second turn so branch vs original divergence and single-message delete can be verified.
    await composer.fill('Second turn question');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    // Reload to ensure all 8 messages have final server IDs.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    const originalDetailBeforeBranch = (await (
      await fetch(`${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      })
    ).json()) as { messages: Array<{ id: string }> };
    expect(originalDetailBeforeBranch.messages).toHaveLength(8);
    const originalIds = new Set(originalDetailBeforeBranch.messages.map((m) => m.id));

    // 5. Branch from the FIRST assistant message -> new URL, 2 messages with newly assigned IDs; original retains 8 messages.
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

    // Navigate back to original conversation: all 8 messages remain intact.
    await page.goto(`${appUrl}/chat/${encodeURIComponent(convId)}`, {
      waitUntil: 'networkidle',
    });
    await expect(page.getByText(/to: Second turn question/)).toBeVisible();

    // 6. Edit first user message and last assistant message inline and verify persistence across reload.
    const editButtons = page.getByRole('button', { name: '修改消息' });
    await editButtons.first().click();
    const msgEditor = page.getByLabel('编辑消息内容');
    await msgEditor.fill('Edited first turn');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('Edited first turn')).toBeVisible();

    await editButtons.last().click();
    await page.getByLabel('编辑消息内容').fill('Edited second reply');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('Edited second reply')).toBeVisible();

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('Edited first turn')).toBeVisible();
    await expect(page.getByText('Edited second reply')).toBeVisible();

    // 7. Non-truncating retry on middle assistant message refreshes ONLY index 1 while preserving trailing turns!
    const beforeMidRetry = (await (
      await fetch(`${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` },
      })
    ).json()) as {
      conversation: { updatedAt: string };
      messages: Array<{ id: string }>;
    };

    const retryMiddleBtn = page.getByRole('button', { name: '重试消息' }).nth(1);
    await retryMiddleBtn.click();
    const confirmAsstRetry = page.getByRole('dialog');
    await expect(
      confirmAsstRetry.getByText(/仅重新生成当前回复，下方其余历史消息保持不变/),
    ).toBeVisible();
    await confirmAsstRetry.getByRole('button', { name: '重新生成' }).click();

    await expect(page.getByText(/Reply #\d+ to: Edited first turn/)).toBeVisible();
    await expect(page.getByText('Edited second reply')).toBeVisible();
    await expect
      .poll(async () => {
        const res = await fetch(
          `${appUrl}/api/v1/conversations/${encodeURIComponent(convId)}`,
          { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
        );
        const detail = (await res.json()) as {
          conversation: { updatedAt: string };
          messages: Array<{ id: string; role: string }>;
        };
        if (detail.messages[1]?.id === beforeMidRetry.messages[1]?.id) {
          return 'waiting';
        }
        expect(detail.conversation.updatedAt >= beforeMidRetry.conversation.updatedAt).toBe(true);
        return detail.messages.map((m) => m.role).join(',');
      })
      .toBe('user,assistant,user,assistant,user,assistant,user,assistant');

    // 8. Single-message delete removes ONLY the first user message; subsequent messages stay after reload.
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
      .toBe(7);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('Edited second reply')).toBeVisible();

    await page.getByRole('button', { name: '新建话题' }).click();
    await expect(page.getByRole('button', { name: '思考强度 (高)' })).toBeVisible();
    await composer.fill('New topic inherits effort');
    const created = page.waitForResponse((res) =>
      res.url().endsWith('/api/v1/conversations') && res.request().method() === 'POST');
    await page.getByRole('button', { name: '发送消息' }).click();
    expect((await created).request().postDataJSON().params.reasoningEffort).toBe('high');
    await expect(page.getByText(/to: New topic inherits effort/)).toBeVisible();
    expect(upstream.lastChatBodies.at(-1)?.reasoning_effort).toBe('high');

    await page.goto(appUrl + '/chat/' + encodeURIComponent(convId));
    await expect(page.getByText('Edited second reply')).toBeVisible();
    await composer.fill('Keep draft when preference save fails');
    const failSave = async (route: import('@playwright/test').Route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: '写入失败' } });
    };
    await page.route('**/api/v1/settings', failSave);
    await page.getByRole('button', { name: '思考强度 (高)' }).click();
    await page.getByRole('radio', { name: '关闭', exact: true }).click();
    await expect(page.getByText(/思考强度保存失败/)).toBeVisible();
    await expect(page.getByRole('button', { name: '思考强度 (高)' })).toBeEnabled();
    await expect(composer).toHaveValue('Keep draft when preference save fails');
    await page.unroute('**/api/v1/settings', failSave);

    await page.getByRole('button', { name: '思考强度 (高)' }).click();
    await page.getByRole('radio', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('button', { name: '思考强度 (关闭)' })).toBeEnabled();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: '思考强度 (关闭)' })).toBeEnabled();

    const resetPreference = await fetch(appUrl + '/api/v1/settings', {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + E2E_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ composerReasoningEffort: '' }),
    });
    expect(resetPreference.ok).toBe(true);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: '思考强度 (高)' })).toBeEnabled();
  });
});


test('persists Enter behavior on the gateway and preserves multiline and IME input', async ({ appUrl, upstream, page }) => {
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  const composer = page.getByLabel('消息输入框');
  const sendButton = page.getByRole('button', { name: '发送消息' });
  const sent: string[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && /\/api\/v1\/conversations\/[^/]+\/messages\/stream$/.test(req.url())) sent.push(req.url());
  });
  await composer.fill('First draft');
  await composer.press('Shift+Enter');
  await expect(composer).toHaveValue('First draft\n');
  await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await expect(composer).toHaveValue('First draft\n');
  expect(sent).toEqual([]);
  await expect(sendButton).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByText(/Reply #1 to: First draft/)).toBeVisible();
  expect(upstream.lastChatBodies).toHaveLength(1);

  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: '外观与显示' }).click();
  const enter = page.getByRole('switch', { name: 'Enter 发送' });
  await expect(enter).toBeChecked();
  const saved = page.waitForResponse(res => res.url().endsWith('/api/v1/settings') && res.request().method() === 'PATCH' && res.ok());
  await enter.click();
  await saved;
  await page.reload();
  await expect(enter).not.toBeChecked();
  await page.route('**/api/v1/settings', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: '故障回归' } })
    : route.continue());
  await enter.click();
  await expect(page.getByText('设置保存失败：故障回归')).toBeVisible();
  await expect(enter).not.toBeChecked();
  await page.unroute('**/api/v1/settings');
  await page.getByRole('button', { name: '返回工作台' }).click();

  await composer.fill('Second draft');
  await composer.press('Enter');
  await expect(composer).toHaveValue('Second draft\n');
  expect(upstream.lastChatBodies).toHaveLength(1);
  await expect(sendButton).toBeEnabled();
  await composer.press('Control+Enter');
  await expect(page.getByText(/Reply #2 to: Second draft/)).toBeVisible();
  await composer.fill('Third draft');
  // Reply text can become visible before the previous send finishes reconciling.
  await expect(sendButton).toBeEnabled();
  await composer.press('Meta+Enter');
  await expect(page.getByText(/Reply #3 to: Third draft/)).toBeVisible();
  await composer.fill('Fourth draft');
  await sendButton.click();
  await expect(page.getByText(/Reply #4 to: Fourth draft/)).toBeVisible();
  expect(upstream.lastChatBodies).toHaveLength(4);
});
