const DB_NAME = 'llmstudio.custom-fonts';
const STORE_NAME = 'fonts';
const RECORD_KEY = 'custom';

export const CUSTOM_FONT_FAMILY = 'LLMStudioCustom';
export const CUSTOM_FONT_MAX_BYTES = 32 * 1024 * 1024;

export interface StoredCustomFont {
  name: string;
  blob: Blob;
  enabled: boolean;
}

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
    request.onerror = () => reject(request.error ?? new Error('无法打开本地字体存储'));
  });
}

function normalizeRecord(raw: unknown): StoredCustomFont | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  if (typeof record.enabled !== 'boolean') return null;
  if (!(record.blob instanceof Blob) || record.blob.size === 0) return null;
  return { name: record.name, blob: record.blob, enabled: record.enabled };
}

function readRecord(): Promise<StoredCustomFont | null> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        request.onsuccess = () => resolve(normalizeRecord(request.result));
        request.onerror = () => reject(request.error ?? new Error('读取本地字体失败'));
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('读取本地字体失败'));
        };
      }),
  );
}

function writeRecord(record: StoredCustomFont): Promise<void> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
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

/** Reads the single device-local font, or null when none is stored. */
export async function readCustomFont(): Promise<StoredCustomFont | null> {
  if (!supportsStorage()) return null;
  try {
    return await readRecord();
  } catch {
    return null;
  }
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

/** Replaces the stored font only after validation and decoding succeed. */
export async function importCustomFont(
  file: File,
): Promise<{ font: StoredCustomFont; face: FontFace }> {
  validateCustomFontFile(file.name, file.size);
  const name = file.name.trim();
  const buffer = await file.arrayBuffer();
  if (!hasTrueTypeSignature(buffer)) {
    throw new Error('文件不是有效的 TrueType 字体');
  }
  const face = await decodeCustomFontFace(buffer);

  const font: StoredCustomFont = {
    name,
    blob: new Blob([buffer], { type: 'font/ttf' }),
    enabled: true,
  };
  await writeRecord(font);
  return { font, face };
}

/** Decodes a stored font for the current document. */
export async function loadStoredCustomFontFace(
  font: StoredCustomFont,
): Promise<FontFace> {
  return decodeCustomFontFace(font.blob);
}

/** Toggles the stored font and keeps the record when the write fails. */
export async function setStoredCustomFontEnabled(
  enabled: boolean,
): Promise<StoredCustomFont> {
  const existing = await readRecord();
  if (!existing) {
    throw new Error('没有可用的自定义字体');
  }
  const next = { ...existing, enabled };
  await writeRecord(next);
  return next;
}

/** Removes the device-local font. A failed delete leaves the record intact. */
export async function deleteCustomFont(): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
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
  });
}

/** TrueType sfnt signatures; other containers are rejected before decoding. */
export function hasTrueTypeSignature(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const signature = new DataView(buffer).getUint32(0, false);
  return signature === 0x00010000 || signature === 0x74727565;
}

async function decodeCustomFontFace(source: ArrayBuffer | Blob): Promise<FontFace> {
  if (
    typeof FontFace === 'undefined' ||
    typeof document === 'undefined' ||
    !document.fonts
  ) {
    throw new Error('当前环境不支持字体解码');
  }
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
  await face.load();
  return face;
}
