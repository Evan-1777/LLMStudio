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
  const local: AgentSettings = {
    directory: { path: 'C:/local', status: 'ready' },
    allowedTools: [],
    availableTools: ['read', 'skill'],
    injectAgentMd: true,
    markdownVisualRender: false,
    skills: [],
  };
  const cloud: AgentSettings = {
    directory: { path: 'remote', status: 'ready' },
    allowedTools: ['read'],
    availableTools: ['read', 'skill'],
    injectAgentMd: false,
    markdownVisualRender: true,
    skills: [{ name: 'deploy-check', description: 'Verify deployment', path: '.agent/skills/deploy-check/SKILL.md' }],
  };
  mocked.getAgentSettings.mockImplementation((scope) => Promise.resolve(scope === 'local' ? local : cloud));
  mocked.listAgentDirectories.mockResolvedValue({ path: 'remote', directories: [] });
  mocked.pickDirectory.mockResolvedValueOnce('').mockResolvedValueOnce('C:/chosen');
  let resolveLocal!: (next: AgentSettings) => void;
  mocked.updateAgentSettings.mockImplementation(() => new Promise((resolve) => { resolveLocal = resolve; }));

  render(<AgentPage />);
  await screen.findByText('C:/local');
  expect(screen.getByRole('switch', { name: '注入目录 AGENT.md' })).toBeChecked();
  expect(screen.queryByRole('switch', { name: '工作区 Markdown 可视化渲染' })).not.toBeInTheDocument();
  expect(screen.queryByText('目录技能')).not.toBeInTheDocument();

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
  expect(screen.getByRole('switch', { name: '注入目录 AGENT.md' })).not.toBeChecked();
  expect(screen.getByRole('switch', { name: '工作区 Markdown 可视化渲染' })).toBeChecked();
  expect(screen.getByText('目录技能')).toBeInTheDocument();
  expect(screen.getByText('deploy-check')).toBeInTheDocument();
  expect(screen.getByText('Verify deployment')).toBeInTheDocument();

  await user.click(choose());
  const dialog = await screen.findByRole('dialog', { name: '选择工作目录' });
  expect(await within(dialog).findByText('没有子目录')).toBeVisible();
  expect(mocked.listAgentDirectories).toHaveBeenCalledWith('remote', 'cloud', expect.any(AbortSignal));
  await user.keyboard('{Escape}');
  expect(mocked.pickDirectory).toHaveBeenCalledTimes(2);
  expect(mocked.updateAgentSettings).toHaveBeenCalledTimes(1);
});

it('toggles injectAgentMd, markdownVisualRender, skill tool and rolls back on failure', async () => {
  const user = userEvent.setup();
  const base: AgentSettings = {
    directory: { path: 'remote', status: 'ready' },
    allowedTools: ['read'],
    availableTools: ['read', 'skill'],
    injectAgentMd: true,
    markdownVisualRender: false,
    skills: [],
  };
  mocked.getAgentSettings.mockResolvedValue(base);
  mocked.updateAgentSettings
    .mockResolvedValueOnce({ ...base, injectAgentMd: false })
    .mockResolvedValueOnce({ ...base, injectAgentMd: false, markdownVisualRender: true })
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce({ ...base, injectAgentMd: false, markdownVisualRender: true, allowedTools: ['read', 'skill'] });

  render(<AgentPage />);
  await user.click(await screen.findByRole('radio', { name: '网关' }));
  await screen.findByText('remote');

  await user.click(screen.getByRole('switch', { name: '注入目录 AGENT.md' }));
  expect(mocked.updateAgentSettings).toHaveBeenLastCalledWith({ injectAgentMd: false }, 'cloud', expect.any(AbortSignal));
  expect(screen.getByRole('switch', { name: '注入目录 AGENT.md' })).not.toBeChecked();

  await user.click(screen.getByRole('switch', { name: '工作区 Markdown 可视化渲染' }));
  expect(mocked.updateAgentSettings).toHaveBeenLastCalledWith({ markdownVisualRender: true }, 'cloud', expect.any(AbortSignal));
  expect(screen.getByRole('switch', { name: '工作区 Markdown 可视化渲染' })).toBeChecked();

  await user.click(screen.getByRole('switch', { name: '调用技能' }));
  expect(await screen.findByText('无法保存 Agent 设置')).toBeVisible();
  expect(screen.getByRole('switch', { name: '调用技能' })).not.toBeChecked();

  await user.click(screen.getByRole('switch', { name: '调用技能' }));
  expect(mocked.updateAgentSettings).toHaveBeenLastCalledWith({ allowedTools: ['read', 'skill'] }, 'cloud', expect.any(AbortSignal));
  expect(screen.getByRole('switch', { name: '调用技能' })).toBeChecked();
});
