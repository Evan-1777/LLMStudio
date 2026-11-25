import { decodeSseByteStream } from '../sse';
import type { ContentBlock, StreamEvent, TokenUsage } from '../types';
import {
  mapAnthropicStopReason,
  parseToolArguments,
  withMeta,
  type LocalStreamMeta,
} from './shared';

export async function decodeAnthropicMessages(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  interface BlockState {
    blockIdx: number;
    blockType: string;
    id: string;
    name: string;
    redactedData: string;
    fallbackArgs: string;
    buf: string;
    signature: string;
    closed: boolean;
  }

  let nextBlockIdx = 0;
  const blocks = new Map<number, BlockState>();
  const blockOrder: number[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let hasUsage = false;
  let rawInputTokens = 0;

  // Anthropic reports uncached input separately from the cached portions, and
  // later frames may omit fields the first frame carried.
  const mergeUsage = (frame: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  }) => {
    if (frame.input_tokens !== undefined) rawInputTokens = frame.input_tokens;
    if (frame.cache_creation_input_tokens !== undefined) {
      usage.cacheCreationInputTokens = frame.cache_creation_input_tokens;
    }
    if (frame.cache_read_input_tokens !== undefined) {
      usage.cacheReadInputTokens = frame.cache_read_input_tokens;
    }
    usage.inputTokens =
      rawInputTokens +
      (usage.cacheCreationInputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0);
    if (frame.output_tokens !== undefined) {
      usage.outputTokens = frame.output_tokens;
    }
  };
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
        ...(st.redactedData
          ? {
              extra: {
                providerFormat: 'anthropic-messages',
                anthropicRedactedThinking: st.redactedData,
              },
            }
          : {}),
      };
    } else if (st.blockType === 'toolCall') {
      block = {
        type: 'toolCall',
        id: st.id,
        name: st.name,
        arguments: parseToolArguments(st.buf || st.fallbackArgs),
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
        ...(usage.cacheReadInputTokens && usage.cacheReadInputTokens > 0
          ? { cacheReadInputTokens: usage.cacheReadInputTokens }
          : {}),
        ...(usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0
          ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
          : {}),
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
      content_block?: {
        type?: string;
        id?: string;
        name?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        data?: string;
        input?: Record<string, unknown>;
      };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
        stop_reason?: string;
      };
      usage?: {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
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
          mergeUsage(u);
          hasUsage = true;
        }
        break;
      }

      case 'content_block_start': {
        const cb = ev.content_block;
        if (!cb) break;
        let blockType = 'text';
        let initBlock: ContentBlock | undefined;
        let buf = '';
        let signature = '';
        let redactedData = '';
        let fallbackArgs = '';
        if (cb.type === 'thinking') {
          blockType = 'thinking';
          if (cb.thinking) buf = cb.thinking;
          if (cb.signature) signature = cb.signature;
        } else if (cb.type === 'redacted_thinking') {
          blockType = 'thinking';
          if (cb.data) redactedData = cb.data;
        } else if (cb.type === 'tool_use') {
          blockType = 'toolCall';
          hasToolCall = true;
          if (cb.input && Object.keys(cb.input).length > 0) {
            fallbackArgs = JSON.stringify(cb.input);
          }
          initBlock = {
            type: 'toolCall',
            id: cb.id ?? '',
            name: cb.name ?? '',
          };
        } else if (cb.text) {
          buf = cb.text;
        }
        const st: BlockState = {
          blockIdx: nextBlockIdx++,
          blockType,
          id: cb.id ?? '',
          name: cb.name ?? '',
          redactedData,
          fallbackArgs,
          buf,
          signature,
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
        if (ev.usage) {
          mergeUsage(ev.usage);
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
