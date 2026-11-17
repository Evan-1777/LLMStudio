package plugin

import (
	"context"
	"encoding/json"

	"llmstudio/backend/internal/domain"
)

// MCPToolDescriptor describes a tool exposed by an external MCP server.
type MCPToolDescriptor struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// MCPClientBoundary defines the reserved extension point for future MCP tool execution.
type MCPClientBoundary interface {
	ID() string
	ListTools(ctx context.Context, server domain.MCPServerConfig) ([]MCPToolDescriptor, error)
}
