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
import { decodeUpstreamSseStream } from '../../core/localStreamDecoders';
import { decodeSseByteStream, parseStreamEventFrame } from '../../core/sse';
import type {
  CompactionMeta,
  ContentBlock,
  Conversation,
  ConversationMode,
  ConversationDetail,
  GenerationParams,
  GraphMutationInput,
  LocalCacheResultData,
  Message,
  PreparedLocalHTTPRequest,
  PreparedLocalRequest,
  PreparedSearchInput,
  ProviderConfig,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
  ToolCallBlock,
  TopicScope,
} from '../../core/types';
import {
  activeChatMessages,
  bufferToBlock,
  chatReducer,
  initialChatState,
  isLocalMessageId,
  type ChatState,
  type StreamingBlockBuffer,
} from './chatReducer';
import { estimateCompactionAfterTokens } from '../workbench/contextUsage';

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

export interface CompactConversationResult {
  ok: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  error?: string;
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

function extractSafeCacheResult(
  status: number,
  rawText: string,
): LocalCacheResultData {
  const out: LocalCacheResultData = {};
  try {
    const parsed = JSON.parse(rawText) as {
      name?: unknown;
      expireTime?: unknown;
      error?: { code?: unknown; status?: unknown; message?: unknown };
      message?: unknown;
    };
    if (status >= 200 && status < 300) {
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        out.name = parsed.name.trim();
      }
      if (typeof parsed.expireTime === 'string' && parsed.expireTime.trim()) {
        out.expireTime = parsed.expireTime.trim();
      }
      return out;
    }
    const errObj = parsed.error;
    if (errObj && typeof errObj === 'object') {
      if (typeof errObj.status === 'string' && errObj.status) {
        out.errorCode = errObj.status;
      } else if (
        typeof errObj.code === 'number' ||
        typeof errObj.code === 'string'
      ) {
        out.errorCode = String(errObj.code);
      }
      if (typeof errObj.message === 'string' && errObj.message) {
        out.errorMessage = errObj.message.slice(0, 500);
      }
    } else if (typeof parsed.message === 'string' && parsed.message) {
      out.errorMessage = parsed.message.slice(0, 500);
    }
  } catch {
    if (status >= 400 && rawText.trim()) {
      out.errorMessage = rawText.trim().slice(0, 500);
    }
  }
  return out;
}

interface GenerationRun {
  id: number;
  epoch: number;
  connectionEpoch: number;
  conversationId: string;
  scope: TopicScope | undefined;
  ctrl: AbortController;
  aborted: boolean;
  released: boolean;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const {
    gateway,
    isDesktop,
    topicScope,
    resources,
    settings: { mcpMaxToolRounds },
    connectionEpoch,
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

  const cancelActiveStream = useCallback((_quiet: boolean) => {
    epochRef.current += 1;
    if (activeGenRef.current) {
      const run = activeGenRef.current;
      activeGenRef.current = null;
      run.released = true;
      run.aborted = true;
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
        run.aborted = true;
        run.ctrl.abort();
        setIsGenerating(false);
      }
      if (compactAbortRef.current) {
        compactAbortRef.current.abort();
        compactAbortRef.current = null;
      }
      return;
    }
    cancelActiveStream(true);
    dispatch({ type: 'CLEAR_SESSION' });
  }, [connectionEpoch, cancelActiveStream]);

  useEffect(() => {
    return () => {
      cancelActiveStream(true);
    };
  }, [cancelActiveStream]);

  const isBusy =
    state.runState === 'loading' || state.runState === 'streaming' || isGenerating;

  const updateConversationMeta = useCallback((conversation: Conversation) => {
    if (stateRef.current.conversation?.id !== conversation.id) {
      return;
    }
    dispatch({ type: 'UPDATE_CONVERSATION_META', conversation });
  }, []);

  const clearSession = useCallback(() => {
    cancelActiveStream(true);
    dispatch({ type: 'CLEAR_SESSION' });
  }, [cancelActiveStream]);

  const loadConversation = useCallback(
    async (
      conversationId: string,
      explicitScope?: TopicScope,
    ): Promise<ConversationDetail | null> => {
      cancelActiveStream(true);
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
        upsertLocalConversation(detail.conversation, reqScope);
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
    [cancelActiveStream, gateway, isDesktop, upsertLocalConversation],
  );

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
        upsertLocalConversation(detail.conversation, reqScope);
      } catch {
        if (!isCurrent()) return;
        if (opts.isAbort) {
          dispatch({ type: 'MARK_NEEDS_RELOAD' });
        }
      }
    },
    [gateway, resolveScope, upsertLocalConversation],
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
      try {
        response = await gateway.openChatStream(
          opts.conversationId,
          opts.input,
          run.ctrl.signal,
          reqScope,
        );
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run)) return false;

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

      if (!isRunCurrent(run) || run.aborted || run.ctrl.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        releaseGeneration(run);
        if (isRunCurrent(run) && run.aborted) {
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

      // Prepare succeeded (HTTP 200): server has persisted user message or accepted regenerated tail.
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
          if (!isRunCurrent(run) || run.aborted) break;
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

        releaseGeneration(run);
        if (!isRunCurrent(run)) return false;

        if (run.aborted) {
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
          return false;
        }

        if (!receivedMessageEnd) {
          dispatch({ type: 'STREAM_EOF_INCOMPLETE' });
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
        return true;
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run)) return false;
        if (isAbortError(err) || run.aborted) {
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
        dispatch({
          type: 'STREAM_NETWORK_ERROR',
          code: e.code,
          message: e.message,
        });
        return false;
      } finally {
        releaseGeneration(run);
      }
    },
    [gateway, isRunCurrent, reconcileAfterStream, releaseGeneration],
  );

  const sendLocalHttpFetch = useCallback(
    async (
      preparedReq: PreparedLocalHTTPRequest,
      _provider: ProviderConfig | undefined,
      _providerId: string,
      signal: AbortSignal,
    ): Promise<Response> => {
      const serializedBody =
        typeof preparedReq.body === 'string'
          ? preparedReq.body
          : JSON.stringify(preparedReq.body ?? {});

      try {
        // The gateway already bound the saved credential to this request envelope.
        return await gateway.fetchImpl(preparedReq.url, {
          method: preparedReq.method || 'POST',
          headers: preparedReq.headers ?? {},
          body: serializedBody,
          signal,
        });
      } catch (fetchErr) {
        if (isAbortError(fetchErr)) throw fetchErr;
        if (fetchErr instanceof TypeError) {
          throw new GatewayError(
            'LOCAL_NETWORK_ERROR',
            '无法直连本地模型服务，请检查服务是否启动并已开启 CORS 跨域支持',
          );
        }
        throw fetchErr;
      }
    },
    [gateway],
  );

  const prepareAndOpenLocalUpstream = useCallback(
    async (
      conversationId: string,
      baseInput: StreamChatInput,
      provider: ProviderConfig | undefined,
      providerId: string,
      searchTracker: { settled: boolean; block: ContentBlock | null },
      signal: AbortSignal,
    ): Promise<{ prepared: PreparedLocalRequest; response: Response }> => {
      const buildInput = (extra?: Partial<StreamChatInput>): StreamChatInput => ({
        ...baseInput,
        // Direct requests carry the gateway-bound credential instead of a browser key.
        credentialEnvelope: true,
        ...(searchTracker.settled
          ? { preparedSearch: { block: searchTracker.block } satisfies PreparedSearchInput }
          : {}),
        ...extra,
      });

      let prepared = await gateway.prepareLocalChat(
        conversationId,
        buildInput(),
        signal,
      );
      if (!searchTracker.settled) {
        searchTracker.settled = true;
        searchTracker.block = prepared.webSearchBlock ?? null;
      }

      if (prepared.cacheStep) {
        const cacheRes = await sendLocalHttpFetch(
          prepared.cacheStep.request,
          provider,
          providerId,
          signal,
        );
        const rawText = await cacheRes.text().catch(() => '');
        const safeResult = extractSafeCacheResult(cacheRes.status, rawText);
        prepared = await gateway.prepareLocalChat(
          conversationId,
          buildInput({
            cacheResolution: {
              planKey: prepared.cacheStep.planKey,
              status: cacheRes.status,
              result: safeResult,
            },
          }),
          signal,
        );
      }

      // The gateway owns the reusable cache state; this request only reports the
      // state it executed plus any rejection so the gateway can classify both.
      let mainRes = await sendLocalHttpFetch(
        prepared,
        provider,
        providerId,
        signal,
      );
      if (!mainRes.ok) {
        const snippet = await mainRes.text().catch(() => '');
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const retry = await gateway
          .prepareLocalChat(
            conversationId,
            buildInput({
              ...(prepared.cacheState ? { cacheState: prepared.cacheState } : {}),
              localMainFailure: {
                status: mainRes.status,
                body: snippet.slice(0, 2000),
              },
            }),
            signal,
          )
          .catch((err) => {
            if (isAbortError(err) || signal.aborted) throw err;
            return null;
          });
        if (retry?.cacheRetry) {
          mainRes = await sendLocalHttpFetch(retry, provider, providerId, signal);
          if (mainRes.ok) {
            return { prepared: retry, response: mainRes };
          }
        }
        throw new GatewayError(
          `HTTP_${mainRes.status}`,
          snippet.trim()
            ? `上游返回 HTTP ${mainRes.status}: ${snippet.trim().slice(0, 300)}`
            : `上游返回 HTTP ${mainRes.status}`,
          mainRes.status,
        );
      }
      return { prepared, response: mainRes };
    },
    [gateway, sendLocalHttpFetch],
  );
  const executeLocalStream = useCallback(
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

      const provider = resources.providers.find(
        (p) => p.id === opts.input.providerId,
      );
      const model = provider?.models.find((m) => m.id === opts.input.modelId);
      const apiFormat = model?.apiFormat || 'openai-completions';

      const searchTracker = { settled: false, block: null as ContentBlock | null };
      let prepared: PreparedLocalRequest;
      let response: Response;

      try {
        const opened = await prepareAndOpenLocalUpstream(
          opts.conversationId,
          opts.input,
          provider,
          opts.input.providerId,
          searchTracker,
          run.ctrl.signal,
        );
        prepared = opened.prepared;
        response = opened.response;
      } catch (err) {
        releaseGeneration(run);
        if (!isRunCurrent(run)) return false;

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

      if (!isRunCurrent(run) || run.aborted || run.ctrl.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        releaseGeneration(run);
        if (isRunCurrent(run) && run.aborted) {
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

      let persistedUserMessageId = '';
      if (opts.optimisticUserId) {
        const userBlocks: ContentBlock[] =
          opts.input.blocks && opts.input.blocks.length > 0
            ? opts.input.blocks
            : [{ type: 'text', text: opts.input.text ?? '' }];
        try {
          const savedUser = await gateway.createMessage(
            opts.conversationId,
            {
              role: 'user',
              blocks: userBlocks,
              ...(prepared.parentId !== undefined ? { parentId: prepared.parentId, consumeBranchId: prepared.consumeBranchId } : {}),
            },
            run.ctrl.signal,
            reqScope,
          );
          persistedUserMessageId = savedUser.message.id;
          upsertLocalConversation(savedUser.conversation, reqScope);
          if (!isRunCurrent(run)) {
            await response.body?.cancel().catch(() => {});
            releaseGeneration(run);
            return false;
          }
          dispatch({
            type: 'UPDATE_CONVERSATION_META',
            conversation: savedUser.conversation,
          });
          dispatch({
            type: 'REPLACE_MESSAGE_BY_ID',
            targetId: opts.optimisticUserId,
            message: savedUser.message,
          });
          opts.onStreamAccepted?.();
          if (run.aborted || run.ctrl.signal.aborted) {
            await response.body?.cancel().catch(() => {});
            releaseGeneration(run);
            dispatch({ type: 'ABORT_LOCAL' });
            return false;
          }
        } catch (userPersistErr) {
          await response.body?.cancel().catch(() => {});
          releaseGeneration(run);
          if (!isRunCurrent(run)) return false;
          if (isAbortError(userPersistErr) && run.aborted) {
            dispatch({
              type: 'SEND_PREPARE_ABORTED',
              optimisticUserId: opts.optimisticUserId,
            });
            opts.onPrepareRollback?.();
            return false;
          }
          const e = formatError(userPersistErr);
          dispatch({
            type: 'SEND_PREPARE_FAILED',
            optimisticUserId: opts.optimisticUserId,
            code: e.code,
            message: e.message,
          });
          opts.onPrepareRollback?.();
          return false;
        }
      } else {
        opts.onStreamAccepted?.();
      }

      const localAssistantId = opts.placeholderAssistantId;
      const accOrder: number[] = [];
      const accBlocks: Record<number, StreamingBlockBuffer> = {};
      let accUsage: TokenUsage | undefined;
      let accStopReason: string | undefined;
      let streamErrorMsg: string | undefined;

      const applyLocalAccum = (ev: StreamEvent) => {
        if (ev.type === 'block_start' && ev.index !== undefined) {
          if (!accBlocks[ev.index]) {
            accOrder.push(ev.index);
            const initTool =
              ev.block && ev.block.type === 'toolCall' ? ev.block : undefined;
            accBlocks[ev.index] = {
              blockType: ev.blockType || ev.block?.type || 'text',
              id: initTool ? String(initTool.id ?? '') : '',
              name: initTool ? String(initTool.name ?? '') : '',
              text: '',
              signature: '',
              finalized: ev.block,
            };
          }
        } else if (ev.type === 'block_delta' && ev.index !== undefined) {
          let buf = accBlocks[ev.index];
          if (!buf) {
            accOrder.push(ev.index);
            buf = {
              blockType: ev.blockType || 'text',
              id: '',
              name: '',
              text: '',
              signature: '',
            };
            accBlocks[ev.index] = buf;
          }
          buf.finalized = undefined;
          if (ev.deltaType === 'signature_delta') {
            buf.signature += ev.delta ?? '';
          } else {
            buf.text += ev.delta ?? '';
          }
        } else if (
          ev.type === 'block_end' &&
          ev.index !== undefined &&
          ev.block
        ) {
          if (!accBlocks[ev.index]) {
            accOrder.push(ev.index);
            accBlocks[ev.index] = {
              blockType: ev.block.type,
              id: '',
              name: '',
              text: '',
              signature: '',
              finalized: ev.block,
            };
          } else {
            accBlocks[ev.index].finalized = ev.block;
          }
        } else if (ev.type === 'message_delta') {
          if (ev.usage) accUsage = ev.usage;
          if (ev.stopReason) accStopReason = ev.stopReason;
        }
      };

      let regenConfirmed = !opts.regenerateTargetId;
      const emitEvent = (ev: StreamEvent) => {
        if (
          !regenConfirmed &&
          opts.regenerateTargetId &&
          (ev.type === 'block_start' || ev.type === 'block_delta' || ev.type === 'block_end')
        ) {
          regenConfirmed = true;
          dispatch({
            type: 'REGEN_PREPARE_CONFIRMED',
            targetMessageId: opts.regenerateTargetId,
          });
        }
        applyLocalAccum(ev);
        dispatch({
          type: 'STREAM_EVENT',
          event: ev,
          fallbackProviderId: opts.input.providerId,
          fallbackModelId: opts.input.modelId,
        });
      };

      const roundContextTokens = (u: TokenUsage): number => {
        if (u.contextTokens !== undefined && u.contextTokens > 0) {
          return u.contextTokens;
        }
        const sum = u.inputTokens + u.outputTokens;
        return sum > 0 ? sum : Math.max(0, u.totalTokens);
      };

      const sumTokenUsage = (
        acc: TokenUsage | undefined,
        round: TokenUsage | undefined,
      ): TokenUsage | undefined => {
        if (!round) return acc;
        const roundCtx = roundContextTokens(round);
        if (!acc) {
          return roundCtx > 0 && !round.contextTokens
            ? { ...round, contextTokens: roundCtx }
            : { ...round };
        }
        const thinkingTokens =
          (acc.thinkingTokens ?? 0) + (round.thinkingTokens ?? 0);
        const cacheReadInputTokens =
          (acc.cacheReadInputTokens ?? 0) + (round.cacheReadInputTokens ?? 0);
        const cacheCreationInputTokens =
          (acc.cacheCreationInputTokens ?? 0) +
          (round.cacheCreationInputTokens ?? 0);
        const nextCtx = roundCtx > 0 ? roundCtx : (acc.contextTokens ?? 0);
        return {
          inputTokens: acc.inputTokens + round.inputTokens,
          outputTokens: acc.outputTokens + round.outputTokens,
          ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
          ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
          ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
          totalTokens: acc.totalTokens + round.totalTokens,
          ...(nextCtx > 0 ? { contextTokens: nextCtx } : {}),
        };
      };

      let caughtDecodeErr: unknown = null;
      const seenCallIds = new Set<string>();
      let cumulativeUsage: TokenUsage | undefined;
      let finalStopReason = 'stop';

      try {
        emitEvent({
          type: 'message_start',
          conversationId: opts.conversationId,
          messageId: localAssistantId,
          providerId: opts.input.providerId,
          modelId: opts.input.modelId,
        });

        let indexOffset = 0;
        const initialWebSearchBlock = searchTracker.block ?? prepared.webSearchBlock;
        if (initialWebSearchBlock) {
          emitEvent({
            type: 'block_start',
            conversationId: opts.conversationId,
            messageId: localAssistantId,
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
            index: 0,
            blockType: 'webSearch',
            block: initialWebSearchBlock,
          });
          emitEvent({
            type: 'block_end',
            conversationId: opts.conversationId,
            messageId: localAssistantId,
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
            index: 0,
            blockType: 'webSearch',
            block: initialWebSearchBlock,
          });
          indexOffset = 1;
        }

        let roundResp = response;
        for (let round = 0; ; round++) {
          if (!roundResp.body) {
            throw new GatewayError('STREAM_EMPTY', '上游未返回事件流');
          }

          let roundUsage: TokenUsage | undefined;
          let roundStopReason = '';
          const roundCalls: ToolCallBlock[] = [];
          const roundCallIds = new Map<number, string>();
          let maxSeenIdx = indexOffset - 1;

          await decodeUpstreamSseStream(
            apiFormat,
            roundResp.body,
            {
              conversationId: opts.conversationId,
              messageId: localAssistantId,
              providerId: opts.input.providerId,
              modelId: opts.input.modelId,
            },
            (rawEv) => {
              if (!isRunCurrent(run) || run.aborted) return;
              const shiftedIdx =
                rawEv.index !== undefined
                  ? rawEv.index + indexOffset
                  : undefined;
              if (shiftedIdx !== undefined && shiftedIdx > maxSeenIdx) {
                maxSeenIdx = shiftedIdx;
              }
              let nextEv: StreamEvent =
                shiftedIdx !== undefined ? { ...rawEv, index: shiftedIdx } : rawEv;

              if (
                nextEv.block &&
                nextEv.block.type === 'toolCall' &&
                shiftedIdx !== undefined
              ) {
                const rawTool = nextEv.block as ToolCallBlock;
                const b: ToolCallBlock = {
                  ...rawTool,
                  id: String(rawTool.id ?? ''),
                  name: String(rawTool.name ?? ''),
                };
                if (nextEv.type === 'block_start') {
                  let id = b.id.trim();
                  if (!id || seenCallIds.has(id)) {
                    const base = `call_r${round + 1}_${shiftedIdx}`;
                    id = base;
                    for (let suffix = 2; seenCallIds.has(id); suffix++) {
                      id = `${base}_${suffix}`;
                    }
                  }
                  seenCallIds.add(id);
                  roundCallIds.set(shiftedIdx, id);
                  b.id = id;
                  nextEv = { ...nextEv, block: b };
                } else if (nextEv.type === 'block_end') {
                  let id = roundCallIds.get(shiftedIdx);
                  if (!id) {
                    id = b.id.trim();
                    if (!id || seenCallIds.has(id)) {
                      const base = `call_r${round + 1}_${shiftedIdx}`;
                      id = base;
                      for (let suffix = 2; seenCallIds.has(id); suffix++) {
                        id = `${base}_${suffix}`;
                      }
                    }
                    seenCallIds.add(id);
                    roundCallIds.set(shiftedIdx, id);
                  }
                  b.id = id;
                  nextEv = { ...nextEv, block: b };
                  roundCalls.push(b);
                }
              }

              if (nextEv.type === 'message_delta') {
                if (nextEv.usage) {
                  roundUsage = nextEv.usage;
                  nextEv = {
                    ...nextEv,
                    usage: sumTokenUsage(cumulativeUsage, roundUsage),
                  };
                }
                if (nextEv.stopReason) {
                  roundStopReason = nextEv.stopReason;
                }
              }

              if (nextEv.type === 'error') {
                streamErrorMsg = nextEv.error?.message || '流式生成失败';
              }
              emitEvent(nextEv);
            },
          );

          if (
            !isRunCurrent(run) ||
            run.aborted ||
            run.ctrl.signal.aborted ||
            streamErrorMsg
          ) {
            break;
          }

          cumulativeUsage = sumTokenUsage(cumulativeUsage, roundUsage);
          accUsage = cumulativeUsage;
          indexOffset = maxSeenIdx + 1;

          const effectiveStop =
            roundStopReason || (roundCalls.length > 0 ? 'toolUse' : 'stop');
          if (effectiveStop !== 'toolUse' || roundCalls.length === 0) {
            finalStopReason = effectiveStop;
            break;
          }

          if (round >= mcpMaxToolRounds) {
            streamErrorMsg = `达到最大工具调用轮数上限（${mcpMaxToolRounds} 轮）`;
            emitEvent({
              type: 'error',
              conversationId: opts.conversationId,
              messageId: localAssistantId,
              providerId: opts.input.providerId,
              modelId: opts.input.modelId,
              error: {
                code: 'MCP_ROUND_LIMIT',
                message: streamErrorMsg,
              },
            });
            break;
          }

          const execResp = await gateway.openToolExecutionStream(
            opts.conversationId,
            roundCalls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments: c.arguments ?? {},
            })),
            run.ctrl.signal,
          );
          if (!execResp.body) {
            throw new GatewayError('STREAM_EMPTY', '工具执行未返回事件流');
          }

          const toolIdxMap = new Map<number, number>();
          for await (const frame of decodeSseByteStream(execResp.body)) {
            if (
              !isRunCurrent(run) ||
              run.aborted ||
              run.ctrl.signal.aborted
            ) {
              break;
            }
            const parsed = parseStreamEventFrame(frame);
            if (!parsed) continue;
            if (parsed.type === 'error') {
              throw new GatewayError(
                parsed.error?.code || 'TOOL_EXEC_FAILED',
                parsed.error?.message || '工具执行失败',
              );
            }
            if (parsed.index !== undefined) {
              let mappedIdx = toolIdxMap.get(parsed.index);
              if (mappedIdx === undefined) {
                mappedIdx = indexOffset++;
                toolIdxMap.set(parsed.index, mappedIdx);
              }
              emitEvent({
                ...parsed,
                conversationId: opts.conversationId,
                messageId: localAssistantId,
                providerId: opts.input.providerId,
                modelId: opts.input.modelId,
                index: mappedIdx,
              });
            }
          }

          if (
            !isRunCurrent(run) ||
            run.aborted ||
            run.ctrl.signal.aborted
          ) {
            break;
          }

          const currentBlocks = accOrder.map((idx) =>
            bufferToBlock(accBlocks[idx]),
          );
          const nextOpened = await prepareAndOpenLocalUpstream(
            opts.conversationId,
            {
              ...opts.input,
              localContinuation: {
                ...(persistedUserMessageId
                  ? { userMessageId: persistedUserMessageId }
                  : {}),
                blocks: currentBlocks,
              },
            },
            provider,
            opts.input.providerId,
            searchTracker,
            run.ctrl.signal,
          );
          roundResp = nextOpened.response;
        }
      } catch (err) {
        caughtDecodeErr = err;
      } finally {
        releaseGeneration(run);
      }

      if (!isRunCurrent(run)) return false;

      const finalBlocks = accOrder.map((idx) => bufferToBlock(accBlocks[idx]));
      let stopReason = finalStopReason || accStopReason || 'stop';
      let errMsg = '';

      if (run.aborted || isAbortError(caughtDecodeErr)) {
        stopReason = 'aborted';
        dispatch({ type: 'ABORT_LOCAL' });
        if (finalBlocks.length === 0 && opts.regenerateTargetId) {
          return false;
        }
      } else if (streamErrorMsg) {
        stopReason = 'error';
        errMsg = streamErrorMsg;
      } else if (caughtDecodeErr) {
        const e = formatError(caughtDecodeErr);
        stopReason = 'error';
        errMsg = e.message;
        dispatch({
          type: 'STREAM_NETWORK_ERROR',
          code: e.code,
          message: e.message,
        });
      } else {
        if (!regenConfirmed && opts.regenerateTargetId) {
          dispatch({
            type: 'REGEN_PREPARE_CONFIRMED',
            targetMessageId: opts.regenerateTargetId,
          });
        }
        const localFinalMsg: Message = {
          id: localAssistantId,
          conversationId: opts.conversationId,
          role: 'assistant',
          blocks: finalBlocks,
          providerId: opts.input.providerId,
          modelId: opts.input.modelId,
          ...(accUsage ? { usage: accUsage } : {}),
          stopReason,
          createdAt: new Date().toISOString(),
        };
        dispatch({
          type: 'STREAM_EVENT',
          event: {
            type: 'message_end',
            conversationId: opts.conversationId,
            messageId: localAssistantId,
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
            message: localFinalMsg,
          },
          fallbackProviderId: opts.input.providerId,
          fallbackModelId: opts.input.modelId,
        });
      }

      try {
        // Never pass the aborted run signal to final partial/completed message persistence.
        const saved = await gateway.createMessage(
          opts.conversationId,
          {
            role: 'assistant',
            blocks: finalBlocks,
            ...(persistedUserMessageId && prepared.parentId !== undefined ? { parentId: persistedUserMessageId } : {}),
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
            ...(accUsage ? { usage: accUsage } : {}),
            stopReason,
            ...(errMsg ? { errorMessage: errMsg } : {}),
            ...(prepared.replaceMessageId
              ? { replaceMessageId: prepared.replaceMessageId }
              : {}),
            ...(prepared.insertAfterMessageId
              ? { afterMessageId: prepared.insertAfterMessageId }
              : {}),
          },
          undefined,
          reqScope,
        );
        upsertLocalConversation(saved.conversation, reqScope);
        if (!isRunCurrent(run)) return false;
        dispatch({
          type: 'REPLACE_MESSAGE_BY_ID',
          targetId: localAssistantId,
          message: saved.message,
        });
        dispatch({ type: 'UPDATE_CONVERSATION_META', conversation: saved.conversation });
        void reconcileAfterStream(
          opts.conversationId,
          run.epoch,
          run.connectionEpoch,
          {
            isAbort: stopReason === 'aborted',
            minExpectedMessages: opts.expectedCountOnAbort,
          },
          reqScope,
        );
        return stopReason !== 'aborted' && stopReason !== 'error';
      } catch (saveErr) {
        if (!isRunCurrent(run)) return false;
        toast(
          `回复已生成，但保存至服务端失败：${formatError(saveErr).message}`,
          'error',
        );
        dispatch({ type: 'MARK_NEEDS_RELOAD' });
        return false;
      }
    },
    [
      gateway,
      isRunCurrent,
      mcpMaxToolRounds,
      prepareAndOpenLocalUpstream,
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
      const run: GenerationRun = {
        id: ++runSeqRef.current,
        epoch,
        connectionEpoch: connectionEpochRef.current,
        conversationId: conv.id,
        scope: reqScope,
        ctrl,
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

      const useBrowserLocalRequest =
        !isDesktop &&
        conv.mode !== 'agent' &&
        Boolean(
          resources.providers.find((p) => p.id === opts.providerId)?.localRequest,
        );
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
    run.aborted = true;
    run.ctrl.abort();
  }, []);

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

      const provider = resources.providers.find(
        (p) => p.id === opts.providerId,
      );
      const reqScope = resolveScope(opts.scope);
      const epoch = epochRef.current;
      const ctrl = new AbortController();
      compactingRef.current = true;
      compactAbortRef.current = ctrl;
      setIsCompacting(true);

      try {
        if (isDesktop || conv.mode === 'agent' || !provider?.localRequest) {
          const res = await gateway.compactConversation(
            conv.id,
            {
              providerId: opts.providerId,
              modelId: opts.modelId,
            },
            ctrl.signal,
            reqScope,
          );
          if (epoch !== epochRef.current || ctrl.signal.aborted) {
            return { ok: false, error: '压缩已取消' };
          }
          dispatch({
            type: 'LOAD_SUCCESS',
            conversation: res.conversation,
            messages: res.messages,
          });
          upsertLocalConversation(res.conversation, reqScope);
          return {
            ok: true,
            beforeTokens: res.meta.beforeTokens,
            afterTokens: res.meta.afterTokens,
          };
        }

        const prepared = await gateway.prepareLocalCompact(
          conv.id,
          {
            providerId: opts.providerId,
            modelId: opts.modelId,
            credentialEnvelope: true,
          },
          ctrl.signal,
        );
        if (epoch !== epochRef.current || ctrl.signal.aborted) {
          return { ok: false, error: '压缩已取消' };
        }

        const upstreamRes = await sendLocalHttpFetch(
          prepared.request,
          provider,
          opts.providerId,
          ctrl.signal,
        );
        if (!upstreamRes.ok) {
          const snippet = await upstreamRes.text().catch(() => '');
          throw new GatewayError(
            `HTTP_${upstreamRes.status}`,
            snippet.trim()
              ? `上游返回 HTTP ${upstreamRes.status}: ${snippet.trim().slice(0, 300)}`
              : `上游返回 HTTP ${upstreamRes.status}`,
            upstreamRes.status,
          );
        }
        if (!upstreamRes.body) {
          throw new GatewayError('STREAM_EMPTY', '上游未返回事件流');
        }

        const accBlocks: Record<number, StreamingBlockBuffer> = {};
        const accOrder: number[] = [];
        let accUsage: TokenUsage | undefined;
        let streamErrorMsg = '';

        await decodeUpstreamSseStream(
          prepared.apiFormat,
          upstreamRes.body,
          {
            conversationId: conv.id,
            providerId: prepared.providerId,
            modelId: prepared.modelId,
          },
          (ev) => {
            if (epoch !== epochRef.current || ctrl.signal.aborted) return;
            if (ev.type === 'block_start' && ev.index !== undefined) {
              if (!accBlocks[ev.index]) {
                accOrder.push(ev.index);
                accBlocks[ev.index] = {
                  blockType: ev.blockType || ev.block?.type || 'text',
                  id: '',
                  name: '',
                  text: '',
                  signature: '',
                  finalized: ev.block,
                };
              }
            } else if (ev.type === 'block_delta' && ev.index !== undefined) {
              let buf = accBlocks[ev.index];
              if (!buf) {
                accOrder.push(ev.index);
                buf = {
                  blockType: ev.blockType || 'text',
                  id: '',
                  name: '',
                  text: '',
                  signature: '',
                };
                accBlocks[ev.index] = buf;
              }
              buf.finalized = undefined;
              if (ev.deltaType !== 'signature_delta') {
                buf.text += ev.delta ?? '';
              }
            } else if (
              ev.type === 'block_end' &&
              ev.index !== undefined &&
              ev.block
            ) {
              if (!accBlocks[ev.index]) {
                accOrder.push(ev.index);
                accBlocks[ev.index] = {
                  blockType: ev.block.type,
                  id: '',
                  name: '',
                  text: '',
                  signature: '',
                  finalized: ev.block,
                };
              } else {
                accBlocks[ev.index].finalized = ev.block;
              }
            } else if (ev.type === 'message_delta' && ev.usage) {
              accUsage = ev.usage;
            } else if (ev.type === 'error' && ev.error?.message) {
              streamErrorMsg = ev.error.message;
            }
          },
        );

        if (epoch !== epochRef.current || ctrl.signal.aborted) {
          return { ok: false, error: '压缩已取消' };
        }
        if (streamErrorMsg) {
          throw new GatewayError('UPSTREAM_ERROR', streamErrorMsg);
        }

        const summary = accOrder
          .map((idx) => bufferToBlock(accBlocks[idx]))
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (!summary) {
          throw new GatewayError('UPSTREAM_ERROR', '压缩摘要返回为空');
        }

        const curMessages = stateRef.current.messages;
        let keptMessages: Message[] = [];
        if (prepared.plan.insertAfterMessageId) {
          const afterIdx = curMessages.findIndex(
            (m) => m.id === prepared.plan.insertAfterMessageId,
          );
          if (afterIdx >= 0) {
            keptMessages = curMessages.slice(afterIdx + 1);
          } else if (prepared.plan.keptCount > 0) {
            keptMessages = curMessages.slice(-prepared.plan.keptCount);
          }
        }
        const afterTokens = estimateCompactionAfterTokens(
          prepared.systemPrompt,
          summary,
          keptMessages,
        );
        const meta: CompactionMeta = {
          snapshotLastMessageId: prepared.plan.snapshotLastMessageId,
          compactedCount: prepared.plan.compactedCount,
          beforeTokens: prepared.plan.beforeTokens,
          afterTokens,
        };

        await gateway.createMessage(
          conv.id,
          {
            role: 'compaction',
            blocks: [{ type: 'compaction', text: summary, extra: meta }],
            providerId: prepared.providerId,
            modelId: prepared.modelId,
            ...(accUsage ? { usage: accUsage } : {}),
            stopReason: 'stop',
            ...(prepared.plan.insertAfterMessageId
              ? { afterMessageId: prepared.plan.insertAfterMessageId }
              : conv.graphState?.enabled ? { parentId: prepared.plan.snapshotLastMessageId, consumeBranchId: conv.graphState.activeBranchId } : {}),
          },
          ctrl.signal,
        );
        if (epoch !== epochRef.current || ctrl.signal.aborted) {
          return { ok: false, error: '压缩已取消' };
        }

        const detail = await gateway.getConversationDetail(
          conv.id,
          ctrl.signal,
        );
        if (epoch !== epochRef.current) {
          return { ok: false, error: '压缩已取消' };
        }
        dispatch({
          type: 'LOAD_SUCCESS',
          conversation: detail.conversation,
          messages: detail.messages,
        });
        upsertLocalConversation(detail.conversation);
        return {
          ok: true,
          beforeTokens: prepared.plan.beforeTokens,
          afterTokens,
        };
      } catch (err) {
        if (isAbortError(err) || epoch !== epochRef.current) {
          return { ok: false, error: '压缩已取消' };
        }
        return { ok: false, error: formatError(err).message };
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
      sendLocalHttpFetch,
      upsertLocalConversation,
    ],
  );

  const applyBranchedDetail = useCallback(
    (detail: ConversationDetail, scope?: TopicScope) => {
      cancelActiveStream(true);
      const reqScope = resolveScope(scope);
      sessionScopeRef.current = reqScope;
      upsertLocalConversation(detail.conversation, reqScope);
      dispatch({
        type: 'LOAD_SUCCESS',
        conversation: detail.conversation,
        messages: detail.messages,
      });
    },
    [cancelActiveStream, resolveScope, upsertLocalConversation],
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
