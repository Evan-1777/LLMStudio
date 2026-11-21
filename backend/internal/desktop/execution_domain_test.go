package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

type stubLocalMCPClient struct {
	mu      sync.Mutex
	toolsBy map[string][]plugin.MCPToolDescriptor
	calls   []string
}

func (s *stubLocalMCPClient) ID() string { return "stub-local-mcp" }
func (s *stubLocalMCPClient) ListTools(_ context.Context, srv domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.toolsBy[srv.ID]), nil
}
func (s *stubLocalMCPClient) CallTool(_ context.Context, srv domain.MCPServerConfig, name string, args json.RawMessage) (plugin.MCPCallToolResult, error) {
	s.mu.Lock()
	s.calls = append(s.calls, srv.ID+":"+name+":"+string(args))
	s.mu.Unlock()
	return plugin.MCPCallToolResult{
		Content: []plugin.MCPToolContent{{Type: "text", Text: "local-res:" + srv.ID + ":" + name}},
	}, nil
}
func (s *stubLocalMCPClient) CloseServer(string) error { return nil }
func (s *stubLocalMCPClient) Close() error             { return nil }

func TestDualDomainMCPAliasStabilityAndRouting(t *testing.T) {
	ctx := context.Background()

	// Cloud DB + router hosting cloud MCP server list and stateless /mcp/tools/execute.
	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open cloud db: %v", err)
	}
	defer cloudDB.Close()

	cloudMCPStore := store.NewMCPServerStore(cloudDB)
	longToolName := "123.very/long.tool." + strings.Repeat("x", 70)
	// Same serverID ("shared-srv") and same toolName ("lookup") exist on BOTH local and cloud.
	if _, err := cloudMCPStore.Create(ctx, domain.MCPServerConfig{
		ID:        "shared-srv",
		Name:      "Cloud Shared",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  "http://unused.local/mcp",
		Enabled:   true,
	}); err != nil {
		t.Fatalf("create cloud mcp server: %v", err)
	}

	var cloudCalled []string
	cloudMCPStub := &stubLocalMCPClient{
		toolsBy: map[string][]plugin.MCPToolDescriptor{
			"shared-srv": {
				{Name: "lookup", Description: "Cloud lookup", InputSchema: json.RawMessage(`{"type":"object"}`)},
				{Name: longToolName, Description: "Long tool", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
		},
	}

	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:        config.Config{AccessToken: "mcp-tok", DevMode: false},
		PluginService: service.NewPluginService(plugin.NewSearchRegistry(), store.NewSearchConfigStore(cloudDB), cloudMCPStore).WithMCPClient(cloudMCPStub),
	})
	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/mcp/tools/execute" {
			cloudCalled = append(cloudCalled, r.URL.Path)
		}
		cloudRouter.ServeHTTP(w, r)
	}))
	defer cloudSrv.Close()

	// Local desktop store with identical serverID "shared-srv" and tool "lookup".
	localStore, err := OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "local.db"))
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()
	if _, err := localStore.MCPs.Create(ctx, domain.MCPServerConfig{
		ID:        "shared-srv",
		Name:      "Local Shared",
		Transport: domain.MCPTransportStdio,
		Command:   "echo",
		Enabled:   true,
	}); err != nil {
		t.Fatalf("create local mcp server: %v", err)
	}
	localMCPStub := &stubLocalMCPClient{
		toolsBy: map[string][]plugin.MCPToolDescriptor{
			"shared-srv": {
				{Name: "lookup", Description: "Local lookup", InputSchema: json.RawMessage(`{"type":"object"}`)},
				{Name: longToolName, Description: "Local long", InputSchema: json.RawMessage(`{"type":"object"}`)},
			},
		},
	}

	cloud := NewCloudClient(cloudSrv.URL, "mcp-tok")
	composite := NewCompositeToolRuntime(localStore.MCPs, localMCPStub, cloud)

	// Verify deterministic alias computation independent of discovery order.
	entries, err := composite.ListScoped(ctx)
	if err != nil || len(entries) != 2 {
		t.Fatalf("ListScoped expected 2 entries, got %+v err=%v", entries, err)
	}
	if entries[0].Scope != plugin.ExecutionScopeCloud || entries[1].Scope != plugin.ExecutionScopeLocal {
		t.Fatalf("expected deterministic (cloud, local) ordering, got %+v", entries)
	}

	aliasRegex := regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`)
	used := make(map[string]struct{})
	var localLookupAlias, cloudLookupAlias string
	for _, entry := range entries {
		descs, err := composite.ListScopedTools(ctx, entry.Scope, entry.Server)
		if err != nil {
			t.Fatalf("ListScopedTools(%s): %v", entry.Scope, err)
		}
		for _, d := range descs {
			alias := plugin.BuildChatToolAlias(string(entry.Scope)+"\x00"+entry.Server.ID, d.Name, used)
			if !aliasRegex.MatchString(alias) {
				t.Fatalf("alias %q violates identifier/length constraints", alias)
			}
			if d.Name == "lookup" {
				if entry.Scope == plugin.ExecutionScopeLocal {
					localLookupAlias = alias
				} else {
					cloudLookupAlias = alias
				}
			}
		}
	}
	if localLookupAlias == "" || cloudLookupAlias == "" || localLookupAlias == cloudLookupAlias {
		t.Fatalf("expected distinct aliases for local=%q and cloud=%q", localLookupAlias, cloudLookupAlias)
	}
	if len(used) != 4 {
		t.Fatalf("expected 4 collision-free aliases, got %d (%v)", len(used), used)
	}

	// Full multi-round ChatService execution routing local vs cloud tools cleanly.
	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	turn := 0
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		turn++
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		if turn == 1 {
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_local\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"k\\\":1}\"}},{\"index\":1,\"id\":\"tc_cloud\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"k\\\":2}\"}}]}}]}\n\n", localLookupAlias, cloudLookupAlias)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		} else {
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Combined tools complete\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		}
		flusher.Flush()
	}))
	defer llmSrv.Close()

	if err := localStore.SaveCachedProviderConfigs(ctx, []domain.ProviderConfig{
		{
			ID:       "p-local",
			Name:     "Mock",
			Adapter:  provider.AdapterGenericHTTP,
			BaseURL:  llmSrv.URL,
			AuthType: domain.AuthTypeNone,
			Enabled:  true,
			Models:   []domain.ModelConfig{{ID: "m1", Name: "M1", APIFormat: format.FormatIDOpenAICompletions}},
		},
	}); err != nil {
		t.Fatalf("SaveCachedProviderConfigs: %v", err)
	}
	conv, err := localStore.Conversations.Create(ctx, domain.Conversation{
		ID:          "conv-dual-mcp",
		AssistantID: domain.DefaultAssistantID,
		Title:       "Dual MCP",
		ProviderID:  "p-local",
		ModelID:     "m1",
	})
	if err != nil {
		t.Fatalf("create local conv: %v", err)
	}

	engine := NewDesktopChatEngine(localStore, cloud, NewMemoryCredentialCache(cloud), formats, adapters, nil, composite, &http.Client{})
	prep, err := engine.Prepare(ctx, plugin.ExecutionScopeLocal, service.StreamChatInput{
		ConversationID: conv.ID,
		Text:           "run both tools",
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream: %v", err)
	}

	msgs, err := localStore.Messages.ListByConversation(ctx, conv.ID)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("expected 2 persisted messages, got %+v err=%v", msgs, err)
	}
	asst := msgs[1]
	var results []string
	for _, b := range asst.Blocks {
		if b.Type == domain.BlockTypeToolResult {
			results = append(results, b.Content)
		}
	}
	if len(results) != 2 || len(localMCPStub.calls) != 1 || len(cloudMCPStub.calls) != 1 || len(cloudCalled) != 1 {
		t.Fatalf("unexpected routing results: results=%v localCalls=%v cloudCalls=%v cloudHTTP=%v", results, localMCPStub.calls, cloudMCPStub.calls, cloudCalled)
	}
}

func TestCompositeToolRuntimeCloudCacheAndInvalidation(t *testing.T) {
	ctx := context.Background()

	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open cloud db: %v", err)
	}
	defer cloudDB.Close()

	cloudMCPStore := store.NewMCPServerStore(cloudDB)
	srvCfg, err := cloudMCPStore.Create(ctx, domain.MCPServerConfig{
		ID:        "cloud-srv-1",
		Name:      "Cloud Cached",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  "http://unused.local/mcp",
		Enabled:   true,
	})
	if err != nil {
		t.Fatalf("create cloud mcp server: %v", err)
	}

	cloudMCPStub := &stubLocalMCPClient{
		toolsBy: map[string][]plugin.MCPToolDescriptor{
			"cloud-srv-1": {{Name: "ping", Description: "Ping", InputSchema: json.RawMessage(`{"type":"object"}`)}},
		},
	}

	var listServersHits, listToolsHits atomic.Int32
	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:        config.Config{AccessToken: "mcp-tok", DevMode: false},
		PluginService: service.NewPluginService(plugin.NewSearchRegistry(), store.NewSearchConfigStore(cloudDB), cloudMCPStore).WithMCPClient(cloudMCPStub),
	})
	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/mcp/servers":
			listServersHits.Add(1)
		case "/api/v1/mcp/servers/cloud-srv-1/tools":
			listToolsHits.Add(1)
		}
		cloudRouter.ServeHTTP(w, r)
	}))
	defer cloudSrv.Close()

	localStore, err := OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "local.db"))
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()

	cloud := NewCloudClient(cloudSrv.URL, "mcp-tok")
	composite := NewCompositeToolRuntime(localStore.MCPs, &stubLocalMCPClient{}, cloud)

	now := time.Now()
	composite.nowFn = func() time.Time { return now }

	// First discovery hits cloud once for servers and once for tools.
	entries, err := composite.ListScoped(ctx)
	if err != nil || len(entries) != 1 {
		t.Fatalf("ListScoped: entries=%+v err=%v", entries, err)
	}
	if _, err := composite.ListScopedTools(ctx, plugin.ExecutionScopeCloud, entries[0].Server); err != nil {
		t.Fatalf("ListScopedTools: %v", err)
	}
	if listServersHits.Load() != 1 || listToolsHits.Load() != 1 {
		t.Fatalf("expected 1/1 initial cloud hits, got servers=%d tools=%d", listServersHits.Load(), listToolsHits.Load())
	}

	// Subsequent calls within TTL hit cache with 0 cloud requests.
	if _, err := composite.ListScoped(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := composite.GetScoped(ctx, plugin.ExecutionScopeCloud, srvCfg.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := composite.ListScopedTools(ctx, plugin.ExecutionScopeCloud, entries[0].Server); err != nil {
		t.Fatal(err)
	}
	if listServersHits.Load() != 1 || listToolsHits.Load() != 1 {
		t.Fatalf("expected zero additional cloud hits within TTL, got servers=%d tools=%d", listServersHits.Load(), listToolsHits.Load())
	}

	// UpdatedAt change forces tool catalog re-fetch even inside TTL.
	updatedSrv := entries[0].Server
	updatedSrv.UpdatedAt = updatedSrv.UpdatedAt.Add(time.Second)
	if _, err := composite.ListScopedTools(ctx, plugin.ExecutionScopeCloud, updatedSrv); err != nil {
		t.Fatal(err)
	}
	if listToolsHits.Load() != 2 {
		t.Fatalf("expected UpdatedAt change to invalidate tools cache, got tools=%d", listToolsHits.Load())
	}

	// InvalidateCloudCache or connection change invalidates both server list and tools.
	composite.InvalidateCloudCache()
	if _, err := composite.ListScoped(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := composite.ListScopedTools(ctx, plugin.ExecutionScopeCloud, updatedSrv); err != nil {
		t.Fatal(err)
	}
	if listServersHits.Load() != 2 || listToolsHits.Load() != 3 {
		t.Fatalf("expected re-fetch after InvalidateCloudCache, got servers=%d tools=%d", listServersHits.Load(), listToolsHits.Load())
	}

	// Connection switch isolates cache to the new connection.
	cloud.SetCredentials(cloudSrv.URL, "mcp-tok-2")
	if _, err := composite.ListScoped(ctx); err != nil {
		t.Fatal(err)
	}
	if listServersHits.Load() != 3 {
		t.Fatalf("expected SetCredentials to isolate cache, got servers=%d", listServersHits.Load())
	}
}
