import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useApp } from '../../app/AppProvider';
import { GatewayError } from '../../core/gateway';
import { decodeSseByteStream, parseStreamEventFrame } from '../../core/sse';
import type {
  ContentBlock,
  Conversation,
  ConversationDetail,
  GenerationParams,
  ReasoningEffort,
} from '../../core/types';
import {
  chatReducer,
  initialChatState,
  isLocalMessageId,
  type ChatState,
} from './chatReducer';

export interface SendMessageOptions {
  conversationId: string;
  conversation?: Conversation;
  blocks: ContentBlock[];
  text?: string;
  providerId: string;
  modelId: string;
  params?: GenerationParams;
  webSearch?: boolean;
  searchEngineId?: string;
  onStreamAccepted?: () => void;
}

export interface RegenerateOptions {
  targetMessageId: string;
  providerId: string;
  modelId: string;
  params?: GenerationParams;
  webSearch?: boolean;
  searchEngineId?: string;
}

export interface ChatContextValue {
  state: ChatState;
  isBusy: boolean;
  setReasoningEffort: (effort: ReasoningEffort) => void;
  clearSession: () => void;
  loadConversation: (conversationId: string) => Promise<ConversationDetail | null>;
  reloadCurrentConversation: () => Promise<void>;
  sendMessage: (opts: SendMessageOptions) => Promise<boolean>;
  regenerateMessage: (opts: RegenerateOptions) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;
  branchFromMessage: (messageId: string) => Promise<ConversationDetail | null>;
  applyBranchedDetail: (detail: ConversationDetail) => void;
  stopStreaming: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof GatewayError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'NETWORK_ERROR', message: err.message };
  }
  return { code: 'NETWORK_ERROR', message: '请求失败' };
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const {
    gateway,
    connectionEpoch,
    upsertLocalConversation,
    toast,
  } = useApp();

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const epochRef = useRef(0);
  const prevConnectionEpochRef = useRef(connectionEpoch);
  const activeAbortRef = useRef<AbortController | null>(null);
  const manualAbortRef = useRef(false);
  const sendingRef = useRef(false);

  const cancelActiveStream = useCallback((quiet: boolean) => {
    epochRef.current += 1;
    manualAbortRef.current = !quiet;
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
    }
    sendingRef.current = false;
  }, []);

  useEffect(() => {
    if (prevConnectionEpochRef.current === connectionEpoch) return;
    prevConnectionEpochRef.current = connectionEpoch;
    cancelActiveStream(true);
    dispatch({ type: 'CLEAR_SESSION' });
  }, [connectionEpoch, cancelActiveStream]);

  useEffect(() => {
    return () => {
      cancelActiveStream(true);
    };
  }, [cancelActiveStream]);

  const isBusy =
    state.runState === 'loading' || state.runState === 'streaming';

  const setReasoningEffort = useCallback((effort: ReasoningEffort) => {
    dispatch({ type: 'SET_EFFORT', effort });
  }, []);

  const clearSession = useCallback(() => {
    cancelActiveStream(true);
    dispatch({ type: 'CLEAR_SESSION' });
  }, [cancelActiveStream]);

  const loadConversation = useCallback(
    async (conversationId: string): Promise<ConversationDetail | null> => {
      cancelActiveStream(true);
      const epoch = ++epochRef.current;
      const ctrl = new AbortController();
      activeAbortRef.current = ctrl;
      dispatch({ type: 'LOAD_START' });
      try {
        const detail = await gateway.getConversationDetail(
          conversationId,
          ctrl.signal,
        );
        if (epoch !== epochRef.current) return null;
        dispatch({
          type: 'LOAD_SUCCESS',
          conversation: detail.conversation,
          messages: detail.messages,
        });
        upsertLocalConversation(detail.conversation);
        return detail;
      } catch (err) {
        if (epoch !== epochRef.current || isAbortError(err)) return null;
        const e = formatError(err);
        dispatch({ type: 'LOAD_ERROR', code: e.code, message: e.message });
        return null;
      } finally {
        if (activeAbortRef.current === ctrl) {
          activeAbortRef.current = null;
        }
      }
    },
    [cancelActiveStream, gateway, upsertLocalConversation],
  );

  const reconcileAfterStream = useCallback(
    async (
      conversationId: string,
      epoch: number,
      opts: {
        isAbort: boolean;
        minExpectedMessages: number;
      },
    ) => {
      const fetchDetail = async () => {
        const detail = await gateway.getConversationDetail(conversationId);
        if (epoch !== epochRef.current) return null;
        return detail;
      };

      try {
        let detail = await fetchDetail();
        if (!detail) return;
        if (
          opts.isAbort &&
          detail.messages.length < opts.minExpectedMessages
        ) {
          await new Promise((r) => window.setTimeout(r, 150));
          if (epoch !== epochRef.current) return;
          detail = await fetchDetail();
          if (!detail) return;
        }

        if (
          opts.isAbort &&
          detail.messages.length < opts.minExpectedMessages
        ) {
          // Backend hasn't persisted the aborted assistant block yet: keep visible partial blocks and expose Reload.
          dispatch({ type: 'MARK_NEEDS_RELOAD' });
          return;
        }

        dispatch({
          type: 'RECONCILE_DETAIL',
          conversation: detail.conversation,
          messages: detail.messages,
        });
        upsertLocalConversation(detail.conversation);
      } catch {
        if (epoch !== epochRef.current) return;
        if (opts.isAbort) {
          dispatch({ type: 'MARK_NEEDS_RELOAD' });
        }
      }
    },
    [gateway, upsertLocalConversation],
  );

  const executeStream = useCallback(
    async (opts: {
      conversationId: string;
      input: {
        blocks?: ContentBlock[];
        text?: string;
        providerId: string;
        modelId: string;
        params?: GenerationParams;
        regenerateMessageId?: string;
        webSearch?: boolean;
        searchEngineId?: string;
      };
      optimisticUserId?: string;
      regenerateTargetId?: string;
      expectedCountOnAbort: number;
      onStreamAccepted?: () => void;
    }): Promise<boolean> => {
      if (sendingRef.current) return false;
      sendingRef.current = true;
      const epoch = ++epochRef.current;
      const ctrl = new AbortController();
      activeAbortRef.current = ctrl;
      manualAbortRef.current = false;

      let response: Response;
      try {
        response = await gateway.openChatStream(
          opts.conversationId,
          opts.input,
          ctrl.signal,
        );
      } catch (err) {
        sendingRef.current = false;
        if (activeAbortRef.current === ctrl) activeAbortRef.current = null;

        if (epoch !== epochRef.current) return false;
        if (isAbortError(err) && manualAbortRef.current) {
          if (opts.optimisticUserId) {
            dispatch({
              type: 'SEND_PREPARE_FAILED',
              optimisticUserId: opts.optimisticUserId,
              code: 'ABORTED',
              message: '已取消请求',
            });
          } else {
            dispatch({ type: 'ABORT_LOCAL' });
          }
          return false;
        }

        const e = formatError(err);
        if (opts.optimisticUserId) {
          dispatch({
            type: 'SEND_PREPARE_FAILED',
            optimisticUserId: opts.optimisticUserId,
            code: e.code,
            message: e.message,
          });
        } else {
          dispatch({
            type: 'REGEN_PREPARE_FAILED',
            code: e.code,
            message: e.message,
          });
        }
        return false;
      }

      if (epoch !== epochRef.current) {
        await response.body?.cancel().catch(() => {});
        sendingRef.current = false;
        return false;
      }

      // Prepare succeeded (HTTP 200): server has persisted user message or truncated regenerated tail.
      opts.onStreamAccepted?.();
      if (opts.regenerateTargetId) {
        dispatch({
          type: 'REGEN_PREPARE_CONFIRMED',
          targetMessageId: opts.regenerateTargetId,
        });
      }

      let receivedMessageEnd = false;
      let receivedStreamError = false;

      try {
        if (!response.body) {
          throw new GatewayError('STREAM_EMPTY', '服务端未返回事件流');
        }
        for await (const frame of decodeSseByteStream(response.body)) {
          if (epoch !== epochRef.current || manualAbortRef.current) break;
          let ev;
          try {
            ev = parseStreamEventFrame(frame);
          } catch {
            continue;
          }
          if (!ev) continue;

          if (ev.type === 'message_end') {
            receivedMessageEnd = true;
          }
          if (ev.type === 'error') {
            receivedStreamError = true;
          }

          dispatch({
            type: 'STREAM_EVENT',
            event: ev,
            fallbackProviderId: opts.input.providerId,
            fallbackModelId: opts.input.modelId,
          });

          if (ev.type === 'error') {
            break;
          }
        }

        if (epoch !== epochRef.current) return false;

        if (manualAbortRef.current) {
          dispatch({ type: 'ABORT_LOCAL' });
          await reconcileAfterStream(opts.conversationId, epoch, {
            isAbort: true,
            minExpectedMessages: opts.expectedCountOnAbort,
          });
          return false;
        }

        if (receivedStreamError) {
          return false;
        }

        if (!receivedMessageEnd) {
          dispatch({ type: 'STREAM_EOF_INCOMPLETE' });
          return false;
        }

        // Sync real server IDs (user + assistant) & updated title/timestamps.
        await reconcileAfterStream(opts.conversationId, epoch, {
          isAbort: false,
          minExpectedMessages: opts.expectedCountOnAbort,
        });
        return true;
      } catch (err) {
        if (epoch !== epochRef.current) return false;
        if (isAbortError(err) || manualAbortRef.current) {
          dispatch({ type: 'ABORT_LOCAL' });
          await reconcileAfterStream(opts.conversationId, epoch, {
            isAbort: true,
            minExpectedMessages: opts.expectedCountOnAbort,
          });
          return false;
        }
        const e = formatError(err);
        dispatch({
          type: 'STREAM_NETWORK_ERROR',
          code: e.code,
          message: e.message,
        });
        return false;
      } finally {
        sendingRef.current = false;
        if (activeAbortRef.current === ctrl) {
          activeAbortRef.current = null;
        }
      }
    },
    [gateway, reconcileAfterStream],
  );

  const sendMessage = useCallback(
    async (opts: SendMessageOptions): Promise<boolean> => {
      if (sendingRef.current || (opts.blocks.length === 0 && !opts.text?.trim())) {
        return false;
      }
      const optimisticId = `local-user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const mergedParams: GenerationParams = {
        ...opts.params,
        reasoningEffort:
          opts.params?.reasoningEffort ?? stateRef.current.reasoningEffort,
      };
      const expectedAfterAbort = stateRef.current.messages.length + 2;

      if (opts.conversation) {
        dispatch({
          type: 'UPDATE_CONVERSATION_META',
          conversation: opts.conversation,
        });
      }

      dispatch({
        type: 'SEND_PREPARE_START',
        optimisticUser: {
          id: optimisticId,
          conversationId: opts.conversationId,
          role: 'user',
          blocks: opts.blocks,
          createdAt: new Date().toISOString(),
        },
      });

      return executeStream({
        conversationId: opts.conversationId,
        input: {
          blocks: opts.blocks,
          text: opts.text,
          providerId: opts.providerId,
          modelId: opts.modelId,
          params: mergedParams,
          webSearch: opts.webSearch,
          searchEngineId: opts.searchEngineId,
        },
        optimisticUserId: optimisticId,
        expectedCountOnAbort: expectedAfterAbort,
        onStreamAccepted: opts.onStreamAccepted,
      });
    },
    [executeStream],
  );

  const regenerateMessage = useCallback(
    async (opts: RegenerateOptions): Promise<boolean> => {
      const conv = stateRef.current.conversation;
      if (!conv || sendingRef.current) return false;
      if (isLocalMessageId(opts.targetMessageId)) {
        toast('请先重新加载以获取服务端消息 ID', 'error');
        return false;
      }
      const idx = stateRef.current.messages.findIndex(
        (m) => m.id === opts.targetMessageId,
      );
      if (idx < 0) return false;
      const target = stateRef.current.messages[idx];
      const baseCount = target.role === 'user' ? idx + 1 : idx;

      const mergedParams: GenerationParams = {
        ...opts.params,
        reasoningEffort:
          opts.params?.reasoningEffort ?? stateRef.current.reasoningEffort,
      };

      dispatch({ type: 'REGEN_PREPARE_START' });

      return executeStream({
        conversationId: conv.id,
        input: {
          providerId: opts.providerId,
          modelId: opts.modelId,
          params: mergedParams,
          regenerateMessageId: opts.targetMessageId,
          webSearch: opts.webSearch,
          searchEngineId: opts.searchEngineId,
        },
        regenerateTargetId: opts.targetMessageId,
        expectedCountOnAbort: baseCount + 1,
      });
    },
    [executeStream, toast],
  );

  const stopStreaming = useCallback(() => {
    if (
      stateRef.current.runState !== 'loading' &&
      stateRef.current.runState !== 'streaming'
    ) {
      return;
    }
    manualAbortRef.current = true;
    activeAbortRef.current?.abort();
  }, []);

  const reloadCurrentConversation = useCallback(async () => {
    const convId = stateRef.current.conversation?.id;
    if (!convId || isBusy) return;
    await loadConversation(convId);
  }, [isBusy, loadConversation]);

  const deleteMessage = useCallback(
    async (messageId: string): Promise<boolean> => {
      const conv = stateRef.current.conversation;
      if (!conv || sendingRef.current) return false;
      if (isLocalMessageId(messageId)) {
        toast('该消息尚未确认落盘，请先重新加载', 'error');
        return false;
      }
      try {
        await gateway.deleteMessage(conv.id, messageId);
        dispatch({ type: 'REMOVE_MESSAGE', messageId });
        return true;
      } catch (err) {
        toast(formatError(err).message, 'error');
        return false;
      }
    },
    [gateway, toast],
  );

  const branchFromMessage = useCallback(
    async (messageId: string) => {
      const conv = stateRef.current.conversation;
      if (!conv || sendingRef.current) return null;
      if (isLocalMessageId(messageId)) {
        toast('该消息尚未确认落盘，请先重新加载', 'error');
        return null;
      }
      try {
        const detail = await gateway.branchConversation(conv.id, messageId);
        upsertLocalConversation(detail.conversation);
        dispatch({
          type: 'LOAD_SUCCESS',
          conversation: detail.conversation,
          messages: detail.messages,
        });
        return detail;
      } catch (err) {
        toast(formatError(err).message, 'error');
        return null;
      }
    },
    [gateway, toast, upsertLocalConversation],
  );

  const applyBranchedDetail = useCallback(
    (detail: ConversationDetail) => {
      cancelActiveStream(true);
      upsertLocalConversation(detail.conversation);
      dispatch({
        type: 'LOAD_SUCCESS',
        conversation: detail.conversation,
        messages: detail.messages,
      });
    },
    [cancelActiveStream, upsertLocalConversation],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      state,
      isBusy,
      setReasoningEffort,
      clearSession,
      loadConversation,
      reloadCurrentConversation,
      sendMessage,
      regenerateMessage,
      deleteMessage,
      branchFromMessage,
      applyBranchedDetail,
      stopStreaming,
    }),
    [
      state,
      isBusy,
      setReasoningEffort,
      clearSession,
      loadConversation,
      reloadCurrentConversation,
      sendMessage,
      regenerateMessage,
      deleteMessage,
      branchFromMessage,
      applyBranchedDetail,
      stopStreaming,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used inside ChatProvider');
  }
  return ctx;
}
