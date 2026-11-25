import type { StreamEvent } from '../types';

export interface LocalStreamMeta {
  conversationId?: string;
  messageId?: string;
  providerId?: string;
  modelId?: string;
}

export function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function withMeta(meta: LocalStreamMeta, ev: StreamEvent): StreamEvent {
  return {
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    ...(meta.messageId ? { messageId: meta.messageId } : {}),
    ...(meta.providerId ? { providerId: meta.providerId } : {}),
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...ev,
  };
}

export function mapOpenAIFinishReason(reason: string): string {
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

export function mapAnthropicStopReason(reason: string): string {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'toolUse';
    default:
      return 'stop';
  }
}

export function mapGeminiFinishReason(reason: string): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    default:
      return 'stop';
  }
}
