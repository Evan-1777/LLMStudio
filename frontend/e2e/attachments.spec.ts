import type { Locator } from '@playwright/test';
import {
  E2E_TOKEN,
  connectWithToken,
  expect,
  seedMockProviderViaApi,
  test,
} from './fixtures';

// 1x1 transparent PNG, small enough to inline in the test.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pastePNG(target: Locator, base64: string, name: string) {
  return target.evaluate((element, { base64, name }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], name, { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  }, { base64, name });
}

test.describe('Image attachments', () => {
  test('sends a pasted clipboard image upstream with its data and MIME and keeps it in history', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url, [
      {
        id: 'mock-vision',
        name: 'Mock Vision',
        apiFormat: 'openai-completions',
        reasoning: false,
        inputModalities: ['text', 'image'],
      },
    ]);

    await connectWithToken(page, appUrl);
    await expect(page.getByRole('button', { name: '选择模型' })).toHaveText(
      /Mock Vision/,
    );

    await pastePNG(page.getByLabel('消息输入框'), PNG_BASE64, 'clipboard.png');

    // The pasted image becomes a removable attachment chip without touching the draft.
    await expect(page.getByText('clipboard.png')).toBeVisible();
    const composer = page.getByLabel('消息输入框');
    await expect(composer).toHaveValue('');

    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();

    await expect.poll(() => upstream.lastChatBodies.length).toBe(1);
    const sent = JSON.stringify(upstream.lastChatBodies[0]);
    expect(sent).toContain('image_url');
    expect(sent).toContain(`data:image/png;base64,${PNG_BASE64}`);

    // History survives a reload and the gateway persisted the image block.
    await expect(page).toHaveURL(/\/chat\/.+/);
    const convId = new URL(page.url()).pathname.split('/').pop();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();

    const detail = await page.request.get(
      `${appUrl}/api/v1/conversations/${convId}`,
      { headers: { Authorization: `Bearer ${E2E_TOKEN}` } },
    );
    expect(detail.ok()).toBe(true);
    const stored = JSON.stringify(await detail.json());
    // The gateway keeps the image block with its data and MIME for history.
    expect(stored).toContain('"type":"image"');
    expect(stored).toContain('"mimeType":"image/png"');
    expect(stored).toContain(PNG_BASE64);
  });

  test('saves historical image changes in both layouts without regenerating until the user retries', async ({ appUrl, page, upstream }) => {
    const headers = { Authorization: 'Bearer ' + E2E_TOKEN };
    const providerId = await seedMockProviderViaApi(appUrl, upstream.url, [
      { id: 'mock-vision', name: 'Mock Vision', apiFormat: 'openai-completions', inputModalities: ['text', 'image'] },
    ]);
    await page.setViewportSize({ width: 375, height: 800 });
    await connectWithToken(page, appUrl);
    const [kept, removed, selected, pasted] = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const ctx = canvas.getContext('2d')!;
      return ['red', 'green', 'blue', 'purple'].map((color) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 8, 8);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    });
    const img = (data: string) => ({ type: 'image', mimeType: 'image/png', data });
    const text = (value: string) => ({ type: 'text', text: value });
    const setMode = async (chatDisplayMode: 'bubble' | 'feed') => {
      const res = await page.request.patch(appUrl + '/api/v1/settings', { headers, data: { chatDisplayMode } });
      expect(res.ok()).toBe(true);
    };
    await setMode('bubble');
    const create = await page.request.post(appUrl + '/api/v1/conversations', { headers, data: { title: 'Image history', providerId, modelId: 'mock-vision' } });
    expect(create.ok()).toBe(true);
    const { conversation } = await create.json();
    const path = appUrl + '/api/v1/conversations/' + conversation.id;
    const send = async (role: string, blocks: Array<ReturnType<typeof img> | ReturnType<typeof text>>) => {
      const response = await page.request.post(path + '/messages', { headers, data: { role, blocks } });
      expect(response.ok()).toBe(true);
      return (await response.json()).message;
    };
    const firstText = text('Compare the image colors');
    const first = await send('user', [firstText, img(kept), img(removed)]);
    await send('assistant', [text('Initial comparison')]);
    await send('user', [text('Follow-up question')]);
    await send('assistant', [text('Follow-up reply')]);
    const detail = async () => {
      const response = await page.request.get(path, { headers });
      expect(response.ok()).toBe(true);
      return (await response.json()).messages;
    };
    const before = await detail();
    const messagePath = path + '/messages/' + first.id;
    let patches = 0;
    page.on('request', (r) => { if (r.url() === messagePath && r.method() === 'PATCH') patches++; });
    await page.goto(appUrl + '/chat/' + conversation.id);
    const bubble = page.locator('.wb-user-msg').filter({ hasText: 'Compare the image colors' });
    const save = page.getByRole('button', { name: '保存' });
    const edit = bubble.getByRole('button', { name: '修改消息' });
    await edit.click();
    await page.getByRole('button', { name: '移除 图片 2' }).click();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(bubble.locator('.msg-image-thumb')).toHaveCount(2);
    expect(patches).toBe(0);
    expect(await detail()).toEqual(before);

    await edit.click();
    await page.getByRole('button', { name: '移除 图片 2' }).click();
    const choose = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加图片' }).click();
    await (await choose).setFiles({ name: 'selected.png', mimeType: 'image/png', buffer: Buffer.from(selected, 'base64') });
    await expect(page.getByRole('img', { name: 'selected.png' })).toBeVisible();
    const editor = page.locator('.wb-msg-editor');
    expect(await editor.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    const failOnce = async (route: import('@playwright/test').Route) => {
      await route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: '图片保存失败' } });
    };
    await page.route(messagePath, failOnce, { times: 1 });
    await save.click();
    await expect(page.getByText('图片保存失败')).toBeVisible();
    await expect(page.getByRole('img', { name: 'selected.png' })).toBeVisible();
    const patch = () => page.waitForResponse((res) => res.url() === messagePath && res.request().method() === 'PATCH');
    const bubblePatch = patch();
    await save.click();
    expect((await bubblePatch).ok()).toBe(true);
    await expect(editor).toHaveCount(0);
    expect((await detail())[0].blocks).toEqual([firstText, img(kept), img(selected)]);

    await setMode('feed');
    await page.reload();
    const feed = page.locator('.wb-feed-msg--user').filter({ hasText: 'Compare the image colors' });
    await feed.getByRole('button', { name: '修改消息' }).click();
    const textarea = page.getByLabel('编辑消息内容');
    await pastePNG(textarea, pasted, 'pasted.png');
    await expect(page.getByRole('img', { name: 'pasted.png' })).toBeVisible();
    await expect(textarea).toHaveValue(firstText.text);
    const feedPatch = patch();
    await textarea.press('Control+Enter');
    expect((await feedPatch).ok()).toBe(true);
    await expect(editor).toHaveCount(0);
    expect(patches).toBe(3);
    expect(upstream.lastChatBodies).toHaveLength(0);
    const saved = await detail();
    expect(saved.map((m: { id: string }) => m.id)).toEqual(before.map((m: { id: string }) => m.id));
    expect(saved.slice(1)).toEqual(before.slice(1));
    expect(saved[0].blocks).toEqual([firstText, img(kept), img(selected), img(pasted)]);
    await page.reload();
    await expect(page.getByText('Follow-up reply')).toBeVisible();
    const thumbnails = feed.locator('.msg-image-thumb');
    await expect(thumbnails).toHaveCount(3);
    for (const [index, data] of [kept, selected, pasted].entries()) {
      await expect(thumbnails.nth(index)).toHaveAttribute('src', 'data:image/png;base64,' + data);
    }
    await feed.getByRole('button', { name: '重试消息' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '重新生成' }).click();
    await expect.poll(() => upstream.lastChatBodies.length).toBe(1);
    const request = JSON.stringify(upstream.lastChatBodies[0]);
    for (const data of [kept, selected, pasted]) expect(request).toContain('data:image/png;base64,' + data);
    expect(request).not.toContain(removed);
    await expect(page.getByText(/Reply #1 to:.*Compare the image colors/)).toBeVisible();
    await expect(page.getByText('Follow-up reply')).toBeVisible();
  });

  test('compresses a large file before sending from a model without a vision label', async ({ appUrl, upstream, page }) => {
    await seedMockProviderViaApi(appUrl, upstream.url, [
      { id: 'mock-chat', name: 'Mock Chat', apiFormat: 'openai-completions' },
    ]);
    await connectWithToken(page, appUrl);
    await expect(page.getByRole('button', { name: '选择模型' })).toHaveText(/Mock Chat/);
    const originalBytes = await page.locator('input[type="file"]').evaluate(async (input: HTMLInputElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = 2400;
      canvas.height = 1400;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 42;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        pixels.data[i] = seed & 255;
        pixels.data[i + 1] = (seed >>> 8) & 255;
        pixels.data[i + 2] = (seed >>> 16) & 255;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((image) => image ? resolve(image) : reject(new Error('PNG encoding failed')), 'image/png');
      });
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'large.png', { type: blob.type }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return blob.size;
    });
    expect(originalBytes).toBeGreaterThan(8 * 1024 * 1024);
    const thumbnail = page.getByRole('img', { name: 'large.png' });
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
    await expect(thumbnail.locator('..')).toHaveAttribute('title', /→/);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(/Reply #1 to:/)).toBeVisible();
    const payload = JSON.stringify(upstream.lastChatBodies[0]);
    const encoded = payload.match(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/)?.[1];
    expect(encoded).toBeTruthy();
    expect(Buffer.from(encoded!, 'base64').byteLength).toBeLessThan(originalBytes / 4);
  });
});
