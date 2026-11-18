import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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

const INLINE_PREVIEW_MAX_HEIGHT = 8192;

// Shared inline responsive rules: constrain top-level containers and scalable
// media to the chat column without breaking author media queries, min-widths,
// or intentional nested horizontal scrollers.
const INLINE_RESPONSIVE_STYLE = `
  :where(html, body) {
    max-width: 100%;
    box-sizing: border-box;
  }
  body > :where(div, section, article, main, header, footer, aside, nav, form, table, pre, blockquote, figure, ul, ol, dl, p, fieldset, details, hr, h1, h2, h3, h4, h5, h6) {
    max-width: 100%;
    box-sizing: border-box;
  }
  :where(img, svg, video, canvas) {
    max-width: 100%;
    height: auto;
  }`;

// Reports the intrinsic height of the document content, never the iframe viewport:
// measuring documentElement.scrollHeight returns at least the current frame height,
// so a shortened document could never shrink. Measure body/root box extents and
// visible content overflow in unified document coordinates.
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
    var docEl = document.documentElement;
    var body = document.body;
    if (!body || !body.getBoundingClientRect) return 0;
    var scrollY = window.scrollY || window.pageYOffset || (docEl && docEl.scrollTop) || 0;
    var docStyle = docEl ? getComputedStyle(docEl) : null;
    var bodyStyle = getComputedStyle(body);
    var bodyRect = body.getBoundingClientRect();
    var bodyTop = bodyRect.top + scrollY;
    var bodyPadTop = px(bodyStyle, "paddingTop");
    var bodyPadBottom = px(bodyStyle, "paddingBottom");
    var bodyBorderTop = px(bodyStyle, "borderTopWidth");
    var bodyBorderBottom = px(bodyStyle, "borderBottomWidth");
    var bodyMarginBottom = Math.max(0, px(bodyStyle, "marginBottom"));
    var docPadBottom = docStyle ? px(docStyle, "paddingBottom") : 0;
    var docBorderBottom = docStyle ? px(docStyle, "borderBottomWidth") : 0;
    var docMarginBottom = docStyle ? Math.max(0, px(docStyle, "marginBottom")) : 0;

    var canCollapseBottom =
      bodyPadBottom === 0 &&
      bodyBorderBottom === 0 &&
      bodyStyle.overflowY === "visible" &&
      bodyStyle.display !== "flex" &&
      bodyStyle.display !== "grid" &&
      bodyStyle.display !== "flow-root";

    var flowBottom = bodyTop + bodyBorderTop + bodyPadTop;
    var absBottom = 0;
    var overflowBottom = 0;
    var hasFlowContent = false;

    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      var childStyle = getComputedStyle(child);
      if (childStyle.display === "none" || childStyle.position === "fixed") continue;
      var childRect = child.getBoundingClientRect();
      var childBoxBottom = childRect.bottom + scrollY;

      if (childStyle.position === "absolute") {
        if (childBoxBottom > absBottom) absBottom = childBoxBottom;
      } else {
        hasFlowContent = true;
        var childMb = Math.max(0, px(childStyle, "marginBottom"));
        var childEdge = canCollapseBottom && childStyle.float === "none"
          ? childBoxBottom + Math.max(childMb, bodyMarginBottom)
          : childBoxBottom + childMb;
        if (childEdge > flowBottom) flowBottom = childEdge;
      }

      if (childStyle.overflowY === "visible" && child.scrollHeight > child.clientHeight) {
        var childOverflow = childRect.top + scrollY + child.clientTop + child.scrollHeight;
        if (childOverflow > overflowBottom) overflowBottom = childOverflow;
      }
    }

    for (var j = 0; j < body.childNodes.length; j++) {
      var node = body.childNodes[j];
      if (node.nodeType === 3 && /\\S/.test(node.nodeValue || "")) {
        var range = document.createRange();
        range.selectNodeContents(node);
        var textBottom = range.getBoundingClientRect().bottom + scrollY;
        hasFlowContent = true;
        var textEdge = canCollapseBottom ? textBottom + bodyMarginBottom : textBottom;
        if (textEdge > flowBottom) flowBottom = textEdge;
      }
    }

    var bodyBoxBottom = hasFlowContent
      ? (canCollapseBottom
          ? flowBottom
          : flowBottom + bodyPadBottom + bodyBorderBottom + bodyMarginBottom)
      : bodyTop + bodyBorderTop + bodyPadTop + bodyPadBottom + bodyBorderBottom + bodyMarginBottom;

    var docBottom = bodyBoxBottom + docPadBottom + docBorderBottom + docMarginBottom;

    if (
      bodyStyle.overflowY !== "hidden" &&
      bodyStyle.overflowY !== "clip" &&
      body.scrollHeight > body.clientHeight
    ) {
      var bodyOverflow = bodyTop + body.clientTop + body.scrollHeight;
      if (bodyOverflow > overflowBottom) overflowBottom = bodyOverflow;
    }

    return Math.ceil(Math.max(docBottom, absBottom, overflowBottom));
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
    // Layout can still measure zero at load. Publish the first measurable size immediately.
    if (last < 0) { report(); return; }
    if (frame) return;
    frame = requestAnimationFrame(function() {
      frame = 0;
      report();
    });
  }

  // The first height must not depend on an animation frame.
  window.addEventListener("load", report, { once: true });
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
  const isInline = options?.measure !== false;
  const bridgeScript = isInline ? HEIGHT_BRIDGE(safeNonce) : '';
  const inlineStyleTag = isInline ? `<style>${INLINE_RESPONSIVE_STYLE}\n</style>` : '';

  const lower = rawHtml.toLowerCase();
  const hasDocRoot = lower.includes('<!doctype') || lower.includes('<html');
  if (hasDocRoot) {
    let doc = rawHtml;
    if (inlineStyleTag) {
      const closeHead = lower.indexOf('</head>');
      const bodyMatch = /<body(?:\s|>)/i.exec(doc);
      const openBody = bodyMatch ? bodyMatch.index : -1;
      if (closeHead >= 0 && (openBody < 0 || closeHead < openBody)) {
        doc = doc.slice(0, closeHead) + inlineStyleTag + doc.slice(closeHead);
      } else if (openBody >= 0) {
        doc = doc.slice(0, openBody) + inlineStyleTag + doc.slice(openBody);
      } else {
        doc = `${inlineStyleTag}\n${doc}`;
      }
    }
    if (!bridgeScript) return doc;
    const closeBody = doc.toLowerCase().lastIndexOf('</body>');
    if (closeBody >= 0) {
      return doc.slice(0, closeBody) + bridgeScript + doc.slice(closeBody);
    }
    return `${doc}\n${bridgeScript}`;
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
<style>${styleBlock}${isInline ? INLINE_RESPONSIVE_STYLE : ''}
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
  maxHeight = INLINE_PREVIEW_MAX_HEIGHT,
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

  useLayoutEffect(() => {
    setHeight(effectiveMinHeight);
  }, [effectiveMinHeight, html]);

  useLayoutEffect(() => {
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
