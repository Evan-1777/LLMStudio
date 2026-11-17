export const LOCAL_PROVIDER_KEYS_STORAGE_KEY = 'llmstudio.localProviderKeys.v1';

function getSafeStorage(explicit?: Storage | null): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readKeyMap(storage: Storage | null): Record<string, string> {
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

function writeKeyMap(
  storage: Storage | null,
  map: Record<string, string>,
): boolean {
  if (!storage) return false;
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY);
    } else {
      storage.setItem(LOCAL_PROVIDER_KEYS_STORAGE_KEY, JSON.stringify(map));
    }
    return true;
  } catch {
    return false;
  }
}

export function getLocalProviderKey(
  providerId: string,
  explicitStorage?: Storage | null,
): string {
  if (!providerId) return '';
  const map = readKeyMap(getSafeStorage(explicitStorage));
  return map[providerId] ?? '';
}

export function hasLocalProviderKey(
  providerId: string,
  explicitStorage?: Storage | null,
): boolean {
  return getLocalProviderKey(providerId, explicitStorage) !== '';
}

export function setLocalProviderKey(
  providerId: string,
  apiKey: string,
  explicitStorage?: Storage | null,
): boolean {
  if (!providerId) return false;
  const storage = getSafeStorage(explicitStorage);
  const map = readKeyMap(storage);
  const trimmed = apiKey.trim();
  if (!trimmed) {
    delete map[providerId];
  } else {
    map[providerId] = trimmed;
  }
  return writeKeyMap(storage, map);
}

export function removeLocalProviderKey(
  providerId: string,
  explicitStorage?: Storage | null,
): boolean {
  if (!providerId) return false;
  const storage = getSafeStorage(explicitStorage);
  const map = readKeyMap(storage);
  if (!(providerId in map)) return true;
  delete map[providerId];
  return writeKeyMap(storage, map);
}
