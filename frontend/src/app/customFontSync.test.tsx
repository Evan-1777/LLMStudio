import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './AppProvider';
import { importCustomFont } from '../core/customFont';

function sfntBytes(label: string): ArrayBuffer {
  const payload = new TextEncoder().encode(label);
  const buf = new ArrayBuffer(4 + payload.byteLength);
  new DataView(buf).setUint32(0, 0x00010000, false);
  new Uint8Array(buf, 4).set(payload);
  return buf;
}

function createMemoryIDB() {
  const map = new Map<string, unknown>();
  return {
    map,
    idb: {
      open: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => {
          const db = {
            objectStoreNames: { contains: () => true },
            createObjectStore: () => ({}),
            close: () => {},
            transaction: () => {
              const tx: Record<string, unknown> = {};
              const store = {
                get: (key: string) => {
                  const getReq: Record<string, unknown> = {};
                  queueMicrotask(() => {
                    getReq.result = map.get(key);
                    if (typeof getReq.onsuccess === 'function') getReq.onsuccess();
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                  });
                  return getReq;
                },
                put: (val: unknown, key: string) => {
                  queueMicrotask(() => {
                    map.set(key, val);
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                  });
                },
                delete: (key: string) => {
                  queueMicrotask(() => {
                    map.delete(key);
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                  });
                },
              };
              return {
                set oncomplete(fn: () => void) {
                  tx.oncomplete = fn;
                },
                set onerror(fn: () => void) {
                  tx.onerror = fn;
                },
                set onabort(fn: () => void) {
                  tx.onabort = fn;
                },
                objectStore: () => store,
              };
            },
          };
          req.result = db;
          if (typeof req.onsuccess === 'function') req.onsuccess();
        });
        return req;
      },
    },
  };
}

class MockFontFace {
  readonly family: string;
  constructor(family: string, _source: ArrayBuffer) {
    this.family = family;
  }
  load() {
    return Promise.resolve(this);
  }
}

interface CloudFontServerState {
  meta: {
    name: string;
    enabled: boolean;
    sha256: string;
    sizeBytes: number;
    updatedAt: string;
  } | null;
  bytes: ArrayBuffer | null;
}

function makeCloudFetch(server: CloudFontServerState) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ status: 'ok', version: '1.5.0', authRequired: false }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/settings')) {
      return new Response(
        JSON.stringify({ preferences: {}, initialized: true }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/formats')) {
      return new Response(JSON.stringify({ formats: [], adapters: [] }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/providers')) {
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/assistants')) {
      return new Response(JSON.stringify({ assistants: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/conversations')) {
      return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/conversation-groups')) {
      return new Response(JSON.stringify({ groups: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/plugins/search')) {
      return new Response(JSON.stringify({ engines: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/mcp/servers')) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    }

    if (url.endsWith('/api/v1/settings/custom-font')) {
      if (method === 'GET') {
        return new Response(JSON.stringify({ font: server.meta }), {
          status: 200,
        });
      }
      if (method === 'PUT') {
        const headers = new Headers(init?.headers);
        const name = decodeURIComponent(headers.get('X-Font-Name') ?? 'Font.ttf');
        const bodyBuf =
          init?.body instanceof ArrayBuffer
            ? init.body
            : await new Response(init?.body).arrayBuffer();
        server.bytes = bodyBuf;
        server.meta = {
          name,
          enabled: true,
          sha256: `sha-${name}-${bodyBuf.byteLength}`,
          sizeBytes: bodyBuf.byteLength,
          updatedAt: '2026-11-22T03:00:00Z',
        };
        return new Response(JSON.stringify({ font: server.meta }), {
          status: 200,
        });
      }
      if (method === 'DELETE') {
        server.meta = null;
        server.bytes = null;
        return new Response(null, { status: 204 });
      }
    }

    if (url.endsWith('/api/v1/settings/custom-font/file')) {
      if (!server.meta || !server.bytes) {
        return new Response(
          JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }),
          { status: 404 },
        );
      }
      return new Response(server.bytes, {
        status: 200,
        headers: {
          'Content-Type': 'font/ttf',
          ETag: `"${server.meta.sha256}"`,
          'Cache-Control': 'private, no-cache',
        },
      });
    }

    return new Response('{}', { status: 200 });
  });
}

describe('cloud custom font multi-client sync & legacy delete semantics', () => {
  let memIDB: ReturnType<typeof createMemoryIDB>;

  beforeEach(() => {
    localStorage.clear();
    memIDB = createMemoryIDB();
    vi.stubGlobal('indexedDB', memIDB.idb);
    vi.stubGlobal('FontFace', MockFontFace);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('syncs updated cloud font to an independent second client on manual sync or reopen, and does not revive legacy font after delete', async () => {
    // Seed a legacy device-local font record first.
    await importCustomFont(new File([sfntBytes('legacy-v1')], 'OldLocal.ttf'));

    const server: CloudFontServerState = { meta: null, bytes: null };
    const fetch1 = makeCloudFetch(server);
    const fetch2 = makeCloudFetch(server);

    let client1Ctx!: ReturnType<typeof useApp>;
    let client2Ctx!: ReturnType<typeof useApp>;

    function Probe({
      label,
      onCtx,
    }: {
      label: string;
      onCtx: (ctx: ReturnType<typeof useApp>) => void;
    }) {
      const ctx = useApp();
      onCtx(ctx);
      return (
        <div data-testid={label}>
          {ctx.customFont ? ctx.customFont.name : 'NONE'}|
          {ctx.legacyCustomFont ? ctx.legacyCustomFont.name : 'NO_LEGACY'}
        </div>
      );
    }

    const view1 = render(
      <AppProvider fetchImpl={fetch1}>
        <Probe label="c1" onCtx={(c) => (client1Ctx = c)} />
      </AppProvider>,
    );
    const view2 = render(
      <AppProvider fetchImpl={fetch2}>
        <Probe label="c2" onCtx={(c) => (client2Ctx = c)} />
      </AppProvider>,
    );

    // Initially cloud is empty: neither client auto-applies OldLocal.ttf, but explicit legacy import is offered.
    await waitFor(() => {
      expect(screen.getByTestId('c1')).toHaveTextContent('NONE|OldLocal.ttf');
      expect(screen.getByTestId('c2')).toHaveTextContent('NONE|OldLocal.ttf');
    });

    // Client 1 uploads a cloud font.
    await act(async () => {
      const res = await client1Ctx.uploadCustomFont(
        new File([sfntBytes('cloud-v1')], 'SharedCloud.ttf'),
      );
      expect(res.ok).toBe(true);
    });
    expect(screen.getByTestId('c1')).toHaveTextContent('SharedCloud.ttf|NO_LEGACY');
    // Client 2 is not pushed automatically until manual sync.
    expect(screen.getByTestId('c2')).toHaveTextContent('NONE|OldLocal.ttf');

    // Client 2 runs manual sync -> picks up SharedCloud.ttf.
    await act(async () => {
      const res = await client2Ctx.syncFromServer();
      expect(res.ok).toBe(true);
    });
    expect(screen.getByTestId('c2')).toHaveTextContent('SharedCloud.ttf|NO_LEGACY');

    // Client 1 deletes cloud font -> unloads and does NOT revive OldLocal.ttf automatically.
    await act(async () => {
      const res = await client1Ctx.removeCustomFont();
      expect(res.ok).toBe(true);
    });
    expect(screen.getByTestId('c1')).toHaveTextContent('NONE|OldLocal.ttf');
    expect(
      document.documentElement.style.getPropertyValue('--font-custom'),
    ).toBe('');

    view1.unmount();
    view2.unmount();
  });
});
