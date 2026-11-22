export type ContentSegment =
  | { kind: 'prose'; markdown: string }
  | { kind: 'code'; language: string; code: string; isClosed: boolean }
  | { kind: 'html'; html: string; isClosed: boolean };

const RAW_HTML_BLOCK_TAGS = new Set([
  'html',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'table',
  'svg',
  'form',
  'style',
  'details',
]);

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const FENCE_START_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const DOCTYPE_START_RE = /^\s*<!doctype\s+html\b/i;
const HTML_OPEN_LINE_RE = /^\s*<([a-zA-Z][a-zA-Z0-9]*)(?=[\s>/]|$)/;
const TAG_TOKEN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?(\/?)>/g;

function matchHtmlBlockStart(line: string): string | null {
  if (/^(?:\t| {4})/.test(line)) {
    return null;
  }
  if (DOCTYPE_START_RE.test(line)) {
    return 'html';
  }
  const m = HTML_OPEN_LINE_RE.exec(line);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  return RAW_HTML_BLOCK_TAGS.has(tag) ? tag : null;
}

function consumeRawHtmlBlock(
  lines: string[],
  startIndex: number,
  rootTag: string,
  isStreaming: boolean,
): { segment: ContentSegment; nextIndex: number } | null {
  const htmlLines: string[] = [];
  let depth = 0;
  let sawRootOpen = false;
  let j = startIndex;

  while (j < lines.length) {
    const line = lines[j];
    htmlLines.push(line);

    TAG_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_TOKEN_RE.exec(line)) !== null) {
      const isClose = m[1] === '/';
      const tag = m[2].toLowerCase();
      const isSelfClose = m[3] === '/' || VOID_HTML_TAGS.has(tag);

      if (tag === rootTag) {
        if (isClose) {
          depth--;
        } else if (!isSelfClose) {
          sawRootOpen = true;
          depth++;
        } else if (!sawRootOpen) {
          sawRootOpen = true;
        }
      }
    }

    if (sawRootOpen && depth <= 0) {
      return {
        segment: {
          kind: 'html',
          html: htmlLines.join('\n'),
          isClosed: true,
        },
        nextIndex: j + 1,
      };
    }
    j++;
  }

  if (isStreaming || htmlLines.length > 1) {
    return {
      segment: {
        kind: 'html',
        html: htmlLines.join('\n'),
        isClosed: false,
      },
      nextIndex: lines.length,
    };
  }
  return null;
}

/**
 * Splits assistant Markdown text into prose, fenced code blocks, and standalone raw HTML blocks.
 * Set `extractCode: false` to keep Markdown fences in prose so CommonMark preserves list, quote, and link boundaries.
 */
export function parseAssistantContent(
  input: string,
  options?: { isStreaming?: boolean; extractCode?: boolean },
): ContentSegment[] {
  if (!input) return [];
  const isStreaming = options?.isStreaming ?? false;
  const extractCode = options?.extractCode ?? true;

  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const segments: ContentSegment[] = [];
  let proseLines: string[] = [];

  const flushProse = () => {
    if (proseLines.length === 0) return;
    const text = proseLines.join('\n');
    proseLines = [];
    if (text.trim().length > 0) {
      segments.push({ kind: 'prose', markdown: text });
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = FENCE_START_RE.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const fenceChar = fence[0];
      const fenceLen = fence.length;
      const info = fenceMatch[2].trim();
      const language = info === '' ? '' : info.split(/\s+/)[0].toLowerCase();

      if (!(fenceChar === '`' && info.includes('`'))) {
        const codeLines: string[] = [];
        let closed = false;
        let j = i + 1;
        const closePrefix = fenceChar.repeat(fenceLen);
        const stripRe = new RegExp(`^\\${fenceChar}+`);

        while (j < lines.length) {
          const candidate = lines[j].trimStart();
          if (candidate.startsWith(closePrefix)) {
            const rest = candidate.replace(stripRe, '');
            if (rest.trim() === '') {
              closed = true;
              break;
            }
          }
          codeLines.push(lines[j]);
          j++;
        }

        const nextIdx = closed ? j + 1 : lines.length;
        if (extractCode) {
          flushProse();
          segments.push({
            kind: 'code',
            language,
            code: codeLines.join('\n'),
            isClosed: closed,
          });
        } else {
          for (let k = i; k < nextIdx; k++) {
            proseLines.push(lines[k]);
          }
        }
        i = nextIdx;
        continue;
      }
    }

    const rawStart = matchHtmlBlockStart(line);
    if (rawStart !== null) {
      const parsed = consumeRawHtmlBlock(lines, i, rawStart, isStreaming);
      if (parsed) {
        flushProse();
        segments.push(parsed.segment);
        i = parsed.nextIndex;
        continue;
      }
    }

    proseLines.push(line);
    i++;
  }

  flushProse();
  return segments;
}

export function splitMarkdownAndRawHtml(
  input: string,
  options?: { isStreaming?: boolean },
): ContentSegment[] {
  return parseAssistantContent(input, { ...options, extractCode: false });
}

export function isFencedHtmlCodeBlock(seg: {
  kind: 'code';
  language: string;
}): boolean {
  return seg.language === 'html' || seg.language === 'htm';
}

export function shouldAutoCollapseText(
  content: string,
  opts: {
    autoCollapseEnabled: boolean;
    collapseLineThreshold: number;
    collapseCharThreshold: number;
  },
): boolean {
  if (!opts.autoCollapseEnabled) return false;
  if (content.length > opts.collapseCharThreshold) return true;
  const lineCount = content.split('\n').length;
  return lineCount > opts.collapseLineThreshold;
}
