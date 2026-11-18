import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  LoadingSpinner,
  Textarea,
} from '../../components/ui';
import type { Assistant, ContentBlock, Message, ProviderConfig } from '../../core/types';
import { CollapseStateProvider } from '../../rendering/CollapsibleBlock';
import { ContentRenderer } from '../../rendering/ContentRenderer';
import { MessageActions, extractMessageCopyText } from '../chat/MessageActions';
import {
  insertMessageAt,
  materializeStreamingMessage,
  type ChatState,
} from '../chat/chatReducer';

function buildEditedBlocks(
  blocks: ContentBlock[],
  nextText: string,
): ContentBlock[] {
  const firstTextIdx = blocks.findIndex((b) => b.type === 'text');
  if (firstTextIdx < 0) {
    return nextText.trim() !== ''
      ? [...blocks, { type: 'text', text: nextText }]
      : blocks;
  }
  const out: ContentBlock[] = [];
  let inserted = false;
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!inserted) {
        out.push({ type: 'text', text: nextText });
        inserted = true;
      }
    } else {
      out.push(block);
    }
  }
  return out;
}

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

export function ChatCanvas({
  state,
  assistant,
  providers = [],
  hasConversationId,
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
  onUpdateMessage: (messageId: string, blocks: ContentBlock[]) => Promise<boolean>;
  onRetryMessage: (message: Message) => Promise<boolean>;
  onDeleteMessage: (message: Message) => Promise<boolean>;
  onBranchMessage: (message: Message) => Promise<unknown>;
  onReloadConversation: () => Promise<void>;
  onResetToNewTopic: () => void;
}) {
  const { settings } = useApp();
  const displayMode = settings.chatDisplayMode;
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const programmaticTopRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const visibleMessages = useMemo(() => {
    if (!state.streaming || !state.conversation) {
      return state.messages;
    }
    return insertMessageAt(
      state.messages,
      materializeStreamingMessage(state.conversation.id, state.streaming),
      state.streaming.insertIndex,
    );
  }, [state.conversation, state.messages, state.streaming]);

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
    setEditingMessageId(null);
    setEditingText('');
  }, [state.conversation?.id, hasConversationId]);

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

  const startEdit = (msg: Message) => {
    setEditingMessageId(msg.id);
    setEditingText(extractMessageCopyText(msg));
  };

  const cancelEdit = () => {
    if (savingEdit) return;
    setEditingMessageId(null);
    setEditingText('');
  };

  const saveEdit = async (msg: Message) => {
    const hasNonText = msg.blocks.some((b) => b.type !== 'text');
    if (savingEdit || (!editingText.trim() && !hasNonText)) return;
    const nextBlocks = buildEditedBlocks(msg.blocks, editingText);
    if (nextBlocks.length === 0) return;
    setSavingEdit(true);
    try {
      const ok = await onUpdateMessage(msg.id, nextBlocks);
      if (ok) {
        setEditingMessageId(null);
        setEditingText('');
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const renderInlineEditor = (msg: Message) => {
    const hasNonText = msg.blocks.some((b) => b.type !== 'text');
    const canSave = editingText.trim().length > 0 || hasNonText;
    return (
      <div className="wb-msg-editor">
        <Textarea
          aria-label="编辑消息内容"
          className="wb-msg-editor__textarea"
          value={editingText}
          autoFocus
          rows={Math.min(10, Math.max(3, editingText.split('\n').length))}
          disabled={savingEdit}
          onChange={(e) => setEditingText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void saveEdit(msg);
            }
          }}
        />
        <div className="wb-msg-editor__actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={savingEdit}
            onClick={cancelEdit}
          >
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={savingEdit || !canSave}
            onClick={() => void saveEdit(msg)}
          >
            {savingEdit ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      className="wb-chat-scroll"
      aria-label="对话消息"
      onScroll={handleScroll}
    >
      <div className="wb-chat-inner" data-display-mode={displayMode}>
        {state.runState === 'loading' && visibleMessages.length > 0 ? (
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
            <EmptyState
              icon="bot"
              title={assistant.name}
            />
          )
        ) : (
          <CollapseStateProvider>
            {visibleMessages.map((msg) => {
              const uiKey = state.uiKeyByMsgId[msg.id] ?? msg.id;
              const isStreamingThis =
                Boolean(state.streaming) &&
                msg.id === state.streaming?.messageId;
              const isBusy =
                state.runState === 'loading' || state.runState === 'streaming';
              const isEditingThis = editingMessageId === msg.id;

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
                        renderInlineEditor(msg)
                      ) : isStreamingThis && msg.blocks.length === 0 ? (
                        <LoadingSpinner />
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
                          displayMode="feed"
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
                      renderInlineEditor(msg)
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
                    renderInlineEditor(msg)
                  ) : isStreamingThis && msg.blocks.length === 0 ? (
                    <LoadingSpinner />
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
    </div>
  );
}
