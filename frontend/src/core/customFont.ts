import { GatewayError, type GatewayClient } from './gateway';
import type { CustomFontMeta } from './types';

const DB_NAME = 'llmstudio.custom-fonts';
const STORE_NAME = 'fonts';
const LEGACY_RECORD_KEY = 'custom';
const CLOUD_KEY_PREFIX = 'cloud::';

export const CUSTOM_FONT_FAMILY = 'LLMStudioCustom';
export const CUSTOM_FONT_MAX_BYTES = 32 * 1024 * 1024;

export interface StoredCustomFont {
  name: string;
  blob: Blob;
  enabled: boolean;
}

export interface CachedCloudFont extends CustomFontMeta {
  gatewayKey: string;
  blob: Blob;
}

export type CloudFontSyncResult =
  | { kind: 'stale' }
  | { kind: 'ready'; font: CustomFontMeta; face: FontFace | null }
  | { kind: 'empty'; legacyFont: { name: string } | null }
  | { kind: 'offline-cached'; font: CachedCloudFont; face: FontFace | null }
  | { kind: 'auth-error' }
  | { kind: 'disconnected' }
  | { kind: 'error'; error: unknown };

function supportsStorage(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!supportsStorage()) {
      reject(new Error('当前环境不支持本地字体存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('无法打开本地字体存储'));
  });
}

function readRawRecord(key: string): Promise<unknown> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error('读取本地字体失败'));
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('读取本地字体失败'));
        };
      }),
  );
}

function writeRawRecord(key: string, value: unknown): Promise<void> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('保存本地字体失败'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('保存本地字体失败'));
        };
      }),
  );
}

function deleteRawRecord(key: string): Promise<void> {
  return openDatabase().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('移除本地字体失败'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('移除本地字体失败'));
        };
      }),
  );
}

function normalizeLegacyRecord(raw: unknown): StoredCustomFont | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  if (typeof record.enabled !== 'boolean') return null;
  if (!(record.blob instanceof Blob) || record.blob.size === 0) return null;
  return { name: record.name, blob: record.blob, enabled: record.enabled };
}

function normalizeCloudCacheRecord(raw: unknown): CachedCloudFont | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.gatewayKey !== 'string' || !record.gatewayKey.trim()) return null;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  if (typeof record.enabled !== 'boolean') return null;
  if (typeof record.sha256 !== 'string' || !record.sha256.trim()) return null;
  if (typeof record.sizeBytes !== 'number' || !Number.isFinite(record.sizeBytes)) return null;
  if (typeof record.updatedAt !== 'string') return null;
  if (!(record.blob instanceof Blob) || record.blob.size === 0) return null;
  return {
    gatewayKey: record.gatewayKey,
    name: record.name,
    enabled: record.enabled,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    updatedAt: record.updatedAt,
    blob: record.blob,
  };
}

/**
 * Normalizes a real remote gateway URL into a stable IndexedDB cache partition key.
 * Desktop callers must pass the configured remote cloud URL, never the loopback facade.
 */
export function normalizeFontGatewayKey(rawGatewayBaseUrl: string): string | null {
  const trimmed = rawGatewayBaseUrl.trim();
  if (!trimmed) return null;
  if (trimmed === '/') {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/+$/, '');
    }
    return '/';
  }
  try {
    const base =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : undefined;
    const parsed = base ? new URL(trimmed, base) : new URL(trimmed);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return trimmed.replace(/\/+$/, '') || '/';
  }
}

function cloudCacheKey(gatewayKey: string): string {
  return `${CLOUD_KEY_PREFIX}${gatewayKey}`;
}

/** Reads the legacy device-local font record ('custom'), or null when none is stored. */
export async function readCustomFont(): Promise<StoredCustomFont | null> {
  if (!supportsStorage()) return null;
  try {
    return normalizeLegacyRecord(await readRawRecord(LEGACY_RECORD_KEY));
  } catch {
    return null;
  }
}

/** Reads the cached cloud font for a specific remote gateway partition. */
export async function readCachedCloudFont(
  gatewayKey: string,
): Promise<CachedCloudFont | null> {
  if (!supportsStorage() || !gatewayKey) return null;
  try {
    return normalizeCloudCacheRecord(await readRawRecord(cloudCacheKey(gatewayKey)));
  } catch {
    return null;
  }
}

/** Writes the cached cloud font for a specific remote gateway partition. */
export async function writeCachedCloudFont(record: CachedCloudFont): Promise<void> {
  await writeRawRecord(cloudCacheKey(record.gatewayKey), record);
}

/** Removes the cached cloud font for a specific remote gateway partition. */
export async function deleteCachedCloudFont(gatewayKey: string): Promise<void> {
  if (!supportsStorage() || !gatewayKey) return;
  await deleteRawRecord(cloudCacheKey(gatewayKey));
}

/** Validates name and size before any file contents are read. */
export function validateCustomFontFile(name: string, size: number): void {
  if (!name.trim().toLowerCase().endsWith('.ttf')) {
    throw new Error('仅支持 .ttf 字体文件');
  }
  if (size <= 0) {
    throw new Error('字体文件为空');
  }
  if (size > CUSTOM_FONT_MAX_BYTES) {
    throw new Error('字体文件不能超过 32 MiB');
  }
}

/** Validates extension, size, TrueType signature, and browser FontFace decoding. */
export async function validateAndDecodeCustomFontFile(
  file: File,
): Promise<{ name: string; buffer: ArrayBuffer; face: FontFace }> {
  validateCustomFontFile(file.name, file.size);
  const name = file.name.trim();
  const buffer = await file.arrayBuffer();
  if (!hasTrueTypeSignature(buffer)) {
    throw new Error('文件不是有效的 TrueType 字体');
  }
  const face = await decodeCustomFontFace(buffer);
  return { name, buffer, face };
}

/** Replaces the device-local font only after validation and decoding succeed. */
export async function importCustomFont(
  file: File,
): Promise<{ font: StoredCustomFont; face: FontFace }> {
  const { name, buffer, face } = await validateAndDecodeCustomFontFile(file);
  const font: StoredCustomFont = {
    name,
    blob: new Blob([buffer], { type: 'font/ttf' }),
    enabled: true,
  };
  await writeRawRecord(LEGACY_RECORD_KEY, font);
  return { font, face };
}

/** Decodes a stored font for the current document. */
export async function loadStoredCustomFontFace(
  font: Pick<StoredCustomFont, 'blob'>,
): Promise<FontFace> {
  const buffer = await font.blob.arrayBuffer();
  return decodeCustomFontBuffer(buffer);
}

/** Validates TrueType signature and decodes a raw font buffer. */
export async function decodeCustomFontBuffer(
  buffer: ArrayBuffer,
): Promise<FontFace> {
  if (!hasTrueTypeSignature(buffer)) {
    throw new Error('文件不是有效的 TrueType 字体');
  }
  return decodeCustomFontFace(buffer);
}

/** Toggles the device-local font and keeps the record when the write fails. */
export async function setStoredCustomFontEnabled(
  enabled: boolean,
): Promise<StoredCustomFont> {
  const existing = normalizeLegacyRecord(await readRawRecord(LEGACY_RECORD_KEY));
  if (!existing) {
    throw new Error('没有可用的自定义字体');
  }
  const next = { ...existing, enabled };
  await writeRawRecord(LEGACY_RECORD_KEY, next);
  return next;
}

/** Removes the device-local font. A failed delete leaves the record intact. */
export async function deleteCustomFont(): Promise<void> {
  await deleteRawRecord(LEGACY_RECORD_KEY);
}

/** TrueType sfnt signatures; other containers are rejected before decoding. */
export function hasTrueTypeSignature(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const signature = new DataView(buffer).getUint32(0, false);
  return signature === 0x00010000 || signature === 0x74727565;
}

async function decodeCustomFontFace(
  source: ArrayBuffer | Blob,
): Promise<FontFace> {
  if (
    typeof FontFace === 'undefined' ||
    typeof document === 'undefined' ||
    !document.fonts
  ) {
    throw new Error('当前环境不支持字体解码');
  }
  const buffer =
    source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
  await face.load();
  return face;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * Downloads the cloud font binary and verifies that the response ETag matches
 * the expected metadata SHA-256. If the font was replaced concurrently, re-reads
 * metadata once and retries so bytes are never cached under a mismatched hash.
 */
export async function downloadVerifiedCloudFont(
  gateway: Pick<GatewayClient, 'getCustomFontMeta' | 'downloadCustomFontFile'>,
  initialMeta: CustomFontMeta,
  signal?: AbortSignal,
): Promise<{ meta: CustomFontMeta; buffer: ArrayBuffer; face: FontFace } | null> {
  let meta = initialMeta;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fileRes = await gateway.downloadCustomFontFile({ signal });
    if (fileRes.notModified) {
      throw new Error('字体文件未返回有效内容');
    }
    if (fileRes.etag && fileRes.etag !== meta.sha256) {
      if (attempt === 0) {
        const refreshed = await gateway.getCustomFontMeta(signal);
        if (!refreshed) return null;
        meta = refreshed;
        continue;
      }
      throw new Error('云端字体版本不一致，请重试同步');
    }
    const face = await decodeCustomFontBuffer(fileRes.buffer);
    return { meta, buffer: fileRes.buffer, face };
  }
  throw new Error('云端字体版本不一致，请重试同步');
}

/**
 * Synchronizes cloud custom font metadata and binary bytes for a single remote gateway
 * partition while preserving legacy device-local records and isolating failures.
 */
export async function syncCloudCustomFont(opts: {
  gateway: Pick<GatewayClient, 'getCustomFontMeta' | 'downloadCustomFontFile'>;
  gatewayKey: string;
  signal?: AbortSignal;
  isCurrent: () => boolean;
}): Promise<CloudFontSyncResult> {
  const { gateway, gatewayKey, signal, isCurrent } = opts;
  try {
    const meta = await gateway.getCustomFontMeta(signal);
    if (!isCurrent() || signal?.aborted) return { kind: 'stale' };

    if (!meta) {
      await deleteCachedCloudFont(gatewayKey).catch(() => {});
      const legacy = await readCustomFont();
      if (!isCurrent() || signal?.aborted) return { kind: 'stale' };
      return {
        kind: 'empty',
        legacyFont: legacy ? { name: legacy.name } : null,
      };
    }

    const cached = await readCachedCloudFont(gatewayKey);
    if (!isCurrent() || signal?.aborted) return { kind: 'stale' };

    if (cached && cached.sha256 === meta.sha256) {
      await writeCachedCloudFont({
        ...cached,
        name: meta.name,
        enabled: meta.enabled,
        sizeBytes: meta.sizeBytes,
        updatedAt: meta.updatedAt,
      }).catch(() => {});

      if (!meta.enabled) {
        return { kind: 'ready', font: meta, face: null };
      }
      const face = await loadStoredCustomFontFace(cached);
      if (!isCurrent() || signal?.aborted) return { kind: 'stale' };
      return { kind: 'ready', font: meta, face };
    }

    if (!meta.enabled) {
      return { kind: 'ready', font: meta, face: null };
    }

    const downloaded = await downloadVerifiedCloudFont(gateway, meta, signal);
    if (!isCurrent() || signal?.aborted) return { kind: 'stale' };
    if (!downloaded) {
      await deleteCachedCloudFont(gatewayKey).catch(() => {});
      const legacy = await readCustomFont();
      if (!isCurrent() || signal?.aborted) return { kind: 'stale' };
      return {
        kind: 'empty',
        legacyFont: legacy ? { name: legacy.name } : null,
      };
    }

    await writeCachedCloudFont({
      gatewayKey,
      ...downloaded.meta,
      blob: new Blob([downloaded.buffer], { type: 'font/ttf' }),
    }).catch(() => {});

    return {
      kind: 'ready',
      font: downloaded.meta,
      face: downloaded.meta.enabled ? downloaded.face : null,
    };
  } catch (err) {
    if (isAbortError(err) || !isCurrent() || signal?.aborted) {
      return { kind: 'stale' };
    }
    if (err instanceof GatewayError) {
      if (err.statusCode === 401) {
        return { kind: 'auth-error' };
      }
      if (err.code === 'CLOUD_NOT_CONNECTED') {
        return { kind: 'disconnected' };
      }
    }
    // Temporary offline / network / 5xx error for the same bound gateway:
    // fall back to previously confirmed cache for this gateway partition only.
    const cached = await readCachedCloudFont(gatewayKey);
    if (!isCurrent() || signal?.aborted) return { kind: 'stale' };
    if (cached) {
      let face: FontFace | null = null;
      if (cached.enabled) {
        try {
          face = await loadStoredCustomFontFace(cached);
        } catch {
          face = null;
        }
      }
      if (!isCurrent() || signal?.aborted) return { kind: 'stale' };
      return { kind: 'offline-cached', font: cached, face };
    }
    return { kind: 'error', error: err };
  }
}
