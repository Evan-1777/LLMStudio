import { GatewayError } from '../../core/gateway';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonStringMap(
  raw: string,
  fieldLabel: string,
): ParseResult<Record<string, string>> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: `${fieldLabel} JSON 格式无效` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${fieldLabel}须为 JSON 对象` };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `${fieldLabel}的值须为字符串` };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

export function parseJsonObject(
  raw: string,
  fieldLabel: string,
): ParseResult<Record<string, unknown> | undefined> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: `${fieldLabel} JSON 格式无效` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${fieldLabel}须为 JSON 对象` };
  }
  return { ok: true, value: parsed };
}

export function parseJsonStringArray(
  raw: string,
  fieldLabel: string,
): ParseResult<string[]> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: `${fieldLabel} JSON 格式无效` };
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    return { ok: false, error: `${fieldLabel}须为 JSON 字符串数组` };
  }
  return { ok: true, value: parsed as string[] };
}

export function validateHttpUrl(raw: string, fieldLabel: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return `${fieldLabel}不能为空`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${fieldLabel}须为 http 或 https 地址`;
    }
    if (!parsed.host) {
      return `${fieldLabel}缺少有效主机名`;
    }
    return null;
  } catch {
    return `${fieldLabel}格式无效`;
  }
}

export function errorMessageOf(err: unknown, fallback = '操作失败'): string {
  if (err instanceof GatewayError) return err.message;
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}
