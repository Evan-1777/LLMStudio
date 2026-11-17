'use strict';

// Short-term retirement worker for legacy Flutter Web installations on the same origin/scope.
// Deletes only Flutter's named caches and unregisters itself without force-reloading active drafts.
const LEGACY_FLUTTER_CACHES = [
  'flutter-app-cache',
  'flutter-temp-cache',
  'flutter-app-manifest',
];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (typeof caches !== 'undefined') {
        await Promise.all(
          LEGACY_FLUTTER_CACHES.map((name) =>
            caches.delete(name).catch(() => false),
          ),
        );
      }
      try {
        await self.registration.unregister();
      } catch {
        // Ignore unregister failures on restricted origins.
      }
    })(),
  );
});
