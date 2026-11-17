package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/store"
)

// SearchEngineView combines registered search plugin metadata with persisted user settings.
type SearchEngineView struct {
	EngineID        string    `json:"engineId"`
	DisplayName     string    `json:"displayName"`
	DefaultEndpoint string    `json:"defaultEndpoint"`
	RequiresAPIKey  bool      `json:"requiresApiKey"`
	Enabled         bool      `json:"enabled"`
	Endpoint        string    `json:"endpoint"`
	APIKeyMasked    string    `json:"apiKeyMasked"`
	APIKeySet       bool      `json:"apiKeySet"`
	MaxResults      int       `json:"maxResults"`
	IsDefault       bool      `json:"isDefault"`
	UpdatedAt       time.Time `json:"updatedAt,omitempty"`
}

// SearchEngineUpdateInput defines mutable fields for configuring a search engine plugin.
type SearchEngineUpdateInput struct {
	Enabled     *bool  `json:"enabled,omitempty"`
	Endpoint    string `json:"endpoint,omitempty"`
	APIKey      string `json:"apiKey,omitempty"`
	ClearAPIKey bool   `json:"clearApiKey,omitempty"`
	MaxResults  *int   `json:"maxResults,omitempty"`
	IsDefault   *bool  `json:"isDefault,omitempty"`
}

// SearchEngineTestInput supplies optional unsaved overrides and query text for testing a search engine.
type SearchEngineTestInput struct {
	Query      string `json:"query,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	APIKey     string `json:"apiKey,omitempty"`
	MaxResults int    `json:"maxResults,omitempty"`
}

// SearchEngineTestResult summarizes a single search connectivity test execution.
type SearchEngineTestResult struct {
	OK          bool                  `json:"ok"`
	EngineID    string                `json:"engineId"`
	ResultCount int                   `json:"resultCount"`
	LatencyMs   int64                 `json:"latencyMs"`
	Message     string                `json:"message"`
	Results     []plugin.SearchResult `json:"results,omitempty"`
}

// MCPServerTestResult summarizes a connectivity and tool discovery probe against a saved MCP server.
type MCPServerTestResult struct {
	OK        bool                       `json:"ok"`
	ServerID  string                     `json:"serverId"`
	ToolCount int                        `json:"toolCount"`
	LatencyMs int64                      `json:"latencyMs"`
	Message   string                     `json:"message"`
	Tools     []plugin.MCPToolDescriptor `json:"tools"`
}

// MCPServerInput defines create or update fields for an MCP server configuration.
type MCPServerInput struct {
	ID        string            `json:"id,omitempty"`
	Name      string            `json:"name"`
	Transport string            `json:"transport"`
	Endpoint  string            `json:"endpoint,omitempty"`
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Enabled   *bool             `json:"enabled,omitempty"`
}

// PluginService manages search engine plugin configuration/testing and MCP server presets.
type PluginService struct {
	searchReg   *plugin.SearchRegistry
	searchStore *store.SearchConfigStore
	mcpStore    *store.MCPServerStore
	mcpClient   plugin.MCPClientBoundary
}

// NewPluginService constructs a PluginService.
func NewPluginService(
	searchReg *plugin.SearchRegistry,
	searchStore *store.SearchConfigStore,
	mcpStore *store.MCPServerStore,
) *PluginService {
	return &PluginService{
		searchReg:   searchReg,
		searchStore: searchStore,
		mcpStore:    mcpStore,
	}
}

// WithMCPClient attaches the shared MCP client runtime used for tool discovery and invalidation.
func (s *PluginService) WithMCPClient(client plugin.MCPClientBoundary) *PluginService {
	s.mcpClient = client
	return s
}

// ListSearchEngines returns all registered search engines merged with persisted settings.
func (s *PluginService) ListSearchEngines(ctx context.Context) ([]SearchEngineView, error) {
	infos := s.searchReg.List()
	storedList, err := s.searchStore.List(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]domain.SearchEngineConfig, len(storedList))
	hasDefault := false
	for _, cfg := range storedList {
		byID[cfg.EngineID] = cfg
		if cfg.IsDefault {
			hasDefault = true
		}
	}

	out := make([]SearchEngineView, 0, len(infos))
	for _, info := range infos {
		cfg, ok := byID[info.ID]
		endpoint := strings.TrimSpace(cfg.Endpoint)
		if endpoint == "" {
			endpoint = info.DefaultEndpoint
		}
		maxRes := cfg.MaxResults
		if maxRes <= 0 {
			maxRes = 5
		}
		isDef := cfg.IsDefault
		if !hasDefault && info.ID == "tavily" {
			isDef = true
		}
		view := SearchEngineView{
			EngineID:        info.ID,
			DisplayName:     info.DisplayName,
			DefaultEndpoint: info.DefaultEndpoint,
			RequiresAPIKey:  info.RequiresAPIKey,
			Enabled:         ok && cfg.Enabled,
			Endpoint:        endpoint,
			APIKeyMasked:    domain.MaskAPIKey(cfg.APIKey),
			APIKeySet:       strings.TrimSpace(cfg.APIKey) != "",
			MaxResults:      maxRes,
			IsDefault:       isDef,
			UpdatedAt:       cfg.UpdatedAt,
		}
		out = append(out, view)
	}
	return out, nil
}

// UpdateSearchEngine validates and persists configuration updates for a registered search engine.
func (s *PluginService) UpdateSearchEngine(ctx context.Context, id string, in SearchEngineUpdateInput) (SearchEngineView, error) {
	engine, ok := s.searchReg.Get(id)
	if !ok {
		return SearchEngineView{}, domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("unknown search engine %q", id), nil)
	}

	cfg, err := s.searchStore.Get(ctx, id)
	if err != nil {
		if appErr, isApp := domain.AsAppError(err); !isApp || appErr.Code != domain.ErrCodeNotFound {
			return SearchEngineView{}, err
		}
		cfg = domain.SearchEngineConfig{
			EngineID:   id,
			Endpoint:   engine.DefaultEndpoint(),
			MaxResults: 5,
		}
	}

	if in.Enabled != nil {
		cfg.Enabled = *in.Enabled
	}
	if ep := strings.TrimSpace(in.Endpoint); ep != "" {
		cfg.Endpoint = ep
	} else if strings.TrimSpace(cfg.Endpoint) == "" {
		cfg.Endpoint = engine.DefaultEndpoint()
	}
	if in.ClearAPIKey {
		cfg.APIKey = ""
	} else if key := strings.TrimSpace(in.APIKey); key != "" {
		cfg.APIKey = key
	}
	if in.MaxResults != nil {
		if *in.MaxResults <= 0 || *in.MaxResults > 20 {
			return SearchEngineView{}, domain.NewError(domain.ErrCodeInvalidArgument, "maxResults must be between 1 and 20", nil)
		}
		cfg.MaxResults = *in.MaxResults
	}
	if cfg.MaxResults <= 0 {
		cfg.MaxResults = 5
	}
	if in.IsDefault != nil {
		cfg.IsDefault = *in.IsDefault
	}

	saved, err := s.searchStore.Upsert(ctx, cfg)
	if err != nil {
		return SearchEngineView{}, err
	}
	return SearchEngineView{
		EngineID:        engine.ID(),
		DisplayName:     engine.DisplayName(),
		DefaultEndpoint: engine.DefaultEndpoint(),
		RequiresAPIKey:  engine.RequiresAPIKey(),
		Enabled:         saved.Enabled,
		Endpoint:        saved.Endpoint,
		APIKeyMasked:    domain.MaskAPIKey(saved.APIKey),
		APIKeySet:       strings.TrimSpace(saved.APIKey) != "",
		MaxResults:      saved.MaxResults,
		IsDefault:       saved.IsDefault,
		UpdatedAt:       saved.UpdatedAt,
	}, nil
}

// TestSearchEngine runs a live search query against the specified plugin using stored + override settings.
func (s *PluginService) TestSearchEngine(ctx context.Context, id string, in SearchEngineTestInput) (SearchEngineTestResult, error) {
	engine, ok := s.searchReg.Get(id)
	if !ok {
		return SearchEngineTestResult{}, domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("unknown search engine %q", id), nil)
	}

	cfg, err := s.searchStore.Get(ctx, id)
	if err != nil {
		if appErr, isApp := domain.AsAppError(err); !isApp || appErr.Code != domain.ErrCodeNotFound {
			return SearchEngineTestResult{}, err
		}
		cfg = domain.SearchEngineConfig{
			EngineID:   id,
			Endpoint:   engine.DefaultEndpoint(),
			MaxResults: 5,
		}
	}

	endpoint := strings.TrimSpace(in.Endpoint)
	if endpoint == "" {
		endpoint = strings.TrimSpace(cfg.Endpoint)
	}
	if endpoint == "" {
		endpoint = engine.DefaultEndpoint()
	}
	apiKey := strings.TrimSpace(in.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(cfg.APIKey)
	}
	maxRes := in.MaxResults
	if maxRes <= 0 {
		maxRes = cfg.MaxResults
	}
	if maxRes <= 0 {
		maxRes = 5
	}
	query := strings.TrimSpace(in.Query)
	if query == "" {
		query = "LLMStudio"
	}

	testCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	start := time.Now()
	results, err := engine.Search(testCtx, plugin.SearchQueryInput{
		Query:      query,
		Endpoint:   endpoint,
		APIKey:     apiKey,
		MaxResults: maxRes,
	})
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return SearchEngineTestResult{}, err
	}
	return SearchEngineTestResult{
		OK:          true,
		EngineID:    id,
		ResultCount: len(results),
		LatencyMs:   latency,
		Message:     "搜索测试正常",
		Results:     results,
	}, nil
}

// ListMCPServers returns all configured MCP servers.
func (s *PluginService) ListMCPServers(ctx context.Context) ([]domain.MCPServerConfig, error) {
	return s.mcpStore.List(ctx)
}

// CreateMCPServer validates and persists a new MCP server configuration.
func (s *PluginService) CreateMCPServer(ctx context.Context, in MCPServerInput) (domain.MCPServerConfig, error) {
	srv := domain.MCPServerConfig{
		ID:        strings.TrimSpace(in.ID),
		Name:      strings.TrimSpace(in.Name),
		Transport: strings.TrimSpace(in.Transport),
		Endpoint:  strings.TrimSpace(in.Endpoint),
		Command:   strings.TrimSpace(in.Command),
		Args:      in.Args,
		Env:       in.Env,
		Headers:   in.Headers,
		Enabled:   true,
	}
	if in.Enabled != nil {
		srv.Enabled = *in.Enabled
	}
	if err := validateMCPServer(&srv); err != nil {
		return domain.MCPServerConfig{}, err
	}
	return s.mcpStore.Create(ctx, srv)
}

// UpdateMCPServer validates and updates an existing MCP server configuration.
func (s *PluginService) UpdateMCPServer(ctx context.Context, id string, in MCPServerInput) (domain.MCPServerConfig, error) {
	existing, err := s.mcpStore.Get(ctx, id)
	if err != nil {
		return domain.MCPServerConfig{}, err
	}
	if name := strings.TrimSpace(in.Name); name != "" {
		existing.Name = name
	}
	if transport := strings.TrimSpace(in.Transport); transport != "" {
		existing.Transport = transport
	}
	if in.Endpoint != "" {
		existing.Endpoint = strings.TrimSpace(in.Endpoint)
	}
	if in.Command != "" {
		existing.Command = strings.TrimSpace(in.Command)
	}
	if in.Args != nil {
		existing.Args = in.Args
	}
	if in.Env != nil {
		existing.Env = in.Env
	}
	if in.Headers != nil {
		existing.Headers = in.Headers
	}
	if in.Enabled != nil {
		existing.Enabled = *in.Enabled
	}
	if err := validateMCPServer(&existing); err != nil {
		return domain.MCPServerConfig{}, err
	}
	updated, err := s.mcpStore.Update(ctx, existing)
	if err != nil {
		return domain.MCPServerConfig{}, err
	}
	if s.mcpClient != nil {
		_ = s.mcpClient.CloseServer(id)
	}
	return updated, nil
}

// DeleteMCPServer removes an MCP server configuration by ID.
func (s *PluginService) DeleteMCPServer(ctx context.Context, id string) error {
	if err := s.mcpStore.Delete(ctx, id); err != nil {
		return err
	}
	if s.mcpClient != nil {
		_ = s.mcpClient.CloseServer(id)
	}
	return nil
}

// ListMCPServerTools discovers tools exposed by the saved MCP server configuration.
func (s *PluginService) ListMCPServerTools(ctx context.Context, id string) ([]plugin.MCPToolDescriptor, error) {
	if s.mcpClient == nil {
		return nil, domain.NewError(domain.ErrCodeInternalError, "MCP runtime is not configured", nil)
	}
	srv, err := s.mcpStore.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	tools, err := s.mcpClient.ListTools(ctx, srv)
	if err != nil {
		return nil, err
	}
	if tools == nil {
		tools = []plugin.MCPToolDescriptor{}
	}
	return tools, nil
}

// TestMCPServer probes initialize and tools/list against the currently saved server configuration.
func (s *PluginService) TestMCPServer(ctx context.Context, id string) (MCPServerTestResult, error) {
	if s.mcpClient == nil {
		return MCPServerTestResult{}, domain.NewError(domain.ErrCodeInternalError, "MCP runtime is not configured", nil)
	}
	srv, err := s.mcpStore.Get(ctx, id)
	if err != nil {
		return MCPServerTestResult{}, err
	}

	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Force a live handshake + list probe instead of returning a cached catalog.
	_ = s.mcpClient.CloseServer(id)

	start := time.Now()
	tools, err := s.mcpClient.ListTools(probeCtx, srv)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return MCPServerTestResult{}, err
	}
	if tools == nil {
		tools = []plugin.MCPToolDescriptor{}
	}
	return MCPServerTestResult{
		OK:        true,
		ServerID:  id,
		ToolCount: len(tools),
		LatencyMs: latency,
		Message:   fmt.Sprintf("连接正常（%d 个工具）", len(tools)),
		Tools:     tools,
	}, nil
}

func validateMCPServer(srv *domain.MCPServerConfig) error {
	if srv.Name == "" {
		return domain.NewError(domain.ErrCodeInvalidArgument, "mcp server name is required", nil)
	}
	if srv.Transport == "" {
		srv.Transport = domain.MCPTransportStdio
	}
	switch srv.Transport {
	case domain.MCPTransportStdio:
		if srv.Command == "" {
			return domain.NewError(domain.ErrCodeInvalidArgument, "command is required for stdio mcp server", nil)
		}
	case domain.MCPTransportSSE, domain.MCPTransportStreamableHTTP:
		if srv.Endpoint == "" {
			return domain.NewError(domain.ErrCodeInvalidArgument, "endpoint is required for remote mcp server", nil)
		}
	default:
		return domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unsupported mcp transport %q", srv.Transport), nil)
	}
	if srv.Args == nil {
		srv.Args = []string{}
	}
	return nil
}
