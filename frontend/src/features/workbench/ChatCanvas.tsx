import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Icon,
  LoadingSpinner,
} from '../../components/ui';
import type { Assistant, Message } from '../../core/types';
import { CollapseStateProvider } from '../../rendering/CollapsibleBlock';
import { ContentRenderer } from '../../rendering/ContentRenderer';
import { MessageActions } from '../chat/MessageActions';
import {
  materializeStreamingMessage,
  type ChatState,
} from '../chat/chatReducer';

export function ChatCanvas({
  state,
  assistant,
  hasConversationId,
  onRetryMessage,
  onDeleteMessage,
  onBranchMessage,
  onReloadConversation,
  onResetToNewTopic,
}: {
  state: ChatState;
  assistant: Assistant;
  hasConversationId: boolean;
  onRetryMessage: (message: Message) => Promise<boolean>;
  onDeleteMessage: (message: Message) => Promise<boolean>;
  onBranchMessage: (message: Message) => Promise<unknown>;
  onReloadConversation: () => Promise<void>;
  onResetToNewTopic: () => void;
}) {
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const visibleMessages = useMemo(() => {
    if (!state.streaming || !state.conversation) {
      return state.messages;
    }
    return [
      ...state.messages,
      materializeStreamingMessage(state.conversation.id, state.streaming),
    ];
  }, [state.conversation, state.messages, state.streaming]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setShowScrollBottom(false);
  }, [state.conversation?.id, hasConversationId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 72;
    stickToBottomRef.current = isNearBottom;
    setShowScrollBottom(!isNearBottom && visibleMessages.length > 0);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleMessages, state.streaming, state.runState]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowScrollBottom(false);
  };

  return (
    <div
      ref={scrollRef}
      className="wb-chat-scroll"
      aria-label="对话消息"
      onScroll={handleScroll}
    >
      <div className="wb-chat-inner">
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
            {visibleMessages.map((msg, idx) => {
              const isStreamingThis =
                Boolean(state.streaming) && idx === visibleMessages.length - 1;
              const isBusy =
                state.runState === 'loading' || state.runState === 'streaming';

              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className="wb-user-msg">
                    <div className="wb-user-bubble">
                      <ContentRenderer
                        messageId={msg.id}
                        blocks={msg.blocks}
                        isUser
                      />
                    </div>
                    <MessageActions
                      message={msg}
                      disabled={isBusy}
                      onRetry={onRetryMessage}
                      onDelete={onDeleteMessage}
                    />
                  </div>
                );
              }

              return (
                <article key={msg.id} className="wb-asst-msg">
                  <div className="wb-asst-head">
                    <span className="wb-asst-avatar" aria-hidden="true">
                      <Icon name="bot" size={13} />
                    </span>
                    <span className="wb-asst-name">{assistant.name}</span>
                    {msg.modelId ? (
                      <span className="wb-asst-tag">{msg.modelId}</span>
                    ) : null}
                  </div>

                  {isStreamingThis && msg.blocks.length === 0 ? (
                    <LoadingSpinner />
                  ) : (
                    <ContentRenderer
                      messageId={msg.id}
                      blocks={msg.blocks}
                      isStreaming={isStreamingThis}
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

                  {!isStreamingThis ? (
                    <MessageActions
                      message={msg}
                      disabled={isBusy}
                      onRetry={onRetryMessage}
                      onDelete={onDeleteMessage}
                      onBranch={onBranchMessage}
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
