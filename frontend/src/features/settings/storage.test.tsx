import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppProvider, useApp } from '../../app/AppProvider';
import { defaultSettings } from '../../core/settings';
import { SettingsLayout } from './SettingsLayout';

function preferencesPayload(): Record<string, unknown> {
  const { gatewayBaseUrl, accessToken, ...preferences } = defaultSettings();
  void gatewayBaseUrl;
  void accessToken;
  return preferences;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function setups(fetchMock: ReturnType<typeof vi.fn>, probe?: ReactNode) {
  const user = userEvent.setup();
  render(
    <AppProvider fetchImpl={fetchMock as unknown as typeof fetch}>
      {probe}
      <MemoryRouter initialEntries={['/settings/storage']}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsLayout />} />
          <Route path="/chat" element={<div data-testid="chat-route" />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>,
  );
  return user;
}

function baseFetch(
  overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | null,
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const custom = overrides(url, init);
    if (custom) return custom;
    if (url.endsWith('/healthz')) {
      return jsonResponse({ status: 'ok', version: '1.9.3', authRequired: false });
    }
    if (url.endsWith('/api/v1/settings')) {
      return jsonResponse({ preferences: preferencesPayload(), initialized: true });
    }
    if (url.endsWith('/api/v1/formats')) return jsonResponse({ formats: [], adapters: [] });
    if (url.endsWith('/api/v1/providers')) return jsonResponse({ providers: [] });
    if (url.endsWith('/api/v1/assistants')) return jsonResponse({ assistants: [] });
    if (url.endsWith('/api/v1/conversations')) return jsonResponse({ conversations: [] });
    if (url.endsWith('/api/v1/plugins/search')) return jsonResponse({ engines: [] });
    if (url.endsWith('/api/v1/mcp/servers')) return jsonResponse({ servers: [] });
    return jsonResponse({});
  });
}

describe('StoragePage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the database footprint and blocks repeat compactions while busy', async () => {
    let compactCalls = 0;
    const compactGate: { release: (() => void) | null } = { release: null };
    const fetchMock = baseFetch((url, init) => {
      if (url.endsWith('/api/v1/storage')) {
        return jsonResponse({
          mainBytes: 8192,
          walBytes: 1024,
          totalBytes: 9216,
          compactable: true,
        });
      }
      if (url.endsWith('/api/v1/storage/compact')) {
        compactCalls += 1;
        expect((init?.method ?? 'GET').toUpperCase()).toBe('POST');
        return new Promise<Response>((resolve) => {
          compactGate.release = () =>
            resolve(
              jsonResponse({
                beforeBytes: 9216,
                afterBytes: 4096,
                freedBytes: 5120,
                usage: {
                  mainBytes: 4096,
                  walBytes: 0,
                  totalBytes: 4096,
                  compactable: true,
                },
              }),
            );
        });
      }
      return null;
    });
    const user = setups(fetchMock);

    await waitFor(() => expect(screen.getByText('9.0 KB')).toBeInTheDocument());
    const compactButton = screen.getByRole('button', { name: '压缩数据库' });
    await user.click(compactButton);
    await waitFor(() => expect(compactCalls).toBe(1));

    // While the command is in flight the action is disabled and old values stay.
    expect(compactButton).toBeDisabled();
    expect(screen.getByText('9.0 KB')).toBeInTheDocument();
    await user.click(compactButton);
    expect(compactCalls).toBe(1);

    compactGate.release?.();
    await waitFor(() =>
      expect(screen.getByText('已释放 5.0 KB')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('4.0 KB').length).toBeGreaterThan(0);
  });

  it('reports a compaction that reclaimed nothing without fabricating a win', async () => {
    const fetchMock = baseFetch((url) => {
      if (url.endsWith('/api/v1/storage')) {
        return jsonResponse({
          mainBytes: 5120,
          walBytes: 0,
          totalBytes: 5120,
          compactable: true,
        });
      }
      if (url.endsWith('/api/v1/storage/compact')) {
        return jsonResponse({
          beforeBytes: 5120,
          afterBytes: 5120,
          freedBytes: 0,
          usage: {
            mainBytes: 5120,
            walBytes: 0,
            totalBytes: 5120,
            compactable: true,
          },
        });
      }
      return null;
    });
    const user = setups(fetchMock);
    await waitFor(() => expect(screen.getAllByText('5.0 KB').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: '压缩数据库' }));
    await waitFor(() =>
      expect(screen.getByText('未释放空间')).toBeInTheDocument(),
    );
  });

  it('surfaces a failed compaction with a retry that preserves the footprint', async () => {
    let attempts = 0;
    const fetchMock = baseFetch((url) => {
      if (url.endsWith('/api/v1/storage')) {
        return jsonResponse({
          mainBytes: 8192,
          walBytes: 1024,
          totalBytes: 9216,
          compactable: true,
        });
      }
      if (url.endsWith('/api/v1/storage/compact')) {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse({ code: 'INTERNAL_ERROR', message: '数据库正忙' }, 500);
        }
        return jsonResponse({
          beforeBytes: 9216,
          afterBytes: 9216,
          freedBytes: 0,
          usage: {
            mainBytes: 8192,
            walBytes: 1024,
            totalBytes: 9216,
            compactable: true,
          },
        });
      }
      return null;
    });
    const user = setups(fetchMock);

    await waitFor(() => expect(screen.getByText('9.0 KB')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '压缩数据库' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('9.0 KB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(screen.getByText('未释放空间')).toBeInTheDocument(),
    );
    expect(attempts).toBe(2);
  });

  it('requires confirmation on every cleanup, retains success if stats fail, and prevents stale refresh from restoring topics', async () => {
    let commands = 0;
    let compactCalls = 0;
    let stats = 0;
    let failNextStats = false;
    let reads = 0;
    let settleCleanup: (value: Response) => void = () => {};
    let settleRefresh: (value: Response) => void = () => {};
    const initial = { conversations: [{ id: 'deleted', assistantId: 'default' }, { id: 'kept', assistantId: 'default' }] };
    const footprint = { mainBytes: 8192, walBytes: 1024, totalBytes: 9216, compactable: true };
    const fetchMock = baseFetch((url, init) => {
      if (url.endsWith('/api/v1/storage/compact')) {
        compactCalls++;
        return jsonResponse({ freedBytes: 0, usage: footprint });
      }
      if (url.endsWith('/api/v1/storage')) {
        stats++;
        if (failNextStats) {
          failNextStats = false;
          return jsonResponse({ message: '无法读取磁盘占用' }, 500);
        }
        return jsonResponse(footprint);
      }
      if (url.endsWith('/api/v1/conversations/cleanup-ungrouped')) {
        expect(init?.method).toBe('POST');
        commands++;
        if (commands === 1) return jsonResponse({ message: '清理失败' }, 500);
        if (commands === 2) return new Promise<Response>((resolve) => { settleCleanup = resolve; });
        return jsonResponse({ deleted: [] });
      }
      if (url.endsWith('/api/v1/conversations')) {
        reads++;
        if (reads === 2) return new Promise<Response>((resolve) => { settleRefresh = resolve; });
        return jsonResponse(initial);
      }
      return null;
    });
    function Probe() {
      const { resources, refreshConversations } = useApp();
      return <>
        <button onClick={() => void refreshConversations()}>刷新话题</button>
        <span data-testid="ids">{resources.conversations.map(({ id }) => id).join(',')}</span>
      </>;
    }
    const user = setups(fetchMock, <Probe />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('deleted,kept'));
    const open = () => user.click(screen.getByRole('button', { name: '删除未分组话题' }));
    const dialog = () => within(screen.getByRole('dialog', { name: '删除未分组话题' }));
    const confirm = () => user.click(dialog().getByRole('button', { name: '删除' }));
    await open();
    expect(dialog().getByText(/所有助手.*保留置顶和已分组话题/)).toBeInTheDocument();
    await user.click(dialog().getByRole('button', { name: '取消' }));
    expect(commands).toBe(0);
    await open();
    await confirm();
    expect(await screen.findByText('清理失败')).toBeInTheDocument();
    expect(screen.queryByText(/已删除|没有未分组话题/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '刷新话题' }));
    await waitFor(() => expect(reads).toBe(2));
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(commands).toBe(1);
    await confirm();
    await waitFor(() => expect(commands).toBe(2));
    const button = dialog().getByRole('button', { name: '删除' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(commands).toBe(2);
    expect(compactCalls).toBe(0);
    failNextStats = true;
    await act(async () => settleCleanup(jsonResponse({ deleted: [{ id: 'deleted', assistantId: 'default' }] })));
    expect(await screen.findByText('已删除 1 个话题')).toBeInTheDocument();
    expect(await screen.findByText('无法读取磁盘占用')).toBeInTheDocument();
    await act(async () => settleRefresh(jsonResponse(initial)));
    expect(screen.getByTestId('ids')).toHaveTextContent(/^kept$/);
    const statsBeforeRetry = stats;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(commands).toBe(2);
    await waitFor(() => expect(stats).toBe(statsBeforeRetry + 1));
    expect(screen.getByText('已删除 1 个话题')).toBeInTheDocument();
    await open();
    await confirm();
    expect(await screen.findByText('没有未分组话题')).toBeInTheDocument();
    expect(compactCalls).toBe(0);
    await user.click(screen.getByRole('button', { name: '压缩数据库' }));
    expect(compactCalls).toBe(1);
    expect(screen.queryByText('本地存储')).toBeNull();
    expect(screen.queryByRole('button', { name: '打开数据目录' })).toBeNull();
  });

  it('renders desktop local storage panel with compact, clear-cache, local cleanup, and open-dir bridge', async () => {
    const openDirSpy = vi.fn().mockResolvedValue(undefined);
    window.__LLMSTUDIO_DESKTOP__ = {
      apiBaseUrl: 'http://127.0.0.1:45123',
      sessionToken: 'desktop-tok',
      platform: 'windows',
      dataMode: 'portable',
      version: '1.5.0',
    };
    window.mygo = { call: openDirSpy };

    try {
      const requested: string[] = [];
      let localBytes = 16384;
      const fetchMock = baseFetch((url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        requested.push(`${method} ${url}`);
        if (url.endsWith('/api/v1/desktop/status')) {
          return jsonResponse({
            mode: 'portable',
            dataDir: 'D:\\Portable\\data',
            dbPath: 'D:\\Portable\\data\\llmstudio.db',
            cloudConfigured: false,
            cloudState: 'disconnected',
            gatewayBaseUrl: '',
            tokenSet: false,
            authRequired: false,
            version: '1.5.0',
          });
        }
        if (url.endsWith('/api/v1/desktop/storage')) {
          return jsonResponse({
            mainBytes: localBytes,
            walBytes: 2048,
            totalBytes: localBytes + 2048,
            compactable: true,
            mode: 'portable',
            dataDir: 'D:\\Portable\\data',
            conversationCount: 3,
            messageCount: 12,
          });
        }
        if (url.endsWith('/api/v1/desktop/storage/compact') && method === 'POST') {
          localBytes = 8192;
          return jsonResponse({
            beforeBytes: 18432,
            afterBytes: 8192,
            freedBytes: 10240,
            usage: {
              mainBytes: 8192,
              walBytes: 0,
              totalBytes: 8192,
              compactable: true,
            },
          });
        }
        if (url.endsWith('/api/v1/desktop/storage/clear-cache') && method === 'POST') {
          return jsonResponse({ cleared: true });
        }
        if (url.endsWith('/api/v1/desktop/storage/cleanup-ungrouped') && method === 'POST') {
          return jsonResponse({ deleted: [{ id: 'loc-1', assistantId: 'default' }] });
        }
        return null;
      });

      const user = setups(fetchMock);
      await waitFor(() => expect(screen.getByText('本地存储')).toBeInTheDocument());
      expect(screen.getByText('便携模式')).toBeInTheDocument();
      expect(screen.getByText('D:\\Portable\\data')).toBeInTheDocument();
      expect(screen.getByText('3 话题 · 12 消息')).toBeInTheDocument();
      expect(screen.getByText('云端存储')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '前往连接' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '打开数据目录' }));
      expect(openDirSpy).toHaveBeenCalledWith('DesktopBridge.OpenDataDir');

      await user.click(screen.getByRole('button', { name: '压缩本地库' }));
      expect(await screen.findByText('已释放 10.0 KB')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '清空缓存' }));
      expect(await screen.findByText('缓存已清空')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '删除本地未分组话题' }));
      const dlg = within(screen.getByRole('dialog', { name: '删除本地未分组话题' }));
      await user.click(dlg.getByRole('button', { name: '删除' }));
      expect(await screen.findByText('已删除 1 个话题')).toBeInTheDocument();
      expect(requested.some((r) => r.includes('/api/v1/desktop/storage/cleanup-ungrouped'))).toBe(true);
    } finally {
      delete window.__LLMSTUDIO_DESKTOP__;
      delete window.mygo;
      delete document.documentElement.dataset.desktop;
    }
  });
});
