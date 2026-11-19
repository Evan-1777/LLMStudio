import { connectWithToken, expect, seedMockProviderViaApi, test } from './fixtures';

test('keeps the composer within the visible mobile viewport without changing drafts, attachments, or zoom', async ({ appUrl, upstream, browser }) => {
  await seedMockProviderViaApi(appUrl, upstream.url);
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      // Simulate platforms which resize only the visual viewport when opening the keyboard.
      const viewport = new EventTarget();
      Object.assign(viewport, { height: window.innerHeight, scale: 1, offsetTop: 0 });
      Object.defineProperty(window, 'visualViewport', { value: viewport });
    });
    await connectWithToken(page, appUrl);
    const shell = page.locator('.wb-shell');
    const input = page.getByRole('textbox', { name: '消息输入框' });
    const send = page.getByRole('button', { name: '发送消息' });
    const history = Array.from({ length: 36 }, (_, i) => 'History ' + i).join('\n');
    await input.fill(history);
    await send.click();
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();
    const distanceFromBottom = () => page.locator('.wb-chat-scroll').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
    const draft = Array.from({ length: 25 }, (_, i) => '换行草稿 ' + i).join('\n');
    await input.fill(draft);
    await page.locator('.wb-composer input[type=file]').setInputFiles({
      name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Retained attachment'),
    });
    await expect(page.getByText('draft.txt', { exact: true })).toBeVisible();
    await page.locator('.wb-chat-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2);
    await input.focus();
    await expect(input).toHaveCSS('font-size', '16px');
    const resize = (height: number, offsetTop = 0, scale = 1, type = 'resize') => page.evaluate((args) => {
      const viewport = window.visualViewport!;
      Object.assign(viewport, args.values);
      viewport.dispatchEvent(new Event(args.type));
    }, { values: { height, offsetTop, scale }, type });
    const metrics = () => shell.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    });
    const expectComposerInside = async (bottom: number) => {
      for (const control of [input, send, page.getByRole('button', { name: '添加附件' })]) {
        const rect = await control.boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(bottom);
      }
      expect(await input.evaluate(el => el.scrollHeight)).toBeGreaterThan(await input.evaluate(el => el.clientHeight));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    };

    await resize(405, 24);
    await expect.poll(metrics).toEqual({ top: 24, bottom: 429, height: 405 });
    await expectComposerInside(429);
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2);
    await resize(405, 52, 1, 'scroll');
    await expect.poll(metrics).toEqual({ top: 52, bottom: 457, height: 405 });
    await expectComposerInside(457);
    // Browser zoom and focus loss must restore native layout.
    await resize(390, 30, 1.4);
    await expect.poll(metrics).toEqual({ top: 0, bottom: 812, height: 812 });
    await resize(405, 24);
    await expect.poll(metrics).toEqual({ top: 24, bottom: 429, height: 405 });
    await input.blur();
    await expect.poll(metrics).toEqual({ top: 0, bottom: 812, height: 812 });
    await input.focus();
    await resize(812);
    await expect.poll(metrics).toEqual({ top: 0, bottom: 812, height: 812 });
    await page.setViewportSize({ width: 812, height: 375 });
    await resize(375); // Native layout already shrank to the available height.
    await expect.poll(metrics).toEqual({ top: 0, bottom: 375, height: 375 });
    await resize(270, 4);
    await expect.poll(metrics).toEqual({ top: 4, bottom: 274, height: 270 });
    await expectComposerInside(274);
    await expect(input).toHaveValue(draft);
    await expect(input).toBeFocused();
    await expect(page.getByText('draft.txt', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
