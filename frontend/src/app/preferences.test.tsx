import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './AppProvider';
import { defaultSettings } from '../core/settings';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function PreferenceProbe() {
  const { settings, updatePreferences } = useApp();
  return (
    <div>
      <span data-testid="theme">{settings.themeMode}</span>
      <span data-testid="avatar">{settings.userAvatarDataUrl || 'none'}</span>
      <span data-testid="typography">{`${settings.fontFamily}:${settings.fontSize}`}</span>
      <button type="button" onClick={() => void updatePreferences({ themeMode: 'dark' })}>
        主题
      </button>
      <button
        type="button"
        onClick={() => void updatePreferences({ userAvatarDataUrl: 'data:image/png;base64,AAAA' })}
      >
        头像
      </button>
      <button
        type="button"
        onClick={() => void updatePreferences({ fontFamily: 'kai', fontSize: 18 })}
      >
        排版
      </button>
    </div>
  );
}

describe('shared preference writes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('applies out-of-order responses per field and rolls back only the failed patch', async () => {
    const { gatewayBaseUrl, accessToken, ...preferences } = defaultSettings();
    void gatewayBaseUrl;
    void accessToken;
    const server: Record<string, unknown> = { ...preferences };
    const themeGate: { release: (() => void) | null } = { release: null };
    let failAvatar = false;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/settings')) {
        if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
          const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (patch.themeMode !== undefined) {
            // The slow theme save answers with the snapshot taken when it started,
            // which still carries the avatar value from before the later write.
            const snapshot = { ...server, ...patch };
            Object.assign(server, patch);
            await new Promise<void>((resolve) => {
              themeGate.release = resolve;
            });
            return jsonResponse({ preferences: snapshot, initialized: true });
          }
          if (failAvatar) {
            return jsonResponse({ code: 'INTERNAL', message: 'avatar write failed' }, 500);
          }
          Object.assign(server, patch);
          return jsonResponse({ preferences: { ...server }, initialized: true });
        }
        return jsonResponse({ preferences: { ...server }, initialized: true });
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock} skipInitialBootstrap>
        <PreferenceProbe />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: '主题' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    await user.click(screen.getByRole('button', { name: '头像' }));
    await waitFor(() => {
      expect(screen.getByTestId('avatar')).toHaveTextContent('data:image/png');
    });

    // The slow theme response still carries the old avatar; it must not revert it.
    themeGate.release?.();
    await waitFor(() => {
      expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    });
    expect(screen.getByTestId('avatar')).toHaveTextContent('data:image/png');

    // A failed save rolls back its own field to the last confirmed avatar.
    failAvatar = true;
    await user.click(screen.getByRole('button', { name: '头像' }));
    await waitFor(() => {
      expect(screen.getByTestId('avatar')).toHaveTextContent('data:image/png');
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    failAvatar = false;
    await user.click(screen.getByRole('button', { name: '排版' }));
    await waitFor(() => {
      expect(screen.getByTestId('typography')).toHaveTextContent('kai:18');
    });
    expect(document.documentElement.dataset.fontFamily).toBe('kai');
    expect(
      document.documentElement.style.getPropertyValue('--font-size-base'),
    ).toBe('18px');
  });
});
