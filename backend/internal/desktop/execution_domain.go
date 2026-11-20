package desktop

import (
	"context"
	"encoding/json"
	"sort"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

// CompositeToolRuntime unifies local and cloud MCP servers under a deterministic
// scoped alias namespace and routes executions to the owning domain runtime.
type CompositeToolRuntime struct {
	localStore  *store.MCPServerStore
	localClient plugin.MCPClientBoundary
	cloudClient *CloudClient
}

// NewCompositeToolRuntime constructs a dual-domain MCP catalog and runtime router.
func NewCompositeToolRuntime(
	localStore *store.MCPServerStore,
	localClient plugin.MCPClientBoundary,
	cloudClient *CloudClient,
) *CompositeToolRuntime {
	return &CompositeToolRuntime{
		localStore:  localStore,
		localClient: localClient,
		cloudClient: cloudClient,
	}
}

// ID identifies this composite MCP runtime.
func (r *CompositeToolRuntime) ID() string {
	return "desktop-composite-mcp"
}

// ListScoped returns enabled and disabled servers from both local and cloud domains
// sorted deterministically by (scope, serverID). Cloud errors degrade gracefully so
// local MCP tools remain available offline.
func (r *CompositeToolRuntime) ListScoped(ctx context.Context) ([]service.ScopedMCPServer, error) {
	var out []service.ScopedMCPServer
	if r.localStore != nil {
		localServers, err := r.localStore.List(ctx)
		if err != nil {
			return nil, err
		}
		for _, srv := range localServers {
			out = append(out, service.ScopedMCPServer{
				Scope:  plugin.ExecutionScopeLocal,
				Server: srv,
			})
		}
	}
	if r.cloudClient != nil && r.cloudClient.IsConfigured() {
		if cloudServers, err := r.cloudClient.ListMCPServers(ctx); err == nil {
			for _, srv := range cloudServers {
				out = append(out, service.ScopedMCPServer{
					Scope:  plugin.ExecutionScopeCloud,
					Server: srv,
				})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Scope != out[j].Scope {
			return out[i].Scope < out[j].Scope
		}
		return out[i].Server.ID < out[j].Server.ID
	})
	return out, nil
}

// GetScoped fetches an MCP server configuration from the specified domain.
func (r *CompositeToolRuntime) GetScoped(ctx context.Context, scope plugin.ExecutionScope, id string) (domain.MCPServerConfig, error) {
	switch scope {
	case plugin.ExecutionScopeLocal:
		if r.localStore == nil {
			return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeNotFound, "local mcp store unavailable", nil)
		}
		return r.localStore.Get(ctx, id)
	case plugin.ExecutionScopeCloud:
		if r.cloudClient == nil || !r.cloudClient.IsConfigured() {
			return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeNotFound, "cloud mcp store unavailable", nil)
		}
		servers, err := r.cloudClient.ListMCPServers(ctx)
		if err != nil {
			return domain.MCPServerConfig{}, err
		}
		for _, srv := range servers {
			if srv.ID == id {
				return srv, nil
			}
		}
		return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeNotFound, "cloud mcp server not found", nil)
	default:
		return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeInvalidArgument, "unsupported execution scope", nil)
	}
}

// List implements service.MCPCatalog by returning merged server configurations.
func (r *CompositeToolRuntime) List(ctx context.Context) ([]domain.MCPServerConfig, error) {
	scoped, err := r.ListScoped(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.MCPServerConfig, len(scoped))
	for i, item := range scoped {
		out[i] = item.Server
	}
	return out, nil
}

// Get implements service.MCPCatalog, searching local first then cloud.
func (r *CompositeToolRuntime) Get(ctx context.Context, id string) (domain.MCPServerConfig, error) {
	if r.localStore != nil {
		if srv, err := r.localStore.Get(ctx, id); err == nil {
			return srv, nil
		}
	}
	return r.GetScoped(ctx, plugin.ExecutionScopeCloud, id)
}

// ListScopedTools discovers tools for a server in the specified execution scope.
func (r *CompositeToolRuntime) ListScopedTools(ctx context.Context, scope plugin.ExecutionScope, server domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	switch scope {
	case plugin.ExecutionScopeLocal:
		if r.localClient == nil {
			return nil, domain.NewError(domain.ErrCodeInternalError, "local MCP runtime unavailable", nil)
		}
		return r.localClient.ListTools(ctx, server)
	case plugin.ExecutionScopeCloud:
		if r.cloudClient == nil || !r.cloudClient.IsConfigured() {
			return nil, domain.NewError(domain.ErrCodeUpstreamError, "cloud gateway is not connected", nil)
		}
		return r.cloudClient.ListMCPServerTools(ctx, server.ID)
	default:
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "unsupported execution scope", nil)
	}
}

// CallScopedTool executes a tool against either the local MCP runtime or the stateless cloud MCP endpoint.
func (r *CompositeToolRuntime) CallScopedTool(
	ctx context.Context,
	scope plugin.ExecutionScope,
	server domain.MCPServerConfig,
	name string,
	arguments json.RawMessage,
) (plugin.MCPCallToolResult, error) {
	switch scope {
	case plugin.ExecutionScopeLocal:
		if r.localClient == nil {
			return plugin.MCPCallToolResult{}, domain.NewError(domain.ErrCodeInternalError, "local MCP runtime unavailable", nil)
		}
		return r.localClient.CallTool(ctx, server, name, arguments)
	case plugin.ExecutionScopeCloud:
		if r.cloudClient == nil || !r.cloudClient.IsConfigured() {
			return plugin.MCPCallToolResult{}, domain.NewError(domain.ErrCodeUpstreamError, "cloud gateway is not connected", nil)
		}
		results, err := r.cloudClient.ExecuteCloudMCPTools(ctx, []service.StatelessToolCallInput{
			{
				ID:        domain.NewUUID(),
				ServerID:  server.ID,
				ToolName:  name,
				Arguments: arguments,
			},
		})
		if err != nil {
			return plugin.MCPCallToolResult{}, err
		}
		if len(results) == 0 {
			return plugin.MCPCallToolResult{IsError: true, Content: []plugin.MCPToolContent{{Type: "text", Text: "empty cloud MCP tool response"}}}, nil
		}
		return contentBlockToMCPResult(results[0]), nil
	default:
		return plugin.MCPCallToolResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "unsupported execution scope", nil)
	}
}

// CloseScopedServer terminates a local cached MCP session; cloud sessions are stateless per server.
func (r *CompositeToolRuntime) CloseScopedServer(scope plugin.ExecutionScope, serverID string) error {
	if scope == plugin.ExecutionScopeLocal && r.localClient != nil {
		return r.localClient.CloseServer(serverID)
	}
	return nil
}

// ListTools implements plugin.MCPClientBoundary for local fallback.
func (r *CompositeToolRuntime) ListTools(ctx context.Context, server domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	return r.ListScopedTools(ctx, plugin.ExecutionScopeLocal, server)
}

// CallTool implements plugin.MCPClientBoundary for local fallback.
func (r *CompositeToolRuntime) CallTool(ctx context.Context, server domain.MCPServerConfig, name string, arguments json.RawMessage) (plugin.MCPCallToolResult, error) {
	return r.CallScopedTool(ctx, plugin.ExecutionScopeLocal, server, name, arguments)
}

// CloseServer implements plugin.MCPClientBoundary.
func (r *CompositeToolRuntime) CloseServer(serverID string) error {
	return r.CloseScopedServer(plugin.ExecutionScopeLocal, serverID)
}

// Close implements plugin.MCPClientBoundary.
func (r *CompositeToolRuntime) Close() error {
	if r.localClient != nil {
		return r.localClient.Close()
	}
	return nil
}

func contentBlockToMCPResult(block domain.ContentBlock) plugin.MCPCallToolResult {
	res := plugin.MCPCallToolResult{
		IsError: block.IsError,
	}
	if len(block.Extra) > 0 {
		var extra struct {
			Content           []plugin.MCPToolContent `json:"content"`
			StructuredContent json.RawMessage         `json:"structuredContent"`
		}
		if err := json.Unmarshal(block.Extra, &extra); err == nil {
			res.Content = extra.Content
			res.StructuredContent = extra.StructuredContent
		}
	}
	if len(res.Content) == 0 && block.Content != "" {
		res.Content = []plugin.MCPToolContent{{
			Type: "text",
			Text: block.Content,
		}}
	}
	return res
}
