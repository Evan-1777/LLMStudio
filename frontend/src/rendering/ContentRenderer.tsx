import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../app/AppProvider';
import { Icon, IconButton, Modal } from '../components/ui';
import type { ContentBlock, WebSearchExtra } from '../core/types';
import { CodeBlock } from './CodeBlock';
import { CollapsibleBlock, useCollapsibleState } from './CollapsibleBlock';
import { SandboxedIframe } from './HtmlPreview';
import { buildRemarkPlugins } from './markdownPlugins';
import { shouldAutoCollapseText, splitMarkdownAndRawHtml } from './segments';
import {
  buildPairedToolEntries,
  buildProcessTrace,
  firstNonEmptyLine,
  summarizeToolArgs,
  toolIconName,
  type PairedToolCallEntry,
} from './toolTrace';
import './rendering.css';

function RawHtmlCodeCard({
  html,
  isClosed,
  collapseKey,
}: {
  html: string;
  isClosed: boolean;
  collapseKey: string;
}) {
  const { settings, toast } = useApp();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('无法写入剪贴板', 'error');
    }
  };

  return (
    <CollapsibleBlock
      collapseKey={collapseKey}
      title={isClosed ? 'HTML' : 'HTML · 输出中'}
      icon="code"
      defaultCollapsed={shouldAutoCollapseText(html, settings)}
      actions={
        <IconButton
          size="sm"
          icon={copied ? 'check' : 'copy'}
          label="复制 HTML"
          onClick={() => void handleCopy()}
        />
      }
    >
      <pre className="code-pre">
        <code>{html}</code>
      </pre>
    </CollapsibleBlock>
  );
}

function sanitizeLinkUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:')
  ) {
    return trimmed;
  }
  return undefined;
}

export function imageBlockSource(image: Extract<ContentBlock, { type: 'image' }>): string | undefined {
  return image.data && image.mimeType
    ? `data:${image.mimeType};base64,${image.data}`
    : sanitizeLinkUrl(image.url);
}

const KatexMath = memo(function KatexMath({
  latex,
  raw,
  displayMode,
}: {
  latex: string;
  raw: string;
  displayMode: boolean;
}) {
  const renderedHtml = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        displayMode,
        output: 'htmlAndMathml',
        trust: false,
        throwOnError: true,
        strict: 'ignore',
      });
    } catch {
      return null;
    }
  }, [displayMode, latex]);

  if (renderedHtml === null) {
    return displayMode ? (
      <div className="math-raw math-raw--block">{raw}</div>
    ) : (
      <span className="math-raw">{raw}</span>
    );
  }

  if (displayMode) {
    return (
      <div
        className="math-block-scroll"
        // KaTeX runs with trust:false and throwOnError:true on parsed math tokens only.
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    );
  }

  return (
    <span
      className="math-inline"
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
});

const MarkdownProse = memo(function MarkdownProse({
  markdown,
  isStreaming = false,
  collapsePrefix = 'prose',
  defaultHtmlPreview,
}: {
  markdown: string;
  isStreaming?: boolean;
  collapsePrefix?: string;
  defaultHtmlPreview?: boolean;
}) {
  const { settings } = useApp();
  const normalized = useMemo(
    () => markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    [markdown],
  );
  const plugins = useMemo(
    () => [
      remarkGfm,
      ...buildRemarkPlugins({
        source: normalized,
        isStreaming,
        collapsePrefix,
        mathRenderEnabled: settings.mathRenderEnabled,
      }),
    ],
    [collapsePrefix, isStreaming, normalized, settings.mathRenderEnabled],
  );

  return (
    <div className="prose">
      <Markdown
        remarkPlugins={plugins}
        urlTransform={(url) => sanitizeLinkUrl(url) ?? ''}
        components={{
          pre({ children }) {
            if (
              isValidElement(children) &&
              (children.props as Record<string, unknown>)['data-code-block'] === 'true'
            ) {
              return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
          code({ className, children, ...props }) {
            const p = props as Record<string, unknown>;
            if (p['data-code-block'] === 'true') {
              return (
                <CodeBlock
                  language={String(p['data-lang'] ?? '')}
                  code={String(p['data-code-raw'] ?? '')}
                  isClosed={p['data-closed'] === 'true'}
                  collapseKey={String(p['data-collapse-key'] ?? `${collapsePrefix}:code`)}
                  defaultHtmlPreview={defaultHtmlPreview}
                />
              );
            }
            return <code className={className}>{children}</code>;
          },
          div({ className, children, ...props }) {
            const p = props as Record<string, unknown>;
            if (p['data-math-node'] === 'block') {
              return (
                <KatexMath
                  latex={String(p['data-math-latex'] ?? '')}
                  raw={String(p['data-math-raw'] ?? '')}
                  displayMode
                />
              );
            }
            return <div className={className}>{children}</div>;
          },
          span({ className, children, ...props }) {
            const p = props as Record<string, unknown>;
            const mathKind = p['data-math-node'];
            if (mathKind === 'inline' || mathKind === 'inline-display') {
              return (
                <KatexMath
                  latex={String(p['data-math-latex'] ?? '')}
                  raw={String(p['data-math-raw'] ?? '')}
                  displayMode={mathKind === 'inline-display'}
                />
              );
            }
            return <span className={className}>{children}</span>;
          },
          table({ children }) {
            return (
              <div className="prose-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            const safe = sanitizeLinkUrl(href);
            if (!safe) return <span>{children}</span>;
            const external = safe.startsWith('http://') || safe.startsWith('https://');
            return (
              <a
                href={safe}
                target={external ? '_blank' : undefined}
                rel={external ? 'noopener noreferrer' : undefined}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {normalized}
      </Markdown>
    </div>
  );
});

export const MarkdownDocument = memo(function MarkdownDocument({
  content,
  collapsePrefix,
  isStreaming = false,
  visualHtmlRender,
  defaultHtmlPreview,
}: {
  content: string;
  collapsePrefix: string;
  isStreaming?: boolean;
  visualHtmlRender?: boolean;
  defaultHtmlPreview?: boolean;
}) {
  const { settings } = useApp();
  const enableVisualHtml = visualHtmlRender ?? settings.visualHtmlRender;
  const segs = splitMarkdownAndRawHtml(content, { isStreaming });

  return (
    <>
      {segs.map((seg, segIndex) => {
        const segKey = `${collapsePrefix}:${segIndex}`;
        if (seg.kind === 'prose') {
          return (
            <MarkdownProse
              key={segKey}
              markdown={seg.markdown}
              isStreaming={isStreaming}
              collapsePrefix={segKey}
              defaultHtmlPreview={defaultHtmlPreview}
            />
          );
        }
        if (seg.kind === 'code') {
          return (
            <CodeBlock
              key={segKey}
              language={seg.language}
              code={seg.code}
              isClosed={seg.isClosed}
              collapseKey={segKey}
              defaultHtmlPreview={defaultHtmlPreview}
            />
          );
        }
        if (enableVisualHtml) {
          if (seg.isClosed) {
            return (
              <SandboxedIframe
                key={segKey}
                html={seg.html}
                seamless
                minHeight={24}
              />
            );
          }
          return (
            <pre key={segKey} className="code-pre code-pre--streaming">
              <code>{seg.html}</code>
            </pre>
          );
        }
        return (
          <RawHtmlCodeCard
            key={segKey}
            html={seg.html}
            isClosed={seg.isClosed}
            collapseKey={segKey}
          />
        );
      })}
    </>
  );
});

function parseWebSearchExtra(extra: unknown): WebSearchExtra {
  if (!extra) return {};
  if (typeof extra === 'string') {
    try {
      const parsed: unknown = JSON.parse(extra);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as WebSearchExtra;
      }
    } catch {
      return {};
    }
  }
  if (typeof extra === 'object' && !Array.isArray(extra)) {
    return extra as WebSearchExtra;
  }
  return {};
}

function formatJsonValue(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ThinkingScrollBody = memo(function ThinkingScrollBody({
  thinking,
  isStreaming,
}: {
  thinking: string;
  isStreaming: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const programmaticTopRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevLengthRef = useRef(0);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const applied = programmaticTopRef.current;
    if (applied !== null && Math.abs(el.scrollTop - applied) <= 2) {
      programmaticTopRef.current = null;
      stickToBottomRef.current = true;
      return;
    }
    programmaticTopRef.current = null;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 24;
  };

  useEffect(() => {
    const grew = thinking.length > prevLengthRef.current;
    prevLengthRef.current = thinking.length;
    if (!isStreaming || !grew || !stickToBottomRef.current) return;
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (!el || !stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
      programmaticTopRef.current = el.scrollTop;
    });
  }, [thinking, isStreaming]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="thinking-body"
      tabIndex={0}
      role="region"
      aria-label="思考过程内容"
      onScroll={handleScroll}
    >
      {thinking}
    </div>
  );
});

interface MCPContentItemRender {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  description?: string;
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

interface ToolResultExtraPayload {
  content?: MCPContentItemRender[];
  structuredContent?: unknown;
}

function parseToolResultExtra(extra: unknown): ToolResultExtraPayload {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  return extra as ToolResultExtraPayload;
}

function ToolStepDisclosure({
  entry,
  collapseKey,
  isEnded,
  isStreaming,
  inTrace,
  autoCollapseTools,
  onZoomImage,
}: {
  entry: PairedToolCallEntry;
  collapseKey: string;
  isEnded: boolean;
  isStreaming: boolean;
  inTrace: boolean;
  autoCollapseTools: boolean;
  onZoomImage: (src: string) => void;
}) {
  const toolName = entry.call?.name || entry.result?.toolName || 'tool';
  const source = entry.call?.toolSource ?? entry.result?.toolSource;
  const sourceLabel = source === 'native' ? '原生' : source === 'mcp' ? 'MCP' : null;
  const argSummary = entry.call ? summarizeToolArgs(toolName, entry.call.arguments) : '';
  const isErr = Boolean(entry.result?.isError);
  const entryState = isEnded
    ? isErr ? 'error' : 'success'
    : isStreaming ? 'running' : 'pending';
  const statusLabel = {
    running: '运行中',
    success: '完成',
    error: '失败',
    pending: '未完成',
  }[entryState];

  const defaultCollapsed = inTrace ? true : isEnded && autoCollapseTools;
  const completion = inTrace
    ? undefined
    : isEnded
      ? autoCollapseTools ? 'collapse' : 'keep'
      : isStreaming ? 'pending' : 'keep';

  const { collapsed, toggle, containerRef, triggerRef } = useCollapsibleState({
    collapseKey,
    defaultCollapsed,
    completion,
  });

  const extra = entry.result ? parseToolResultExtra(entry.result.extra) : {};
  const mcpItems = Array.isArray(extra.content) ? extra.content : [];
  const hasStructured = extra.structuredContent !== undefined;

  return (
    <div
      ref={containerRef}
      className={`tool-step ${inTrace ? 'tool-step--inline' : 'tool-step--standalone'} ${isErr ? 'tool-step--error' : ''}`.trim()}
      data-state={collapsed ? 'closed' : 'open'}
    >
      <button
        type="button"
        ref={triggerRef}
        className="tool-step__summary"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <Icon name="chevronRight" size={14} className="tool-step__chevron" />
        <Icon name={toolIconName(toolName)} size={14} className="tool-step__icon" />
        <span className="tool-step__name">{toolName}</span>
        {argSummary ? (
          <span className="tool-step__arg" title={argSummary}>
            {argSummary}
          </span>
        ) : null}
        {sourceLabel ? <span className="tool-step__source">{sourceLabel}</span> : null}
        <span
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
          className={`tool-step__status tool-step__status--${entryState}`}
        >
          {entryState === 'running' ? (
            <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
          ) : entryState === 'success' ? (
            <Icon name="check" size={12} />
          ) : entryState === 'error' ? (
            <Icon name="warning" size={12} />
          ) : (
            <Icon name="minus" size={12} />
          )}
        </span>
      </button>

      {!collapsed ? (
        <div className="tool-step__body" tabIndex={0} aria-label={`${toolName} 详情`}>
          {entry.call ? (
            <div className="tool-step__section">
              <span className="tool-trace-section-label">调用参数</span>
              <pre className="tool-trace-pre">
                <code>{formatJsonValue(entry.call.arguments ?? {})}</code>
              </pre>
            </div>
          ) : null}

          {entry.result ? (
            <div className="tool-step__section">
              <span className="tool-trace-section-label">
                {isErr ? '错误结果' : '返回结果'}
              </span>
              {mcpItems.length > 0 ? (
                mcpItems.map((item, itemIdx) => {
                  if (item.type === 'image') {
                    const src =
                      item.data && item.mimeType
                        ? `data:${item.mimeType};base64,${item.data}`
                        : item.data
                          ? `data:image/png;base64,${item.data}`
                          : sanitizeLinkUrl(item.uri);
                    return src ? (
                      <img
                        key={`mcp-img-${itemIdx}`}
                        src={src}
                        alt={toolName}
                        className="msg-image-thumb"
                        onClick={() => onZoomImage(src)}
                      />
                    ) : null;
                  }
                  if (item.type === 'resource' && item.resource) {
                    return (
                      <div key={`mcp-res-${itemIdx}`} className="tool-trace-resource">
                        <div className="tool-trace-resource__meta">
                          嵌入资源：{item.resource.uri || '(未命名)'}
                          {item.resource.mimeType ? ` (${item.resource.mimeType})` : ''}
                        </div>
                        {item.resource.text !== undefined ? (
                          <pre className="tool-trace-pre">
                            <code>{item.resource.text}</code>
                          </pre>
                        ) : item.resource.blob ? (
                          <span className="tool-trace-resource__meta">[二进制资源]</span>
                        ) : null}
                      </div>
                    );
                  }
                  if (item.type === 'resource_link') {
                    const safe = sanitizeLinkUrl(item.uri);
                    return (
                      <div key={`mcp-link-${itemIdx}`} className="tool-trace-resource">
                        <div className="tool-trace-resource__meta">
                          资源链接：{item.name || item.uri}
                          {item.mimeType ? ` (${item.mimeType})` : ''}
                        </div>
                        {safe ? (
                          <a href={safe} target="_blank" rel="noopener noreferrer">
                            {safe}
                          </a>
                        ) : item.uri ? (
                          <pre className="tool-trace-pre">
                            <code>{item.uri}</code>
                          </pre>
                        ) : null}
                      </div>
                    );
                  }
                  return (
                    <pre
                      key={`mcp-txt-${itemIdx}`}
                      className={`tool-trace-pre ${isErr ? 'tool-trace-pre--error' : ''}`.trim()}
                    >
                      <code>
                        {item.text ??
                          (item.type === 'audio'
                            ? `[音频 ${item.mimeType ?? ''}]`
                            : formatJsonValue(item))}
                      </code>
                    </pre>
                  );
                })
              ) : (
                <pre className={`tool-trace-pre ${isErr ? 'tool-trace-pre--error' : ''}`.trim()}>
                  <code>{entry.result.content ?? ''}</code>
                </pre>
              )}

              {hasStructured ? (
                <>
                  <span className="tool-trace-section-label">结构化数据</span>
                  <pre className="tool-trace-pre">
                    <code>{formatJsonValue(extra.structuredContent)}</code>
                  </pre>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const ContentRenderer = memo(function ContentRenderer({
  messageId,
  collapsePrefix,
  blocks,
  isStreaming = false,
  blockCompleted,
  stopReason,
  isUser = false,
  visualHtmlRender,
}: {
  messageId: string;
  collapsePrefix?: string;
  blocks: ContentBlock[];
  isStreaming?: boolean;
  blockCompleted?: readonly boolean[];
  stopReason?: string;
  isUser?: boolean;
  visualHtmlRender?: boolean;
}) {
  const { settings } = useApp();
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  const effectivePrefix = collapsePrefix ?? messageId;

  const imageBlocks = useMemo(
    () =>
      blocks.filter(
        (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
      ),
    [blocks],
  );

  const paired = useMemo(() => buildPairedToolEntries(blocks), [blocks]);
  const trace = useMemo(() => buildProcessTrace(blocks, paired), [blocks, paired]);
  const ended = (entry: PairedToolCallEntry) =>
    entry.resultIndex !== undefined && (!isStreaming || blockCompleted?.[entry.resultIndex] === true);

  const renderBlock = (block: ContentBlock, blockIndex: number, nodes: ReactNode[], inTrace = false) => {
    if (paired.pairedResultIndexes.has(blockIndex)) return;
    const baseKey = `${effectivePrefix}:${blockIndex}`;

    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (!text) return;

      if (isUser) {
        nodes.push(
          <div key={baseKey} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {text}
          </div>,
        );
        return;
      }

      if (inTrace) {
        nodes.push(
          <MarkdownProse
            key={baseKey}
            markdown={text}
            isStreaming={isStreaming}
            collapsePrefix={baseKey}
          />,
        );
        return;
      }

      nodes.push(
        <MarkdownDocument
          key={baseKey}
          content={text}
          collapsePrefix={baseKey}
          isStreaming={isStreaming}
          visualHtmlRender={visualHtmlRender ?? settings.visualHtmlRender}
        />,
      );
      return;
    }

    if (block.type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      const isBlockStreaming = isStreaming && blockCompleted?.[blockIndex] !== true;
      const interrupted = !isStreaming && stopReason === 'aborted' && blockIndex === blocks.length - 1;
      const defaultCollapsed = !isBlockStreaming && !interrupted && settings.autoCollapseThinkingOnComplete;
      const preview = !isBlockStreaming && inTrace ? firstNonEmptyLine(thinking, 64) : '';
      const title = isBlockStreaming
        ? inTrace ? '思考中…' : '思考过程 · 输出中'
        : preview ? `思考过程 · ${preview}` : '思考过程';
      nodes.push(
        <CollapsibleBlock
          key={`${baseKey}:0`}
          collapseKey={`${baseKey}:0`}
          title={title}
          icon="lightbulb"
          subtle
          defaultCollapsed={defaultCollapsed}
          completion={isBlockStreaming ? 'pending' : defaultCollapsed ? 'collapse' : 'keep'}
        >
          <ThinkingScrollBody thinking={thinking} isStreaming={isBlockStreaming} />
        </CollapsibleBlock>,
      );
      return;
    }

    if (block.type === 'image') {
      return;
    }

    if (block.type === 'webSearch') {
      const ws = parseWebSearchExtra(block.extra);
      const count = Array.isArray(ws.results) ? ws.results.length : 0;
      const title = ws.error
        ? `联网搜索 · 失败${ws.query ? ` (${ws.query})` : ''}`
        : `联网搜索${ws.query ? ` · ${ws.query}` : ''}${count > 0 ? ` (${count})` : ''}`;

      nodes.push(
        <CollapsibleBlock
          key={`${baseKey}:0`}
          collapseKey={`${baseKey}:0`}
          title={title}
          icon="globe"
          subtle
          defaultCollapsed={!ws.error}
        >
          <div className="search-sources">
            {ws.error ? (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>{ws.error}</div>
            ) : null}
            {Array.isArray(ws.results) && ws.results.length > 0
              ? ws.results.map((item, idx) => {
                  const safeUrl = sanitizeLinkUrl(item.url);
                  return (
                    <div key={`${item.url}-${idx}`} className="search-source-item">
                      {safeUrl ? (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="search-source-item__title"
                        >
                          {item.title || safeUrl}
                        </a>
                      ) : (
                        <span className="search-source-item__title">
                          {item.title || item.url}
                        </span>
                      )}
                      {item.snippet ? (
                        <span className="search-source-item__snippet">{item.snippet}</span>
                      ) : null}
                    </div>
                  );
                })
              : !ws.error && (
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    无搜索结果
                  </span>
                )}
          </div>
        </CollapsibleBlock>,
      );
      return;
    }

    if (block.type === 'toolCall' || block.type === 'toolResult') {
      const entry = paired.entries.get(blockIndex);
      if (!entry) return;
      const stepKey = `${effectivePrefix}:tool:${entry.index}`;
      nodes.push(
        <ToolStepDisclosure
          key={stepKey}
          collapseKey={stepKey}
          entry={entry}
          isEnded={ended(entry)}
          isStreaming={isStreaming}
          inTrace={inTrace}
          autoCollapseTools={settings.autoCollapseToolsOnComplete}
          onZoomImage={setZoomedSrc}
        />,
      );
      return;
    }

    const ext = block as { type?: string; extra?: unknown };
    nodes.push(
      <CollapsibleBlock
        key={`${baseKey}:0`}
        collapseKey={`${baseKey}:0`}
        title={ext.type || 'extension'}
        icon="plugin"
        subtle
        defaultCollapsed
      >
        <pre className="code-pre">
          <code>{formatJsonValue(ext.extra ?? block)}</code>
        </pre>
      </CollapsibleBlock>,
    );
  };

  const nodes: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index++) {
    if (trace?.start !== index) {
      renderBlock(blocks[index], index, nodes);
      continue;
    }

    const steps: ReactNode[] = [];
    const traceEntries: PairedToolCallEntry[] = [];
    let thinking = false;
    for (let step = trace.start; step <= trace.end; step++) {
      const block = blocks[step];
      const entry = paired.entries.get(step);
      if (entry) traceEntries.push(entry);
      const stepNodes: ReactNode[] = [];
      renderBlock(block, step, stepNodes, true);
      if (stepNodes.length) {
        steps.push(
          <li className="trace-step" key={step}>
            {stepNodes}
          </li>,
        );
      }
      thinking ||= block.type === 'thinking' && isStreaming && blockCompleted?.[step] !== true;
    }

    const failed = traceEntries.filter((entry) => ended(entry) && entry.result?.isError).length;
    const activeEntry = traceEntries.findLast((entry) => !ended(entry));
    const interruptedThinking = stopReason === 'aborted' && blocks.at(-1)?.type === 'thinking';
    const label = trace.thinkingCount ? '思考与工具' : '工具调用';
    let title: string;
    if (isStreaming) {
      if (activeEntry) {
        const activeName = activeEntry.call?.name || activeEntry.result?.toolName || 'tool';
        const activeArg = activeEntry.call
          ? summarizeToolArgs(activeName, activeEntry.call.arguments, 48)
          : '';
        title = activeArg
          ? `正在执行 · ${activeName} (${activeArg})`
          : `正在执行 · ${activeName}`;
      } else if (thinking) {
        title = '思考中…';
      } else {
        title = `${label} · 生成中…`;
      }
    } else {
      const suffix = failed
        ? `${failed} 个失败`
        : activeEntry || interruptedThinking
          ? '未完成'
          : '完成';
      title = `${label} · ${traceEntries.length} 次 · ${suffix}`;
    }

    const autoCollapse =
      settings.autoCollapseToolsOnComplete &&
      (!trace.thinkingCount || settings.autoCollapseThinkingOnComplete) &&
      !interruptedThinking &&
      (!activeEntry || stopReason === 'error');
    const completion = isStreaming ? 'pending' : autoCollapse ? 'collapse' : 'keep';
    const traceKey = `${effectivePrefix}:process-trace`;
    nodes.push(
      <CollapsibleBlock
        key={traceKey}
        collapseKey={traceKey}
        title={title}
        icon={failed ? 'warning' : trace.thinkingCount ? 'lightbulb' : 'wrench'}
        defaultCollapsed={completion === 'collapse'}
        completion={completion}
        subtle
      >
        <ol className="trace-timeline">{steps}</ol>
      </CollapsibleBlock>,
    );
    index = trace.end;
  }

  return (
    <div className="content-stack">
      {imageBlocks.length > 0 ? (
        <div className="msg-image-grid">
          {imageBlocks.map((img, idx) => {
            const src = imageBlockSource(img);
            if (!src) {
              return (
                <span key={`img-${idx}`} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  <Icon name="image" size={14} /> 图片不可用
                </span>
              );
            }
            return (
              <img
                key={`img-${idx}`}
                src={src}
                alt={`图片 ${idx + 1}`}
                className="msg-image-thumb"
                onClick={() => setZoomedSrc(src)}
              />
            );
          })}
        </div>
      ) : null}

      {nodes}

      <Modal
        open={zoomedSrc !== null}
        onOpenChange={(open) => {
          if (!open) setZoomedSrc(null);
        }}
        title="图片预览"
        wide
      >
        {zoomedSrc ? (
          <img
            src={zoomedSrc}
            alt="放大预览"
            style={{
              maxWidth: '100%',
              maxHeight: '72dvh',
              objectFit: 'contain',
              margin: '0 auto',
              display: 'block',
              borderRadius: 'var(--radius-md)',
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
});
