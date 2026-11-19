import type { ContentBlock, Message } from '../../core/types';
import {
  insertMessageAt,
  materializeStreamingMessage,
  type StreamingDraft,
} from '../chat/chatReducer';
import type { PendingAttachment } from './attachments';

export type ContextUsageSource = 'reported' | 'hybrid' | 'estimated';

export interface ContextUsageInput {
  messages: readonly Message[];
  streaming?: StreamingDraft | null;
  systemPrompt?: string;
  draft: string;
  attachments: readonly PendingAttachment[];
  contextWindow?: number | null;
}

export interface ContextUsageSnapshot {
  usedTokens: number;
  contextWindow: number | null;
  ratio: number | null;
  percent: number | null;
  rawPercent: number | null;
  remainingTokens: number | null;
  draftTokens: number;
  messageCount: number;
  sessionTotalTokens: number;
  sessionCacheReadTokens: number;
  source: ContextUsageSource;
}

// ponytail: deterministic CJK/ASCII character heuristic; swap for a model BPE tokenizer
// here if exact offline pre-flight counts are ever required.
export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let asciiUnits = 0;
  let nonAsciiUnits = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) <= 0x7f) asciiUnits += 1;
    else nonAsciiUnits += 1;
  }
  return Math.max(1, Math.ceil(asciiUnits / 3.5 + nonAsciiUnits / 1.5));
}

function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(String(block.text ?? ''));
    case 'thinking':
      return estimateTextTokens(String(block.thinking ?? ''));
    case 'toolCall': {
      const args =
        block.arguments === undefined
          ? ''
          : typeof block.arguments === 'string'
            ? block.arguments
            : JSON.stringify(block.arguments);
      return estimateTextTokens(`${String(block.name ?? '')} ${args}`);
    }
    case 'toolResult':
      return estimateTextTokens(
        `${String(block.toolName ?? '')} ${String(block.content ?? '')}`,
      );
    case 'image':
      return 1024;
    default:
      return estimateTextTokens(JSON.stringify(block));
  }
}

function estimateMessageTokens(msg: Message): number {
  let tokens = 4;
  for (const block of msg.blocks) {
    tokens += estimateBlockTokens(block);
  }
  return tokens;
}

function estimateAttachmentsTokens(
  attachments: readonly PendingAttachment[],
): number {
  let tokens = 0;
  for (const att of attachments) {
    if (att.status !== 'ready') continue;
    if (att.kind === 'image') {
      tokens += 1024;
    } else {
      tokens += estimateTextTokens(att.textContent ?? att.name);
    }
  }
  return tokens;
}

export function formatCompactTokens(n: number): string {
  const safe = Math.max(0, Math.round(n));
  if (safe < 1000) return String(safe);
  if (safe < 1_000_000) {
    const val = (safe / 1000).toFixed(safe >= 10_000 ? 0 : 1).replace(/\.0$/, '');
    return `${val}K`;
  }
  const val = (safe / 1_000_000)
    .toFixed(safe >= 10_000_000 ? 0 : 1)
    .replace(/\.0$/, '');
  return `${val}M`;
}

export function computeContextUsage({
  messages,
  streaming,
  systemPrompt,
  draft,
  attachments,
  contextWindow,
}: ContextUsageInput): ContextUsageSnapshot {
  const visible = streaming
    ? insertMessageAt(
        messages as Message[],
        materializeStreamingMessage('', streaming),
        streaming.insertIndex,
      )
    : messages;

  const draftTokens =
    estimateTextTokens(draft) + estimateAttachmentsTokens(attachments);

  let sessionTotalTokens = 0;
  let sessionCacheReadTokens = 0;
  let anchorIdx = -1;

  for (let i = 0; i < visible.length; i++) {
    const msg = visible[i];
    if (msg.role !== 'assistant' || !msg.usage) continue;
    const u = msg.usage;
    const reportedTotal =
      u.totalTokens > 0 ? u.totalTokens : u.inputTokens + u.outputTokens;
    sessionTotalTokens += reportedTotal;
    sessionCacheReadTokens += u.cacheReadInputTokens ?? 0;
    if (u.inputTokens > 0 || u.outputTokens > 0 || u.totalTokens > 0) {
      anchorIdx = i;
    }
  }

  let usedTokens: number;
  let source: ContextUsageSource;
  if (anchorIdx >= 0) {
    const u = visible[anchorIdx].usage!;
    const anchorTokens =
      u.inputTokens + u.outputTokens > 0
        ? u.inputTokens + u.outputTokens
        : u.totalTokens;
    let trailingTokens = 0;
    for (let i = anchorIdx + 1; i < visible.length; i++) {
      trailingTokens += estimateMessageTokens(visible[i]);
    }
    usedTokens = anchorTokens + trailingTokens + draftTokens;
    source =
      anchorIdx === visible.length - 1 && draftTokens === 0
        ? 'reported'
        : 'hybrid';
  } else {
    const sysTokens = systemPrompt?.trim()
      ? estimateTextTokens(systemPrompt) + 4
      : 0;
    let historyTokens = 0;
    for (const msg of visible) {
      historyTokens += estimateMessageTokens(msg);
    }
    usedTokens = sysTokens + historyTokens + draftTokens;
    source = 'estimated';
  }

  const validWindow =
    typeof contextWindow === 'number' &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
      ? Math.trunc(contextWindow)
      : null;

  const rawPercent =
    validWindow !== null ? (usedTokens / validWindow) * 100 : null;
  const ratio =
    validWindow !== null ? Math.min(1, Math.max(0, usedTokens / validWindow)) : null;
  const percent =
    rawPercent !== null ? Math.round(rawPercent) : null;
  const remainingTokens =
    validWindow !== null ? Math.max(0, validWindow - usedTokens) : null;

  return {
    usedTokens,
    contextWindow: validWindow,
    ratio,
    percent,
    rawPercent,
    remainingTokens,
    draftTokens,
    messageCount: visible.length,
    sessionTotalTokens,
    sessionCacheReadTokens,
    source,
  };
}
