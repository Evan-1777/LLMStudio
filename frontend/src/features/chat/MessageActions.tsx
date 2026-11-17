import { useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { ConfirmDialog, IconButton } from '../../components/ui';
import type { ChatDisplayMode } from '../../core/settings';
import type { Message } from '../../core/types';
import { isLocalMessageId } from './chatReducer';

export function extractMessageCopyText(message: Message): string {
  return message.blocks
    .filter((b): b is Extract<Message['blocks'][number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}

export function MessageActions({
  message,
  disabled = false,
  displayMode = 'bubble',
  onEdit,
  onRetry,
  onDelete,
  onBranch,
}: {
  message: Message;
  disabled?: boolean;
  displayMode?: ChatDisplayMode;
  onEdit?: (message: Message) => void;
  onRetry: (message: Message) => Promise<boolean> | void;
  onDelete: (message: Message) => Promise<boolean> | void;
  onBranch?: (message: Message) => Promise<unknown> | void;
}) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const [confirmKind, setConfirmKind] = useState<'retry' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  const isLocal = isLocalMessageId(message.id);
  const copyText = extractMessageCopyText(message);
  const usage = message.usage;

  const handleCopy = async () => {
    if (!copyText) {
      toast('当前消息无可复制的文本', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('无法访问剪贴板', 'error');
    }
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      if (confirmKind === 'retry') {
        await onRetry(message);
      } else if (confirmKind === 'delete') {
        await onDelete(message);
      }
      setConfirmKind(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="msg-actions">
        <IconButton
          size="sm"
          icon={copied ? 'check' : 'copy'}
          label="复制消息"
          disabled={!copyText}
          onClick={() => void handleCopy()}
        />
        <IconButton
          size="sm"
          icon="refresh"
          label="重试消息"
          disabled={disabled || isLocal}
          onClick={() => setConfirmKind('retry')}
        />
        {onEdit ? (
          <IconButton
            size="sm"
            icon="edit"
            label="修改消息"
            disabled={disabled || isLocal}
            onClick={() => onEdit(message)}
          />
        ) : null}
        <IconButton
          size="sm"
          icon="trash"
          label="删除消息"
          tone="danger"
          disabled={disabled || isLocal}
          onClick={() => setConfirmKind('delete')}
        />
        {onBranch && message.role === 'assistant' ? (
          <IconButton
            size="sm"
            icon="branch"
            label="从此处分支"
            disabled={disabled || isLocal}
            onClick={() => void onBranch(message)}
          />
        ) : null}
        {usage ? (
          displayMode === 'feed' ? (
            <span className="msg-usage msg-usage--feed">
              Tokens: {usage.totalTokens} ↑{usage.inputTokens} ↓{usage.outputTokens}
            </span>
          ) : (
            <span className="msg-usage">
              {usage.inputTokens.toLocaleString()} in ·{' '}
              {usage.outputTokens.toLocaleString()} out
              {usage.thinkingTokens ? ` · ${usage.thinkingTokens.toLocaleString()} think` : ''}
            </span>
          )
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmKind !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmKind(null);
        }}
        title={confirmKind === 'retry' ? '重新生成回复？' : '删除此消息？'}
        message={
          confirmKind === 'retry'
            ? message.role === 'user'
              ? '将保留这条用户消息，并仅重新生成紧邻的下一条回复，下方其余历史消息保持不变。'
              : '将仅重新生成当前回复，下方其余历史消息保持不变。'
            : '只删除这一条消息，后续消息会保留。此操作不可撤销。'
        }
        confirmLabel={confirmKind === 'retry' ? '重新生成' : '删除'}
        danger={confirmKind === 'delete'}
        busy={busy}
        onConfirm={handleConfirm}
      />
    </>
  );
}
