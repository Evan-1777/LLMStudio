import type {
  Assistant,
  Conversation,
  ModelConfig,
  ProviderConfig,
  ScheduleRunStatus,
} from '../../core/types';

export interface WeekdayPillOption {
  value: number;
  short: string;
  full: string;
}

export const WEEKDAY_PILLS: readonly WeekdayPillOption[] = [
  { value: 1, short: '一', full: '周一' },
  { value: 2, short: '二', full: '周二' },
  { value: 3, short: '三', full: '周三' },
  { value: 4, short: '四', full: '周四' },
  { value: 5, short: '五', full: '周五' },
  { value: 6, short: '六', full: '周六' },
  { value: 0, short: '日', full: '周日' },
];

export const COMMON_TIMEZONES: readonly string[] = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
];

const SHORT_NAMES: readonly string[] = ['日', '一', '二', '三', '四', '五', '六'];
const DISPLAY_ORDER: ReadonlyMap<number, number> = new Map([
  [1, 0],
  [2, 1],
  [3, 2],
  [4, 3],
  [5, 4],
  [6, 5],
  [0, 6],
]);

function pad2(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, '0');
}

export function getDefaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function formatAlarmTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function parseTimeValue(
  raw: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

export function normalizeWeekdays(weekdays: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const day of weekdays) {
    if (Number.isInteger(day) && day >= 0 && day <= 6) {
      seen.add(day);
    }
  }
  return Array.from(seen).sort(
    (a, b) => (DISPLAY_ORDER.get(a) ?? a) - (DISPLAY_ORDER.get(b) ?? b),
  );
}

export function formatWeekdays(weekdays: readonly number[]): string {
  const sorted = normalizeWeekdays(weekdays);
  if (sorted.length === 0 || sorted.length === 7) {
    return '每日';
  }
  if (
    sorted.length === 5 &&
    sorted[0] === 1 &&
    sorted[1] === 2 &&
    sorted[2] === 3 &&
    sorted[3] === 4 &&
    sorted[4] === 5
  ) {
    return '工作日';
  }
  if (sorted.length === 2 && sorted[0] === 6 && sorted[1] === 0) {
    return '周末';
  }
  return `周${sorted.map((day) => SHORT_NAMES[day]).join('、')}`;
}

export function formatRunProgress(runCount: number, maxRuns: number): string {
  if (maxRuns <= 0) return '∞';
  return `${runCount}/${maxRuns}`;
}

export function formatNextRunLabel(
  nextRunAt?: string,
  now: Date = new Date(),
): string {
  if (!nextRunAt) return '';
  const dt = new Date(nextRunAt);
  if (Number.isNaN(dt.getTime())) return '';

  const hm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diffDays = Math.round(
    (targetStart.getTime() - todayStart.getTime()) / 86_400_000,
  );
  if (diffDays === 0) return `今天 ${hm}`;
  if (diffDays === 1) return `明天 ${hm}`;
  return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} ${hm}`;
}

export function formatLastStatus(status: ScheduleRunStatus): {
  label: string;
  tone: 'neutral' | 'accent' | 'success' | 'danger' | 'warning';
} {
  switch (status) {
    case 'running':
      return { label: '运行中', tone: 'accent' };
    case 'succeeded':
      return { label: '已成功', tone: 'success' };
    case 'failed':
      return { label: '失败', tone: 'danger' };
    case 'skipped':
      return { label: '已跳过', tone: 'warning' };
    case '':
      return { label: '', tone: 'neutral' };
  }
}

export interface CloudModelOption {
  key: string;
  provider: ProviderConfig;
  model: ModelConfig;
  usable: boolean;
}

const MODEL_KEY_SEP = '\u0000';

export function makeModelSelectionKey(providerId: string, modelId: string): string {
  if (!providerId || !modelId) return '';
  return `${providerId}${MODEL_KEY_SEP}${modelId}`;
}

export function parseModelSelectionKey(
  key: string,
): { providerId: string; modelId: string } | null {
  if (!key) return null;
  const idx = key.indexOf(MODEL_KEY_SEP);
  if (idx <= 0 || idx >= key.length - 1) return null;
  return {
    providerId: key.slice(0, idx),
    modelId: key.slice(idx + 1),
  };
}

export function getCloudEligibleModels(
  providers: readonly ProviderConfig[],
): CloudModelOption[] {
  const out: CloudModelOption[] = [];
  for (const provider of providers) {
    if (!provider.enabled || provider.localRequest) continue;
    const usable = provider.authType === 'none' || provider.apiKeySet;
    for (const model of provider.models) {
      out.push({
        key: makeModelSelectionKey(provider.id, model.id),
        provider,
        model,
        usable,
      });
    }
  }
  return out;
}

export interface CloudAgentConversationOption {
  id: string;
  title: string;
  assistantId: string;
  assistantName: string;
  updatedAt: string;
}

export function buildCloudAgentConversations(
  conversations: readonly Conversation[],
  assistants: readonly Assistant[],
): CloudAgentConversationOption[] {
  const assistantNames = new Map<string, string>();
  for (const assistant of assistants) {
    assistantNames.set(assistant.id, assistant.name);
  }
  return conversations
    .filter((conv) => !conv.ephemeral && conv.mode === 'agent')
    .map((conv) => ({
      id: conv.id,
      title: conv.title || '未命名话题',
      assistantId: conv.assistantId || 'default',
      assistantName:
        assistantNames.get(conv.assistantId || 'default') ??
        conv.assistantId ??
        '默认助手',
      updatedAt: conv.updatedAt || conv.createdAt || '',
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function formatScheduleError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}
