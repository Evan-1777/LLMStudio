import { connectWithToken, E2E_TOKEN, expect, seedMockProviderViaApi, test } from './fixtures';

const auth = { Authorization: 'Bearer ' + E2E_TOKEN };

test.describe('topic content search, graph notes, persistence, and side references', () => {
  test('searches message body content, highlights snippet, ignores reasoning, and jumps across topics', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedMockProviderViaApi(appUrl, upstream.url);
    await connectWithToken(page, appUrl);
    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    const input = page.getByRole('textbox', { name: '消息输入框' });
    const send = async (text: string) => {
      await input.fill(text);
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText(new RegExp('Reply #\\d+ to: ' + text.slice(0, 20)))).toBeVisible();
    };

    // Topic 1 contains unique body keyword "QuasarVectorIndex".
    await send('QuasarVectorIndex architecture note');
    const topic1Id = new URL(page.url()).pathname.split('/').at(-1)!;

    // Topic 2 is active when we search.
    await page.getByRole('button', { name: '新建话题' }).click();
    await send('Unrelated second topic');
    const topic2Id = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(topic2Id).not.toBe(topic1Id);

    const searchInput = page.getByRole('searchbox', { name: '搜索话题' }).or(page.getByLabel('搜索话题'));
    await searchInput.fill('QuasarVectorIndex');

    const mark = page.locator('mark.wb-search-mark', { hasText: 'QuasarVectorIndex' }).first();
    await expect(mark).toBeVisible();

    // Click matched topic hit -> navigates to topic 1 and focuses/highlights target message.
    await mark.locator('xpath=ancestor::button[1]').click();
    await expect.poll(() => new URL(page.url()).pathname).toContain(topic1Id);
    await expect(
      page.getByLabel('对话消息').getByText('QuasarVectorIndex architecture note', { exact: true }),
    ).toBeVisible();

    // Searching reasoning-only text ("Reasoning #1") must not match.
    await searchInput.fill('Reasoning #1');
    await expect(page.locator('mark.wb-search-mark')).toHaveCount(0);
  });

  test('persists summary centering, quick edit, one-click toggles, and adaptive text notes across reload', async ({
    appUrl,
    upstream,
    page,
  }) => {
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

    await send('First prompt');
    await send('Second prompt');

    await openGraph.click();
    await expect(stage).toBeVisible();

    // One-click collapse all user messages into centered summary capsules.
    await stage.getByRole('button', { name: '一键缩放用户信息为摘要' }).click();
    const summaries = stage.locator('[data-kind="summary"]');
    await expect(summaries).toHaveCount(2);

    // Verify centered text styling on summary capsule.
    const firstSummary = summaries.first();
    const justify = await firstSummary.locator('.cg-node__body').evaluate((el) => getComputedStyle(el).justifyContent);
    expect(justify).toBe('center');

    // Hover quick-edit summary icon button (floated above capsule).
    await firstSummary.hover();
    await firstSummary.getByRole('button', { name: '编辑摘要' }).click();
    await page.getByRole('textbox', { name: '摘要', exact: true }).fill('核心诉求');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(stage.locator('[data-kind="summary"]', { hasText: '核心诉求' })).toBeVisible();

    // One-click expand all assistant messages.
    await stage.getByRole('button', { name: '一键展开助手信息' }).click();
    await expect(stage.locator('[data-kind="assistant"][data-expanded="true"]')).toHaveCount(2);

    // Create adaptive text note with multi-line content.
    await stage.getByRole('button', { name: '新建文字标注' }).click();
    const noteEditor = stage.getByRole('textbox', { name: '文字标注' });
    await expect(noteEditor).toBeVisible();
    await noteEditor.fill('标注第一行\n标注第二行 SECRET_NOTE_MARKER');
    await noteEditor.press('Control+Enter');

    const noteNode = stage.locator('[data-kind="note"]', { hasText: 'SECRET_NOTE_MARKER' });
    await expect(noteNode).toBeVisible();

    // Drag from note's left port to an assistant node to create a visual dashed note edge.
    const targetAsst = stage.locator('[data-kind="assistant"]').first();
    const noteBox = (await noteNode.boundingBox())!;
    const targetBox = (await targetAsst.boundingBox())!;
    await page.mouse.move(noteBox.x, noteBox.y + noteBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(stage.locator('[data-note-edge]')).toHaveCount(1);

    // Full page reload -> verify summary, expanded assistants, note, and note edge persist.
    await page.reload();
    await openGraph.click();
    await expect(stage.locator('[data-kind="summary"]', { hasText: '核心诉求' })).toBeVisible();
    await expect(stage.locator('[data-kind="assistant"][data-expanded="true"]')).toHaveCount(2);
    await expect(stage.locator('[data-kind="note"]', { hasText: 'SECRET_NOTE_MARKER' })).toBeVisible();
    await expect(stage.locator('[data-note-edge]')).toHaveCount(1);

    // Send a new message and verify note text is NOT sent to upstream LLM.
    await page.getByRole('button', { name: '返回对话' }).click();
    await send('Follow-up after note');
    const lastBody = JSON.stringify(upstream.lastChatBodies.at(-1));
    expect(lastBody).not.toContain('SECRET_NOTE_MARKER');
  });

  test('attaches side reference branch, injects <reference_materials> upstream, and closes ChatUI badge loop', async ({
    appUrl,
    upstream,
    page,
  }) => {
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

    // Main trunk message.
    await send('Main trunk query');

    // Create independent side branch in graph and send a message on it.
    await openGraph.click();
    await stage.getByRole('button', { name: '新建空白分支' }).click();
    await stage.locator('[data-kind="branch"] .cg-node__body').dblclick();
    await send('Side branch secret question');

    // Back to graph: attach side branch assistant node to main trunk assistant node via context menu pick mode.
    await openGraph.click();
    const sideAsst = stage.locator('[data-kind="assistant"]', { hasText: 'Side branch secret' });
    const mainAsst = stage.locator('[data-kind="assistant"]', { hasText: 'Main trunk query' });
    const sideAsstId = (await sideAsst.getAttribute('data-graph-node'))!;

    await sideAsst.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '侧边接入至…', exact: true }).click();
    await mainAsst.locator('.cg-node__body').click();
    await expect(stage.locator('[data-sideref-edge]')).toHaveCount(1);

    // Activate main branch and send a follow-up -> verify upstream receives <reference_materials>.
    await mainAsst.hover();
    await mainAsst.getByRole('button', { name: '跳转至此消息' }).click();
    await expect(page.getByRole('button', { name: '参考分支' })).toBeVisible();

    await send('Main follow-up using side ref');
    const msgsSent = upstream.lastChatBodies.at(-1)?.messages as Array<{ role: string; content: string }>;
    const refMsg = msgsSent.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<reference_materials>'),
    );
    expect(refMsg).toBeDefined();
    expect(refMsg!.content).toBe(
      '<reference_materials>\nReply #2 to: Side branch secret question\n</reference_materials>',
    );

    // Verify ChatUI badge popover preview and bidirectional jump to graph.
    await page.getByRole('button', { name: '参考分支' }).click();
    await expect(page.getByText(/Reply #2 to: Side branch secret question/).last()).toBeVisible();
    await page.getByRole('button', { name: '在缩略图中查看' }).click();
    await expect(stage).toBeVisible();
    await expect(stage.locator(`[data-graph-node="${sideAsstId}"]`)).toHaveAttribute('data-selected', 'true');

    // Return to ChatUI and test disconnect from badge popover.
    await page.getByRole('button', { name: '返回对话' }).click();
    await page.getByRole('button', { name: '参考分支' }).click();
    await page.getByRole('button', { name: '断开接入' }).click();
    await expect(page.getByRole('button', { name: '参考分支' })).toHaveCount(0);

    // Responsive + dark mode + reduced-motion zero horizontal overflow regression across 1280 / 768 / 375px.
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    for (const vp of [
      { width: 1280, height: 800 },
      { width: 768, height: 900 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(vp);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }

    // Also verify topic search API returns clean 200.
    const searchRes = await fetch(appUrl + '/api/v1/conversations/search?q=Main', { headers: auth });
    expect(searchRes.ok).toBeTruthy();
  });
});
