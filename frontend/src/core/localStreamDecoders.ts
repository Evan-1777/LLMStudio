import { decodeSseByteStream } from './sse';
import type { ContentBlock, StreamEvent, TokenUsage } from './types';

export interface LocalStreamMeta {
  conversationId?: string;
  messageId?: string;
  providerId?: string;
  modelId?: string;
}

function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function withMeta(meta: LocalStreamMeta, ev: StreamEvent): StreamEvent {
  return {
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    ...(meta.messageId ? { messageId: meta.messageId } : {}),
    ...(meta.providerId ? { providerId: meta.providerId } : {}),
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...ev,
  };
}

function mapOpenAIFinishReason(reason: string): string {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'toolUse';
    default:
      return 'stop';
  }
}

function mapAnthropicStopReason(reason: string): string {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'toolUse';
    default:
      return 'stop';
  }
}

function mapGeminiFinishReason(reason: string): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    default:
      return 'stop';
  }
}

async function decodeOpenAICompletions(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  interface ToolState {
    blockIdx: number;
    id: string;
    name: string;
    args: string;
    closed: boolean;
  }

  let nextBlockIdx = 0;
  let activeTextIdx = -1;
  let textBuf = '';
  let activeThinkIdx = -1;
  let thinkBuf = '';
  const toolStates = new Map<number, ToolState>();
  const toolOrder: number[] = [];
  let stopReason = '';
  let finalUsage: TokenUsage | undefined;
  let emittedEnd = false;
  let emittedError = false;

  const closeThinking = () => {
    if (activeThinkIdx < 0) return;
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: activeThinkIdx,
        blockType: 'thinking',
        block: { type: 'thinking', thinking: thinkBuf },
      }),
    );
    activeThinkIdx = -1;
    thinkBuf = '';
  };

  const closeText = () => {
    if (activeTextIdx < 0) return;
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: activeTextIdx,
        blockType: 'text',
        block: { type: 'text', text: textBuf },
      }),
    );
    activeTextIdx = -1;
    textBuf = '';
  };

  const finalizeStream = () => {
    if (emittedEnd || emittedError) return;
    emittedEnd = true;
    closeThinking();
    closeText();
    for (const tcIdx of toolOrder) {
      const st = toolStates.get(tcIdx);
      if (!st || st.closed) continue;
      st.closed = true;
      emit(
        withMeta(meta, {
          type: 'block_end',
          index: st.blockIdx,
          blockType: 'toolCall',
          block: {
            type: 'toolCall',
            id: st.id,
            name: st.name,
            arguments: parseToolArguments(st.args),
          },
        }),
      );
    }
    const resolvedStop =
      stopReason || (toolOrder.length > 0 ? 'toolUse' : 'stop');
    emit(
      withMeta(meta, {
        type: 'message_delta',
        ...(finalUsage ? { usage: finalUsage } : {}),
        stopReason: resolvedStop,
      }),
    );
  };

  for await (const frame of decodeSseByteStream(body)) {
    const data = frame.data.trim();
    if (!data) continue;
    if (data === '[DONE]') {
      finalizeStream();
      return;
    }

    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      continue;
    }

    if (chunk.error?.message) {
      emittedError = true;
      emit(
        withMeta(meta, {
          type: 'error',
          error: { code: 'UPSTREAM_ERROR', message: chunk.error.message },
        }),
      );
      return;
    }

    if (chunk.usage) {
      const thinkingTokens =
        chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      finalUsage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
        ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta ?? {};
    const reasoningDelta = delta.reasoning_content || delta.reasoning || '';
    if (reasoningDelta) {
      closeText();
      if (activeThinkIdx < 0) {
        activeThinkIdx = nextBlockIdx++;
        emit(
          withMeta(meta, {
            type: 'block_start',
            index: activeThinkIdx,
            blockType: 'thinking',
          }),
        );
      }
      thinkBuf += reasoningDelta;
      emit(
        withMeta(meta, {
          type: 'block_delta',
          index: activeThinkIdx,
          blockType: 'thinking',
          deltaType: 'thinking_delta',
          delta: reasoningDelta,
        }),
      );
    }

    if (delta.content) {
      closeThinking();
      if (activeTextIdx < 0) {
        activeTextIdx = nextBlockIdx++;
        emit(
          withMeta(meta, {
            type: 'block_start',
            index: activeTextIdx,
            blockType: 'text',
          }),
        );
      }
      textBuf += delta.content;
      emit(
        withMeta(meta, {
          type: 'block_delta',
          index: activeTextIdx,
          blockType: 'text',
          deltaType: 'text_delta',
          delta: delta.content,
        }),
      );
    }

    for (const tc of delta.tool_calls ?? []) {
      closeThinking();
      closeText();
      const tcIdx = tc.index ?? 0;
      let st = toolStates.get(tcIdx);
      if (!st) {
        st = {
          blockIdx: nextBlockIdx++,
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          args: '',
          closed: false,
        };
        toolStates.set(tcIdx, st);
        toolOrder.push(tcIdx);
        emit(
          withMeta(meta, {
            type: 'block_start',
            index: st.blockIdx,
            blockType: 'toolCall',
            block: {
              type: 'toolCall',
              id: st.id,
              name: st.name,
            },
          }),
        );
      } else {
        if (!st.id && tc.id) st.id = tc.id;
        if (!st.name && tc.function?.name) st.name = tc.function.name;
      }
      const argDelta = tc.function?.arguments ?? '';
      if (argDelta) {
        st.args += argDelta;
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: st.blockIdx,
            blockType: 'toolCall',
            deltaType: 'toolcall_delta',
            delta: argDelta,
          }),
        );
      }
    }

    if (choice.finish_reason) {
      stopReason = mapOpenAIFinishReason(choice.finish_reason);
    }
  }

  finalizeStream();
}

async function decodeOpenAIResponses(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  interface ItemState {
    blockIdx: number;
    blockType: string;
    callId: string;
    name: string;
    buf: string;
    closed: boolean;
  }

  let nextBlockIdx = 0;
  const items = new Map<number, ItemState>();
  const itemOrder: number[] = [];
  let hasToolCall = false;
  let emittedEnd = false;
  let emittedError = false;

  const ensureItem = (
    outputIdx: number,
    blockType: string,
    callId: string,
    name: string,
  ): ItemState => {
    const existing = items.get(outputIdx);
    if (existing) {
      if (!existing.callId && callId) existing.callId = callId;
      if (!existing.name && name) existing.name = name;
      return existing;
    }
    const st: ItemState = {
      blockIdx: nextBlockIdx++,
      blockType,
      callId,
      name,
      buf: '',
      closed: false,
    };
    items.set(outputIdx, st);
    itemOrder.push(outputIdx);
    let initBlock: ContentBlock | undefined;
    if (blockType === 'toolCall') {
      hasToolCall = true;
      initBlock = { type: 'toolCall', id: callId, name };
    }
    emit(
      withMeta(meta, {
        type: 'block_start',
        index: st.blockIdx,
        blockType,
        ...(initBlock ? { block: initBlock } : {}),
      }),
    );
    return st;
  };

  const closeItem = (st: ItemState | undefined) => {
    if (!st || st.closed) return;
    st.closed = true;
    let block: ContentBlock;
    if (st.blockType === 'thinking') {
      block = { type: 'thinking', thinking: st.buf };
    } else if (st.blockType === 'toolCall') {
      block = {
        type: 'toolCall',
        id: st.callId,
        name: st.name,
        arguments: parseToolArguments(st.buf),
      };
    } else {
      block = { type: 'text', text: st.buf };
    }
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: st.blockIdx,
        blockType: block.type,
        block,
      }),
    );
  };

  const closeRemaining = () => {
    for (const idx of itemOrder) {
      closeItem(items.get(idx));
    }
  };

  for await (const frame of decodeSseByteStream(body)) {
    const data = frame.data.trim();
    if (!data || data === '[DONE]') continue;

    let payload: {
      type?: string;
      output_index?: number;
      item_id?: string;
      delta?: string;
      item?: {
        id?: string;
        type?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      };
      response?: {
        status?: string;
        error?: { message?: string };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          output_tokens_details?: { reasoning_tokens?: number };
        };
      };
      error?: { message?: string };
    };
    try {
      payload = JSON.parse(data) as typeof payload;
    } catch {
      continue;
    }

    const evType = payload.type || frame.event;
    const outputIdx = payload.output_index ?? 0;

    switch (evType) {
      case 'response.output_item.added': {
        const item = payload.item;
        if (!item) break;
        if (item.type === 'reasoning') {
          ensureItem(outputIdx, 'thinking', '', '');
        } else if (item.type === 'message') {
          ensureItem(outputIdx, 'text', '', '');
        } else if (item.type === 'function_call') {
          ensureItem(
            outputIdx,
            'toolCall',
            item.call_id || item.id || '',
            item.name || '',
          );
        }
        break;
      }

      case 'response.output_text.delta': {
        if (!payload.delta) break;
        const st = ensureItem(outputIdx, 'text', '', '');
        st.buf += payload.delta;
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: st.blockIdx,
            blockType: 'text',
            deltaType: 'text_delta',
            delta: payload.delta,
          }),
        );
        break;
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (!payload.delta) break;
        const st = ensureItem(outputIdx, 'thinking', '', '');
        st.buf += payload.delta;
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: st.blockIdx,
            blockType: 'thinking',
            deltaType: 'thinking_delta',
            delta: payload.delta,
          }),
        );
        break;
      }

      case 'response.function_call_arguments.delta': {
        if (!payload.delta) break;
        const st = ensureItem(
          outputIdx,
          'toolCall',
          payload.item_id ?? '',
          '',
        );
        st.buf += payload.delta;
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: st.blockIdx,
            blockType: 'toolCall',
            deltaType: 'toolcall_delta',
            delta: payload.delta,
          }),
        );
        break;
      }

      case 'response.output_item.done': {
        const st = items.get(outputIdx);
        if (!st) break;
        if (payload.item && st.blockType === 'toolCall') {
          if (payload.item.call_id) st.callId = payload.item.call_id;
          if (payload.item.name) st.name = payload.item.name;
          if (!st.buf && payload.item.arguments) {
            st.buf = payload.item.arguments;
          }
        }
        closeItem(st);
        break;
      }

      case 'response.completed':
      case 'response.incomplete': {
        if (emittedEnd) break;
        emittedEnd = true;
        closeRemaining();
        let stopReason = 'stop';
        if (
          evType === 'response.incomplete' ||
          payload.response?.status === 'incomplete'
        ) {
          stopReason = 'length';
        } else if (hasToolCall) {
          stopReason = 'toolUse';
        }
        let usage: TokenUsage | undefined;
        const rawUsage = payload.response?.usage;
        if (rawUsage) {
          const thinkingTokens =
            rawUsage.output_tokens_details?.reasoning_tokens ?? 0;
          usage = {
            inputTokens: rawUsage.input_tokens ?? 0,
            outputTokens: rawUsage.output_tokens ?? 0,
            totalTokens: rawUsage.total_tokens ?? 0,
            ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
          };
        }
        emit(
          withMeta(meta, {
            type: 'message_delta',
            ...(usage ? { usage } : {}),
            stopReason,
          }),
        );
        break;
      }

      case 'response.failed':
      case 'error': {
        emittedError = true;
        const msg =
          payload.error?.message ||
          payload.response?.error?.message ||
          'upstream responses error';
        emit(
          withMeta(meta, {
            type: 'error',
            error: { code: 'UPSTREAM_ERROR', message: msg },
          }),
        );
        return;
      }
    }
  }

  if (!emittedEnd && !emittedError && itemOrder.length > 0) {
    closeRemaining();
    emit(
      withMeta(meta, {
        type: 'message_delta',
        stopReason: hasToolCall ? 'toolUse' : 'stop',
      }),
    );
  }
}

async function decodeAnthropicMessages(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  interface BlockState {
    blockIdx: number;
    blockType: string;
    id: string;
    name: string;
    buf: string;
    signature: string;
    closed: boolean;
  }

  let nextBlockIdx = 0;
  const blocks = new Map<number, BlockState>();
  const blockOrder: number[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let hasUsage = false;
  let stopReason = '';
  let hasToolCall = false;
  let emittedEnd = false;
  let emittedError = false;

  const closeBlock = (st: BlockState | undefined) => {
    if (!st || st.closed) return;
    st.closed = true;
    let block: ContentBlock;
    if (st.blockType === 'thinking') {
      block = {
        type: 'thinking',
        thinking: st.buf,
        ...(st.signature ? { signature: st.signature } : {}),
      };
    } else if (st.blockType === 'toolCall') {
      block = {
        type: 'toolCall',
        id: st.id,
        name: st.name,
        arguments: parseToolArguments(st.buf),
      };
    } else {
      block = { type: 'text', text: st.buf };
    }
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: st.blockIdx,
        blockType: block.type,
        block,
      }),
    );
  };

  const finalize = () => {
    if (emittedEnd || emittedError) return;
    emittedEnd = true;
    for (const idx of blockOrder) {
      closeBlock(blocks.get(idx));
    }
    const resolvedStop = stopReason || (hasToolCall ? 'toolUse' : 'stop');
    let outUsage: TokenUsage | undefined;
    if (hasUsage) {
      outUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
      };
    }
    emit(
      withMeta(meta, {
        type: 'message_delta',
        ...(outUsage ? { usage: outUsage } : {}),
        stopReason: resolvedStop,
      }),
    );
  };

  for await (const frame of decodeSseByteStream(body)) {
    const data = frame.data.trim();
    if (!data) continue;

    let ev: {
      type?: string;
      index?: number;
      message?: {
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
        stop_reason?: string;
      };
      usage?: { output_tokens?: number };
      error?: { message?: string };
    };
    try {
      ev = JSON.parse(data) as typeof ev;
    } catch {
      continue;
    }

    const evType = ev.type || frame.event;
    const rawIdx = ev.index ?? 0;

    switch (evType) {
      case 'message_start': {
        const u = ev.message?.usage;
        if (u) {
          usage.inputTokens =
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          usage.outputTokens = u.output_tokens ?? 0;
          hasUsage = true;
        }
        break;
      }

      case 'content_block_start': {
        const cb = ev.content_block;
        if (!cb) break;
        let blockType = 'text';
        let initBlock: ContentBlock | undefined;
        if (cb.type === 'thinking') {
          blockType = 'thinking';
        } else if (cb.type === 'tool_use') {
          blockType = 'toolCall';
          hasToolCall = true;
          initBlock = {
            type: 'toolCall',
            id: cb.id ?? '',
            name: cb.name ?? '',
          };
        }
        const st: BlockState = {
          blockIdx: nextBlockIdx++,
          blockType,
          id: cb.id ?? '',
          name: cb.name ?? '',
          buf: '',
          signature: '',
          closed: false,
        };
        blocks.set(rawIdx, st);
        blockOrder.push(rawIdx);
        emit(
          withMeta(meta, {
            type: 'block_start',
            index: st.blockIdx,
            blockType,
            ...(initBlock ? { block: initBlock } : {}),
          }),
        );
        break;
      }

      case 'content_block_delta': {
        const st = blocks.get(rawIdx);
        const delta = ev.delta;
        if (!st || !delta) break;
        if (delta.type === 'text_delta' && delta.text) {
          st.buf += delta.text;
          emit(
            withMeta(meta, {
              type: 'block_delta',
              index: st.blockIdx,
              blockType: st.blockType,
              deltaType: 'text_delta',
              delta: delta.text,
            }),
          );
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          st.buf += delta.thinking;
          emit(
            withMeta(meta, {
              type: 'block_delta',
              index: st.blockIdx,
              blockType: st.blockType,
              deltaType: 'thinking_delta',
              delta: delta.thinking,
            }),
          );
        } else if (delta.type === 'signature_delta' && delta.signature) {
          st.signature += delta.signature;
          emit(
            withMeta(meta, {
              type: 'block_delta',
              index: st.blockIdx,
              blockType: st.blockType,
              deltaType: 'signature_delta',
              delta: delta.signature,
            }),
          );
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          st.buf += delta.partial_json;
          emit(
            withMeta(meta, {
              type: 'block_delta',
              index: st.blockIdx,
              blockType: st.blockType,
              deltaType: 'toolcall_delta',
              delta: delta.partial_json,
            }),
          );
        }
        break;
      }

      case 'content_block_stop':
        closeBlock(blocks.get(rawIdx));
        break;

      case 'message_delta':
        if (ev.delta?.stop_reason) {
          stopReason = mapAnthropicStopReason(ev.delta.stop_reason);
        }
        if (ev.usage && ev.usage.output_tokens !== undefined) {
          usage.outputTokens = ev.usage.output_tokens;
          hasUsage = true;
        }
        break;

      case 'message_stop':
        finalize();
        return;

      case 'error': {
        emittedError = true;
        emit(
          withMeta(meta, {
            type: 'error',
            error: {
              code: 'UPSTREAM_ERROR',
              message: ev.error?.message || 'upstream anthropic error',
            },
          }),
        );
        return;
      }
    }
  }

  if (blockOrder.length > 0 && !emittedEnd && !emittedError) {
    finalize();
  }
}

async function decodeGoogleGenAI(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  let nextBlockIdx = 0;
  let activeThinkIdx = -1;
  let thinkBuf = '';
  let activeTextIdx = -1;
  let textBuf = '';
  let hasToolCall = false;
  let toolCounter = 0;
  let finalUsage: TokenUsage | undefined;
  let stopReason = '';
  let emittedError = false;

  const closeThinking = () => {
    if (activeThinkIdx < 0) return;
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: activeThinkIdx,
        blockType: 'thinking',
        block: { type: 'thinking', thinking: thinkBuf },
      }),
    );
    activeThinkIdx = -1;
    thinkBuf = '';
  };

  const closeText = () => {
    if (activeTextIdx < 0) return;
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: activeTextIdx,
        blockType: 'text',
        block: { type: 'text', text: textBuf },
      }),
    );
    activeTextIdx = -1;
    textBuf = '';
  };

  for await (const frame of decodeSseByteStream(body)) {
    const data = frame.data.trim();
    if (!data || data === '[DONE]') continue;

    let chunk: {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
            functionCall?: {
              id?: string;
              name?: string;
              args?: unknown;
            };
          }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      continue;
    }

    if (chunk.error?.message) {
      emittedError = true;
      emit(
        withMeta(meta, {
          type: 'error',
          error: { code: 'UPSTREAM_ERROR', message: chunk.error.message },
        }),
      );
      return;
    }

    if (chunk.usageMetadata) {
      const u = chunk.usageMetadata;
      const inputTokens = u.promptTokenCount ?? 0;
      const outputTokens = u.candidatesTokenCount ?? 0;
      const thinkingTokens = u.thoughtsTokenCount ?? 0;
      const totalTokens =
        u.totalTokenCount && u.totalTokenCount > 0
          ? u.totalTokenCount
          : inputTokens + outputTokens + thinkingTokens;
      finalUsage = {
        inputTokens,
        outputTokens,
        ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
        totalTokens,
      };
    }

    const cand = chunk.candidates?.[0];
    if (!cand) continue;

    for (const part of cand.content?.parts ?? []) {
      if (part.thought && part.text) {
        closeText();
        if (activeThinkIdx < 0) {
          activeThinkIdx = nextBlockIdx++;
          emit(
            withMeta(meta, {
              type: 'block_start',
              index: activeThinkIdx,
              blockType: 'thinking',
            }),
          );
        }
        thinkBuf += part.text;
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: activeThinkIdx,
            blockType: 'thinking',
            deltaType: 'thinking_delta',
            delta: part.text,
          }),
        );
        continue;
      }

      if (part.text) {
        closeThinking();
        if (activeTextIdx < 0) {
          activeTextIdx = nextBlockIdx++;
          emit(
            withMeta(meta, {
              type: 'block_start',
              index: activeTextIdx,
              blockType: 'text',
            }),
          );
        }
        textBuf += part.text;
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: activeTextIdx,
            blockType: 'text',
            deltaType: 'text_delta',
            delta: part.text,
          }),
        );
      }

      if (part.functionCall) {
        closeThinking();
        closeText();
        hasToolCall = true;
        toolCounter += 1;
        const callId = part.functionCall.id || `call_${toolCounter}`;
        const name = part.functionCall.name || '';
        const args = part.functionCall.args ?? {};
        const argsStr = JSON.stringify(args);
        const idx = nextBlockIdx++;

        emit(
          withMeta(meta, {
            type: 'block_start',
            index: idx,
            blockType: 'toolCall',
            block: { type: 'toolCall', id: callId, name },
          }),
        );
        emit(
          withMeta(meta, {
            type: 'block_delta',
            index: idx,
            blockType: 'toolCall',
            deltaType: 'toolcall_delta',
            delta: argsStr,
          }),
        );
        emit(
          withMeta(meta, {
            type: 'block_end',
            index: idx,
            blockType: 'toolCall',
            block: {
              type: 'toolCall',
              id: callId,
              name,
              arguments: args,
            },
          }),
        );
      }
    }

    if (cand.finishReason) {
      stopReason = mapGeminiFinishReason(cand.finishReason);
    }
  }

  if (emittedError) return;
  closeThinking();
  closeText();

  let resolvedStop = stopReason;
  if (hasToolCall && (!resolvedStop || resolvedStop === 'stop')) {
    resolvedStop = 'toolUse';
  }
  if (!resolvedStop) {
    resolvedStop = 'stop';
  }
  emit(
    withMeta(meta, {
      type: 'message_delta',
      ...(finalUsage ? { usage: finalUsage } : {}),
      stopReason: resolvedStop,
    }),
  );
}

export async function decodeUpstreamSseStream(
  apiFormat: string,
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  switch (apiFormat) {
    case 'openai-completions':
      await decodeOpenAICompletions(body, meta, emit);
      return;
    case 'openai-responses':
      await decodeOpenAIResponses(body, meta, emit);
      return;
    case 'anthropic-messages':
      await decodeAnthropicMessages(body, meta, emit);
      return;
    case 'google-generative-ai':
      await decodeGoogleGenAI(body, meta, emit);
      return;
    default:
      throw new Error(`unsupported apiFormat: ${apiFormat}`);
  }
}
