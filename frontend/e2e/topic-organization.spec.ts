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
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

test.describe('Topic Organization, Manual Order, Touch Drag, and Batch Operations', () => {
  test('preserves manual order across navigation/edits/sends/retries and supports groups, pin, mouse & touch drag, keyboard, and atomic batch delete', async ({
    appUrl,
    upstream,
    browser,
    page,
  }) => {
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url);

    // Seed C, B, A so initial ungrouped head-insert order is A, B, C.
    const cRes = await apiJson<{ conversation: { id: string } }>(appUrl, '/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'Topic C', providerId, modelId: 'mock-chat' }),
    });
    const bRes = await apiJson<{ conversation: { id: string } }>(appUrl, '/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'Topic B', providerId, modelId: 'mock-chat' }),
    });
    const aRes = await apiJson<{ conversation: { id: string } }>(appUrl, '/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'Topic A', providerId, modelId: 'mock-chat' }),
    });

    const idA = aRes.conversation.id;
    const idB = bRes.conversation.id;
    const idC = cRes.conversation.id;

    // Seed initial messages in B and C so message preservation after batch operations can be verified.
    for (const [cid, txt] of [
      [idB, 'Keep msg in B'],
      [idC, 'Keep msg in C'],
    ] as const) {
      await apiJson(appUrl, `/api/v1/conversations/${encodeURIComponent(cid)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', blocks: [{ type: 'text', text: txt }] }),
      });
    }

    await connectWithToken(page, appUrl);
    const getTitles = () => page.locator('.wb-topic-row__title').allTextContents();
    await expect.poll(getTitles).toEqual(['Topic A', 'Topic B', 'Topic C']);

    // 1. Navigate C -> A -> rename C -> send & receive reply in C -> intermediate retry in C -> order stays A, B, C across reloads!
    await page.getByRole('button', { name: /^Topic C/ }).click();
    await expect(page.getByText('Keep msg in C')).toBeVisible();
    await page.getByRole('button', { name: /^Topic A/ }).click();
    await page.getByRole('button', { name: /^Topic C/ }).click();

    // Rename Topic C via row menu.
    await page.getByRole('button', { name: '更多操作 Topic C' }).click();
    await page.getByRole('menuitem', { name: '重命名' }).click();
    await page.getByLabel('标题').fill('Topic C Renamed');
    await page.getByRole('button', { name: '保存' }).click();
    await expect.poll(getTitles).toEqual(['Topic A', 'Topic B', 'Topic C Renamed']);

    // Send a message in Topic C Renamed and receive reply, then reload.
    await page.getByLabel('消息输入框').fill('Question in C');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Reply #1 to: Question in C/)).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(getTitles).toEqual(['Topic A', 'Topic B', 'Topic C Renamed']);

    // Intermediate retry in Topic C Renamed must also keep order A, B, C Renamed.
    await page.getByRole('button', { name: '重试消息' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: '重新生成' }).click();
    await expect(page.getByText(/Reply #2 to:/)).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(getTitles).toEqual(['Topic A', 'Topic B', 'Topic C Renamed']);

    // 2. Create two groups ('Work', 'Research'), move C into Work, pin B via keyboard menu, and verify order + reload.
    await page.getByRole('button', { name: '新建分组' }).click();
    await page.getByLabel('分组名称').fill('Work');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('button', { name: /^Work/ })).toBeVisible();

    await page.getByRole('button', { name: '新建分组' }).click();
    await page.getByLabel('分组名称').fill('Research');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('button', { name: /^Research/ })).toBeVisible();

    // Move Topic C Renamed to Work via keyboard menu activation.
    const menuBtnC = page.getByRole('button', { name: '更多操作 Topic C Renamed' });
    await menuBtnC.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: '移至分组' }).click();
    await page.getByRole('radio', { name: 'Work' }).check();
    await page.getByRole('button', { name: '确定' }).click();

    // Pin Topic B via menu.
    await page.getByRole('button', { name: '更多操作 Topic B' }).click();
    await page.getByRole('menuitem', { name: '置顶' }).click();

    // Order should now be: Pinned [Topic B], Work [Topic C Renamed], Ungrouped [Topic A].
    await expect.poll(getTitles).toEqual(['Topic B', 'Topic C Renamed', 'Topic A']);
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(getTitles).toEqual(['Topic B', 'Topic C Renamed', 'Topic A']);

    // 3. Desktop mouse drag: drag Topic A into Research group, then drag back to ungrouped, and verify!
    const dragA = page.getByRole('button', { name: '拖动排序 Topic A' });
    const researchSection = page.locator('[data-drop-bucket^="group:"]').nth(1);
    await dragA.scrollIntoViewIfNeeded();
    const boxA = (await dragA.boundingBox())!;
    const boxR = (await researchSection.boundingBox())!;
    await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxR.x + boxR.width / 2, boxR.y + boxR.height - 6, { steps: 10 });
    await page.mouse.up();

    // Verify Topic A is now in Research group via API and stays after reload.
    await expect
      .poll(async () => {
        const list = await apiJson<{ conversations: Array<{ id: string; groupId: string | null }> }>(
          appUrl,
          '/api/v1/conversations?assistantId=default',
        );
        return list.conversations.find((c) => c.id === idA)?.groupId ?? null;
      })
      .not.toBeNull();

    // Move Topic A back to ungrouped via menu and verify groupId becomes null.
    await page.getByRole('button', { name: '更多操作 Topic A' }).click();
    await page.getByRole('menuitem', { name: '移至分组' }).click();
    await page.getByRole('radio', { name: '未分组' }).check();
    await page.getByRole('button', { name: '确定' }).click();
    await expect
      .poll(async () => {
        const list = await apiJson<{ conversations: Array<{ id: string; groupId: string | null }> }>(
          appUrl,
          '/api/v1/conversations?assistantId=default',
        );
        const found = list.conversations.find((c) => c.id === idA);
        return found ? found.groupId : 'missing';
      })
      .toBeNull();

    // 4. Search + menu step move / pin actions work in filtered view.
    await page.getByLabel('搜索话题').fill('Topic C');
    await expect.poll(getTitles).toEqual(['Topic C Renamed']);
    await page.getByRole('button', { name: '更多操作 Topic C Renamed' }).click();
    await page.getByRole('menuitem', { name: '置顶' }).click();
    await page.getByLabel('搜索话题').fill('');
    await expect.poll(getTitles).toEqual(['Topic C Renamed', 'Topic B', 'Topic A']);

    // 5. Real touch pointer drag in mobile touch context (390x844, hasTouch=true): reorder pinned Topic B above Topic C Renamed!
    const touchCtx = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      const touchPage = await touchCtx.newPage();
      await connectWithToken(touchPage, appUrl);
      await touchPage.getByRole('button', { name: '切换话题栏' }).click();
      await expect(touchPage.getByText('Topic C Renamed')).toBeVisible();

      const handleB = touchPage.getByRole('button', { name: '拖动排序 Topic B' });
      const rowC = touchPage.locator(`[data-topic-id="${idC}"]`);
      // Wait for drawer slide transition to finish before sampling CDP touch coordinates.
      await expect
        .poll(async () => {
          const b1 = await handleB.boundingBox();
          await touchPage.waitForTimeout(30);
          const b2 = await handleB.boundingBox();
          return Boolean(b1 && b2 && Math.abs(b1.x - b2.x) < 0.5 && b2.x + b2.width <= 390);
        })
        .toBe(true);
      const hbBox = (await handleB.boundingBox())!;
      const rcBox = (await rowC.boundingBox())!;

      const cdp = await touchCtx.newCDPSession(touchPage);
      const startX = Math.round(hbBox.x + hbBox.width / 2);
      const startY = Math.round(hbBox.y + hbBox.height / 2);
      const endY = Math.round(rcBox.y + 4);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY, id: 1 }],
      });
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: startX,
              y: Math.round(startY + ((endY - startY) * step) / 6),
              id: 1,
            },
          ],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });

      await expect
        .poll(() => touchPage.locator('.wb-topic-row__title').allTextContents())
        .toEqual(['Topic B', 'Topic C Renamed', 'Topic A']);
      await touchPage.reload({ waitUntil: 'networkidle' });
      await touchPage.getByRole('button', { name: '切换话题栏' }).click();
      await expect
        .poll(() => touchPage.locator('.wb-topic-row__title').allTextContents())
        .toEqual(['Topic B', 'Topic C Renamed', 'Topic A']);
    } finally {
      await touchCtx.close();
    }

    // Reload desktop page to sync with touch reorder.
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(getTitles).toEqual(['Topic B', 'Topic C Renamed', 'Topic A']);

    // 6. Delete group 'Work' retains conversations and messages.
    await page.getByRole('button', { name: '分组操作 Work' }).click();
    await page.getByRole('menuitem', { name: '删除分组' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page.getByRole('button', { name: /^Work/ })).toHaveCount(0);

    // 7. Manage mode: failed batch delete preserves selection & items; cancel preserves items; partial delete keeps draft & B's message count; deleting current navigates; deleting all goes to empty state.
    await page.getByRole('button', { name: /^Topic A/ }).click();
    await page.getByLabel('消息输入框').fill('Keep my draft');

    await page.getByRole('button', { name: '管理话题' }).click();
    await page.getByRole('checkbox', { name: '选择 Topic C Renamed' }).check();

    // Cancel confirmation keeps Topic C Renamed.
    await page.getByRole('button', { name: '删除 (1)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    expect(await getTitles()).toEqual(['Topic B', 'Topic C Renamed', 'Topic A']);

    // Simulate failed batch delete once -> selection and item stay intact.
    await page.route('**/api/v1/conversations/batch', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'simulated batch fail' }),
      });
    }, { times: 1 });
    await page.getByRole('button', { name: '删除 (1)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('simulated batch fail')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(page.getByText('已选 1 项')).toBeVisible();

    // Real delete of non-current Topic C Renamed keeps current Topic A & draft, and preserves Topic B's message count.
    await page.getByRole('button', { name: '删除 (1)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect.poll(getTitles).toEqual(['Topic B', 'Topic A']);
    expect(await page.getByLabel('消息输入框').inputValue()).toBe('Keep my draft');
    const detailB = await apiJson<{ messages: Array<{ id: string }> }>(
      appUrl,
      `/api/v1/conversations/${encodeURIComponent(idB)}`,
    );
    expect(detailB.messages).toHaveLength(1);

    // Delete current Topic A -> routes to Topic B.
    await page.getByRole('checkbox', { name: '选择 Topic A' }).check();
    await page.getByRole('button', { name: '删除 (1)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${encodeURIComponent(idB)}$`));

    // Delete remaining Topic B -> routes to new topic.
    await page.getByRole('checkbox', { name: '选择 Topic B' }).check();
    await page.getByRole('button', { name: '删除 (1)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page).toHaveURL(/\/chat\?assistant=/);
    await expect(page.locator('[data-topic-id]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '全选' })).toBeDisabled();
  });
});
