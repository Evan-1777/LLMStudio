import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWithToken, expect, test } from './fixtures';

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
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.querySelector('.wb-draft')!).fontFamily,
      ),
    )
    .toContain('LLMStudioCustom');
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
