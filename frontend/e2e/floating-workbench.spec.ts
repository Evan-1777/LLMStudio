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
  const assistantMsg = await write<{ message: { id: string } }>(
    `conversations/${ids[0]}/messages`,
    { role: 'assistant', blocks: [{ type: 'text', text: '发布清单已整理。桌面与移动端的验证记录可在工作记录分组中查看。' }] },
  );
  await write(
    `conversations/${ids[0]}/graph`,
    { op: 'createBranch', parentMessageId: assistantMsg.message.id, x: 320, y: 120, activate: true },
    'PATCH',
  );

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
      await page.getByRole('button', { name: /^工作记录/ }).click();
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
          return Math.min(...Array.from(document.querySelectorAll('.wb-eyebrow, .wb-nav-row--active .wb-nav-row__btn, .wb-topic-group__toggle, .wb-topic-row__time, .wb-topic-row__title, .wb-assistant-pill, .wb-branch-badge, .wb-model-btn, .wb-asst-name, .wb-asst-tag, .wb-user-bubble, .prose')).filter(el => el.checkVisibility({ visibilityProperty: true })).map(el => {
            const panel = el.closest('.wb-rail, .wb-history, .wb-main')!;
            const layer = el.closest('.wb-topic-row, .wb-nav-row, .wb-toolbar, .wb-user-bubble');
            const colors = [root.getPropertyValue('--bg-base'), getComputedStyle(panel).backgroundColor];
            if (layer) colors.push(getComputedStyle(layer).backgroundColor);
            if (el.matches('.wb-asst-tag, .wb-branch-badge')) colors.push(getComputedStyle(el).backgroundColor);
            const background = luminance(pixel(...colors));
            const foreground = luminance(pixel(getComputedStyle(el).color));
            return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
          }));
        });
        expect(minContrast).toBeGreaterThanOrEqual(4.5);
        if (width < 768) {
          const mainBox = (await page.locator('.wb-main').boundingBox())!;
          await expect(page.locator('.wb-main')).toHaveCSS('border-radius', '0px');
          expect(Math.round(mainBox.x)).toBe(0);
          expect(Math.round(mainBox.width)).toBe(width);
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
          const mainEl = page.locator('.wb-main');
          const main = (await mainEl.boundingBox())!;
          const h = (await history.boundingBox())!;
          await expect(mainEl).toHaveCSS('border-radius', '12px');
          expect(a.x).toBeGreaterThanOrEqual(12);
          expect(main.x - a.x - a.width).toBeGreaterThanOrEqual(12);
          expect(h.x - main.x - main.width).toBeGreaterThanOrEqual(12);
          expect(Math.abs(a.y - main.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(h.y - main.y)).toBeLessThanOrEqual(1);
          expect(Math.abs((a.y + a.height) - (main.y + main.height))).toBeLessThanOrEqual(1);
          expect(Math.abs((h.y + h.height) - (main.y + main.height))).toBeLessThanOrEqual(1);

          const railHead = (await page.locator('.wb-rail__head').boundingBox())!;
          const toolbar = (await page.locator('.wb-toolbar').boundingBox())!;
          const historyHead = (await page.locator('.wb-history__head').boundingBox())!;
          expect(Math.abs(railHead.height - 48)).toBeLessThanOrEqual(1);
          expect(Math.abs(toolbar.height - 48)).toBeLessThanOrEqual(1);
          expect(Math.abs(historyHead.height - 48)).toBeLessThanOrEqual(1);
          expect(Math.abs(railHead.y - toolbar.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(historyHead.y - toolbar.y)).toBeLessThanOrEqual(1);

          // Unified 8px radius and 32px height across desktop toolbar & composer auxiliary controls.
          for (const selector of [
            '.wb-assistant-pill',
            '.wb-branch-badge',
            '.wb-graph-toggle',
            '.wb-composer__tools > .ui-icon-btn--sm',
            '.wb-ctx-ring-btn',
          ]) {
            const el = page.locator(selector).first();
            await expect(el).toBeVisible();
            await expect(el).toHaveCSS('border-radius', '8px');
            const box = (await el.boundingBox())!;
            expect(Math.abs(box.height - 32)).toBeLessThanOrEqual(1);
          }

          await left.click();
          await expect(rail).toBeHidden();
          const collapsedLeftMain = (await mainEl.boundingBox())!;
          expect(collapsedLeftMain.x).toBeLessThan(main.x);
          expect(Math.abs(collapsedLeftMain.x - 12)).toBeLessThanOrEqual(1);

          await right.click();
          await expect(history).toBeHidden();
          const collapsedBothMain = (await mainEl.boundingBox())!;
          expect(Math.abs((collapsedBothMain.x + collapsedBothMain.width) - (width - 12))).toBeLessThanOrEqual(1);

          await right.click();
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
      if (!baseline && width < 768) {
        // Verify compact top bar secondary menu & composer inline tool drawer in both light/dark + reduced motion.
        const moreBtn = page.getByRole('button', { name: '更多话题操作' });
        await expect(moreBtn).toBeVisible();
        await expect(moreBtn).toHaveAttribute('data-has-active', 'true');
        await moreBtn.click();
        const menuDialog = page.getByRole('dialog', { name: '更多话题操作' });
        await expect(menuDialog).toBeVisible();
        await expect(menuDialog.locator('.wb-toolbar-menu__badge')).toBeVisible();
        await expect(menuDialog.getByRole('button', { name: '临时会话' })).toBeVisible();
        await snap('-mobile-menu');
        const menuContrast = await page.evaluate(() => {
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
          const popoverBg = getComputedStyle(document.querySelector('.ui-popover-content')!).backgroundColor;
          const targets = Array.from(document.querySelectorAll('.wb-toolbar-menu__item, .wb-toolbar-menu__badge'));
          return Math.min(...targets.map((el) => {
            const colors = [root.getPropertyValue('--bg-surface'), popoverBg];
            if (el.matches('.wb-toolbar-menu__badge')) colors.push(getComputedStyle(el).backgroundColor);
            const bg = luminance(pixel(...colors));
            const fg = luminance(pixel(getComputedStyle(el).color));
            return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
          }));
        });
        expect(menuContrast).toBeGreaterThanOrEqual(4.5);
        await menuDialog.getByRole('button', { name: '话题参数' }).click();
        await expect(page.getByLabel('系统提示词')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(history).toBeHidden();

        const modelBox = (await page.locator('.wb-model-btn').boundingBox())!;
        expect(modelBox.width).toBeGreaterThanOrEqual(160);
        const drawerToggle = page.getByRole('button', { name: '展开工具' });
        await expect(drawerToggle).toBeVisible();
        await expect(page.locator('.wb-composer-drawer')).toHaveCSS('transition-duration', '0s');
        await expect(drawerToggle.locator('svg')).toHaveCSS('transition-duration', '0s');
        await drawerToggle.click();
        await expect(page.getByRole('button', { name: '添加附件' })).toBeVisible();
        await expect(page.getByRole('button', { name: '开启联网搜索' })).toBeVisible();
        await expect(page.locator('.wb-ctx-ring-btn')).toBeVisible();
        await snap('-mobile-drawer');
        await page.locator('.wb-ctx-ring-btn').click();
        await expect(page.getByRole('dialog', { name: '上下文占用明细' })).toBeVisible();
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.getByRole('button', { name: '收起工具' }).click();
      }
      if (mode === 'dark') await write('settings', { themeMode: 'light' }, 'PATCH');
    } finally {
      await context.close();
    }
  }
});

test('keeps settings floating dual-column stage aligned at desktop, tablet, and mobile', async ({ appUrl, browser }) => {
  for (const [mode, width, height] of [['light', 1280, 800], ['dark', 1280, 800], ['light', 768, 900], ['dark', 375, 812]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1000, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await connectWithToken(page, appUrl);
      if (mode === 'dark') {
        await fetch(`${appUrl}/api/v1/settings`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ themeMode: 'dark' }),
        });
      }
      await page.goto(`${appUrl}/settings/appearance`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      const rail = page.locator('.st-rail');
      const main = page.locator('.st-main');

      if (width >= 768) {
        await expect(rail).toHaveCSS('border-radius', '12px');
        await expect(main).toHaveCSS('border-radius', '12px');
        const railBox = (await rail.boundingBox())!;
        const mainBox = (await main.boundingBox())!;
        expect(Math.abs(railBox.x - 12)).toBeLessThanOrEqual(1);
        expect(Math.abs(mainBox.x - railBox.x - railBox.width - 12)).toBeLessThanOrEqual(1);
        expect(Math.abs(railBox.y - mainBox.y)).toBeLessThanOrEqual(1);
        expect(Math.abs((railBox.y + railBox.height) - (mainBox.y + mainBox.height))).toBeLessThanOrEqual(1);
        const railHead = (await page.locator('.st-rail__head').boundingBox())!;
        const toolbar = (await page.locator('.st-toolbar').boundingBox())!;
        expect(Math.abs(railHead.height - 48)).toBeLessThanOrEqual(1);
        expect(Math.abs(toolbar.height - 48)).toBeLessThanOrEqual(1);
        expect(Math.abs(railHead.y - toolbar.y)).toBeLessThanOrEqual(1);
      } else {
        await expect(main).toHaveCSS('border-radius', '0px');
        const mainBox = (await main.boundingBox())!;
        expect(Math.round(mainBox.x)).toBe(0);
        expect(Math.round(mainBox.width)).toBe(width);
        await expect(rail).toBeHidden();
        await page.getByRole('button', { name: '打开设置分类' }).click();
        await expect(rail).toBeVisible();
        await expect(rail).toHaveCSS('border-radius', '12px');
        expect((await rail.boundingBox())!.x).toBeGreaterThanOrEqual(12);
        await page.keyboard.press('Escape');
        await expect(rail).toBeHidden();
      }

      if (mode === 'dark') {
        await fetch(`${appUrl}/api/v1/settings`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ themeMode: 'light' }),
        });
      }
    } finally {
      await context.close();
    }
  }
});
