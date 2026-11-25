import { decodeSseByteStream } from '../sse';
import type { ContentBlock, StreamEvent, TokenUsage } from '../types';
import {
  parseToolArguments,
  withMeta,
  type LocalStreamMeta,
} from './shared';

export async function decodeOpenAIResponses(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  interface ItemState {
    blockIdx: number;
    blockType: string;
    itemId: string;
    callId: string;
    name: string;
    encryptedContent: string;
    buf: string;
    closed: boolean;
  }

  let nextBlockIdx = 0;
  const items = new Map<number, ItemState>();
  const itemOrder: number[] = [];
  const seenSeq = new Set<number>();
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
      itemId: '',
      callId,
      name,
      encryptedContent: '',
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

  interface ResponsesItemPayload {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    encrypted_content?: string;
    summary?: Array<{ text?: string }>;
    content?: Array<{ text?: string }>;
  }

  const applyItemSnapshot = (
    st: ItemState | undefined,
    item: ResponsesItemPayload | undefined,
  ) => {
    if (!st || !item) return;
    if (item.id && !st.itemId) st.itemId = item.id;
    if (item.encrypted_content) st.encryptedContent = item.encrypted_content;
    if (st.blockType === 'toolCall') {
      if (item.call_id) st.callId = item.call_id;
      if (item.name) st.name = item.name;
      if (!st.buf && item.arguments) st.buf = item.arguments;
    } else if (st.blockType === 'thinking') {
      if (!st.buf && item.summary?.length) {
        st.buf = item.summary.map((s) => s.text ?? '').join('');
      }
    } else {
      if (!st.buf && item.content?.length) {
        st.buf = item.content.map((c) => c.text ?? '').join('');
      }
    }
  };

  const closeItem = (st: ItemState | undefined) => {
    if (!st || st.closed) return;
    st.closed = true;
    let block: ContentBlock;
    if (st.blockType === 'thinking') {
      block = {
        type: 'thinking',
        thinking: st.buf,
        ...(st.encryptedContent
          ? {
              signature: st.encryptedContent,
              extra: {
                providerFormat: 'openai-responses',
                ...(st.itemId ? { itemId: st.itemId } : {}),
                encryptedContent: st.encryptedContent,
              },
            }
          : {}),
      };
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
      sequence_number?: number;
      output_index?: number;
      item_id?: string;
      delta?: string;
      text?: string;
      arguments?: string;
      item?: ResponsesItemPayload;
      response?: {
        status?: string;
        output?: ResponsesItemPayload[];
        error?: { message?: string };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          input_tokens_details?: {
            cached_tokens?: number;
            cache_write_tokens?: number;
            cache_creation_tokens?: number;
          };
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

    if (payload.sequence_number !== undefined) {
      if (seenSeq.has(payload.sequence_number)) continue;
      seenSeq.add(payload.sequence_number);
    }

    const evType = payload.type || frame.event;
    const outputIdx = payload.output_index ?? 0;

    switch (evType) {
      case 'response.output_item.added': {
        const item = payload.item;
        if (!item) break;
        let blockType = '';
        let callId = '';
        let name = '';
        if (item.type === 'reasoning') {
          blockType = 'thinking';
        } else if (item.type === 'message') {
          blockType = 'text';
        } else if (item.type === 'function_call') {
          blockType = 'toolCall';
          callId = item.call_id || item.id || '';
          name = item.name || '';
        } else {
          break;
        }
        const st = ensureItem(outputIdx, blockType, callId, name);
        if (item.id) st.itemId = item.id;
        if (item.encrypted_content) st.encryptedContent = item.encrypted_content;
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

      case 'response.output_text.done': {
        const st = items.get(outputIdx);
        if (st && !st.buf && payload.text) st.buf = payload.text;
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

      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done': {
        const st = items.get(outputIdx);
        if (st && !st.buf && payload.text) st.buf = payload.text;
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

      case 'response.function_call_arguments.done': {
        const st = items.get(outputIdx);
        if (st && !st.buf && payload.arguments) st.buf = payload.arguments;
        break;
      }

      case 'response.output_item.done': {
        let st = items.get(outputIdx);
        if (!st && payload.item) {
          const item = payload.item;
          if (item.type === 'reasoning') {
            st = ensureItem(outputIdx, 'thinking', '', '');
          } else if (item.type === 'message') {
            st = ensureItem(outputIdx, 'text', '', '');
          } else if (item.type === 'function_call') {
            st = ensureItem(
              outputIdx,
              'toolCall',
              item.call_id || item.id || '',
              item.name || '',
            );
          }
        }
        if (!st) break;
        applyItemSnapshot(st, payload.item);
        closeItem(st);
        break;
      }

      case 'response.completed':
      case 'response.incomplete': {
        if (emittedEnd) break;
        emittedEnd = true;
        if (payload.response?.output?.length) {
          payload.response.output.forEach((item, outIdx) => {
            let st = items.get(outIdx);
            if (!st) {
              if (item.type === 'reasoning') {
                st = ensureItem(outIdx, 'thinking', '', '');
              } else if (item.type === 'message') {
                st = ensureItem(outIdx, 'text', '', '');
              } else if (item.type === 'function_call') {
                st = ensureItem(
                  outIdx,
                  'toolCall',
                  item.call_id || item.id || '',
                  item.name || '',
                );
              }
            }
            applyItemSnapshot(st, item);
          });
        }
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
          const inputTokens = rawUsage.input_tokens ?? 0;
          const outputTokens = rawUsage.output_tokens ?? 0;
          const totalTokens =
            rawUsage.total_tokens && rawUsage.total_tokens > 0
              ? rawUsage.total_tokens
              : inputTokens + outputTokens;
          const thinkingTokens =
            rawUsage.output_tokens_details?.reasoning_tokens ?? 0;
          const cacheReadInputTokens =
            rawUsage.input_tokens_details?.cached_tokens ?? 0;
          const cacheCreationInputTokens =
            (rawUsage.input_tokens_details?.cache_write_tokens ?? 0) > 0
              ? (rawUsage.input_tokens_details?.cache_write_tokens ?? 0)
              : (rawUsage.input_tokens_details?.cache_creation_tokens ?? 0);
          usage = {
            inputTokens,
            outputTokens,
            totalTokens,
            ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
            ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
            ...(cacheCreationInputTokens > 0
              ? { cacheCreationInputTokens }
              : {}),
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
