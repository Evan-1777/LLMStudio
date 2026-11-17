import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_FLUTTER_CACHE_NAMES,
  retireLegacyFlutterServiceWorker,
} from './legacySwRetirement';

describe('retireLegacyFlutterServiceWorker', () => {
  it('unregisters only same-origin/scope Flutter SW and deletes only named Flutter caches', async () => {
    const expectedScope = new URL('./', window.location.href).href;
    const otherScope = new URL('/other/', window.location.href).href;

    const flutterUnregister = vi.fn().mockResolvedValue(true);
    const otherSwUnregister = vi.fn().mockResolvedValue(true);
    const otherScopeUnregister = vi.fn().mockResolvedValue(true);

    const originalSw = navigator.serviceWorker;
    const originalCaches = window.caches;
    const deletedCaches: string[] = [];

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistrations: vi.fn().mockResolvedValue([
          {
            scope: expectedScope,
            active: { scriptURL: `${window.location.origin}/flutter_service_worker.js?v=1` },
            unregister: flutterUnregister,
          },
          {
            scope: expectedScope,
            active: { scriptURL: `${window.location.origin}/custom-sw.js` },
            unregister: otherSwUnregister,
          },
          {
            scope: otherScope,
            active: { scriptURL: `${window.location.origin}/other/flutter_service_worker.js` },
            unregister: otherScopeUnregister,
          },
        ]),
      },
    });

    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: {
        delete: vi.fn(async (name: string) => {
          deletedCaches.push(name);
          return true;
        }),
      },
    });

    localStorage.setItem('unrelated.app.key', 'keep-me');

    try {
      const count = await retireLegacyFlutterServiceWorker();
      expect(count).toBe(1);
      expect(flutterUnregister).toHaveBeenCalledTimes(1);
      expect(otherSwUnregister).not.toHaveBeenCalled();
      expect(otherScopeUnregister).not.toHaveBeenCalled();
      expect(deletedCaches).toEqual([...LEGACY_FLUTTER_CACHE_NAMES]);
      expect(localStorage.getItem('unrelated.app.key')).toBe('keep-me');
    } finally {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: originalSw,
      });
      Object.defineProperty(window, 'caches', {
        configurable: true,
        value: originalCaches,
      });
      localStorage.removeItem('unrelated.app.key');
    }
  });
});
