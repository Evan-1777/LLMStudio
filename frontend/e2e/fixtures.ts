import {
  test as base,
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.resolve(FRONTEND_DIR, '..', 'backend');
const DIST_DIR = path.join(FRONTEND_DIR, 'dist');

export const E2E_TOKEN = 'e2e-test-token-2026';

export interface MockUpstreamModel {
  id: string;
  name: string;
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
}

const DEFAULT_UPSTREAM_MODELS: MockUpstreamModel[] = [
  {
    id: 'mock-chat',
    name: 'Mock Chat',
    context_window: 128000,
    max_tokens: 8192,
    reasoning: true,
  },
  {
    id: 'mock-vision',
    name: 'Mock Vision',
    context_window: 128000,
    max_tokens: 4096,
    reasoning: false,
  },
];

export interface MockUpstreamControl {
  url: string;
  models: MockUpstreamModel[];
  lastAuthHeaders: string[];
  lastChatBodies: Array<Record<string, unknown>>;
  abortedCount: number;
  reset: () => void;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to obtain free port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function extractLastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) =>
          p && typeof p === 'object' && 'text' in p
            ? String((p as { text?: unknown }).text ?? '')
            : '',
        )
        .join('\n');
    }
  }
  return '';
}

async function startMockUpstream(): Promise<{
  control: MockUpstreamControl;
  close: () => Promise<void>;
}> {
  const control: MockUpstreamControl = {
    url: '',
    models: DEFAULT_UPSTREAM_MODELS.map((m) => ({ ...m })),
    lastAuthHeaders: [],
    lastChatBodies: [],
    abortedCount: 0,
    reset() {
      this.models = DEFAULT_UPSTREAM_MODELS.map((m) => ({ ...m }));
      this.lastAuthHeaders = [];
      this.lastChatBodies = [];
      this.abortedCount = 0;
    },
  };

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, x-api-key, anthropic-version',
  };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(corsHeaders)) {
      res.setHeader(k, v);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (parsedUrl.pathname === '/v1/models' && req.method === 'GET') {
      const auth = req.headers.authorization || '';
      if (auth) control.lastAuthHeaders.push(auth);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: control.models,
        }),
      );
      return;
    }

    if (parsedUrl.pathname === '/search' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              title: `Search Result for ${q}`,
              url: 'https://example.org/e2e-doc',
              content: 'Mock SearXNG snippet for E2E verification.',
            },
          ],
        }),
      );
      return;
    }

    if (parsedUrl.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const auth = req.headers.authorization || '';
      if (auth) control.lastAuthHeaders.push(auth);
      const body = await readJsonBody(req);
      control.lastChatBodies.push(body);
      const prompt = extractLastUserText(body);

      if (prompt.includes('[PREPARE_FAIL]')) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'upstream prepare rejected' },
          }),
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const writeChunk = (obj: unknown) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      if (prompt.includes('[SLOW_ABORT]')) {
        let closed = false;
        const onAbort = () => {
          if (!closed) {
            closed = true;
            control.abortedCount += 1;
          }
        };
        req.on('close', onAbort);
        res.on('close', onAbort);

        writeChunk({
          choices: [{ delta: { reasoning_content: 'thinking slowly...' } }],
        });
        writeChunk({
          choices: [{ delta: { content: 'Partial streamed answer ' } }],
        });

        const timer = setInterval(() => {
          if (closed || res.writableEnded) {
            clearInterval(timer);
            return;
          }
          writeChunk({ choices: [{ delta: { content: '.' } }] });
        }, 120);
        return;
      }

      if (prompt.includes('[MID_EOF]')) {
        res.flushHeaders();
        writeChunk({
          choices: [{ delta: { content: 'Truncated chunk before EOF' } }],
        });
        setTimeout(() => res.destroy(), 40);
        return;
      }

      if (prompt.includes('[LONG_THINKING]')) {
        const longLines = Array.from(
          { length: 40 },
          (_, i) => `Thinking step line ${i + 1}: analyzing details and constraints.`,
        );
        for (const line of longLines) {
          writeChunk({ choices: [{ delta: { reasoning_content: `${line}\n` } }] });
        }
        writeChunk({ choices: [{ delta: { content: 'Done thinking.' } }] });
        writeChunk({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (prompt.includes('[RAW_HTML_VISUAL]')) {
        const rawHtmlReply =
          '前置说明\n\n<div id="raw-visual-card" style="padding:8px;border:1px solid #007aff;">Raw Seamless Visual Content</div>\n\n后置说明';
        writeChunk({ choices: [{ delta: { content: rawHtmlReply } }] });
        writeChunk({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (prompt.includes('[HTML_SANDBOX]')) {
        const htmlReply = [
          '### Markdown Title',
          '',
          '| Key | Value |',
          '| --- | --- |',
          '| Mode | Safe |',
          '',
          '```ts',
          'export const safe = true;',
          '```',
          '',
          '```html',
          '<div id="sandbox-card">Sandboxed Preview Content</div>',
          '<script>',
          'try { parent.document.body.dataset.pwned = "1"; } catch (e) {}',
          'try { localStorage.setItem("pwned", "1"); } catch (e) {}',
          '</script>',
          '```',
        ].join('\n');
        writeChunk({ choices: [{ delta: { content: htmlReply } }] });
        writeChunk({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const callSeq = control.lastChatBodies.length;
      writeChunk({
        choices: [{ delta: { reasoning_content: `Reasoning #${callSeq}` } }],
      });
      writeChunk({
        choices: [
          {
            delta: {
              content: `Reply #${callSeq} to: ${prompt.slice(0, 60)}`,
            },
          },
        ],
      });
      writeChunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock upstream');
  }
  control.url = `http://127.0.0.1:${addr.port}`;

  return {
    control,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function resolveBrowser(): Promise<{
  browser: Browser;
  isCdp: boolean;
}> {
  const cdpUrl =
    process.env.CDP_ENDPOINT ||
    (!process.env.CI ? 'http://127.0.0.1:9222' : '');

  if (cdpUrl) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 800);
      const res = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const browser = await chromium.connectOverCDP(cdpUrl);
        return { browser, isCdp: true };
      }
    } catch {
      if (process.env.CDP_ENDPOINT) {
        throw new Error(`CDP_ENDPOINT ${cdpUrl} is not reachable`);
      }
    }
  }

  const browser = await chromium.launch({ headless: true });
  return { browser, isCdp: false };
}

interface WorkerShared {
  binDir: string;
  binPath: string;
  upstream: MockUpstreamControl;
  browser: Browser;
}

interface GoInstance {
  baseUrl: string;
  dbPath: string;
}

export const test = base.extend<
  {
    browser: Browser;
    goInstance: GoInstance;
    appUrl: string;
    dbPath: string;
    upstream: MockUpstreamControl;
    context: BrowserContext;
    page: Page;
  },
  { workerShared: WorkerShared }
>({
  workerShared: [
    async ({}, use) => {
      if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        execFileSync('npm', ['run', 'build'], {
          cwd: FRONTEND_DIR,
          stdio: 'inherit',
        });
      }

      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmstudio-e2e-bin-'));
      const binPath = path.join(binDir, 'llmstudio-server');
      execFileSync('go', ['build', '-o', binPath, './cmd/server'], {
        cwd: BACKEND_DIR,
        stdio: 'inherit',
      });

      const upstreamHandle = await startMockUpstream();
      let browserHandle: { browser: Browser; isCdp: boolean } | null = null;

      try {
        browserHandle = await resolveBrowser();
        await use({
          binDir,
          binPath,
          upstream: upstreamHandle.control,
          browser: browserHandle.browser,
        });
      } finally {
        if (browserHandle) {
          await browserHandle.browser.close().catch(() => {});
        }
        await upstreamHandle.close().catch(() => {});
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],

  goInstance: async ({ workerShared }, use) => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmstudio-e2e-db-'));
    const dbPath = path.join(dbDir, 'e2e.db');
    const goPort = await getFreePort();
    const baseUrl = `http://127.0.0.1:${goPort}`;

    const proc: ChildProcess = spawn(workerShared.binPath, [], {
      env: {
        ...process.env,
        LLMSTUDIO_PORT: String(goPort),
        LLMSTUDIO_DB_PATH: dbPath,
        LLMSTUDIO_STATIC_DIR: DIST_DIR,
        LLMSTUDIO_ACCESS_TOKEN: E2E_TOKEN,
        LLMSTUDIO_DEV_MODE: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      let healthy = false;
      for (let i = 0; i < 60; i++) {
        try {
          const resp = await fetch(`${baseUrl}/healthz`);
          if (resp.ok) {
            healthy = true;
            break;
          }
        } catch {
          // Wait for startup.
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!healthy) {
        throw new Error(`Go server failed to start on ${baseUrl}`);
      }

      await use({ baseUrl, dbPath });
    } finally {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
          }, 2000);
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  },

  appUrl: async ({ goInstance }, use) => {
    await use(goInstance.baseUrl);
  },

  dbPath: async ({ goInstance }, use) => {
    await use(goInstance.dbPath);
  },

  upstream: async ({ workerShared }, use) => {
    workerShared.upstream.reset();
    await use(workerShared.upstream);
  },

  browser: async ({ workerShared }, use) => {
    await use(workerShared.browser);
  },

  context: async ({ workerShared }, use) => {
    const context = await workerShared.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      await use(context);
    } finally {
      await context.close().catch(() => {});
    }
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },
});

export { expect } from '@playwright/test';

export async function connectWithToken(page: Page, appUrl: string): Promise<void> {
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.getByLabel('访问令牌').fill(E2E_TOKEN);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByLabel('消息输入框').waitFor();
}

export async function seedMockProviderViaApi(
  appUrl: string,
  upstreamUrl: string,
  models?: Array<Record<string, unknown>>,
): Promise<string> {
  const providerId = 'e2e-mock-provider';
  const res = await fetch(`${appUrl}/api/v1/providers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${E2E_TOKEN}`,
    },
    body: JSON.stringify({
      id: providerId,
      name: 'E2E Mock Provider',
      adapter: 'generic-http',
      baseURL: upstreamUrl,
      authType: 'bearer',
      apiKey: 'sk-e2e-upstream-secret',
      enabled: true,
      models: models ?? [
        {
          id: 'mock-chat',
          name: 'Mock Chat',
          apiFormat: 'openai-completions',
          reasoning: true,
          inputModalities: ['text'],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to seed mock provider: ${res.status}`);
  }
  const json = (await res.json()) as { provider: { id: string } };
  return json.provider.id;
}
