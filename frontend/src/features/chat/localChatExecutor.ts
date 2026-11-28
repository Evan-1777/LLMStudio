import { GatewayClient, GatewayError } from '../../core/gateway';
import { decodeUpstreamSseStream } from '../../core/localStreamDecoders';
import { decodeSseByteStream, parseStreamEventFrame } from '../../core/sse';
import type {
  ContentBlock,
  Conversation,
  GenerationParams,
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
  extractSafeCacheResult,
  formatError,
  isAbortError,
  isSubstantiveAssistantEvent,
  type ChatDispatch,
  type GenerationRun,
} from './chatErrors';
import { bufferToBlock, type StreamingBlockBuffer } from './chatReducer';

export async function sendLocalHttpFetch(
  gateway: GatewayClient,
  preparedReq: PreparedLocalHTTPRequest,
  _provider: ProviderConfig | undefined,
  _providerId: string,
  signal: AbortSignal,
): Promise<Response> {
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
}

export async function prepareAndOpenLocalUpstream(
  gateway: GatewayClient,
  conversationId: string,
  baseInput: StreamChatInput,
  provider: ProviderConfig | undefined,
  providerId: string,
  searchTracker: { settled: boolean; block: ContentBlock | null },
  signal: AbortSignal,
): Promise<{ prepared: PreparedLocalRequest; response: Response }> {
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
      gateway,
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
    gateway,
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
      mainRes = await sendLocalHttpFetch(gateway, retry, provider, providerId, signal);
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
}

export interface LocalStreamDeps {
  gateway: GatewayClient;
  providers: ProviderConfig[];
  mcpMaxToolRounds: number;
  dispatch: ChatDispatch;
  isRunCurrent: (run: GenerationRun) => boolean;
  releaseGeneration: (run: GenerationRun) => void;
  reconcileAfterStream: (
    conversationId: string,
    epoch: number,
    connEpoch: number,
    opts: { isAbort: boolean; minExpectedMessages: number },
    reqScope?: TopicScope,
  ) => Promise<void>;
  upsertLocalConversation: (conv: Conversation, scope?: TopicScope) => void;
  toast: (message: string, tone?: 'default' | 'error') => void;
}

export interface LocalStreamRunOptions {
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
}

function roundContextTokens(u: TokenUsage): number {
  if (u.contextTokens !== undefined && u.contextTokens > 0) {
    return u.contextTokens;
  }
  const sum = u.inputTokens + u.outputTokens;
  return sum > 0 ? sum : Math.max(0, u.totalTokens);
}

function sumTokenUsage(
  acc: TokenUsage | undefined,
  round: TokenUsage | undefined,
): TokenUsage | undefined {
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
}

export async function runLocalChatStream(
  deps: LocalStreamDeps,
  opts: LocalStreamRunOptions,
): Promise<boolean> {
  const {
    gateway,
    providers,
    mcpMaxToolRounds,
    dispatch,
    isRunCurrent,
    releaseGeneration,
    reconcileAfterStream,
    upsertLocalConversation,
    toast,
  } = deps;
  const { run } = opts;
  const reqScope = opts.scope;

  const provider = providers.find((p) => p.id === opts.input.providerId);
  const model = provider?.models.find((m) => m.id === opts.input.modelId);
  const apiFormat = model?.apiFormat || 'openai-completions';

  const searchTracker = { settled: false, block: null as ContentBlock | null };
  let prepared: PreparedLocalRequest;
  let response: Response;

  try {
    const opened = await prepareAndOpenLocalUpstream(
      gateway,
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
  let userPersistError = '';
  let userPersistPromise: Promise<string> | null = null;
  const userBlocks: ContentBlock[] =
    opts.input.blocks && opts.input.blocks.length > 0
      ? opts.input.blocks
      : [{ type: 'text', text: opts.input.text ?? '' }];

  const persistUserMessage = async (): Promise<string> => {
    try {
      const savedUser = await gateway.createMessage(
        opts.conversationId,
        {
          role: 'user',
          blocks: userBlocks,
          ...(prepared.parentId !== undefined
            ? { parentId: prepared.parentId, consumeBranchId: prepared.consumeBranchId }
            : {}),
        },
        undefined,
        reqScope,
      );
      persistedUserMessageId = savedUser.message.id;
      upsertLocalConversation(savedUser.conversation, reqScope);
      if (isRunCurrent(run)) {
        dispatch({
          type: 'UPDATE_CONVERSATION_META',
          conversation: savedUser.conversation,
        });
        dispatch({
          type: 'REPLACE_MESSAGE_BY_ID',
          targetId: opts.optimisticUserId as string,
          message: savedUser.message,
        });
        opts.onStreamAccepted?.();
      }
      return persistedUserMessageId;
    } catch (userPersistErr) {
      userPersistError = formatError(userPersistErr).message;
      return '';
    }
  };

  const ensureUserMessagePersisted = (): Promise<string> => {
    if (!opts.optimisticUserId) return Promise.resolve('');
    if (persistedUserMessageId) return Promise.resolve(persistedUserMessageId);
    if (!userPersistPromise) userPersistPromise = persistUserMessage();
    return userPersistPromise;
  };

  if (!opts.optimisticUserId) {
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
  let hasAssistantOutput = false;
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
    if (!hasAssistantOutput && isSubstantiveAssistantEvent(ev)) {
      hasAssistantOutput = true;
      if (opts.optimisticUserId) {
        void ensureUserMessagePersisted();
      }
    }
    dispatch({
      type: 'STREAM_EVENT',
      event: ev,
      fallbackProviderId: opts.input.providerId,
      fallbackModelId: opts.input.modelId,
    });
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

      if (opts.optimisticUserId) {
        const userId = await ensureUserMessagePersisted();
        if (!userId) {
          throw new GatewayError('USER_PERSIST_FAILED', userPersistError || '用户消息保存失败');
        }
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
      if (opts.optimisticUserId) {
        const userId = await ensureUserMessagePersisted();
        if (!userId) {
          throw new GatewayError('USER_PERSIST_FAILED', userPersistError || '用户消息保存失败');
        }
      }

      const nextOpened = await prepareAndOpenLocalUpstream(
        gateway,
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

  const finalBlocks = accOrder
    .map((idx) => bufferToBlock(accBlocks[idx]))
    .filter((block) => {
      if (block.type !== 'toolCall') return true;
      return 'name' in block && typeof block.name === 'string' && block.name.trim() !== '';
    });
  let stopReason = finalStopReason || accStopReason || 'stop';
  let errMsg = '';

  if (opts.optimisticUserId && !hasAssistantOutput) {
    if (run.aborted || isAbortError(caughtDecodeErr)) {
      dispatch({
        type: 'SEND_PREPARE_ABORTED',
        optimisticUserId: opts.optimisticUserId,
      });
      opts.onPrepareRollback?.();
      return false;
    }
    const e = caughtDecodeErr ? formatError(caughtDecodeErr) : null;
    dispatch({
      type: 'SEND_PREPARE_FAILED',
      optimisticUserId: opts.optimisticUserId,
      code: streamErrorMsg ? 'UPSTREAM_ERROR' : (e?.code ?? 'STREAM_EMPTY'),
      message: streamErrorMsg || e?.message || '响应流未产出有效内容',
    });
    opts.onPrepareRollback?.();
    return false;
  }

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

  if (opts.optimisticUserId) {
    const userId = await ensureUserMessagePersisted();
    if (!userId) {
      const message = userPersistError || '网络异常';
      toast('用户消息保存失败：' + message, 'error');
      dispatch({ type: 'STREAM_NETWORK_ERROR', code: 'USER_PERSIST_FAILED', message });
      dispatch({ type: 'MARK_NEEDS_RELOAD' });
      return false;
    }
  }

  try {
    // Never pass the aborted run signal to final partial/completed message persistence.
    const saved = await gateway.createMessage(
      opts.conversationId,
      {
        role: 'assistant',
        blocks: finalBlocks,
        ...(persistedUserMessageId && prepared.parentId !== undefined
          ? { parentId: persistedUserMessageId }
          : {}),
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
}
