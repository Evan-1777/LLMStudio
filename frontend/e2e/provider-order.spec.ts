import { connectWithToken, E2E_TOKEN, expect, test } from './fixtures';

const names = ['Quartz', 'Slate', 'Birch'];
const endpoint = '**/api/v1/providers/reorder';

async function seedProviders(base: string, upstream: string) {
  for (const name of names) {
    const response = await fetch(`${base}/api/v1/providers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: name.toLowerCase(), name, adapter: 'generic-http', baseURL: upstream,
        authType: 'none', models: [{ id: name, name, apiFormat: 'openai-completions' }],
      }),
    });
    expect(response.ok, await response.text()).toBe(true);
  }
}

test('persists desktop drag and keyboard moves without selecting a provider or clearing its draft', async ({ appUrl, page, upstream }) => {
  await seedProviders(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  await page.getByRole('link', { name: '设置' }).click();
  const nameField = page.getByLabel('名称', { exact: true });
  const order = page.locator('.st-provider-name');
  const slate = page.getByRole('button', { name: 'Slate 1 个模型', exact: true });
  const birch = page.getByRole('button', { name: 'Birch 1 个模型', exact: true });
  const requestBodies: unknown[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/providers/reorder')) requestBodies.push(req.postDataJSON());
  });
  await expect(order).toHaveText(names);
  await slate.click();
  await expect(nameField).toHaveValue('Slate');
  await nameField.fill('Uncommitted Slate');
  const from = (await slate.boundingBox())!;
  const to = (await birch.boundingBox())!;
  const start = async () => {
    await page.mouse.move(from.x + 25, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 25, to.y + to.height - 3, { steps: 5 });
  };
  await start();
  await expect(page.locator('[data-provider-id="birch"]')).toHaveAttribute('data-provider-drop', 'after');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await start();
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await page.getByLabel('搜索供应商').fill('Slate');
  await expect(page.getByRole('button', { name: '调整 Slate 的顺序' })).toBeDisabled();
  await page.getByLabel('搜索供应商').fill('');
  expect(requestBodies).toEqual([]);
  await page.route(endpoint, (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL', message: '排序暂不可用' } }), { times: 1 });
  await start();
  await page.mouse.up();
  await expect(page.getByText('排序暂不可用')).toBeVisible();
  await expect(order).toHaveText(names);
  await start();
  await page.mouse.up();
  await expect(order).toHaveText(['Quartz', 'Birch', 'Slate']);
  expect(requestBodies).toEqual([{ id: 'slate', beforeId: null }, { id: 'slate', beforeId: null }]);
  await expect(nameField).toHaveValue('Uncommitted Slate');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const sortSlate = page.getByRole('button', { name: '调整 Slate 的顺序' });
  await sortSlate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '下移' })).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(order).toHaveText(names);
  await expect(nameField).toHaveValue('Uncommitted Slate');
  await sortSlate.click();
  await page.getByRole('menuitem', { name: '下移' }).click();
  await expect(order).toHaveText(['Quartz', 'Birch', 'Slate']);
  await page.reload();
  await expect(order).toHaveText(['Quartz', 'Birch', 'Slate']);
  await page.getByRole('button', { name: '返回工作台' }).click();
  await page.getByRole('button', { name: '选择模型' }).click();
  await expect(page.getByRole('option')).toHaveText(['Quartz', 'Birch', 'Slate']);
});

test('scrolls the narrow provider strip normally and sorts by horizontal long press', async ({ appUrl, browser, upstream }) => {
  await seedProviders(appUrl, upstream.url);
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await connectWithToken(page, appUrl);
    await page.getByRole('button', { name: '切换助手栏' }).click();
    await page.getByRole('link', { name: '设置' }).click();
    const list = page.locator('.st-provider-scroll');
    await expect(list).toBeVisible();
    const cdp = await context.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y!, id: 1 }] });
    const requestBodies: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/providers/reorder')) requestBodies.push(req.postDataJSON());
    });
    const slate = page.getByRole('button', { name: 'Slate 1 个模型', exact: true });
    const quartz = page.getByRole('button', { name: 'Quartz 1 个模型', exact: true });
    const slateBox = (await slate.boundingBox())!;
    const quartzBox = (await quartz.boundingBox())!;
    const x = Math.round(slateBox.x + 40);
    const y = Math.round(slateBox.y + slateBox.height / 2);
    // Register before swiping: the fling can outlive touchEnd and overwrite the reset.
    const swipe = await list.evaluateHandle((el) => ({
      end: new Promise<void>((resolve) => el.addEventListener('scrollend', () => resolve(), { once: true })),
    }));
    await touch('touchStart', x, y);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x - i * 22, y);
    await touch('touchEnd');
    await expect.poll(() => list.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(requestBodies).toEqual([]);
    await swipe.evaluate(({ end }) => end);
    await swipe.dispose();
    await list.evaluate((el) => { el.scrollLeft = 0; });
    await touch('touchStart', x, y);
    await page.waitForTimeout(370); // Longer than the production long-press threshold.
    const endX = Math.round(quartzBox.x + 15);
    for (let i = 1; i <= 6; i++) await touch('touchMove', Math.round(x + (endX - x) * i / 6), y);
    const marker = page.locator('[data-provider-id="quartz"]');
    await expect(marker).toHaveAttribute('data-provider-drop', 'before');
    expect(await marker.evaluate(el => getComputedStyle(el, '::after').width)).toBe('2px');
    await touch('touchEnd');
    await expect(page.locator('.st-provider-name')).toHaveText(['Slate', 'Quartz', 'Birch']);
    expect(requestBodies).toEqual([{ id: 'slate', beforeId: 'quartz' }]);
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('Quartz');
  } finally {
    await context.close();
  }
});
