export const LEGACY_FLUTTER_CACHE_NAMES = [
  'flutter-app-cache',
  'flutter-temp-cache',
  'flutter-app-manifest',
] as const;

export async function retireLegacyFlutterServiceWorker(): Promise<number> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 0;
  }
  const swContainer = navigator.serviceWorker;
  if (!swContainer || typeof swContainer.getRegistrations !== 'function') {
    return 0;
  }

  let unregisteredCount = 0;
  try {
    const expectedScope = new URL('./', window.location.href).href;
    const registrations = await swContainer.getRegistrations();

    for (const reg of registrations) {
      if (reg.scope !== expectedScope) continue;
      const scriptUrls = [
        reg.active?.scriptURL,
        reg.waiting?.scriptURL,
        reg.installing?.scriptURL,
      ];
      const isLegacyFlutterSw = scriptUrls.some((rawUrl) => {
        if (!rawUrl) return false;
        try {
          const parsed = new URL(rawUrl);
          return (
            parsed.origin === window.location.origin &&
            parsed.pathname.endsWith('/flutter_service_worker.js')
          );
        } catch {
          return false;
        }
      });
      if (!isLegacyFlutterSw) continue;

      const removed = await reg.unregister().catch(() => false);
      if (removed) {
        unregisteredCount += 1;
      }
    }

    if (unregisteredCount > 0 && 'caches' in window && window.caches) {
      await Promise.all(
        LEGACY_FLUTTER_CACHE_NAMES.map((name) =>
          window.caches.delete(name).catch(() => false),
        ),
      );
    }
  } catch {
    // Ignore restricted Service Worker environments (e.g. opaque origin or disabled storage).
  }

  return unregisteredCount;
}
