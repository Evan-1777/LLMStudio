package domain

import (
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// Content block types.
const (
	BlockTypeText       = "text"
	BlockTypeThinking   = "thinking"
	BlockTypeImage      = "image"
	BlockTypeToolCall   = "toolCall"
	BlockTypeToolResult = "toolResult"
	BlockTypeWebSearch  = "webSearch"
	BlockTypeCompaction = "compaction"
)

// Reasoning effort levels.
const (
	EffortNone   = "none"
	EffortLow    = "low"
	EffortMedium = "medium"
	EffortHigh   = "high"
	EffortXHigh  = "xhigh"
	EffortMax    = "max"
)

// DefaultAssistantID identifies the built-in fallback assistant.
const DefaultAssistantID = "default"

// MCP transport types.
const (
	MCPTransportStdio          = "stdio"
	MCPTransportSSE            = "sse"
	MCPTransportStreamableHTTP = "streamable-http"
)

// Message roles.
const (
	RoleUser       = "user"
	RoleAssistant  = "assistant"
	RoleToolResult = "toolResult"
	RoleCompaction = "compaction"
)

// Stop reasons.
const (
	StopReasonStop    = "stop"
	StopReasonLength  = "length"
	StopReasonToolUse = "toolUse"
	StopReasonAborted = "aborted"
	StopReasonError   = "error"
)

// StreamEvent types emitted over SSE.
const (
	StreamEventMessageStart = "message_start"
	StreamEventBlockStart   = "block_start"
	StreamEventBlockDelta   = "block_delta"
	StreamEventBlockEnd     = "block_end"
	StreamEventMessageDelta = "message_delta"
	StreamEventMessageEnd   = "message_end"
	StreamEventError        = "error"
)

// Delta types for block_delta events.
const (
	DeltaTypeText         = "text_delta"
	DeltaTypeThinking     = "thinking_delta"
	DeltaTypeSignature    = "signature_delta"
	DeltaTypeToolCallArgs = "toolcall_delta"
)

// Provider auth types.
const (
	AuthTypeBearer    = "bearer"
	AuthTypeXAPIKey   = "x-api-key"
	AuthTypeQueryKey  = "query-key"
	AuthTypeHeaderKey = "header-key"
	AuthTypeNone      = "none"
)

// Sync states reserved for future selective conversation sync.
const (
	SyncStateLocalOnly = "local_only"
	SyncStatePending   = "pending"
	SyncStateSynced    = "synced"
	SyncStateConflict  = "conflict"
)

// BoolPtr returns a pointer to v for optional boolean overrides.
func BoolPtr(v bool) *bool {
	return &v
}

// Prompt cache modes for CompatConfig.CacheMode.
const (
	CacheModeAuto     = "auto"
	CacheModeImplicit = "implicit"
	CacheModeExplicit = "explicit"
	CacheModeDisabled = "disabled"
)

// CompatConfig holds declarative protocol compatibility overrides for providers and models.
type CompatConfig struct {
	MaxTokensField        string            `json:"maxTokensField,omitempty"`
	SupportsDeveloperRole *bool             `json:"supportsDeveloperRole,omitempty"`
	SupportsStreamOptions *bool             `json:"supportsStreamOptions,omitempty"`
	ThinkingFormat        string            `json:"thinkingFormat,omitempty"`
	ReasoningEffortField  string            `json:"reasoningEffortField,omitempty"`
	PathOverride          string            `json:"pathOverride,omitempty"`
	CacheMode             string            `json:"cacheMode,omitempty"`
	ExtraHeaders          map[string]string `json:"extraHeaders,omitempty"`
	ExtraBody             map[string]any    `json:"extraBody,omitempty"`
}

// DeveloperRoleSupported reports whether developer role is explicitly enabled.
func (c CompatConfig) DeveloperRoleSupported() bool {
	return c.SupportsDeveloperRole != nil && *c.SupportsDeveloperRole
}

// StreamOptionsSupported reports whether stream_options is explicitly enabled.
func (c CompatConfig) StreamOptionsSupported() bool {
	return c.SupportsStreamOptions != nil && *c.SupportsStreamOptions
}

// GenerationParams stores per-conversation or per-request sampling parameters.
type GenerationParams struct {
	Temperature     *float64 `json:"temperature,omitempty"`
	MaxTokens       *int     `json:"maxTokens,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
}

// ModelConfig binds a model definition to an APIFormat ID and optional compatibility overrides.
type ModelConfig struct {
	ID              string           `json:"id"`
	Name            string           `json:"name"`
	APIFormat       string           `json:"apiFormat"`
	ContextWindow   int              `json:"contextWindow,omitempty"`
	MaxTokens       int              `json:"maxTokens,omitempty"`
	Reasoning       bool             `json:"reasoning,omitempty"`
	InputModalities []string         `json:"inputModalities,omitempty"`
	Compat          CompatConfig     `json:"compat,omitempty"`
	DefaultParams   GenerationParams `json:"defaultParams,omitempty"`
}

// ProviderConfig defines an upstream AI provider connection and its configured models.
// APIKey is accepted on JSON unmarshaling but never emitted in MarshalJSON output.
type ProviderConfig struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Adapter      string            `json:"adapter"`
	BaseURL      string            `json:"baseURL"`
	AuthType     string            `json:"authType"`
	APIKey       string            `json:"apiKey,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	Models       []ModelConfig     `json:"models"`
	Enabled      bool              `json:"enabled"`
	BuiltIn      bool              `json:"builtIn"`
	LocalRequest bool              `json:"localRequest"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`

	// apiKeyManaged is a storage-only marker: true once the gateway itself wrote
	// the credential (create, explicit set, explicit clear, or one-time import).
	// It never appears in API responses.
	apiKeyManaged bool
}

// APIKeyManaged reports whether the stored credential is gateway-owned.
func (p ProviderConfig) APIKeyManaged() bool { return p.apiKeyManaged }

// MarkAPIKeyManaged records that the gateway owns the stored credential.
func (p *ProviderConfig) MarkAPIKeyManaged() { p.apiKeyManaged = true }

type providerWire struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Adapter      string            `json:"adapter"`
	BaseURL      string            `json:"baseURL"`
	AuthType     string            `json:"authType"`
	APIKeyMasked string            `json:"apiKeyMasked"`
	APIKeySet    bool              `json:"apiKeySet"`
	Headers      map[string]string `json:"headers,omitempty"`
	Models       []ModelConfig     `json:"models"`
	Enabled      bool              `json:"enabled"`
	BuiltIn      bool              `json:"builtIn"`
	LocalRequest bool              `json:"localRequest"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
}

// MarshalJSON redacts APIKey and exposes apiKeyMasked and apiKeySet instead.
func (p ProviderConfig) MarshalJSON() ([]byte, error) {
	models := p.Models
	if models == nil {
		models = []ModelConfig{}
	}
	wire := providerWire{
		ID:           p.ID,
		Name:         p.Name,
		Adapter:      p.Adapter,
		BaseURL:      p.BaseURL,
		AuthType:     p.AuthType,
		APIKeyMasked: MaskAPIKey(p.APIKey),
		APIKeySet:    strings.TrimSpace(p.APIKey) != "",
		Headers:      p.Headers,
		Models:       models,
		Enabled:      p.Enabled,
		BuiltIn:      p.BuiltIn,
		LocalRequest: p.LocalRequest,
		CreatedAt:    p.CreatedAt,
		UpdatedAt:    p.UpdatedAt,
	}
	return json.Marshal(wire)
}

// MaskAPIKey returns a redacted display representation of an API key.
func MaskAPIKey(key string) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) <= 8 {
		return "****"
	}
	return trimmed[:4] + "..." + trimmed[len(trimmed)-4:]
}

// ContentBlock represents a unified multimodal or reserved agent block inside a Message.
type ContentBlock struct {
	Type string `json:"type"`

	// Text block field.
	Text string `json:"text,omitempty"`

	// Thinking block fields.
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`

	// Image block fields (inline/URL only, no dangling asset IDs).
	MimeType string `json:"mimeType,omitempty"`
	URL      string `json:"url,omitempty"`
	Data     string `json:"data,omitempty"`

	// Reserved Agent toolCall fields.
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`

	// Reserved Agent toolResult fields.
	ToolSource string `json:"toolSource,omitempty"` // native, mcp, or builtin
	ToolCallID string `json:"toolCallId,omitempty"`
	ToolName   string `json:"toolName,omitempty"`
	Content    string `json:"content,omitempty"`
	IsError    bool   `json:"isError,omitempty"`

	// Extension payload for future custom blocks (e.g., imageGen).
	Extra json.RawMessage `json:"extra,omitempty"`
}

// Usage tracks token consumption for a message.
type Usage struct {
	InputTokens              int `json:"inputTokens"`
	OutputTokens             int `json:"outputTokens"`
	ThinkingTokens           int `json:"thinkingTokens,omitempty"`
	CacheReadInputTokens     int `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens int `json:"cacheCreationInputTokens,omitempty"`
	TotalTokens              int `json:"totalTokens"`
	ContextTokens            int `json:"contextTokens,omitempty"`
}

// MessageGraphMeta stores display preferences for a conversation node.
type MessageGraphMeta struct {
	Collapsed bool     `json:"collapsed,omitempty"`
	Summary   string   `json:"summary,omitempty"`
	X         *float64 `json:"x,omitempty"`
	Y         *float64 `json:"y,omitempty"`
}

type ConversationBranchSlot struct {
	ID              string    `json:"id"`
	Label           string    `json:"label"`
	ParentMessageID string    `json:"parentMessageId"`
	X               *float64  `json:"x,omitempty"`
	Y               *float64  `json:"y,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
}

type ConversationGraphState struct {
	Enabled        bool                     `json:"enabled"`
	ActiveBranchID string                   `json:"activeBranchId,omitempty"`
	Branches       []ConversationBranchSlot `json:"branches"`
}

// MessageGraphWrite carries insertion options, not persisted message data.
type MessageGraphWrite struct {
	ParentID        *string
	ConsumeBranchID string
}

// Message represents a persisted turn in a conversation.
type Message struct {
	GraphWrite     *MessageGraphWrite `json:"-"`
	ParentID       string             `json:"parentId,omitempty"`
	GraphMeta      *MessageGraphMeta  `json:"graphMeta,omitempty"`
	ID             string             `json:"id"`
	ConversationID string             `json:"conversationId"`
	Role           string             `json:"role"`
	Blocks         []ContentBlock     `json:"blocks"`
	ProviderID     string             `json:"providerId,omitempty"`
	ModelID        string             `json:"modelId,omitempty"`
	Usage          *Usage             `json:"usage,omitempty"`
	StopReason     string             `json:"stopReason,omitempty"`
	ErrorMessage   string             `json:"errorMessage,omitempty"`
	CreatedAt      time.Time          `json:"createdAt"`
}

// Assistant represents a reusable persona preset bound to conversations.
type Assistant struct {
	ID                string           `json:"id"`
	Name              string           `json:"name"`
	SystemPrompt      string           `json:"systemPrompt,omitempty"`
	DefaultProviderID string           `json:"defaultProviderId,omitempty"`
	DefaultModelID    string           `json:"defaultModelId,omitempty"`
	Params            GenerationParams `json:"params"`
	AvatarDataURL     string           `json:"avatarDataUrl"`
	IsDefault         bool             `json:"isDefault"`
	CreatedAt         time.Time        `json:"createdAt"`
	UpdatedAt         time.Time        `json:"updatedAt"`
}

// SearchEngineConfig stores persisted settings for a registered search engine plugin.
// APIKey is accepted on JSON unmarshaling and redacted on MarshalJSON output.
type SearchEngineConfig struct {
	EngineID   string    `json:"engineId"`
	Enabled    bool      `json:"enabled"`
	Endpoint   string    `json:"endpoint"`
	APIKey     string    `json:"apiKey,omitempty"`
	MaxResults int       `json:"maxResults"`
	IsDefault  bool      `json:"isDefault"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type searchEngineConfigWire struct {
	EngineID     string    `json:"engineId"`
	Enabled      bool      `json:"enabled"`
	Endpoint     string    `json:"endpoint"`
	APIKeyMasked string    `json:"apiKeyMasked"`
	APIKeySet    bool      `json:"apiKeySet"`
	MaxResults   int       `json:"maxResults"`
	IsDefault    bool      `json:"isDefault"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// MarshalJSON redacts APIKey and exposes apiKeyMasked and apiKeySet instead.
func (s SearchEngineConfig) MarshalJSON() ([]byte, error) {
	return json.Marshal(searchEngineConfigWire{
		EngineID:     s.EngineID,
		Enabled:      s.Enabled,
		Endpoint:     s.Endpoint,
		APIKeyMasked: MaskAPIKey(s.APIKey),
		APIKeySet:    strings.TrimSpace(s.APIKey) != "",
		MaxResults:   s.MaxResults,
		IsDefault:    s.IsDefault,
		UpdatedAt:    s.UpdatedAt,
	})
}

// MCPServerConfig defines a configured MCP server connection.
type MCPServerConfig struct {
	DisabledTools []string          `json:"disabledTools"`
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Transport     string            `json:"transport"`
	Endpoint      string            `json:"endpoint,omitempty"`
	Command       string            `json:"command,omitempty"`
	Args          []string          `json:"args"`
	Env           map[string]string `json:"env,omitempty"`
	Headers       map[string]string `json:"headers,omitempty"`
	Enabled       bool              `json:"enabled"`
	CreatedAt     time.Time         `json:"createdAt"`
	UpdatedAt     time.Time         `json:"updatedAt"`
}

// ToolEnabled combines the server switch and its per-tool policy.
func (s MCPServerConfig) ToolEnabled(name string) bool {
	return s.Enabled && !slices.Contains(s.DisabledTools, name)
}

// DiscoveredModel represents a model normalized from an upstream provider listing.
type DiscoveredModel struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Group           string   `json:"group"`
	APIFormat       string   `json:"apiFormat"`
	ContextWindow   int      `json:"contextWindow,omitempty"`
	MaxTokens       int      `json:"maxTokens,omitempty"`
	Reasoning       bool     `json:"reasoning,omitempty"`
	InputModalities []string `json:"inputModalities,omitempty"`
}

// ConversationGroup represents a single-level folder organizing conversations within an assistant.
type ConversationGroup struct {
	ID          string    `json:"id"`
	AssistantID string    `json:"assistantId"`
	Name        string    `json:"name"`
	SortOrder   int       `json:"sortOrder"`
	CreatedAt   time.Time `json:"createdAt"`
}

const (
	ConversationModeChat  = "chat"
	ConversationModeAgent = "agent"
)

func ValidConversationMode(mode string) bool {
	return mode == ConversationModeChat || mode == ConversationModeAgent
}

// Conversation represents a chat session with reserved selective sync metadata.
type Conversation struct {
	ActiveLeafID string                  `json:"activeLeafId,omitempty"`
	GraphState   *ConversationGraphState `json:"graphState,omitempty"`
	ID           string                  `json:"id"`
	AssistantID  string                  `json:"assistantId"`
	Title        string                  `json:"title"`
	ProviderID   string                  `json:"providerId,omitempty"`
	ModelID      string                  `json:"modelId,omitempty"`
	SystemPrompt string                  `json:"systemPrompt,omitempty"`
	Params       GenerationParams        `json:"params"`
	GroupID      *string                 `json:"groupId"`
	Pinned       bool                    `json:"pinned"`
	SortOrder    int                     `json:"sortOrder"`
	Ephemeral    bool                    `json:"ephemeral,omitempty"`
	Mode         string                  `json:"mode"`
	SyncEnabled  bool                    `json:"syncEnabled"`
	SyncState    string                  `json:"syncState"`
	SyncVersion  int64                   `json:"syncVersion"`
	LastSyncedAt *time.Time              `json:"lastSyncedAt,omitempty"`
	CreatedAt    time.Time               `json:"createdAt"`
	UpdatedAt    time.Time               `json:"updatedAt"`
}

// DeletedConversation identifies a removed topic and its assistant.
type DeletedConversation struct {
	ID          string `json:"id"`
	AssistantID string `json:"assistantId"`
}

// NewConversationDefaults ensures reserved sync metadata and assistant defaults are populated.
func NewConversationDefaults(c *Conversation) {
	if c.Mode == "" {
		c.Mode = ConversationModeChat
	}
	if c.AssistantID == "" {
		c.AssistantID = DefaultAssistantID
	}
	if c.SyncState == "" {
		c.SyncState = SyncStateLocalOnly
	}
}

// StreamError describes an error event sent over SSE.
type StreamError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// StreamEvent is the unified SSE wire payload emitted to clients.
type StreamEvent struct {
	Type           string        `json:"type"`
	ConversationID string        `json:"conversationId,omitempty"`
	MessageID      string        `json:"messageId,omitempty"`
	ProviderID     string        `json:"providerId,omitempty"`
	ModelID        string        `json:"modelId,omitempty"`
	Index          *int          `json:"index,omitempty"`
	BlockType      string        `json:"blockType,omitempty"`
	DeltaType      string        `json:"deltaType,omitempty"`
	Delta          string        `json:"delta,omitempty"`
	Block          *ContentBlock `json:"block,omitempty"`
	Usage          *Usage        `json:"usage,omitempty"`
	StopReason     string        `json:"stopReason,omitempty"`
	Message        *Message      `json:"message,omitempty"`
	Error          *StreamError  `json:"error,omitempty"`
}

// IntPtr returns a pointer to v for optional integer fields such as StreamEvent.Index.
func IntPtr(v int) *int {
	return &v
}
