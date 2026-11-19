import { resolve } from 'node:path';
import { connectWithToken, E2E_TOKEN, expect, seedMockProviderViaApi, test } from './fixtures';

const capture = process.env.WORKBENCH_CAPTURE;
const baseline = capture === 'baseline';

test('keeps floating rails usable in both themes and at every drawer breakpoint', async ({ appUrl, browser, upstream }) => {
  const providerId = await seedMockProviderViaApi(appUrl, upstream.url);
  const write = async <T,>(path: string, body: unknown, method = 'POST') => {
    const response = await fetch(`${appUrl}/api/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<T>;
  };
  const { group } = await write<{ group: { id: string } }>('conversation-groups', { assistantId: 'default', name: '工作记录' });
  const { group: refs } = await write<{ group: { id: string } }>('conversation-groups', { assistantId: 'default', name: '参考资料' });
  const titles = ['十一月产品评审', '新版本发布前的多端验证与测试环境记录', '接口调用记录'];
  const ids: string[] = [];
  for (const [i, title] of titles.entries()) {
    const { conversation } = await write<{ conversation: { id: string } }>('conversations', { title, providerId, modelId: 'mock-chat' });
    ids.push(conversation.id);
    await write('conversations/batch', { assistantId: 'default', ids: [conversation.id], operation: 'move', groupId: i < 2 ? group.id : refs.id });
  }
  await write(`conversations/${ids[0]}/messages`, { role: 'user', blocks: [{ type: 'text', text: '先核对发布清单与各端测试结果。' }] });
  await write(`conversations/${ids[0]}/messages`, { role: 'assistant', blocks: [{ type: 'text', text: '发布清单已整理。桌面与移动端的验证记录可在工作记录分组中查看。' }] });

  for (const [mode, width, height] of [['light', 1280, 800], ['dark', 1280, 800], ['light', 768, 900], ['dark', 768, 900], ['light', 375, 812], ['dark', 375, 812]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1000, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await connectWithToken(page, appUrl);
      if (mode === 'dark') await write('settings', { themeMode: 'dark' }, 'PATCH');
      await page.goto(`${appUrl}/chat/${ids[0]}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      await expect(page.getByText('先核对发布清单与各端测试结果。')).toBeVisible();
      const left = page.getByRole('button', { name: '切换助手栏' });
      const right = page.getByRole('button', { name: '切换话题栏' });
      const rail = page.locator('.wb-rail');
      const history = page.locator('.wb-history');
      const snap = async (suffix = '') => {
        if (capture) await page.screenshot({ path: resolve('../temp', `workbench-${capture}-${width}-${mode}${suffix}.png`), animations: 'disabled' });
      };
      if (width < 768) {
        await expect(rail).toBeHidden();
        await left.click();
        await expect(rail).toBeVisible();
        await snap('-assistants');
        if (!baseline) expect((await rail.boundingBox())!.x).toBeGreaterThanOrEqual(12);
        await page.keyboard.press('Escape');
        await expect(rail).toBeHidden();
        await expect(left).toBeFocused();
      }
      if (width < 1200) {
        await expect(history).toBeHidden();
        await right.click();
      }
      await expect(history).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp('^' + titles[1]) })).toBeVisible();
      if (width < 768) {
        await page.getByRole('button', { name: '管理话题' }).click();
        await page.getByRole('checkbox', { name: '选择 ' + titles[1] }).check();
        await expect(page.getByRole('checkbox', { name: '选择分区 工作记录' })).toHaveJSProperty('indeterminate', true);
      }
      await snap();
      if (!baseline) {
        if (width < 1200) {
          const rightBox = (await history.boundingBox())!;
          expect(width - rightBox.x - rightBox.width).toBeGreaterThanOrEqual(12);
        }
        await expect(history).toHaveCSS('border-radius', '12px');
        await expect(history).toHaveCSS('transition-duration', '0s');
        await expect(page.locator('[data-drop-bucket="ungrouped"] .wb-topic-section__empty')).toHaveCount(0);
        const minContrast = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const ctx = document.createElement('canvas').getContext('2d')!;
          const pixel = (...colors: string[]) => {
            ctx.clearRect(0, 0, 1, 1);
            for (const color of colors) {
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
            }
            return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
          };
          const luminance = (rgb: number[]) => rgb.reduce((sum, channel, index) => {
            const c = channel / 255;
            return sum + [0.2126, 0.7152, 0.0722][index] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
          }, 0);
          return Math.min(...Array.from(document.querySelectorAll('.wb-eyebrow, .wb-nav-row--active .wb-nav-row__btn, .wb-topic-group__toggle, .wb-topic-row__time, .wb-topic-row__title')).filter(el => el.checkVisibility({ visibilityProperty: true })).map(el => {
            const panel = el.closest('.wb-rail, .wb-history')!;
            const row = el.closest('.wb-topic-row, .wb-nav-row');
            const colors = [root.getPropertyValue('--bg-base'), getComputedStyle(panel).backgroundColor];
            if (row) colors.push(getComputedStyle(row).backgroundColor);
            const background = luminance(pixel(...colors));
            const foreground = luminance(pixel(getComputedStyle(el).color));
            return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
          }));
        });
        expect(minContrast).toBeGreaterThanOrEqual(4.5);
        if (width < 768) {
          expect((await page.getByRole('button', { name: /^工作记录/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: '分组操作 工作记录' }).click();
          await expect(page.getByRole('menuitem', { name: '重命名' })).toBeVisible();
          await page.getByRole('menuitem', { name: '删除分组' }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await page.getByRole('button', { name: '取消', exact: true }).click();
          await expect(history).toBeVisible();
        }
        if (width >= 1200) {
          const a = (await rail.boundingBox())!;
          const main = (await page.locator('.wb-main').boundingBox())!;
          const h = (await history.boundingBox())!;
          expect(a.x).toBeGreaterThanOrEqual(12);
          expect(main.x - a.x - a.width).toBeGreaterThanOrEqual(12);
          expect(h.x - main.x - main.width).toBeGreaterThanOrEqual(12);
          await left.click();
          await expect(rail).toBeHidden();
          expect((await page.locator('.wb-main').boundingBox())!.x).toBeLessThan(main.x);
          await left.click();
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (baseline && width < 768) await page.keyboard.press('Escape'); // exit management before closing drawer
      if (width < 1200) {
        await page.keyboard.press('Escape');
        await expect(history).toBeHidden();
        await expect(right).toBeFocused();
      }
      if (mode === 'dark') await write('settings', { themeMode: 'light' }, 'PATCH');
    } finally {
      await context.close();
    }
  }
});
