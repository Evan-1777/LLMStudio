import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSettings } from '../../core/types';
import { AgentPage } from './AgentPage';

const mocked = vi.hoisted(() => ({
  getAgentSettings: vi.fn(), updateAgentSettings: vi.fn(), listAgentDirectories: vi.fn(),
  pickDirectory: vi.fn(),
}));
vi.mock('../../app/AppProvider', () => ({ useApp: () => ({
  gateway: mocked, isDesktop: true, connectionEpoch: 1, cloudConnectionState: 'connected',
}) }));
vi.mock('../../core/desktop', () => ({ pickDesktopDirectory: mocked.pickDirectory }));

afterEach(() => vi.resetAllMocks());

it('opens native picker only for local settings and drops results from the previous scope', async () => {
  const user = userEvent.setup();
  const local: AgentSettings = { directory: { path: 'C:/local', status: 'ready' }, allowedTools: [], availableTools: ['read'] };
  const cloud: AgentSettings = { directory: { path: 'remote', status: 'ready' }, allowedTools: ['read'], availableTools: ['read'] };
  mocked.getAgentSettings.mockImplementation((scope) => Promise.resolve(scope === 'local' ? local : cloud));
  mocked.listAgentDirectories.mockResolvedValue({ path: 'remote', directories: [] });
  mocked.pickDirectory.mockResolvedValueOnce('').mockResolvedValueOnce('C:/chosen');
  let resolveLocal!: (next: AgentSettings) => void;
  mocked.updateAgentSettings.mockImplementation(() => new Promise((resolve) => { resolveLocal = resolve; }));

  render(<AgentPage />);
  await screen.findByText('C:/local');
  const choose = () => screen.getByRole('button', { name: '选择工作目录' });
  await user.click(choose());
  expect(mocked.pickDirectory).toHaveBeenCalledWith('C:/local');
  expect(mocked.updateAgentSettings).not.toHaveBeenCalled();
  await user.click(choose());
  expect(mocked.updateAgentSettings).toHaveBeenCalledWith({ defaultDirectory: 'C:/chosen' }, 'local', expect.any(AbortSignal));

  await user.click(screen.getByRole('radio', { name: '网关' }));
  await screen.findByText('remote');
  await act(async () => { resolveLocal({ ...local, directory: { path: 'C:/chosen', status: 'ready' } }); });
  expect(screen.queryByText('C:/chosen')).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: '读取文件' })).toBeChecked();
  await user.click(choose());
  const dialog = await screen.findByRole('dialog', { name: '选择工作目录' });
  expect(await within(dialog).findByText('没有子目录')).toBeVisible();
  expect(mocked.listAgentDirectories).toHaveBeenCalledWith('remote', 'cloud', expect.any(AbortSignal));
  await user.keyboard('{Escape}');
  expect(mocked.pickDirectory).toHaveBeenCalledTimes(2);
  expect(mocked.updateAgentSettings).toHaveBeenCalledTimes(1);
});
