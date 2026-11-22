import { useState } from 'react';
import { IconButton } from '../components/ui';
import { useApp } from '../app/AppProvider';
import { CollapsibleBlock } from './CollapsibleBlock';
import { HtmlPreview } from './HtmlPreview';
import { shouldAutoCollapseText } from './segments';

export function CodeBlock({
  language,
  code,
  isClosed,
  collapseKey,
  defaultHtmlPreview,
}: {
  language: string;
  code: string;
  isClosed: boolean;
  collapseKey: string;
  defaultHtmlPreview?: boolean;
}) {
  const { settings, toast } = useApp();
  const [copied, setCopied] = useState(false);

  if (language === 'html' || language === 'htm') {
    return (
      <HtmlPreview
        html={code}
        isClosed={isClosed}
        collapseKey={collapseKey}
        title="HTML"
        defaultHtmlPreview={defaultHtmlPreview}
      />
    );
  }

  const defaultCollapsed = shouldAutoCollapseText(code, settings);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('无法写入剪贴板', 'error');
    }
  };

  return (
    <CollapsibleBlock
      collapseKey={collapseKey}
      title={language || 'text'}
      icon="code"
      defaultCollapsed={defaultCollapsed}
      actions={
        <IconButton
          size="sm"
          icon={copied ? 'check' : 'copy'}
          label="复制代码"
          onClick={() => void handleCopy()}
        />
      }
    >
      <pre className="code-pre">
        <code>{code}</code>
      </pre>
    </CollapsibleBlock>
  );
}
