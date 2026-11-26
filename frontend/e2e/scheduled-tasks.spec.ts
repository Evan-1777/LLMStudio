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

test.describe('Cloud Agent Scheduled Tasks & Topic Binding', () => {
  test('manages schedules in sidebar tab: create, toggle, edit, runNow creates Agent topic with reply, navigate, and delete', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    await page.getByRole('radio', { name: '定时任务' }).click();
    await expect(page.getByText('暂无定时任务')).toBeVisible();

    await page.getByRole('button', { name: '新建定时任务' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新建定时任务' });
    await dialog.getByLabel('任务名称').fill('E2E 巡检任务');
    await dialog.getByRole('button', { name: '周一' }).click();
    await dialog.getByLabel('提示词').fill('执行云端定时巡检');
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(dialog).toBeHidden();

    const card = page.locator('.sched-card', { hasText: 'E2E 巡检任务' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('周一');

    // Toggle switch off and back on.
    const toggle = card.getByRole('switch');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();

    // Edit task name and time.
    await card.getByRole('button', { name: '编辑 E2E 巡检任务' }).click();
    const editDialog = page.getByRole('dialog', { name: '编辑定时任务' });
    await editDialog.getByLabel('任务名称').fill('E2E 巡检（已编辑）');
    await editDialog.getByRole('button', { name: '保存' }).click();
    await expect(editDialog).toBeHidden();
    const editedCard = page.locator('.sched-card', { hasText: 'E2E 巡检（已编辑）' });
    await expect(editedCard).toBeVisible();

    // Run now -> creates new Agent topic, runs reply, and provides direct link to open it.
    await editedCard.getByRole('button', { name: '立即执行 E2E 巡检（已编辑）' }).click();
    const openLastTopicBtn = editedCard.getByRole('button', { name: '打开最近执行话题' });
    await expect(openLastTopicBtn).toBeVisible();
    await expect(editedCard).toContainText('已成功', { timeout: 10000 });

    await openLastTopicBtn.click();
    await expect(page.getByText(/Reply #\d+ to: 执行云端定时巡检/)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Agent', exact: true })).toBeChecked();

    // Return to schedules tab and delete task.
    await page.getByRole('radio', { name: '定时任务' }).click();
    await editedCard.getByRole('button', { name: '删除 E2E 巡检（已编辑）' }).click();
    await page.getByRole('dialog', { name: '删除定时任务' }).getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('暂无定时任务')).toBeVisible();
  });

  test('binds schedule inside cloud Agent topic, wakes current topic without creating a new one, and hides entry for chat topics', async ({
    appUrl,
    upstream,
    page,
  }) => {
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url);
    const agentConv = await apiJson<{ conversation: { id: string } }>(
      appUrl,
      '/api/v1/conversations',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Bound Agent Target',
          mode: 'agent',
          providerId,
          modelId: 'mock-chat',
        }),
      },
    );
    const chatConv = await apiJson<{ conversation: { id: string } }>(
      appUrl,
      '/api/v1/conversations',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Plain Chat Topic',
          mode: 'chat',
          providerId,
          modelId: 'mock-chat',
        }),
      },
    );

    await connectWithToken(page, appUrl);

    // Chat topic must hide toolbar alarm button.
    await page.getByRole('button', { name: /^Plain Chat Topic/ }).click();
    await expect(page.getByRole('button', { name: '话题定时任务' })).toHaveCount(0);

    // Agent topic shows toolbar alarm button and binds directly to this conversation.
    await page.getByRole('button', { name: /^Bound Agent Target/ }).click();
    await expect(page.getByRole('button', { name: '话题定时任务' })).toBeVisible();
    await page.getByRole('button', { name: '话题定时任务' }).click();
    await page.getByRole('button', { name: '新建绑定任务' }).click();

    const dlg = page.getByRole('dialog', { name: '新建定时任务' });
    await dlg.getByLabel('任务名称').fill('原地唤醒闹钟');
    await dlg.getByLabel('提示词').fill('在当前话题继续分析');
    await dlg.getByRole('button', { name: '创建' }).click();
    await expect(dlg).toBeHidden();

    const alarmBtn = page.getByRole('button', { name: '话题定时任务' });
    await expect(alarmBtn).toHaveAttribute('data-has-active', 'true');
    await alarmBtn.click();
    await expect(page.getByText('原地唤醒闹钟')).toBeVisible();

    await page.getByRole('button', { name: '立即执行 原地唤醒闹钟' }).click();
    await expect(page.getByText(/Reply #\d+ to: 在当前话题继续分析/)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chat/${agentConv.conversation.id}$`));

    const listRes = await apiJson<{ conversations: Array<{ id: string }> }>(
      appUrl,
      '/api/v1/conversations',
    );
    expect(listRes.conversations.map((c) => c.id)).toContain(chatConv.conversation.id);
    expect(listRes.conversations).toHaveLength(2);
  });

  test('executes Agent native schedule tool and persists bound task for the active topic', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    // Enable schedule tool in Agent settings.
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const schedSwitch = page.getByRole('switch', { name: '定时任务' });
    await expect(schedSwitch).toBeVisible();
    if (!(await schedSwitch.isChecked())) {
      await schedSwitch.click();
      await expect(schedSwitch).toBeChecked();
    }

    await page.getByRole('button', { name: '返回工作台' }).click();
    await page.getByRole('radio', { name: 'Agent', exact: true }).click();
    await page.getByLabel('消息输入框').fill('[AGENT_SCHEDULE]');
    await page.getByRole('button', { name: '发送消息' }).click();

    await expect(page.getByText(/Schedule verified:/)).toBeVisible();
    await expect(page.getByRole('button', { name: /schedule.*AI 自动巡检/ })).toBeVisible();

    // Bound task appears directly under toolbar topic schedule popover.
    const alarmBtn = page.getByRole('button', { name: '话题定时任务' });
    await expect(alarmBtn).toHaveAttribute('data-has-active', 'true');
    await alarmBtn.click();
    await expect(
      page.getByRole('dialog', { name: '话题定时任务' }).getByText('AI 自动巡检'),
    ).toBeVisible();
  });

  test('maintains zero horizontal overflow across viewports, themes, and reduced motion', async ({
    appUrl,
    upstream,
    page,
  }) => {
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url);
    const conv = await apiJson<{ conversation: { id: string } }>(
      appUrl,
      '/api/v1/conversations',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Responsive Agent Topic',
          mode: 'agent',
          providerId,
          modelId: 'mock-chat',
        }),
      },
    );
    await apiJson(appUrl, '/api/v1/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: '多端响应式巡检',
        prompt: '输出状态摘要',
        hour: 9,
        minute: 0,
        weekdays: [1, 2, 3, 4, 5],
        timezone: 'Asia/Shanghai',
        bindMode: 'conversation',
        conversationId: conv.conversation.id,
      }),
    });

    await connectWithToken(page, appUrl);
    await page.getByRole('button', { name: /^Responsive Agent Topic/ }).click();

    for (const width of [1280, 768, 375] as const) {
      await page.setViewportSize({ width, height: 800 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });

        if (width < 1200) {
          await page.getByRole('button', { name: '切换话题栏' }).click();
        }
        await page.getByRole('radio', { name: '定时任务' }).click();
        await expect(page.getByText('多端响应式巡检')).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);

        if (width < 1200) {
          if (width < 768) {
            await page.getByRole('button', { name: '关闭定时任务栏' }).click();
            await expect(page.getByRole('button', { name: '更多话题操作' })).toBeVisible();
          } else {
            await page.getByRole('button', { name: '关闭侧栏' }).click();
            await expect(page.getByRole('button', { name: '话题定时任务' })).toBeVisible();
          }
        } else {
          await expect(page.getByRole('button', { name: '话题定时任务' })).toBeVisible();
        }
      }
    }
  });
});
