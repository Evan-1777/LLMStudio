import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDesktopBootstrap,
  getDesktopClientSettings,
  isDesktopApp,
  openDesktopDataDir,
  setDesktopCloseToTray,
} from './desktop';
import { readThemeHint, themeHintKey, writeThemeHint } from './settings';

function clearDesktopEnv() {
  delete window.__LLMSTUDIO_DESKTOP__;
  delete window.mygo;
  delete document.documentElement.dataset.desktop;
  document.documentElement.removeAttribute('data-theme');
}

describe('desktop runtime detection and themeHint isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    clearDesktopEnv();
  });

  afterEach(() => {
    clearDesktopEnv();
  });

  it('detects __LLMSTUDIO_DESKTOP__, invokes MyGo OpenDataDir bridge, and pins desktop themeHintKey across random ports', async () => {
    expect(isDesktopApp()).toBe(false);
    expect(getDesktopBootstrap()).toBeNull();
    expect(themeHintKey('http://127.0.0.1:41234')).toBe(
      'llmstudio.themeHint.v1::http://127.0.0.1:41234',
    );
    await expect(openDesktopDataDir()).rejects.toThrow('原生桌面桥接不可用');

    const callSpy = vi.fn().mockResolvedValue(undefined);
    window.__LLMSTUDIO_DESKTOP__ = {
      apiBaseUrl: 'http://127.0.0.1:41234',
      sessionToken: 'tok-abc',
      platform: 'windows',
      dataMode: 'portable',
      version: '1.5.0',
    };
    window.mygo = { call: callSpy };

    expect(isDesktopApp()).toBe(true);
    expect(getDesktopBootstrap()).toEqual(window.__LLMSTUDIO_DESKTOP__);
    expect(themeHintKey('http://127.0.0.1:41234')).toBe('llmstudio.themeHint.v1::desktop');
    expect(themeHintKey('http://127.0.0.1:59999')).toBe('llmstudio.themeHint.v1::desktop');

    writeThemeHint('http://127.0.0.1:41234', {
      themeMode: 'dark',
      seedColorValue: 0xff007aff,
    });
    expect(readThemeHint('http://127.0.0.1:59999')?.themeMode).toBe('dark');

    await openDesktopDataDir();
    expect(callSpy).toHaveBeenCalledWith('DesktopBridge.OpenDataDir');

    callSpy.mockResolvedValueOnce({ closeToTray: false, trayAvailable: true });
    await expect(getDesktopClientSettings()).resolves.toEqual({
      closeToTray: false,
      trayAvailable: true,
    });
    expect(callSpy).toHaveBeenLastCalledWith('DesktopBridge.GetClientSettings');

    callSpy.mockResolvedValueOnce({ closeToTray: true, trayAvailable: true });
    await expect(setDesktopCloseToTray(true)).resolves.toEqual({
      closeToTray: true,
      trayAvailable: true,
    });
    expect(callSpy).toHaveBeenLastCalledWith(
      'DesktopBridge.SetCloseToTray',
      true,
    );
  });

  it('ignores malformed desktop bootstrap payloads', () => {
    window.__LLMSTUDIO_DESKTOP__ = {
      apiBaseUrl: '   ',
      sessionToken: 'tok',
      platform: 'windows',
      dataMode: 'portable',
      version: '1.5.0',
    };
    expect(isDesktopApp()).toBe(false);
    expect(getDesktopBootstrap()).toBeNull();
    expect(themeHintKey('/')).toBe('llmstudio.themeHint.v1::/');
  });
});
