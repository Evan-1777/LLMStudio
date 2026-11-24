import { connectWithToken, E2E_TOKEN, expect, seedMockProviderViaApi, test } from './fixtures';

test('selects a workspace with the keyboard, reads the first turn and retains policy when the entry is hidden', async ({ page, appUrl, upstream }) => {
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: '执行端' })).toHaveCount(0);
  const readSwitch = page.getByRole('switch', { name: '读取文件' });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await expect(readSwitch).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  }
  await expect(readSwitch).not.toBeChecked();
  await readSwitch.click();
  await expect(readSwitch).toBeChecked();

  const selectDirectory = page.getByRole('button', { name: '选择工作目录' });
  await selectDirectory.click();
  const dialog = page.getByRole('dialog', { name: '选择工作目录' });
  await expect(dialog.locator('input')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'project' }).press('Enter');
  await dialog.getByRole('button', { name: 'empty' }).press('Enter');
  await expect(dialog.getByText('没有子目录')).toBeVisible();
  await dialog.getByRole('button', { name: '选择', exact: true }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(selectDirectory).toBeFocused();
  await expect(page.getByText('project/empty', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '返回工作台' }).click();
  await page.getByRole('radio', { name: 'Agent', exact: true }).press('Space');
  await expect(page.getByText('网关执行', { exact: true })).toBeVisible();
  await selectDirectory.click();
  await dialog.getByRole('button', { name: 'project' }).click();
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('project', { exact: true })).toBeVisible();
  await selectDirectory.click();
  await expect(dialog.getByRole('button', { name: 'empty' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('project', { exact: true })).toBeVisible();

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await expect(page.getByRole('radiogroup', { name: '话题模式' })).toBeInViewport();
      await expect(selectDirectory).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  }

  const composer = page.getByLabel('消息输入框');
  await composer.fill('[AGENT_READ]');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText(/Agent verified: .*browser-agent-sentinel/)).toBeVisible();
  const readStep = page.getByRole('button', { name: /read.*note\.txt.*原生/ });
  await expect(readStep).toBeVisible();
  await expect(readStep).toHaveAttribute('aria-expanded', 'false');
  await readStep.click();
  await expect(readStep).toHaveAttribute('aria-expanded', 'true');
  const topicUrl = page.url();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Agent', exact: true })).toBeChecked();
  await expect(readStep).toBeVisible();
  await expect(page.getByText('project', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(readSwitch).toBeChecked();
  await page.getByRole('switch', { name: '显示模式切换' }).click();
  const settings = await page.request.get(appUrl + '/api/v1/agent/settings', { headers: { Authorization: 'Bearer ' + E2E_TOKEN } });
  expect((await settings.json()).allowedTools).toEqual(['read']);
  await page.goto(topicUrl);
  await expect(page.getByRole('radiogroup', { name: '话题模式' })).toHaveCount(0);
  await expect(page.getByText('网关执行', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除话题目录覆写' }).click();
  await expect(page.getByText('project/empty', { exact: true })).toBeVisible();
});

test('selects a gateway folder by touch on a phone viewport', async ({ browser, appUrl }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await connectWithToken(page, appUrl);
    await page.getByRole('radio', { name: 'Agent', exact: true }).tap();
    await page.getByRole('button', { name: '选择工作目录' }).tap();
    const dialog = page.getByRole('dialog', { name: '选择工作目录' });
    await dialog.getByRole('button', { name: 'project' }).tap();
    await dialog.getByRole('button', { name: '选择', exact: true }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('project', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('continues running Agent conversation in background across navigation, reconnects on reload, and stops only on explicit stop', async ({
  page,
  appUrl,
  upstream,
}) => {
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);

  // Enable read tool and select project directory.
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const readSwitch = page.getByRole('switch', { name: '读取文件' });
  if (!(await readSwitch.isChecked())) {
    await readSwitch.click();
    await expect(readSwitch).toBeChecked();
  }
  await page.getByRole('button', { name: '选择工作目录' }).click();
  const dirDialog = page.getByRole('dialog', { name: '选择工作目录' });
  await dirDialog.getByRole('button', { name: 'project' }).click();
  await dirDialog.getByRole('button', { name: '选择', exact: true }).click();
  await expect(dirDialog).toBeHidden();
  await page.getByRole('button', { name: '返回工作台' }).click();

  // Case A: Start background Agent run, switch to new topic and Settings while running, release gate, and verify completion.
  await page.getByRole('radio', { name: 'Agent', exact: true }).click();
  const gateEnteredA = upstream.armFirstByteGate();
  await page.getByLabel('消息输入框').fill('[AGENT_BG_RUN] case A');
  await page.getByRole('button', { name: '发送消息' }).click();
  await gateEnteredA;

  const agentTopicUrl = page.url();
  await expect(page.locator('.wb-topic-running')).toBeVisible();

  // Leave topic -> start new topic -> visit Settings: backend run must NOT be canceled.
  await page.getByRole('button', { name: '新建话题' }).click();
  await expect(page.locator('.wb-topic-running')).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByRole('button', { name: '返回工作台' })).toBeVisible();
  expect(upstream.abortedCount).toBe(0);

  // Release gate while away on Settings page so Agent finishes in background.
  upstream.releaseFirstByteGate();
  await page.getByRole('button', { name: '返回工作台' }).click();
  await page.goto(agentTopicUrl);

  await expect(page.getByText(/Background Agent verified: .*browser-agent-sentinel/)).toBeVisible();
  const timelineBtn = page.getByRole('button', { name: /思考与工具 · 1 次 · 完成/ });
  await expect(timelineBtn).toBeVisible();
  await timelineBtn.click();
  await expect(page.getByRole('button', { name: /read.*note\.txt.*原生/ })).toBeVisible();

  // Case B: Start second background Agent run -> reload page -> auto-reconnects -> explicit stop aborts backend run.
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByRole('radio', { name: 'Agent', exact: true }).click();
  const gateEnteredB = upstream.armFirstByteGate();
  await page.getByLabel('消息输入框').fill('[AGENT_BG_RUN] case B');
  await page.getByRole('button', { name: '发送消息' }).click();
  await gateEnteredB;

  // Reload page while Agent is mid-run.
  await page.reload();
  const stopBtn = page.getByRole('button', { name: '停止生成' });
  await expect(stopBtn).toBeVisible();
  await expect(page.getByRole('button', { name: /read.*note\.txt.*原生/ })).toBeVisible();

  // Explicit stop terminates backend upstream and persists aborted status.
  await stopBtn.click();
  await expect.poll(() => upstream.abortedCount).toBeGreaterThanOrEqual(1);
  await expect(stopBtn).toBeHidden();
  await expect(page.getByText('已停止')).toBeVisible();

  await page.reload();
  await expect(page.getByText('已停止')).toBeVisible();
});
