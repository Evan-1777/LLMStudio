import { connectWithToken, E2E_TOKEN, expect, seedMockProviderViaApi, test } from './fixtures';

const auth = { Authorization: 'Bearer ' + E2E_TOKEN };

test('browser-direct generation saves the exact parent and consumed branch from the gateway', async ({ appUrl, upstream, page }) => {
  const provider = await fetch(appUrl + '/api/v1/providers', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'graph-direct', name: 'Direct', baseURL: upstream.url, adapter: 'generic-http',
      authType: 'bearer', apiKey: 'e2e-graph-key', enabled: true, localRequest: true,
      models: [{ id: 'mock-chat', name: 'Mock Chat', apiFormat: 'openai-completions' }],
    }),
  });
  expect(provider.ok).toBeTruthy();
  await connectWithToken(page, appUrl);
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Mock Chat/ }).click();
  const input = page.getByRole('textbox', { name: '消息输入框' });
  const open = page.getByRole('button', { name: '对话缩略图' });
  const send = async (text: string) => {
    await input.fill(text);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(new RegExp('Reply #\\d+ to: ' + text))).toBeVisible();
    await expect(open).toBeEnabled();
  };
  await send('Direct original');
  await open.click();
  await page.getByRole('button', { name: '新建空白分支' }).click();
  await page.locator('[data-kind="branch"] .cg-node__body').dblclick();
  await expect(input).toBeVisible();
  await send('Direct isolated');
  const first = upstream.lastChatBodies.at(-1)?.messages as { role: string; content: string }[];
  expect(first.filter(({ role }) => role === 'user').map(({ content }) => content)).toEqual(['Direct isolated']);
  await send('Direct continuation');
  const second = upstream.lastChatBodies.at(-1)?.messages as { role: string; content: string }[];
  expect(second.filter(({ role }) => role === 'user').map(({ content }) => content)).toEqual(['Direct isolated', 'Direct continuation']);
  const id = new URL(page.url()).pathname.split('/').at(-1);
  const response = await fetch(appUrl + '/api/v1/conversations/' + id, { headers: auth });
  expect(response.ok).toBeTruthy();
  const detail = await response.json() as {
    messages: { id: string; parentId?: string; role: string }[];
    conversation: { activeLeafId: string; graphState: { activeBranchId?: string; branches?: unknown[] } };
  };
  const chain = detail.messages.slice(-4);
  expect(chain.map(({ role }) => role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(chain[0].parentId).toBeFalsy();
  expect(chain.slice(1).map(({ parentId }) => parentId)).toEqual(chain.slice(0, -1).map(({ id }) => id));
  expect(detail.conversation.activeLeafId).toBe(chain.at(-1)?.id);
  expect(detail.conversation.graphState.activeBranchId).toBeFalsy();
});

test('edits, reconnects and navigates conversation branches without creating topics', async ({ appUrl, upstream, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Mock Chat/ }).click();

  const input = page.getByRole('textbox', { name: '消息输入框' });
  const openGraph = page.getByRole('button', { name: '对话缩略图' });
  const stage = page.getByRole('region', { name: '对话图谱' });
  const menu = page.getByRole('menu');
  const choose = (name: string) => menu.getByRole('menuitem', { name, exact: true }).click();
  const node = (kind: string, text: string) => stage.locator('[data-kind="' + kind + '"]').filter({ hasText: text });
  const send = async (text: string) => {
    await input.fill(text);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(new RegExp('Reply #\\d+ to: ' + text))).toBeVisible();
    await expect(openGraph).toBeEnabled();
  };
  await send('Graph root');
  await send('Graph second');
  const topicPath = new URL(page.url()).pathname;
  const topicId = topicPath.split('/').at(-1);
  const details = async () => {
    const response = await fetch(appUrl + '/api/v1/conversations/' + topicId, { headers: auth });
    expect(response.ok).toBeTruthy();
    return await response.json() as {
      messages: { id: string; parentId?: string; role: string; graphMeta?: { summary?: string; x?: number } }[];
      conversation: { graphState?: { activeBranchId?: string; branches?: unknown[] } };
    };
  };
  const topics = async () => {
    const response = await fetch(appUrl + '/api/v1/conversations', { headers: auth });
    expect(response.ok).toBeTruthy();
    return (await response.json() as { conversations: unknown[] }).conversations.length;
  };
  const topicCount = await topics();
  await input.fill('Draft survives view switch');
  await openGraph.click();
  await expect(stage).toBeVisible();
  await expect(input).toBeHidden();
  await expect(stage.locator('[data-graph-node]')).toHaveCount(4);

  const root = node('user', 'Graph root');
  const rootId = (await root.getAttribute('data-graph-node'))!;
  await root.getByRole('button', { name: /用户.*Graph root/ }).click({ button: 'right' });
  await choose('缩略为箭头摘要');
  const summary = node('summary', 'Graph root');
  await expect(summary).toBeVisible();
  await summary.getByRole('button', { name: 'Graph root' }).click({ button: 'right' });
  await choose('编辑摘要');
  await page.getByRole('textbox', { name: '摘要', exact: true }).fill('Root brief');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(node('summary', 'Root brief')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('Draft survives view switch');
  await page.reload();
  await openGraph.click();
  await node('summary', 'Root brief').getByRole('button', { name: 'Root brief' }).click({ button: 'right' });
  await choose('展开为完整节点');
  await expect(root).toBeVisible();
  await expect.poll(async () => (await details()).messages.find((msg) => msg.id === rootId)?.graphMeta?.summary).toBe('Root brief');

  const endNode = node('assistant', 'Graph second');
  const endId = (await endNode.getAttribute('data-graph-node'))!;
  const firstParent = (await details()).messages.find((msg) => msg.id === endId)?.parentId;
  const drag = async (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => {
    const start = (await from.boundingBox())!;
    const target = (await to.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + 4);
    await page.mouse.move(start.x + start.width / 2, start.y);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width * .35, target.y + target.height * .45, { steps: 12 });
  };
  await drag(root, endNode);
  await expect(endNode).toHaveClass(/cg-node--invalid/);
  await page.mouse.up();
  expect((await details()).messages.find((msg) => msg.id === rootId)?.parentId).toBeFalsy();
  expect((await details()).messages.find((msg) => msg.id === endId)?.parentId).toBe(firstParent);
  await drag(endNode, root);
  await expect(root).toHaveClass(/cg-node--valid/);
  await page.mouse.up();
  await expect.poll(async () => (await details()).messages.find((msg) => msg.id === endId)?.parentId).toBe(rootId);

  await endNode.getByRole('button', { name: /mock-chat.*Graph second/ }).click();
  await endNode.getByRole('button', { name: '跳转至此消息' }).click();
  await expect(page.locator('[data-message-id="' + endId + '"]')).toBeFocused();
  await expect(page.locator('[data-message-id="' + firstParent + '"]')).toHaveCount(0);
  await send('Graph reconnected');
  const reconnected = upstream.lastChatBodies.at(-1)?.messages as { role: string; content: unknown }[];
  expect(reconnected.filter((msg) => msg.role === 'user').map((msg) => msg.content)).toEqual(['Graph root', 'Graph reconnected']);

  await openGraph.click();
  await stage.click({ button: 'right', position: { x: 12, y: 12 } });
  await choose('新建空白分支');
  const branch = node('branch', '独立上下文');
  await expect(branch).toBeVisible();
  await branch.getByRole('button', { name: /独立上下文/ }).dblclick();
  await expect(input).toBeVisible();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await send('Graph independent');
  const independent = upstream.lastChatBodies.at(-1)?.messages as { role: string; content: unknown }[];
  expect(independent.filter((msg) => ['user', 'assistant'].includes(msg.role)).map((msg) => msg.content)).toEqual(['Graph independent']);
  expect((await details()).conversation.graphState?.branches ?? []).toHaveLength(0);
  expect(await topics()).toBe(topicCount);
  expect(new URL(page.url()).pathname).toBe(topicPath);

  await openGraph.click();
  await stage.getByRole('button', { name: '自动整理布局' }).click();
  await expect.poll(async () => (await details()).messages.find((msg) => msg.id === rootId)?.graphMeta?.x).toEqual(expect.any(Number));
  await stage.getByRole('button', { name: '放大' }).click();
  await stage.getByRole('button', { name: '适配画布' }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      await stage.getByRole('button', { name: '适配画布' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(stage.getByRole('button', { name: '新建空白分支' })).toBeInViewport();
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await stage.getByRole('button', { name: '适配画布' }).click();
  await root.getByRole('button', { name: /用户.*Graph root/ }).click();
  await root.getByRole('button', { name: '跳转至此消息' }).click();
  const jumped = page.locator('[data-message-id="' + rootId + '"]');
  await expect(jumped).toBeFocused();
  await expect(jumped).toHaveCSS('animation-name', 'none');
  await expect(page.getByText('Graph independent', { exact: true })).toHaveCount(0);
});

test('supports marquee selection, multi-node drag persistence, subtree select, and atomic batch deletion', async ({ appUrl, upstream, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Mock Chat/ }).click();

  const input = page.getByRole('textbox', { name: '消息输入框' });
  const openGraph = page.getByRole('button', { name: '对话缩略图' });
  const stage = page.getByRole('region', { name: '对话图谱' });
  const send = async (text: string) => {
    await input.fill(text);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText(new RegExp('Reply #\\d+ to: ' + text))).toBeVisible();
    await expect(openGraph).toBeEnabled();
  };

  await send('Batch root');
  await send('Batch leaf');
  const topicId = new URL(page.url()).pathname.split('/').at(-1)!;
  const details = async () => {
    const response = await fetch(appUrl + '/api/v1/conversations/' + topicId, { headers: auth });
    expect(response.ok).toBeTruthy();
    return await response.json() as {
      messages: { id: string; parentId?: string; role: string; graphMeta?: { x?: number; y?: number } }[];
      conversation: { graphState?: { branches?: { id: string; x?: number; y?: number }[] } };
    };
  };

  await openGraph.click();
  await expect(stage.locator('[data-graph-node]')).toHaveCount(4);
  await stage.getByRole('button', { name: '自动整理布局' }).click();
  await expect.poll(async () => (await details()).messages[0]?.graphMeta?.x).toEqual(expect.any(Number));
  await stage.getByRole('button', { name: '适配画布' }).click();

  const beforePositions = new Map(
    (await details()).messages.map((m) => [m.id, { x: m.graphMeta?.x ?? 0, y: m.graphMeta?.y ?? 0 }]),
  );

  // Marquee select all nodes using select mode toggle.
  const selectToggle = stage.getByRole('button', { name: '框选模式' });
  await selectToggle.click();
  await expect(selectToggle).toHaveAttribute('aria-pressed', 'true');
  const stageBox = (await stage.boundingBox())!;
  await page.mouse.move(stageBox.x + 24, stageBox.y + 24);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width - 24, stageBox.y + stageBox.height - 80, { steps: 10 });
  await page.mouse.up();

  const selectionBar = stage.getByRole('toolbar', { name: '批量操作' });
  await expect(selectionBar).toBeVisible();
  await expect(selectionBar).toContainText('已选 4 项');

  // Drag one selected node to move all 4 selected nodes simultaneously.
  const firstNode = stage.locator('[data-graph-node]').first();
  const nodeBox = (await firstNode.boundingBox())!;
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 90, nodeBox.y + nodeBox.height / 2 + 45, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => {
    const msgs = (await details()).messages;
    return msgs.every((m) => (m.graphMeta?.x ?? 0) !== beforePositions.get(m.id)?.x);
  }).toBe(true);
  const movedPositions = new Map(
    (await details()).messages.map((m) => [m.id, { x: m.graphMeta?.x ?? 0, y: m.graphMeta?.y ?? 0 }]),
  );

  // Reload and confirm multi-dragged coordinates persisted.
  await page.reload();
  await openGraph.click();
  await expect(stage.locator('[data-graph-node]')).toHaveCount(4);
  const afterReload = (await details()).messages;
  for (const m of afterReload) {
    expect(m.graphMeta?.x).toBe(movedPositions.get(m.id)?.x);
    expect(m.graphMeta?.y).toBe(movedPositions.get(m.id)?.y);
  }

  // Create a blank branch, select subtree from second message, add branch via Shift+click, then batch delete.
  await stage.getByRole('button', { name: '新建空白分支' }).click();
  const branchNode = stage.locator('[data-kind="branch"]');
  await expect(branchNode).toHaveCount(1);
  const msgIds = (await details()).messages.map((m) => m.id);
  const secondMsg = stage.locator('[data-graph-node="' + msgIds[1] + '"]');
  await secondMsg.locator('.cg-node__body').click();
  await expect(selectionBar).toContainText('已选 1 项');
  await selectionBar.getByRole('button', { name: '选中子树' }).click();
  await expect(selectionBar).toContainText('已选 3 项');

  // Escape clears selection before closing graph.
  await page.keyboard.press('Escape');
  await expect(selectionBar).toBeHidden();
  await expect(stage).toBeVisible();

  // Select middle message + blank branch and batch delete atomically.
  await secondMsg.locator('.cg-node__body').click();
  await branchNode.locator('.cg-node__body').click({ modifiers: ['Shift'] });
  await expect(selectionBar).toContainText('已选 2 项');
  await selectionBar.getByRole('button', { name: '删除所选' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('删除选中的 2 个节点');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(stage.locator('[data-graph-node]')).toHaveCount(3);
  await expect(branchNode).toHaveCount(0);
  await expect(selectionBar).toBeHidden();

  // Verify surviving descendant reconnected to surviving ancestor.
  const remaining = (await details()).messages;
  expect(remaining.map((m) => m.id)).not.toContain(msgIds[1]);
  expect(remaining.find((m) => m.id === msgIds[2])?.parentId).toBe(msgIds[0]);
});

test('expands nodes inline as mind-map cards and respects Markdown and visual HTML settings across viewports', async ({ appUrl, upstream, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedMockProviderViaApi(appUrl, upstream.url);
  await connectWithToken(page, appUrl);
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('option', { name: /Mock Chat/ }).click();

  const input = page.getByRole('textbox', { name: '消息输入框' });
  const openGraph = page.getByRole('button', { name: '对话缩略图' });
  const stage = page.getByRole('region', { name: '对话图谱' });

  await input.fill('**BoldInsight** [RAW_HTML_VISUAL]');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('后置说明')).toBeVisible();
  await expect(openGraph).toBeEnabled();
  const chatUrl = page.url();

  // Open graph, click assistant node (stays in graph & selects), then expand both user (Markdown) & assistant (visual HTML) inline.
  await openGraph.click();
  await expect(stage).toBeVisible();
  const userNode = stage.locator('[data-kind="user"]').first();
  const assistantNode = stage.locator('[data-kind="assistant"]').first();
  await assistantNode.locator('.cg-node__body').click();
  await expect(stage).toBeVisible();
  await expect(assistantNode).toHaveAttribute('data-selected', 'true');
  await assistantNode.getByRole('button', { name: '展开信息' }).click();
  await expect(assistantNode).toHaveAttribute('data-expanded', 'true');
  await expect(assistantNode.locator('.cg-node__detail iframe')).toHaveCount(1);

  await userNode.locator('.cg-node__body').dblclick();
  await expect(userNode).toHaveAttribute('data-expanded', 'true');
  await expect(userNode.locator('.cg-node__detail strong')).toContainText('BoldInsight');

  // Check responsive zero horizontal overflow across 1280/768/375 px × light/dark × reduced-motion with selection bar + expanded cards.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // Navigate to Settings -> Appearance and toggle graphVisualHtmlRender off.
  await page.goto(appUrl + '/settings/appearance');
  const mdSwitch = page.getByRole('switch', { name: '缩略图渲染 Markdown' });
  const visualSwitch = page.getByRole('switch', { name: '缩略图可视化渲染' });
  await expect(mdSwitch).toBeChecked();
  await expect(visualSwitch).toBeChecked();
  await visualSwitch.click();
  await expect(visualSwitch).not.toBeChecked();

  // Return to graph and verify expanded state persists while iframe degrades to raw HTML code card and Markdown stays rendered.
  await page.goto(chatUrl);
  await openGraph.click();
  await expect(assistantNode).toHaveAttribute('data-expanded', 'true');
  await expect(assistantNode.locator('.cg-node__detail iframe')).toHaveCount(0);
  await expect(userNode).toHaveAttribute('data-expanded', 'true');
  await expect(userNode.locator('.cg-node__detail strong')).toContainText('BoldInsight');

  // Disable graphMarkdownRender and confirm visual switch is disabled and persisted expanded cards degrade to plain text.
  await page.goto(appUrl + '/settings/appearance');
  await mdSwitch.click();
  await expect(mdSwitch).not.toBeChecked();
  await expect(visualSwitch).toBeDisabled();

  await page.goto(chatUrl);
  await openGraph.click();
  await expect(userNode).toHaveAttribute('data-expanded', 'true');
  await expect(userNode.locator('.cg-node__plain')).toBeVisible();
  await expect(userNode.locator('.cg-node__detail strong')).toHaveCount(0);
  await expect(assistantNode).toHaveAttribute('data-expanded', 'true');
  await expect(assistantNode.locator('.cg-node__plain')).toBeVisible();
  await expect(assistantNode.locator('.cg-node__detail iframe')).toHaveCount(0);
});
