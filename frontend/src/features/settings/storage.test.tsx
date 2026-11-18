import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
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

function setups(fetchMock: ReturnType<typeof vi.fn>) {
  const user = userEvent.setup();
  render(
    <AppProvider fetchImpl={fetchMock as unknown as typeof fetch}>
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
});
