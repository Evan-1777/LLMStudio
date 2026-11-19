import { connectWithToken, E2E_TOKEN, expect, test } from './fixtures';

test('cleans ungrouped topics across assistants and repairs only a deleted return route', async ({ appUrl, page }) => {
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${appUrl}/api/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.ok, `POST ${path}: ${response.status}`).toBe(true);
    return response.json() as Promise<T>;
  };
  const { assistant } = await post<{ assistant: { id: string } }>('assistants', { name: 'Archivist' });
  const topic = async (title: string, assistantId = 'default') =>
    (await post<{ conversation: { id: string } }>('conversations', { title, assistantId })).conversation.id;
  const source = await topic('Discard this draft', assistant.id);
  const keeper = await topic('Pinned notes');
  const filed = await topic('Filed notes');
  await topic('Discard another draft');
  const { group } = await post<{ group: { id: string } }>('conversation-groups', { assistantId: 'default', name: 'Reference' });
  await post('conversations/batch', { assistantId: 'default', ids: [keeper], operation: 'pin', pinned: true });
  await post('conversations/batch', { assistantId: 'default', ids: [filed], operation: 'move', groupId: group.id });

  await connectWithToken(page, appUrl);
  await page.goto(`${appUrl}/chat/${source}`);
  await expect(page.getByRole('button', { name: /^Discard this draft/ })).toHaveAttribute('aria-current', 'true');
  const openStorage = async () => {
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '存储', exact: true }).click();
  };
  const cleanup = async () => {
    await page.getByRole('button', { name: '删除未分组话题' }).click();
    await page.getByRole('dialog', { name: '删除未分组话题' }).getByRole('button', { name: '删除', exact: true }).click();
  };
  await openStorage();
  await cleanup();
  await expect(page.getByRole('status')).toHaveText('已删除 2 个话题');
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page).toHaveURL(`${appUrl}/chat?assistant=${assistant.id}`);
  await expect(page.getByRole('button', { name: /^Discard this draft/ })).toHaveCount(0);

  await page.goto(`${appUrl}/chat/${keeper}`);
  await expect(page.getByRole('button', { name: /^Pinned notes/ })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: /^Reference/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Filed notes/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Discard another draft/ })).toHaveCount(0);
  await openStorage();
  await cleanup();
  await expect(page.getByRole('status')).toHaveText('没有未分组话题');
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page).toHaveURL(`${appUrl}/chat/${keeper}`);
});
