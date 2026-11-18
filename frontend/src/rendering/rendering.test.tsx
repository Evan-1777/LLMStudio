import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../app/AppProvider';
import { SETTINGS_STORAGE_KEY, defaultSettings } from '../core/settings';
import type { ContentBlock } from '../core/types';
import { CollapseStateProvider } from './CollapsibleBlock';
import { ContentRenderer } from './ContentRenderer';
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

  it('respects autoCollapseThinkingOnComplete=false, keeps aborted/error thinking open, and keeps code blocks governed by autoCollapseEnabled', async () => {
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

  it('keeps tool rounds in order and folds a successful round only after its final result ends', async () => {
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
          <ContentRenderer messageId={messageId} collapsePrefix="stable-ui-id"
            isStreaming={isStreaming} blocks={blocks.slice(0, count)} blockCompleted={completed} />
        </CollapseStateProvider>
      </AppProvider>
    );
    const { rerender } = render(view(5, [true, true, true, true, false]));
    const first = screen.getByRole('button', { name: /工具调用 · 第 1 轮/ });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveTextContent('执行中 (1/2)');
    expect(screen.getByText('lookup_more')).toBeVisible();
    const detail = screen.getByText('lookup').closest('summary')!;
    expect(detail.closest('details')).not.toHaveAttribute('open');
    await user.click(detail);
    expect(screen.getByText('<script>window.__xss=1</script><b>safe text</b>')).toBeVisible();
    expect(screen.getByText(/doc:\/\/readme/)).toBeVisible();
    expect(screen.getByText(/"count": 2/)).toBeVisible();
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();
    detail.focus();
    rerender(view(5, Array(5).fill(true)));
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(first).toHaveFocus();

    await user.click(first);
    rerender(view(7, Array(7).fill(true)));
    const second = screen.getByRole('button', { name: /工具调用 · 第 2 轮/ });
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveTextContent('执行中 (0/1)');
    rerender(view(blocks.length, [], false, 'server-message'));
    const orphan = screen.getByRole('button', { name: /工具结果/ });
    const inOrder = [screen.getByText('First text'), first, screen.getByText('Between rounds'), second, orphan, screen.getByText('Final answer')];
    inOrder.slice(1).forEach((node, i) => expect(inOrder[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps failed and incomplete rounds visible but hides details until expanded', async () => {
    const user = userEvent.setup();
    render(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer messageId="m-err" stopReason="aborted" blocks={[
          { type: 'toolCall', id: 'a', name: 'broken' },
          { type: 'toolResult', toolCallId: 'a', content: 'connection lost', isError: true },
          { type: 'toolCall', id: 'b', name: 'interrupted' },
        ]} />
      </AppProvider>,
    );
    expect(screen.getByRole('button', { name: /1 个失败/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /未完成/ })).toHaveAttribute('aria-expanded', 'true');
    const detail = screen.getByText('broken').closest('summary')!;
    expect(detail.closest('details')).not.toHaveAttribute('open');
    await user.click(detail);
    expect(screen.getByText('connection lost')).toBeVisible();
    await user.click(detail);
    expect(detail.closest('details')).not.toHaveAttribute('open');
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
});
