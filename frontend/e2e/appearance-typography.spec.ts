import { connectWithToken, expect, seedMockProviderViaApi, test } from './fixtures';

async function openAppearance(page: import('@playwright/test').Page) {
  if (!page.url().includes('/settings/')) {
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: '外观与显示' })).toBeVisible();
}

function centerY(box: { y: number; height: number }) {
  return box.y + box.height / 2;
}

test('keeps the font size slider, value, step buttons and reset on stable tracks', async ({
  page,
  appUrl,
}) => {
  await connectWithToken(page, appUrl);
  await openAppearance(page);

  for (const width of [375, 768, 820, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const controls = page.locator('.st-font-size-controls');
    const minus = (await page.getByRole('button', { name: '减小字号' }).boundingBox())!;
    const value = (await page.locator('.st-font-size-value').boundingBox())!;
    const plus = (await page.getByRole('button', { name: '增大字号' }).boundingBox())!;
    const slider = (await page.getByLabel('字体大小').boundingBox())!;
    const reset = page.getByRole('button', { name: '重置' });

    expect(Math.abs(centerY(minus) - centerY(value))).toBeLessThanOrEqual(2);
    expect(Math.abs(centerY(plus) - centerY(value))).toBeLessThanOrEqual(2);
    expect(minus.x + minus.width).toBeLessThanOrEqual(value.x + 0.5);
    expect(value.x + value.width).toBeLessThanOrEqual(plus.x + 0.5);
    expect(slider.width).toBeGreaterThan(40);
    await expect(reset).toBeVisible();
    await expect(reset).toBeDisabled();
    const resetBox = (await reset.boundingBox())!;

    const controlsBox = (await controls.boundingBox())!;
    expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(width + 0.5);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.getByRole('button', { name: '减小字号' }).click();
    await page.getByRole('button', { name: '减小字号' }).click();
    await expect(page.locator('.st-font-size-value')).toHaveText('12 px');
    await expect(page.getByRole('button', { name: '减小字号' })).toBeDisabled();

    const range = page.getByLabel('字体大小');
    await range.focus();
    await range.press('End');
    await expect(page.locator('.st-font-size-value')).toHaveText('22 px');
    await expect(page.getByRole('button', { name: '增大字号' })).toBeDisabled();
    await expect(reset).toBeEnabled();
    const resetBoxAfter = (await reset.boundingBox())!;
    expect(Math.abs(resetBoxAfter.x - resetBox.x)).toBeLessThanOrEqual(1);

    await reset.click();
    await expect(page.locator('.st-font-size-value')).toHaveText('14 px');
    await expect(reset).toBeDisabled();
  }
});

test('persists the default new-topic mode and remembers the last selected model', async ({ appUrl, upstream, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Mock Chat/ }).click();
  await expect(page.getByRole('button', { name: '选择模型' })).toContainText('Mock Chat');

  await page.getByRole('button', { name: '新建话题' }).click();
  await expect(page.getByRole('button', { name: '选择模型' })).toContainText('Mock Chat');

  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const modeGroup = page.getByRole('radiogroup', { name: '默认新建话题' });
  await modeGroup.getByRole('radio', { name: 'Agent' }).click();
  await expect(modeGroup.getByRole('radio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: '返回工作台' }).click();
  await page.getByRole('button', { name: '新建话题' }).click();
  await expect(
    page.getByRole('radiogroup', { name: '话题模式' }).getByRole('radio', { name: 'Agent' }),
  ).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await expect(
    page.getByRole('radiogroup', { name: '话题模式' }).getByRole('radio', { name: 'Agent' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: '选择模型' })).toContainText('Mock Chat');
});
