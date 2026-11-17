export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_GATEWAY_BODY_BYTES = 16 * 1024 * 1024;

export type ReasoningEffort =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export const REASONING_EFFORT_LEVELS: readonly ReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type AuthType =
  | 'bearer'
  | 'x-api-key'
  | 'query-key'
  | 'header-key'
  | 'none';

export type MCPTransport = 'stdio' | 'sse' | 'streamable-http';

export interface CompatConfig {
  maxTokensField?: string;
  supportsDeveloperRole?: boolean | null;
  supportsStreamOptions?: boolean | null;
  thinkingFormat?: string;
  reasoningEffortField?: string;
  pathOverride?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface GenerationParams {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort | '';
}

export interface PatchGenerationParams {
  temperature?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: ReasoningEffort | '' | null;
}

export interface ModelConfig {
  id: string;
  name: string;
  apiFormat: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  inputModalities?: string[];
  compat?: CompatConfig;
  defaultParams?: GenerationParams;
}

export interface ProviderConfig {
  id: string;
  name: string;
  adapter: string;
  baseURL: string;
  authType: AuthType | string;
  apiKeyMasked: string;
  apiKeySet: boolean;
  headers?: Record<string, string>;
  models: ModelConfig[];
  enabled: boolean;
  builtIn: boolean;
  localRequest?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderUpsertPayload {
  id?: string;
  name: string;
  adapter: string;
  baseURL: string;
  authType: AuthType | string;
  apiKey?: string;
  clearApiKey?: boolean;
  headers?: Record<string, string>;
  models: ModelConfig[];
  enabled?: boolean;
  localRequest?: boolean;
}

export interface ProviderProbeInput {
  baseURL?: string;
  authType?: AuthType | string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ProviderConnectionResult {
  ok: boolean;
  latencyMs: number;
  modelCount: number;
  message: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  group: string;
  apiFormat: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  inputModalities?: string[];
}

export interface FormatInfo {
  id: string;
  displayName: string;
  defaultPath: string;
  defaultCompat: CompatConfig;
}

export interface ProviderAdapterInfo {
  id: string;
  displayName: string;
}

export interface Assistant {
  id: string;
  name: string;
  systemPrompt?: string;
  defaultProviderId?: string;
  defaultModelId?: string;
  params: GenerationParams;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AssistantUpsertPayload {
  id?: string;
  name: string;
  systemPrompt?: string;
  defaultProviderId?: string;
  defaultModelId?: string;
  params?: GenerationParams;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ImageBlock {
  type: 'image';
  mimeType?: string;
  url?: string;
  data?: string;
}

export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: unknown;
}

export interface ToolResultBlock {
  type: 'toolResult';
  toolCallId: string;
  toolName?: string;
  content?: string;
  isError?: boolean;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchExtra {
  query?: string;
  engineId?: string;
  results?: WebSearchResultItem[];
  error?: string;
}

export interface WebSearchBlock {
  type: 'webSearch';
  extra?: WebSearchExtra | unknown;
}

export interface UnknownExtensionBlock {
  type: string;
  extra?: unknown;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | WebSearchBlock
  | UnknownExtensionBlock;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  totalTokens: number;
}

export type StopReason = 'stop' | 'length' | 'toolUse' | 'aborted' | 'error' | '';

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'toolResult' | string;
  blocks: ContentBlock[];
  providerId?: string;
  modelId?: string;
  usage?: TokenUsage;
  stopReason?: StopReason | string;
  errorMessage?: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  assistantId: string;
  title: string;
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  params: GenerationParams;
  syncEnabled: boolean;
  syncState: string;
  syncVersion: number;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  assistantId?: string;
  title?: string;
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  params?: GenerationParams;
}

export interface PatchConversationInput {
  assistantId?: string | null;
  title?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  systemPrompt?: string | null;
  params?: PatchGenerationParams | null;
  syncEnabled?: boolean | null;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
}

export interface SearchEngineView {
  engineId: string;
  displayName: string;
  defaultEndpoint: string;
  requiresApiKey: boolean;
  enabled: boolean;
  endpoint: string;
  apiKeyMasked: string;
  apiKeySet: boolean;
  maxResults: number;
  isDefault: boolean;
  updatedAt?: string;
}

export interface SearchEngineUpdateInput {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  maxResults?: number;
  isDefault?: boolean;
}

export interface SearchEngineTestInput {
  query?: string;
  endpoint?: string;
  apiKey?: string;
  maxResults?: number;
}

export interface SearchEngineTestResult {
  ok: boolean;
  engineId: string;
  resultCount: number;
  latencyMs: number;
  message: string;
  results?: WebSearchResultItem[];
}

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: MCPTransport | string;
  endpoint?: string;
  command?: string;
  args: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface MCPServerInput {
  id?: string;
  name: string;
  transport: MCPTransport | string;
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type StreamEventType =
  | 'message_start'
  | 'block_start'
  | 'block_delta'
  | 'block_end'
  | 'message_delta'
  | 'message_end'
  | 'error';

export type DeltaType =
  | 'text_delta'
  | 'thinking_delta'
  | 'signature_delta'
  | 'toolcall_delta';

export interface StreamError {
  code: string;
  message: string;
}

export interface StreamEvent {
  type: StreamEventType;
  conversationId?: string;
  messageId?: string;
  providerId?: string;
  modelId?: string;
  index?: number;
  blockType?: string;
  deltaType?: DeltaType | string;
  delta?: string;
  block?: ContentBlock;
  usage?: TokenUsage;
  stopReason?: string;
  message?: Message;
  error?: StreamError;
}

export interface StreamChatInput {
  blocks?: ContentBlock[];
  text?: string;
  providerId?: string;
  modelId?: string;
  params?: GenerationParams;
  regenerateMessageId?: string;
  webSearch?: boolean;
  searchEngineId?: string;
}

export interface CreateMessageInput {
  role: 'user' | 'assistant' | 'toolResult';
  blocks: ContentBlock[];
  providerId?: string;
  modelId?: string;
  usage?: TokenUsage;
  stopReason?: StopReason | string;
  errorMessage?: string;
  replaceMessageId?: string;
  afterMessageId?: string;
}

export interface CreateMessageResult {
  message: Message;
  conversation: Conversation;
}

export interface PreparedLocalRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  authType: AuthType | string;
  webSearchBlock?: ContentBlock;
  replaceMessageId?: string;
  insertAfterMessageId?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  authRequired: boolean;
}

export interface ApiErrorEnvelope {
  code: string;
  message: string;
}
