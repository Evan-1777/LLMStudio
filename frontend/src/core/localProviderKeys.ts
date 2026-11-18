import type { GatewayClient } from './gateway';

// Pre-migration browser key store. Only read once to adopt legacy values into the
// gateway; all new reads and writes go through the provider API.
export const LOCAL_PROVIDER_KEYS_STORAGE_KEY = 'llmstudio.localProviderKeys.v1';

function safeStorage(explicit?: Storage | null): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Reads the raw legacy browser key map. */
export function readLegacyProviderKeys(
  explicitStorage?: Storage | null,
): Record<string, string> {
  const storage = safeStorage(explicitStorage);
  if (!storage) return {};
  try {
    const raw = storage.getItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') {
        out[k] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeLegacyProviderKeys(
  keys: Record<string, string>,
  storage: Storage | null,
): void {
  if (!storage) return;
  try {
    if (Object.keys(keys).length === 0) {
      storage.removeItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY);
    } else {
      storage.setItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY, JSON.stringify(keys));
    }
  } catch {
    // Cleanup is best-effort; the browser copy no longer drives behaviour.
  }
}

/**
 * Adopts every legacy browser key through the gateway's conditional import.
 * Entries the gateway already owns, or that no longer match a local-request
 * provider, are dropped; transport failures keep the entry for a later retry.
 */
export async function importLegacyProviderKeys(
  gateway: GatewayClient,
  providerIds: readonly string[],
  explicitStorage?: Storage | null,
): Promise<void> {
  const storage = safeStorage(explicitStorage);
  const keys = readLegacyProviderKeys(storage);
  const candidates = providerIds.filter((id) => (keys[id] ?? '') !== '');
  if (candidates.length === 0) return;

  let changed = false;
  await Promise.all(
    candidates.map(async (id) => {
      try {
        await gateway.importProviderAPIKey(id, keys[id]);
        delete keys[id];
        changed = true;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 409) {
          // Gone, not in local request mode, or already gateway-owned: the browser
          // copy can never be adopted again, so stop retrying it.
          delete keys[id];
          changed = true;
        }
      }
    }),
  );
  if (changed) {
    writeLegacyProviderKeys(keys, storage);
  }
}
