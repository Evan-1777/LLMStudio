import type {
  CompactionBlock,
  CompactionMeta,
  ContentBlock,
  Message,
} from '../../core/types';
import {
  insertMessageAt,
  materializeStreamingMessage,
  type StreamingDraft,
} from '../chat/chatReducer';
import type { PendingAttachment } from './attachments';
import { resolveSideRefMaterials } from './conversationGraph';

export type ContextUsageSource = 'reported' | 'hybrid' | 'estimated';

export interface ContextUsageInput {
  messages: readonly Message[];
  allMessages?: readonly Message[];
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
  activeMessageCount: number;
  compactedCount: number;
  canCompact: boolean;
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
    case 'compaction':
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
    case 'toolResult': {
      let contentStr = String(block.content ?? '');
      if (
        block.extra &&
        typeof block.extra === 'object' &&
        !Array.isArray(block.extra)
      ) {
        const sc = (block.extra as { structuredContent?: unknown })
          .structuredContent;
        if (sc !== undefined && sc !== null) {
          const scText =
            typeof sc === 'string' ? sc.trim() : JSON.stringify(sc);
          if (scText && scText !== 'null' && !contentStr.includes(scText)) {
            contentStr = contentStr ? `${contentStr}\n${scText}` : scText;
          }
        }
      }
      return estimateTextTokens(
        `${String(block.toolName ?? '')} ${contentStr}`,
      );
    }
    case 'image':
      return 1024;
    default:
      return estimateTextTokens(JSON.stringify(block));
  }
}

function hasToolResultBlocks(msg: Message): boolean {
  return msg.blocks.some((b) => b.type === 'toolResult');
}

function estimateMessageTokens(msg: Message): number {
  let tokens = 4;
  for (const block of msg.blocks) {
    tokens += estimateBlockTokens(block);
  }
  return tokens;
}

export function estimateCompactionAfterTokens(
  systemPrompt: string | undefined,
  summary: string,
  keptMessages: readonly Message[],
): number {
  let total = systemPrompt?.trim()
    ? estimateTextTokens(systemPrompt) + 4
    : 0;
  total += 4 + estimateTextTokens(summary);
  for (const msg of keptMessages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

export function parseCompactionMeta(
  msg: Message | undefined,
): Partial<CompactionMeta> | null {
  if (!msg) return null;
  const block = msg.blocks.find(
    (b): b is CompactionBlock => b.type === 'compaction',
  );
  if (
    !block ||
    !block.extra ||
    typeof block.extra !== 'object' ||
    Array.isArray(block.extra)
  ) {
    return null;
  }
  return block.extra as Partial<CompactionMeta>;
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

function estimateMessageSideRefTokens(
  pool: readonly Message[],
  msg: Message,
): number {
  if (!msg.graphMeta?.sideRefs?.length) return 0;
  const { text } = resolveSideRefMaterials(pool, msg);
  if (!text) return 0;
  return 4 + estimateTextTokens(text);
}

export function computeContextUsage({
  messages,
  allMessages,
  streaming,
  systemPrompt,
  draft,
  attachments,
  contextWindow,
}: ContextUsageInput): ContextUsageSnapshot {
  const sideRefPool = allMessages?.length ? allMessages : messages;
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
  let compactIdx = -1;

  for (let i = 0; i < visible.length; i++) {
    const msg = visible[i];
    if (msg.role === 'compaction') {
      compactIdx = i;
    }
    if ((msg.role !== 'assistant' && msg.role !== 'compaction') || !msg.usage) {
      continue;
    }
    const u = msg.usage;
    const reportedTotal =
      u.totalTokens > 0 ? u.totalTokens : u.inputTokens + u.outputTokens;
    sessionTotalTokens += reportedTotal;
    sessionCacheReadTokens += u.cacheReadInputTokens ?? 0;
  }

  const activeVisible = compactIdx >= 0 ? visible.slice(compactIdx) : visible;
  const checkpointMeta =
    compactIdx >= 0 ? parseCompactionMeta(visible[compactIdx]) : null;
  const compactedCount =
    compactIdx >= 0
      ? typeof checkpointMeta?.compactedCount === 'number'
        ? checkpointMeta.compactedCount
        : visible.slice(0, compactIdx).filter((m) => m.role !== 'compaction').length
      : 0;
  const activeMessageCount = activeVisible.filter(
    (m) => m.role !== 'compaction',
  ).length;
  const canCompact = activeMessageCount >= 2;

  let snapshotCutoffIdx = -1;
  if (compactIdx >= 0) {
    snapshotCutoffIdx = 0;
    const snapId = checkpointMeta?.snapshotLastMessageId;
    if (typeof snapId === 'string' && snapId) {
      const idx = activeVisible.findIndex((m) => m.id === snapId);
      if (idx >= 0) {
        snapshotCutoffIdx = Math.max(snapshotCutoffIdx, idx);
      }
    }
  }

  let anchorIdx = -1;
  for (let i = snapshotCutoffIdx + 1; i < activeVisible.length; i++) {
    const msg = activeVisible[i];
    if (msg.role !== 'assistant' || !msg.usage) continue;
    const u = msg.usage;
    if (u.contextTokens !== undefined && u.contextTokens > 0) {
      anchorIdx = i;
    } else if (
      !hasToolResultBlocks(msg) &&
      (u.inputTokens > 0 || u.outputTokens > 0 || u.totalTokens > 0)
    ) {
      anchorIdx = i;
    }
  }

  let usedTokens: number;
  let source: ContextUsageSource;
  if (anchorIdx >= 0) {
    const u = activeVisible[anchorIdx].usage!;
    const anchorTokens =
      u.contextTokens !== undefined && u.contextTokens > 0
        ? u.contextTokens
        : u.inputTokens + u.outputTokens > 0
          ? u.inputTokens + u.outputTokens
          : u.totalTokens;
    let trailingTokens = estimateMessageSideRefTokens(
      sideRefPool,
      activeVisible[anchorIdx],
    );
    for (let i = anchorIdx + 1; i < activeVisible.length; i++) {
      trailingTokens +=
        estimateMessageTokens(activeVisible[i]) +
        estimateMessageSideRefTokens(sideRefPool, activeVisible[i]);
    }
    usedTokens = anchorTokens + trailingTokens + draftTokens;
    source =
      anchorIdx === activeVisible.length - 1 &&
      trailingTokens === 0 &&
      draftTokens === 0
        ? 'reported'
        : 'hybrid';
  } else {
    const sysTokens = systemPrompt?.trim()
      ? estimateTextTokens(systemPrompt) + 4
      : 0;
    let historyTokens = 0;
    for (const msg of activeVisible) {
      historyTokens +=
        estimateMessageTokens(msg) +
        estimateMessageSideRefTokens(sideRefPool, msg);
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
    activeMessageCount,
    compactedCount,
    canCompact,
    sessionTotalTokens,
    sessionCacheReadTokens,
    source,
  };
}
