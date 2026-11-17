import { useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { ConfirmDialog, IconButton, Popover } from '../../components/ui';
import type { ChatDisplayMode } from '../../core/settings';
import type { Message, TokenUsage } from '../../core/types';
import { isLocalMessageId } from './chatReducer';

function formatUsageTriggerText(
  usage: TokenUsage,
  displayMode: ChatDisplayMode,
): string {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  if (displayMode === 'feed') {
    const parts = [
      `Tokens: ${usage.totalTokens} ↑${usage.inputTokens} ↓${usage.outputTokens}`,
    ];
    if (cacheRead > 0) parts.push(`缓存读 ${cacheRead.toLocaleString()}`);
    if (cacheWrite > 0) parts.push(`缓存写 ${cacheWrite.toLocaleString()}`);
    return parts.join(' · ');
  }
  const parts = [
    `${usage.inputTokens.toLocaleString()} in`,
    `${usage.outputTokens.toLocaleString()} out`,
  ];
  if (usage.thinkingTokens && usage.thinkingTokens > 0) {
    parts.push(`${usage.thinkingTokens.toLocaleString()} think`);
  }
  if (cacheRead > 0) {
    parts.push(`缓存读 ${cacheRead.toLocaleString()}`);
  }
  if (cacheWrite > 0) {
    parts.push(`缓存写 ${cacheWrite.toLocaleString()}`);
  }
  return parts.join(' · ');
}

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
  const retryDispatchedRef = useRef(false);

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
    const kind = confirmKind;
    if (kind === 'retry') {
      if (retryDispatchedRef.current || disabled) return;
      retryDispatchedRef.current = true;
      setConfirmKind(null);
      try {
        void Promise.resolve(onRetry(message)).catch((err: unknown) => {
          toast(err instanceof Error ? err.message : '重试请求失败', 'error');
        });
      } catch (err) {
        toast(err instanceof Error ? err.message : '重试请求失败', 'error');
      }
      return;
    }
    if (kind !== 'delete') return;
    setBusy(true);
    try {
      await onDelete(message);
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
          onClick={() => {
            retryDispatchedRef.current = false;
            setConfirmKind('retry');
          }}
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
          <Popover
            align="end"
            side="top"
            trigger={
              <button
                type="button"
                className={`msg-usage msg-usage--trigger ${
                  displayMode === 'feed' ? 'msg-usage--feed' : ''
                }`.trim()}
                aria-label="查看 Token 用量详情"
              >
                {formatUsageTriggerText(usage, displayMode)}
              </button>
            }
          >
            <div className="msg-usage-detail">
              <div className="msg-usage-detail__row">
                <span>输入</span>
                <span>{usage.inputTokens.toLocaleString()}</span>
              </div>
              <div className="msg-usage-detail__row">
                <span>输出</span>
                <span>{usage.outputTokens.toLocaleString()}</span>
              </div>
              {usage.thinkingTokens && usage.thinkingTokens > 0 ? (
                <div className="msg-usage-detail__row">
                  <span>思考</span>
                  <span>{usage.thinkingTokens.toLocaleString()}</span>
                </div>
              ) : null}
              {usage.cacheReadInputTokens && usage.cacheReadInputTokens > 0 ? (
                <div className="msg-usage-detail__row">
                  <span>缓存读取</span>
                  <span>{usage.cacheReadInputTokens.toLocaleString()}</span>
                </div>
              ) : null}
              {usage.cacheCreationInputTokens &&
              usage.cacheCreationInputTokens > 0 ? (
                <div className="msg-usage-detail__row">
                  <span>缓存写入</span>
                  <span>{usage.cacheCreationInputTokens.toLocaleString()}</span>
                </div>
              ) : null}
              <div className="msg-usage-detail__row msg-usage-detail__row--total">
                <span>总计</span>
                <span>{usage.totalTokens.toLocaleString()}</span>
              </div>
            </div>
          </Popover>
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
