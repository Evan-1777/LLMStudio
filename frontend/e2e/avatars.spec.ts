import {
  connectWithToken,
  expect,
  seedMockProviderViaApi,
  test,
} from './fixtures';

// 16x16 solid PNGs: blue for the user, orange for the assistant.
const USER_AVATAR = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgqPpPGhrVMKph+GoAAG3QeRBTX5QLAAAAAElFTkSuQmCC',
  'base64',
);
const ASSISTANT_AVATAR = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4P5WBJESa6lENoxqGlAYAxlWUEIE/OMYAAAAASUVORK5CYII=',
  'base64',
);

const PNG_DATA_URL = /^data:image\/png;base64,/;

test.describe('User and assistant avatars', () => {
  test('stores both avatars on the gateway, renders one frame per role in both chat layouts, and clears back to defaults', async ({
    appUrl,
    upstream,
    page,
    browser,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);

    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();
    await page.getByLabel('消息输入框').fill('头像回归消息');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Reply #1 to/)).toBeVisible();
    const conversationUrl = page.url();

    // User avatar: appearance settings saves it through the shared preference entry.
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    const userField = page.locator('.ui-avatar-field').first();
    await page.getByLabel('用户头像文件').setInputFiles({
      name: 'user.png',
      mimeType: 'image/png',
      buffer: USER_AVATAR,
    });
    await expect(userField.locator('img')).toHaveAttribute('src', PNG_DATA_URL);
    await page.setViewportSize({ width: 375, height: 812 });
    const narrowOverflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    expect(narrowOverflow.scrollW).toBeLessThanOrEqual(narrowOverflow.innerW);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Assistant avatar: the editor keeps it in the draft until the form is saved.
    await page.getByRole('button', { name: '返回工作台' }).click();
    await page.locator('.wb-assistant-pill').click();
    const dialog = page.getByRole('dialog');
    await page.getByLabel('助手头像文件').setInputFiles({
      name: 'assistant.png',
      mimeType: 'image/png',
      buffer: ASSISTANT_AVATAR,
    });
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();

    // Bubble layout: user and assistant avatars share the 32 px frame.
    const bubbleUser = page.locator('.wb-user-row .ui-avatar').first();
    const bubbleAssistant = page.locator('.wb-asst-head .ui-avatar').first();
    await expect(bubbleUser.locator('img')).toBeVisible();
    await expect(bubbleAssistant.locator('img')).toBeVisible();
    for (const avatar of [bubbleUser, bubbleAssistant]) {
      const box = await avatar.boundingBox();
      expect(box ? Math.round(box.width) : 0).toBe(32);
      expect(box ? Math.round(box.height) : 0).toBe(32);
    }
    const bubbleRadii = await page.evaluate(() => {
      const user = document.querySelector('.wb-user-row .ui-avatar');
      const assistant = document.querySelector('.wb-asst-head .ui-avatar');
      return [getComputedStyle(user!).borderRadius, getComputedStyle(assistant!).borderRadius];
    });
    expect(bubbleRadii[0]).toBe(bubbleRadii[1]);

    // Feed layout keeps the same frame geometry.
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('radio', { name: '信息流模式' }).click();
    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.locator('.wb-feed-head .ui-avatar')).toHaveCount(2);
    const feedBoxes = await page.locator('.wb-feed-head .ui-avatar').evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return Math.round(rect.width);
      }),
    );
    expect(feedBoxes).toEqual([32, 32]);

    // A different browser context reads both avatars back from the gateway.
    const otherContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const otherPage = await otherContext.newPage();
    await connectWithToken(otherPage, appUrl);
    await otherPage.goto(conversationUrl, { waitUntil: 'networkidle' });
    await expect(otherPage.locator('.wb-feed-head .ui-avatar img').first()).toBeVisible();
    await otherPage.getByRole('link', { name: '设置' }).click();
    await otherPage.getByRole('button', { name: '外观与显示' }).click();
    await expect(otherPage.locator('.ui-avatar-field img')).toHaveAttribute('src', PNG_DATA_URL);
    await otherContext.close();

    // Cancelling the assistant editor discards the draft image.
    await page.locator('.wb-assistant-pill').click();
    await page.getByLabel('助手头像文件').setInputFiles({
      name: 'discard.png',
      mimeType: 'image/png',
      buffer: USER_AVATAR,
    });
    await expect(page.getByRole('dialog').locator('.ui-avatar img')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.locator('.wb-assistant-pill').click();
    await expect(page.getByRole('dialog').locator('.ui-avatar img')).toHaveAttribute(
      'src',
      PNG_DATA_URL,
    );
    await page.keyboard.press('Escape');

    // Clearing the user avatar restores the built-in glyph everywhere.
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('button', { name: '清除用户头像' }).click();
    await expect(page.locator('.ui-avatar-field img')).toHaveCount(0);
    await page.getByRole('button', { name: '返回工作台' }).click();
    await expect(page.locator('.wb-feed-head .ui-avatar').first().locator('img')).toHaveCount(0);
    await expect(page.locator('.wb-feed-head .ui-avatar').nth(1).locator('img')).toBeVisible();
  });
});
