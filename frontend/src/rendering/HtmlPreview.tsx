import { useEffect, useMemo, useRef, useState } from 'react';
import { IconButton, Modal } from '../components/ui';
import { useApp } from '../app/AppProvider';
import { CollapsibleBlock } from './CollapsibleBlock';
import { shouldAutoCollapseText } from './segments';

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Reports the intrinsic height of the document content, never the iframe viewport:
// measuring documentElement.scrollHeight returns at least the current frame height,
// so a shortened document could never shrink. Body margins and padding are added
// back explicitly, and viewport-sized bodies fall back to their content extent.
const HEIGHT_BRIDGE = (safeNonce: string) => `
<script>
(function() {
  var nonce = ${safeNonce};
  var last = -1;
  var frame = 0;

  function px(style, prop) {
    var value = parseFloat(style[prop]);
    return isFinite(value) ? value : 0;
  }

  function contentHeight() {
    var body = document.body;
    if (!body || !body.getBoundingClientRect) return 0;
    var rect = body.getBoundingClientRect();
    var bodyStyle = getComputedStyle(body);
    var bottom = 0;
    var hasChild = false;
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      var childStyle = getComputedStyle(child);
      if (childStyle.display === "none" || childStyle.position === "fixed") continue;
      var childRect = child.getBoundingClientRect();
      var edge = childRect.bottom + px(childStyle, "marginBottom") - rect.top;
      if (edge > bottom) bottom = edge;
      hasChild = true;
    }
    if (!hasChild) {
      bottom = Math.max(0, body.scrollHeight - px(bodyStyle, "paddingTop"));
    }
    return Math.ceil(
      bottom +
      px(bodyStyle, "paddingBottom") +
      px(bodyStyle, "marginTop") +
      px(bodyStyle, "marginBottom")
    );
  }

  function report() {
    try {
      var height = contentHeight();
      if (!(height > 0) || Math.abs(height - last) < 1) return;
      last = height;
      window.parent.postMessage({
        type: "llmstudio-html-height",
        nonce: nonce,
        height: height
      }, "*");
    } catch (_) {}
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(function() {
      frame = 0;
      report();
    });
  }

  window.addEventListener("load", schedule);
  window.addEventListener("resize", schedule);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(schedule).observe(document.body);
  }
  schedule();
})();
</script>`;

export function buildSandboxedSrcDoc(
  rawHtml: string,
  nonce: string,
  options?: { seamless?: boolean; theme?: 'light' | 'dark'; measure?: boolean },
): string {
  const safeNonce = JSON.stringify(nonce);
  const bridgeScript = options?.measure === false ? '' : HEIGHT_BRIDGE(safeNonce);

  const lower = rawHtml.toLowerCase();
  const hasDocRoot = lower.includes('<!doctype') || lower.includes('<html');
  if (hasDocRoot) {
    const closeBody = lower.lastIndexOf('</body>');
    if (closeBody >= 0) {
      return (
        rawHtml.slice(0, closeBody) + bridgeScript + rawHtml.slice(closeBody)
      );
    }
    return `${rawHtml}\n${bridgeScript}`;
  }

  const isSeamless = Boolean(options?.seamless);
  const isDark = options?.theme === 'dark';
  const styleBlock = isSeamless
    ? `
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${isDark ? '#f5f5f7' : '#1d1d1f'};
    color-scheme: ${isDark ? 'dark' : 'light'};
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
  }`
    : `
  html, body {
    margin: 0;
    padding: 10px;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${styleBlock}
</style>
</head>
<body>
${rawHtml}
${bridgeScript}
</body>
</html>`;
}

export function SandboxedIframe({
  html,
  minHeight = 140,
  maxHeight = 680,
  fillAvailable = false,
  seamless = false,
}: {
  html: string;
  minHeight?: number;
  maxHeight?: number;
  fillAvailable?: boolean;
  seamless?: boolean;
}) {
  const { resolvedTheme } = useApp();
  const effectiveMinHeight = seamless && minHeight === 140 ? 24 : minHeight;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // A new document invalidates the previous height; theme changes keep the nonce.
  const nonce = useMemo(() => generateNonce(), [html]);
  const srcDoc = useMemo(
    () =>
      buildSandboxedSrcDoc(html, nonce, {
        seamless,
        theme: resolvedTheme,
        measure: !fillAvailable,
      }),
    [fillAvailable, html, nonce, resolvedTheme, seamless],
  );
  const [height, setHeight] = useState(effectiveMinHeight);

  useEffect(() => {
    setHeight(effectiveMinHeight);
  }, [effectiveMinHeight, html]);

  useEffect(() => {
    if (fillAvailable) return;
    const onMessage = (event: MessageEvent) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const payload = data as Record<string, unknown>;
      if (payload.type !== 'llmstudio-html-height') return;
      if (payload.nonce !== nonce) return;
      const reported = payload.height;
      if (
        typeof reported === 'number' &&
        Number.isFinite(reported) &&
        reported > 0
      ) {
        const clamped = Math.min(
          maxHeight,
          Math.max(effectiveMinHeight, Math.round(reported)),
        );
        setHeight((prev) => (Math.abs(clamped - prev) >= 1 ? clamped : prev));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [effectiveMinHeight, fillAvailable, maxHeight, nonce]);

  return (
    <div
      className={
        seamless
          ? 'html-sandbox-wrap html-sandbox-wrap--seamless'
          : 'html-sandbox-wrap'
      }
    >
      <iframe
        ref={iframeRef}
        title="HTML 预览"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className={
          seamless
            ? 'html-sandbox-frame html-sandbox-frame--seamless'
            : 'html-sandbox-frame'
        }
        style={{
          height: fillAvailable ? 'min(70dvh, 640px)' : `${height}px`,
        }}
      />
    </div>
  );
}

export function HtmlPreview({
  html,
  isClosed,
  collapseKey,
  title = 'HTML',
}: {
  html: string;
  isClosed: boolean;
  collapseKey: string;
  title?: string;
}) {
  const { settings, toast } = useApp();
  const [previewOverride, setPreviewOverride] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const canPreview = isClosed;
  const showPreview =
    canPreview && (previewOverride ?? settings.defaultHtmlPreview);

  const defaultCollapsed = shouldAutoCollapseText(html, settings);

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
    <>
      <CollapsibleBlock
        collapseKey={collapseKey}
        title={isClosed ? title : `${title} · 输出中`}
        icon={showPreview ? 'preview' : 'code'}
        defaultCollapsed={defaultCollapsed}
        actions={
          <>
            {canPreview ? (
              <IconButton
                size="sm"
                icon={showPreview ? 'code' : 'preview'}
                label={showPreview ? '查看源码' : '预览 HTML'}
                onClick={() => setPreviewOverride(!showPreview)}
              />
            ) : null}
            {canPreview ? (
              <IconButton
                size="sm"
                icon="expand"
                label="全屏预览"
                onClick={() => setFullscreen(true)}
              />
            ) : null}
            <IconButton
              size="sm"
              icon={copied ? 'check' : 'copy'}
              label="复制 HTML"
              onClick={() => void handleCopy()}
            />
          </>
        }
      >
        {showPreview ? (
          <SandboxedIframe html={html} />
        ) : (
          <pre className="code-pre">
            <code>{html}</code>
          </pre>
        )}
      </CollapsibleBlock>

      <Modal
        open={fullscreen}
        onOpenChange={setFullscreen}
        title="HTML 预览"
        wide
      >
        {canPreview ? <SandboxedIframe html={html} fillAvailable /> : null}
      </Modal>
    </>
  );
}
