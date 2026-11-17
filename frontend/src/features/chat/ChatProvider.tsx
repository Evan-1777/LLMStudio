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
import { applyLocalAuth } from '../../core/localProvider';
import { getLocalProviderKey } from '../../core/localProviderKeys';
import { decodeUpstreamSseStream } from '../../core/localStreamDecoders';
import { decodeSseByteStream, parseStreamEventFrame } from '../../core/sse';
import type {
  ContentBlock,
  Conversation,
  ConversationDetail,
  GenerationParams,
  Message,
  PreparedLocalRequest,
  ReasoningEffort,
  StreamEvent,
  TokenUsage,
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

export function ChatProvider({ children }: { children: ReactNode }) {
  const {
    gateway,
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

      let prepared: PreparedLocalRequest;
      let response: Response;

      try {
        prepared = await gateway.prepareLocalChat(
          opts.conversationId,
          opts.input,
          ctrl.signal,
        );
        const localApiKey = getLocalProviderKey(opts.input.providerId);
        const authed = applyLocalAuth(
          prepared.url,
          prepared.headers ?? {},
          prepared.authType,
          localApiKey,
          provider?.headers,
        );
        const serializedBody =
          typeof prepared.body === 'string'
            ? prepared.body
            : JSON.stringify(prepared.body ?? {});

        try {
          response = await gateway.fetchImpl(authed.url, {
            method: prepared.method || 'POST',
            headers: authed.headers,
            body: serializedBody,
            signal: ctrl.signal,
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

        if (!response.ok) {
          const snippet = await response.text().catch(() => '');
          throw new GatewayError(
            `HTTP_${response.status}`,
            snippet.trim()
              ? `上游返回 HTTP ${response.status}: ${snippet.trim().slice(0, 300)}`
              : `上游返回 HTTP ${response.status}`,
            response.status,
          );
        }
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

      let caughtDecodeErr: unknown = null;

      try {
        if (!response.body) {
          throw new GatewayError('STREAM_EMPTY', '上游未返回事件流');
        }

        emitEvent({
          type: 'message_start',
          conversationId: opts.conversationId,
          messageId: localAssistantId,
          providerId: opts.input.providerId,
          modelId: opts.input.modelId,
        });

        let indexOffset = 0;
        if (prepared.webSearchBlock) {
          emitEvent({
            type: 'block_start',
            conversationId: opts.conversationId,
            messageId: localAssistantId,
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
            index: 0,
            blockType: 'webSearch',
            block: prepared.webSearchBlock,
          });
          emitEvent({
            type: 'block_end',
            conversationId: opts.conversationId,
            messageId: localAssistantId,
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
            index: 0,
            blockType: 'webSearch',
            block: prepared.webSearchBlock,
          });
          indexOffset = 1;
        }

        await decodeUpstreamSseStream(
          apiFormat,
          response.body,
          {
            conversationId: opts.conversationId,
            messageId: localAssistantId,
            providerId: opts.input.providerId,
            modelId: opts.input.modelId,
          },
          (rawEv) => {
            if (epoch !== epochRef.current || manualAbortRef.current) return;
            const shiftedEv: StreamEvent =
              indexOffset > 0 && rawEv.index !== undefined
                ? { ...rawEv, index: rawEv.index + indexOffset }
                : rawEv;
            if (shiftedEv.type === 'error') {
              streamErrorMsg = shiftedEv.error?.message || '流式生成失败';
            }
            emitEvent(shiftedEv);
          },
        );
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
      let stopReason = accStopReason || 'stop';
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
        },
        optimisticUserId: optimisticId,
        expectedCountOnAbort: expectedAfterAbort,
        onStreamAccepted: opts.onStreamAccepted,
      });
    },
    [executeLocalStream, executeStream, resources.providers],
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
        },
        regenerateTargetId: opts.targetMessageId,
        expectedCountOnAbort,
      });
    },
    [executeLocalStream, executeStream, resources.providers, toast],
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
