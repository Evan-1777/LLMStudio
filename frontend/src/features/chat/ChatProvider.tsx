import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp } from '../../app/AppProvider';
import { GatewayError } from '../../core/gateway';
import { decodeSseByteStream, parseStreamEventFrame } from '../../core/sse';
import type {
  ActiveRunInfo,
  ContentBlock,
  Conversation,
  ConversationMode,
  ConversationDetail,
  GenerationParams,
  GraphMutationInput,
  Message,
  TopicScope,
} from '../../core/types';
import {
  activeChatMessages,
  chatReducer,
  initialChatState,
  isLocalMessageId,
  type ChatState,
} from './chatReducer';
import {
  formatError,
  isAbortError,
  isSubstantiveAssistantEvent,
  type CompactConversationResult,
  type GenerationRun,
} from './chatErrors';
import { runCompactConversation } from './compactExecutor';
import {
  runLocalChatStream,
  type LocalStreamRunOptions,
} from './localChatExecutor';

export type { CompactConversationResult } from './chatErrors';

export interface SendMessageOptions {
  conversationId?: string;
  conversation?: Conversation;
  conversationMode?: ConversationMode;
  scope?: TopicScope;
  ensureConversation?: (signal: AbortSignal) => Promise<Conversation | null>;
  blocks: ContentBlock[];
  text?: string;
  providerId: string;
  modelId: string;
  params?: GenerationParams;
  mcpToolsEnabled?: boolean;
  webSearch?: boolean;
  searchEngineId?: string;
  onOptimisticStart?: () => void;
  onPrepareRollback?: () => void;
  onStreamAccepted?: () => void;
}

export interface RegenerateOptions {
  targetMessageId: string;
  providerId: string;
  modelId: string;
  scope?: TopicScope;
  params?: GenerationParams;
  mcpToolsEnabled?: boolean;
  webSearch?: boolean;
  searchEngineId?: string;
}

export interface ChatContextValue {
  state: ChatState;
  activeMessages: Message[];
  mutateGraph: (input: GraphMutationInput, scope?: TopicScope) => Promise<ConversationDetail | null>;
  sessionScope?: TopicScope;
  isBusy: boolean;
  isGenerating: boolean;
  isCompacting: boolean;
  updateConversationMeta: (conversation: Conversation) => void;
  clearSession: () => void;
  loadConversation: (
    conversationId: string,
    scope?: TopicScope,
  ) => Promise<ConversationDetail | null>;
  reloadCurrentConversation: () => Promise<void>;
  sendMessage: (opts: SendMessageOptions) => Promise<boolean>;
  regenerateMessage: (opts: RegenerateOptions) => Promise<boolean>;
  compactConversation: (opts: {
    providerId: string;
    modelId: string;
    scope?: TopicScope;
  }) => Promise<CompactConversationResult>;
  updateMessage: (
    messageId: string,
    blocks: ContentBlock[],
    scope?: TopicScope,
  ) => Promise<boolean>;
  deleteMessage: (messageId: string, scope?: TopicScope) => Promise<boolean>;
  branchFromMessage: (
    messageId: string,
    scope?: TopicScope,
  ) => Promise<ConversationDetail | null>;
  applyBranchedDetail: (detail: ConversationDetail, scope?: TopicScope) => void;
  detachStream: () => void;
  stopStreaming: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const {
    gateway,
    isDesktop,
    topicScope,
    resources,
    settings: { mcpMaxToolRounds },
    connectionEpoch,
    markConversationRunning,
    upsertLocalConversation,
    toast,
  } = useApp();

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);

  const epochRef = useRef(0);
  const runSeqRef = useRef(0);
  const prevConnectionEpochRef = useRef(connectionEpoch);
  const connectionEpochRef = useRef(connectionEpoch);
  connectionEpochRef.current = connectionEpoch;
  const activeGenRef = useRef<GenerationRun | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadConnectionEpochRef = useRef<number | null>(null);
  const compactAbortRef = useRef<AbortController | null>(null);
  const compactingRef = useRef(false);
  const graphMutationRef = useRef(false);
  const topicScopeRef = useRef(topicScope);
  topicScopeRef.current = topicScope;
  const sessionScopeRef = useRef<TopicScope | undefined>(
    isDesktop ? topicScope : undefined,
  );

  const resolveScope = useCallback(
    (explicit?: TopicScope): TopicScope | undefined => {
      if (!isDesktop) return undefined;
      return explicit ?? sessionScopeRef.current ?? topicScopeRef.current;
    },
    [isDesktop],
  );

  const isRunCurrent = useCallback(
    (run: GenerationRun) =>
      run.epoch === epochRef.current &&
      run.connectionEpoch === connectionEpochRef.current,
    [],
  );

  const releaseGeneration = useCallback((run: GenerationRun) => {
    if (run.released) return;
    run.released = true;
    if (activeGenRef.current === run) {
      activeGenRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  const detachStream = useCallback(() => {
    epochRef.current += 1;
    if (activeGenRef.current) {
      const run = activeGenRef.current;
      activeGenRef.current = null;
      run.released = true;
      if (run.detachedAgent) {
        run.detached = true;
      } else {
        run.aborted = true;
      }
      run.ctrl.abort();
      setIsGenerating(false);
    }
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
      loadAbortRef.current = null;
      loadConnectionEpochRef.current = null;
    }
    if (compactAbortRef.current) {
      compactAbortRef.current.abort();
      compactAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (prevConnectionEpochRef.current === connectionEpoch) return;
    prevConnectionEpochRef.current = connectionEpoch;
    const hasFreshLoad =
      loadAbortRef.current !== null &&
      loadConnectionEpochRef.current === connectionEpoch;
    if (hasFreshLoad) {
      if (
        activeGenRef.current &&
        activeGenRef.current.connectionEpoch !== connectionEpoch
      ) {
        const run = activeGenRef.current;
        activeGenRef.current = null;
        run.released = true;
        if (run.detachedAgent) {
          run.detached = true;
        } else {
          run.aborted = true;
        }
        run.ctrl.abort();
        setIsGenerating(false);
      }
      if (compactAbortRef.current) {
        compactAbortRef.current.abort();
        compactAbortRef.current = null;
      }
      return;
    }
    detachStream();
    dispatch({ type: 'CLEAR_SESSION' });
  }, [connectionEpoch, detachStream]);

  useEffect(() => {
    return () => {
      detachStream();
    };
  }, [detachStream]);

  const isBusy =
    state.runState === 'loading' || state.runState === 'streaming' || isGenerating;

  const updateConversationMeta = useCallback((conversation: Conversation) => {
    if (stateRef.current.conversation?.id !== conversation.id) {
      return;
    }
    dispatch({ type: 'UPDATE_CONVERSATION_META', conversation });
  }, []);

  const clearSession = useCallback(() => {
    detachStream();
    dispatch({ type: 'CLEAR_SESSION' });
  }, [detachStream]);

  const reconcileAfterStream = useCallback(
    async (
      conversationId: string,
      epoch: number,
      connEpoch: number,
      opts: {
        isAbort: boolean;
        minExpectedMessages: number;
      },
      reqScope?: TopicScope,
    ) => {
      const isCurrent = () =>
        epoch === epochRef.current &&
        connEpoch === connectionEpochRef.current &&
        stateRef.current.conversation?.id === conversationId &&
        resolveScope() === reqScope;

      const fetchDetail = async () => {
        if (!isCurrent()) return null;
        const detail = await gateway.getConversationDetail(
          conversationId,
          undefined,
          reqScope,
        );
        if (!isCurrent()) return null;
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
          if (!isCurrent()) return;
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
        markConversationRunning(
          detail.conversation.id,
          Boolean(detail.activeRun || detail.conversation.running),
          reqScope,
        );
        upsertLocalConversation(detail.conversation, reqScope);
      } catch {
        if (!isCurrent()) return;
        if (opts.isAbort) {
          dispatch({ type: 'MARK_NEEDS_RELOAD' });
        }
      }
    },
    [gateway, markConversationRunning, resolveScope, upsertLocalConversation],
  );

  const attachActiveRun = useCallback(
    async (activeRun: ActiveRunInfo, reqScope?: TopicScope): Promise<void> => {
      const epoch = epochRef.current;
      const ctrl = new AbortController();
      const run: GenerationRun = {
        id: ++runSeqRef.current,
        epoch,
        connectionEpoch: connectionEpochRef.current,
        conversationId: activeRun.conversationId,
        scope: reqScope,
        ctrl,
        detachedAgent: true,
        detached: false,
        aborted: false,
        released: false,
      };
      activeGenRef.current = run;
      setIsGenerating(true);
      markConversationRunning(activeRun.conversationId, true, reqScope);
      dispatch({ type: 'ATTACH_RUN_START', run: activeRun });

      let response: Response;
      try {
        response = await gateway.openRunStream(
          activeRun.conversationId,
          ctrl.signal,
          reqScope,
        );
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run) || run.detached) return;
        if (isAbortError(err) || run.aborted) {
          markConversationRunning(activeRun.conversationId, false, reqScope);
          dispatch({ type: 'ABORT_LOCAL' });
          void reconcileAfterStream(
            activeRun.conversationId,
            run.epoch,
            run.connectionEpoch,
            { isAbort: true, minExpectedMessages: 0 },
            reqScope,
          );
          return;
        }
        const e = formatError(err);
        dispatch({ type: 'STREAM_NETWORK_ERROR', code: e.code, message: e.message });
        return;
      }

      if (!isRunCurrent(run) || run.detached) {
        await response.body?.cancel().catch(() => {});
        releaseGeneration(run);
        return;
      }

      if (response.status === 204) {
        releaseGeneration(run);
        markConversationRunning(activeRun.conversationId, false, reqScope);
        void reconcileAfterStream(
          activeRun.conversationId,
          run.epoch,
          run.connectionEpoch,
          { isAbort: false, minExpectedMessages: 0 },
          reqScope,
        );
        return;
      }

      run.streamOpened = true;
      let receivedMessageEnd = false;
      let receivedStreamError = false;
      let receivedRolledBack = false;
      try {
        if (!response.body) {
          throw new GatewayError('STREAM_EMPTY', '服务端未返回事件流');
        }
        for await (const frame of decodeSseByteStream(response.body)) {
          if (!isRunCurrent(run) || run.detached) break;
          let ev;
          try {
            ev = parseStreamEventFrame(frame);
          } catch {
            continue;
          }
          if (!ev) continue;

          if (ev.type === 'message_end') {
            receivedMessageEnd = true;
            if (ev.rolledBack) receivedRolledBack = true;
          }
          if (ev.type === 'error') {
            receivedStreamError = true;
            if (ev.rolledBack) receivedRolledBack = true;
          }

          dispatch({
            type: 'STREAM_EVENT',
            event: ev,
            fallbackProviderId: activeRun.providerId,
            fallbackModelId: activeRun.modelId,
          });

          if (ev.type === 'error' || ev.type === 'message_end') {
            break;
          }
        }

        releaseGeneration(run);
        if (!isRunCurrent(run) || run.detached) return;

        markConversationRunning(activeRun.conversationId, false, reqScope);
        if (receivedRolledBack) return;
        if (receivedMessageEnd) {
          void reconcileAfterStream(
            activeRun.conversationId,
            run.epoch,
            run.connectionEpoch,
            { isAbort: false, minExpectedMessages: 0 },
            reqScope,
          );
          return;
        }
        if (run.aborted) {
          dispatch({ type: 'ABORT_LOCAL' });
          void reconcileAfterStream(
            activeRun.conversationId,
            run.epoch,
            run.connectionEpoch,
            { isAbort: true, minExpectedMessages: 0 },
            reqScope,
          );
          return;
        }
        if (receivedStreamError) {
          void reconcileAfterStream(
            activeRun.conversationId,
            run.epoch,
            run.connectionEpoch,
            { isAbort: false, minExpectedMessages: 0 },
            reqScope,
          );
          return;
        }
        dispatch({ type: 'STREAM_EOF_INCOMPLETE' });
        void reconcileAfterStream(
          activeRun.conversationId,
          run.epoch,
          run.connectionEpoch,
          { isAbort: false, minExpectedMessages: 0 },
          reqScope,
        );
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run) || run.detached) return;
        if (isAbortError(err) || run.aborted) {
          markConversationRunning(activeRun.conversationId, false, reqScope);
          dispatch({ type: 'ABORT_LOCAL' });
          void reconcileAfterStream(
            activeRun.conversationId,
            run.epoch,
            run.connectionEpoch,
            { isAbort: true, minExpectedMessages: 0 },
            reqScope,
          );
          return;
        }
        const e = formatError(err);
        dispatch({ type: 'STREAM_NETWORK_ERROR', code: e.code, message: e.message });
        void reconcileAfterStream(
          activeRun.conversationId,
          run.epoch,
          run.connectionEpoch,
          { isAbort: false, minExpectedMessages: 0 },
          reqScope,
        );
      } finally {
        releaseGeneration(run);
      }
    },
    [gateway, isRunCurrent, markConversationRunning, reconcileAfterStream, releaseGeneration],
  );

  const loadConversation = useCallback(
    async (
      conversationId: string,
      explicitScope?: TopicScope,
    ): Promise<ConversationDetail | null> => {
      detachStream();
      const reqScope = isDesktop ? (explicitScope ?? topicScopeRef.current) : undefined;
      if (sessionScopeRef.current !== reqScope) dispatch({ type: 'CLEAR_SESSION' });
      sessionScopeRef.current = reqScope;
      const epoch = ++epochRef.current;
      const ctrl = new AbortController();
      loadAbortRef.current = ctrl;
      loadConnectionEpochRef.current = connectionEpochRef.current;
      dispatch({ type: 'LOAD_START', conversationId });
      try {
        const detail = await gateway.getConversationDetail(
          conversationId,
          ctrl.signal,
          reqScope,
        );
        if (epoch !== epochRef.current) return null;
        dispatch({
          type: 'LOAD_SUCCESS',
          conversation: detail.conversation,
          messages: detail.messages,
        });
        markConversationRunning(
          detail.conversation.id,
          Boolean(detail.activeRun || detail.conversation.running),
          reqScope,
        );
        upsertLocalConversation(detail.conversation, reqScope);
        if (detail.activeRun && epoch === epochRef.current) {
          void attachActiveRun(detail.activeRun, reqScope);
        }
        return detail;
      } catch (err) {
        if (epoch !== epochRef.current || isAbortError(err)) return null;
        const e = formatError(err);
        dispatch({ type: 'LOAD_ERROR', code: e.code, message: e.message });
        return null;
      } finally {
        if (loadAbortRef.current === ctrl) {
          loadAbortRef.current = null;
          loadConnectionEpochRef.current = null;
        }
      }
    },
    [attachActiveRun, detachStream, gateway, isDesktop, markConversationRunning, upsertLocalConversation],
  );

  const executeStream = useCallback(
    async (opts: {
      conversationId: string;
      scope?: TopicScope;
      input: {
        blocks?: ContentBlock[];
        text?: string;
        providerId: string;
        modelId: string;
        params?: GenerationParams;
        regenerateMessageId?: string;
        mcpToolsEnabled?: boolean;
        webSearch?: boolean;
        searchEngineId?: string;
      };
      optimisticUserId?: string;
      regenerateTargetId?: string;
      expectedCountOnAbort: number;
      run: GenerationRun;
      placeholderAssistantId: string;
      onPrepareRollback?: () => void;
      onStreamAccepted?: () => void;
    }): Promise<boolean> => {
      const { run } = opts;
      const reqScope = opts.scope;

      let response: Response;
      if (run.detachedAgent) {
        markConversationRunning(opts.conversationId, true, reqScope);
      }
      try {
        response = await gateway.openChatStream(
          opts.conversationId,
          opts.input,
          run.ctrl.signal,
          reqScope,
        );
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run) || run.detached) return false;

        if (
          run.detachedAgent &&
          err instanceof GatewayError &&
          (err.code === 'CONFLICT' || err.statusCode === 409)
        ) {
          if (opts.optimisticUserId) {
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: opts.optimisticUserId,
            });
            opts.onPrepareRollback?.();
          }
          void loadConversation(opts.conversationId, reqScope);
          return false;
        }

        if (run.detachedAgent) {
          markConversationRunning(opts.conversationId, false, reqScope);
        }

        if (isAbortError(err) && run.aborted) {
          if (opts.optimisticUserId) {
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: opts.optimisticUserId,
            });
            opts.onPrepareRollback?.();
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
          opts.onPrepareRollback?.();
        } else {
          dispatch({
            type: 'REGEN_PREPARE_FAILED',
            code: e.code,
            message: e.message,
          });
        }
        return false;
      }

      if (!isRunCurrent(run) || run.detached || (!run.detachedAgent && (run.aborted || run.ctrl.signal.aborted))) {
        await response.body?.cancel().catch(() => {});
        releaseGeneration(run);
        if (isRunCurrent(run) && !run.detached && run.aborted) {
          if (opts.optimisticUserId) {
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: opts.optimisticUserId,
            });
            opts.onPrepareRollback?.();
          } else {
            dispatch({ type: 'ABORT_LOCAL' });
          }
        }
        return false;
      }

      // HTTP 200 only proves the upstream accepted the request; for a new send the
      // user prompt is persisted lazily at the first substantive assistant block.
      run.streamOpened = true;
      const isNewSend = Boolean(opts.optimisticUserId);
      let hasAssistantOutput = false;
      let streamAccepted = false;
      const acceptStream = () => {
        if (streamAccepted) return;
        streamAccepted = true;
        opts.onStreamAccepted?.();
      };
      if (!isNewSend) {
        dispatch({
          type: 'REGEN_PREPARE_CONFIRMED',
          targetMessageId: opts.regenerateTargetId as string,
        });
        acceptStream();
      }

      let receivedMessageEnd = false;
      let receivedStreamError = false;
      let rolledBackError: { code: string; message: string } | null = null;
      let rolledBackAbort = false;

      try {
        if (!response.body) {
          throw new GatewayError('STREAM_EMPTY', '服务端未返回事件流');
        }
        for await (const frame of decodeSseByteStream(response.body)) {
          if (!isRunCurrent(run) || run.detached || (!run.detachedAgent && run.aborted)) break;
          let ev;
          try {
            ev = parseStreamEventFrame(frame);
          } catch {
            continue;
          }
          if (!ev) continue;

          if (ev.type === 'message_end') {
            receivedMessageEnd = true;
            if (ev.rolledBack && isNewSend && !hasAssistantOutput) {
              rolledBackAbort = true;
              break;
            }
            if (!ev.rolledBack) acceptStream();
          }
          if (ev.type === 'error') {
            receivedStreamError = true;
            if (isNewSend && (ev.rolledBack || !hasAssistantOutput)) {
              rolledBackError = {
                code: ev.error?.code || 'UPSTREAM_ERROR',
                message: ev.error?.message || '流式生成失败',
              };
              break;
            }
          }

          dispatch({
            type: 'STREAM_EVENT',
            event: ev,
            fallbackProviderId: opts.input.providerId,
            fallbackModelId: opts.input.modelId,
          });

          if (isSubstantiveAssistantEvent(ev)) {
            hasAssistantOutput = true;
            acceptStream();
          }

          if (ev.type === 'error' || (run.detachedAgent && ev.type === 'message_end')) {
            break;
          }
        }

        releaseGeneration(run);
        if (!isRunCurrent(run) || run.detached) return false;

        if (run.detachedAgent) {
          markConversationRunning(opts.conversationId, false, reqScope);
        }

        if (
          rolledBackAbort ||
          (run.aborted && isNewSend && !hasAssistantOutput && !receivedMessageEnd)
        ) {
          dispatch({
            type: 'SEND_PREPARE_ABORTED',
            optimisticUserId: opts.optimisticUserId as string,
          });
          opts.onPrepareRollback?.();
          return false;
        }

        if (
          rolledBackError ||
          ((receivedStreamError || !receivedMessageEnd) && isNewSend && !hasAssistantOutput)
        ) {
          const code = rolledBackError?.code ?? (receivedStreamError ? 'UPSTREAM_ERROR' : 'STREAM_INCOMPLETE');
          const message = rolledBackError?.message ?? (receivedStreamError ? '流式生成失败' : '响应流意外中断，未收到结束标记');
          dispatch({
            type: 'SEND_PREPARE_FAILED',
            optimisticUserId: opts.optimisticUserId as string,
            code,
            message,
          });
          opts.onPrepareRollback?.();
          return false;
        }

        if (run.aborted && !receivedMessageEnd) {
          dispatch({ type: 'ABORT_LOCAL' });
          void reconcileAfterStream(
            opts.conversationId,
            run.epoch,
            run.connectionEpoch,
            {
              isAbort: true,
              minExpectedMessages: opts.expectedCountOnAbort,
            },
            reqScope,
          );
          return false;
        }

        if (receivedStreamError) {
          void reconcileAfterStream(
            opts.conversationId,
            run.epoch,
            run.connectionEpoch,
            {
              isAbort: false,
              minExpectedMessages: 0,
            },
            reqScope,
          );
          return false;
        }

        if (!receivedMessageEnd) {
          dispatch({ type: 'STREAM_EOF_INCOMPLETE' });
          if (!run.detachedAgent) {
            void reconcileAfterStream(
              opts.conversationId,
              run.epoch,
              run.connectionEpoch,
              {
                isAbort: true,
                minExpectedMessages: opts.expectedCountOnAbort,
              },
              reqScope,
            );
          }
          return false;
        }

        // Sync real server IDs (user + assistant) & updated title/timestamps in background without blocking next send.
        void reconcileAfterStream(
          opts.conversationId,
          run.epoch,
          run.connectionEpoch,
          {
            isAbort: false,
            minExpectedMessages: opts.expectedCountOnAbort,
          },
          reqScope,
        );
        return !run.aborted;
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run) || run.detached) return false;
        if (run.detachedAgent) {
          markConversationRunning(opts.conversationId, false, reqScope);
        }
        if (isAbortError(err) || run.aborted) {
          if (isNewSend && !hasAssistantOutput && !receivedMessageEnd) {
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: opts.optimisticUserId as string,
            });
            opts.onPrepareRollback?.();
            return false;
          }
          dispatch({ type: 'ABORT_LOCAL' });
          void reconcileAfterStream(
            opts.conversationId,
            run.epoch,
            run.connectionEpoch,
            {
              isAbort: true,
              minExpectedMessages: opts.expectedCountOnAbort,
            },
            reqScope,
          );
          return false;
        }
        const e = formatError(err);
        if (isNewSend && !hasAssistantOutput) {
          dispatch({
            type: 'SEND_PREPARE_FAILED',
            optimisticUserId: opts.optimisticUserId as string,
            code: e.code,
            message: e.message,
          });
          opts.onPrepareRollback?.();
          return false;
        }
        dispatch({
          type: 'STREAM_NETWORK_ERROR',
          code: e.code,
          message: e.message,
        });
        if (!run.detachedAgent) {
          void reconcileAfterStream(
            opts.conversationId,
            run.epoch,
            run.connectionEpoch,
            {
              isAbort: true,
              minExpectedMessages: opts.expectedCountOnAbort,
            },
            reqScope,
          );
        }
        return false;
      } finally {
        releaseGeneration(run);
      }
    },
    [gateway, isRunCurrent, loadConversation, markConversationRunning, reconcileAfterStream, releaseGeneration],
  );

  const executeLocalStream = useCallback(
    (opts: LocalStreamRunOptions): Promise<boolean> =>
      runLocalChatStream(
        {
          gateway,
          providers: resources.providers,
          mcpMaxToolRounds,
          dispatch,
          isRunCurrent,
          releaseGeneration,
          reconcileAfterStream,
          upsertLocalConversation,
          toast,
        },
        opts,
      ),
    [
      gateway,
      isRunCurrent,
      mcpMaxToolRounds,
      reconcileAfterStream,
      releaseGeneration,
      resources.providers,
      toast,
      upsertLocalConversation,
    ],
  );

  const sendMessage = useCallback(
    async (opts: SendMessageOptions): Promise<boolean> => {
      if (
        activeGenRef.current ||
        compactingRef.current ||
        (opts.blocks.length === 0 && !opts.text?.trim())
      ) {
        return false;
      }
      const epoch = ++epochRef.current;
      const ctrl = new AbortController();
      const reqScope = resolveScope(opts.scope);
      sessionScopeRef.current = reqScope;
      const run: GenerationRun = {
        id: ++runSeqRef.current,
        epoch,
        connectionEpoch: connectionEpochRef.current,
        conversationId: opts.conversationId ?? '',
        scope: reqScope,
        ctrl,
        detachedAgent: false,
        detached: false,
        aborted: false,
        released: false,
      };
      activeGenRef.current = run;
      setIsGenerating(true);

      const optimisticId = `local-user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const placeholderAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
          conversationId: opts.conversationId ?? '',
          role: 'user',
          blocks: opts.blocks,
          createdAt: new Date().toISOString(),
        },
        providerId: opts.providerId,
        modelId: opts.modelId,
        placeholderAssistantId,
      });
      opts.onOptimisticStart?.();

      let mode = opts.conversationMode ?? stateRef.current.conversation?.mode;
      let ephemeral = Boolean(
        opts.conversation?.ephemeral ?? stateRef.current.conversation?.ephemeral,
      );
      let targetConvId = opts.conversationId ?? '';
      if (!targetConvId) {
        if (!opts.ensureConversation) {
          releaseGeneration(run);
          dispatch({
            type: 'SEND_PREPARE_FAILED',
            optimisticUserId: optimisticId,
            code: 'INVALID_ARGUMENT',
            message: '缺少会话标识',
          });
          opts.onPrepareRollback?.();
          return false;
        }
        try {
          const created = await opts.ensureConversation(ctrl.signal);
          if (!isRunCurrent(run)) {
            releaseGeneration(run);
            return false;
          }
          if (!created || run.aborted || ctrl.signal.aborted) {
            releaseGeneration(run);
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: optimisticId,
            });
            opts.onPrepareRollback?.();
            return false;
          }
          targetConvId = created.id;
          mode = created.mode ?? mode;
          ephemeral = Boolean(created.ephemeral);
          run.conversationId = targetConvId;
          dispatch({
            type: 'UPDATE_CONVERSATION_META',
            conversation: created,
          });
        } catch (err) {
          releaseGeneration(run);
          if (!isRunCurrent(run)) return false;

          if (isAbortError(err) && run.aborted) {
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: optimisticId,
            });
          } else {
            const e = formatError(err);
            dispatch({
              type: 'SEND_PREPARE_FAILED',
              optimisticUserId: optimisticId,
              code: e.code,
              message: e.message,
            });
          }
          opts.onPrepareRollback?.();
          return false;
        }
      }

      const useBrowserLocalRequest =
        !isDesktop &&
        mode !== 'agent' &&
        Boolean(
          resources.providers.find((p) => p.id === opts.providerId)?.localRequest,
        );
      run.detachedAgent = !useBrowserLocalRequest && mode === 'agent' && !ephemeral;
      const streamRunner = useBrowserLocalRequest ? executeLocalStream : executeStream;
      return streamRunner({
        conversationId: targetConvId,
        scope: reqScope,
        input: {
          blocks: opts.blocks,
          text: opts.text,
          providerId: opts.providerId,
          modelId: opts.modelId,
          params: opts.params,
          mcpToolsEnabled: opts.mcpToolsEnabled,
          webSearch: opts.webSearch,
          searchEngineId: opts.searchEngineId,
        },
        optimisticUserId: optimisticId,
        expectedCountOnAbort: expectedAfterAbort,
        run,
        placeholderAssistantId,
        onPrepareRollback: opts.onPrepareRollback,
        onStreamAccepted: opts.onStreamAccepted,
      });
    },
    [
      executeLocalStream,
      executeStream,
      isDesktop,
      isRunCurrent,
      releaseGeneration,
      resolveScope,
      resources.providers,
    ],
  );

  const regenerateMessage = useCallback(
    async (opts: RegenerateOptions): Promise<boolean> => {
      const conv = stateRef.current.conversation;
      if (!conv || activeGenRef.current || compactingRef.current) return false;
      if (isLocalMessageId(opts.targetMessageId)) {
        toast('请先重新加载以获取服务端消息 ID', 'error');
        return false;
      }
      const path = activeChatMessages(stateRef.current);
      const idx = path.findIndex((m) => m.id === opts.targetMessageId);
      if (idx < 0) return false;
      const isReplacing = path[idx].role !== 'user' || path[idx + 1]?.role === 'assistant';
      const expectedCountOnAbort = isReplacing
        ? stateRef.current.messages.length
        : stateRef.current.messages.length + 1;

      const epoch = ++epochRef.current;
      const ctrl = new AbortController();
      const reqScope = resolveScope(opts.scope);
      sessionScopeRef.current = reqScope;
      const useBrowserLocalRequest =
        !isDesktop &&
        conv.mode !== 'agent' &&
        Boolean(
          resources.providers.find((p) => p.id === opts.providerId)?.localRequest,
        );
      const run: GenerationRun = {
        id: ++runSeqRef.current,
        epoch,
        connectionEpoch: connectionEpochRef.current,
        conversationId: conv.id,
        scope: reqScope,
        ctrl,
        detachedAgent: !useBrowserLocalRequest && conv.mode === 'agent' && !conv.ephemeral,
        detached: false,
        aborted: false,
        released: false,
      };
      activeGenRef.current = run;
      setIsGenerating(true);
      const placeholderAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      dispatch({
        type: 'REGEN_PREPARE_START',
        targetMessageId: opts.targetMessageId,
        providerId: opts.providerId,
        modelId: opts.modelId,
        placeholderAssistantId,
      });

      const streamRunner = useBrowserLocalRequest ? executeLocalStream : executeStream;
      return streamRunner({
        conversationId: conv.id,
        scope: reqScope,
        input: {
          providerId: opts.providerId,
          modelId: opts.modelId,
          params: opts.params,
          regenerateMessageId: opts.targetMessageId,
          mcpToolsEnabled: opts.mcpToolsEnabled,
          webSearch: opts.webSearch,
          searchEngineId: opts.searchEngineId,
        },
        regenerateTargetId: opts.targetMessageId,
        expectedCountOnAbort,
        run,
        placeholderAssistantId,
      });
    },
    [
      executeLocalStream,
      executeStream,
      isDesktop,
      resolveScope,
      resources.providers,
      toast,
    ],
  );

  const stopStreaming = useCallback(() => {
    const run = activeGenRef.current;
    if (!run) return;
    if (run.detachedAgent && run.conversationId) {
      if (run.aborted) return;
      run.aborted = true;
      void gateway.cancelConversationRun(run.conversationId, run.scope).catch(() => {});
      if (!run.streamOpened) {
        run.ctrl.abort();
        return;
      }
      window.setTimeout(() => {
        if (activeGenRef.current === run && !run.ctrl.signal.aborted) {
          run.ctrl.abort();
        }
      }, 2500);
      return;
    }
    run.aborted = true;
    run.ctrl.abort();
  }, [gateway]);

  const reloadCurrentConversation = useCallback(async () => {
    const convId = stateRef.current.conversation?.id;
    if (!convId || isBusy) return;
    await loadConversation(convId, resolveScope());
  }, [isBusy, loadConversation, resolveScope]);

  const updateMessage = useCallback(
    async (
      messageId: string,
      blocks: ContentBlock[],
      scope?: TopicScope,
    ): Promise<boolean> => {
      const conv = stateRef.current.conversation;
      const reqScope = resolveScope(scope);
      if (!conv || activeGenRef.current || compactingRef.current || reqScope !== resolveScope()) return false;
      const epoch = epochRef.current;
      const connection = connectionEpochRef.current;
      const isCurrent = () =>
        epoch === epochRef.current && connection === connectionEpochRef.current &&
        stateRef.current.conversation?.id === conv.id && reqScope === resolveScope();
      if (isLocalMessageId(messageId)) {
        toast('该消息尚未确认落盘，请先重新加载', 'error');
        return false;
      }
      try {
        const updated = await gateway.updateMessage(
          conv.id,
          messageId,
          blocks,
          undefined,
          reqScope,
        );
        if (!isCurrent()) return false;
        dispatch({ type: 'UPDATE_MESSAGE', message: updated });
        return true;
      } catch (err) {
        if (isCurrent()) toast(formatError(err).message, 'error');
        return false;
      }
    },
    [gateway, resolveScope, toast],
  );

  const deleteMessage = useCallback(
    async (messageId: string, scope?: TopicScope): Promise<boolean> => {
      const conv = stateRef.current.conversation;
      if (!conv || activeGenRef.current || compactingRef.current) return false;
      if (isLocalMessageId(messageId)) {
        toast('该消息尚未确认落盘，请先重新加载', 'error');
        return false;
      }
      try {
        await gateway.deleteMessage(
          conv.id,
          messageId,
          undefined,
          resolveScope(scope),
        );
        if (conv.graphState?.enabled) {
          const reqScope = resolveScope(scope);
          const epoch = epochRef.current;
          const detail = await gateway.getConversationDetail(conv.id, undefined, reqScope);
          if (epoch === epochRef.current && stateRef.current.conversation?.id === conv.id && resolveScope() === reqScope) {
            dispatch({ type: 'RECONCILE_DETAIL', ...detail });
            upsertLocalConversation(detail.conversation, reqScope);
          }
        } else {
          dispatch({ type: 'REMOVE_MESSAGE', messageId });
        }
        return true;
      } catch (err) {
        toast(formatError(err).message, 'error');
        return false;
      }
    },
    [gateway, resolveScope, toast, upsertLocalConversation],
  );

  const branchFromMessage = useCallback(
    async (messageId: string, scope?: TopicScope) => {
      const conv = stateRef.current.conversation;
      if (!conv || activeGenRef.current || compactingRef.current) return null;
      if (isLocalMessageId(messageId)) {
        toast('该消息尚未确认落盘，请先重新加载', 'error');
        return null;
      }
      const reqScope = resolveScope(scope);
      try {
        const detail = await gateway.branchConversation(
          conv.id,
          messageId,
          undefined,
          reqScope,
        );
        upsertLocalConversation(detail.conversation, reqScope);
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
    [gateway, resolveScope, toast, upsertLocalConversation],
  );

  const compactConversation = useCallback(
    async (opts: {
      providerId: string;
      modelId: string;
      scope?: TopicScope;
    }): Promise<CompactConversationResult> => {
      const conv = stateRef.current.conversation;
      const runState = stateRef.current.runState;
      if (
        !conv ||
        activeGenRef.current ||
        compactingRef.current ||
        runState === 'loading' ||
        runState === 'streaming'
      ) {
        return { ok: false, error: '当前状态不可压缩对话' };
      }

      const reqScope = resolveScope(opts.scope);
      const epoch = epochRef.current;
      const ctrl = new AbortController();
      compactingRef.current = true;
      compactAbortRef.current = ctrl;
      setIsCompacting(true);

      try {
        return await runCompactConversation(
          {
            gateway,
            isDesktop,
            providers: resources.providers,
            conversation: conv,
            getMessages: () => stateRef.current.messages,
            reqScope,
            epoch,
            getCurrentEpoch: () => epochRef.current,
            signal: ctrl.signal,
            dispatch,
            upsertLocalConversation,
          },
          {
            providerId: opts.providerId,
            modelId: opts.modelId,
          },
        );
      } finally {
        compactingRef.current = false;
        setIsCompacting(false);
        if (compactAbortRef.current === ctrl) {
          compactAbortRef.current = null;
        }
      }
    },
    [
      gateway,
      isDesktop,
      resolveScope,
      resources.providers,
      upsertLocalConversation,
    ],
  );

  const applyBranchedDetail = useCallback(
    (detail: ConversationDetail, scope?: TopicScope) => {
      detachStream();
      const reqScope = resolveScope(scope);
      sessionScopeRef.current = reqScope;
      upsertLocalConversation(detail.conversation, reqScope);
      dispatch({
        type: 'LOAD_SUCCESS',
        conversation: detail.conversation,
        messages: detail.messages,
      });
    },
    [detachStream, resolveScope, upsertLocalConversation],
  );

  const mutateGraph = useCallback(async (input: GraphMutationInput, scope?: TopicScope) => {
    const conversation = stateRef.current.conversation;
    if (!conversation || activeGenRef.current || compactingRef.current || graphMutationRef.current) return null;
    graphMutationRef.current = true;
    const reqScope = resolveScope(scope);
    const epoch = ++epochRef.current;
    const connection = connectionEpochRef.current;
    const isCurrent = () => epochRef.current === epoch && connectionEpochRef.current === connection && stateRef.current.conversation?.id === conversation.id && resolveScope() === reqScope;
    try {
      const detail = await gateway.mutateConversationGraph(conversation.id, input, undefined, reqScope);
      if (!isCurrent()) return null;
      dispatch({ type: 'RECONCILE_DETAIL', ...detail });
      upsertLocalConversation(detail.conversation, reqScope);
      return detail;
    } catch (err) {
      if (isCurrent()) toast(formatError(err).message, 'error');
      return null;
    } finally {
      graphMutationRef.current = false;
    }
  }, [gateway, resolveScope, toast, upsertLocalConversation]);
  const activeMessages = useMemo(() => activeChatMessages(state), [state.conversation, state.messages, state.streaming?.graphTarget, Boolean(state.streaming)]);
  const sessionScope = sessionScopeRef.current;
  const value = useMemo<ChatContextValue>(
    () => ({
      state,
      activeMessages,
      mutateGraph,
      sessionScope,
      isBusy,
      isGenerating,
      isCompacting,
      updateConversationMeta,
      clearSession,
      loadConversation,
      reloadCurrentConversation,
      sendMessage,
      regenerateMessage,
      compactConversation,
      updateMessage,
      deleteMessage,
      branchFromMessage,
      applyBranchedDetail,
      detachStream,
      stopStreaming,
    }),
    [
      state,
      activeMessages,
      mutateGraph,
      sessionScope,
      isBusy,
      isGenerating,
      isCompacting,
      updateConversationMeta,
      clearSession,
      loadConversation,
      reloadCurrentConversation,
      sendMessage,
      regenerateMessage,
      compactConversation,
      updateMessage,
      deleteMessage,
      branchFromMessage,
      applyBranchedDetail,
      detachStream,
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
