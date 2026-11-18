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
import { decodeUpstreamSseStream } from '../../core/localStreamDecoders';
import { decodeSseByteStream, parseStreamEventFrame } from '../../core/sse';
import type {
  ContentBlock,
  Conversation,
  ConversationDetail,
  GenerationParams,
  LocalCacheResultData,
  Message,
  ModelConfig,
  PreparedLocalHTTPRequest,
  PreparedLocalRequest,
  PreparedSearchInput,
  PromptCacheState,
  ProviderConfig,
  ReasoningEffort,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
  ToolCallBlock,
} from '../../core/types';
import {
  bufferToBlock,
  chatReducer,
  initialChatState,
  isLocalMessageId,
  type ChatState,
  type StreamingBlockBuffer,
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
  updateConversationMeta: (conversation: Conversation) => void;
  clearSession: () => void;
  loadConversation: (conversationId: string) => Promise<ConversationDetail | null>;
  reloadCurrentConversation: () => Promise<void>;
  sendMessage: (opts: SendMessageOptions) => Promise<boolean>;
  regenerateMessage: (opts: RegenerateOptions) => Promise<boolean>;
  updateMessage: (messageId: string, blocks: ContentBlock[]) => Promise<boolean>;
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

function buildLocalCacheKey(
  connectionEpoch: number,
  provider: ProviderConfig | undefined,
  providerId: string,
  model: ModelConfig | undefined,
  modelId: string,
): string {
  // Credentials live in the gateway now: its provider revision changes whenever
  // the stored key does, which is what invalidates prepared cache state.
  const hdrs = provider?.headers
    ? Object.entries(provider.headers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(';')
    : '';
  return [
    connectionEpoch,
    providerId,
    provider?.baseURL ?? '',
    provider?.authType ?? '',
    hdrs,
    provider?.updatedAt ?? '',
    model?.apiFormat ?? '',
    modelId,
    model?.compat?.pathOverride ?? '',
    model?.compat?.cacheMode ?? '',
  ].join('|');
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

function classifyLocalMainCacheError(
  status: number,
  bodyText: string,
  hadCachedRef: boolean,
): 'none' | 'unsupported' | 'expired' {
  const lower = bodyText.toLowerCase();
  if (
    lower.includes('api key') ||
    lower.includes('api_key') ||
    lower.includes('invalid key')
  ) {
    return 'none';
  }
  if (status === 400 || status === 422) {
    const hasInlineKw =
      lower.includes('cache_control') ||
      lower.includes('prompt_cache_options') ||
      lower.includes('prompt_cache_breakpoint') ||
      lower.includes('ephemeral');
    const hasReject =
      lower.includes('unsupported') ||
      lower.includes('not supported') ||
      lower.includes('unknown') ||
      lower.includes('unrecognized') ||
      lower.includes('invalid') ||
      lower.includes('unexpected') ||
      lower.includes('not permitted');
    if (hasInlineKw && hasReject) {
      return 'unsupported';
    }
  }
  if (
    hadCachedRef &&
    (status === 404 || status === 400 || status === 403) &&
    (lower.includes('cachedcontent') ||
      lower.includes('cached_content') ||
      lower.includes('not found') ||
      lower.includes('expired') ||
      lower.includes('does not exist'))
  ) {
    return lower.includes('unsupported') ? 'unsupported' : 'expired';
  }
  return 'none';
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const {
    gateway,
    settings,
    resources,
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
  const localCacheRef = useRef<Map<string, PromptCacheState>>(new Map());

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
    localCacheRef.current.clear();
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
    async (conversationId: string): Promise<ConversationDetail | null> => {
      cancelActiveStream(true);
      const epoch = ++epochRef.current;
      const ctrl = new AbortController();
      activeAbortRef.current = ctrl;
      dispatch({ type: 'LOAD_START', conversationId });
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
        autoCreateCache?: boolean;
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
      model: ModelConfig | undefined,
      modelId: string,
      searchTracker: { settled: boolean; block: ContentBlock | null },
      signal: AbortSignal,
    ): Promise<{ prepared: PreparedLocalRequest; response: Response }> => {
      const cacheKey = buildLocalCacheKey(
        connectionEpoch,
        provider,
        providerId,
        model,
        modelId,
      );
      let currentCache = localCacheRef.current.get(cacheKey);
      if (currentCache?.expireTime) {
        const expMs = Date.parse(currentCache.expireTime);
        if (Number.isFinite(expMs) && expMs <= Date.now()) {
          localCacheRef.current.delete(cacheKey);
          currentCache = undefined;
        }
      }

      const buildInput = (extra?: Partial<StreamChatInput>): StreamChatInput => ({
        ...baseInput,
        // Direct requests carry the gateway-bound credential instead of a browser key.
        credentialEnvelope: true,
        ...(searchTracker.settled
          ? { preparedSearch: { block: searchTracker.block } satisfies PreparedSearchInput }
          : {}),
        ...(currentCache ? { cacheState: currentCache } : {}),
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

      const hadCacheStep = Boolean(prepared.cacheStep);
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

      if (prepared.cacheState) {
        localCacheRef.current.set(cacheKey, prepared.cacheState);
      } else if (hadCacheStep) {
        localCacheRef.current.delete(cacheKey);
      }

      let mainRes = await sendLocalHttpFetch(
        prepared,
        provider,
        providerId,
        signal,
      );
      if (!mainRes.ok) {
        const snippet = await mainRes.text().catch(() => '');
        const errKind = classifyLocalMainCacheError(
          mainRes.status,
          snippet,
          Boolean(prepared.cacheState?.resourceName),
        );
        if (errKind !== 'none') {
          const fallbackState: PromptCacheState = { unsupported: true };
          if (errKind === 'unsupported') {
            localCacheRef.current.set(cacheKey, fallbackState);
          } else {
            localCacheRef.current.delete(cacheKey);
          }
          prepared = await gateway.prepareLocalChat(
            conversationId,
            {
              ...baseInput,
              credentialEnvelope: true,
              ...(searchTracker.settled
                ? { preparedSearch: { block: searchTracker.block } }
                : {}),
              cacheState: fallbackState,
            },
            signal,
          );
          mainRes = await sendLocalHttpFetch(
            prepared,
            provider,
            providerId,
            signal,
          );
          if (!mainRes.ok) {
            const retrySnippet = await mainRes.text().catch(() => '');
            throw new GatewayError(
              `HTTP_${mainRes.status}`,
              retrySnippet.trim()
                ? `上游返回 HTTP ${mainRes.status}: ${retrySnippet.trim().slice(0, 300)}`
                : `上游返回 HTTP ${mainRes.status}`,
              mainRes.status,
            );
          }
          return { prepared, response: mainRes };
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
    [connectionEpoch, gateway, sendLocalHttpFetch],
  );

  const executeLocalStream = useCallback(
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
        autoCreateCache?: boolean;
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
          model,
          opts.input.modelId,
          searchTracker,
          ctrl.signal,
        );
        prepared = opened.prepared;
        response = opened.response;
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

      let persistedUserMessageId = '';
      if (opts.optimisticUserId) {
        const userBlocks: ContentBlock[] =
          opts.input.blocks && opts.input.blocks.length > 0
            ? opts.input.blocks
            : [{ type: 'text', text: opts.input.text ?? '' }];
        try {
          const savedUser = await gateway.createMessage(opts.conversationId, {
            role: 'user',
            blocks: userBlocks,
          });
          if (epoch !== epochRef.current) {
            await response.body?.cancel().catch(() => {});
            sendingRef.current = false;
            return false;
          }
          persistedUserMessageId = savedUser.message.id;
          upsertLocalConversation(savedUser.conversation);
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
        } catch (userPersistErr) {
          await response.body?.cancel().catch(() => {});
          sendingRef.current = false;
          if (activeAbortRef.current === ctrl) activeAbortRef.current = null;
          if (epoch !== epochRef.current) return false;
          const e = formatError(userPersistErr);
          dispatch({
            type: 'SEND_PREPARE_FAILED',
            optimisticUserId: opts.optimisticUserId,
            code: e.code,
            message: e.message,
          });
          return false;
        }
      } else {
        opts.onStreamAccepted?.();
        if (opts.regenerateTargetId) {
          dispatch({
            type: 'REGEN_PREPARE_CONFIRMED',
            targetMessageId: opts.regenerateTargetId,
          });
        }
      }

      const localAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

      const emitEvent = (ev: StreamEvent) => {
        applyLocalAccum(ev);
        dispatch({
          type: 'STREAM_EVENT',
          event: ev,
          fallbackProviderId: opts.input.providerId,
          fallbackModelId: opts.input.modelId,
        });
      };

      const sumTokenUsage = (
        acc: TokenUsage | undefined,
        round: TokenUsage | undefined,
      ): TokenUsage | undefined => {
        if (!round) return acc;
        if (!acc) return { ...round };
        const thinkingTokens =
          (acc.thinkingTokens ?? 0) + (round.thinkingTokens ?? 0);
        const cacheReadInputTokens =
          (acc.cacheReadInputTokens ?? 0) + (round.cacheReadInputTokens ?? 0);
        const cacheCreationInputTokens =
          (acc.cacheCreationInputTokens ?? 0) +
          (round.cacheCreationInputTokens ?? 0);
        return {
          inputTokens: acc.inputTokens + round.inputTokens,
          outputTokens: acc.outputTokens + round.outputTokens,
          ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
          ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
          ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
          totalTokens: acc.totalTokens + round.totalTokens,
        };
      };

      const LOCAL_MCP_ROUND_LIMIT = 8;
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
              if (epoch !== epochRef.current || manualAbortRef.current) return;
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
            epoch !== epochRef.current ||
            manualAbortRef.current ||
            ctrl.signal.aborted ||
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

          if (round >= LOCAL_MCP_ROUND_LIMIT) {
            streamErrorMsg = `达到最大工具调用轮数上限（${LOCAL_MCP_ROUND_LIMIT} 轮）`;
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
            ctrl.signal,
          );
          if (!execResp.body) {
            throw new GatewayError('STREAM_EMPTY', '工具执行未返回事件流');
          }

          const toolIdxMap = new Map<number, number>();
          for await (const frame of decodeSseByteStream(execResp.body)) {
            if (
              epoch !== epochRef.current ||
              manualAbortRef.current ||
              ctrl.signal.aborted
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
            epoch !== epochRef.current ||
            manualAbortRef.current ||
            ctrl.signal.aborted
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
            model,
            opts.input.modelId,
            searchTracker,
            ctrl.signal,
          );
          roundResp = nextOpened.response;
        }
      } catch (err) {
        caughtDecodeErr = err;
      } finally {
        sendingRef.current = false;
        if (activeAbortRef.current === ctrl) {
          activeAbortRef.current = null;
        }
      }

      if (epoch !== epochRef.current) return false;

      const finalBlocks = accOrder.map((idx) => bufferToBlock(accBlocks[idx]));
      let stopReason = finalStopReason || accStopReason || 'stop';
      let errMsg = '';

      if (manualAbortRef.current || isAbortError(caughtDecodeErr)) {
        stopReason = 'aborted';
        dispatch({ type: 'ABORT_LOCAL' });
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
        const saved = await gateway.createMessage(opts.conversationId, {
          role: 'assistant',
          blocks: finalBlocks,
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
        });
        if (epoch !== epochRef.current) return false;
        dispatch({
          type: 'REPLACE_MESSAGE_BY_ID',
          targetId: localAssistantId,
          message: saved.message,
        });
        upsertLocalConversation(saved.conversation);
        await reconcileAfterStream(opts.conversationId, epoch, {
          isAbort: stopReason === 'aborted',
          minExpectedMessages: opts.expectedCountOnAbort,
        });
        return stopReason !== 'aborted' && stopReason !== 'error';
      } catch (saveErr) {
        if (epoch !== epochRef.current) return false;
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
      prepareAndOpenLocalUpstream,
      reconcileAfterStream,
      resources.providers,
      toast,
      upsertLocalConversation,
    ],
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

      const isLocal = Boolean(
        resources.providers.find((p) => p.id === opts.providerId)?.localRequest,
      );
      const streamRunner = isLocal ? executeLocalStream : executeStream;
      return streamRunner({
        conversationId: opts.conversationId,
        input: {
          blocks: opts.blocks,
          text: opts.text,
          providerId: opts.providerId,
          modelId: opts.modelId,
          params: mergedParams,
          webSearch: opts.webSearch,
          searchEngineId: opts.searchEngineId,
          autoCreateCache: settings.autoCreateCache,
        },
        optimisticUserId: optimisticId,
        expectedCountOnAbort: expectedAfterAbort,
        onStreamAccepted: opts.onStreamAccepted,
      });
    },
    [
      executeLocalStream,
      executeStream,
      resources.providers,
      settings.autoCreateCache,
    ],
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
      const isReplacing =
        target.role !== 'user' ||
        stateRef.current.messages[idx + 1]?.role === 'assistant';
      const expectedCountOnAbort = isReplacing
        ? stateRef.current.messages.length
        : stateRef.current.messages.length + 1;

      const mergedParams: GenerationParams = {
        ...opts.params,
        reasoningEffort:
          opts.params?.reasoningEffort ?? stateRef.current.reasoningEffort,
      };

      dispatch({ type: 'REGEN_PREPARE_START' });

      const isLocal = Boolean(
        resources.providers.find((p) => p.id === opts.providerId)?.localRequest,
      );
      const streamRunner = isLocal ? executeLocalStream : executeStream;
      return streamRunner({
        conversationId: conv.id,
        input: {
          providerId: opts.providerId,
          modelId: opts.modelId,
          params: mergedParams,
          regenerateMessageId: opts.targetMessageId,
          webSearch: opts.webSearch,
          searchEngineId: opts.searchEngineId,
          autoCreateCache: settings.autoCreateCache,
        },
        regenerateTargetId: opts.targetMessageId,
        expectedCountOnAbort,
      });
    },
    [
      executeLocalStream,
      executeStream,
      resources.providers,
      settings.autoCreateCache,
      toast,
    ],
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

  const updateMessage = useCallback(
    async (messageId: string, blocks: ContentBlock[]): Promise<boolean> => {
      const conv = stateRef.current.conversation;
      if (!conv || sendingRef.current) return false;
      if (isLocalMessageId(messageId)) {
        toast('该消息尚未确认落盘，请先重新加载', 'error');
        return false;
      }
      try {
        const updated = await gateway.updateMessage(conv.id, messageId, blocks);
        dispatch({ type: 'UPDATE_MESSAGE', message: updated });
        return true;
      } catch (err) {
        toast(formatError(err).message, 'error');
        return false;
      }
    },
    [gateway, toast],
  );

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
      updateConversationMeta,
      clearSession,
      loadConversation,
      reloadCurrentConversation,
      sendMessage,
      regenerateMessage,
      updateMessage,
      deleteMessage,
      branchFromMessage,
      applyBranchedDetail,
      stopStreaming,
    }),
    [
      state,
      isBusy,
      setReasoningEffort,
      updateConversationMeta,
      clearSession,
      loadConversation,
      reloadCurrentConversation,
      sendMessage,
      regenerateMessage,
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
