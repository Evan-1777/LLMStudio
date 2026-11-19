import {
  MAX_GATEWAY_BODY_BYTES,
  type Assistant,
  type AssistantUpsertPayload,
  type BatchConversationsInput,
  type ContentBlock,
  type Conversation,
  type ConversationDetail,
  type ConversationGroup,
  type ConversationOrganizationSnapshot,
  type CreateConversationInput,
  type CreateMessageInput,
  type CreateMessageResult,
  type DeletedConversation,
  type DiscoveredModel,
  type FormatInfo,
  type GroupDeleteResult,
  type GroupMutationResult,
  type HealthResponse,
  type MCPServerConfig,
  type MCPServerInput,
  type MCPServerTestResult,
  type MCPToolDescriptor,
  type Message,
  type ModelConfig,
  type PatchConversationInput,
  type PreparedLocalRequest,
  type ProviderAdapterInfo,
  type ProviderConfig,
  type ProviderConnectionResult,
  type ProviderProbeInput,
  type ProviderUpsertPayload,
  type ReorderConversationsInput,
  type SearchEngineTestInput,
  type SearchEngineTestResult,
  type SearchEngineUpdateInput,
  type SearchEngineView,
  type ServerPreferences,
  type ServerPreferencesEnvelope,
  type ServerPreferencesImport,
  type StorageCompactResult,
  type StorageUsage,
  type StreamChatInput,
  type ToolCallExecutionInput,
} from './types';

export class GatewayError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(code: string, message: string, statusCode?: number) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
}

export function validateGatewayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '网关地址必须为根路径 / 或 http/https 地址';
    }
    if (!parsed.host) {
      return '请输入有效的网关主机名';
    }
    return null;
  } catch {
    return '请输入有效的网关地址（如 / 或 https://example.com）';
  }
}

export function resolveGatewayUrl(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed === '/') {
    return `/${cleanPath}`;
  }
  const normalized = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  return new URL(cleanPath, normalized).toString();
}

const utf8Encoder = new TextEncoder();

export function measureUtf8Bytes(input: string): number {
  return utf8Encoder.encode(input).length;
}

function sanitizeModel(model: ModelConfig): ModelConfig {
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

function sanitizeProviderPayload(
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

function sanitizeProbePayload(
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
  if (probe.apiKey && probe.apiKey.trim() !== '') {
    out.apiKey = probe.apiKey.trim();
  }
  if (probe.headers !== undefined) {
    out.headers = { ...probe.headers };
  }
  return out;
}

function sanitizeSearchUpdatePayload(
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

function parseErrorEnvelope(
  rawText: string,
  status: number,
): { code: string; message: string } {
  const trimmed = rawText.trim();
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        const code =
          typeof rec.code === 'string' && rec.code.trim()
            ? rec.code
            : `HTTP_${status}`;
        const message =
          typeof rec.message === 'string' && rec.message.trim()
            ? rec.message
            : `请求失败 (${status})`;
        return { code, message };
      }
    } catch {
      const safeMessage =
        trimmed.startsWith('<') || trimmed.length > 240
          ? `请求失败 (${status})`
          : trimmed;
      return { code: `HTTP_${status}`, message: safeMessage };
    }
  }
  return { code: `HTTP_${status}`, message: `请求失败 (${status})` };
}

function buildStreamChatPayload(input: StreamChatInput): Record<string, unknown> {
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

export class GatewayClient {
  baseUrl: string;
  accessToken: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl;
    this.accessToken = options.accessToken ?? '';
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private buildHeaders(
    includeJson: boolean,
    includeAuth: boolean,
    extra?: Record<string, string>,
  ): HeadersInit {
    const headers: Record<string, string> = {};
    if (includeJson) {
      headers['Content-Type'] = 'application/json';
    }
    if (includeAuth) {
      const token = this.accessToken.trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    if (extra) {
      Object.assign(headers, extra);
    }
    return headers;
  }

  private serializeBody(body: unknown): string {
    const json = JSON.stringify(body);
    if (measureUtf8Bytes(json) >= MAX_GATEWAY_BODY_BYTES) {
      throw new GatewayError(
        'REQUEST_TOO_LARGE',
        '请求体大小超过 16 MiB 限制，请精简文本或附件后再发送',
      );
    }
    return json;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      includeAuth?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = resolveGatewayUrl(this.baseUrl, path);
    const hasBody = options?.body !== undefined;
    const includeAuth = options?.includeAuth ?? true;
    const serialized = hasBody ? this.serializeBody(options.body) : undefined;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(hasBody, includeAuth),
        body: serialized,
        signal: options?.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new GatewayError(
        'NETWORK_ERROR',
        err instanceof Error ? err.message : '网络请求失败',
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const rawText = await response.text();
    if (!response.ok) {
      const env = parseErrorEnvelope(rawText, response.status);
      throw new GatewayError(env.code, env.message, response.status);
    }

    if (!rawText.trim()) {
      return {} as T;
    }
    try {
      return JSON.parse(rawText) as T;
    } catch {
      throw new GatewayError(
        'INVALID_RESPONSE',
        '服务端返回了无效的 JSON 响应',
        response.status,
      );
    }
  }

  healthCheck(signal?: AbortSignal): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>('GET', '/healthz', {
      includeAuth: false,
      signal,
    });
  }

  getPreferences(signal?: AbortSignal): Promise<ServerPreferencesEnvelope> {
    return this.requestJson<ServerPreferencesEnvelope>(
      'GET',
      '/api/v1/settings',
      { signal },
    ).then((res) => ({
      preferences: res.preferences as ServerPreferences,
      initialized: res.initialized === true,
    }));
  }

  updatePreferences(
    patch: Partial<ServerPreferences>,
    signal?: AbortSignal,
  ): Promise<ServerPreferencesEnvelope> {
    return this.requestJson<ServerPreferencesEnvelope>(
      'PATCH',
      '/api/v1/settings',
      { body: patch, signal },
    );
  }

  importLegacyPreferences(
    preferences: ServerPreferencesImport,
    signal?: AbortSignal,
  ): Promise<ServerPreferencesEnvelope> {
    return this.requestJson<ServerPreferencesEnvelope>(
      'POST',
      '/api/v1/settings/import',
      { body: preferences, signal },
    );
  }

  getStorage(signal?: AbortSignal): Promise<StorageUsage> {
    return this.requestJson<StorageUsage>('GET', '/api/v1/storage', { signal });
  }

  compactStorage(signal?: AbortSignal): Promise<StorageCompactResult> {
    return this.requestJson<StorageCompactResult>(
      'POST',
      '/api/v1/storage/compact',
      { signal },
    );
  }

  listFormatsAndAdapters(
    signal?: AbortSignal,
  ): Promise<{ formats: FormatInfo[]; adapters: ProviderAdapterInfo[] }> {
    return this.requestJson<{
      formats?: FormatInfo[];
      adapters?: ProviderAdapterInfo[];
    }>('GET', '/api/v1/formats', { signal }).then((res) => ({
      formats: res.formats ?? [],
      adapters: res.adapters ?? [],
    }));
  }

  listProviders(signal?: AbortSignal): Promise<ProviderConfig[]> {
    return this.requestJson<{ providers?: ProviderConfig[] }>(
      'GET',
      '/api/v1/providers',
      { signal },
    ).then((res) => res.providers ?? []);
  }

  reorderProviders(id: string, beforeId: string | null, signal?: AbortSignal): Promise<ProviderConfig[]> {
    return this.requestJson<{ providers: ProviderConfig[] }>('POST', '/api/v1/providers/reorder', {
      body: { id, beforeId }, signal,
    }).then((res) => res.providers);
  }

  createProvider(
    payload: ProviderUpsertPayload,
    signal?: AbortSignal,
  ): Promise<ProviderConfig> {
    return this.requestJson<{ provider: ProviderConfig }>(
      'POST',
      '/api/v1/providers',
      { body: sanitizeProviderPayload(payload), signal },
    ).then((res) => res.provider);
  }

  updateProvider(
    id: string,
    payload: ProviderUpsertPayload,
    signal?: AbortSignal,
  ): Promise<ProviderConfig> {
    return this.requestJson<{ provider: ProviderConfig }>(
      'PUT',
      `/api/v1/providers/${encodeURIComponent(id)}`,
      { body: sanitizeProviderPayload(payload), signal },
    ).then((res) => res.provider);
  }

  importProviderAPIKey(
    id: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<{ applied: boolean; provider: ProviderConfig }> {
    return this.requestJson<{ applied: boolean; provider: ProviderConfig }>(
      'POST',
      `/api/v1/providers/${encodeURIComponent(id)}/keys/import`,
      { body: { apiKey }, signal },
    );
  }

  deleteProvider(id: string, signal?: AbortSignal): Promise<void> {
    return this.requestJson<void>(
      'DELETE',
      `/api/v1/providers/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  testProviderConnection(
    id: string,
    probe?: ProviderProbeInput,
    signal?: AbortSignal,
  ): Promise<ProviderConnectionResult> {
    return this.requestJson<ProviderConnectionResult>(
      'POST',
      `/api/v1/providers/${encodeURIComponent(id)}/test`,
      { body: sanitizeProbePayload(probe), signal },
    );
  }

  fetchProviderModels(
    id: string,
    probe?: ProviderProbeInput,
    signal?: AbortSignal,
  ): Promise<DiscoveredModel[]> {
    return this.requestJson<{ models?: DiscoveredModel[] }>(
      'POST',
      `/api/v1/providers/${encodeURIComponent(id)}/models/fetch`,
      { body: sanitizeProbePayload(probe), signal },
    ).then((res) => res.models ?? []);
  }

  listAssistants(signal?: AbortSignal): Promise<Assistant[]> {
    return this.requestJson<{ assistants?: Assistant[] }>(
      'GET',
      '/api/v1/assistants',
      { signal },
    ).then((res) => res.assistants ?? []);
  }

  createAssistant(
    payload: AssistantUpsertPayload,
    signal?: AbortSignal,
  ): Promise<Assistant> {
    return this.requestJson<{ assistant: Assistant }>(
      'POST',
      '/api/v1/assistants',
      { body: payload, signal },
    ).then((res) => res.assistant);
  }

  updateAssistant(
    id: string,
    payload: AssistantUpsertPayload,
    signal?: AbortSignal,
  ): Promise<Assistant> {
    return this.requestJson<{ assistant: Assistant }>(
      'PUT',
      `/api/v1/assistants/${encodeURIComponent(id)}`,
      { body: payload, signal },
    ).then((res) => res.assistant);
  }

  deleteAssistant(id: string, signal?: AbortSignal): Promise<void> {
    return this.requestJson<void>(
      'DELETE',
      `/api/v1/assistants/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  listConversations(signal?: AbortSignal): Promise<Conversation[]> {
    return this.requestJson<{ conversations?: Conversation[] }>(
      'GET',
      '/api/v1/conversations',
      { signal },
    ).then((res) => res.conversations ?? []);
  }

  createConversation(
    input: CreateConversationInput = {},
    signal?: AbortSignal,
  ): Promise<Conversation> {
    return this.requestJson<{ conversation: Conversation }>(
      'POST',
      '/api/v1/conversations',
      { body: input, signal },
    ).then((res) => res.conversation);
  }

  getConversationDetail(
    id: string,
    signal?: AbortSignal,
  ): Promise<ConversationDetail> {
    return this.requestJson<ConversationDetail>(
      'GET',
      `/api/v1/conversations/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  patchConversation(
    id: string,
    input: PatchConversationInput,
    signal?: AbortSignal,
  ): Promise<Conversation> {
    return this.requestJson<{ conversation: Conversation }>(
      'PATCH',
      `/api/v1/conversations/${encodeURIComponent(id)}`,
      { body: input, signal },
    ).then((res) => res.conversation);
  }

  deleteConversation(id: string, signal?: AbortSignal): Promise<void> {
    return this.requestJson<void>(
      'DELETE',
      `/api/v1/conversations/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  cleanupUngroupedConversations(signal?: AbortSignal): Promise<DeletedConversation[]> {
    return this.requestJson<{ deleted: DeletedConversation[] }>(
      'POST', '/api/v1/conversations/cleanup-ungrouped', { signal },
    ).then((res) => res.deleted);
  }

  listConversationGroups(
    assistantId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationGroup[]> {
    const query = assistantId
      ? `?assistantId=${encodeURIComponent(assistantId)}`
      : '';
    return this.requestJson<{ groups?: ConversationGroup[] }>(
      'GET',
      `/api/v1/conversation-groups${query}`,
      { signal },
    ).then((res) => res.groups ?? []);
  }

  createConversationGroup(
    input: { assistantId: string; name: string },
    signal?: AbortSignal,
  ): Promise<GroupMutationResult> {
    return this.requestJson<GroupMutationResult>(
      'POST',
      '/api/v1/conversation-groups',
      { body: input, signal },
    );
  }

  reorderConversationGroup(
    input: { assistantId: string; id: string; beforeId: string | null },
    signal?: AbortSignal,
  ): Promise<ConversationOrganizationSnapshot> {
    return this.requestJson<ConversationOrganizationSnapshot>(
      'POST', '/api/v1/conversation-groups/reorder', { body: input, signal },
    );
  }

  renameConversationGroup(
    id: string,
    input: { name: string },
    signal?: AbortSignal,
  ): Promise<GroupMutationResult> {
    return this.requestJson<GroupMutationResult>(
      'PATCH',
      `/api/v1/conversation-groups/${encodeURIComponent(id)}`,
      { body: input, signal },
    );
  }

  deleteConversationGroup(
    id: string,
    signal?: AbortSignal,
  ): Promise<GroupDeleteResult> {
    return this.requestJson<GroupDeleteResult>(
      'DELETE',
      `/api/v1/conversation-groups/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  batchConversations(
    input: BatchConversationsInput,
    signal?: AbortSignal,
  ): Promise<ConversationOrganizationSnapshot> {
    const body: Record<string, unknown> = {
      assistantId: input.assistantId,
      ids: input.ids,
      operation: input.operation,
    };
    if (input.operation === 'move') {
      body.groupId = input.groupId ?? null;
    } else if (input.operation === 'pin') {
      body.pinned = input.pinned;
    }
    return this.requestJson<ConversationOrganizationSnapshot>(
      'POST',
      '/api/v1/conversations/batch',
      { body, signal },
    );
  }

  reorderConversations(
    input: ReorderConversationsInput,
    signal?: AbortSignal,
  ): Promise<ConversationOrganizationSnapshot> {
    const body: Record<string, unknown> = {
      assistantId: input.assistantId,
      ids: input.ids,
      pinned: input.pinned,
    };
    if (!input.pinned) {
      body.groupId = input.groupId ?? null;
    }
    if (input.beforeId !== undefined) {
      body.beforeId = input.beforeId ?? null;
    }
    return this.requestJson<ConversationOrganizationSnapshot>(
      'POST',
      '/api/v1/conversations/reorder',
      { body, signal },
    );
  }

  deleteMessage(
    conversationId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.requestJson<void>(
      'DELETE',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { signal },
    );
  }

  updateMessage(
    conversationId: string,
    messageId: string,
    blocks: ContentBlock[],
    signal?: AbortSignal,
  ): Promise<Message> {
    return this.requestJson<{ message: Message }>(
      'PATCH',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { body: { blocks }, signal },
    ).then((res) => res.message);
  }

  createMessage(
    conversationId: string,
    input: CreateMessageInput,
    signal?: AbortSignal,
  ): Promise<CreateMessageResult> {
    return this.requestJson<CreateMessageResult>(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body: input, signal },
    );
  }

  prepareLocalChat(
    conversationId: string,
    input: StreamChatInput,
    signal?: AbortSignal,
  ): Promise<PreparedLocalRequest> {
    return this.requestJson<PreparedLocalRequest>(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/prepare-local`,
      { body: buildStreamChatPayload(input), signal },
    );
  }

  branchConversation(
    conversationId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ConversationDetail> {
    return this.requestJson<ConversationDetail>(
      'POST',
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/branch`,
      { body: {}, signal },
    );
  }

  listSearchEngines(signal?: AbortSignal): Promise<SearchEngineView[]> {
    return this.requestJson<{ engines?: SearchEngineView[] }>(
      'GET',
      '/api/v1/plugins/search',
      { signal },
    ).then((res) => res.engines ?? []);
  }

  updateSearchEngine(
    id: string,
    input: SearchEngineUpdateInput,
    signal?: AbortSignal,
  ): Promise<SearchEngineView> {
    return this.requestJson<{ engine: SearchEngineView }>(
      'PUT',
      `/api/v1/plugins/search/${encodeURIComponent(id)}`,
      { body: sanitizeSearchUpdatePayload(input), signal },
    ).then((res) => res.engine);
  }

  testSearchEngine(
    id: string,
    input?: SearchEngineTestInput,
    signal?: AbortSignal,
  ): Promise<SearchEngineTestResult> {
    return this.requestJson<SearchEngineTestResult>(
      'POST',
      `/api/v1/plugins/search/${encodeURIComponent(id)}/test`,
      { body: input ?? {}, signal },
    );
  }

  listMcpServers(signal?: AbortSignal): Promise<MCPServerConfig[]> {
    return this.requestJson<{ servers?: MCPServerConfig[] }>(
      'GET',
      '/api/v1/mcp/servers',
      { signal },
    ).then((res) => res.servers ?? []);
  }

  createMcpServer(
    input: MCPServerInput,
    signal?: AbortSignal,
  ): Promise<MCPServerConfig> {
    return this.requestJson<{ server: MCPServerConfig }>(
      'POST',
      '/api/v1/mcp/servers',
      { body: input, signal },
    ).then((res) => res.server);
  }

  updateMcpServer(
    id: string,
    input: Partial<MCPServerInput>,
    signal?: AbortSignal,
  ): Promise<MCPServerConfig> {
    return this.requestJson<{ server: MCPServerConfig }>(
      'PUT',
      `/api/v1/mcp/servers/${encodeURIComponent(id)}`,
      { body: input, signal },
    ).then((res) => res.server);
  }

  deleteMcpServer(id: string, signal?: AbortSignal): Promise<void> {
    return this.requestJson<void>(
      'DELETE',
      `/api/v1/mcp/servers/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  listMcpServerTools(
    id: string,
    signal?: AbortSignal,
  ): Promise<MCPToolDescriptor[]> {
    return this.requestJson<{ tools?: MCPToolDescriptor[] }>(
      'GET',
      `/api/v1/mcp/servers/${encodeURIComponent(id)}/tools`,
      { signal },
    ).then((res) => res.tools ?? []);
  }

  testMcpServer(
    id: string,
    signal?: AbortSignal,
  ): Promise<MCPServerTestResult> {
    return this.requestJson<MCPServerTestResult>(
      'POST',
      `/api/v1/mcp/servers/${encodeURIComponent(id)}/test`,
      { body: {}, signal },
    );
  }

  async openToolExecutionStream(
    conversationId: string,
    calls: ToolCallExecutionInput[],
    signal?: AbortSignal,
  ): Promise<Response> {
    const serialized = this.serializeBody({ calls });
    const url = resolveGatewayUrl(
      this.baseUrl,
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/tools/execute`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(true, true, { Accept: 'text/event-stream' }),
        body: serialized,
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new GatewayError(
        'NETWORK_ERROR',
        err instanceof Error ? err.message : '工具执行连接失败',
      );
    }

    if (!response.ok) {
      const rawText = await response.text();
      const env = parseErrorEnvelope(rawText, response.status);
      throw new GatewayError(env.code, env.message, response.status);
    }
    return response;
  }

  async openChatStream(
    conversationId: string,
    input: StreamChatInput,
    signal?: AbortSignal,
  ): Promise<Response> {
    const serialized = this.serializeBody(buildStreamChatPayload(input));
    const url = resolveGatewayUrl(
      this.baseUrl,
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(true, true, { Accept: 'text/event-stream' }),
        body: serialized,
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new GatewayError(
        'NETWORK_ERROR',
        err instanceof Error ? err.message : '流式连接建立失败',
      );
    }

    if (!response.ok) {
      const rawText = await response.text();
      const env = parseErrorEnvelope(rawText, response.status);
      throw new GatewayError(env.code, env.message, response.status);
    }
    return response;
  }
}
