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
