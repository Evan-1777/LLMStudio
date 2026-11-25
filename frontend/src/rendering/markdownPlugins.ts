import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkMath from 'remark-math';
import type { PluggableList, Processor } from 'unified';

type TokenizerState = (code: number | null) => TokenizerState | void;
type MicromarkCallback = (code: number | null) => TokenizerState | void;

interface MicromarkToken {
  type: string;
  start: unknown;
  end: unknown;
}

interface MicromarkTokenizeContext {
  events: MicromarkEvent[];
  interrupt?: boolean;
  now(): { line: number };
  sliceSerialize(token: MicromarkToken, expandTabs?: boolean): string;
  parser: {
    lazy: Record<number, boolean | undefined>;
    constructs: {
      disable: {
        null: string[];
      };
    };
  };
}

type MicromarkEvent = ['enter' | 'exit', MicromarkToken, MicromarkTokenizeContext];

interface MicromarkPartialConstruct {
  partial: true;
  tokenize(
    this: MicromarkTokenizeContext,
    effects: MicromarkEffects,
    ok: MicromarkCallback,
    nok: MicromarkCallback,
  ): TokenizerState;
}

interface MicromarkEffects {
  enter(type: string): MicromarkToken;
  exit(type: string): MicromarkToken;
  consume(code: number | null): void;
  attempt(
    construct: MicromarkPartialConstruct,
    ok: MicromarkCallback,
    nok: MicromarkCallback,
  ): TokenizerState;
}

interface MdastCompileContext {
  stack: NodeLike[];
  enter(node: NodeLike, token: MicromarkToken): void;
  exit(token: MicromarkToken): void;
  buffer(): void;
  resume(): string;
}

interface RemarkDataContainer {
  micromarkExtensions?: Array<{
    flow?: Record<number, unknown>;
    text?: Record<number, unknown>;
  }>;
  fromMarkdownExtensions?: unknown[];
}

type NodeLike = {
  type: string;
  value?: string;
  lang?: string | null;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  data?: Record<string, unknown>;
  children?: NodeLike[];
};

function walkAst(node: NodeLike, visitor: (n: NodeLike) => void): void {
  visitor(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walkAst(child, visitor);
    }
  }
}

function isLineEnding(code: number | null): boolean {
  return code === 10 || code === 13 || code === -3 || code === -4 || code === -5;
}

function isHorizontalSpace(code: number | null): boolean {
  return code === 32 || code === 9 || code === -1 || code === -2;
}

function isDigit(code: number | null): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/**
 * Currency- and escape-aware replacement for micromark-extension-math's $...$ / $$...$$ text construct.
 * Single-$ rejects leading/trailing horizontal whitespace, blank lines, and trailing digits ($5 and $10).
 */
const currencySafeDollarMathText = {
  name: 'mathText',
  previous(this: { events: Array<[string, { type: string }]> }, code: number | null) {
    return code !== 36 || this.events[this.events.length - 1]?.[1].type === 'characterEscape';
  },
  tokenize(effects: MicromarkEffects, ok: MicromarkCallback, nok: MicromarkCallback) {
    let sizeOpen = 0;
    let size = 0;
    let token: MicromarkToken | undefined;
    let lastNonSeqCode: number | null = null;
    let consecutiveNewlines = 0;

    return start;

    function start(code: number | null) {
      effects.enter('mathText');
      effects.enter('mathTextSequence');
      return sequenceOpen(code);
    }

    function sequenceOpen(code: number | null) {
      if (code === 36) {
        effects.consume(code);
        sizeOpen++;
        return sequenceOpen;
      }
      if (sizeOpen === 1) {
        if (code === null || isHorizontalSpace(code) || isLineEnding(code)) {
          return nok(code);
        }
      }
      effects.exit('mathTextSequence');
      return between(code);
    }

    function between(code: number | null): TokenizerState | void {
      if (code === null || code === 96) return nok(code);
      if (code === 36) {
        token = effects.enter('mathTextSequence');
        size = 0;
        return sequenceClose(code);
      }
      if (code === 32) {
        lastNonSeqCode = 32;
        consecutiveNewlines = 0;
        effects.enter('space');
        effects.consume(code);
        effects.exit('space');
        return between;
      }
      if (isLineEnding(code)) {
        consecutiveNewlines++;
        if (consecutiveNewlines > 1) return nok(code);
        lastNonSeqCode = code;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return between;
      }
      consecutiveNewlines = 0;
      effects.enter('mathTextData');
      return data(code);
    }

    function data(code: number | null): TokenizerState | void {
      if (code === null || code === 32 || code === 36 || code === 96 || isLineEnding(code)) {
        effects.exit('mathTextData');
        return between(code);
      }
      if (code === 92) {
        lastNonSeqCode = 92;
        effects.consume(code);
        return dataEscape;
      }
      lastNonSeqCode = code;
      effects.consume(code);
      return data;
    }

    function dataEscape(code: number | null): TokenizerState | void {
      if (code === null || isLineEnding(code)) {
        effects.exit('mathTextData');
        return between(code);
      }
      lastNonSeqCode = code;
      effects.consume(code);
      return data;
    }

    function sequenceClose(code: number | null): TokenizerState | void {
      if (code === 36) {
        effects.consume(code);
        size++;
        return sequenceClose;
      }
      if (size === sizeOpen) {
        if (sizeOpen === 1) {
          if (
            lastNonSeqCode === null ||
            isHorizontalSpace(lastNonSeqCode) ||
            isLineEnding(lastNonSeqCode) ||
            isDigit(code)
          ) {
            if (token) token.type = 'mathTextData';
            lastNonSeqCode = 36;
            return data(code);
          }
        }
        effects.exit('mathTextSequence');
        effects.exit('mathText');
        return ok(code);
      }
      if (token) token.type = 'mathTextData';
      lastNonSeqCode = 36;
      return data(code);
    }
  },
  resolve(events: MicromarkEvent[]) {
    let tailExitIndex = events.length - 4;
    let headEnterIndex = 3;
    if (
      tailExitIndex > headEnterIndex &&
      (events[headEnterIndex][1].type === 'lineEnding' || events[headEnterIndex][1].type === 'space') &&
      (events[tailExitIndex][1].type === 'lineEnding' || events[tailExitIndex][1].type === 'space')
    ) {
      let index = headEnterIndex;
      while (++index < tailExitIndex) {
        if (events[index][1].type === 'mathTextData') {
          events[tailExitIndex][1].type = 'mathTextPadding';
          events[headEnterIndex][1].type = 'mathTextPadding';
          headEnterIndex += 2;
          tailExitIndex -= 2;
          break;
        }
      }
    }
    let index = headEnterIndex - 1;
    tailExitIndex++;
    let enter: number | undefined;
    while (++index <= tailExitIndex) {
      if (enter === undefined) {
        if (index !== tailExitIndex && events[index][1].type !== 'lineEnding') {
          enter = index;
        }
      } else if (index === tailExitIndex || events[index][1].type === 'lineEnding') {
        events[enter][1].type = 'mathTextData';
        if (index !== enter + 2) {
          events[enter][1].end = events[index - 1][1].end;
          events.splice(enter + 2, index - enter - 2);
          tailExitIndex -= index - enter - 2;
          index = enter + 2;
        }
        enter = undefined;
      }
    }
    return events;
  },
};

/**
 * Micromark construct for inline \(...\) and inline \[...\] math before CommonMark escapes strip backslashes.
 */
function createLatexBracketText() {
  return {
    name: 'latexBracketText',
    tokenize(effects: MicromarkEffects, ok: MicromarkCallback, nok: MicromarkCallback) {
      let closeCode = 41;
      let outerType = 'mathText';
      let consecutiveNewlines = 0;

      return start;

      function start(code: number | null): TokenizerState | void {
        if (code !== 92) return nok(code);
        effects.enter('latexBracketProbe');
        effects.consume(code);
        return checkOpener;
      }

      function checkOpener(code: number | null): TokenizerState | void {
        if (code === 40) {
          closeCode = 41;
          outerType = 'mathText';
        } else if (code === 91) {
          closeCode = 93;
          outerType = 'latexDisplayText';
        } else {
          return nok(code);
        }
        effects.consume(code);
        effects.exit('latexBracketProbe');
        return between;
      }

      function between(code: number | null): TokenizerState | void {
        if (code === null || code === 96) return nok(code);
        if (code === 92) {
          return effects.attempt(
            {
              partial: true,
              tokenize(eff: MicromarkEffects, okClose: MicromarkCallback, nokClose: MicromarkCallback) {
                return (c: number | null) => {
                  eff.enter('mathTextSequence');
                  eff.consume(c);
                  return (c2: number | null) => {
                    if (c2 !== closeCode) return nokClose(c2);
                    eff.consume(c2);
                    eff.exit('mathTextSequence');
                    return okClose(c2);
                  };
                };
              },
            },
            done,
            consumeEscapedInData,
          )(code);
        }
        if (code === 32) {
          consecutiveNewlines = 0;
          effects.enter('space');
          effects.consume(code);
          effects.exit('space');
          return between;
        }
        if (isLineEnding(code)) {
          consecutiveNewlines++;
          if (consecutiveNewlines > 1) return nok(code);
          effects.enter('lineEnding');
          effects.consume(code);
          effects.exit('lineEnding');
          return between;
        }
        consecutiveNewlines = 0;
        effects.enter('mathTextData');
        return data(code);
      }

      function consumeEscapedInData(code: number | null): TokenizerState | void {
        effects.enter('mathTextData');
        effects.consume(code);
        return afterSlashInData;
      }

      function afterSlashInData(code: number | null): TokenizerState | void {
        if (code === null || isLineEnding(code)) {
          effects.exit('mathTextData');
          return between(code);
        }
        effects.consume(code);
        return data;
      }

      function data(code: number | null): TokenizerState | void {
        if (code === null || code === 32 || code === 92 || code === 96 || isLineEnding(code)) {
          effects.exit('mathTextData');
          return between(code);
        }
        effects.consume(code);
        return data;
      }

      function done(code: number | null) {
        void outerType;
        return ok(code);
      }
    },
    resolve(events: MicromarkEvent[]) {
      // Rename the probe token to the resolved math node and wrap the sequence.
      if (events.length < 2) return events;
      const openProbe = events[0][1];
      const isDisplay = events[0][2].sliceSerialize(openProbe) === '\\[';
      const outer = isDisplay ? 'latexDisplayText' : 'mathText';
      openProbe.type = 'mathTextSequence';
      const wrapperToken: MicromarkToken = {
        type: outer,
        start: openProbe.start,
        end: events[events.length - 1][1].end,
      };
      const wrapperEnter: MicromarkEvent = ['enter', wrapperToken, events[0][2]];
      const wrapperExit: MicromarkEvent = ['exit', wrapperToken, events[0][2]];
      events.unshift(wrapperEnter);
      events.push(wrapperExit);
      return events;
    },
  };
}

/**
 * Micromark flow construct for standalone \[ ... \] display math blocks (single-line or multi-line).
 */
function createLatexBracketFlow() {
  const nonLazyContinuation: MicromarkPartialConstruct = {
    partial: true,
    tokenize(this: MicromarkTokenizeContext, effects: MicromarkEffects, ok: MicromarkCallback, nok: MicromarkCallback) {
      const self = this;
      return (code: number | null) => {
        if (code === null) return ok(code);
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return (next: number | null) =>
          self.parser.lazy[self.now().line] ? nok(next) : ok(next);
      };
    },
  };

  return {
    name: 'latexBracketFlow',
    concrete: true,
    tokenize(this: MicromarkTokenizeContext, effects: MicromarkEffects, ok: MicromarkCallback, nok: MicromarkCallback) {
      const self = this;
      const tail = self.events[self.events.length - 1];
      const initialSize =
        tail && tail[1].type === 'linePrefix'
          ? tail[2].sliceSerialize(tail[1], true).length
          : 0;

      return start;

      function start(code: number | null) {
        if (code !== 92) return nok(code);
        effects.enter('mathFlow');
        effects.enter('mathFlowFence');
        effects.enter('mathFlowFenceSequence');
        effects.consume(code);
        return openBracket;
      }

      function openBracket(code: number | null) {
        if (code !== 91) return nok(code);
        effects.consume(code);
        effects.exit('mathFlowFenceSequence');
        effects.exit('mathFlowFence');
        return afterOpen;
      }

      function afterOpen(code: number | null) {
        if (code === null) return nok(code);
        if (isLineEnding(code)) {
          if (self.interrupt) return nok(code);
          return effects.attempt(nonLazyContinuation, beforeMultiLine, nok)(code);
        }
        // Single-line form: \[ ... \]
        return singleLineContent(code);
      }

      function singleLineContent(code: number | null): TokenizerState | void {
        if (code === null || isLineEnding(code)) return nok(code);
        if (code === 92) {
          return effects.attempt(
            {
              partial: true,
              tokenize(eff: MicromarkEffects, okClose: MicromarkCallback, nokClose: MicromarkCallback) {
                return (c: number | null) => {
                  eff.enter('mathFlowFence');
                  eff.enter('mathFlowFenceSequence');
                  eff.consume(c);
                  return (c2: number | null) => {
                    if (c2 !== 93) return nokClose(c2);
                    eff.consume(c2);
                    eff.exit('mathFlowFenceSequence');
                    return skipTrailingSpaces(eff, okClose, nokClose);
                  };
                };
              },
            },
            finishFlow,
            singleLineSlashData,
          )(code);
        }
        effects.enter('mathFlowValue');
        return singleLineData(code);
      }

      function singleLineSlashData(code: number | null): TokenizerState | void {
        effects.enter('mathFlowValue');
        effects.consume(code);
        return singleLineAfterSlash;
      }

      function singleLineAfterSlash(code: number | null): TokenizerState | void {
        if (code === null || isLineEnding(code)) {
          effects.exit('mathFlowValue');
          return nok(code);
        }
        effects.consume(code);
        return singleLineData;
      }

      function singleLineData(code: number | null): TokenizerState | void {
        if (code === null || isLineEnding(code)) {
          effects.exit('mathFlowValue');
          return nok(code);
        }
        if (code === 92) {
          effects.exit('mathFlowValue');
          return singleLineContent(code);
        }
        effects.consume(code);
        return singleLineData;
      }

      function skipTrailingSpaces(
        eff: MicromarkEffects,
        okClose: MicromarkCallback,
        nokClose: MicromarkCallback,
      ): TokenizerState {
        return function loop(c: number | null): TokenizerState | void {
          if (c === 32 || c === 9) {
            eff.enter('whitespace');
            eff.consume(c);
            eff.exit('whitespace');
            return loop;
          }
          if (c === null || isLineEnding(c)) {
            eff.exit('mathFlowFence');
            return okClose(c);
          }
          return nokClose(c);
        };
      }

      function beforeMultiLine(code: number | null) {
        return effects.attempt(
          {
            partial: true,
            tokenize: tokenizeClosingLine,
          },
          finishFlow,
          contentStart,
        )(code);
      }

      function contentStart(code: number | null) {
        if (initialSize > 0) {
          let skipped = 0;
          const skipIndent: TokenizerState = (c: number | null) => {
            if (skipped < initialSize && c === 32) {
              skipped++;
              effects.enter('linePrefix');
              effects.consume(c);
              effects.exit('linePrefix');
              return skipIndent;
            }
            return beforeContentChunk(c);
          };
          return skipIndent(code);
        }
        return beforeContentChunk(code);
      }

      function beforeContentChunk(code: number | null): TokenizerState | void {
        if (code === null) return nok(code);
        if (isLineEnding(code)) {
          return effects.attempt(nonLazyContinuation, beforeMultiLine, nok)(code);
        }
        effects.enter('mathFlowValue');
        return contentChunk(code);
      }

      function contentChunk(code: number | null): TokenizerState | void {
        if (code === null || isLineEnding(code)) {
          effects.exit('mathFlowValue');
          return beforeContentChunk(code);
        }
        effects.consume(code);
        return contentChunk;
      }

      function finishFlow(code: number | null) {
        effects.exit('mathFlow');
        return ok(code);
      }

      function tokenizeClosingLine(
        eff: MicromarkEffects,
        okClose: MicromarkCallback,
        nokClose: MicromarkCallback,
      ): TokenizerState {
        let indent = 0;
        const maxIndent = self.parser.constructs.disable.null.includes('codeIndented') ? Infinity : 3;
        return leadSpace;

        function leadSpace(c: number | null): TokenizerState | void {
          if (c === 32 && indent < maxIndent) {
            indent++;
            eff.enter('linePrefix');
            eff.consume(c);
            eff.exit('linePrefix');
            return leadSpace;
          }
          if (c !== 92) return nokClose(c);
          eff.enter('mathFlowFence');
          eff.enter('mathFlowFenceSequence');
          eff.consume(c);
          return closeBracket;
        }

        function closeBracket(c: number | null): TokenizerState | void {
          if (c !== 93) return nokClose(c);
          eff.consume(c);
          eff.exit('mathFlowFenceSequence');
          return skipTrailingSpaces(eff, okClose, nokClose);
        }
      }
    },
  };
}

function latexDisplayFromMarkdown() {
  return {
    enter: {
      latexDisplayText(this: MdastCompileContext, token: MicromarkToken) {
        this.enter(
          {
            type: 'inlineMath',
            value: '',
            data: { latexDisplay: true },
          },
          token,
        );
        this.buffer();
      },
    },
    exit: {
      latexDisplayText(this: MdastCompileContext, token: MicromarkToken) {
        const data = this.resume();
        const node = this.stack[this.stack.length - 1];
        this.exit(token);
        node.value = data;
      },
    },
  };
}

function remarkLatexExtensions(this: Processor) {
  (remarkMath as (this: Processor) => void).call(this);
  const data = this.data() as RemarkDataContainer;
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const ext = micromarkExtensions[micromarkExtensions.length - 1];
  if (ext?.text) {
    ext.text[36] = currencySafeDollarMathText;
  }
  micromarkExtensions.push({
    flow: { 92: createLatexBracketFlow() },
    text: { 92: createLatexBracketText() },
  });
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  fromMarkdownExtensions.push(latexDisplayFromMarkdown());
}

function isFencedCodeClosed(
  source: string,
  node: NodeLike,
  isStreaming: boolean,
): boolean {
  if (!isStreaming) return true;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return true;
  if (end < source.length) return true;

  const slice = source.slice(start, end).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = slice.split('\n');
  if (lines.length === 0) return true;

  const firstLine = lines[0].replace(/^(?:[ \t]*>[ \t]*)+/, '').trimStart();
  const openMatch = /^(`{3,}|~{3,})/.exec(firstLine);
  if (!openMatch) return true; // Indented code block

  if (lines.length === 1) return false;
  const fenceChar = openMatch[1][0];
  const fenceLen = openMatch[1].length;
  const lastLine = lines[lines.length - 1].replace(/^(?:[ \t]*>[ \t]*)+/, '').trim();
  const closeRe = new RegExp(`^\\${fenceChar}{${fenceLen},}$`);
  return closeRe.test(lastLine);
}

export function buildRemarkPlugins({
  source,
  isStreaming,
  collapsePrefix,
  mathRenderEnabled,
}: {
  source: string;
  isStreaming: boolean;
  collapsePrefix: string;
  mathRenderEnabled: boolean;
}): PluggableList {
  const remarkCodeAndMath = () => (tree: NodeLike) => {
    let codeSeq = 0;
    walkAst(tree, (node) => {
      if (node.type === 'code') {
        const closed = isFencedCodeClosed(source, node, isStreaming);
        const startOffset = node.position?.start?.offset ?? codeSeq++;
        const lang = (node.lang ?? '').trim().toLowerCase();
        node.data = {
          ...(node.data ?? {}),
          hProperties: {
            ...((node.data?.hProperties as Record<string, unknown> | undefined) ?? {}),
            'data-code-block': 'true',
            'data-lang': lang,
            'data-closed': closed ? 'true' : 'false',
            'data-collapse-key': `${collapsePrefix}:code:${startOffset}`,
            'data-code-raw': node.value ?? '',
          },
        };
        return;
      }

      if (node.type === 'math' || node.type === 'inlineMath') {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        const raw =
          start !== undefined && end !== undefined
            ? source.slice(start, end)
            : (node.value ?? '');
        const isBlock = node.type === 'math';
        const isInlineDisplay = Boolean(node.data?.latexDisplay);

        if (!mathRenderEnabled) {
          node.data = {
            hName: 'span',
            hProperties: { className: ['math-raw'] },
            hChildren: [{ type: 'text', value: raw }],
          };
          return;
        }

        node.data = {
          hName: isBlock ? 'div' : 'span',
          hProperties: {
            'data-math-node': isBlock ? 'block' : isInlineDisplay ? 'inline-display' : 'inline',
            'data-math-latex': node.value ?? '',
            'data-math-raw': raw,
          },
          hChildren: [],
        };
      }
    });
  };

  return [
    remarkCjkFriendly,
    remarkLatexExtensions,
    remarkCodeAndMath,
  ];
}
