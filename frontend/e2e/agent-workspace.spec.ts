import fs from 'node:fs';
import path from 'node:path';
import { connectWithToken, expect, seedMockProviderViaApi, test } from './fixtures';

test('injects AGENTS.md, runs skill tool continuation, and browses/renders/edits workspace files across viewports and themes', async ({
  page,
  appUrl,
  upstream,
  agentWorkspaceDir,
}) => {
  fs.writeFileSync(
    path.join(agentWorkspaceDir, 'AGENTS.md'),
    'Workspace rule: verify references before deploying.',
  );
  const demoSkillDir = path.join(agentWorkspaceDir, '.agent', 'skills', 'demo-skill');
  fs.mkdirSync(path.join(demoSkillDir, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(demoSkillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: Verify deployment checklist',
      '---',
      '# Demo Skill',
      'Execute checklist steps in order.',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(demoSkillDir, 'references', 'guide.md'), '# Guide\nStep 1');
  fs.writeFileSync(
    path.join(agentWorkspaceDir, 'notes.md'),
    [
      '# Workspace Notes',
      '',
      '<div id="viz-card">Visual Block</div>',
      '',
      '```html',
      '<section>Fenced Preview</section>',
      '```',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(agentWorkspaceDir, 'pic.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );

  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);

  // 1. Configure Agent settings: enable skill tool, verify AGENT.md toggle and discovered skill list.
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('switch', { name: '注入目录 AGENT.md' })).toBeChecked();
  const visualSwitch = page.getByRole('switch', { name: '工作区 Markdown 可视化渲染' });
  await expect(visualSwitch).not.toBeChecked();
  await expect(page.getByText('demo-skill')).toBeVisible();

  const skillSwitch = page.getByRole('switch', { name: '调用技能' });
  await skillSwitch.click();
  await expect(skillSwitch).toBeChecked();

  // 2. Return to workbench, enter Agent mode, and run a turn triggering the native skill tool.
  await page.getByRole('button', { name: '返回工作台' }).click();
  await page.getByRole('radio', { name: 'Agent', exact: true }).click();
  await page.getByLabel('消息输入框').fill('[AGENT_SKILL]');
  await page.getByRole('button', { name: '发送消息' }).click();

  await expect(page.getByText(/Skill verified:/)).toBeVisible();
  await expect(page.getByText('Execute checklist steps in order.')).toBeVisible();
  expect(upstream.lastChatBodies).toHaveLength(2);
  const req0 = JSON.stringify(upstream.lastChatBodies[0]);
  expect(req0).toContain('Workspace rule: verify references before deploying.');
  expect(req0).toContain('<available_skills>');
  expect(req0).toContain('demo-skill');

  // 3. Switch right sidebar to workspace file browser and inspect tree + previews.
  await page.getByRole('radio', { name: '工作区文件' }).click();
  await page.getByRole('treeitem', { name: '.agent' }).click();
  await page.getByRole('treeitem', { name: 'skills' }).click();
  await page.getByRole('treeitem', { name: 'demo-skill' }).click();
  await expect(page.getByRole('treeitem', { name: 'SKILL.md' })).toBeVisible();

  // Image files show unsupported state without error.
  await page.getByRole('treeitem', { name: 'pic.png' }).click();
  await expect(page.getByText('图片暂不支持预览')).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  // Markdown preview with markdownVisualRender=false does NOT mount sandbox iframe.
  await page.getByRole('treeitem', { name: 'notes.md' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace Notes' })).toBeVisible();
  await expect(page.locator('iframe[title="HTML 预览"]')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭' }).click();

  // Enable workspace Markdown visual render in Agent settings.
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await visualSwitch.click();
  await expect(visualSwitch).toBeChecked();

  await page.getByRole('button', { name: '返回工作台' }).click();
  await page.getByRole('radio', { name: '工作区文件' }).click();
  await page.getByRole('treeitem', { name: 'notes.md' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace Notes' })).toBeVisible();
  const iframes = page.locator('iframe[title="HTML 预览"]');
  await expect(iframes).toHaveCount(2);
  await expect(iframes.first()).toHaveAttribute('sandbox', 'allow-scripts');

  // Check responsive & light/dark/reduced-motion layout inside the viewer.
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // Edit notes.md and save via Cmd/Ctrl+S, verifying disk persistence.
  await page.getByRole('radio', { name: '编辑' }).click();
  const editor = page.getByLabel('文件内容编辑');
  await editor.fill('# Updated Notes\n\nSaved from E2E.');
  const saveResp = page.waitForResponse(
    (r) => r.url().includes('/api/v1/agent/workspace/file') && r.request().method() === 'PUT',
  );
  await editor.press('Control+s');
  expect((await saveResp).status()).toBe(200);
  expect(fs.readFileSync(path.join(agentWorkspaceDir, 'notes.md'), 'utf8')).toBe(
    '# Updated Notes\n\nSaved from E2E.',
  );
  await page.getByRole('button', { name: '关闭' }).click();
});

test('manages workspace files end-to-end: create, edit, mkdir, rename, move, copy, search, upload overwrite, download, batch delete, and responsive layout', async ({
  page,
  appUrl,
  upstream,
  agentWorkspaceDir,
}) => {
  for (const name of fs.readdirSync(agentWorkspaceDir)) {
    fs.rmSync(path.join(agentWorkspaceDir, name), { recursive: true, force: true });
  }
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);

  await page.getByRole('radio', { name: '工作区文件' }).click();
  await expect(page.getByText('工作区为空')).toBeVisible();

  // 1. Create Markdown file from header -> auto enters edit mode -> write & Ctrl+S save.
  await page.getByRole('button', { name: '新建文件' }).first().click();
  const createFileDialog = page.getByRole('dialog', { name: '新建文件' });
  await createFileDialog.getByLabel('名称').fill('draft.md');
  await createFileDialog.getByRole('button', { name: '创建' }).click();

  const editor = page.getByLabel('文件内容编辑');
  await expect(editor).toBeVisible();
  await editor.fill('# Draft Content\n\nCreated in E2E.');
  const saveResp = page.waitForResponse(
    (r) => r.url().includes('/api/v1/agent/workspace/file') && r.request().method() === 'PUT',
  );
  await editor.press('Control+s');
  expect((await saveResp).status()).toBe(200);
  expect(fs.readFileSync(path.join(agentWorkspaceDir, 'draft.md'), 'utf8')).toBe(
    '# Draft Content\n\nCreated in E2E.',
  );
  await page.getByRole('button', { name: '关闭' }).click();

  // 2. Create subdirectory -> rename draft.md -> move to subdirectory -> create copy.
  await page.getByRole('button', { name: '新建文件夹' }).click();
  const createDirDialog = page.getByRole('dialog', { name: '新建文件夹' });
  await createDirDialog.getByLabel('文件夹名称').fill('docs');
  await createDirDialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByRole('treeitem', { name: 'docs' })).toBeVisible();

  await page.getByRole('button', { name: '操作 draft.md' }).click({ force: true });
  await page.getByRole('menuitem', { name: '重命名' }).click();
  const renameDialog = page.getByRole('dialog', { name: '重命名' });
  await renameDialog.getByLabel('名称').fill('spec.md');
  await renameDialog.getByRole('button', { name: '重命名' }).click();
  await expect(page.getByRole('treeitem', { name: 'spec.md' })).toBeVisible();

  await page.getByRole('button', { name: '操作 spec.md' }).click({ force: true });
  await page.getByRole('menuitem', { name: '移动' }).click();
  const moveDialog = page.getByRole('dialog', { name: '移动「spec.md」' });
  await moveDialog.getByRole('listitem', { name: 'docs' }).click();
  await moveDialog.getByRole('button', { name: '移至此处' }).click();
  await expect(page.getByRole('treeitem', { name: 'spec.md' })).toHaveCount(0);

  // Expand docs and create a copy.
  await page.getByRole('treeitem', { name: 'docs' }).click();
  await expect(page.getByRole('treeitem', { name: 'spec.md' })).toBeVisible();
  await page.getByRole('button', { name: '操作 spec.md' }).click({ force: true });
  await page.getByRole('menuitem', { name: '创建副本' }).click();
  await expect(page.getByRole('treeitem', { name: 'spec copy.md' })).toBeVisible();

  // 3. Search across directories and verify download content.
  await page.getByLabel('搜索文件').fill('spec.md');
  await expect(page.getByRole('list', { name: '文件搜索结果' }).getByText('spec.md')).toBeVisible();
  const dlRespPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/agent/workspace/download') && r.request().method() === 'GET',
  );
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '操作 spec.md' }).click({ force: true });
  await page.getByRole('menuitem', { name: '下载' }).click();
  const [dlResp, download] = await Promise.all([dlRespPromise, downloadPromise]);
  const expectedBody = '# Draft Content\n\nCreated in E2E.';
  expect(fs.readFileSync(path.join(agentWorkspaceDir, 'docs', 'spec.md'), 'utf8')).toBe(expectedBody);
  expect(fs.readFileSync(path.join(agentWorkspaceDir, 'docs', 'spec copy.md'), 'utf8')).toBe(expectedBody);
  expect(dlResp.status()).toBe(200);
  expect(dlResp.headers()['content-disposition']).toContain('spec.md');
  expect(dlResp.headers()['content-length']).toBe(String(Buffer.byteLength(expectedBody)));
  expect(download.suggestedFilename()).toBe('spec.md');
  await page.getByRole('button', { name: '清空搜索' }).click();

  // 4. Upload file and trigger 409 overwrite confirmation.
  const fileInput = page.locator('.ws-panel input[type="file"]');
  await fileInput.setInputFiles({
    name: 'upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('upload-v1'),
  });
  await expect(page.getByRole('treeitem', { name: 'upload.txt' })).toBeVisible();
  expect(fs.readFileSync(path.join(agentWorkspaceDir, 'upload.txt'), 'utf8')).toBe('upload-v1');

  await fileInput.setInputFiles({
    name: 'upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('upload-v2'),
  });
  const overwriteDialog = page.getByRole('dialog', { name: '覆盖已有文件？' });
  await expect(overwriteDialog).toBeVisible();
  await overwriteDialog.getByRole('button', { name: '覆盖' }).click();
  await expect(overwriteDialog).toBeHidden();
  await expect.poll(() => fs.readFileSync(path.join(agentWorkspaceDir, 'upload.txt'), 'utf8')).toBe('upload-v2');

  // 5. Responsive & light/dark/reduced-motion layout check across 1280 / 768 / 375 px.
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  // 6. Batch delete docs and upload.txt and verify removed from disk.
  await page.getByRole('button', { name: '管理文件' }).click();
  await page.getByLabel('选择 docs').click();
  await page.getByLabel('选择 upload.txt').click();
  await page.getByRole('button', { name: '删除 (2)' }).click();
  const delDialog = page.getByRole('dialog', { name: '删除 2 项？' });
  await delDialog.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('工作区为空')).toBeVisible();
  expect(fs.existsSync(path.join(agentWorkspaceDir, 'docs'))).toBe(false);
  expect(fs.existsSync(path.join(agentWorkspaceDir, 'upload.txt'))).toBe(false);
});
