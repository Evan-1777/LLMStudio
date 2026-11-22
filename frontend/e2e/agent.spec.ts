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
  const openTrace = () => page.getByRole('button', { name: /工具调用 · 第 1 轮.*完成/ }).click();
  await openTrace();
  await expect(page.getByText('原生 ·', { exact: true })).toBeVisible();
  const topicUrl = page.url();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Agent', exact: true })).toBeChecked();
  await openTrace();
  await expect(page.getByText('原生 ·', { exact: true })).toBeVisible();
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
