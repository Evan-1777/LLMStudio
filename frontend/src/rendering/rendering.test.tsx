import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../app/AppProvider';
import { SETTINGS_STORAGE_KEY, defaultSettings } from '../core/settings';
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

  it('consolidates multi-round tool calls and results into one scrollable trace, auto-collapses on success while honoring manual reopen, keeps errors open, and never executes tool HTML', async () => {
    const user = userEvent.setup();
    const multiRoundBlocks = [
      { type: 'toolCall', id: 'tc-1', name: 'lookup', arguments: { q: 'alpha' } },
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
      { type: 'toolCall', id: 'tc-2', name: 'summarize', arguments: { depth: 1 } },
      { type: 'toolResult', toolCallId: 'tc-2', toolName: 'summarize', content: 'done' },
      { type: 'text', text: 'Final answer' },
    ];

    // 1. Expanded during streaming, single summary card, safe HTML & embedded resource display.
    const { container, rerender } = render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="local-assistant-1"
            collapsePrefix="ui-trace-1"
            isStreaming
            blocks={multiRoundBlocks}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );

    expect(container.querySelectorAll('.block-card')).toHaveLength(1);
    expect(screen.getByText(/第 1 轮/)).toBeInTheDocument();
    expect(screen.getByText(/第 2 轮/)).toBeInTheDocument();
    expect(screen.getByText('<script>window.__xss=1</script><b>safe text</b>')).toBeInTheDocument();
    expect(screen.getByText(/doc:\/\/readme/)).toBeInTheDocument();
    expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();

    // 2. Overall completion collapses once when autoCollapseToolsOnComplete=true.
    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="srv-1"
            collapsePrefix="ui-trace-1"
            isStreaming={false}
            stopReason="stop"
            blocks={multiRoundBlocks}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.queryByText(/第 1 轮/)).not.toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();

    // 3. Manual reopen stays open across server ID reconciliation re-renders.
    await user.click(screen.getByRole('button', { name: /工具调用/ }));
    expect(screen.getByText(/第 1 轮/)).toBeInTheDocument();
    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="srv-1-reconciled"
            collapsePrefix="ui-trace-1"
            isStreaming={false}
            stopReason="stop"
            blocks={multiRoundBlocks}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByText(/第 1 轮/)).toBeInTheDocument();

    // 4. Error in a tool round keeps trace open & locatable even when autoCollapseToolsOnComplete=true.
    render(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m-err"
            isStreaming={false}
            stopReason="stop"
            blocks={[
              { type: 'toolCall', id: 'tc-e', name: 'bad', arguments: {} },
              {
                type: 'toolResult',
                toolCallId: 'tc-e',
                toolName: 'bad',
                content: 'connection lost',
                isError: true,
              },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByText('connection lost')).toBeInTheDocument();
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
