import { E2E_TOKEN, expect, test } from './fixtures';

test.describe('Setup, Settings, Provider Discovery, and Persistence', () => {
  test('connects via token gate, manages assistants/providers/model import/search/MCP/appearance, and persists across reload', async ({
    appUrl,
    dbPath,
    upstream,
    page,
  }) => {
    expect(dbPath).not.toContain('/backend/data/');
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    // 1. Auth gate rejects wrong token (401) and recovers with valid test token.
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByLabel('访问令牌').fill('wrong-token');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();

    await page.getByLabel('访问令牌').fill(E2E_TOKEN);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByLabel('消息输入框').waitFor();
    consoleErrors.length = 0; // Reset after intentional wrong-token 401 test above.

    // Verify custom brand favicon loads cleanly as circular image in sidebar.
    const brandImgLoaded = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>('img.wb-brand__mark');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });
    expect(brandImgLoaded).toBe(true);

    // 2. Assistant CRUD persists across reload.
    await page.getByRole('button', { name: '添加助手' }).click();
    const asstDialog = page.getByRole('dialog');
    await asstDialog.getByLabel('名称').fill('研发专家');
    await asstDialog.getByLabel('系统提示词').fill('Always verify carefully.');
    await asstDialog.getByRole('button', { name: '保存' }).click();
    const asstBtn = page
      .getByRole('navigation', { name: '助手列表' })
      .getByRole('button', { name: '研发专家', exact: true });
    await expect(asstBtn).toBeVisible();

    await page.reload({ waitUntil: 'networkidle' });
    await expect(asstBtn).toBeVisible();

    // 3. Provider creation, probe, model discovery cancel-vs-import, and secret preservation.
    await page.getByRole('link', { name: '设置' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '模型服务' })).toBeVisible();

    await page.getByRole('button', { name: '添加供应商' }).click();
    const addProvDialog = page.getByRole('dialog');
    await addProvDialog.getByLabel('名称').fill('Mock Provider');
    await addProvDialog.getByLabel('API 地址').fill(upstream.url);
    await addProvDialog.getByLabel('API Key').fill('sk-e2e-upstream-secret');
    await addProvDialog.getByRole('button', { name: '添加' }).click();

    await expect(page.getByRole('heading', { name: 'Mock Provider' })).toBeVisible();

    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.getByText(/连接正常.*2 个模型/)).toBeVisible();

    // Cancel after discovery writes zero models.
    await page.getByRole('button', { name: '获取模型' }).first().click();
    const importDialog1 = page.getByRole('dialog');
    await expect(importDialog1.getByText('Mock Chat')).toBeVisible();
    await importDialog1.getByRole('button', { name: '取消' }).click();
    await expect(page.getByText('暂无模型')).toBeVisible();

    // Re-open, select Mock Chat, and import.
    await page.getByRole('button', { name: '获取模型' }).first().click();
    const importDialog2 = page.getByRole('dialog');
    await importDialog2.getByRole('checkbox', { name: /Mock Chat/ }).check();
    await importDialog2.getByRole('button', { name: '导入 (1)' }).click();
    await expect(page.getByText('Mock Chat')).toBeVisible();

    // Edit provider name without re-entering API key -> secret must remain intact on backend.
    await page.getByLabel('名称').fill('Mock Provider Renamed');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('heading', { name: 'Mock Provider Renamed' })).toBeVisible();

    upstream.lastAuthHeaders = [];
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.getByText(/连接正常/)).toBeVisible();
    expect(upstream.lastAuthHeaders).toContain('Bearer sk-e2e-upstream-secret');

    // 4. Plugins: SearXNG endpoint update, test search, enable & set default.
    await page.getByRole('button', { name: '插件' }).click();
    const searxForm = page.getByRole('form', { name: 'SearXNG' });
    await searxForm.getByLabel('服务地址').fill(`${upstream.url}/search`);
    await searxForm.getByRole('button', { name: '保存' }).click();
    await expect(searxForm.getByText('已保存')).toBeVisible();

    await searxForm.getByRole('button', { name: '测试搜索' }).click();
    await expect(searxForm.getByText(/1 条结果/)).toBeVisible();

    await searxForm.getByRole('switch', { name: '启用 SearXNG' }).click();
    await searxForm.getByRole('button', { name: '设为默认' }).click();
    await expect(searxForm.getByText('默认')).toBeVisible();

    // 5. MCP configuration CRUD (no runtime execution controls).
    await page.getByRole('button', { name: 'MCP 配置' }).click();
    await expect(page.getByRole('button', { name: /测试/ })).toHaveCount(0);
    await page.getByRole('button', { name: '添加配置' }).click();
    const mcpDialog = page.getByRole('dialog');
    await mcpDialog.getByLabel('名称').fill('local-fs');
    await mcpDialog.getByLabel('启动命令').fill('npx');
    await mcpDialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('local-fs')).toBeVisible();

    // 6. Appearance & About.
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: '关于' }).click();
    await expect(page.getByText('已启用')).toBeVisible();

    // Reload preserves all saved settings and backend entities.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: '模型服务' }).click();
    await page.getByRole('button', { name: /Mock Provider Renamed/ }).click();
    await expect(page.getByRole('heading', { name: 'Mock Provider Renamed' })).toBeVisible();
    await expect(page.getByText('Mock Chat')).toBeVisible();

    await page.getByRole('button', { name: 'MCP 配置' }).click();
    await expect(page.getByText('local-fs')).toBeVisible();

    // 7. Create a localRequest provider, verify browser-direct probe/fetch/chat with CORS preflight, and verify Feed mode UI.
    await page.getByRole('button', { name: '模型服务' }).click();
    await page.getByRole('button', { name: '添加供应商' }).click();
    const localDialog = page.getByRole('dialog');
    await localDialog.getByLabel('名称').fill('Direct Local');
    await localDialog.getByLabel('API 地址').fill(upstream.url);
    await localDialog.getByLabel('API Key').fill('sk-browser-direct');
    await localDialog.getByRole('switch', { name: '本地请求' }).click();
    await localDialog.getByRole('button', { name: '添加' }).click();
    await expect(page.getByRole('heading', { name: 'Direct Local' })).toBeVisible();

    const directProbeReqPromise = page.waitForRequest(
      (req) => req.url() === `${upstream.url}/v1/models` && req.method() === 'GET',
    );
    await page.getByRole('button', { name: '测试连接' }).click();
    await directProbeReqPromise;
    await expect(page.getByText(/连接正常.*2 个模型/)).toBeVisible();

    await page.getByRole('button', { name: '获取模型' }).first().click();
    const localImportDialog = page.getByRole('dialog');
    await localImportDialog.getByRole('checkbox', { name: /Mock Chat/ }).check();
    await localImportDialog.getByRole('button', { name: '导入 (1)' }).click();
    await expect(page.getByText('Mock Chat')).toBeVisible();

    await page.getByRole('button', { name: '返回工作台' }).click();
    await page.getByLabel('消息输入框').waitFor();
    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByLabel('搜索模型').fill('Direct Local');
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    const directChatReqPromise = page.waitForRequest(
      (req) =>
        req.url() === `${upstream.url}/v1/chat/completions` &&
        req.method() === 'POST',
    );
    await page.getByLabel('消息输入框').fill('Direct browser chat');
    await page.getByRole('button', { name: '发送消息' }).click();
    await directChatReqPromise;
    await expect(page.getByText(/to: Direct browser chat/)).toBeVisible();

    // Switch to Feed display mode via toolbar button and verify author/provider header & Token summary.
    await page.getByRole('button', { name: '切换消息显示模式' }).click();
    await expect(page.locator('.wb-feed-author', { hasText: '用户' })).toBeVisible();
    await expect(
      page.locator('.wb-feed-author', { hasText: 'Mock Chat | Direct Local' }),
    ).toBeVisible();
    await expect(page.getByText(/Tokens: 40 ↑15 ↓25/)).toBeVisible();

    // Reload preserves persisted local chat history and Feed mode.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(
      page.locator('.wb-feed-author', { hasText: 'Mock Chat | Direct Local' }),
    ).toBeVisible();
    await expect(page.getByText(/to: Direct browser chat/)).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
