import { describe, expect, it } from 'vitest';
import { parseAssistantContent, shouldAutoCollapseText } from './segments';

describe('parseAssistantContent', () => {
  it('segments prose, fenced code blocks, and standalone raw HTML structures', () => {
    const input = `# Overview

Inline \`<div>not-raw</div>\` and prose mentioning <script> or <div> stays prose.

\`\`\`html
<div class="box">Fenced HTML</div>
\`\`\`

~~~python
print("tilde fence")
~~~

<!DOCTYPE html>
<html>
  <body><p>Full doc</p></body>
</html>

<svg width="24" height="24">
  <circle cx="12" cy="12" r="10"/>
</svg>

<table>
  <tr><td>Cell</td></tr>
</table>

<form action="/submit"><input type="text"/></form>

<style>.card { color: red; }</style>

Closing paragraph.
`;

    const segments = parseAssistantContent(input);
    const htmlSegs = segments.filter((s) => s.kind === 'html');
    const codeSegs = segments.filter((s) => s.kind === 'code');
    const proseSegs = segments.filter((s) => s.kind === 'prose');

    expect(htmlSegs).toHaveLength(5);
    expect(codeSegs).toHaveLength(2);
    expect(proseSegs).toHaveLength(2);

    expect(codeSegs[0]).toMatchObject({ language: 'html', isClosed: true });
    expect(codeSegs[1]).toMatchObject({ language: 'python', isClosed: true });
    expect(htmlSegs.every((s) => s.kind === 'html' && s.isClosed)).toBe(true);
    expect(htmlSegs[0].kind === 'html' && htmlSegs[0].html).toContain(
      '<!DOCTYPE html>',
    );
    expect(htmlSegs[1].kind === 'html' && htmlSegs[1].html).toContain('<svg');
    expect(htmlSegs[2].kind === 'html' && htmlSegs[2].html).toContain('<table>');
    expect(htmlSegs[3].kind === 'html' && htmlSegs[3].html).toContain('<form');
    expect(htmlSegs[4].kind === 'html' && htmlSegs[4].html).toContain(
      '<style>',
    );
  });

  it('maintains unclosed streaming segments and ignores single-line prose HTML mentions', () => {
    const streamingFence = `Intro text\n\n\`\`\`ts\nconst a = 1;\n`;
    const fenceSegs = parseAssistantContent(streamingFence, {
      isStreaming: true,
    });
    expect(fenceSegs).toHaveLength(2);
    expect(fenceSegs[1]).toMatchObject({ kind: 'code', isClosed: false });

    const streamingHtml = '<section>\n  <h1>Streaming';
    const htmlSegs = parseAssistantContent(streamingHtml, {
      isStreaming: true,
    });
    expect(htmlSegs).toHaveLength(1);
    expect(htmlSegs[0]).toMatchObject({ kind: 'html', isClosed: false });

    const proseLine = '<div> is a generic container element in HTML.';
    const proseSegs = parseAssistantContent(proseLine, { isStreaming: false });
    expect(proseSegs).toHaveLength(1);
    expect(proseSegs[0].kind).toBe('prose');
  });

  it('evaluates collapse threshold accurately', () => {
    expect(
      shouldAutoCollapseText('a\nb\nc', {
        autoCollapseEnabled: true,
        collapseLineThreshold: 2,
        collapseCharThreshold: 1200,
      }),
    ).toBe(true);
    expect(
      shouldAutoCollapseText('a'.repeat(130), {
        autoCollapseEnabled: true,
        collapseLineThreshold: 24,
        collapseCharThreshold: 120,
      }),
    ).toBe(true);
    expect(
      shouldAutoCollapseText('a'.repeat(500), {
        autoCollapseEnabled: false,
        collapseLineThreshold: 4,
        collapseCharThreshold: 120,
      }),
    ).toBe(false);
  });
});
