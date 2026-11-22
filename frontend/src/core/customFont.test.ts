import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_FONT_MAX_BYTES,
  hasTrueTypeSignature,
  importCustomFont,
  normalizeFontGatewayKey,
  readCachedCloudFont,
  readCustomFont,
  syncCloudCustomFont,
  validateCustomFontFile,
  writeCachedCloudFont,
} from './customFont';
import { GatewayClient, GatewayError } from './gateway';
import type { CustomFontMeta } from './types';

function sfntHeader(tag = 0x00010000, label = 'font'): ArrayBuffer {
  const text = new TextEncoder().encode(label);
  const buffer = new ArrayBuffer(4 + text.byteLength);
  new DataView(buffer).setUint32(0, tag, false);
  new Uint8Array(buffer, 4).set(text);
  return buffer;
}

function createFakeIndexedDB() {
  const store = new Map<string, unknown>();
  let failWrite = false;

  const fakeIDB = {
    open: () => {
      const openReq: Record<string, unknown> = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          close: () => {},
          transaction: (_name: string, _mode: string) => {
            const tx: Record<string, unknown> = {};
            const objectStore = {
              get: (key: string) => {
                const req: Record<string, unknown> = {};
                queueMicrotask(() => {
                  req.result = store.get(key);
                  if (typeof req.onsuccess === 'function') req.onsuccess();
                  if (typeof tx.oncomplete === 'function') tx.oncomplete();
                });
                return req;
              },
              put: (val: unknown, key: string) => {
                queueMicrotask(() => {
                  if (failWrite) {
                    failWrite = false;
                    tx.error = new Error('IndexedDB quota exceeded');
                    if (typeof tx.onerror === 'function') tx.onerror();
                    return;
                  }
                  store.set(key, val);
                  if (typeof tx.oncomplete === 'function') tx.oncomplete();
                });
              },
              delete: (key: string) => {
                queueMicrotask(() => {
                  store.delete(key);
                  if (typeof tx.oncomplete === 'function') tx.oncomplete();
                });
              },
            };
            return {
              ...tx,
              set oncomplete(fn: () => void) {
                tx.oncomplete = fn;
              },
              set onerror(fn: () => void) {
                tx.onerror = fn;
              },
              set onabort(fn: () => void) {
                tx.onabort = fn;
              },
              get error() {
                return tx.error;
              },
              objectStore: () => objectStore,
            };
          },
        };
        openReq.result = db;
        if (typeof openReq.onupgradeneeded === 'function') {
          openReq.onupgradeneeded();
        }
        if (typeof openReq.onsuccess === 'function') {
          openReq.onsuccess();
        }
      });
      return openReq;
    },
  };

  return {
    store,
    fakeIDB,
    failNextWrite() {
      failWrite = true;
    },
  };
}

class FakeFontFace {
  readonly family: string;
  readonly source: ArrayBuffer;
  constructor(family: string, source: ArrayBuffer) {
    this.family = family;
    this.source = source;
  }
  load() {
    return Promise.resolve(this);
  }
}

describe('custom font validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts an uppercase .ttf extension and rejects other containers', () => {
    expect(() => validateCustomFontFile('Font.TTF', 1024)).not.toThrow();
    expect(() => validateCustomFontFile('font.otf', 1024)).toThrow('仅支持 .ttf');
    expect(() => validateCustomFontFile('font.woff', 1024)).toThrow('仅支持 .ttf');
  });

  it('rejects empty and oversize files before reading them', () => {
    expect(() => validateCustomFontFile('empty.ttf', 0)).toThrow('字体文件为空');
    expect(() =>
      validateCustomFontFile('huge.ttf', CUSTOM_FONT_MAX_BYTES + 1),
    ).toThrow('不能超过 32 MiB');
  });

  it('accepts TrueType sfnt signatures and rejects collections and OpenType', () => {
    expect(hasTrueTypeSignature(sfntHeader(0x00010000))).toBe(true);
    expect(hasTrueTypeSignature(sfntHeader(0x74727565))).toBe(true);
    expect(hasTrueTypeSignature(sfntHeader(0x4f54544f))).toBe(false);
    expect(hasTrueTypeSignature(sfntHeader(0x74746366))).toBe(false);
    expect(hasTrueTypeSignature(new ArrayBuffer(2))).toBe(false);
  });

  it('reports a decoding failure without saving a replacement', async () => {
    class RejectingFontFace {
      constructor() {}
      load() {
        return Promise.reject(new Error('字体解码失败'));
      }
    }
    vi.stubGlobal('FontFace', RejectingFontFace);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn() },
    });
    const file = new File([sfntHeader()], 'broken.ttf');
    await expect(importCustomFont(file)).rejects.toThrow('字体解码失败');
  });
});

describe('cloud custom font sync, legacy preservation, and partitioned cache', () => {
  let idb: ReturnType<typeof createFakeIndexedDB>;

  beforeEach(() => {
    idb = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', idb.fakeIDB);
    vi.stubGlobal('FontFace', FakeFontFace);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves legacy custom record when cloud is empty without auto-uploading or auto-applying', async () => {
    const legacyFile = new File([sfntHeader(0x00010000, 'legacy')], 'Legacy.ttf');
    await importCustomFont(legacyFile);

    const gateway = {
      getCustomFontMeta: vi.fn(async () => null),
      downloadCustomFontFile: vi.fn(),
    };
    const gwKey = normalizeFontGatewayKey('https://gw-a.example/')!;
    const res = await syncCloudCustomFont({
      gateway,
      gatewayKey: gwKey,
      isCurrent: () => true,
    });

    expect(res).toEqual({ kind: 'empty', legacyFont: { name: 'Legacy.ttf' } });
    expect(gateway.downloadCustomFontFile).not.toHaveBeenCalled();
    expect(await readCustomFont()).not.toBeNull();
  });

  it('prefers cloud font over legacy record, skips /file on same-gateway hash hit, and isolates gateways A and B', async () => {
    await importCustomFont(new File([sfntHeader(0x00010000, 'legacy')], 'Legacy.ttf'));

    const metaA: CustomFontMeta = {
      name: 'CloudA.ttf',
      enabled: true,
      sha256: 'hash-a',
      sizeBytes: 12,
      updatedAt: '2026-11-22T00:00:00Z',
    };
    const metaB: CustomFontMeta = {
      name: 'CloudB.ttf',
      enabled: true,
      sha256: 'hash-b',
      sizeBytes: 12,
      updatedAt: '2026-11-22T00:00:01Z',
    };

    const gwA = {
      getCustomFontMeta: vi.fn(async () => metaA),
      downloadCustomFontFile: vi.fn(async () => ({
        notModified: false as const,
        buffer: sfntHeader(0x00010000, 'cloud-a'),
        etag: 'hash-a',
      })),
    };
    const keyA = normalizeFontGatewayKey('https://gw-a.example')!;
    const firstA = await syncCloudCustomFont({
      gateway: gwA,
      gatewayKey: keyA,
      isCurrent: () => true,
    });
    expect(firstA.kind).toBe('ready');
    if (firstA.kind === 'ready') {
      expect(firstA.font.name).toBe('CloudA.ttf');
      expect(firstA.face).not.toBeNull();
    }
    expect(gwA.downloadCustomFontFile).toHaveBeenCalledTimes(1);

    // Second sync on same gateway hits cache by hash and never downloads /file.
    const secondA = await syncCloudCustomFont({
      gateway: gwA,
      gatewayKey: keyA,
      isCurrent: () => true,
    });
    expect(secondA.kind).toBe('ready');
    expect(gwA.downloadCustomFontFile).toHaveBeenCalledTimes(1);

    // Switching to gateway B uses separate partition and downloads B without touching A or legacy.
    const gwB = {
      getCustomFontMeta: vi.fn(async () => metaB),
      downloadCustomFontFile: vi.fn(async () => ({
        notModified: false as const,
        buffer: sfntHeader(0x00010000, 'cloud-b'),
        etag: 'hash-b',
      })),
    };
    const keyB = normalizeFontGatewayKey('https://gw-b.example')!;
    const firstB = await syncCloudCustomFont({
      gateway: gwB,
      gatewayKey: keyB,
      isCurrent: () => true,
    });
    expect(firstB.kind).toBe('ready');
    if (firstB.kind === 'ready') {
      expect(firstB.font.name).toBe('CloudB.ttf');
    }
    expect((await readCachedCloudFont(keyA))?.sha256).toBe('hash-a');
    expect((await readCachedCloudFont(keyB))?.sha256).toBe('hash-b');
    expect((await readCustomFont())?.name).toBe('Legacy.ttf');
  });

  it('re-reads metadata when ETag mismatches during font replacement and ignores late responses', async () => {
    const metaOld: CustomFontMeta = {
      name: 'Old.ttf',
      enabled: true,
      sha256: 'hash-old',
      sizeBytes: 10,
      updatedAt: '2026-11-22T00:00:00Z',
    };
    const metaNew: CustomFontMeta = {
      name: 'New.ttf',
      enabled: true,
      sha256: 'hash-new',
      sizeBytes: 10,
      updatedAt: '2026-11-22T00:00:02Z',
    };

    const gateway = {
      getCustomFontMeta: vi
        .fn<() => Promise<CustomFontMeta | null>>()
        .mockResolvedValueOnce(metaOld)
        .mockResolvedValueOnce(metaNew),
      downloadCustomFontFile: vi
        .fn()
        .mockResolvedValueOnce({
          notModified: false as const,
          buffer: sfntHeader(0x00010000, 'new-bytes'),
          etag: 'hash-new',
        })
        .mockResolvedValueOnce({
          notModified: false as const,
          buffer: sfntHeader(0x00010000, 'new-bytes'),
          etag: 'hash-new',
        }),
    };
    const gwKey = normalizeFontGatewayKey('https://gw-replace.example')!;
    const res = await syncCloudCustomFont({
      gateway,
      gatewayKey: gwKey,
      isCurrent: () => true,
    });
    expect(res.kind).toBe('ready');
    if (res.kind === 'ready') {
      expect(res.font.sha256).toBe('hash-new');
      expect(res.font.name).toBe('New.ttf');
    }
    expect((await readCachedCloudFont(gwKey))?.sha256).toBe('hash-new');

    // Late response after gateway switch is dropped.
    let current = true;
    const lateGateway = {
      getCustomFontMeta: vi.fn(async () => {
        current = false;
        return metaNew;
      }),
      downloadCustomFontFile: vi.fn(),
    };
    const lateRes = await syncCloudCustomFont({
      gateway: lateGateway,
      gatewayKey: gwKey,
      isCurrent: () => current,
    });
    expect(lateRes.kind).toBe('stale');
  });

  it('still succeeds when local cache write fails, and limits offline fallback to same-gateway transient errors', async () => {
    const meta: CustomFontMeta = {
      name: 'Resilient.ttf',
      enabled: true,
      sha256: 'hash-resilient',
      sizeBytes: 12,
      updatedAt: '2026-11-22T00:00:00Z',
    };
    const gwKey = normalizeFontGatewayKey('https://gw-cache.example')!;
    idb.failNextWrite();

    const gateway = {
      getCustomFontMeta: vi.fn(async () => meta),
      downloadCustomFontFile: vi.fn(async () => ({
        notModified: false as const,
        buffer: sfntHeader(0x00010000, 'resilient'),
        etag: 'hash-resilient',
      })),
    };
    const synced = await syncCloudCustomFont({
      gateway,
      gatewayKey: gwKey,
      isCurrent: () => true,
    });
    expect(synced.kind).toBe('ready');
    if (synced.kind === 'ready') {
      expect(synced.face).not.toBeNull();
    }

    // Seed confirmed cache and verify transient offline uses it, while 401 and disconnected do NOT.
    await writeCachedCloudFont({
      gatewayKey: gwKey,
      ...meta,
      blob: new Blob([sfntHeader(0x00010000, 'resilient')], { type: 'font/ttf' }),
    });

    const offlineRes = await syncCloudCustomFont({
      gateway: {
        getCustomFontMeta: vi.fn(async () => {
          throw new GatewayError('NETWORK_ERROR', 'offline');
        }),
        downloadCustomFontFile: vi.fn(),
      },
      gatewayKey: gwKey,
      isCurrent: () => true,
    });
    expect(offlineRes.kind).toBe('offline-cached');

    const authFailRes = await syncCloudCustomFont({
      gateway: {
        getCustomFontMeta: vi.fn(async () => {
          throw new GatewayError('UNAUTHORIZED', 'bad token', 401);
        }),
        downloadCustomFontFile: vi.fn(),
      },
      gatewayKey: gwKey,
      isCurrent: () => true,
    });
    expect(authFailRes.kind).toBe('auth-error');

    const disconnRes = await syncCloudCustomFont({
      gateway: {
        getCustomFontMeta: vi.fn(async () => {
          throw new GatewayError('CLOUD_NOT_CONNECTED', 'disconnected', 503);
        }),
        downloadCustomFontFile: vi.fn(),
      },
      gatewayKey: gwKey,
      isCurrent: () => true,
    });
    expect(disconnRes.kind).toBe('disconnected');

    // Verify GatewayClient binary upload encodes X-Font-Name and strips ETag quotes on download.
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/settings/custom-font') && init?.method === 'PUT') {
        const headers = new Headers(init.headers);
        expect(headers.get('X-Font-Name')).toBe(encodeURIComponent('中文 Font.ttf'));
        return new Response(JSON.stringify({ font: meta }), { status: 200 });
      }
      if (url.endsWith('/api/v1/settings/custom-font/file')) {
        return new Response(sfntHeader(0x00010000, 'client2'), {
          status: 200,
          headers: { ETag: '"hash-resilient"' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    const client = new GatewayClient({
      baseUrl: 'https://gw-cache.example',
      accessToken: 'tok',
      fetchImpl: fetchMock,
    });
    const uploaded = await client.uploadCustomFont(
      '中文 Font.ttf',
      sfntHeader(0x00010000, 'client2'),
    );
    expect(uploaded.sha256).toBe('hash-resilient');
    const downloaded = await client.downloadCustomFontFile();
    expect(downloaded.notModified).toBe(false);
    expect(downloaded.etag).toBe('hash-resilient');
  });
});
