import type {
  ModelConfig,
  ProviderProbeInput,
  ProviderUpsertPayload,
  SearchEngineUpdateInput,
  StreamChatInput,
} from './types';

export function sanitizeModel(model: ModelConfig): ModelConfig {
  const out: ModelConfig = {
    id: model.id,
    name: model.name,
    apiFormat: model.apiFormat,
  };
  if (model.contextWindow !== undefined && model.contextWindow > 0) {
    out.contextWindow = model.contextWindow;
  }
  if (model.maxTokens !== undefined && model.maxTokens > 0) {
    out.maxTokens = model.maxTokens;
  }
  if (model.reasoning) {
    out.reasoning = true;
  }
  if (model.inputModalities && model.inputModalities.length > 0) {
    out.inputModalities = [...model.inputModalities];
  }
  if (model.compat) {
    const compat: NonNullable<ModelConfig['compat']> = {};
    if (model.compat.maxTokensField) {
      compat.maxTokensField = model.compat.maxTokensField;
    }
    if (
      model.compat.supportsDeveloperRole !== undefined &&
      model.compat.supportsDeveloperRole !== null
    ) {
      compat.supportsDeveloperRole = model.compat.supportsDeveloperRole;
    }
    if (
      model.compat.supportsStreamOptions !== undefined &&
      model.compat.supportsStreamOptions !== null
    ) {
      compat.supportsStreamOptions = model.compat.supportsStreamOptions;
    }
    if (model.compat.thinkingFormat) {
      compat.thinkingFormat = model.compat.thinkingFormat;
    }
    if (model.compat.reasoningEffortField) {
      compat.reasoningEffortField = model.compat.reasoningEffortField;
    }
    if (model.compat.pathOverride) {
      compat.pathOverride = model.compat.pathOverride;
    }
    if (model.compat.cacheMode) {
      compat.cacheMode = model.compat.cacheMode;
    }
    if (
      model.compat.extraHeaders &&
      Object.keys(model.compat.extraHeaders).length > 0
    ) {
      compat.extraHeaders = { ...model.compat.extraHeaders };
    }
    if (
      model.compat.extraBody &&
      Object.keys(model.compat.extraBody).length > 0
    ) {
      compat.extraBody = { ...model.compat.extraBody };
    }
    if (Object.keys(compat).length > 0) {
      out.compat = compat;
    }
  }
  if (model.defaultParams) {
    const params: NonNullable<ModelConfig['defaultParams']> = {};
    if (model.defaultParams.temperature !== undefined) {
      params.temperature = model.defaultParams.temperature;
    }
    if (model.defaultParams.maxTokens !== undefined) {
      params.maxTokens = model.defaultParams.maxTokens;
    }
    if (model.defaultParams.reasoningEffort) {
      params.reasoningEffort = model.defaultParams.reasoningEffort;
    }
    if (Object.keys(params).length > 0) {
      out.defaultParams = params;
    }
  }
  return out;
}

export function sanitizeProviderPayload(
  payload: ProviderUpsertPayload,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: payload.name,
    adapter: payload.adapter,
    baseURL: payload.baseURL,
    authType: payload.authType,
    models: payload.models.map(sanitizeModel),
  };
  if (payload.id) {
    out.id = payload.id;
  }
  if (payload.clearApiKey) {
    out.clearApiKey = true;
  } else if (payload.apiKey && payload.apiKey.trim() !== '') {
    out.apiKey = payload.apiKey.trim();
  }
  if (payload.headers !== undefined) {
    out.headers = { ...payload.headers };
  }
  if (payload.enabled !== undefined) {
    out.enabled = payload.enabled;
  }
  if (payload.localRequest !== undefined) {
    out.localRequest = payload.localRequest;
  }
  return out;
}

export function sanitizeProbePayload(
  probe?: ProviderProbeInput,
): Record<string, unknown> {
  if (!probe) return {};
  const out: Record<string, unknown> = {};
  if (probe.baseURL && probe.baseURL.trim() !== '') {
    out.baseURL = probe.baseURL.trim();
  }
  if (probe.authType && probe.authType.trim() !== '') {
    out.authType = probe.authType.trim();
  }
  if (probe.clearApiKey) {
    out.clearApiKey = true;
  } else if (probe.apiKey && probe.apiKey.trim() !== '') {
    out.apiKey = probe.apiKey.trim();
  }
  if (probe.headers !== undefined) {
    out.headers = { ...probe.headers };
  }
  return out;
}

export function sanitizeSearchUpdatePayload(
  input: SearchEngineUpdateInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.enabled !== undefined) {
    out.enabled = input.enabled;
  }
  if (input.endpoint !== undefined && input.endpoint.trim() !== '') {
    out.endpoint = input.endpoint.trim();
  }
  if (input.clearApiKey) {
    out.clearApiKey = true;
  } else if (input.apiKey && input.apiKey.trim() !== '') {
    out.apiKey = input.apiKey.trim();
  }
  if (input.maxResults !== undefined) {
    out.maxResults = input.maxResults;
  }
  if (input.isDefault !== undefined) {
    out.isDefault = input.isDefault;
  }
  return out;
}

export function buildStreamChatPayload(
  input: StreamChatInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.blocks && input.blocks.length > 0) {
    payload.blocks = input.blocks;
  } else if (input.text && input.text !== '') {
    payload.text = input.text;
  }
  if (input.providerId) payload.providerId = input.providerId;
  if (input.modelId) payload.modelId = input.modelId;
  if (input.params && Object.keys(input.params).length > 0) {
    payload.params = input.params;
  }
  if (input.regenerateMessageId) {
    payload.regenerateMessageId = input.regenerateMessageId;
  }
  if (input.mcpToolsEnabled !== undefined) {
    payload.mcpToolsEnabled = input.mcpToolsEnabled;
  }
  if (input.webSearch) {
    payload.webSearch = true;
  }
  if (input.searchEngineId) {
    payload.searchEngineId = input.searchEngineId;
  }
  if (input.preparedSearch !== undefined) {
    payload.preparedSearch = {
      block: input.preparedSearch.block ?? null,
    };
  }
  if (input.cacheState) {
    payload.cacheState = input.cacheState;
  }
  if (input.cacheResolution) {
    payload.cacheResolution = input.cacheResolution;
  }
  if (input.localMainFailure) {
    payload.localMainFailure = input.localMainFailure;
  }
  if (input.credentialEnvelope) {
    payload.credentialEnvelope = true;
  }
  if (input.localContinuation) {
    payload.localContinuation = {
      ...(input.localContinuation.userMessageId
        ? { userMessageId: input.localContinuation.userMessageId }
        : {}),
      blocks: input.localContinuation.blocks,
    };
  }
  return payload;
}
