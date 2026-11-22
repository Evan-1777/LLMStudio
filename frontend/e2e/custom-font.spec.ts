import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWithToken, E2E_TOKEN, expect, test } from './fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'LiberationSansNarrow-Regular.ttf',
);
const FONT_NAME = 'LiberationSansNarrow-Regular.ttf';

async function openAppearance(page: import('@playwright/test').Page) {
  if (!page.url().includes('/settings/')) {
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: '外观与显示' })).toBeVisible();
}

async function bodyFontFamily(page: import('@playwright/test').Page) {
  return page.evaluate(() => getComputedStyle(document.body).fontFamily);
}

test('uploads, restores, disables, replaces, and removes one local TTF', async ({
  page,
  appUrl,
}) => {
  await connectWithToken(page, appUrl);
  await openAppearance(page);

  expect(await bodyFontFamily(page)).not.toContain('LLMStudioCustom');
  const fileInput = page.locator('input[aria-label="选择 TTF 字体文件"]');
  await fileInput.setInputFiles(FONT_FIXTURE);
  await expect(page.getByText(FONT_NAME)).toBeVisible();
  await expect(page.getByRole('switch', { name: '使用自定义字体' })).toBeChecked();
  await expect
    .poll(() => bodyFontFamily(page))
    .toContain('LLMStudioCustom');
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--font-custom'),
    ),
  ).toContain('LLMStudioCustom');

  await page.setViewportSize({ width: 375, height: 812 });
  const fontRow = (await page.locator('.st-custom-font').boundingBox())!;
  expect(fontRow.x + fontRow.width).toBeLessThanOrEqual(375.5);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page.locator('.wb-draft')).toHaveCSS(
    'font-family',
    /LLMStudioCustom/,
  );
  await openAppearance(page);
  await expect(page.getByText(FONT_NAME)).toBeVisible();

  await page.reload({ waitUntil: 'networkidle' });
  await openAppearance(page);
  await expect(page.getByText(FONT_NAME)).toBeVisible();
  await expect(page.getByRole('switch', { name: '使用自定义字体' })).toBeChecked();
  await expect.poll(() => bodyFontFamily(page)).toContain('LLMStudioCustom');

  await page.getByRole('switch', { name: '使用自定义字体' }).click();
  await expect(page.getByRole('switch', { name: '使用自定义字体' })).not.toBeChecked();
  await expect.poll(() => bodyFontFamily(page)).not.toContain('LLMStudioCustom');
  await page.reload({ waitUntil: 'networkidle' });
  await openAppearance(page);
  await expect(page.getByRole('switch', { name: '使用自定义字体' })).not.toBeChecked();
  expect(await bodyFontFamily(page)).not.toContain('LLMStudioCustom');

  await page.getByRole('switch', { name: '使用自定义字体' }).click();
  await expect.poll(() => bodyFontFamily(page)).toContain('LLMStudioCustom');

  await fileInput.setInputFiles({
    name: 'broken.ttf',
    mimeType: 'font/ttf',
    buffer: Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText(FONT_NAME)).toBeVisible();
  await expect.poll(() => bodyFontFamily(page)).toContain('LLMStudioCustom');

  await fileInput.setInputFiles(FONT_FIXTURE);
  await expect
    .poll(() => bodyFontFamily(page))
    .toContain('LLMStudioCustom');

  await page.getByRole('button', { name: '移除' }).click();
  await expect(page.getByRole('button', { name: '上传字体' })).toBeVisible();
  await expect.poll(() => bodyFontFamily(page)).not.toContain('LLMStudioCustom');

  await page.reload({ waitUntil: 'networkidle' });
  await openAppearance(page);
  await expect(page.getByRole('button', { name: '上传字体' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--font-custom'),
    ),
  ).toBe('');
});

test('cross-origin font replacement invalidates the old ETag and syncs to an independent client', async ({ page, browser, appUrl }) => {
  await connectWithToken(page, appUrl);
  await openAppearance(page);
  const input = page.getByLabel('选择 TTF 字体文件');
  await input.setInputFiles(FONT_FIXTURE);
  await expect(page.getByText(FONT_NAME)).toBeVisible();
  const oldResponse = await page.request.get(appUrl + '/api/v1/settings/custom-font/file', { headers: { Authorization: 'Bearer ' + E2E_TOKEN } });
  const oldETag = oldResponse.headers().etag;
  expect(oldETag).toBeTruthy();

  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await connectWithToken(other, appUrl);
    await openAppearance(other);
    await expect(other.getByText(FONT_NAME)).toBeVisible();

    // Update a valid TTF under the same URL and exercise a real browser CORS preflight.
    const replacement = Buffer.concat([readFileSync(FONT_FIXTURE), Buffer.alloc(4)]);
    const changed = await page.evaluate(async ({ alternate, token, bytes, previousTag }) => {
      const url = alternate + '/api/v1/settings/custom-font';
      const headers = { Authorization: 'Bearer ' + token };
      const put = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'font/ttf', 'X-Font-Name': 'Updated.ttf' }, body: new Uint8Array(bytes) });
      const file = await fetch(url + '/file', { headers: { ...headers, 'If-None-Match': previousTag }, cache: 'no-store' });
      return { put: put.status, file: file.status, etag: file.headers.get('etag'), length: (await file.arrayBuffer()).byteLength };
    }, { alternate: appUrl.replace('127.0.0.1', 'localhost'), token: E2E_TOKEN, bytes: Array.from(replacement), previousTag: oldETag });
    expect(changed).toMatchObject({ put: 200, file: 200, length: replacement.length });
    expect(changed.etag).toBeTruthy();
    expect(changed.etag).not.toBe(oldETag);

    await expect(other.getByText(FONT_NAME)).toBeVisible();
    await other.getByRole('button', { name: '返回工作台' }).click();
    await other.getByRole('button', { name: '刷新服务端数据' }).click();
    await openAppearance(other);
    await expect(other.getByText('Updated.ttf', { exact: true })).toBeVisible();
    await expect.poll(() => bodyFontFamily(other)).toContain('LLMStudioCustom');
  } finally {
    await otherContext.close();
  }
});
