package domain

import (
	"encoding/json"
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
)

// Message roles.
const (
	RoleUser       = "user"
	RoleAssistant  = "assistant"
	RoleToolResult = "toolResult"
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

// CompatConfig holds declarative protocol compatibility overrides for providers and models.
type CompatConfig struct {
	MaxTokensField        string            `json:"maxTokensField,omitempty"`
	SupportsDeveloperRole *bool             `json:"supportsDeveloperRole,omitempty"`
	SupportsStreamOptions *bool             `json:"supportsStreamOptions,omitempty"`
	ThinkingFormat        string            `json:"thinkingFormat,omitempty"`
	ReasoningEffortField  string            `json:"reasoningEffortField,omitempty"`
	PathOverride          string            `json:"pathOverride,omitempty"`
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
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Adapter   string            `json:"adapter"`
	BaseURL   string            `json:"baseURL"`
	AuthType  string            `json:"authType"`
	APIKey    string            `json:"apiKey,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Models    []ModelConfig     `json:"models"`
	Enabled   bool              `json:"enabled"`
	BuiltIn   bool              `json:"builtIn"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

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
	ToolCallID string `json:"toolCallId,omitempty"`
	ToolName   string `json:"toolName,omitempty"`
	Content    string `json:"content,omitempty"`
	IsError    bool   `json:"isError,omitempty"`

	// Extension payload for future custom blocks (e.g., imageGen).
	Extra json.RawMessage `json:"extra,omitempty"`
}

// Usage tracks token consumption for a message.
type Usage struct {
	InputTokens    int `json:"inputTokens"`
	OutputTokens   int `json:"outputTokens"`
	ThinkingTokens int `json:"thinkingTokens,omitempty"`
	TotalTokens    int `json:"totalTokens"`
}

// Message represents a persisted turn in a conversation.
type Message struct {
	ID             string         `json:"id"`
	ConversationID string         `json:"conversationId"`
	Role           string         `json:"role"`
	Blocks         []ContentBlock `json:"blocks"`
	ProviderID     string         `json:"providerId,omitempty"`
	ModelID        string         `json:"modelId,omitempty"`
	Usage          *Usage         `json:"usage,omitempty"`
	StopReason     string         `json:"stopReason,omitempty"`
	ErrorMessage   string         `json:"errorMessage,omitempty"`
	CreatedAt      time.Time      `json:"createdAt"`
}

// Conversation represents a chat session with reserved selective sync metadata.
type Conversation struct {
	ID           string           `json:"id"`
	Title        string           `json:"title"`
	ProviderID   string           `json:"providerId,omitempty"`
	ModelID      string           `json:"modelId,omitempty"`
	SystemPrompt string           `json:"systemPrompt,omitempty"`
	Params       GenerationParams `json:"params"`
	SyncEnabled  bool             `json:"syncEnabled"`
	SyncState    string           `json:"syncState"`
	SyncVersion  int64            `json:"syncVersion"`
	LastSyncedAt *time.Time       `json:"lastSyncedAt,omitempty"`
	CreatedAt    time.Time        `json:"createdAt"`
	UpdatedAt    time.Time        `json:"updatedAt"`
}

// NewConversationDefaults ensures reserved sync metadata fields carry canonical defaults.
func NewConversationDefaults(c *Conversation) {
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
