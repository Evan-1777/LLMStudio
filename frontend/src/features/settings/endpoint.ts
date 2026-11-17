import type { FormatInfo, ModelConfig } from '../../core/types';

export interface EndpointPreviewInput {
  baseURL: string;
  model?: Pick<ModelConfig, 'id' | 'apiFormat' | 'compat'> | null;
  formats: readonly FormatInfo[];
}

export function buildEndpointPreview({
  baseURL,
  model,
  formats,
}: EndpointPreviewInput): string {
  const baseTrim = baseURL.trim().replace(/\/+$/, '');
  if (!baseTrim) return '';

  const pathOverride = model?.compat?.pathOverride?.trim() ?? '';
  let targetPath = pathOverride;
  if (!targetPath && model?.apiFormat) {
    targetPath =
      formats.find((f) => f.id === model.apiFormat)?.defaultPath.trim() ?? '';
  }
  if (!targetPath && !model && formats.length > 0) {
    targetPath =
      (
        formats.find((f) => f.id === 'openai-completions') ?? formats[0]
      ).defaultPath.trim();
  }
  if (!targetPath) return '';

  const modelId = model?.id?.trim() ?? '';
  if (modelId) {
    targetPath = targetPath.replaceAll('{model}', encodeURIComponent(modelId));
  }

  let queryPart = '';
  const queryIdx = targetPath.indexOf('?');
  if (queryIdx >= 0) {
    queryPart = targetPath.slice(queryIdx);
    targetPath = targetPath.slice(0, queryIdx);
  }

  if (!targetPath.startsWith('/')) {
    targetPath = `/${targetPath}`;
  }

  for (const prefix of ['/v1', '/v1beta'] as const) {
    if (baseTrim.endsWith(prefix) && targetPath.startsWith(`${prefix}/`)) {
      targetPath = targetPath.slice(prefix.length);
      break;
    }
  }

  return `${baseTrim}${targetPath}${queryPart}`;
}

export function extractHost(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host;
  } catch {
    return '';
  }
}

export function deriveModelGroup(id: string): string {
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
