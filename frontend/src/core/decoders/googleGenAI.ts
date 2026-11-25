import { decodeSseByteStream } from '../sse';
import type { ContentBlock, StreamEvent, TokenUsage } from '../types';
import {
  mapGeminiFinishReason,
  withMeta,
  type LocalStreamMeta,
} from './shared';

export async function decodeGoogleGenAI(
  body: ReadableStream<Uint8Array>,
  meta: LocalStreamMeta,
  emit: (event: StreamEvent) => void,
): Promise<void> {
  let nextBlockIdx = 0;
  let activeThinkIdx = -1;
  let thinkBuf = '';
  let thinkSig = '';
  let activeTextIdx = -1;
  let textBuf = '';
  let hasToolCall = false;
  let toolCounter = 0;
  const seenCallIds = new Set<string>();
  let finalUsage: TokenUsage | undefined;
  let stopReason = '';
  let emittedError = false;

  const closeThinking = () => {
    if (activeThinkIdx < 0) return;
    const block: ContentBlock = {
      type: 'thinking',
      thinking: thinkBuf,
      ...(thinkSig
        ? {
            signature: thinkSig,
            extra: {
              providerFormat: 'google-generative-ai',
              thoughtSignature: thinkSig,
            },
          }
        : {}),
    };
    emit(
      withMeta(meta, {
        type: 'block_end',
        index: activeThinkIdx,
        blockType: 'thinking',
        block,
      }),
    );
    activeThinkIdx = -1;
    thinkBuf = '';
    thinkSig = '';
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
            thoughtSignature?: string;
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
        cachedContentTokenCount?: number;
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
      const cacheReadInputTokens = u.cachedContentTokenCount ?? 0;
      const totalTokens =
        u.totalTokenCount && u.totalTokenCount > 0
          ? u.totalTokenCount
          : inputTokens + outputTokens + thinkingTokens;
      finalUsage = {
        inputTokens,
        outputTokens,
        ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
        ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
        totalTokens,
      };
    }

    const cand = chunk.candidates?.[0];
    if (!cand) continue;

    for (const part of cand.content?.parts ?? []) {
      if (part.thought && (part.text || part.thoughtSignature)) {
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
        if (part.text) {
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
        }
        if (part.thoughtSignature) {
          thinkSig = part.thoughtSignature;
          emit(
            withMeta(meta, {
              type: 'block_delta',
              index: activeThinkIdx,
              blockType: 'thinking',
              deltaType: 'signature_delta',
              delta: part.thoughtSignature,
            }),
          );
        }
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
        if (part.functionCall.id) {
          if (seenCallIds.has(part.functionCall.id)) continue;
          seenCallIds.add(part.functionCall.id);
        }
        hasToolCall = true;
        toolCounter += 1;
        const callId = part.functionCall.id || `call_${toolCounter}`;
        const name = part.functionCall.name || '';
        const args = part.functionCall.args ?? {};
        const argsStr = JSON.stringify(args);
        const idx = nextBlockIdx++;
        const sigExtra = part.thoughtSignature
          ? {
              signature: part.thoughtSignature,
              extra: {
                providerFormat: 'google-generative-ai',
                thoughtSignature: part.thoughtSignature,
              },
            }
          : {};

        emit(
          withMeta(meta, {
            type: 'block_start',
            index: idx,
            blockType: 'toolCall',
            block: { type: 'toolCall', id: callId, name, ...sigExtra },
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
              ...sigExtra,
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
