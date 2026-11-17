import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../app/AppProvider';
import { CollapseStateProvider } from './CollapsibleBlock';
import { ContentRenderer } from './ContentRenderer';

describe('ContentRenderer and HTML sandbox', () => {
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

  it('mounts sandboxed iframe only when HTML block is closed and omits allow-same-origin', () => {
    const { rerender } = render(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="m2"
          isStreaming
          blocks={[{ type: 'text', text: '```html\n<div>hi' }]}
        />
      </AppProvider>,
    );

    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();
    expect(screen.getByText('<div>hi')).toBeInTheDocument();

    rerender(
      <AppProvider skipInitialBootstrap>
        <ContentRenderer
          messageId="m2"
          isStreaming={false}
          blocks={[{ type: 'text', text: '```html\n<div>hi</div>\n```' }]}
        />
      </AppProvider>,
    );

    const iframe = screen.getByTitle('HTML 预览');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  });
});
