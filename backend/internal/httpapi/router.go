package httpapi

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
)

// RouterDeps bundles the dependencies required to construct the HTTP router.
type RouterDeps struct {
	Config              config.Config
	Formats             *plugin.FormatRegistry
	Adapters            *plugin.ProviderRegistry
	ProviderService     *service.ProviderService
	AssistantService    *service.AssistantService
	ConversationService *service.ConversationService
	PluginService       *service.PluginService
	ChatService         *service.ChatService
	AgentRuntime        *agent.Runtime
	PreferenceService   *service.PreferenceService
	CustomFontService   *service.CustomFontService
	StorageService      *service.StorageService
}

// NewRouter constructs the root HTTP handler with CORS, authentication, API routes, and optional static assets.
func NewRouter(deps RouterDeps) http.Handler {
	mux := http.NewServeMux()
	authRequired := AuthRequiredForConfig(deps.Config.AccessToken, deps.Config.DevMode)
	mux.HandleFunc("GET /healthz", NewHealthHandler(authRequired))

	if deps.Formats != nil {
		mux.HandleFunc("GET /api/v1/formats", HandleListFormats(deps.Formats, deps.Adapters))
	}
	if deps.ProviderService != nil {
		ph := NewProviderHandler(deps.ProviderService)
		mux.HandleFunc("GET /api/v1/providers", ph.List)
		mux.HandleFunc("POST /api/v1/providers", ph.Create)
		mux.HandleFunc("POST /api/v1/providers/reorder", ph.Reorder)
		mux.HandleFunc("GET /api/v1/providers/{id}/credential", ph.GetCredential)
		mux.HandleFunc("PUT /api/v1/providers/{id}", ph.Update)
		mux.HandleFunc("DELETE /api/v1/providers/{id}", ph.Delete)
		mux.HandleFunc("POST /api/v1/providers/{id}/test", ph.TestConnection)
		mux.HandleFunc("POST /api/v1/providers/{id}/models/fetch", ph.FetchModels)
		mux.HandleFunc("POST /api/v1/providers/{id}/models/prepare-local", ph.PrepareLocalModels)
		mux.HandleFunc("POST /api/v1/providers/{id}/keys/import", ph.ImportAPIKey)
	}
	if deps.AssistantService != nil {
		ah := NewAssistantHandler(deps.AssistantService)
		mux.HandleFunc("GET /api/v1/assistants", ah.List)
		mux.HandleFunc("POST /api/v1/assistants", ah.Create)
		mux.HandleFunc("PUT /api/v1/assistants/{id}", ah.Update)
		mux.HandleFunc("DELETE /api/v1/assistants/{id}", ah.Delete)
	}
	if deps.ConversationService != nil {
		ch := NewConversationHandler(deps.ConversationService)
		mux.HandleFunc("GET /api/v1/conversation-groups", ch.ListGroups)
		mux.HandleFunc("POST /api/v1/conversation-groups", ch.CreateGroup)
		mux.HandleFunc("POST /api/v1/conversation-groups/reorder", ch.ReorderGroups)
		mux.HandleFunc("PATCH /api/v1/conversation-groups/{id}", ch.RenameGroup)
		mux.HandleFunc("DELETE /api/v1/conversation-groups/{id}", ch.DeleteGroup)
		mux.HandleFunc("GET /api/v1/conversations", ch.List)
		mux.HandleFunc("POST /api/v1/conversations", ch.Create)
		mux.HandleFunc("POST /api/v1/conversations/import", ch.Import)
		mux.HandleFunc("POST /api/v1/conversations/batch", ch.Batch)
		mux.HandleFunc("POST /api/v1/conversations/cleanup-ungrouped", ch.CleanupUngrouped)
		mux.HandleFunc("POST /api/v1/conversations/reorder", ch.Reorder)
		mux.HandleFunc("GET /api/v1/conversations/{id}", ch.GetDetail)
		mux.HandleFunc("PATCH /api/v1/conversations/{id}", ch.Patch)
		mux.HandleFunc("PATCH /api/v1/conversations/{id}/graph", ch.MutateGraph)
		mux.HandleFunc("DELETE /api/v1/conversations/{id}", ch.Delete)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages", ch.CreateMessage)
		mux.HandleFunc("PATCH /api/v1/conversations/{id}/messages/{messageId}", ch.UpdateMessage)
		mux.HandleFunc("DELETE /api/v1/conversations/{id}/messages/{messageId}", ch.DeleteMessage)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages/{messageId}/branch", ch.BranchFromMessage)
	}
	if deps.PluginService != nil {
		plh := NewPluginHandler(deps.PluginService).WithChatService(deps.ChatService)
		mux.HandleFunc("GET /api/v1/plugins/search", plh.ListSearchEngines)
		mux.HandleFunc("GET /api/v1/plugins/search/{id}/credential", plh.GetSearchEngineCredential)
		mux.HandleFunc("PUT /api/v1/plugins/search/{id}", plh.UpdateSearchEngine)
		mux.HandleFunc("POST /api/v1/plugins/search/{id}/test", plh.TestSearchEngine)
		mux.HandleFunc("GET /api/v1/mcp/servers", plh.ListMCPServers)
		mux.HandleFunc("POST /api/v1/mcp/servers", plh.CreateMCPServer)
		mux.HandleFunc("PUT /api/v1/mcp/servers/{id}", plh.UpdateMCPServer)
		mux.HandleFunc("DELETE /api/v1/mcp/servers/{id}", plh.DeleteMCPServer)
		mux.HandleFunc("GET /api/v1/mcp/servers/{id}/tools", plh.ListMCPServerTools)
		mux.HandleFunc("POST /api/v1/mcp/servers/{id}/test", plh.TestMCPServer)
		mux.HandleFunc("POST /api/v1/mcp/tools/execute", plh.ExecuteMCPTools)
	}
	if deps.PreferenceService != nil {
		prefHandler := NewPreferenceHandler(deps.PreferenceService)
		mux.HandleFunc("GET /api/v1/settings", prefHandler.Get)
		mux.HandleFunc("PATCH /api/v1/settings", prefHandler.Patch)
		mux.HandleFunc("POST /api/v1/settings/import", prefHandler.ImportOnce)
	}
	if deps.CustomFontService != nil {
		fontHandler := NewCustomFontHandler(deps.CustomFontService)
		mux.HandleFunc("GET /api/v1/settings/custom-font", fontHandler.Get)
		mux.HandleFunc("PUT /api/v1/settings/custom-font", fontHandler.Put)
		mux.HandleFunc("PATCH /api/v1/settings/custom-font", fontHandler.Patch)
		mux.HandleFunc("DELETE /api/v1/settings/custom-font", fontHandler.Delete)
		mux.HandleFunc("GET /api/v1/settings/custom-font/file", fontHandler.GetFile)
	}
	if deps.StorageService != nil {
		sh := NewStorageHandler(deps.StorageService)
		mux.HandleFunc("GET /api/v1/storage", sh.Get)
		mux.HandleFunc("POST /api/v1/storage/compact", sh.Compact)
	}
	if deps.AgentRuntime != nil {
		RegisterAgentRoutes(mux, deps.AgentRuntime, nil)
	}
	if deps.ChatService != nil {
		chatHandler := NewChatHandler(deps.ChatService)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages/stream", chatHandler.Stream)
		mux.HandleFunc("GET /api/v1/conversations/{id}/run/stream", chatHandler.AttachRunStream)
		mux.HandleFunc("POST /api/v1/conversations/{id}/run/cancel", chatHandler.CancelRun)
		mux.HandleFunc("GET /api/v1/agent/runs", chatHandler.ListActiveRuns)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages/prepare-local", chatHandler.PrepareLocal)
		mux.HandleFunc("POST /api/v1/conversations/{id}/compact", chatHandler.Compact)
		mux.HandleFunc("POST /api/v1/conversations/{id}/compact/prepare-local", chatHandler.PrepareLocalCompact)
		mux.HandleFunc("POST /api/v1/conversations/{id}/tools/execute", chatHandler.ExecuteTools)
	}

	if deps.Config.StaticDir != "" {
		mux.Handle("/", spaStaticHandler(deps.Config.StaticDir))
	}

	return CORSMiddleware(
		deps.Config.CORSOrigins,
		AuthMiddleware(deps.Config.AccessToken, deps.Config.DevMode, mux),
	)
}

func spaStaticHandler(staticDir string) http.Handler {
	absRoot, err := filepath.Abs(staticDir)
	if err != nil {
		absRoot = filepath.Clean(staticDir)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
			WriteError(w, http.StatusNotFound, "NOT_FOUND", "endpoint not found")
			return
		}
		cleanRel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleanRel == "" {
			cleanRel = "index.html"
		}
		target := filepath.Join(absRoot, filepath.FromSlash(cleanRel))
		if info, statErr := os.Stat(target); statErr == nil && !info.IsDir() {
			http.ServeFile(w, r, target)
			return
		}
		indexFile := filepath.Join(absRoot, "index.html")
		if _, statErr := os.Stat(indexFile); statErr == nil {
			http.ServeFile(w, r, indexFile)
			return
		}
		http.NotFound(w, r)
	})
}
