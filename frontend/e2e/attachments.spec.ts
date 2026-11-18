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

test.describe('Clipboard image attachments', () => {
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

    await page.evaluate((base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([bytes], 'clipboard.png', { type: 'image/png' }),
      );
      const textarea = document.querySelector('textarea');
      if (!textarea) throw new Error('composer textarea missing');
      textarea.focus();
      textarea.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, PNG_BASE64);

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
});
