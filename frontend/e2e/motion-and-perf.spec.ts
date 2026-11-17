import http from 'node:http';
import {
  E2E_TOKEN,
  connectWithToken,
  expect,
  seedMockProviderViaApi,
  test,
} from './fixtures';

async function apiJson<T>(
  appUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${appUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${E2E_TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function startHighFreqStreamServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  let reqCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === '/v1/chat/completions') {
      reqCount += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.includes('[200_CHUNK_BENCH]')) {
        // 100 rapid thinking chunks (long enough to overflow thinking container) + 100 rapid markdown text chunks.
        for (let i = 1; i <= 100; i += 1) {
          if (res.writableEnded) break;
          const payload = {
            id: `bench-${reqCount}`,
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: `Step ${i}: analyzing prompt cache & layout invariants across streaming frames.\n`,
                },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          await new Promise((r) => setTimeout(r, 4));
        }
        for (let i = 1; i <= 100; i += 1) {
          if (res.writableEnded) break;
          const token =
            i === 1
              ? '### Streamed Report\n\n- item '
              : i % 10 === 0
                ? `${i}\n- item `
                : `word${i} `;
          const payload = {
            id: `bench-${reqCount}`,
            choices: [
              {
                index: 0,
                delta: { content: token },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          await new Promise((r) => setTimeout(r, 4));
        }
        res.write(
          `data: ${JSON.stringify({
            id: `bench-${reqCount}`,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          id: `seed-${reqCount}`,
          choices: [{ index: 0, delta: { content: `Seeded turn ${reqCount}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe('Motion transitions, reduced-motion, 5s slow network feedback, and streaming perf', () => {
  test('verifies overlay transitions, focus restore, light/dark + reduced-motion, and 5s slow-network immediate feedback', async ({
    appUrl,
    upstream,
    page,
  }) => {
    await seedMockProviderViaApi(appUrl, upstream.url);
    await apiJson(appUrl, 'PUT', '/api/v1/providers/e2e-mock-provider', {
      name: 'E2E Mock Provider',
      adapter: 'generic-http',
      baseURL: upstream.url,
      authType: 'bearer',
      enabled: true,
      models: [
        {
          id: 'mock-chat',
          name: 'Mock Chat',
          apiFormat: 'openai-completions',
          reasoning: true,
          inputModalities: ['text'],
        },
        {
          id: 'mock-fast',
          name: 'Mock Fast',
          apiFormat: 'openai-completions',
          reasoning: false,
          inputModalities: ['text'],
        },
      ],
    });

    await connectWithToken(page, appUrl);
    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option', { name: /Mock Chat/ }).click();

    // Send a long thinking + text message so chat scroll area overflows cleanly.
    await page.getByLabel('消息输入框').fill('[LONG_THINKING]');
    await page.getByLabel('发送消息').click();
    await expect(page.getByText('Done thinking.')).toBeVisible();

    // 1. Dark theme + overlay exit/focus restore (Modal & Popover)
    await page.getByRole('link', { name: '设置' }).click();
    await page.getByRole('button', { name: '外观与显示' }).click();
    await page.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Reduced-motion check: spinner & overlays must disable animations & displacements.
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.getByRole('button', { name: '返回工作台' }).click();

    const modelBtn = page.getByRole('button', { name: '选择模型' });
    await modelBtn.click();
    const popoverContent = page.locator('.ui-popover-content');
    await expect(popoverContent).toBeVisible();
    const popoverAnim = await popoverContent.evaluate((el) => ({
      animationName: getComputedStyle(el).animationName,
      transitionDuration: getComputedStyle(el).transitionDuration,
    }));
    expect(popoverAnim.animationName).toBe('none');
    await page.keyboard.press('Escape');
    await expect(popoverContent).toBeHidden();
    await expect(modelBtn).toBeFocused();

    // New Group modal focus restore + mobile drawer reduced-motion check
    const addGroupBtn = page.getByRole('button', { name: '新建分组' });
    await addGroupBtn.click();
    const groupDialog = page.getByRole('dialog');
    await expect(groupDialog).toBeVisible();
    const dialogAnim = await groupDialog.evaluate((el) => getComputedStyle(el).animationName);
    expect(dialogAnim).toBe('none');
    await page.keyboard.press('Escape');
    await expect(groupDialog).toBeHidden();
    await expect(addGroupBtn).toBeFocused();

    await page.setViewportSize({ width: 375, height: 812 });
    const railDur = await page
      .locator('.wb-rail')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(railDur).toBe('0s');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });

    // 2. 5-second delayed network on model switch PATCH:
    // Measure click-to-busy paint (target <= 100ms), verify no GET detail reload,
    // verify messages and non-bottom scrollTop are preserved and canvas is NOT blocked.
    await page.evaluate(() => {
      const el = document.querySelector('.wb-chat-scroll') as HTMLDivElement | null;
      if (el) el.scrollTop = 10;
    });

    let detailGetCount = 0;
    let delayedPatchSeen = false;
    await page.route('**/api/v1/conversations/*', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        detailGetCount += 1;
        await route.continue();
        return;
      }
      if (req.method() === 'PATCH' && !delayedPatchSeen) {
        delayedPatchSeen = true;
        await new Promise((r) => setTimeout(r, 5000));
        await route.continue();
        return;
      }
      await route.continue();
    });

    await modelBtn.click();
    const option = page.getByRole('option', { name: /Mock Fast/ });
    await option.waitFor();

    const clickToBusyPaintMs = await page.evaluate(async () => {
      const btn = document.querySelector('[aria-label="选择模型"]') as HTMLButtonElement;
      const opt = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
        el.textContent?.includes('Mock Fast'),
      ) as HTMLButtonElement;
      const t0 = performance.now();
      opt.click();
      return await new Promise<number>((resolve) => {
        const tick = () => {
          if (btn.getAttribute('aria-busy') === 'true' && btn.querySelector('.ui-spinner')) {
            resolve(performance.now() - t0);
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      });
    });

    console.log(`[TASK-022/023] 5s-delayed model switch click->busy paint: ${clickToBusyPaintMs.toFixed(2)}ms`);
    expect(clickToBusyPaintMs).toBeLessThanOrEqual(100);

    // While 5s PATCH is pending: messages remain, canvas composer still editable (no global scrim).
    await expect(page.getByText('Done thinking.')).toBeVisible();
    await page.getByLabel('消息输入框').fill('responsive while saving model');
    expect(await page.getByLabel('消息输入框').inputValue()).toBe(
      'responsive while saving model',
    );
    await page.getByLabel('消息输入框').fill('');

    await expect(modelBtn).not.toHaveAttribute('aria-busy', 'true', { timeout: 8000 });
    expect(delayedPatchSeen).toBe(true);
    expect(detailGetCount).toBe(0);
    await expect(modelBtn).toContainText('Mock Fast');

    // 3. Slow Move-to-Group Modal: Esc blocked while busy -> fails 500 -> stays open, Esc unlocked -> retry succeeds.
    await addGroupBtn.click();
    await page.getByLabel('分组名称').fill('Work');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('Work')).toBeVisible();

    let batchAttempts = 0;
    let releaseBatch!: () => void;
    const batchPaused = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    await page.route('**/api/v1/conversations/batch', async (route) => {
      batchAttempts += 1;
      if (batchAttempts === 1) {
        await batchPaused;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL', message: 'simulated move failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('.wb-topic-row').getByRole('button', { name: /^更多操作 / }).first().click();
    await page.getByRole('menuitem', { name: '移至分组' }).click();
    const moveDialog = page.getByRole('dialog');
    await moveDialog.getByLabel('Work').check();
    const submitMoveBtn = moveDialog.locator('button[type="submit"]');
    await submitMoveBtn.click();

    await expect(submitMoveBtn).toBeDisabled();
    await expect(submitMoveBtn).toHaveAttribute('aria-busy', 'true');
    await expect(submitMoveBtn).toContainText('移动中');
    await page.keyboard.press('Escape');
    await expect(moveDialog).toBeVisible();

    releaseBatch();
    // After simulated 500 error, confirm re-enables and retrying succeeds cleanly!
    await expect(submitMoveBtn).not.toBeDisabled({ timeout: 3000 });
    await expect(submitMoveBtn).toContainText('确定');
    await submitMoveBtn.click();
    await expect(moveDialog).toBeHidden();
    expect(batchAttempts).toBe(2);
  });

  test('measures 200-chunk high-frequency text and thinking SSE stream on ChatCanvas + ContentRenderer', async ({
    appUrl,
    page,
  }) => {
    const benchSrv = await startHighFreqStreamServer();
    try {
      await apiJson(appUrl, 'POST', '/api/v1/providers', {
        id: 'bench-provider',
        name: 'Bench Provider',
        adapter: 'generic-http',
        baseURL: benchSrv.url,
        authType: 'bearer',
        apiKey: 'sk-bench',
        enabled: true,
        models: [
          {
            id: 'bench-model',
            name: 'Bench Model',
            apiFormat: 'openai-completions',
            reasoning: true,
            inputModalities: ['text'],
          },
        ],
      });

      await connectWithToken(page, appUrl);
      await page.getByRole('button', { name: '选择模型' }).click();
      await page.getByRole('option', { name: 'Bench Model' }).click();

      // Seed 8 prior message exchanges so history re-render work during streaming is exercised realistically.
      for (let t = 1; t <= 4; t += 1) {
        await page.getByLabel('消息输入框').fill(`History turn ${t}`);
        await page.getByLabel('发送消息').click();
        await expect(page.getByText(`Seeded turn ${t}`)).toBeVisible();
      }

      // Install browser performance observers (Long Tasks + scroll/frame instrumentation).
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const longTasks: Array<{ startTime: number; duration: number }> = [];
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        });
        try {
          po.observe({ type: 'longtask', buffered: false });
        } catch {
          // ignore if unsupported
        }

        let frameId = 0;
        let thinkingUpdatesInFrame = 0;
        let maxThinkingUpdatesPerFrame = 0;
        let thinkingScrollEvents = 0;
        let canvasScrollEvents = 0;
        let lastThinkingTop = -1;
        let thinkingOverflowObserved = false;

        const chatScroll = document.querySelector('.wb-chat-scroll') as HTMLDivElement | null;
        if (chatScroll) {
          chatScroll.addEventListener('scroll', () => {
            canvasScrollEvents += 1;
          });
        }

        const mo = new MutationObserver(() => {
          const tb = document.querySelector('.thinking-body') as HTMLDivElement | null;
          if (!tb) return;
          if (tb.scrollHeight > tb.clientHeight) {
            thinkingOverflowObserved = true;
          }
          if (tb.scrollTop !== lastThinkingTop) {
            lastThinkingTop = tb.scrollTop;
            thinkingUpdatesInFrame += 1;
            if (thinkingUpdatesInFrame > maxThinkingUpdatesPerFrame) {
              maxThinkingUpdatesPerFrame = thinkingUpdatesInFrame;
            }
          }
          if (!(tb as unknown as { __benchWatched?: boolean }).__benchWatched) {
            (tb as unknown as { __benchWatched?: boolean }).__benchWatched = true;
            tb.addEventListener('scroll', () => {
              thinkingScrollEvents += 1;
            });
          }
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });

        let rafRunning = true;
        const onFrame = () => {
          frameId += 1;
          thinkingUpdatesInFrame = 0;
          if (rafRunning) requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);

        w.__stopBenchMetrics = () => {
          rafRunning = false;
          po.disconnect();
          mo.disconnect();
          const over50 = longTasks.filter((t) => t.duration > 50);
          return {
            frameCount: frameId,
            longTaskCount: longTasks.length,
            longTaskOver50Count: over50.length,
            longTaskMaxMs:
              longTasks.length > 0 ? Math.max(...longTasks.map((t) => t.duration)) : 0,
            maxThinkingUpdatesPerFrame,
            thinkingScrollEvents,
            canvasScrollEvents,
            thinkingOverflowObserved,
          };
        };
      });

      const composer = page.getByLabel('消息输入框');
      await composer.fill('[200_CHUNK_BENCH]');
      await page.getByLabel('发送消息').click();

      // Wait until streaming begins and verify Composer focus + typing & Stop button remain responsive mid-stream.
      await expect(page.getByLabel('停止生成')).toBeVisible({ timeout: 5000 });
      await composer.click();
      await page.keyboard.type('mid-stream-draft');
      const midStreamState = await page.evaluate(() => ({
        focused: document.activeElement?.getAttribute('aria-label') === '消息输入框',
        value: (document.querySelector('[aria-label="消息输入框"]') as HTMLTextAreaElement)?.value,
        stopVisible: Boolean(document.querySelector('[aria-label="停止生成"]')),
      }));

      await expect(page.getByText('word99')).toBeVisible({ timeout: 15000 });
      await expect(page.getByLabel('停止生成')).toBeHidden({ timeout: 10000 });

      const bench = await page.evaluate(() => {
        const w = window as unknown as Record<string, () => Record<string, unknown>>;
        return w.__stopBenchMetrics();
      });

      console.log(
        '[TASK-023 BENCHMARK]',
        JSON.stringify({ ...bench, ...midStreamState }),
      );

      expect(midStreamState.focused).toBe(true);
      expect(midStreamState.value).toBe('mid-stream-draft');
      expect(midStreamState.stopVisible).toBe(true);
      expect(bench.thinkingOverflowObserved).toBe(true);
      expect(Number(bench.thinkingScrollEvents)).toBeGreaterThan(2);
      expect(Number(bench.maxThinkingUpdatesPerFrame)).toBeLessThanOrEqual(1);
      expect(Number(bench.longTaskOver50Count)).toBe(0);
    } finally {
      await benchSrv.close();
    }
  });
});
