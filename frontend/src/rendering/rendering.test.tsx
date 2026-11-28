import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../app/AppProvider';
import { SETTINGS_STORAGE_KEY, defaultSettings } from '../core/settings';
import type { ContentBlock } from '../core/types';
import { CollapseStateProvider } from './CollapsibleBlock';
import { ContentRenderer, MarkdownDocument } from './ContentRenderer';
import { SandboxedIframe, buildSandboxedSrcDoc } from './HtmlPreview';

describe('ContentRenderer and HTML sandbox', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it('renders headings, tables, links, thinking, webSearch errors, tool blocks, and preserves manual collapse across streaming deltas', async () => {
    const md = `# Title

| Key | Val |
| --- | --- |
| Alpha | 100 |

[Docs](https://example.com) and [Bad](javascript:alert(1))`;

    const longThinking = Array.from({ length: 30 }, (_, i) => `step ${i}`).join(
      '\n',
    );

    const user = userEvent.setup();
    const { rerender } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m1"
            isStreaming
            blocks={[
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: md },
              {
                type: 'webSearch',
                extra: { query: 'test', engineId: 'tavily', error: 'timeout' },
              },
              {
                type: 'toolCall',
                id: 'tc1',
                name: 'read_file',
                arguments: { path: 'a.txt' },
              },
              {
                type: 'customExt',
                extra: { note: 'hello' },
              },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(screen.queryByRole('link', { name: 'Bad' })).not.toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();

    // Streaming thinking starts expanded even when long; completes on block_end -> auto-collapses, manual reopen persists.
    expect(screen.getByText(/step 0/)).toBeInTheDocument();

    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m1"
            isStreaming
            blockCompleted={[true, false]}
            blocks={[
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: `${md}\n\nMore text` },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.queryByText(/step 0/)).not.toBeInTheDocument();

    // Manually reopen after block_end; subsequent deltas and completion must keep it open.
    await user.click(screen.getByRole('button', { name: /思考过程/ }));
    expect(screen.getByText(/step 0/)).toBeInTheDocument();

    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m1"
            isStreaming={false}
            stopReason="stop"
            blocks={[
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: `${md}\n\nFinal text` },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByText(/step 0/)).toBeInTheDocument();
    expect(screen.getByText('Final text')).toBeInTheDocument();
  });

  it('respects autoCollapseThinkingOnComplete=false, keeps only interrupted thinking open when auto-collapse is enabled, and keeps code blocks governed by autoCollapseEnabled', async () => {
    const longCode = Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`).join('\n');
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...defaultSettings(),
        autoCollapseThinkingOnComplete: false,
        autoCollapseEnabled: true,
      }),
    );

    render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-open"
            isStreaming={false}
            stopReason="stop"
            blocks={[
              { type: 'thinking', thinking: 'kept thinking' },
              { type: 'text', text: `\`\`\`ts\n${longCode}\n\`\`\`` },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByText('kept thinking')).toBeInTheDocument();
    expect(screen.queryByText(/const x0/)).not.toBeInTheDocument();

    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...defaultSettings(),
        autoCollapseThinkingOnComplete: true,
      }),
    );
    render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-aborted"
            isStreaming={false}
            stopReason="aborted"
            blocks={[{ type: 'thinking', thinking: 'aborted trace' }]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByText('aborted trace')).toBeInTheDocument();
    render(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer messageId="m-error" stopReason="error"
          blocks={[{ type: 'thinking', thinking: 'failed trace' }]} />
      </AppProvider>,
    );
    expect(screen.queryByText('failed trace')).not.toBeInTheDocument();
  });

  it('renders closed raw HTML seamlessly by default, hides iframe when visualHtmlRender=false, and keeps fenced HTML code preview gated', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="m2"
          isStreaming
          blocks={[{ type: 'text', text: '<div>streaming' }]}
        />
      </AppProvider>,
    );

    // Unclosed raw HTML while streaming does not mount iframe yet.
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();
    expect(screen.getByText('<div>streaming')).toBeInTheDocument();

    // Closed raw HTML renders seamlessly (no CollapsibleBlock card shell).
    rerender(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="m2"
          isStreaming={false}
          blocks={[{ type: 'text', text: '<div>visual-ok</div>' }]}
        />
      </AppProvider>,
    );
    const seamlessIframe = screen.getByTitle('HTML 预览');
    expect(seamlessIframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(seamlessIframe).toHaveClass('html-sandbox-frame--seamless');
    expect(container.querySelector('.block-card')).not.toBeInTheDocument();

    // Fenced ```html code block defaults to source view (defaultHtmlPreview=false) with manual preview toggle.
    rerender(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="m3"
          isStreaming={false}
          blocks={[{ type: 'text', text: '```html\n<div>fenced</div>\n```' }]}
        />
      </AppProvider>,
    );
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();
    expect(screen.getByText('<div>fenced</div>')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '预览 HTML' }));
    expect(screen.getByTitle('HTML 预览')).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    );

    // When visualHtmlRender is false, closed raw HTML shows read-only code card without mounting iframe.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), visualHtmlRender: false }),
    );
    render(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="m4"
          isStreaming={false}
          blocks={[{ type: 'text', text: '<div>raw-disabled</div>' }]}
        />
      </AppProvider>,
    );
    expect(screen.getByText('<div>raw-disabled</div>')).toBeInTheDocument();
  });

  it('renders multi-step tools in a flat 2-level timeline without round wrappers, skips paired results, and preserves manual collapse', async () => {
    const user = userEvent.setup();
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'First text' },
      { type: 'toolCall', id: 'tc-1', name: 'lookup', arguments: { q: 'alpha' } },
      { type: 'toolCall', id: 'tc-b', name: 'lookup_more' },
      {
        type: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'lookup',
        content: 'alpha ok',
        extra: {
          content: [
            { type: 'text', text: '<script>window.__xss=1</script><b>safe text</b>' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
            {
              type: 'resource',
              resource: { uri: 'doc://readme', mimeType: 'text/html', text: '<div>resource html</div>' },
            },
          ],
          structuredContent: { count: 2 },
        },
      },
      { type: 'toolResult', toolCallId: 'tc-b', content: 'more' },
      { type: 'text', text: 'Between rounds' },
      { type: 'toolCall', id: 'tc-2', name: 'summarize', arguments: { depth: 1 } },
      { type: 'toolResult', toolCallId: 'tc-2', toolName: 'summarize', content: 'done' },
      { type: 'toolResult', toolCallId: 'orphan', toolName: 'orphan', content: 'unmatched' },
      { type: 'text', text: 'Final answer' },
    ];

    const view = (count: number, completed: boolean[], isStreaming = true, messageId = 'local-assistant-1') => (
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId={messageId}
            collapsePrefix="stable-ui-id"
            isStreaming={isStreaming}
            blocks={blocks.slice(0, count)}
            blockCompleted={completed}
          />
        </CollapseStateProvider>
      </AppProvider>
    );

    const { rerender } = render(view(5, [true, true, true, true, false]));
    const trace = screen.getByRole('button', { name: /正在执行 · lookup_more/ });
    expect(trace).toHaveAttribute('aria-expanded', 'true');
    // No round cards anywhere; tool names & target argument summaries are directly visible at level 2.
    expect(screen.queryByText(/第 \d+ 轮/)).not.toBeInTheDocument();
    const lookupStep = screen.getByRole('button', { name: /lookup.*alpha/ });
    expect(lookupStep).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^lookup_more/ })).toBeVisible();

    await user.click(lookupStep);
    expect(lookupStep).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('<script>window.__xss=1</script><b>safe text</b>')).toBeVisible();
    expect(screen.getByText(/doc:\/\/readme/)).toBeVisible();
    expect(screen.getByText(/"count": 2/)).toBeVisible();
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();

    // Paired toolResult is never rendered twice.
    expect(screen.getAllByText('lookup')).toHaveLength(1);

    // Focus inside trace returns to trigger if auto-collapsed, and manual toggle persists across messageId replacement.
    rerender(view(7, Array(7).fill(true)));
    expect(screen.getByRole('button', { name: /正在执行 · summarize/ })).toHaveAttribute('aria-expanded', 'true');
    const traceBtn = screen.getByRole('button', { name: /正在执行 · summarize/ });
    await user.click(traceBtn);
    await user.click(traceBtn);

    rerender(view(blocks.length, [], false, 'server-message'));
    const doneTrace = screen.getByRole('button', { name: /工具调用 · 4 次 · 完成/ });
    expect(doneTrace).toHaveAttribute('aria-expanded', 'true');

    const reopenedLookup = screen.getByRole('button', { name: /lookup.*alpha/ });
    const summarizeStep = screen.getByRole('button', { name: /summarize/ });
    const orphanStep = screen.getByRole('button', { name: /orphan/ });
    const note = screen.getByText('Between rounds');
    const answer = screen.getByText('Final answer');
    const inOrder = [screen.getByText('First text'), doneTrace, reopenedLookup, note, summarizeStep, orphanStep, answer];
    inOrder.slice(1).forEach((node, i) =>
      expect(inOrder[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(),
    );
    expect(note.closest('.trace-timeline')).not.toBeNull();
    expect(answer.closest('.trace-timeline')).toBeNull();
    expect(reopenedLookup).toHaveAttribute('aria-expanded', 'true');
    expect(summarizeStep).toHaveAttribute('aria-expanded', 'false');
  });

  it('folds an interleaved thinking and tool timeline once and shows every tool directly on level 2', async () => {
    const user = userEvent.setup();
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'first thought' },
      { type: 'toolCall', id: 'a', name: 'firstTool', arguments: { path: 'src/a.ts' } },
      { type: 'toolResult', toolCallId: 'a', content: 'first result' },
      { type: 'text', text: 'Progress update' },
      { type: 'thinking', thinking: 'second thought' },
      { type: 'toolCall', id: 'b', name: 'secondTool', arguments: { path: 'src/b.ts' } },
      { type: 'toolResult', toolCallId: 'b', content: 'second result' },
      { type: 'thinking', thinking: 'third thought' },
    ];
    const view = (items: ContentBlock[], streaming = false, stopReason = 'stop') => (
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="multi"
            blocks={items}
            isStreaming={streaming}
            blockCompleted={streaming ? [true, true, true, true, true, true, true, false] : undefined}
            stopReason={stopReason}
          />
        </CollapseStateProvider>
      </AppProvider>
    );
    const { rerender, unmount } = render(view(blocks, true));
    expect(screen.getAllByRole('button', { name: '思考中…' })[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('button', { name: /^思考过程/ })).toHaveLength(2);
    expect(screen.getByText('third thought')).toBeVisible();

    rerender(view([...blocks, { type: 'text', text: 'Final text' }]));
    const trace = screen.getByRole('button', { name: /思考与工具 · 2 次 · 完成/ });
    expect(trace).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Final text')).toBeVisible();

    await user.click(trace);
    expect(screen.getByText('Progress update')).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^思考过程/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: /firstTool.*src\/a\.ts/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /secondTool.*src\/b\.ts/ })).toHaveAttribute('aria-expanded', 'false');

    const errorBlocks: ContentBlock[] = [...blocks, { type: 'toolCall', id: 'c', name: 'thirdTool' }];
    rerender(view(errorBlocks, false, 'error'));
    expect(trace).toHaveAttribute('aria-expanded', 'true');
    for (const completed of screen.getAllByRole('button', { name: /^思考过程/ })) {
      expect(completed).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.getByRole('button', { name: /thirdTool/ })).toBeVisible();
    unmount();
    render(view(errorBlocks, false, 'error'));
    expect(screen.getByRole('button', { name: /思考与工具 · 3 次 · 未完成/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps aborted incomplete timelines open and toggles tool details directly at level 2', async () => {
    const user = userEvent.setup();
    render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-err"
            stopReason="aborted"
            blocks={[
              { type: 'toolCall', id: 'a', name: 'broken', arguments: { path: 'bad.txt' } },
              { type: 'toolResult', toolCallId: 'a', content: 'connection lost', isError: true },
              { type: 'toolCall', id: 'b', name: 'interrupted' },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByRole('button', { name: /工具调用 · 2 次 · 1 个失败/ })).toHaveAttribute('aria-expanded', 'true');
    const brokenStep = screen.getByRole('button', { name: /broken.*bad\.txt/ });
    expect(brokenStep).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /interrupted/ })).toBeVisible();
    await user.click(brokenStep);
    expect(screen.getByText('connection lost')).toBeVisible();
    await user.click(brokenStep);
    expect(brokenStep).toHaveAttribute('aria-expanded', 'false');
  });

  it('auto-collapses standalone failed tools and timelines on completion and respects autoCollapseToolsOnComplete=false', async () => {
    const user = userEvent.setup();
    const singleBlocks: ContentBlock[] = [
      { type: 'toolCall', id: 'tc-fail', name: 'broken_tool', arguments: { target: 'x' } },
      { type: 'toolResult', toolCallId: 'tc-fail', toolName: 'broken_tool', content: 'boom', isError: true },
      { type: 'text', text: 'Handled failure' },
    ];
    const renderSingle = (count: number, completed?: boolean[], isStreaming = false) => (
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-fail-single"
            collapsePrefix="fail-single"
            isStreaming={isStreaming}
            blockCompleted={completed}
            stopReason={isStreaming ? undefined : 'stop'}
            blocks={singleBlocks.slice(0, count)}
          />
        </CollapseStateProvider>
      </AppProvider>
    );

    const { rerender, unmount } = render(renderSingle(2, [true, false], true));
    const singleStep = screen.getByRole('button', { name: /broken_tool.*x/ });
    expect(singleStep).toHaveAttribute('aria-expanded', 'true');

    rerender(renderSingle(2, [true, true], true));
    expect(singleStep).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('img', { name: '失败' })).toBeInTheDocument();

    await user.click(singleStep);
    expect(singleStep).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('boom')).toBeVisible();
    rerender(renderSingle(3, undefined, false));
    expect(singleStep).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Handled failure')).toBeVisible();

    // Simulate page reload: fresh CollapseStateProvider mounts with auto-collapsed failed standalone tool.
    unmount();
    const reloadedSingle = render(renderSingle(3, undefined, false));
    expect(screen.getByRole('button', { name: /broken_tool.*x/ })).toHaveAttribute('aria-expanded', 'false');
    reloadedSingle.unmount();

    // Multi-step thinking + failed tool timeline also auto-collapses and remains collapsed after reload.
    const traceBlocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'planning call' },
      { type: 'toolCall', id: 'tc-t', name: 'failing_step' },
      { type: 'toolResult', toolCallId: 'tc-t', toolName: 'failing_step', content: 'upstream 500', isError: true },
      { type: 'text', text: 'Final summary' },
    ];
    const renderTrace = (count: number, completed?: boolean[], isStreaming = false) => (
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-fail-trace"
            blocks={traceBlocks.slice(0, count)}
            isStreaming={isStreaming}
            blockCompleted={completed}
            stopReason={isStreaming ? undefined : 'stop'}
          />
        </CollapseStateProvider>
      </AppProvider>
    );
    const traceView = render(renderTrace(3, [true, true, false], true));
    expect(screen.getByRole('button', { name: /正在执行 · failing_step/ })).toHaveAttribute('aria-expanded', 'true');
    traceView.rerender(renderTrace(4, undefined, false));
    const traceBtn = screen.getByRole('button', { name: /思考与工具 · 1 次 · 1 个失败/ });
    expect(traceBtn).toHaveAttribute('aria-expanded', 'false');
    traceView.unmount();

    const reloadedTrace = render(renderTrace(4, undefined, false));
    const reloadedBtn = screen.getByRole('button', { name: /思考与工具 · 1 次 · 1 个失败/ });
    expect(reloadedBtn).toHaveAttribute('aria-expanded', 'false');
    await user.click(reloadedBtn);
    expect(screen.getByRole('button', { name: /failing_step/ })).toHaveAttribute('aria-expanded', 'false');
    reloadedTrace.unmount();

    // Respects autoCollapseToolsOnComplete=false for standalone failed tool too.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), autoCollapseToolsOnComplete: false }),
    );
    render(renderSingle(3, undefined, false));
    expect(screen.getByRole('button', { name: /broken_tool.*x/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps ThinkingScrollBody auto-following across large streaming deltas unless the user scrolls away', async () => {
    const rafQueue: FrameRequestCallback[] = [];
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;

    try {
      const { rerender } = render(
        <AppProvider skipInitialBootstrap>
          <CollapseStateProvider>
            <ContentRenderer
              messageId="m-think-scroll"
              isStreaming
              blockCompleted={[false]}
              blocks={[{ type: 'thinking', thinking: 'line 1\nline 2\n' }]}
            />
          </CollapseStateProvider>
        </AppProvider>,
      );

      const region = screen.getByRole('region', { name: '思考过程内容' }) as HTMLDivElement;
      let scrollHeightVal = 400;
      let scrollTopVal = 0;
      Object.defineProperty(region, 'clientHeight', { configurable: true, get: () => 200 });
      Object.defineProperty(region, 'scrollHeight', { configurable: true, get: () => scrollHeightVal });
      Object.defineProperty(region, 'scrollTop', {
        configurable: true,
        get: () => scrollTopVal,
        set: (v: number) => {
          scrollTopVal = v;
        },
      });

      // Simulate frame 1 flush, then height grows by +60px (>24px) BEFORE async scroll event fires.
      while (rafQueue.length > 0) rafQueue.shift()!(16);
      expect(scrollTopVal).toBe(400);
      scrollHeightVal = 460;
      region.dispatchEvent(new Event('scroll'));

      // Next delta still auto-follows to bottom because previous scroll matched programmatic position.
      rerender(
        <AppProvider skipInitialBootstrap>
          <CollapseStateProvider>
            <ContentRenderer
              messageId="m-think-scroll"
              isStreaming
              blockCompleted={[false]}
              blocks={[{ type: 'thinking', thinking: 'line 1\nline 2\nline 3\nline 4\n' }]}
            />
          </CollapseStateProvider>
        </AppProvider>,
      );
      while (rafQueue.length > 0) rafQueue.shift()!(32);
      expect(scrollTopVal).toBe(460);

      // Simulate genuine user scroll up -> subsequent streaming delta respects user position.
      scrollTopVal = 50;
      region.dispatchEvent(new Event('scroll'));
      scrollHeightVal = 600;
      rerender(
        <AppProvider skipInitialBootstrap>
          <CollapseStateProvider>
            <ContentRenderer
              messageId="m-think-scroll"
              isStreaming
              blockCompleted={[false]}
              blocks={[{ type: 'thinking', thinking: 'line 1\nline 2\nline 3\nline 4\nline 5\n' }]}
            />
          </CollapseStateProvider>
        </AppProvider>,
      );
      while (rafQueue.length > 0) rafQueue.shift()!(48);
      expect(scrollTopVal).toBe(50);
    } finally {
      window.requestAnimationFrame = origRaf;
    }
  });

  it('injects inline responsive style and height bridge for fragments and full docs, omits both for fullscreen, and clamps inline height at 8192 px', () => {
    const fragInline = buildSandboxedSrcDoc('<div style="width:600px">hi</div>', 'n1');
    expect(fragInline).toContain('llmstudio-html-height');
    expect(fragInline).toContain(':where(img, svg, video, canvas)');

    const docInline = buildSandboxedSrcDoc(
      '<!DOCTYPE html><html><head><title>Doc</title></head><body><div>hi</div></body></html>',
      'n2',
    );
    expect(docInline).toContain('llmstudio-html-height');
    expect(docInline).toContain(':where(html, body)');

    const docFullscreen = buildSandboxedSrcDoc(
      '<!DOCTYPE html><html><head><title>Doc</title></head><body><div>hi</div></body></html>',
      'n3',
      { measure: false },
    );
    expect(docFullscreen).not.toContain('llmstudio-html-height');
    expect(docFullscreen).not.toContain(':where(html, body)');

    const { rerender } = render(
      <AppProvider skipInitialBootstrap>
        <SandboxedIframe html="<div>tall</div>" />
      </AppProvider>,
    );
    const frame = screen.getByTitle('HTML 预览') as HTMLIFrameElement;
    const srcDoc = frame.getAttribute('srcdoc') ?? '';
    const nonceMatch = /var nonce = "([^"]+)"/.exec(srcDoc);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1];

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: { type: 'llmstudio-html-height', nonce, height: 900 },
        }),
      );
    });
    expect(frame.style.height).toBe('900px');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: { type: 'llmstudio-html-height', nonce, height: 9500 },
        }),
      );
    });
    expect(frame.style.height).toBe('8192px');

    rerender(
      <AppProvider skipInitialBootstrap>
        <SandboxedIframe html="<div>tall</div>" fillAvailable />
      </AppProvider>,
    );
    expect(frame.style.height).toBe('min(70dvh, 640px)');
  });

  it('keeps CommonMark list/blockquote fence boundaries, reference links across code blocks, CJK bold punctuation, CRLF, and long fences intact', () => {
    const md = [
      '1. 第一步',
      '   ```ts',
      '   const step1 = 1;',
      '   ```',
      '2. 第二步查看 [规范文档][spec-ref]',
      '> 引用说明',
      '>',
      '> ```js',
      '> const quoted = true;',
      '> ```',
      '>',
      '> 引用结尾',
      '中文**（加粗）**与**“引号”**，还有 ~~删除线~~。',
      '````md',
      '```ts',
      'const nested = 1;',
      '```',
      '````',
      '[spec-ref]: https://example.com/spec',
    ].join('\r\n');

    const { container } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-cm"
            blocks={[{ type: 'text', text: md }]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );

    const ols = container.querySelectorAll('ol');
    expect(ols).toHaveLength(1);
    expect(ols[0].querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ols[0].querySelector('.block-card')).not.toBeNull();

    const quote = container.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote!.querySelector('.block-card')).not.toBeNull();
    expect(quote!.textContent).toContain('const quoted = true;');
    expect(quote!.textContent).not.toContain('> const quoted');

    const link = screen.getByRole('link', { name: '规范文档' });
    expect(link).toHaveAttribute('href', 'https://example.com/spec');

    const strongs = Array.from(container.querySelectorAll('strong')).map((s) => s.textContent);
    expect(strongs).toContain('（加粗）');
    expect(strongs).toContain('“引号”');
    expect(container.querySelector('del')?.textContent).toBe('删除线');
    expect(container.textContent).toContain('const nested = 1;');

    // User messages render Markdown and math while preserving soft line breaks.
    const userView = render(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="u-md"
          isUser
          blocks={[{ type: 'text', text: '**bold** $x^2$ \\(y\\)\nsecond line' }]}
        />
      </AppProvider>,
    );
    expect(userView.container.querySelector('strong')?.textContent).toBe('bold');
    expect(userView.container.querySelector('.katex')).not.toBeNull();
    expect(userView.container.querySelector('br')).not.toBeNull();
    expect(userView.container.textContent).toContain('second line');
  });

  it('renders user fenced code without mounting an HTML preview iframe', () => {
    const longCode = Array.from({ length: 40 }, (_, i) => `const u${i} = ${i};`).join('\n');
    const { container } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="u-code"
            isUser
            blocks={[{
              type: 'text',
              text: `\`\`\`html\n<div>hi</div>\n${longCode}\n\`\`\`\n\n<script>alert(1)</script>`,
            }]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.block-card')).not.toBeNull();
  });

  it('renders four LaTeX delimiters via KaTeX, respects mathRenderEnabled toggle, protects code/URL/HTML/currency, and falls back on invalid/unclosed math', () => {
    const md = [
      '行内 $a^2 + b^2 = c^2$ 与 \\(e^{i\\pi}+1=0\\)。',
      '',
      '$$',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '$$',
      '',
      '\\[',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '\\]',
      '',
      '价格是 $5 和 $10，转义 \\$x\\$，代码 `$z$` 与 `\\(w\\)`。',
      '',
      '链接 [url](https://example.com/$a$/$b$/(c)) 与不合法 $\\unknowncmd{1}$。',
      '',
      '```tex',
      '$$not_math$$',
      '\\[also_not_math\\]',
      '```',
    ].join('\n');

    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), mathRenderEnabled: true }),
    );
    const { container, rerender } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-math"
            isStreaming
            blocks={[{ type: 'text', text: '流式未闭合 $x + ' }]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$x +');

    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-math"
            isStreaming={false}
            blocks={[{ type: 'text', text: md }]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );

    const katexNodes = container.querySelectorAll('.katex');
    expect(katexNodes).toHaveLength(4);
    expect(container.querySelectorAll('.katex-mathml math').length).toBe(4);
    expect(container.querySelector('.math-block-scroll')).not.toBeNull();
    expect(container.textContent).toContain('$5 和 $10');
    expect(container.textContent).toContain('$x$');
    expect(container.textContent).toContain('$z$');
    expect(container.textContent).toContain('\\(w\\)');
    expect(container.textContent).toContain('$\\unknowncmd{1}$');
    expect(container.textContent).toContain('$$not_math$$');
    expect(screen.getByRole('link', { name: 'url' })).toHaveAttribute(
      'href',
      'https://example.com/$a$/$b$/(c)',
    );

    // Disable math rendering: preserves original delimiters & backslashes verbatim.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), mathRenderEnabled: false }),
    );
    const { container: offContainer } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-math-off"
            blocks={[{ type: 'text', text: '公式 \\(a_1\\) 与 \\[b_2\\] 与 $c_3$' }]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(offContainer.querySelector('.katex')).toBeNull();
    expect(offContainer.querySelector('em')).toBeNull();
    expect(offContainer.textContent).toContain('\\(a_1\\)');
    expect(offContainer.textContent).toContain('\\[b_2\\]');
    expect(offContainer.textContent).toContain('$c_3$');

    // KaTeX trust:false blocks javascript: links from \href, and streaming unclosed code blocks report 输出中 until closed.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), mathRenderEnabled: true }),
    );
    const { container: secContainer } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-sec"
            isStreaming
            blocks={[
              {
                type: 'text',
                text: '$\\href{javascript:alert(1)}{click}$\n\n```html\n<div>streaming',
              },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(secContainer.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('HTML · 输出中')).toBeInTheDocument();
  });

  it('renders MarkdownDocument with explicit visualHtmlRender and defaultHtmlPreview overrides for div, svg, details, and fenced html', () => {
    const doc = [
      '# Workspace Doc',
      '',
      '<div>visual-div</div>',
      '',
      '<svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>',
      '',
      '<details><summary>Expandable</summary><p>Hidden body</p></details>',
      '',
      '```html',
      '<section>fenced-visual</section>',
      '```',
    ].join('\n');

    const { rerender } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <MarkdownDocument
            content={doc}
            collapsePrefix="ws-doc"
            visualHtmlRender={false}
            defaultHtmlPreview={false}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Workspace Doc' })).toBeInTheDocument();
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();
    expect(screen.getByText('<div>visual-div</div>')).toBeInTheDocument();
    expect(screen.getByText('<section>fenced-visual</section>')).toBeInTheDocument();

    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <MarkdownDocument
            content={doc}
            collapsePrefix="ws-doc-on"
            visualHtmlRender
            defaultHtmlPreview
          />
        </CollapseStateProvider>
      </AppProvider>,
    );

    const frames = screen.getAllByTitle('HTML 预览');
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    }
  });
});
