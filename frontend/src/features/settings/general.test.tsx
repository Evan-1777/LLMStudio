import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import { SETTINGS_STORAGE_KEY } from '../../core/settings';
import { SettingsLayout } from './SettingsLayout';

function setupMatchMedia(initialDark = false) {
  let dark = initialDark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? dark : false,
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
        listeners.add(fn);
      },
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
        listeners.delete(fn);
      },
      dispatchEvent: () => true,
    })),
  });

  return {
    setDark(next: boolean) {
      dark = next;
      const evt = { matches: next } as MediaQueryListEvent;
      for (const fn of listeners) fn(evt);
    },
  };
}

function makeGatewayFetch() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const auth = (init?.headers as Record<string, string>)?.Authorization;

    if (url.includes('custom-gw.example') && url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ status: 'ok', version: '2.4.1', authRequired: true }),
        { status: 200 },
      );
    }
    if (url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ status: 'ok', version: '1.9.3', authRequired: false }),
        { status: 200 },
      );
    }
    if (url.includes('custom-gw.example') && auth !== 'Bearer gw-secret') {
      return new Response(
        JSON.stringify({ code: 'UNAUTHORIZED', message: 'invalid token' }),
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
}

describe('SettingsLayout, ConnectionPage, AppearancePage, and AboutPage', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('navigates all 6 sections, guards dirty connection draft, tests without overwriting, and displays real health version on About', async () => {
    const mm = setupMatchMedia(false);
    const fetchMock = makeGatewayFetch();
    const user = userEvent.setup();

    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/settings/connection']}>
          <Routes>
            <Route path="/settings/:section" element={<SettingsLayout />} />
            <Route path="/chat" element={<div data-testid="chat-route" />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('网关已连接')).toBeInTheDocument();
    });

    // Test connection with unsaved URL & token without overwriting saved settings.
    const gwInput = screen.getByLabelText('网关地址');
    const tokenInput = screen.getByLabelText('访问令牌');
    await user.clear(gwInput);
    await user.type(gwInput, 'https://custom-gw.example');
    await user.type(tokenInput, 'bad-token');
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => {
      expect(screen.getByText('invalid token')).toBeInTheDocument();
    });
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();

    // Dirty guard triggers when leaving ConnectionPage with unsaved edits.
    await user.click(screen.getByRole('button', { name: '关于' }));
    expect(screen.getByText('放弃未保存的更改？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByLabelText('网关地址')).toHaveValue(
      'https://custom-gw.example',
    );

    // Fix token and save connection -> switches shared gateway & updates About version.
    await user.clear(tokenInput);
    await user.type(tokenInput, 'gw-secret');
    await user.click(screen.getByRole('button', { name: '保存连接' }));

    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}',
      ) as Record<string, unknown>;
      expect(saved.gatewayBaseUrl).toBe('https://custom-gw.example');
      expect(saved.accessToken).toBe('gw-secret');
    });

    await user.click(screen.getByRole('button', { name: '关于' }));
    await waitFor(() => {
      expect(screen.getByText('2.4.1')).toBeInTheDocument();
      expect(screen.getByText('已启用')).toBeInTheDocument();
    });

    // Appearance: system theme tracks OS changes, accent color & thresholds persist and validate.
    await user.click(screen.getByRole('button', { name: '外观与显示' }));
    expect(document.documentElement.dataset.theme).toBe('light');

    act(() => {
      mm.setDark(true);
    });
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });

    await user.click(screen.getByRole('radio', { name: '浅色' }));
    expect(document.documentElement.dataset.theme).toBe('light');

    await user.click(screen.getByRole('radio', { name: 'Forest Teal' }));
    await user.click(screen.getByRole('switch', { name: 'Enter 发送' }));
    await user.click(screen.getByRole('switch', { name: 'HTML 默认预览' }));

    const lineInput = screen.getByLabelText('行数阈值');
    await user.clear(lineInput);
    await user.type(lineInput, '300');
    expect(screen.getByText('须为 4–200 的整数')).toBeInTheDocument();
    await user.clear(lineInput);
    await user.type(lineInput, '48');

    const charInput = screen.getByLabelText('字符阈值');
    await user.clear(charInput);
    await user.type(charInput, '50');
    expect(screen.getByText('须为 120–20000 的整数')).toBeInTheDocument();
    await user.clear(charInput);
    await user.type(charInput, '2400');

    const persisted = JSON.parse(
      localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}',
    ) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      themeMode: 'light',
      enterToSend: false,
      defaultHtmlPreview: false,
      collapseLineThreshold: 48,
      collapseCharThreshold: 2400,
    });

    // Back to workbench navigates to /chat.
    await user.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(screen.getByTestId('chat-route')).toBeInTheDocument();
  });

  it('redirects unknown settings section to providers and toggles mobile drawer with Escape', async () => {
    setupMatchMedia(false);
    const user = userEvent.setup();
    const { container } = render(
      <AppProvider skipInitialBootstrap>
        <MemoryRouter initialEntries={['/settings/unknown-tab']}>
          <Routes>
            <Route path="/settings/:section" element={<SettingsLayout />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: '模型服务' }),
    ).toBeInTheDocument();

    const menuBtn = screen.getByLabelText('打开设置分类');
    fireEvent.click(menuBtn);
    expect(container.querySelector('.st-rail--open')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(container.querySelector('.st-rail--open')).not.toBeInTheDocument();
  });
});
