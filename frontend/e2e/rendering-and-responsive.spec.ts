import type { Locator } from '@playwright/test';
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

  test('drives inline HTML preview height from the document content instead of the iframe viewport', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    const composer = page.getByLabel('消息输入框');
    const frameHeight = (locator: Locator) =>
      locator.evaluate((el) => el.getBoundingClientRect().height);
    const frameContentHeight = async (locator: Locator) => {
      const handle = await locator.elementHandle();
      const frame = await handle?.contentFrame();
      if (!frame) throw new Error('sandboxed frame is not available');
      return frame.evaluate(() => {
        const body = document.body;
        const rect = body.getBoundingClientRect();
        const bodyStyle = getComputedStyle(body);
        let bottom = 0;
        for (const child of Array.from(body.children)) {
          const style = getComputedStyle(child);
          if (style.display === 'none') continue;
          const childRect = child.getBoundingClientRect();
          bottom = Math.max(
            bottom,
            childRect.bottom - rect.top + (parseFloat(style.marginBottom) || 0),
          );
        }
        return Math.ceil(
          bottom +
            (parseFloat(bodyStyle.paddingBottom) || 0) +
            (parseFloat(bodyStyle.marginTop) || 0) +
            (parseFloat(bodyStyle.marginBottom) || 0),
        );
      });
    };

    // 1. Raw HTML: a 514 px document shrinks to 194 px inside the same frame.
    await composer.fill('[HTML_HEIGHT]');
    await page.getByRole('button', { name: '发送消息' }).click();
    const seamless = page.locator('iframe.html-sandbox-frame--seamless');
    await expect(seamless).toHaveCount(1);
    const inlineFrame = seamless.first();
    await expect.poll(() => frameHeight(inlineFrame), { timeout: 6000 }).toBeGreaterThan(480);

    const frameHandle = await inlineFrame.elementHandle();
    const childFrame = await frameHandle?.contentFrame();
    await childFrame?.evaluate(() => {
      (window as unknown as Record<string, unknown>).__heightProbe = 'kept';
    });

    await expect.poll(() => frameHeight(inlineFrame), { timeout: 6000 }).toBeLessThan(240);
    const shrunkHeight = await frameHeight(inlineFrame);
    const contentHeight = await frameContentHeight(inlineFrame);
    expect(Math.abs(shrunkHeight - contentHeight)).toBeLessThanOrEqual(2);
    expect(
      await childFrame?.evaluate(
        () => (window as unknown as Record<string, unknown>).__heightProbe ?? null,
      ),
    ).toBe('kept');

    // The following prose keeps only the normal stack gap (no stale iframe height).
    const gap = await page.evaluate(() => {
      const article = Array.from(document.querySelectorAll('.wb-asst-msg')).find((el) =>
        el.textContent?.includes('尾部说明'),
      );
      const wrap = article?.querySelector('.html-sandbox-wrap');
      const prose = Array.from(article?.querySelectorAll('.prose') ?? []).find((el) =>
        el.textContent?.includes('尾部说明'),
      );
      if (!wrap || !prose) return -1;
      return prose.getBoundingClientRect().top - wrap.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(40);

    const idleA = await frameHeight(inlineFrame);
    await page.waitForTimeout(1000);
    expect(Math.abs((await frameHeight(inlineFrame)) - idleA)).toBeLessThanOrEqual(1);
    console.log(
      `[HEIGHT] raw iframe=${shrunkHeight.toFixed(1)} content=${contentHeight} idleDelta=${(
        (await frameHeight(inlineFrame)) - idleA
      ).toFixed(1)}`,
    );

    // The same measurement keeps working in the feed layout.
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('radio', { name: '信息流模式' }).click();
    await page.getByRole('button', { name: '返回工作台' }).click();
    const feedFrame = page.locator('iframe.html-sandbox-frame--seamless').first();
    await expect.poll(() => frameHeight(feedFrame), { timeout: 6000 }).toBeGreaterThan(150);
    await expect.poll(() => frameHeight(feedFrame), { timeout: 6000 }).toBeLessThan(240);
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('radio', { name: '气泡模式' }).click();
    await page.getByRole('button', { name: '返回工作台' }).click();

    // 2. Full document with min-height:100vh must follow its content and stay stable.
    await composer.fill('[HTML_HEIGHT_DOC]');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(seamless).toHaveCount(2);
    const docFrame = seamless.nth(1);
    await expect.poll(() => frameHeight(docFrame), { timeout: 6000 }).toBeGreaterThan(380);
    const docHeightA = await frameHeight(docFrame);
    await page.waitForTimeout(1000);
    const docHeightB = await frameHeight(docFrame);
    expect(Math.abs(docHeightB - docHeightA)).toBeLessThanOrEqual(1);
    expect(docHeightB).toBeLessThan(520);

    // 3. Fenced HTML preview switches to the same content-driven height.
    await composer.fill('[HTML_HEIGHT_FENCED]');
    await page.getByRole('button', { name: '发送消息' }).click();
    const fencedMessage = page
      .locator('.wb-asst-msg')
      .filter({ hasText: '围栏高度说明' });
    await fencedMessage.getByRole('button', { name: '预览 HTML' }).click();
    const fencedFrame = fencedMessage.locator('iframe[title="HTML 预览"]');
    await expect(fencedFrame).toBeVisible();
    await expect.poll(() => frameHeight(fencedFrame), { timeout: 6000 }).toBeGreaterThan(300);
    await expect.poll(() => frameHeight(fencedFrame), { timeout: 6000 }).toBeLessThan(220);
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
