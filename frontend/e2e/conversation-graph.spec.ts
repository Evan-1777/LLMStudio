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
  await page.locator('[data-kind="branch"] .cg-node__body').click();
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
  await branch.getByRole('button', { name: /独立上下文/ }).click();
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
  const jumped = page.locator('[data-message-id="' + rootId + '"]');
  await expect(jumped).toBeFocused();
  await expect(jumped).toHaveCSS('animation-name', 'none');
  await expect(page.getByText('Graph independent', { exact: true })).toHaveCount(0);
});
