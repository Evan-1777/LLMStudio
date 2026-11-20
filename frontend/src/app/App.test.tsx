import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './AppProvider';
import { ConnectionGate } from './ConnectionGate';
import { AppRoutes } from './routes';
import { SettingsLayout } from '../features/settings/SettingsLayout';
import { Modal, ConfirmDialog } from '../components/ui';
import { chatReducer, initialChatState } from '../features/chat/chatReducer';
import {
  CONNECTION_STORAGE_KEY,
  DEFAULT_APPLE_BLUE,
  SETTINGS_STORAGE_KEY,
  defaultSettings,
  readThemeHint,
} from '../core/settings';

// Mirrors the gateway's GET /api/v1/settings envelope with server defaults.
function settingsEnvelope(overrides: Record<string, unknown> = {}) {
  const { gatewayBaseUrl, accessToken, ...preferences } = defaultSettings();
  void gatewayBaseUrl;
  void accessToken;
  return { preferences: { ...preferences, ...overrides }, initialized: false };
}

describe('AppProvider, ConnectionGate, and Routing', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.pushState({}, '', '/chat');
  });

  it('halts protected API calls on startup when authRequired is true and token is empty, then recovers on connect', async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0', authRequired: true }),
          { status: 200 },
        );
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth !== 'Bearer valid-token') {
        return new Response(
          JSON.stringify({ code: 'UNAUTHORIZED', message: 'bad token' }),
          { status: 401 },
        );
      }
      if (url.endsWith('/api/v1/settings')) {
        return new Response(JSON.stringify(settingsEnvelope()), {
          status: 200,
        });
      }
      if (url.endsWith('/api/v1/formats')) {
        return new Response(JSON.stringify({ formats: [], adapters: [] }), {
          status: 200,
        });
      }
      if (url.endsWith('/api/v1/providers')) {
        return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(
          JSON.stringify({
            assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(JSON.stringify({ engines: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat']}>
          <ConnectionGate>
            <AppRoutes />
          </ConnectionGate>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('需要访问令牌')).toBeInTheDocument();
    });
    expect(requestedUrls).toEqual(['/healthz']);

    await user.type(screen.getByLabelText('访问令牌'), 'wrong-token');
    await user.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => {
      expect(screen.getByText('需要访问令牌')).toBeInTheDocument();
    });

    const tokenInput = screen.getByLabelText('访问令牌');
    await user.clear(tokenInput);
    await user.type(tokenInput, 'valid-token');
    await user.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '默认助手', current: true }),
      ).toBeInTheDocument();
    });
  });

  it('restores the stored connection token on startup and reaches the workspace without re-entering it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0', authRequired: true }),
          { status: 200 },
        );
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth !== 'Bearer stored-token') {
        return new Response(
          JSON.stringify({ code: 'UNAUTHORIZED', message: 'bad token' }),
          { status: 401 },
        );
      }
      if (url.endsWith('/api/v1/settings')) {
        return new Response(JSON.stringify(settingsEnvelope()), { status: 200 });
      }
      if (url.endsWith('/api/v1/formats')) {
        return new Response(JSON.stringify({ formats: [], adapters: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/providers')) {
        return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(
          JSON.stringify({
            assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(JSON.stringify({ engines: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    localStorage.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({ gatewayBaseUrl: '/', accessToken: 'stored-token' }),
    );
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat']}>
          <ConnectionGate>
            <AppRoutes />
          </ConnectionGate>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '默认助手', current: true }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('需要访问令牌')).not.toBeInTheDocument();
  });

  it('hydrates preferences from the gateway and patches single fields without reconnecting', async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    const serverPreferences: Record<string, unknown> = {
      themeMode: 'dark',
      seedColorValue: 0xff3f5f90,
      enterToSend: false,
      visualHtmlRender: true,
      defaultHtmlPreview: false,
      chatDisplayMode: 'feed',
      autoCollapseEnabled: true,
      autoCollapseThinkingOnComplete: true,
      autoCollapseToolsOnComplete: true,
      autoCreateCache: false,
      collapseLineThreshold: 24,
      collapseCharThreshold: 1200,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '1.0.0', authRequired: false }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/settings')) {
        if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<
            string,
            unknown
          >;
          patchBodies.push(body);
          Object.assign(serverPreferences, body);
        }
        return new Response(
          JSON.stringify({
            preferences: { ...serverPreferences },
            initialized: true,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/settings/appearance']}>
          <SettingsLayout section="appearance" />
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });

    const healthCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/healthz'),
      ).length;
    const healthBefore = healthCalls();

    await user.click(screen.getByRole('radio', { name: '浅色' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    // A single field is submitted, without reconnecting the gateway.
    expect(patchBodies).toContainEqual({ themeMode: 'light' });
    expect(healthCalls()).toBe(healthBefore);

    // A rejected write rolls back to the last confirmed value.
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ code: 'INTERNAL_ERROR', message: '写入失败' }),
        { status: 500 },
      ),
    );
    await user.click(screen.getByRole('radio', { name: '深色' }));
    await waitFor(() => {
      expect(screen.getByText(/设置保存失败/)).toBeInTheDocument();
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('imports legacy browser preferences once and keeps a first-paint theme hint', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...defaultSettings(),
        themeMode: 'dark',
        enterToSend: false,
      }),
    );

    let importBody: Record<string, unknown> | null = null;
    let importAuthorized = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '1.0.0', authRequired: true }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/settings/import')) {
        importBody = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        importAuthorized =
          (init?.headers as Record<string, string>)?.Authorization ===
          'Bearer legacy-token';
        return new Response(
          JSON.stringify({
            preferences: {
              ...defaultSettings(),
              themeMode: 'dark',
              enterToSend: false,
            },
            initialized: true,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/settings')) {
        return new Response(
          JSON.stringify({ preferences: defaultSettings(), initialized: false }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const user = userEvent.setup();
    localStorage.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({ gatewayBaseUrl: '/', accessToken: '' }),
    );
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat']}>
          <ConnectionGate>
            <AppRoutes />
          </ConnectionGate>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('需要访问令牌')).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText('访问令牌'), 'legacy-token');
    await user.click(screen.getByRole('button', { name: '连接' }));

    await waitFor(() => {
      expect(importBody).not.toBeNull();
    });
    expect(importBody).toMatchObject({ themeMode: 'dark', enterToSend: false });
    expect(importAuthorized).toBe(true);
    // The imported values are authoritative and the browser copy is gone.
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(readThemeHint('/')).toEqual({
      themeMode: 'dark',
      seedColorValue: DEFAULT_APPLE_BLUE,
      fontFamily: 'system',
      fontSize: 14,
    });
  });

  it('redirects unknown settings section to providers and preserves deep links', () => {
    render(
      <AppProvider skipInitialBootstrap>
        <MemoryRouter initialEntries={['/settings/nonexistent']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    expect(
      screen.getByRole('heading', { name: '模型服务' }),
    ).toBeInTheDocument();

    render(
      <AppProvider skipInitialBootstrap>
        <MemoryRouter initialEntries={['/chat/conv-123']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    expect(screen.getByLabelText('消息输入框')).toBeInTheDocument();
  });

  it('aborts old requests and clears stale resources when switching gateway', async () => {
    let releaseFirstProviders!: () => void;
    const firstProvidersPromise = new Promise<Response>((resolve) => {
      releaseFirstProviders = () =>
        resolve(
          new Response(
            JSON.stringify({
              providers: [
                {
                  id: 'old-p',
                  name: 'Old Provider',
                  adapter: 'generic-http',
                  baseURL: 'https://old.example',
                  authType: 'none',
                  apiKeyMasked: '',
                  apiKeySet: false,
                  models: [],
                  enabled: true,
                  builtIn: false,
                },
              ],
            }),
            { status: 200 },
          ),
        );
    });

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0', authRequired: false }),
          { status: 200 },
        );
      }
      if (url.startsWith('/') && url.endsWith('/api/v1/providers')) {
        return firstProvidersPromise;
      }
      if (url.endsWith('/api/v1/formats')) {
        return new Response(JSON.stringify({ formats: [], adapters: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/providers')) {
        return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(JSON.stringify({ assistants: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(JSON.stringify({ engines: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    function SwitchTester() {
      const { resources, saveConnection } = useApp();
      return (
        <div>
          <span data-testid="provider-names">
            {resources.providers.map((p) => p.name).join(',')}
          </span>
          <button
            type="button"
            onClick={() =>
              void saveConnection({
                gatewayBaseUrl: 'https://new-gw.example',
                accessToken: '',
              })
            }
          >
            switch
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <SwitchTester />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'switch' }));
    releaseFirstProviders();

    await waitFor(() => {
      expect(screen.getByTestId('provider-names')).toHaveTextContent('');
    });
  });

  it('closes Modal on Escape and restores focus to trigger', async () => {
    function ModalHarness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            打开模态
          </button>
          <Modal open={open} onOpenChange={setOpen} title="测试弹窗">
            <input aria-label="输入内容" />
          </Modal>
        </div>
      );
    }

    const user = userEvent.setup();
    render(<ModalHarness />);
    const trigger = screen.getByRole('button', { name: '打开模态' });
    await user.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it('guards Modal and ConfirmDialog against Esc during pending action, displays busy state, and restores focus on close', async () => {
    function BusyConfirmHarness() {
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            触发确认
          </button>
          {err ? <span role="alert">操作失败</span> : null}
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="删除确认"
            message="确认执行？"
            confirmLabel="执行"
            busy={busy}
            onConfirm={async () => {
              setBusy(true);
              await new Promise((r) => setTimeout(r, 30));
              setBusy(false);
              setErr(true);
            }}
          />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<BusyConfirmHarness />);
    const trigger = screen.getByRole('button', { name: '触发确认' });
    await user.click(trigger);

    const confirmBtn = screen.getByRole('button', { name: '执行' });
    await user.click(confirmBtn);
    expect(confirmBtn).toBeDisabled();
    expect(confirmBtn).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');

    // Escape cannot dismiss while busy
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // After failure finishes, busy clears -> Escape dismisses and returns focus
    await waitFor(() => {
      expect(confirmBtn).not.toBeDisabled();
      expect(screen.getByText('操作失败')).toBeInTheDocument();
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it('preserves loaded messages on same-conversation reload instead of wiping the canvas', () => {
    const conv = {
      id: 'conv-same',
      assistantId: 'default',
      title: '同会话',
      providerId: 'p1',
      modelId: 'm1',
      params: {},
      syncEnabled: false,
      syncState: 'local_only' as const,
      syncVersion: 0,
      createdAt: '2026-11-17T08:00:00Z',
      updatedAt: '2026-11-17T08:00:00Z',
    };
    const msg = {
      id: 'm1',
      conversationId: 'conv-same',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: '已有消息' }],
      createdAt: '2026-11-17T08:00:01Z',
    };
    const loaded = chatReducer(initialChatState, {
      type: 'LOAD_SUCCESS',
      conversation: conv,
      messages: [msg],
    });
    const reloadingSame = chatReducer(loaded, {
      type: 'LOAD_START',
      conversationId: 'conv-same',
    });
    expect(reloadingSame.runState).toBe('loading');
    expect(reloadingSame.messages).toHaveLength(1);

    const switchingConv = chatReducer(loaded, {
      type: 'LOAD_START',
      conversationId: 'conv-other',
    });
    expect(switchingConv.runState).toBe('loading');
    expect(switchingConv.messages).toHaveLength(0);
  });

  it('preserves conversation return path across Settings hops and guards dirty plugin edits', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({ status: 'ok', version: '1.2.0', authRequired: false }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/formats')) {
        return new Response(JSON.stringify({ formats: [], adapters: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/providers')) {
        return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(
          JSON.stringify({
            assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(
          JSON.stringify({
            conversations: [
              {
                id: 'conv-keep',
                assistantId: 'default',
                title: '保持选中话题',
                providerId: '',
                modelId: '',
                params: {},
                syncEnabled: false,
                syncState: 'local_only',
                syncVersion: 0,
                createdAt: '2026-11-17T08:00:00Z',
                updatedAt: '2026-11-17T08:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/conv-keep')) {
        return new Response(
          JSON.stringify({
            conversation: {
              id: 'conv-keep',
              assistantId: 'default',
              title: '保持选中话题',
              providerId: '',
              modelId: '',
              params: {},
              syncEnabled: false,
              syncState: 'local_only',
              syncVersion: 0,
              createdAt: '2026-11-17T08:00:00Z',
              updatedAt: '2026-11-17T08:00:00Z',
            },
            messages: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(
          JSON.stringify({
            engines: [
              {
                engineId: 'tavily',
                displayName: 'Tavily Search',
                defaultEndpoint: 'https://api.tavily.com/search',
                requiresApiKey: true,
                enabled: false,
                endpoint: 'https://api.tavily.com/search',
                apiKeyMasked: '',
                apiKeySet: false,
                maxResults: 5,
                isDefault: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat/conv-keep']}>
          <ConnectionGate>
            <AppRoutes />
          </ConnectionGate>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('保持选中话题')).toBeInTheDocument();
    });

    // Enter Settings -> switch to Plugins -> modify endpoint -> navigate triggers dirty confirmation.
    await user.click(screen.getByRole('link', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '插件' }));
    await waitFor(() => {
      expect(screen.getByText('Tavily Search')).toBeInTheDocument();
    });
    const endpointInput = screen.getByLabelText('服务地址');
    await user.type(endpointInput, '/v2');

    await user.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(screen.getByText('放弃未保存的更改？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    // Clear dirty change and navigate Plugins -> Appearance -> back to /chat/conv-keep.
    await user.clear(endpointInput);
    await user.type(endpointInput, 'https://api.tavily.com/search');
    await user.click(screen.getByRole('link', { name: /外观与显示/ }));
    expect(screen.getByRole('heading', { level: 1, name: '外观与显示' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回工作台' }));
    await waitFor(() => {
      expect(screen.getByLabelText('消息输入框')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    expect(
      screen.getByRole('button', { name: /^保持选中话题/ }),
    ).toHaveAttribute('aria-current', 'true');
  });

  it('desktop mode bypasses ConnectionGate offline, persists cloud connection in SQLite facade, and reflects cloud status in SettingsLayout', async () => {
    window.__LLMSTUDIO_DESKTOP__ = {
      apiBaseUrl: 'http://127.0.0.1:43211',
      sessionToken: 'desktop-tok-app',
      platform: 'windows',
      dataMode: 'portable',
      version: '1.5.0',
    };

    try {
      let conn = { gatewayBaseUrl: '', tokenSet: false };
      let cloudState = 'disconnected';
      const user = userEvent.setup();

      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          'Bearer desktop-tok-app',
        );
        if (url.endsWith('/api/v1/desktop/status')) {
          return new Response(
            JSON.stringify({
              mode: 'portable',
              dataDir: 'D:\\LLMStudio\\data',
              dbPath: 'D:\\LLMStudio\\data\\llmstudio.db',
              cloudConfigured: Boolean(conn.gatewayBaseUrl),
              cloudState,
              gatewayBaseUrl: conn.gatewayBaseUrl,
              tokenSet: conn.tokenSet,
              authRequired: conn.tokenSet,
              version: '1.5.0',
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/v1/desktop/connection') && method === 'GET') {
          return new Response(JSON.stringify(conn), { status: 200 });
        }
        if (url.endsWith('/api/v1/desktop/connection/test') && method === 'POST') {
          return new Response(
            JSON.stringify({ ok: true, authRequired: true, latencyMs: 14, message: 'ok' }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/v1/desktop/connection') && method === 'PUT') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            gatewayBaseUrl: string;
            accessToken: string;
          };
          conn = { gatewayBaseUrl: body.gatewayBaseUrl, tokenSet: Boolean(body.accessToken) };
          cloudState = 'connected';
          return new Response(
            JSON.stringify({
              connection: conn,
              status: {
                mode: 'portable',
                dataDir: 'D:\\LLMStudio\\data',
                dbPath: 'D:\\LLMStudio\\data\\llmstudio.db',
                cloudConfigured: true,
                cloudState: 'connected',
                gatewayBaseUrl: conn.gatewayBaseUrl,
                tokenSet: conn.tokenSet,
                authRequired: true,
                version: '1.5.0',
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/v1/desktop/connection') && method === 'DELETE') {
          conn = { gatewayBaseUrl: '', tokenSet: false };
          cloudState = 'disconnected';
          return new Response(
            JSON.stringify({
              mode: 'portable',
              dataDir: 'D:\\LLMStudio\\data',
              dbPath: 'D:\\LLMStudio\\data\\llmstudio.db',
              cloudConfigured: false,
              cloudState: 'disconnected',
              gatewayBaseUrl: '',
              tokenSet: false,
              authRequired: false,
              version: '1.5.0',
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/v1/settings')) {
          return new Response(
            JSON.stringify(settingsEnvelope({ themeMode: 'dark' })),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/v1/formats')) return new Response(JSON.stringify({ formats: [], adapters: [] }), { status: 200 });
        if (url.endsWith('/api/v1/providers')) return new Response(JSON.stringify({ providers: [] }), { status: 200 });
        if (url.endsWith('/api/v1/assistants')) return new Response(JSON.stringify({ assistants: [] }), { status: 200 });
        if (url.includes('/api/v1/conversations')) return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
        if (url.includes('/api/v1/conversation-groups')) return new Response(JSON.stringify({ groups: [] }), { status: 200 });
        if (url.endsWith('/api/v1/plugins/search')) return new Response(JSON.stringify({ engines: [] }), { status: 200 });
        if (url.includes('/api/v1/mcp/servers')) return new Response(JSON.stringify({ servers: [] }), { status: 200 });
        return new Response('{}', { status: 200 });
      });

      render(
        <AppProvider fetchImpl={fetchMock}>
          <MemoryRouter initialEntries={['/settings/connection']}>
            <ConnectionGate>
              <Routes>
                <Route path="/settings/:section" element={<SettingsLayout />} />
              </Routes>
            </ConnectionGate>
          </MemoryRouter>
        </AppProvider>,
      );

      await waitFor(() => expect(screen.getByText('云端未连接')).toBeInTheDocument());
      expect(document.documentElement.dataset.desktop).toBe('true');

      await user.type(screen.getByLabelText('网关地址'), 'https://vps.example.com');
      await user.type(screen.getByLabelText('访问令牌'), 'cloud-secret');
      await user.click(screen.getByRole('button', { name: '测试连接' }));
      await waitFor(() => expect(screen.getByText(/连接成功/)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: '保存连接' }));
      await waitFor(() => expect(screen.getByText('云端已连接')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: '断开云端' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '断开云端' }));
      await waitFor(() => expect(screen.getByText('云端未连接')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: '断开云端' })).toBeNull();
    } finally {
      delete window.__LLMSTUDIO_DESKTOP__;
      delete document.documentElement.dataset.desktop;
    }
  });
});
