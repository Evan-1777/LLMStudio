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

  await page.locator('.ws-empty-actions').getByRole('button', { name: '新建文件夹' }).click();
  const emptyShortcut = page.getByRole('dialog', { name: '新建文件夹' });
  await expect(emptyShortcut.getByLabel('文件夹名称')).toBeFocused();
  await emptyShortcut.getByRole('button', { name: '取消' }).click();
  await expect(emptyShortcut).toBeHidden();

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

test('hands off workspace menus to dialogs and reveals created and moved entries', async ({
  page,
  browser,
  appUrl,
  agentWorkspaceDir,
}) => {
  fs.mkdirSync(path.join(agentWorkspaceDir, 'docs'));
  fs.writeFileSync(path.join(agentWorkspaceDir, 'notes.md'), '# Planning');
  await connectWithToken(page, appUrl);
  const filesTab = page.getByRole('radio', { name: '工作区文件' });
  await filesTab.click();
  const docs = page.getByRole('treeitem', { name: 'docs' });

  await docs.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click();
  const createFile = page.getByRole('dialog', { name: '新建文件', exact: true });
  const fileName = createFile.getByLabel('名称');
  await expect(fileName).toBeFocused();
  await fileName.pressSequentially('notes');
  await fileName.press('Enter');
  const editor = page.getByLabel('文件内容编辑');
  await expect(editor).toHaveValue('');
  await editor.fill('Deployment notes');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => fs.readFileSync(path.join(agentWorkspaceDir, 'docs', 'notes'), 'utf8')).toBe('Deployment notes');
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  const search = page.getByLabel('搜索文件');
  await search.fill('docs');
  const results = page.getByRole('list', { name: '文件搜索结果' });
  await results.getByRole('button', { name: 'docs', exact: true }).hover();
  await results.getByRole('button', { name: '操作 docs' }).click();
  await page.getByRole('menuitem', { name: '新建文件夹' }).click();
  const createDir = page.getByRole('dialog', { name: '新建文件夹' });
  const folderName = createDir.getByLabel('文件夹名称');
  await expect(folderName).toBeFocused();
  await folderName.fill('plans///');
  await createDir.getByRole('button', { name: '创建', exact: true }).click();
  await expect(search).toHaveValue('');
  const plans = page.getByRole('treeitem', { name: 'plans' });
  await plans.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新建文件夹' }).click();
  await expect(folderName).toBeFocused();
  await folderName.fill('releases');
  await folderName.press('Enter');
  await expect(page.getByRole('treeitem', { name: 'releases' })).toBeVisible();

  const scroll = page.locator('.ws-tree-scroll');
  const scrollHeight = await scroll.evaluate((el) => el.clientHeight);
  await scroll.click({ button: 'right', position: { x: 24, y: scrollHeight - 12 } });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['新建文件', '新建文件夹', '上传文件', '刷新']);
  await menu.getByRole('menuitem', { name: '新建文件夹' }).click();
  await expect(folderName).toBeFocused();
  await folderName.fill('exports');
  await folderName.press('Enter');
  await expect(page.getByRole('treeitem', { name: 'exports' })).toBeVisible();

  const header = page.locator('.ws-history-head');
  await header.getByRole('button', { name: '新建文件', exact: true }).click();
  await expect(fileName).toBeFocused();
  await createFile.getByRole('button', { name: '取消' }).click();
  await page.getByRole('radio', { name: '话题', exact: true }).click();
  await filesTab.click();
  await expect(header.getByRole('button', { name: '新建文件', exact: true })).toBeEnabled();
  await expect(createFile).toHaveCount(0);

  await docs.click();
  await expect(page.getByRole('treeitem', { name: 'notes', exact: true })).toBeVisible();
  await plans.click();
  await expect(page.getByRole('treeitem', { name: 'releases' })).toBeVisible();
  await docs.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动' }).click();
  const move = page.getByRole('dialog', { name: '移动「docs」' });
  await move.getByRole('listitem', { name: 'exports' }).click();
  await move.getByRole('button', { name: '新建文件夹' }).click();
  const targetName = move.getByRole('textbox', { name: '文件夹名称' });
  await expect(targetName).toBeFocused();
  await targetName.fill('archive/');
  await targetName.press('Enter');
  await expect(move.getByRole('navigation')).toContainText('archive');
  await move.getByRole('button', { name: '移至此处' }).click();
  await expect(page.getByRole('treeitem', { name: 'notes', exact: true })).toHaveAttribute('title', 'exports/archive/docs/notes');
  await expect(page.getByRole('treeitem', { name: 'releases' })).toHaveAttribute('title', 'exports/archive/docs/plans/releases');

  await header.getByRole('button', { name: '管理文件' }).click();
  const markdown = page.getByRole('treeitem', { name: 'notes.md' });
  await markdown.click({ button: 'right' });
  await expect(menu).toHaveCount(0);
  await page.getByRole('checkbox', { name: '选择 notes.md' }).check();
  await page.getByRole('button', { name: '批量移动' }).click();
  const batch = page.getByRole('dialog', { name: '移动「1 项」' });
  await batch.getByRole('listitem', { name: 'exports' }).click();
  await batch.getByRole('button', { name: '移至此处' }).click();
  await expect(batch).toBeHidden();
  await page.getByRole('button', { name: '退出管理' }).first().click();
  await expect(markdown).toHaveAttribute('title', 'exports/notes.md');
  await markdown.click();
  await page.getByRole('radio', { name: '编辑' }).click();
  await expect(editor).toHaveValue('# Planning');

  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 375, height: 800 } });
  try {
    const touchPage = await touchContext.newPage();
    await connectWithToken(touchPage, appUrl);
    expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await touchPage.getByRole('button', { name: '切换话题栏' }).tap();
    await touchPage.getByRole('radio', { name: '工作区文件' }).tap();
    for (const colorScheme of ['light', 'dark'] as const) {
      await touchPage.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const selector of ['.ws-history-head', '.ws-toolbar']) {
        const region = touchPage.locator(selector);
        await expect(region).toBeVisible();
        expect(await region.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    }
  } finally {
    await touchContext.close();
  }
});

test('operates file viewer ellipsis menu above modal dialog across viewports, dirty state, and full file actions', async ({
  page,
  appUrl,
  agentWorkspaceDir,
}) => {
  fs.mkdirSync(path.join(agentWorkspaceDir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(agentWorkspaceDir, 'readme.md'), '# Original\n\nBody text.');
  await connectWithToken(page, appUrl);

  await page.getByRole('radio', { name: '工作区文件' }).click();
  await page.getByRole('treeitem', { name: 'readme.md' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();

  const moreBtn = viewer.getByRole('button', { name: '文件操作' });

  // Verify ellipsis menu sits above modal dialog and receives pointer hit-testing across viewports & themes.
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await moreBtn.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const copyPathItem = menu.getByRole('menuitem', { name: '复制路径' });
      const box = await copyPathItem.boundingBox();
      expect(box).not.toBeNull();
      const topHit = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          return Boolean(el?.closest('[role="menu"]'));
        },
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
      );
      expect(topHit).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
      // Escape closes only the menu, never the viewer.
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(viewer).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  // Edit to dirty state: clicking 复制路径 must not close viewer or open discard confirm.
  await viewer.getByRole('radio', { name: '编辑' }).click();
  const editor = viewer.getByLabel('文件内容编辑');
  await editor.fill('# Modified Unsaved');
  await moreBtn.click();
  await page.getByRole('menuitem', { name: '复制路径' }).click();
  await expect(viewer).toBeVisible();
  await expect(page.getByRole('dialog', { name: '放弃未保存的更改？' })).toHaveCount(0);

  // Undo dirty state so copy/move/rename are enabled.
  await viewer.getByRole('button', { name: '撤销修改' }).click();
  await expect(editor).toHaveValue('# Original\n\nBody text.');

  // Duplicate via menu.
  await moreBtn.click();
  await page.getByRole('menuitem', { name: '创建副本' }).click();
  await expect.poll(() => fs.existsSync(path.join(agentWorkspaceDir, 'readme copy.md'))).toBe(true);

  // Move to archive/ via menu.
  await moreBtn.click();
  await page.getByRole('menuitem', { name: '移动到' }).click();
  const moveDialog = page.getByRole('dialog', { name: '移动「readme.md」' });
  await expect(moveDialog).toBeVisible();
  await moveDialog.getByRole('listitem', { name: 'archive' }).click();
  await moveDialog.getByRole('button', { name: '移至此处' }).click();
  await expect(moveDialog).toBeHidden();
  await expect.poll(() => fs.existsSync(path.join(agentWorkspaceDir, 'archive', 'readme.md'))).toBe(true);
  await expect(viewer.getByRole('heading', { name: 'archive/readme.md' })).toBeVisible();

  // Rename via menu.
  await moreBtn.click();
  await page.getByRole('menuitem', { name: '重命名' }).click();
  const renameDialog = page.getByRole('dialog', { name: '重命名' });
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByLabel('名称').fill('guide.md');
  await renameDialog.getByRole('button', { name: '重命名' }).click();
  await expect(renameDialog).toBeHidden();
  await expect.poll(() => fs.existsSync(path.join(agentWorkspaceDir, 'archive', 'guide.md'))).toBe(true);
  await expect(viewer.getByRole('heading', { name: 'archive/guide.md' })).toBeVisible();

  // Download via menu.
  const dlRespPromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/agent/workspace/download') && r.request().method() === 'GET',
  );
  const downloadPromise = page.waitForEvent('download');
  await moreBtn.click();
  await page.getByRole('menuitem', { name: '下载' }).click();
  const [dlResp, download] = await Promise.all([dlRespPromise, downloadPromise]);
  expect(dlResp.status()).toBe(200);
  expect(download.suggestedFilename()).toBe('guide.md');

  // Delete via menu -> closes viewer and removes file from disk.
  await moreBtn.click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  const delConfirm = page.getByRole('dialog', { name: '删除文件？' });
  await expect(delConfirm).toBeVisible();
  await delConfirm.getByRole('button', { name: '删除' }).click();
  await expect(delConfirm).toBeHidden();
  await expect(viewer).toBeHidden();
  await expect.poll(() => fs.existsSync(path.join(agentWorkspaceDir, 'archive', 'guide.md'))).toBe(false);
  await expect(page.getByRole('treeitem', { name: 'readme copy.md' })).toBeVisible();
});
