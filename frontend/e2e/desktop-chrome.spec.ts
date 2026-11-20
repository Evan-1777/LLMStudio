import { connectWithToken, expect, test } from './fixtures';

const TITLEBAR_HEIGHT = 32;

async function applyDesktopChrome(page: import('@playwright/test').Page) {
  await page.evaluate((height) => {
    const root = document.documentElement;
    root.dataset.desktop = 'true';
    root.style.setProperty('--mygo-titlebar-height', `${height}px`);
    root.style.setProperty('--mygo-titlebar-inset-left', '0px');
    root.style.setProperty('--mygo-titlebar-inset-right', '138px');
  }, TITLEBAR_HEIGHT);
}

test('keeps the desktop title band above workbench and settings at every breakpoint', async ({
  page,
  appUrl,
}) => {
  await connectWithToken(page, appUrl);

  for (const width of [820, 1199, 1200, 1266, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await applyDesktopChrome(page);

    const titlebar = page.getByTestId('desktop-titlebar');
    await expect(titlebar).toBeVisible();
    const titlebarBox = (await titlebar.boundingBox())!;
    expect(Math.round(titlebarBox.y)).toBe(0);
    expect(Math.round(titlebarBox.height)).toBe(TITLEBAR_HEIGHT);

    const toolbar = (await page.locator('.wb-toolbar').boundingBox())!;
    const railHead = (await page.locator('.wb-rail__head').boundingBox())!;
    expect(toolbar.y).toBeGreaterThanOrEqual(titlebarBox.y + titlebarBox.height - 0.5);
    expect(railHead.y).toBeGreaterThanOrEqual(titlebarBox.y + titlebarBox.height - 0.5);

    if (width < 1200) {
      await page.getByRole('button', { name: '切换话题栏' }).click();
    }
    const history = page.locator('.wb-history');
    await expect(history).toBeVisible();
    const historyHead = (await history.locator('.wb-history__head').boundingBox())!;
    expect(historyHead.y).toBeGreaterThanOrEqual(
      titlebarBox.y + titlebarBox.height - 0.5,
    );
    if (width < 1200) {
      await page.keyboard.press('Escape');
      await expect(history).toBeHidden();
    }

    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '外观与显示' })).toBeVisible();
    const settingsToolbar = (await page.locator('.st-toolbar').boundingBox())!;
    expect(settingsToolbar.y).toBeGreaterThanOrEqual(
      titlebarBox.y + titlebarBox.height - 0.5,
    );
    await expect(page.getByTestId('desktop-titlebar')).toHaveCount(1);

    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.getByLabel('消息输入框')).toBeVisible();
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--mygo-titlebar-height', '0px');
  });
  await expect(page.getByTestId('desktop-titlebar')).toBeHidden();
  const fullscreenShell = (await page.locator('.wb-shell').boundingBox())!;
  expect(Math.round(fullscreenShell.y)).toBe(0);
  expect(Math.round(fullscreenShell.height)).toBe(800);

  await page.evaluate(() => {
    const root = document.documentElement;
    root.removeAttribute('data-desktop');
    root.style.removeProperty('--mygo-titlebar-height');
    root.style.removeProperty('--mygo-titlebar-inset-left');
    root.style.removeProperty('--mygo-titlebar-inset-right');
  });
  await expect(page.getByTestId('desktop-titlebar')).toBeHidden();
  const shell = (await page.locator('.wb-shell').boundingBox())!;
  expect(Math.round(shell.y)).toBe(0);
  expect(Math.round(shell.height)).toBe(800);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <=
        document.documentElement.clientHeight,
    ),
  ).toBe(true);
});
