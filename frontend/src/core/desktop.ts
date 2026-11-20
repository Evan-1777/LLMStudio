export interface DesktopBootstrap {
  readonly apiBaseUrl: string;
  readonly sessionToken: string;
  readonly platform: string;
  readonly dataMode: 'portable' | 'installed' | string;
  readonly version: string;
}

export interface MyGoRuntimeBridge {
  call?: <T = unknown>(method: string, ...args: unknown[]) => Promise<T>;
}

declare global {
  interface Window {
    __LLMSTUDIO_DESKTOP__?: DesktopBootstrap;
    mygo?: MyGoRuntimeBridge;
  }
}

export function getDesktopBootstrap(): DesktopBootstrap | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = window.__LLMSTUDIO_DESKTOP__;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.apiBaseUrl !== 'string' || !raw.apiBaseUrl.trim()) {
    return null;
  }
  if (typeof raw.sessionToken !== 'string' || !raw.sessionToken.trim()) {
    return null;
  }
  return raw;
}

export function isDesktopApp(): boolean {
  return getDesktopBootstrap() !== null;
}

export async function openDesktopDataDir(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.mygo?.call !== 'function') {
    throw new Error('原生桌面桥接不可用');
  }
  await window.mygo.call('DesktopBridge.OpenDataDir');
}
