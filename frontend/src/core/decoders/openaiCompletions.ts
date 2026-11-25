import { decodeSseByteStream } from '../sse';
import type { StreamEvent, TokenUsage } from '../types';
import {
  mapOpenAIFinishReason,
  parseToolArguments,
  withMeta,
  type LocalStreamMeta,
} from './shared';

export async function decodeOpenAICompletions(
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
        // DeepSeek-compatible endpoints report cache hits and misses at the top level.
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
          cache_creation_tokens?: number;
        };
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
      const hitTokens = chunk.usage.prompt_cache_hit_tokens;
      const missTokens = chunk.usage.prompt_cache_miss_tokens;
      // A miss is an uncached prompt, never a cache write; hit plus miss only
      // reconstructs the input total when the endpoint omits prompt_tokens.
      const inputTokens =
        chunk.usage.prompt_tokens ??
        (hitTokens !== undefined && missTokens !== undefined
          ? hitTokens + missTokens
          : 0);
      const outputTokens = chunk.usage.completion_tokens ?? 0;
      const totalTokens =
        chunk.usage.total_tokens && chunk.usage.total_tokens > 0
          ? chunk.usage.total_tokens
          : inputTokens + outputTokens;
      const thinkingTokens =
        chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      const cacheReadInputTokens =
        chunk.usage.prompt_tokens_details?.cached_tokens ?? hitTokens ?? 0;
      const cacheCreationInputTokens =
        (chunk.usage.prompt_tokens_details?.cache_write_tokens ?? 0) > 0
          ? (chunk.usage.prompt_tokens_details?.cache_write_tokens ?? 0)
          : (chunk.usage.prompt_tokens_details?.cache_creation_tokens ?? 0);
      finalUsage = {
        inputTokens,
        outputTokens,
        totalTokens,
        ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
        ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
        ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
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
      if (st && tc.id && st.id && tc.id !== st.id) {
        if (!st.closed) {
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
        st = undefined;
      }
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
