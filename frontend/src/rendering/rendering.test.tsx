import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../app/AppProvider';
import { SETTINGS_STORAGE_KEY, defaultSettings } from '../core/settings';
import { CollapseStateProvider } from './CollapsibleBlock';
import { ContentRenderer } from './ContentRenderer';

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

    // Long thinking starts collapsed; manually expand it
    expect(screen.queryByText(/step 0/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /思考过程/ }));
    expect(screen.getByText(/step 0/)).toBeInTheDocument();

    // Streaming delta updates text; manual expanded state must persist!
    rerender(
      <AppProvider skipInitialBootstrap>
        <CollapseStateProvider>
          <ContentRenderer
            messageId="m1"
            isStreaming
            blocks={[
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: `${md}\n\nMore text` },
            ]}
          />
        </CollapseStateProvider>
      </AppProvider>,
    );
    expect(screen.getByText(/step 0/)).toBeInTheDocument();
    expect(screen.getByText('More text')).toBeInTheDocument();
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
});
