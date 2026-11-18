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
    const frameGeometry = async (locator: Locator, tailSelector: string) => {
      const handle = await locator.elementHandle();
      const frame = await handle?.contentFrame();
      if (!frame) throw new Error('sandboxed frame is not available');
      return frame.evaluate((sel) => {
        const se = document.scrollingElement;
        const tail = document.querySelector(sel);
        if (!se || !tail) {
          return {
            scrollHeight: 0,
            clientHeight: 0,
            scrollWidth: 0,
            clientWidth: 0,
            tailBottom: -1,
            tailRight: -1,
          };
        }
        const tailRect = tail.getBoundingClientRect();
        return {
          scrollHeight: se.scrollHeight,
          clientHeight: se.clientHeight,
          scrollWidth: se.scrollWidth,
          clientWidth: se.clientWidth,
          tailBottom: tailRect.bottom,
          tailRight: tailRect.right,
        };
      }, tailSelector);
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
    const shrunkGeo = await frameGeometry(inlineFrame, '#height-tail');
    expect(shrunkGeo.scrollHeight).toBeLessThanOrEqual(shrunkGeo.clientHeight + 1);
    expect(shrunkGeo.scrollWidth).toBeLessThanOrEqual(shrunkGeo.clientWidth + 1);
    expect(shrunkGeo.tailBottom).toBeGreaterThan(170);
    expect(shrunkGeo.tailBottom).toBeLessThanOrEqual(shrunkGeo.clientHeight + 1);
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
      `[HEIGHT] raw iframe=${shrunkHeight.toFixed(1)} tailBottom=${shrunkGeo.tailBottom.toFixed(1)} idleDelta=${(
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

    // 3. Fenced HTML preview preserves html+body padding (340 px) before shrinking to 160 px.
    await composer.fill('[HTML_HEIGHT_FENCED]');
    await page.getByRole('button', { name: '发送消息' }).click();
    const fencedMessage = page
      .locator('.wb-asst-msg')
      .filter({ hasText: '围栏高度说明' });
    await fencedMessage.getByRole('button', { name: '预览 HTML' }).click();
    const fencedFrame = fencedMessage.locator('iframe[title="HTML 预览"]');
    await expect(fencedFrame).toBeVisible();
    await expect.poll(() => frameHeight(fencedFrame), { timeout: 6000 }).toBeGreaterThan(300);
    const fencedBeforeShrink = await frameGeometry(fencedFrame, '#fenced-card');
    expect(fencedBeforeShrink.scrollHeight).toBeLessThanOrEqual(
      fencedBeforeShrink.clientHeight + 1,
    );
    expect(fencedBeforeShrink.tailBottom).toBeLessThanOrEqual(
      fencedBeforeShrink.clientHeight + 1,
    );
    await expect.poll(() => frameHeight(fencedFrame), { timeout: 6000 }).toBeLessThan(220);
    const fencedAfterShrink = await frameGeometry(fencedFrame, '#fenced-card');
    expect(fencedAfterShrink.scrollHeight).toBeLessThanOrEqual(
      fencedAfterShrink.clientHeight + 1,
    );

    // 4. Raw HTML >680 px with nested absolute tail and 600 px block expands & reflows without rebuilding on 390 px.
    await composer.fill('[HTML_ADAPTIVE]');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(seamless).toHaveCount(3);
    const adaptiveFrame = seamless.nth(2);
    // The fixture parks child animation frames until the first height arrives.
    await expect.poll(() => frameHeight(adaptiveFrame), { timeout: 6000 }).toBeGreaterThan(900);
    await adaptiveFrame.contentFrame().locator('#adaptive-card').evaluate((card) => {
      card.ownerDocument.dispatchEvent(new Event('resume-preview-frames'));
    });

    const adaptiveDesktopGeo = await frameGeometry(adaptiveFrame, '#nested-tail');
    expect(adaptiveDesktopGeo.scrollHeight).toBeLessThanOrEqual(
      adaptiveDesktopGeo.clientHeight + 1,
    );
    expect(adaptiveDesktopGeo.scrollWidth).toBeLessThanOrEqual(
      adaptiveDesktopGeo.clientWidth + 1,
    );
    expect(adaptiveDesktopGeo.tailBottom).toBeLessThanOrEqual(
      adaptiveDesktopGeo.clientHeight + 1,
    );
    expect(adaptiveDesktopGeo.tailRight).toBeLessThanOrEqual(
      adaptiveDesktopGeo.clientWidth + 1,
    );

    // Scroll outer chat container to verify the tail and following prose are reachable.
    const trailingProse = page.getByText('自适应尾部说明');
    await trailingProse.scrollIntoViewIfNeeded();
    await expect(trailingProse).toBeVisible();
    const adaptiveFrameBox = await adaptiveFrame.boundingBox();
    expect(adaptiveFrameBox).not.toBeNull();
    expect(adaptiveFrameBox!.y + adaptiveFrameBox!.height).toBeLessThanOrEqual(801);
    const adaptiveHandle = await adaptiveFrame.elementHandle();
    const adaptiveChild = await adaptiveHandle?.contentFrame();
    if (!adaptiveChild) throw new Error('adaptive child frame missing');
    await adaptiveChild.evaluate(() => {
      (window as unknown as Record<string, unknown>).__adaptiveProbe = 'kept';
    });
    const tailInFrameViewport = await adaptiveChild
      .locator('#nested-tail')
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.bottom <= window.innerHeight + 1;
      });
    expect(tailInFrameViewport).toBe(true);

    // Resize to 390 px narrow mobile viewport: same iframe reflows with zero horizontal overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(
        async () => {
          const g = await frameGeometry(adaptiveFrame, '#nested-tail');
          return g.clientWidth <= 370 && g.scrollWidth <= g.clientWidth + 1;
        },
        { timeout: 6000 },
      )
      .toBe(true);

    const adaptiveMobileGeo = await frameGeometry(adaptiveFrame, '#nested-tail');
    expect(adaptiveMobileGeo.scrollHeight).toBeLessThanOrEqual(
      adaptiveMobileGeo.clientHeight + 1,
    );
    expect(adaptiveMobileGeo.tailBottom).toBeLessThanOrEqual(
      adaptiveMobileGeo.clientHeight + 1,
    );
    expect(adaptiveMobileGeo.tailRight).toBeLessThanOrEqual(
      adaptiveMobileGeo.clientWidth + 1,
    );
    const mobileMetrics = await adaptiveChild.evaluate(() => {
      const card = document.getElementById('adaptive-card')!.getBoundingClientRect();
      const svg = document.getElementById('adaptive-svg')!.getBoundingClientRect();
      return {
        probe: (window as unknown as Record<string, unknown>).__adaptiveProbe ?? null,
        clientW: document.scrollingElement!.clientWidth,
        cardW: card.width,
        svgW: svg.width,
        svgRatio: svg.width / svg.height,
      };
    });
    expect(mobileMetrics.probe).toBe('kept');
    expect(mobileMetrics.cardW).toBeLessThanOrEqual(mobileMetrics.clientW + 1);
    expect(mobileMetrics.svgW).toBeLessThanOrEqual(mobileMetrics.clientW + 1);
    expect(Math.abs(mobileMetrics.svgRatio - 3)).toBeLessThan(0.1);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(pageOverflow).toBe(true);

    // 5. Inline preview caps at 8192 px with native scroll to tail; fullscreen keeps modal viewport height.
    await page.setViewportSize({ width: 1280, height: 800 });
    await composer.fill('[HTML_TALL_CAP]');
    await page.getByRole('button', { name: '发送消息' }).click();
    const tallMessage = page
      .locator('.wb-asst-msg')
      .filter({ hasText: '超长上限说明' });
    await tallMessage.getByRole('button', { name: '预览 HTML' }).click();
    const tallFrame = tallMessage.locator('iframe[title="HTML 预览"]');
    await expect(tallFrame).toBeVisible();
    await expect.poll(() => frameHeight(tallFrame), { timeout: 6000 }).toBeGreaterThan(8000);
    expect(await frameHeight(tallFrame)).toBeLessThanOrEqual(8192);
    const tallHandle = await tallFrame.elementHandle();
    const tallChild = await tallHandle?.contentFrame();
    if (!tallChild) throw new Error('tall child frame missing');
    const inlineTailReachable = await tallChild.evaluate(() => {
      const se = document.scrollingElement!;
      const canScroll = se.scrollHeight > se.clientHeight;
      document.getElementById('tall-tail')!.scrollIntoView();
      const r = document.getElementById('tall-tail')!.getBoundingClientRect();
      return canScroll && r.bottom <= se.clientHeight + 1 && r.top >= -1;
    });
    expect(inlineTailReachable).toBe(true);

    await tallMessage.getByRole('button', { name: '全屏预览' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const fullFrame = dialog.locator('iframe[title="HTML 预览"]');
    await expect(fullFrame).toBeVisible();
    const fullH = await frameHeight(fullFrame);
    expect(fullH).toBeLessThanOrEqual(800 * 0.7 + 2);
    expect(fullH).toBeLessThanOrEqual(641);
    const fullHandle = await fullFrame.elementHandle();
    const fullChild = await fullHandle?.contentFrame();
    if (!fullChild) throw new Error('fullscreen child frame missing');
    const fullTailReachable = await fullChild.evaluate(() => {
      const se = document.scrollingElement!;
      const canScroll = se.scrollHeight > se.clientHeight;
      document.getElementById('tall-tail')!.scrollIntoView();
      const r = document.getElementById('tall-tail')!.getBoundingClientRect();
      return canScroll && r.bottom <= se.clientHeight + 1 && r.top >= -1;
    });
    expect(fullTailReachable).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
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
