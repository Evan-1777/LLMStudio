import { useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../app/AppProvider';
import { Icon, Modal } from '../components/ui';
import type { ContentBlock, WebSearchExtra } from '../core/types';
import { CodeBlock } from './CodeBlock';
import { CollapsibleBlock } from './CollapsibleBlock';
import { HtmlPreview } from './HtmlPreview';
import { parseAssistantContent, shouldAutoCollapseText } from './segments';
import './rendering.css';

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

function MarkdownProse({ markdown }: { markdown: string }) {
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
}

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

export function ContentRenderer({
  messageId,
  blocks,
  isStreaming = false,
  isUser = false,
}: {
  messageId: string;
  blocks: ContentBlock[];
  isStreaming?: boolean;
  isUser?: boolean;
}) {
  const { settings } = useApp();
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);

  const imageBlocks = useMemo(
    () =>
      blocks.filter(
        (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
      ),
    [blocks],
  );

  const otherNodes: ReactNode[] = [];

  blocks.forEach((block, blockIndex) => {
    const baseKey = `${messageId}:${blockIndex}`;

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
        } else {
          otherNodes.push(
            <HtmlPreview
              key={segKey}
              html={seg.html}
              isClosed={seg.isClosed}
              collapseKey={segKey}
              title="HTML"
            />,
          );
        }
      });
      return;
    }

    if (block.type === 'thinking') {
      const thinking =
        typeof block.thinking === 'string' ? block.thinking : '';
      const defaultCollapsed = shouldAutoCollapseText(thinking, settings);
      otherNodes.push(
        <CollapsibleBlock
          key={`${baseKey}:0`}
          collapseKey={`${baseKey}:0`}
          title="思考过程"
          icon="lightbulb"
          subtle
          defaultCollapsed={defaultCollapsed}
        >
          <div className="thinking-body">{thinking}</div>
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

    if (block.type === 'toolCall') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      otherNodes.push(
        <CollapsibleBlock
          key={`${baseKey}:0`}
          collapseKey={`${baseKey}:0`}
          title={`工具调用 · ${name}`}
          icon="wrench"
          subtle
          defaultCollapsed
        >
          <pre className="code-pre">
            <code>{formatJsonValue(block.arguments)}</code>
          </pre>
        </CollapsibleBlock>,
      );
      return;
    }

    if (block.type === 'toolResult') {
      const name =
        typeof block.toolName === 'string' && block.toolName
          ? block.toolName
          : 'toolResult';
      const content = typeof block.content === 'string' ? block.content : '';
      otherNodes.push(
        <CollapsibleBlock
          key={`${baseKey}:0`}
          collapseKey={`${baseKey}:0`}
          title={block.isError ? `工具错误 · ${name}` : `工具结果 · ${name}`}
          icon={block.isError ? 'warning' : 'wrench'}
          subtle
          defaultCollapsed={!block.isError}
        >
          <pre
            className="code-pre"
            style={block.isError ? { color: 'var(--danger)' } : undefined}
          >
            <code>{content}</code>
          </pre>
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
}
