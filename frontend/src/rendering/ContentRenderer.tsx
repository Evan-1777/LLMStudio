import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../app/AppProvider';
import { Icon, IconButton, Modal } from '../components/ui';
import type { ContentBlock, ToolCallBlock, ToolResultBlock, WebSearchExtra } from '../core/types';
import { CodeBlock } from './CodeBlock';
import { CollapsibleBlock } from './CollapsibleBlock';
import { SandboxedIframe } from './HtmlPreview';
import { parseAssistantContent, shouldAutoCollapseText } from './segments';
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

const MarkdownProse = memo(function MarkdownProse({ markdown }: { markdown: string }) {
  return (
    <div className="prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => sanitizeLinkUrl(url) ?? ''}
        components={{
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
        {markdown}
      </Markdown>
    </div>
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

interface PairedToolCallEntry {
  key: string;
  call?: ToolCallBlock;
  result?: ToolResultBlock;
}

interface ToolExecutionRound {
  roundNumber: number;
  entries: PairedToolCallEntry[];
}

function parseToolResultExtra(extra: unknown): ToolResultExtraPayload {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  return extra as ToolResultExtraPayload;
}

function buildToolExecutionTrace(blocks: ContentBlock[]): {
  firstToolIndex: number;
  rounds: ToolExecutionRound[];
  callCount: number;
  doneCount: number;
  errorCount: number;
} {
  let firstToolIndex = -1;
  const resultByCallId = new Map<string, { idx: number; block: ToolResultBlock }>();
  blocks.forEach((b, idx) => {
    if (b.type === 'toolCall' || b.type === 'toolResult') {
      if (firstToolIndex < 0) firstToolIndex = idx;
    }
    if (b.type === 'toolResult') {
      const tr = b as ToolResultBlock;
      if (tr.toolCallId) {
        resultByCallId.set(tr.toolCallId, { idx, block: tr });
      }
    }
  });

  if (firstToolIndex < 0) {
    return { firstToolIndex: -1, rounds: [], callCount: 0, doneCount: 0, errorCount: 0 };
  }

  const matchedResultIndexes = new Set<number>();
  const rounds: ToolExecutionRound[] = [];
  let currentEntries: PairedToolCallEntry[] = [];
  let sawResultSinceCall = false;

  blocks.forEach((b, idx) => {
    if (b.type === 'toolCall') {
      if (sawResultSinceCall && currentEntries.length > 0) {
        rounds.push({ roundNumber: rounds.length + 1, entries: currentEntries });
        currentEntries = [];
        sawResultSinceCall = false;
      }
      const call = b as ToolCallBlock;
      const match = call.id ? resultByCallId.get(call.id) : undefined;
      if (match) matchedResultIndexes.add(match.idx);
      currentEntries.push({
        key: `${idx}:${call.id || call.name}`,
        call,
        result: match?.block,
      });
    } else if (b.type === 'toolResult') {
      if (currentEntries.length > 0) {
        sawResultSinceCall = true;
      }
    }
  });

  if (currentEntries.length > 0) {
    rounds.push({ roundNumber: rounds.length + 1, entries: currentEntries });
  }

  // Keep any standalone or unmatched toolResult blocks visible inside the same trace card.
  const orphanEntries: PairedToolCallEntry[] = [];
  blocks.forEach((b, idx) => {
    if (b.type === 'toolResult' && !matchedResultIndexes.has(idx)) {
      const tr = b as ToolResultBlock;
      orphanEntries.push({
        key: `orphan:${idx}:${tr.toolCallId || tr.toolName || ''}`,
        result: tr,
      });
    }
  });
  if (orphanEntries.length > 0) {
    rounds.push({ roundNumber: rounds.length + 1, entries: orphanEntries });
  }

  let callCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  for (const round of rounds) {
    for (const entry of round.entries) {
      callCount++;
      if (entry.result) {
        doneCount++;
        if (entry.result.isError) errorCount++;
      }
    }
  }
  return { firstToolIndex, rounds, callCount, doneCount, errorCount };
}

export const ContentRenderer = memo(function ContentRenderer({
  messageId,
  collapsePrefix,
  blocks,
  isStreaming = false,
  blockCompleted,
  stopReason,
  isUser = false,
}: {
  messageId: string;
  collapsePrefix?: string;
  blocks: ContentBlock[];
  isStreaming?: boolean;
  blockCompleted?: readonly boolean[];
  stopReason?: string;
  isUser?: boolean;
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

  const toolTrace = useMemo(() => buildToolExecutionTrace(blocks), [blocks]);

  const otherNodes: ReactNode[] = [];

  blocks.forEach((block, blockIndex) => {
    const baseKey = `${effectivePrefix}:${blockIndex}`;

    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (!text) return;

      if (isUser) {
        otherNodes.push(
          <div key={baseKey} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {text}
          </div>,
        );
        return;
      }

      const segments = parseAssistantContent(text, { isStreaming });
      segments.forEach((seg, segIdx) => {
        const segKey = `${baseKey}:${segIdx}`;
        if (seg.kind === 'prose') {
          otherNodes.push(
            <MarkdownProse key={segKey} markdown={seg.markdown} />,
          );
        } else if (seg.kind === 'code') {
          otherNodes.push(
            <CodeBlock
              key={segKey}
              language={seg.language}
              code={seg.code}
              isClosed={seg.isClosed}
              collapseKey={segKey}
            />,
          );
        } else if (settings.visualHtmlRender) {
          if (seg.isClosed) {
            otherNodes.push(
              <SandboxedIframe
                key={segKey}
                html={seg.html}
                seamless
                minHeight={24}
              />,
            );
          } else {
            otherNodes.push(
              <pre key={segKey} className="code-pre code-pre--streaming">
                <code>{seg.html}</code>
              </pre>,
            );
          }
        } else {
          otherNodes.push(
            <RawHtmlCodeCard
              key={segKey}
              html={seg.html}
              isClosed={seg.isClosed}
              collapseKey={segKey}
            />,
          );
        }
      });
      return;
    }

    if (block.type === 'thinking') {
      const thinking =
        typeof block.thinking === 'string' ? block.thinking : '';
      const isBlockStreaming =
        isStreaming && blockCompleted?.[blockIndex] !== true;
      const keepOpenForIncomplete =
        stopReason === 'aborted' || stopReason === 'error';
      const defaultCollapsed =
        isBlockStreaming || keepOpenForIncomplete
          ? false
          : settings.autoCollapseThinkingOnComplete;
      otherNodes.push(
        <CollapsibleBlock
          key={`${baseKey}:0`}
          collapseKey={`${baseKey}:0`}
          title={isBlockStreaming ? '思考过程 · 输出中' : '思考过程'}
          icon="lightbulb"
          subtle
          defaultCollapsed={defaultCollapsed}
        >
          <ThinkingScrollBody
            thinking={thinking}
            isStreaming={isBlockStreaming}
          />
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

      otherNodes.push(
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
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                {ws.error}
              </div>
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
                        <span className="search-source-item__snippet">
                          {item.snippet}
                        </span>
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
      if (blockIndex !== toolTrace.firstToolIndex) {
        return;
      }
      const { rounds, callCount, doneCount, errorCount } = toolTrace;
      const hasIncompleteCalls = Boolean(isStreaming && doneCount < callCount);
      const keepOpenForIncomplete =
        stopReason === 'error' || stopReason === 'aborted';
      const defaultCollapsed =
        Boolean(isStreaming) ||
        errorCount > 0 ||
        keepOpenForIncomplete
          ? false
          : settings.autoCollapseToolsOnComplete;

      const statusParts: string[] = [];
      if (hasIncompleteCalls) {
        statusParts.push(`执行中 (${doneCount}/${callCount})`);
      } else if (isStreaming) {
        statusParts.push(`${rounds.length} 轮 · ${callCount} 次 · 处理中`);
      } else {
        statusParts.push(`${rounds.length} 轮 · ${callCount} 次`);
        if (errorCount > 0) {
          statusParts.push(`${errorCount} 个失败`);
        }
      }
      const traceTitle = `工具调用 · ${statusParts.join(' · ')}`;

      otherNodes.push(
        <CollapsibleBlock
          key={`${effectivePrefix}:tools`}
          collapseKey={`${effectivePrefix}:tools`}
          title={traceTitle}
          icon={errorCount > 0 ? 'warning' : 'wrench'}
          subtle
          defaultCollapsed={defaultCollapsed}
        >
          <div className="tool-trace-body" tabIndex={0} aria-label="工具调用详情">
            {rounds.map((round) => (
              <div key={round.roundNumber} className="tool-trace-round">
                {rounds.length > 1 ? (
                  <div className="tool-trace-round__label">第 {round.roundNumber} 轮</div>
                ) : null}
                {round.entries.map((entry) => {
                  const toolName =
                    entry.call?.name || entry.result?.toolName || 'tool';
                  const isErr = Boolean(entry.result?.isError);
                  const entryState = entry.result
                    ? isErr
                      ? 'error'
                      : 'success'
                    : isStreaming
                      ? 'running'
                      : 'pending';
                  const statusLabel =
                    entryState === 'running'
                      ? '运行中'
                      : entryState === 'success'
                        ? '完成'
                        : entryState === 'error'
                          ? '失败'
                          : '未完成';
                  const extra = entry.result
                    ? parseToolResultExtra(entry.result.extra)
                    : {};
                  const mcpItems = Array.isArray(extra.content)
                    ? extra.content
                    : [];
                  const hasStructured = extra.structuredContent !== undefined;

                  return (
                    <div
                      key={entry.key}
                      className={`tool-trace-entry ${isErr ? 'tool-trace-entry--error' : ''}`.trim()}
                    >
                      <div className="tool-trace-entry__head">
                        <span className="tool-trace-entry__name">{toolName}</span>
                        <span
                          className={`tool-trace-entry__status tool-trace-entry__status--${entryState}`}
                        >
                          {statusLabel}
                        </span>
                      </div>

                      {entry.call ? (
                        <>
                          <span className="tool-trace-section-label">调用参数</span>
                          <pre className="tool-trace-pre">
                            <code>{formatJsonValue(entry.call.arguments ?? {})}</code>
                          </pre>
                        </>
                      ) : null}

                      {entry.result ? (
                        <>
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
                                    onClick={() => setZoomedSrc(src)}
                                  />
                                ) : null;
                              }
                              if (item.type === 'resource' && item.resource) {
                                return (
                                  <div
                                    key={`mcp-res-${itemIdx}`}
                                    className="tool-trace-resource"
                                  >
                                    <div className="tool-trace-resource__meta">
                                      嵌入资源：{item.resource.uri || '(未命名)'}
                                      {item.resource.mimeType
                                        ? ` (${item.resource.mimeType})`
                                        : ''}
                                    </div>
                                    {item.resource.text !== undefined ? (
                                      <pre className="tool-trace-pre">
                                        <code>{item.resource.text}</code>
                                      </pre>
                                    ) : item.resource.blob ? (
                                      <span className="tool-trace-resource__meta">
                                        [二进制资源]
                                      </span>
                                    ) : null}
                                  </div>
                                );
                              }
                              if (item.type === 'resource_link') {
                                const safe = sanitizeLinkUrl(item.uri);
                                return (
                                  <div
                                    key={`mcp-link-${itemIdx}`}
                                    className="tool-trace-resource"
                                  >
                                    <div className="tool-trace-resource__meta">
                                      资源链接：{item.name || item.uri}
                                      {item.mimeType ? ` (${item.mimeType})` : ''}
                                    </div>
                                    {safe ? (
                                      <a
                                        href={safe}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
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
                            <pre
                              className={`tool-trace-pre ${isErr ? 'tool-trace-pre--error' : ''}`.trim()}
                            >
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
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </CollapsibleBlock>,
      );
      return;
    }

    const ext = block as { type?: string; extra?: unknown };
    otherNodes.push(
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
  });

  return (
    <div className="content-stack">
      {imageBlocks.length > 0 ? (
        <div className="msg-image-grid">
          {imageBlocks.map((img, idx) => {
            const safeExternal = sanitizeLinkUrl(img.url);
            const src =
              img.data && img.mimeType
                ? `data:${img.mimeType};base64,${img.data}`
                : safeExternal;
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

      {otherNodes}

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
