import { GatewayError, type GatewayClient } from './gateway';
import type { DiscoveredModel } from './types';
import { deriveModelGroup } from '../features/settings/endpoint';

function safeHttpStatusMessage(status: number): string {
  switch (status) {
    case 401:
      return '上游返回 HTTP 401（鉴权失败）';
    case 403:
      return '上游返回 HTTP 403（拒绝访问）';
    case 404:
      return '上游返回 HTTP 404（模型列表端点不存在）';
    case 429:
      return '上游返回 HTTP 429（请求过于频繁）';
    case 500:
    case 502:
    case 503:
    case 504:
      return `上游返回 HTTP ${status}（服务暂不可用）`;
    default:
      return `上游返回 HTTP ${status}`;
  }
}

function normalizeStandardItems(
  items: unknown[],
  defaultFormat: string,
): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof item.display_name === 'string' ? item.display_name.trim() : '';
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    const name = displayName || rawName || id;
    const lowerId = id.toLowerCase();
    let apiFormat = defaultFormat;
    if (lowerId.startsWith('claude')) {
      apiFormat = 'anthropic-messages';
    } else if (lowerId.startsWith('gemini')) {
      apiFormat = 'google-generative-ai';
    }
    out.push({
      id,
      name,
      group: deriveModelGroup(id),
      apiFormat,
      ...(typeof item.context_window === 'number' && item.context_window > 0
        ? { contextWindow: item.context_window }
        : {}),
      ...(typeof item.max_tokens === 'number' && item.max_tokens > 0
        ? { maxTokens: item.max_tokens }
        : {}),
      ...(item.reasoning === true ? { reasoning: true } : {}),
    });
  }
  return out;
}

/**
 * Parses upstream model list payloads (array, OpenAI/Anthropic data[], or Gemini models[])
 * and rejects unrecognized JSON shapes instead of returning an empty list.
 */
export function parseDiscoveredModelsPayload(
  rawText: string,
  defaultFormat: string,
): DiscoveredModel[] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('上游返回了空的模型列表响应');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('上游返回了无效的模型列表 JSON');
  }

  if (Array.isArray(parsed)) {
    return normalizeStandardItems(parsed, defaultFormat);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('上游返回了无法识别的模型列表格式');
  }
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.models)) {
    const out: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const rawItem of obj.models) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const rawName =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : typeof item.id === 'string'
            ? item.id.trim()
            : '';
      const isGeminiPrefixed = rawName.startsWith('models/');
      const id = (isGeminiPrefixed ? rawName.slice('models/'.length) : rawName).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const displayName =
        typeof item.displayName === 'string' && item.displayName.trim()
          ? item.displayName.trim()
          : id;
      const lowerId = id.toLowerCase();
      let apiFormat = defaultFormat;
      if (
        isGeminiPrefixed ||
        defaultFormat === 'google-generative-ai' ||
        lowerId.startsWith('gemini')
      ) {
        apiFormat = 'google-generative-ai';
      } else if (lowerId.startsWith('claude')) {
        apiFormat = 'anthropic-messages';
      }
      out.push({
        id,
        name: displayName,
        group: deriveModelGroup(id),
        apiFormat,
        ...(typeof item.inputTokenLimit === 'number' && item.inputTokenLimit > 0
          ? { contextWindow: item.inputTokenLimit }
          : {}),
        ...(typeof item.outputTokenLimit === 'number' && item.outputTokenLimit > 0
          ? { maxTokens: item.outputTokenLimit }
          : {}),
        ...(item.thinking === true ? { reasoning: true } : {}),
      });
    }
    return out;
  }

  if (Array.isArray(obj.data)) {
    return normalizeStandardItems(obj.data, defaultFormat);
  }

  throw new Error('上游返回了无法识别的模型列表格式');
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * Probes a saved localRequest=true provider directly from the browser using a
 * no-store gateway-prepared envelope. Never persists the envelope, rejects
 * redirects to avoid leaking credentials cross-origin, and never falls back to gateway.
 */
export async function executeLocalModelProbe(
  gateway: Pick<GatewayClient, 'prepareLocalModelProbe' | 'fetchImpl'>,
  providerId: string,
  signal?: AbortSignal,
): Promise<{ models: DiscoveredModel[]; latencyMs: number }> {
  const envelope = await gateway.prepareLocalModelProbe(providerId, signal);
  const started = performance.now();

  let response: Response;
  try {
    response = await gateway.fetchImpl(envelope.url, {
      method: envelope.method,
      headers: envelope.headers,
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw err;
    }
    throw new GatewayError('LOCAL_CONNECTION_ERROR', '无法连接到上游服务');
  }

  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new GatewayError(
      'REDIRECT_REJECTED',
      '上游返回重定向，已拒绝跨源转发凭据',
      response.status || undefined,
    );
  }

  if (!response.ok) {
    throw new GatewayError(
      `UPSTREAM_HTTP_${response.status}`,
      safeHttpStatusMessage(response.status),
      response.status,
    );
  }

  const rawText = await response.text();
  const models = parseDiscoveredModelsPayload(rawText, envelope.defaultFormat);
  const latencyMs = Math.max(1, Math.round(performance.now() - started));
  return { models, latencyMs };
}
