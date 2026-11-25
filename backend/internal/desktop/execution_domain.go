package desktop

import (
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

const defaultCloudMCPCacheTTL = 5 * time.Minute

type cachedCloudMCPServers struct {
	conn      *cloudConnection
	servers   []domain.MCPServerConfig
	fetchedAt time.Time
	loaded    bool
}

type cachedCloudMCPTools struct {
	conn      *cloudConnection
	updatedAt time.Time
	tools     []plugin.MCPToolDescriptor
	fetchedAt time.Time
}

// CompositeToolRuntime unifies local and cloud MCP servers under a deterministic
// scoped alias namespace and routes executions to the owning domain runtime.
type CompositeToolRuntime struct {
	localStore  *store.MCPServerStore
	localClient plugin.MCPClientBoundary
	cloudClient *CloudClient

	mu           sync.RWMutex
	ttl          time.Duration
	nowFn        func() time.Time
	cloudServers cachedCloudMCPServers
	cloudTools   map[string]cachedCloudMCPTools
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
		ttl:         defaultCloudMCPCacheTTL,
		cloudTools:  make(map[string]cachedCloudMCPTools),
	}
}

func (r *CompositeToolRuntime) now() time.Time {
	if r != nil && r.nowFn != nil {
		return r.nowFn()
	}
	return time.Now()
}

func (r *CompositeToolRuntime) cacheTTL() time.Duration {
	if r != nil && r.ttl > 0 {
		return r.ttl
	}
	return defaultCloudMCPCacheTTL
}

func (r *CompositeToolRuntime) activeConn(ctx context.Context) *cloudConnection {
	if ctx != nil {
		if conn, _ := ctx.Value(cloudConnectionKey{}).(*cloudConnection); conn != nil {
			return conn
		}
	}
	return r.cloudClient.currentConnection()
}

func (r *CompositeToolRuntime) cachedServersFor(conn *cloudConnection) ([]domain.MCPServerConfig, bool) {
	if conn == nil {
		return nil, false
	}
	now := r.now()
	ttl := r.cacheTTL()
	r.mu.RLock()
	defer r.mu.RUnlock()
	if !r.cloudServers.loaded || r.cloudServers.conn != conn {
		return nil, false
	}
	if now.Sub(r.cloudServers.fetchedAt) >= ttl {
		return nil, false
	}
	return cloneMCPServerConfigs(r.cloudServers.servers), true
}

func cloneMCPServerConfigs(in []domain.MCPServerConfig) []domain.MCPServerConfig {
	out := make([]domain.MCPServerConfig, len(in))
	for i, srv := range in {
		out[i] = srv
		if srv.Args != nil {
			out[i].Args = slices.Clone(srv.Args)
		}
		if srv.DisabledTools != nil {
			out[i].DisabledTools = slices.Clone(srv.DisabledTools)
		}
	}
	return out
}

// SetCloudServers updates the connection-bound cloud MCP server cache.
func (r *CompositeToolRuntime) SetCloudServers(conn *cloudConnection, servers []domain.MCPServerConfig) {
	if r == nil || conn == nil || r.cloudClient.currentConnection() != conn {
		return
	}
	now := r.now()
	r.mu.Lock()
	r.cloudServers = cachedCloudMCPServers{
		conn:      conn,
		servers:   cloneMCPServerConfigs(servers),
		fetchedAt: now,
		loaded:    true,
	}
	r.mu.Unlock()
}

// SetCloudServerTools updates the connection- and version-bound cloud MCP tool catalog cache.
func (r *CompositeToolRuntime) SetCloudServerTools(conn *cloudConnection, serverID string, updatedAt time.Time, tools []plugin.MCPToolDescriptor) {
	if r == nil || conn == nil || strings.TrimSpace(serverID) == "" || r.cloudClient.currentConnection() != conn {
		return
	}
	now := r.now()
	r.mu.Lock()
	if r.cloudTools == nil {
		r.cloudTools = make(map[string]cachedCloudMCPTools)
	}
	r.cloudTools[serverID] = cachedCloudMCPTools{
		conn:      conn,
		updatedAt: updatedAt,
		tools:     slices.Clone(tools),
		fetchedAt: now,
	}
	r.mu.Unlock()
}

// InvalidateCloudCache clears all cached cloud MCP server lists and tool catalogs.
func (r *CompositeToolRuntime) InvalidateCloudCache() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.cloudServers = cachedCloudMCPServers{}
	r.cloudTools = make(map[string]cachedCloudMCPTools)
	r.mu.Unlock()
}

// InvalidateCloudServer clears cached server list and tool catalog entries for a single cloud MCP server.
func (r *CompositeToolRuntime) InvalidateCloudServer(serverID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.cloudServers.loaded = false
	delete(r.cloudTools, serverID)
	r.mu.Unlock()
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
		conn := r.activeConn(ctx)
		cloudServers, ok := r.cachedServersFor(conn)
		if !ok {
			if fetched, err := r.cloudClient.ListMCPServers(ctx); err == nil {
				cloudServers = fetched
				r.SetCloudServers(conn, fetched)
				ok = true
			}
		}
		if ok {
			for _, srv := range cloudServers {
				out = append(out, service.ScopedMCPServer{
					Scope:  plugin.ExecutionScopeCloud,
					Server: srv,
				})
			}
		}
	}
	slices.SortFunc(out, func(a, b service.ScopedMCPServer) int {
		return cmp.Or(cmp.Compare(a.Scope, b.Scope), cmp.Compare(a.Server.ID, b.Server.ID))
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
		conn := r.activeConn(ctx)
		servers, ok := r.cachedServersFor(conn)
		if !ok {
			fetched, err := r.cloudClient.ListMCPServers(ctx)
			if err != nil {
				return domain.MCPServerConfig{}, err
			}
			servers = fetched
			r.SetCloudServers(conn, fetched)
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
		conn := r.activeConn(ctx)
		if conn != nil {
			now := r.now()
			ttl := r.cacheTTL()
			r.mu.RLock()
			entry, ok := r.cloudTools[server.ID]
			r.mu.RUnlock()
			if ok && entry.conn == conn && entry.updatedAt.Equal(server.UpdatedAt) && now.Sub(entry.fetchedAt) < ttl {
				return slices.Clone(entry.tools), nil
			}
		}
		tools, err := r.cloudClient.ListMCPServerTools(ctx, server.ID)
		if err != nil {
			return nil, err
		}
		r.SetCloudServerTools(conn, server.ID, server.UpdatedAt, tools)
		return tools, nil
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
			if appErr, ok := domain.AsAppError(err); ok && (appErr.Code == domain.ErrCodeNotFound || appErr.Code == domain.ErrCodeInvalidArgument) {
				r.InvalidateCloudServer(server.ID)
			}
			return plugin.MCPCallToolResult{}, err
		}
		if len(results) == 0 {
			return plugin.MCPCallToolResult{IsError: true, Content: []plugin.MCPToolContent{{Type: "text", Text: "empty cloud MCP tool response"}}}, nil
		}
		res := contentBlockToMCPResult(results[0])
		if res.IsError && (strings.Contains(results[0].Content, "unavailable or disabled") || strings.Contains(results[0].Content, "is disabled") || strings.Contains(results[0].Content, "not found")) {
			r.InvalidateCloudServer(server.ID)
		}
		return res, nil
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
