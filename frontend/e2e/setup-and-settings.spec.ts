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

    expect(consoleErrors).toEqual([]);
  });
});
