import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import { AppRoutes } from '../../app/routes';
import type { MyGoRuntimeBridge } from '../../core/desktop';
import { defaultAppPreferences } from '../../core/settings';
import { SettingsLayout } from './SettingsLayout';

function gatewayFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ status: 'ok', version: '1.5.0', authRequired: false }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/desktop/status')) {
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
        JSON.stringify({
          preferences: defaultAppPreferences(),
          initialized: true,
        }),
        { status: 200 },
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
    if (url.includes('/api/v1/conversations')) {
      return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
    }
    if (url.includes('/api/v1/conversation-groups')) {
      return new Response(JSON.stringify({ groups: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/plugins/search')) {
      return new Response(JSON.stringify({ engines: [] }), { status: 200 });
    }
    if (url.includes('/api/v1/mcp/servers')) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

function desktopBootstrap() {
  window.__LLMSTUDIO_DESKTOP__ = {
    apiBaseUrl: 'http://127.0.0.1:43211',
    sessionToken: 'desktop-token-client',
    platform: 'windows',
    dataMode: 'portable',
    version: '1.5.0',
  };
}

function renderClient() {
  return render(
    <AppProvider fetchImpl={gatewayFetch()}>
      <MemoryRouter initialEntries={['/settings/client']}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsLayout />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>,
  );
}

describe('ClientPage', () => {
  beforeEach(() => {
    localStorage.clear();
    desktopBootstrap();
  });

  afterEach(() => {
    delete window.__LLMSTUDIO_DESKTOP__;
    delete window.mygo;
    delete document.documentElement.dataset.desktop;
  });

  it('loads the confirmed behavior and persists a tray close choice', async () => {
    const call = vi.fn(async (method: string, ...args: unknown[]) => {
      if (method === 'DesktopBridge.GetClientSettings') {
        return { closeToTray: false, trayAvailable: true };
      }
      if (method === 'DesktopBridge.SetCloseToTray') {
        return { closeToTray: Boolean(args[0]), trayAvailable: true };
      }
      throw new Error('unexpected method ' + method);
    });
    window.mygo = { call: call as unknown as NonNullable<MyGoRuntimeBridge['call']> };
    const user = userEvent.setup();
    renderClient();

    const exitOption = await screen.findByRole('radio', { name: '退出应用' });
    expect(exitOption).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: '最小化到托盘' }));
    await waitFor(() => {
      expect(
        screen.getByRole('radio', { name: '最小化到托盘' }),
      ).toHaveAttribute('aria-checked', 'true');
    });
    expect(call).toHaveBeenCalledWith('DesktopBridge.SetCloseToTray', true);
  });

  it('keeps the previous value and shows an alert when saving fails', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'DesktopBridge.GetClientSettings') {
        return { closeToTray: false, trayAvailable: true };
      }
      throw new Error('无法写入关闭设置');
    });
    window.mygo = { call: call as unknown as NonNullable<MyGoRuntimeBridge['call']> };
    const user = userEvent.setup();
    renderClient();

    await screen.findByRole('radio', { name: '退出应用' });
    await user.click(screen.getByRole('radio', { name: '最小化到托盘' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('无法写入关闭设置');
    expect(screen.getByRole('radio', { name: '退出应用' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('disables the tray choice and says so when the tray is unavailable', async () => {
    window.mygo = {
      call: vi.fn(async () => ({
        closeToTray: true,
        trayAvailable: false,
      })) as unknown as NonNullable<MyGoRuntimeBridge['call']>,
    };
    renderClient();

    const trayOption = await screen.findByRole('radio', {
      name: '最小化到托盘',
    });
    expect(trayOption).toBeDisabled();
    expect(trayOption).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '退出应用' })).toBeEnabled();
    expect(
      screen.getByText('系统托盘不可用，关闭按钮将退出应用。'),
    ).toBeInTheDocument();
  });

  it('is absent on the web, including a direct client settings URL', async () => {
    delete window.__LLMSTUDIO_DESKTOP__;
    const call = vi.fn();
    window.mygo = { call: call as unknown as NonNullable<MyGoRuntimeBridge['call']> };

    render(
      <AppProvider fetchImpl={gatewayFetch()} skipInitialBootstrap>
        <MemoryRouter initialEntries={['/settings/client']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: '模型服务' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '客户端设置' }),
    ).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});
