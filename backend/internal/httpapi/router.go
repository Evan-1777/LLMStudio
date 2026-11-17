package httpapi

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

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
		mux.HandleFunc("PUT /api/v1/providers/{id}", ph.Update)
		mux.HandleFunc("DELETE /api/v1/providers/{id}", ph.Delete)
		mux.HandleFunc("POST /api/v1/providers/{id}/test", ph.TestConnection)
		mux.HandleFunc("POST /api/v1/providers/{id}/models/fetch", ph.FetchModels)
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
		mux.HandleFunc("GET /api/v1/conversations", ch.List)
		mux.HandleFunc("POST /api/v1/conversations", ch.Create)
		mux.HandleFunc("GET /api/v1/conversations/{id}", ch.GetDetail)
		mux.HandleFunc("PATCH /api/v1/conversations/{id}", ch.Patch)
		mux.HandleFunc("DELETE /api/v1/conversations/{id}", ch.Delete)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages", ch.CreateMessage)
		mux.HandleFunc("PATCH /api/v1/conversations/{id}/messages/{messageId}", ch.UpdateMessage)
		mux.HandleFunc("DELETE /api/v1/conversations/{id}/messages/{messageId}", ch.DeleteMessage)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages/{messageId}/branch", ch.BranchFromMessage)
	}
	if deps.PluginService != nil {
		plh := NewPluginHandler(deps.PluginService)
		mux.HandleFunc("GET /api/v1/plugins/search", plh.ListSearchEngines)
		mux.HandleFunc("PUT /api/v1/plugins/search/{id}", plh.UpdateSearchEngine)
		mux.HandleFunc("POST /api/v1/plugins/search/{id}/test", plh.TestSearchEngine)
		mux.HandleFunc("GET /api/v1/mcp/servers", plh.ListMCPServers)
		mux.HandleFunc("POST /api/v1/mcp/servers", plh.CreateMCPServer)
		mux.HandleFunc("PUT /api/v1/mcp/servers/{id}", plh.UpdateMCPServer)
		mux.HandleFunc("DELETE /api/v1/mcp/servers/{id}", plh.DeleteMCPServer)
	}
	if deps.ChatService != nil {
		chatHandler := NewChatHandler(deps.ChatService)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages/stream", chatHandler.Stream)
		mux.HandleFunc("POST /api/v1/conversations/{id}/messages/prepare-local", chatHandler.PrepareLocal)
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
