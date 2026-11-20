import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import {
  Avatar,
  Button,
  ConfirmDialog,
  ErrorBanner,
  Icon,
  IconButton,
  LoadingSpinner,
} from '../../components/ui';
import type {
  Assistant,
  CompactionBlock,
  ContentBlock,
  Message,
  ProviderConfig,
  TopicScope,
} from '../../core/types';
import { CollapseStateProvider } from '../../rendering/CollapsibleBlock';
import { ContentRenderer } from '../../rendering/ContentRenderer';
import { formatCompactTokens, parseCompactionMeta } from './contextUsage';
import { MessageActions } from '../chat/MessageActions';
import { MessageEditor } from './MessageEditor';
import {
  insertMessageAt,
  materializeStreamingMessage,
  type ChatState,
} from '../chat/chatReducer';

function resolveMessageSource(
  msg: Message,
  providers: readonly ProviderConfig[],
  assistantName: string,
): string {
  const provider = msg.providerId
    ? providers.find((p) => p.id === msg.providerId)
    : undefined;
  const model =
    provider && msg.modelId
      ? provider.models.find((m) => m.id === msg.modelId)
      : undefined;
  if (model && provider) {
    return `${model.name || msg.modelId} | ${provider.name}`;
  }
  if (msg.modelId && provider) {
    return `${msg.modelId} | ${provider.name}`;
  }
  if (msg.modelId) {
    return msg.modelId;
  }
  return assistantName;
}

function formatFeedTimestamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

function CompactionCheckpointCard({
  message,
  collapsePrefix,
  disabled,
  onRequestDelete,
}: {
  message: Message;
  collapsePrefix: string;
  disabled: boolean;
  onRequestDelete: (message: Message) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = parseCompactionMeta(message);
  const block = message.blocks.find(
    (b): b is CompactionBlock => b.type === 'compaction',
  );
  const summary = block?.text ?? '';

  return (
    <section
      className="wb-compaction"
      aria-label="压缩检查点"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className="wb-compaction__row">
        <span className="wb-compaction__line" aria-hidden="true" />
        <div className="wb-compaction__pill">
          <button
            type="button"
            className="wb-compaction__toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name="compress" size={13} />
            <span className="wb-compaction__title">上下文已压缩</span>
            {typeof meta?.compactedCount === 'number' && meta.compactedCount > 0 ? (
              <span className="wb-compaction__meta">
                已折叠 {meta.compactedCount} 条
              </span>
            ) : null}
            {typeof meta?.beforeTokens === 'number' &&
            typeof meta?.afterTokens === 'number' &&
            meta.beforeTokens > 0 ? (
              <span className="wb-compaction__tokens">
                {formatCompactTokens(meta.beforeTokens)} →{' '}
                {formatCompactTokens(meta.afterTokens)}
              </span>
            ) : null}
            <Icon
              name={expanded ? 'chevronUp' : 'chevronDown'}
              size={13}
              className="wb-compaction__chevron"
            />
          </button>
          <IconButton
            size="sm"
            icon="trash"
            tone="danger"
            label="删除压缩检查点"
            disabled={disabled}
            onClick={() => onRequestDelete(message)}
          />
        </div>
        <span className="wb-compaction__line" aria-hidden="true" />
      </div>

      {expanded && summary ? (
        <div className="wb-compaction__body">
          <ContentRenderer
            messageId={message.id}
            collapsePrefix={`${collapsePrefix}:compaction`}
            blocks={[{ type: 'text', text: summary }]}
          />
        </div>
      ) : null}
    </section>
  );
}

export function ChatCanvas({
  state,
  assistant,
  providers = [],
  hasConversationId,
  scope,
  isTemporary = false,
  onUpdateMessage,
  onRetryMessage,
  onDeleteMessage,
  onBranchMessage,
  onReloadConversation,
  onResetToNewTopic,
}: {
  state: ChatState;
  assistant: Assistant;
  providers?: readonly ProviderConfig[];
  hasConversationId: boolean;
  scope?: TopicScope;
  isTemporary?: boolean;
  onUpdateMessage: (messageId: string, blocks: ContentBlock[]) => Promise<boolean>;
  onRetryMessage: (message: Message) => Promise<boolean>;
  onDeleteMessage: (message: Message) => Promise<boolean>;
  onBranchMessage: (message: Message) => Promise<unknown>;
  onReloadConversation: () => Promise<void>;
  onResetToNewTopic: () => void;
}) {
  const { settings, connectionEpoch } = useApp();
  const displayMode = settings.chatDisplayMode;
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const programmaticTopRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const editScope = JSON.stringify([connectionEpoch, scope, location.pathname, state.conversation?.id, hasConversationId]);
  const [editTarget, setEditTarget] = useState<{ message: Message; scope: string } | null>(null);
  const [savingTarget, setSavingTarget] = useState<typeof editTarget>(null);
  const editing = editTarget?.scope === editScope ? editTarget : null;
  const savingEdit = editing !== null && savingTarget === editing;
  const [deletingCompactionMsg, setDeletingCompactionMsg] =
    useState<Message | null>(null);
  const [deletingCompactionBusy, setDeletingCompactionBusy] = useState(false);
  const isBusy = savingEdit || state.runState === 'loading' || state.runState === 'streaming';

  const visibleMessages = useMemo(() => {
    if (!state.streaming) {
      return state.messages;
    }
    return insertMessageAt(
      state.messages,
      materializeStreamingMessage(state.conversation?.id ?? '', state.streaming),
      state.streaming.insertIndex,
    );
  }, [state.conversation?.id, state.messages, state.streaming]);

  const streamingBlockCompleted = useMemo(() => {
    if (!state.streaming) return undefined;
    return state.streaming.blockOrder.map((idx) =>
      Boolean(state.streaming!.blocksByIndex[idx]?.completed),
    );
  }, [state.streaming]);

  useEffect(() => {
    stickToBottomRef.current = true;
    programmaticTopRef.current = null;
    setShowScrollBottom(false);
    setEditTarget(null);
  }, [editScope]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const applied = programmaticTopRef.current;
    if (applied !== null && Math.abs(el.scrollTop - applied) <= 2) {
      programmaticTopRef.current = null;
      stickToBottomRef.current = true;
      setShowScrollBottom(false);
      return;
    }
    programmaticTopRef.current = null;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 72;
    stickToBottomRef.current = isNearBottom;
    setShowScrollBottom(!isNearBottom && visibleMessages.length > 0);
  };

  useEffect(() => {
    const el = scrollRef.current;
    const isAppendingToEnd =
      !state.streaming ||
      state.streaming.insertIndex === undefined ||
      state.streaming.insertIndex >= state.messages.length;
    if (!el || !stickToBottomRef.current || !isAppendingToEnd) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const target = scrollRef.current;
      if (!target || !stickToBottomRef.current) return;
      target.scrollTop = target.scrollHeight;
      programmaticTopRef.current = target.scrollTop;
    });
  }, [visibleMessages, state.streaming, state.runState, state.messages.length]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      if (stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        programmaticTopRef.current = el.scrollTop;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
    setShowScrollBottom(false);
  };

  const startEdit = (message: Message) => setEditTarget({ message, scope: editScope });

  const inlineEditor = editing ? (
    <MessageEditor
      message={editing.message}
      saving={savingEdit}
      onCancel={() => setEditTarget(null)}
      onSave={async (blocks) => {
        setSavingTarget(editing);
        try {
          if (await onUpdateMessage(editing.message.id, blocks)) {
            setEditTarget((current) => current === editing ? null : current);
          }
        } finally {
          setSavingTarget((current) => current === editing ? null : current);
        }
      }}
    />
  ) : null;

  return (
    <div
      ref={scrollRef}
      className="wb-chat-scroll"
      aria-label="对话消息"
      onScroll={handleScroll}
    >
      <div className="wb-chat-inner" data-display-mode={displayMode}>
        {state.runState === 'loading' && !state.streaming && visibleMessages.length > 0 ? (
          <div className="wb-refresh-status">
            <LoadingSpinner size="sm" label="正在刷新" />
          </div>
        ) : null}
        {state.runState === 'loading' && visibleMessages.length === 0 ? (
          <div style={{ padding: '48px 0', display: 'flex', justifyContent: 'center' }}>
            <LoadingSpinner label="正在加载" />
          </div>
        ) : visibleMessages.length === 0 ? (
          state.runState === 'error' && state.errorMessage ? (
            <ErrorBanner
              message={state.errorMessage}
              onRetry={
                hasConversationId
                  ? () => void onReloadConversation()
                  : undefined
              }
              action={
                hasConversationId ? (
                  <Button size="sm" variant="ghost" onClick={onResetToNewTopic}>
                    新建话题
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="wb-empty-focus">
              <Avatar
                kind="assistant"
                src={assistant.avatarDataUrl}
                size={48}
                className="ui-avatar--lg"
              />
              <h2 className="wb-empty-focus__title">{assistant.name}</h2>
              {isTemporary ? (
                <span className="wb-temp-badge">临时会话</span>
              ) : null}
            </div>
          )
        ) : (
          <CollapseStateProvider>
            {visibleMessages.map((msg) => {
              const uiKey = state.uiKeyByMsgId[msg.id] ?? msg.id;
              if (msg.role === 'compaction') {
                return (
                  <CompactionCheckpointCard
                    key={uiKey}
                    message={msg}
                    collapsePrefix={uiKey}
                    disabled={isBusy}
                    onRequestDelete={(target) => setDeletingCompactionMsg(target)}
                  />
                );
              }
              const isStreamingThis =
                Boolean(state.streaming) &&
                msg.id === state.streaming?.messageId;
              const isEditingThis = editing?.message.id === msg.id;

              if (displayMode === 'feed') {
                const isUser = msg.role === 'user';
                const authorLabel = isUser
                  ? '用户'
                  : resolveMessageSource(msg, providers, assistant.name);
                const timestamp = formatFeedTimestamp(msg.createdAt);

                return (
                  <article
                    key={uiKey}
                    className={`wb-feed-msg ${
                      isUser ? 'wb-feed-msg--user' : 'wb-feed-msg--asst'
                    }`.trim()}
                  >
                    <div className="wb-feed-head">
                      <Avatar
                        kind={isUser ? 'user' : 'assistant'}
                        src={isUser ? settings.userAvatarDataUrl : assistant.avatarDataUrl}
                        size={32}
                      />
                      <div className="wb-feed-meta">
                        <span className="wb-feed-author">{authorLabel}</span>
                        {timestamp ? (
                          <span className="wb-feed-time">{timestamp}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="wb-feed-body">
                      {isEditingThis ? (
                        inlineEditor
                      ) : isStreamingThis && msg.blocks.length === 0 ? (
                        <LoadingSpinner size="sm" label="等待响应" />
                      ) : (
                        <ContentRenderer
                          messageId={msg.id}
                          collapsePrefix={uiKey}
                          blocks={msg.blocks}
                          isStreaming={isStreamingThis}
                          blockCompleted={
                            isStreamingThis ? streamingBlockCompleted : undefined
                          }
                          stopReason={msg.stopReason}
                          isUser={isUser}
                        />
                      )}

                      {!isUser && msg.stopReason === 'aborted' ? (
                        <div className="wb-msg-status">
                          <span>已停止</span>
                          {state.needsReloadAfterAbort ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void onReloadConversation()}
                            >
                              重新加载
                            </Button>
                          ) : null}
                        </div>
                      ) : null}

                      {!isUser && msg.stopReason === 'error' && msg.errorMessage ? (
                        <div className="wb-msg-status wb-msg-status--error">
                          <Icon name="warning" size={14} />
                          <span>{msg.errorMessage}</span>
                        </div>
                      ) : null}

                      {!isStreamingThis && !isEditingThis ? (
                        <MessageActions
                          message={msg}
                          disabled={isBusy}
                          onEdit={startEdit}
                          onRetry={onRetryMessage}
                          onDelete={onDeleteMessage}
                          onBranch={
                            msg.role === 'assistant' ? onBranchMessage : undefined
                          }
                        />
                      ) : null}
                    </div>
                  </article>
                );
              }

              if (msg.role === 'user') {
                return (
                  <div key={uiKey} className="wb-user-msg">
                    {isEditingThis ? (
                      inlineEditor
                    ) : (
                      <>
                        <div className="wb-user-row">
                          <div className="wb-user-bubble">
                            <ContentRenderer
                              messageId={msg.id}
                              collapsePrefix={uiKey}
                              blocks={msg.blocks}
                              isUser
                            />
                          </div>
                          <Avatar
                            kind="user"
                            src={settings.userAvatarDataUrl}
                            size={32}
                          />
                        </div>
                        <MessageActions
                          message={msg}
                          disabled={isBusy}
                          onEdit={startEdit}
                          onRetry={onRetryMessage}
                          onDelete={onDeleteMessage}
                        />
                      </>
                    )}
                  </div>
                );
              }

              return (
                <article key={uiKey} className="wb-asst-msg">
                  <div className="wb-asst-head">
                    <Avatar
                      kind="assistant"
                      src={assistant.avatarDataUrl}
                      size={32}
                    />
                    <span className="wb-asst-name">{assistant.name}</span>
                    {msg.modelId ? (
                      <span className="wb-asst-tag">{msg.modelId}</span>
                    ) : null}
                  </div>

                  {isEditingThis ? (
                    inlineEditor
                  ) : isStreamingThis && msg.blocks.length === 0 ? (
                    <LoadingSpinner size="sm" label="等待响应" />
                  ) : (
                    <ContentRenderer
                      messageId={msg.id}
                      collapsePrefix={uiKey}
                      blocks={msg.blocks}
                      isStreaming={isStreamingThis}
                      blockCompleted={
                        isStreamingThis ? streamingBlockCompleted : undefined
                      }
                      stopReason={msg.stopReason}
                    />
                  )}

                  {msg.stopReason === 'aborted' ? (
                    <div className="wb-msg-status">
                      <span>已停止</span>
                      {state.needsReloadAfterAbort ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onReloadConversation()}
                        >
                          重新加载
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  {msg.stopReason === 'error' && msg.errorMessage ? (
                    <div className="wb-msg-status wb-msg-status--error">
                      <Icon name="warning" size={14} />
                      <span>{msg.errorMessage}</span>
                    </div>
                  ) : null}

                  {!isStreamingThis && !isEditingThis ? (
                    <MessageActions
                      message={msg}
                      disabled={isBusy}
                      onEdit={startEdit}
                      onRetry={onRetryMessage}
                      onDelete={onDeleteMessage}
                      onBranch={
                        msg.role === 'assistant' ? onBranchMessage : undefined
                      }
                    />
                  ) : null}
                </article>
              );
            })}
          </CollapseStateProvider>
        )}

        {visibleMessages.length > 0 &&
        state.runState === 'error' &&
        state.errorMessage ? (
          <ErrorBanner
            message={state.errorMessage}
            onRetry={
              hasConversationId && state.errorCode !== 'UNAUTHORIZED'
                ? () => void onReloadConversation()
                : undefined
            }
            action={
              state.errorCode === 'UNAUTHORIZED' ? (
                <Link
                  to="/settings/connection"
                  state={{ from: `${location.pathname}${location.search}` }}
                  className="ui-btn ui-btn--sm ui-btn--secondary"
                >
                  连接设置
                </Link>
              ) : undefined
            }
          />
        ) : null}
      </div>

      {showScrollBottom ? (
        <button
          type="button"
          className="wb-scroll-bottom-btn"
          aria-label="回到底部"
          title="回到底部"
          onClick={scrollToBottom}
        >
          <Icon name="arrowDown" size={16} />
        </button>
      ) : null}

      <ConfirmDialog
        open={Boolean(deletingCompactionMsg)}
        onOpenChange={(open) => {
          if (!open && !deletingCompactionBusy) {
            setDeletingCompactionMsg(null);
          }
        }}
        title="删除压缩检查点"
        message="删除后将恢复此前历史消息进入上下文。"
        confirmLabel="删除"
        danger
        busy={deletingCompactionBusy}
        onConfirm={async () => {
          if (!deletingCompactionMsg || deletingCompactionBusy) return;
          setDeletingCompactionBusy(true);
          try {
            const ok = await onDeleteMessage(deletingCompactionMsg);
            if (ok) {
              setDeletingCompactionMsg(null);
            }
          } finally {
            setDeletingCompactionBusy(false);
          }
        }}
      />
    </div>
  );
}
