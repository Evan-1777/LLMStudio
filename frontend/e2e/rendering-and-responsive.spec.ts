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

    // 1. Raw unwrapped HTML renders seamlessly (borderless, no card header) by default.
    await composer.fill('[RAW_HTML_VISUAL]');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('前置说明')).toBeVisible();
    const seamlessIframe = page.locator('iframe.html-sandbox-frame--seamless');
    await expect(seamlessIframe).toBeVisible();
    await expect(seamlessIframe).toHaveAttribute('sandbox', 'allow-scripts');

    // 2. Fenced ```html block defaults to code view (defaultHtmlPreview=false) and isolates sandboxed iframe on preview.
    await composer.fill('[HTML_SANDBOX]');
    await page.getByRole('button', { name: '发送消息' }).click();

    // Markdown heading, table, code block render; fenced HTML starts in source mode.
    await expect(page.getByRole('heading', { name: 'Markdown Title' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Safe' })).toBeVisible();
    await expect(page.getByText('export const safe = true;')).toBeVisible();
    await expect(page.getByText('<div id="sandbox-card">')).toBeVisible();

    await page.getByRole('button', { name: '预览 HTML' }).click();

    const iframe = page.locator('iframe[title="HTML 预览"]:not(.html-sandbox-frame--seamless)');
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

  test('bounds long thinking container height with internal scrolling across desktop, tablet, and mobile viewports', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    await page.getByLabel('消息输入框').fill('[LONG_THINKING]');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('Done thinking.')).toBeVisible();

    // Auto-collapsed on completion; open it to inspect height limits & internal scrolling.
    await page.getByRole('button', { name: /思考过程/ }).click();
    const thinkingBody = page.locator('.thinking-body').first();
    await expect(thinkingBody).toBeVisible();

    for (const vp of [
      { width: 1280, height: 800, maxH: 320 },
      { width: 768, height: 1024, maxH: 320 },
      { width: 375, height: 812, maxH: 240 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const metrics = await thinkingBody.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          height: rect.height,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
          pageOverflow:
            document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(metrics.overflowY).toBe('auto');
      expect(metrics.height).toBeLessThanOrEqual(vp.maxH + 1);
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.pageOverflow).toBe(false);
    }
  });
});
