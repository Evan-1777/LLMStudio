import type { IconName } from '../components/ui';
import type { ContentBlock, ToolCallBlock, ToolResultBlock } from '../core/types';

export interface PairedToolCallEntry {
  index: number;
  call?: ToolCallBlock;
  result?: ToolResultBlock;
  resultIndex?: number;
}

export interface PairedToolEntriesResult {
  entries: Map<number, PairedToolCallEntry>;
  pairedResultIndexes: Set<number>;
}

export interface ProcessTraceSpan {
  start: number;
  end: number;
  toolCount: number;
  thinkingCount: number;
  stepCount: number;
}

const PREFERRED_ARG_KEYS = [
  'path',
  'file',
  'query',
  'q',
  'url',
  'command',
  'name',
  'id',
  'target',
] as const;

export function buildPairedToolEntries(blocks: ContentBlock[]): PairedToolEntriesResult {
  const entries = new Map<number, PairedToolCallEntry>();
  const pairedResultIndexes = new Set<number>();
  const openCallsById = new Map<string, PairedToolCallEntry[]>();

  blocks.forEach((block, index) => {
    if (block.type === 'toolCall') {
      const call = block as ToolCallBlock;
      const entry: PairedToolCallEntry = { index, call };
      entries.set(index, entry);
      if (call.id) {
        const list = openCallsById.get(call.id);
        if (list) {
          list.push(entry);
        } else {
          openCallsById.set(call.id, [entry]);
        }
      }
      return;
    }

    if (block.type === 'toolResult') {
      const result = block as ToolResultBlock;
      let matched: PairedToolCallEntry | undefined;
      if (result.toolCallId) {
        const list = openCallsById.get(result.toolCallId);
        if (list) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (!list[i].result) {
              matched = list[i];
              break;
            }
          }
        }
      }
      if (matched) {
        matched.result = result;
        matched.resultIndex = index;
        pairedResultIndexes.add(index);
      } else {
        entries.set(index, { index, result, resultIndex: index });
      }
    }
  });

  return { entries, pairedResultIndexes };
}

export function toolIconName(toolName: string): IconName {
  switch (toolName.trim().toLowerCase()) {
    case 'read':
      return 'fileText';
    case 'write':
    case 'edit':
      return 'edit';
    case 'ls':
      return 'folder';
    case 'find':
    case 'grep':
      return 'search';
    case 'bash':
      return 'terminal';
    case 'skill':
      return 'plugin';
    case 'get_current_time':
      return 'clock';
    case 'schedule':
      return 'alarmClock';
    default:
      return 'wrench';
  }
}

function truncateSingleLine(raw: string, maxLen: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

export function firstNonEmptyLine(text: string, maxLen = 64): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return truncateSingleLine(trimmed, maxLen);
    }
  }
  return '';
}

function asRecord(args: unknown): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return null;
}

function nonEmptyString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function formatPrimitive(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return '';
}

export function summarizeToolArgs(
  toolName: string,
  args: unknown,
  maxLen = 80,
): string {
  const rec = asRecord(args);
  if (!rec) return '';
  const normalized = toolName.trim().toLowerCase();

  if (normalized === 'read') {
    const p = nonEmptyString(rec.path);
    if (p) {
      const offset = typeof rec.offset === 'number' && Number.isFinite(rec.offset) ? rec.offset : undefined;
      return truncateSingleLine(offset && offset > 0 ? `${p}:L${offset}` : p, maxLen);
    }
  } else if (normalized === 'write' || normalized === 'edit' || normalized === 'ls') {
    const p = nonEmptyString(rec.path);
    if (p) return truncateSingleLine(p, maxLen);
  } else if (normalized === 'find' || normalized === 'grep') {
    const pattern = nonEmptyString(rec.pattern);
    const p = nonEmptyString(rec.path);
    if (pattern) {
      const combined = p && p !== '.' ? `${pattern} in ${p}` : pattern;
      return truncateSingleLine(combined, maxLen);
    }
    if (p) return truncateSingleLine(p, maxLen);
  } else if (normalized === 'bash') {
    const cmd = nonEmptyString(rec.command);
    if (cmd) return firstNonEmptyLine(cmd, maxLen);
  } else if (normalized === 'skill') {
    const name = nonEmptyString(rec.name);
    if (name) return truncateSingleLine(name, maxLen);
  } else if (normalized === 'get_current_time') {
    const tz = nonEmptyString(rec.timezone);
    if (tz) return truncateSingleLine(tz, maxLen);
  } else if (normalized === 'schedule') {
    const action = nonEmptyString(rec.action);
    const name = nonEmptyString(rec.name);
    const id = nonEmptyString(rec.id);
    const hour = typeof rec.hour === 'number' && Number.isInteger(rec.hour) && rec.hour >= 0 && rec.hour <= 23 ? rec.hour : undefined;
    const minute = typeof rec.minute === 'number' && Number.isInteger(rec.minute) && rec.minute >= 0 && rec.minute <= 59 ? rec.minute : undefined;
    const clock = hour !== undefined && minute !== undefined
      ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      : '';
    const detail = [name || (action === 'delete' || action === 'update' ? id : ''), clock].filter(Boolean).join(' ');
    if (action) {
      if (action === 'list' && rec.current_topic_only === true) {
        return truncateSingleLine('list · 当前话题', maxLen);
      }
      return truncateSingleLine(detail ? `${action} · ${detail}` : action, maxLen);
    }
    if (detail) return truncateSingleLine(detail, maxLen);
  }

  for (const key of PREFERRED_ARG_KEYS) {
    const val = formatPrimitive(rec[key]);
    if (val) return firstNonEmptyLine(val, maxLen);
  }

  for (const [, value] of Object.entries(rec)) {
    const val = formatPrimitive(value);
    if (val) return firstNonEmptyLine(val, maxLen);
  }

  return '';
}

export function buildProcessTrace(
  blocks: ContentBlock[],
  paired: PairedToolEntriesResult,
): ProcessTraceSpan | undefined {
  if (paired.entries.size === 0) return undefined;

  const isTool = (b: ContentBlock) => b.type === 'toolCall' || b.type === 'toolResult';
  const start = blocks.findIndex((b) => b.type === 'thinking' || isTool(b));
  let end = blocks.findLastIndex(isTool);
  if (start < 0 || end < start) return undefined;
  while (blocks[end + 1]?.type === 'thinking') end++;

  let toolCount = 0;
  let thinkingCount = 0;
  let transitionTextCount = 0;

  for (let i = start; i <= end; i++) {
    if (paired.pairedResultIndexes.has(i)) continue;
    const b = blocks[i];
    if (paired.entries.has(i)) {
      toolCount++;
    } else if (b.type === 'thinking') {
      thinkingCount++;
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      transitionTextCount++;
    }
  }

  const stepCount = toolCount + thinkingCount + transitionTextCount;
  if (toolCount === 0 || stepCount < 2) return undefined;
  return { start, end, toolCount, thinkingCount, stepCount };
}
