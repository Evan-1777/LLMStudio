import {
  connectWithToken,
  expect,
  seedMockProviderViaApi,
  test,
} from './fixtures';

test.describe('Rendering, HTML Sandbox Isolation, and Responsive Navigation', () => {
  test('isolates untrusted HTML iframe from parent DOM/localStorage/spoofed messages and supports narrow viewport navigation', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    const composer = page.getByLabel('消息输入框');
    await composer.fill('[HTML_SANDBOX]');
    await page.getByRole('button', { name: '发送消息' }).click();

    // Markdown heading, table, code block, and HTML sandbox iframe render.
    await expect(page.getByRole('heading', { name: 'Markdown Title' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Safe' })).toBeVisible();
    await expect(page.getByText('export const safe = true;')).toBeVisible();

    const iframe = page.locator('iframe[title="HTML 预览"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

    // Wait briefly for iframe inline script attempt, then verify parent DOM & localStorage are untouched.
    await page.waitForTimeout(150);
    const securityState = await page.evaluate(() => ({
      pwnedAttr: document.body.dataset.pwned ?? null,
      pwnedStorage: localStorage.getItem('pwned'),
    }));
    expect(securityState.pwnedAttr).toBeNull();
    expect(securityState.pwnedStorage).toBeNull();

    // Spoofed postMessage with invalid source/nonce must NOT resize iframe to 9999px.
    const heightBefore = await iframe.evaluate((el) => el.getBoundingClientRect().height);
    await page.evaluate(() => {
      window.postMessage(
        { type: 'llmstudio-html-height', nonce: 'forged-nonce', height: 9999 },
        '*',
      );
    });
    await page.waitForTimeout(80);
    const heightAfter = await iframe.evaluate((el) => el.getBoundingClientRect().height);
    expect(heightAfter).toBeLessThan(700);
    expect(Math.abs(heightAfter - heightBefore)).toBeLessThan(2);

    // Toggle source/preview and fullscreen modal.
    await page.getByRole('button', { name: '查看源码' }).click();
    await expect(page.getByText('<div id="sandbox-card">')).toBeVisible();
    await page.getByRole('button', { name: '预览 HTML' }).click();
    await page.getByRole('button', { name: '全屏预览' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    // Narrow mobile viewport (390x844): drawers, Escape focus restore, composer visible, zero horizontal overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeVisible();

    const leftToggle = page.getByRole('button', { name: '切换助手栏' });
    await leftToggle.click();
    await expect(page.getByRole('navigation', { name: '助手列表' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(leftToggle).toBeFocused();

    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    expect(overflow.scrollW).toBeLessThanOrEqual(overflow.innerW);
  });
});
