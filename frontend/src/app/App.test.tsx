import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider, useApp } from './AppProvider';
import { ConnectionGate } from './ConnectionGate';
import { AppRoutes } from './routes';
import { Modal } from '../components/ui';

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
});
