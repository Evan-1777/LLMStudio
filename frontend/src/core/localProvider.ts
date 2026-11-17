import { GatewayError } from './gateway';
import type {
  DiscoveredModel,
  ModelConfig,
  ProviderConnectionResult,
} from './types';

const CUSTOM_AUTH_META_KEY = 'x-auth-header';

function findHeaderKeyCaseInsensitive(
  headers: Record<string, string>,
  target: string,
): string | undefined {
  const lower = target.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  key: string,
  value: string,
): void {
  const existing = findHeaderKeyCaseInsensitive(headers, key);
  if (existing && existing !== key) {
    delete headers[existing];
  }
  headers[key] = value;
}

export function applyLocalAuth(
  url: string,
  headers: Record<string, string>,
  authType: string,
  apiKey: string,
  customHeaders?: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  const nextHeaders: Record<string, string> = {};
  let customAuthHeader = '';

  const ingestHeaders = (src?: Record<string, string>, overwrite = false) => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      if (k.toLowerCase() === CUSTOM_AUTH_META_KEY) {
        customAuthHeader = String(v ?? '').trim();
        continue;
      }
      const existing = findHeaderKeyCaseInsensitive(nextHeaders, k);
      if (overwrite || !existing) {
        if (existing && existing !== k) {
          delete nextHeaders[existing];
        }
        nextHeaders[k] = String(v ?? '');
      }
    }
  };

  ingestHeaders(customHeaders, true);
  ingestHeaders(headers, true);

  const resolvedAuthType = (authType || 'bearer').trim();
  const trimmedKey = apiKey.trim();

  if (resolvedAuthType !== 'none' && !trimmedKey) {
    throw new GatewayError(
      'MISSING_LOCAL_KEY',
      '当前浏览器未配置该供应商的本地 API Key，请先录入密钥或改用 none 鉴权模式',
    );
  }

  let nextUrl = url;
  switch (resolvedAuthType) {
    case 'none':
      break;
    case 'bearer':
      setHeaderCaseInsensitive(nextHeaders, 'Authorization', `Bearer ${trimmedKey}`);
      break;
    case 'x-api-key':
      setHeaderCaseInsensitive(nextHeaders, 'x-api-key', trimmedKey);
      break;
    case 'query-key': {
      const parsed = new URL(url);
      parsed.searchParams.set('key', trimmedKey);
      nextUrl = parsed.toString();
      break;
    }
    case 'header-key': {
      let replacedTemplate = false;
      for (const [k, v] of Object.entries(nextHeaders)) {
        if (v.includes('{{apiKey}}')) {
          nextHeaders[k] = v.replaceAll('{{apiKey}}', trimmedKey);
          replacedTemplate = true;
        }
      }
      if (!replacedTemplate) {
        if (customAuthHeader) {
          setHeaderCaseInsensitive(nextHeaders, customAuthHeader, trimmedKey);
        } else {
          const emptyKey = Object.entries(nextHeaders).find(
            ([, v]) => v.trim() === '',
          )?.[0];
          if (emptyKey) {
            nextHeaders[emptyKey] = trimmedKey;
          } else {
            setHeaderCaseInsensitive(nextHeaders, 'X-API-Key', trimmedKey);
          }
        }
      }
      break;
    }
    default:
      throw new GatewayError(
        'INVALID_ARGUMENT',
        `不支持的鉴权方式: ${resolvedAuthType}`,
      );
  }

  return { url: nextUrl, headers: nextHeaders };
}

export function joinEndpointPath(basePath: string, targetPath: string): string {
  const baseTrim = basePath.replace(/\/+$/, '');
  if (!targetPath) {
    return baseTrim || '/';
  }
  let normalizedTarget = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  for (const prefix of ['/v1', '/v1beta']) {
    if (
      baseTrim.endsWith(prefix) &&
      normalizedTarget.startsWith(`${prefix}/`)
    ) {
      normalizedTarget = normalizedTarget.slice(prefix.length);
      break;
    }
  }
  return baseTrim ? `${baseTrim}${normalizedTarget}` : normalizedTarget;
}

export function detectModelListProtocol(
  baseURL: string,
  models: readonly ModelConfig[] = [],
  authType = 'bearer',
): {
  kind: 'openai' | 'anthropic' | 'gemini';
  path: string;
  defaultFormat: string;
} {
  const lowerBase = baseURL.toLowerCase();
  const firstFormat = models[0]?.apiFormat?.trim() ?? '';

  if (
    authType === 'query-key' ||
    lowerBase.includes('generativelanguage') ||
    lowerBase.includes('/v1beta') ||
    firstFormat === 'google-generative-ai'
  ) {
    return {
      kind: 'gemini',
      path: '/v1beta/models',
      defaultFormat: 'google-generative-ai',
    };
  }
  if (
    authType === 'x-api-key' ||
    lowerBase.includes('anthropic') ||
    firstFormat === 'anthropic-messages'
  ) {
    return {
      kind: 'anthropic',
      path: '/v1/models',
      defaultFormat: 'anthropic-messages',
    };
  }
  return {
    kind: 'openai',
    path: '/v1/models',
    defaultFormat: firstFormat || 'openai-completions',
  };
}

export interface LocalProbeOptions {
  baseURL: string;
  authType: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: readonly ModelConfig[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function resolveLocalProbeEndpoint(cfg: {
  baseURL: string;
  authType: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: readonly ModelConfig[];
}): {
  url: string;
  headers: Record<string, string>;
  protoKind: 'openai' | 'anthropic' | 'gemini';
  defaultFormat: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(cfg.baseURL.trim());
  } catch {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      '请输入有效的 API 地址（需包含协议与主机名）',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.host
  ) {
    throw new GatewayError(
      'INVALID_ARGUMENT',
      '请输入有效的 API 地址（需包含协议与主机名）',
    );
  }

  const authType = (cfg.authType || 'bearer').trim();
  const proto = detectModelListProtocol(cfg.baseURL, cfg.models, authType);
  parsed.pathname = joinEndpointPath(parsed.pathname, proto.path);

  const authed = applyLocalAuth(
    parsed.toString(),
    { Accept: 'application/json' },
    authType,
    cfg.apiKey ?? '',
    cfg.headers,
  );

  if (
    proto.kind === 'anthropic' &&
    !findHeaderKeyCaseInsensitive(authed.headers, 'anthropic-version')
  ) {
    authed.headers['anthropic-version'] = '2023-06-01';
  }

  return {
    url: authed.url,
    headers: authed.headers,
    protoKind: proto.kind,
    defaultFormat: proto.defaultFormat,
  };
}

function deriveModelGroup(id: string): string {
  const slashIdx = id.indexOf('/');
  if (slashIdx > 0) {
    const prefix = id.slice(0, slashIdx).trim();
    if (prefix) return prefix;
  }
  const dashIdx = id.indexOf('-');
  if (dashIdx > 0) {
    const prefix = id.slice(0, dashIdx).trim();
    if (prefix) return prefix;
  }
  return 'other';
}

interface RawStandardItem {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  max_tokens?: unknown;
  reasoning?: unknown;
}

interface RawGeminiItem {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  thinking?: unknown;
}

function normalizeStandardModels(
  items: RawStandardItem[],
  defaultFormat: string,
): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const m of items) {
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof m.display_name === 'string' ? m.display_name.trim() : '';
    const rawName = typeof m.name === 'string' ? m.name.trim() : '';
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
      ...(typeof m.context_window === 'number' && m.context_window > 0
        ? { contextWindow: m.context_window }
        : {}),
      ...(typeof m.max_tokens === 'number' && m.max_tokens > 0
        ? { maxTokens: m.max_tokens }
        : {}),
      ...(m.reasoning === true ? { reasoning: true } : {}),
    });
  }
  return out;
}

export function parseDiscoveredModels(
  rawText: string,
  defaultFormat: string,
): DiscoveredModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new GatewayError('UPSTREAM_ERROR', '上游返回的模型列表不是有效的 JSON');
  }

  if (Array.isArray(parsed)) {
    return normalizeStandardModels(parsed as RawStandardItem[], defaultFormat);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new GatewayError('UPSTREAM_ERROR', '上游返回的模型列表格式无效');
  }

  const obj = parsed as { data?: unknown; models?: unknown };
  if (Array.isArray(obj.models) && obj.models.length > 0) {
    const out: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const item of obj.models as RawGeminiItem[]) {
      const rawName = typeof item.name === 'string' ? item.name.trim() : '';
      const id = rawName.startsWith('models/')
        ? rawName.slice('models/'.length).trim()
        : rawName;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const displayName =
        typeof item.displayName === 'string' ? item.displayName.trim() : '';
      out.push({
        id,
        name: displayName || id,
        group: deriveModelGroup(id),
        apiFormat: 'google-generative-ai',
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

  const items = Array.isArray(obj.data) ? (obj.data as RawStandardItem[]) : [];
  return normalizeStandardModels(items, defaultFormat);
}

export async function fetchLocalProviderModels(
  opts: LocalProbeOptions,
): Promise<DiscoveredModel[]> {
  const endpoint = resolveLocalProbeEndpoint(opts);
  const fetchFn = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  let resp: Response;
  try {
    resp = await fetchFn(endpoint.url, {
      method: 'GET',
      headers: endpoint.headers,
      signal: opts.signal,
    });
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw err;
    }
    if (err instanceof TypeError) {
      throw new GatewayError(
        'LOCAL_NETWORK_ERROR',
        '无法直连本地服务，请检查本地服务是否已启动且已开启 CORS 跨域支持',
      );
    }
    throw new GatewayError(
      'LOCAL_NETWORK_ERROR',
      err instanceof Error ? err.message : '本地请求失败',
    );
  }

  const rawText = await resp.text();
  if (!resp.ok) {
    const snippet = rawText.trim();
    throw new GatewayError(
      `HTTP_${resp.status}`,
      snippet
        ? `上游返回 HTTP ${resp.status}: ${snippet.slice(0, 300)}`
        : `上游返回 HTTP ${resp.status}`,
      resp.status,
    );
  }
  return parseDiscoveredModels(rawText, endpoint.defaultFormat);
}

export async function testLocalProviderConnection(
  opts: LocalProbeOptions,
): Promise<ProviderConnectionResult> {
  const start = Date.now();
  const models = await fetchLocalProviderModels(opts);
  const latencyMs = Math.max(0, Date.now() - start);
  return {
    ok: true,
    latencyMs,
    modelCount: models.length,
    message: '连接正常',
  };
}
