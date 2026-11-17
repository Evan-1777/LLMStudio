package plugin

import (
	"context"
	"encoding/json"

	"llmstudio/backend/internal/domain"
)

// MCPToolAnnotations describes optional behavioral hints exposed by an MCP tool.
type MCPToolAnnotations struct {
	Title           string `json:"title,omitempty"`
	ReadOnlyHint    *bool  `json:"readOnlyHint,omitempty"`
	DestructiveHint *bool  `json:"destructiveHint,omitempty"`
	IdempotentHint  *bool  `json:"idempotentHint,omitempty"`
	OpenWorldHint   *bool  `json:"openWorldHint,omitempty"`
}

// MCPToolDescriptor describes a tool exposed by an external MCP server.
type MCPToolDescriptor struct {
	Name         string              `json:"name"`
	Title        string              `json:"title,omitempty"`
	Description  string              `json:"description,omitempty"`
	InputSchema  json.RawMessage     `json:"inputSchema,omitempty"`
	OutputSchema json.RawMessage     `json:"outputSchema,omitempty"`
	Annotations  *MCPToolAnnotations `json:"annotations,omitempty"`
}

// MCPEmbeddedResource represents an inline resource returned inside an MCP resource item.
type MCPEmbeddedResource struct {
	URI      string `json:"uri,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"`
}

// MCPToolContent represents a single typed item in an MCP tools/call result.
type MCPToolContent struct {
	Type        string               `json:"type"`
	Text        string               `json:"text,omitempty"`
	Data        string               `json:"data,omitempty"`
	MimeType    string               `json:"mimeType,omitempty"`
	URI         string               `json:"uri,omitempty"`
	Name        string               `json:"name,omitempty"`
	Description string               `json:"description,omitempty"`
	Resource    *MCPEmbeddedResource `json:"resource,omitempty"`
	Annotations json.RawMessage      `json:"annotations,omitempty"`
}

// MCPCallToolResult holds the structured output from an MCP tools/call invocation.
type MCPCallToolResult struct {
	Content           []MCPToolContent `json:"content,omitempty"`
	StructuredContent json.RawMessage  `json:"structuredContent,omitempty"`
	IsError           bool             `json:"isError,omitempty"`
}

// MCPClientBoundary defines the extension point for MCP tool discovery, invocation, and session cleanup.
type MCPClientBoundary interface {
	ID() string
	ListTools(ctx context.Context, server domain.MCPServerConfig) ([]MCPToolDescriptor, error)
	CallTool(ctx context.Context, server domain.MCPServerConfig, name string, arguments json.RawMessage) (MCPCallToolResult, error)
	CloseServer(serverID string) error
	Close() error
}
