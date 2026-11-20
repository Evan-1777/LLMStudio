package desktop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
)

const defaultDesktopVersion = "1.5.0"

// ServerConfig supplies the dependencies required to construct the desktop loopback facade.
type ServerConfig struct {
	Paths          StoragePaths
	Store          *DesktopStore
	Cloud          *CloudClient
	CredCache      *MemoryCredentialCache
	Formats        *plugin.FormatRegistry
	Adapters       *plugin.ProviderRegistry
	SearchReg      *plugin.SearchRegistry
	LocalMCPClient plugin.MCPClientBoundary
	CompositeTools *CompositeToolRuntime
	ChatEngine     *DesktopChatEngine
	SyncService    *SyncService
	DevMode        bool
	Version        string
}

// DesktopStatus describes the current runtime mode, storage location, and cloud connection health.
type DesktopStatus struct {
	Mode            DataMode `json:"mode"`
	DataDir         string   `json:"dataDir"`
	DBPath          string   `json:"dbPath"`
	CloudConfigured bool     `json:"cloudConfigured"`
	CloudState      string   `json:"cloudState"`
	GatewayBaseURL  string   `json:"gatewayBaseUrl"`
	TokenSet        bool     `json:"tokenSet"`
	AuthRequired    bool     `json:"authRequired"`
	Version         string   `json:"version"`
}

// Server serves the token-protected local loopback HTTP/SSE facade for the MyGo webview.
type Server struct {
	cfg          ServerConfig
	sessionToken string
	tokenHash    [32]byte
	handler      http.Handler

	localConvSvc     *service.ConversationService
	localConvHandler *httpapi.ConversationHandler
	localPluginSvc   *service.PluginService
	localPluginH     *httpapi.PluginHandler
	localPrefSvc     *service.PreferenceService
	localPrefH       *httpapi.PreferenceHandler

	mu       sync.Mutex
	listener net.Listener
	httpSrv  *http.Server
	baseURL  string
}

// NewServer constructs a desktop loopback server with a freshly generated 32-byte hex session token.
func NewServer(cfg ServerConfig) (*Server, error) {
	rawToken := make([]byte, 32)
	if _, err := rand.Read(rawToken); err != nil {
		return nil, fmt.Errorf("generate desktop session token: %w", err)
	}
	token := hex.EncodeToString(rawToken)
	if strings.TrimSpace(cfg.Version) == "" {
		cfg.Version = defaultDesktopVersion
	}

	localConvSvc := service.NewConversationService(cfg.Store.Conversations, cfg.Store.Messages).
		WithAssistants(cfg.Store.Assistants)
	localPluginSvc := service.NewPluginService(cfg.SearchReg, cfg.Store.Searches, cfg.Store.MCPs).
		WithMCPClient(cfg.LocalMCPClient)
	localPrefSvc := service.NewPreferenceService(cfg.Store.Preferences)

	s := &Server{
		cfg:              cfg,
		sessionToken:     token,
		tokenHash:        sha256.Sum256([]byte(token)),
		localConvSvc:     localConvSvc,
		localConvHandler: httpapi.NewConversationHandler(localConvSvc),
		localPluginSvc:   localPluginSvc,
		localPluginH:     httpapi.NewPluginHandler(localPluginSvc),
		localPrefSvc:     localPrefSvc,
		localPrefH:       httpapi.NewPreferenceHandler(localPrefSvc),
	}
	s.handler = s.buildHandler()
	return s, nil
}

// Token returns the random per-process Bearer session token required by all requests.
func (s *Server) Token() string {
	return s.sessionToken
}

// Handler returns the middleware-wrapped HTTP handler for tests or embedding.
func (s *Server) Handler() http.Handler {
	return s.handler
}

// BaseURL returns the bound loopback base URL once ListenAndServe has started.
func (s *Server) BaseURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.baseURL
}

// ListenAndServe binds 127.0.0.1:0 and begins serving requests in a background goroutine.
func (s *Server) ListenAndServe() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen desktop loopback: %w", err)
	}
	srv := &http.Server{
		Handler:           s.handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	s.mu.Lock()
	s.listener = ln
	s.httpSrv = srv
	s.baseURL = "http://" + ln.Addr().String()
	s.mu.Unlock()

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Server closed unexpectedly; caller cleans up on shutdown.
		}
	}()
	return nil
}

// Shutdown gracefully stops the loopback HTTP server.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	srv := s.httpSrv
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

func (s *Server) buildHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"authRequired": true,
		})
	})

	if s.cfg.Formats != nil {
		mux.HandleFunc("GET /api/v1/formats", httpapi.HandleListFormats(s.cfg.Formats, s.cfg.Adapters))
	}

	// Providers: online cloud read/write with redacted local cache fallback.
	mux.HandleFunc("GET /api/v1/providers", s.handleListProviders)
	mux.HandleFunc("POST /api/v1/providers", s.handleCreateProvider)
	mux.HandleFunc("POST /api/v1/providers/reorder", s.handleReorderProviders)
	mux.HandleFunc("PUT /api/v1/providers/{id}", s.handleUpdateProvider)
	mux.HandleFunc("DELETE /api/v1/providers/{id}", s.handleDeleteProvider)
	mux.HandleFunc("POST /api/v1/providers/{id}/test", s.handleTestProvider)
	mux.HandleFunc("POST /api/v1/providers/{id}/models/fetch", s.handleFetchProviderModels)
	mux.HandleFunc("POST /api/v1/providers/{id}/keys/import", s.handleImportProviderKey)

	// Assistants: online cloud read/write mirrored into local assistants table.
	mux.HandleFunc("GET /api/v1/assistants", s.handleListAssistants)
	mux.HandleFunc("POST /api/v1/assistants", s.handleCreateAssistant)
	mux.HandleFunc("PUT /api/v1/assistants/{id}", s.handleUpdateAssistant)
	mux.HandleFunc("DELETE /api/v1/assistants/{id}", s.handleDeleteAssistant)

	// Preferences: online cloud read/write with cache/local fallback.
	mux.HandleFunc("GET /api/v1/settings", s.handleGetSettings)
	mux.HandleFunc("PATCH /api/v1/settings", s.handlePatchSettings)
	mux.HandleFunc("POST /api/v1/settings/import", s.handleImportSettings)

	// Search plugins: online cloud read/write with cache fallback.
	mux.HandleFunc("GET /api/v1/plugins/search", s.handleListSearchEngines)
	mux.HandleFunc("PUT /api/v1/plugins/search/{id}", s.handleUpdateSearchEngine)
	mux.HandleFunc("POST /api/v1/plugins/search/{id}/test", s.handleTestSearchEngine)

	// MCP servers: dispatched by ?scope=local|cloud (default local).
	mux.HandleFunc("GET /api/v1/mcp/servers", s.handleListMCPServers)
	mux.HandleFunc("POST /api/v1/mcp/servers", s.handleCreateMCPServer)
	mux.HandleFunc("PUT /api/v1/mcp/servers/{id}", s.handleUpdateMCPServer)
	mux.HandleFunc("DELETE /api/v1/mcp/servers/{id}", s.handleDeleteMCPServer)
	mux.HandleFunc("GET /api/v1/mcp/servers/{id}/tools", s.handleListMCPServerTools)
	mux.HandleFunc("POST /api/v1/mcp/servers/{id}/test", s.handleTestMCPServer)

	// Conversation groups & conversations: dispatched by ?scope=local|cloud (default local).
	mux.HandleFunc("GET /api/v1/conversation-groups", s.handleListGroups)
	mux.HandleFunc("POST /api/v1/conversation-groups", s.handleCreateGroup)
	mux.HandleFunc("POST /api/v1/conversation-groups/reorder", s.handleReorderGroups)
	mux.HandleFunc("PATCH /api/v1/conversation-groups/{id}", s.handleRenameGroup)
	mux.HandleFunc("DELETE /api/v1/conversation-groups/{id}", s.handleDeleteGroup)

	mux.HandleFunc("GET /api/v1/conversations", s.handleListConversations)
	mux.HandleFunc("POST /api/v1/conversations", s.handleCreateConversation)
	mux.HandleFunc("POST /api/v1/conversations/batch", s.handleBatchConversations)
	mux.HandleFunc("POST /api/v1/conversations/cleanup-ungrouped", s.handleCleanupUngrouped)
	mux.HandleFunc("POST /api/v1/conversations/reorder", s.handleReorderConversations)
	mux.HandleFunc("GET /api/v1/conversations/{id}", s.handleGetConversation)
	mux.HandleFunc("PATCH /api/v1/conversations/{id}", s.handlePatchConversation)
	mux.HandleFunc("DELETE /api/v1/conversations/{id}", s.handleDeleteConversation)
	mux.HandleFunc("POST /api/v1/conversations/{id}/messages", s.handleCreateMessage)
	mux.HandleFunc("PATCH /api/v1/conversations/{id}/messages/{messageId}", s.handleUpdateMessage)
	mux.HandleFunc("DELETE /api/v1/conversations/{id}/messages/{messageId}", s.handleDeleteMessage)
	mux.HandleFunc("POST /api/v1/conversations/{id}/messages/{messageId}/branch", s.handleBranchConversation)

	// Local-first chat streaming, compaction, and MCP tool execution for both domains.
	mux.HandleFunc("POST /api/v1/conversations/{id}/messages/stream", s.handleChatStream)
	mux.HandleFunc("POST /api/v1/conversations/{id}/compact", s.handleChatCompact)
	mux.HandleFunc("POST /api/v1/conversations/{id}/tools/execute", s.handleChatExecuteTools)

	// Cloud storage endpoints.
	mux.HandleFunc("GET /api/v1/storage", s.handleCloudStorage)
	mux.HandleFunc("POST /api/v1/storage/compact", s.handleCloudStorageCompact)

	// Desktop-exclusive endpoints.
	mux.HandleFunc("GET /api/v1/desktop/status", s.handleDesktopStatus)
	mux.HandleFunc("GET /api/v1/desktop/connection", s.handleGetDesktopConnection)
	mux.HandleFunc("PUT /api/v1/desktop/connection", s.handleSaveDesktopConnection)
	mux.HandleFunc("DELETE /api/v1/desktop/connection", s.handleDeleteDesktopConnection)
	mux.HandleFunc("POST /api/v1/desktop/connection/test", s.handleTestDesktopConnection)
	mux.HandleFunc("POST /api/v1/desktop/conversations/{id}/upload", s.handleUploadConversation)
	mux.HandleFunc("POST /api/v1/desktop/conversations/{id}/pull", s.handlePullConversation)
	mux.HandleFunc("POST /api/v1/desktop/conversations/batch-transfer", s.handleBatchTransfer)
	mux.HandleFunc("GET /api/v1/desktop/storage", s.handleDesktopStorage)
	mux.HandleFunc("POST /api/v1/desktop/storage/compact", s.handleCompactLocalStorage)
	mux.HandleFunc("POST /api/v1/desktop/storage/cleanup-ungrouped", s.handleCleanupLocalUngrouped)
	mux.HandleFunc("POST /api/v1/desktop/storage/clear-cache", s.handleClearLocalCache)

	allowedOrigins := []string{"http://mygo.localhost", "mygo://localhost"}
	if s.cfg.DevMode {
		allowedOrigins = append(allowedOrigins, "http://localhost:5173")
	}
	return s.corsMiddleware(allowedOrigins, s.bearerAuthMiddleware(mux))
}

func (s *Server) corsMiddleware(allowedOrigins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && slices.Contains(allowedOrigins, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) bearerAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		header := r.Header.Get("Authorization")
		if len(header) < 7 || !strings.EqualFold(header[:7], "Bearer ") {
			httpapi.WriteError(w, http.StatusUnauthorized, domain.ErrCodeUnauthorized, "missing or invalid bearer token")
			return
		}
		token := strings.TrimSpace(header[7:])
		if token == "" {
			httpapi.WriteError(w, http.StatusUnauthorized, domain.ErrCodeUnauthorized, "missing or invalid bearer token")
			return
		}
		actualHash := sha256.Sum256([]byte(token))
		if subtle.ConstantTimeCompare(actualHash[:], s.tokenHash[:]) != 1 {
			httpapi.WriteError(w, http.StatusUnauthorized, domain.ErrCodeUnauthorized, "invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func scopeFromRequest(r *http.Request) (plugin.ExecutionScope, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("scope"))
	if raw == "" {
		return plugin.ExecutionScopeLocal, nil
	}
	scope := plugin.ExecutionScope(raw)
	if !plugin.ValidExecutionScope(scope) {
		return "", domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("invalid scope %q", raw), nil)
	}
	return scope, nil
}

func writeDesktopError(w http.ResponseWriter, err error) {
	if appErr, ok := domain.AsAppError(err); ok {
		httpapi.WriteError(w, appErr.HTTPStatus(), appErr.Code, appErr.Message)
		return
	}
	httpapi.WriteError(w, http.StatusInternalServerError, domain.ErrCodeInternalError, err.Error())
}

func readRawBody(r *http.Request, limit int64) (json.RawMessage, error) {
	if r.Body == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, limit))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "read request body failed", err)
	}
	return json.RawMessage(data), nil
}

func writeRawJSON(w http.ResponseWriter, status int, raw json.RawMessage) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func (s *Server) requireCloud(w http.ResponseWriter) bool {
	if s.cfg.Cloud == nil || !s.cfg.Cloud.IsConfigured() {
		httpapi.WriteError(w, http.StatusUnauthorized, domain.ErrCodeUnauthorized, "cloud gateway is not connected")
		return false
	}
	return true
}

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		if providers, err := s.cfg.Cloud.ListProviders(r.Context()); err == nil {
			_ = s.cfg.Store.SaveCachedProviders(r.Context(), providers)
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"providers": providers})
			return
		}
	}
	cached, err := s.cfg.Store.LoadCachedProviders(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"providers": cached})
}

func (s *Server) refreshProvidersCache(ctx context.Context) {
	if s.cfg.Cloud == nil || !s.cfg.Cloud.IsConfigured() {
		return
	}
	if list, err := s.cfg.Cloud.ListProviders(ctx); err == nil {
		_ = s.cfg.Store.SaveCachedProviders(ctx, list)
	}
}

func (s *Server) handleCreateProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.CreateProvider(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	s.refreshProvidersCache(r.Context())
	writeRawJSON(w, http.StatusCreated, raw)
}

func (s *Server) handleReorderProviders(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.ReorderProviders(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	s.refreshProvidersCache(r.Context())
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	id := r.PathValue("id")
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.UpdateProvider(r.Context(), id, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if s.cfg.CredCache != nil {
		s.cfg.CredCache.InvalidateProvider(id)
	}
	s.refreshProvidersCache(r.Context())
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	id := r.PathValue("id")
	if err := s.cfg.Cloud.DeleteProvider(r.Context(), id); err != nil {
		writeDesktopError(w, err)
		return
	}
	if s.cfg.CredCache != nil {
		s.cfg.CredCache.InvalidateProvider(id)
	}
	s.refreshProvidersCache(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTestProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.TestProvider(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleFetchProviderModels(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.FetchProviderModels(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleImportProviderKey(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	id := r.PathValue("id")
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.ImportProviderKey(r.Context(), id, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if s.cfg.CredCache != nil {
		s.cfg.CredCache.InvalidateProvider(id)
	}
	s.refreshProvidersCache(r.Context())
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleListAssistants(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		if items, err := s.cfg.Cloud.ListAssistants(r.Context()); err == nil {
			_ = s.cfg.Store.SyncCloudAssistants(r.Context(), items)
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"assistants": items})
			return
		}
	}
	items, err := s.cfg.Store.Assistants.List(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"assistants": items})
}

func (s *Server) handleCreateAssistant(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	created, err := s.cfg.Cloud.CreateAssistant(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	_ = s.cfg.Store.SyncCloudAssistants(r.Context(), []domain.Assistant{created})
	httpapi.WriteJSON(w, http.StatusCreated, map[string]any{"assistant": created})
}

func (s *Server) handleUpdateAssistant(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	updated, err := s.cfg.Cloud.UpdateAssistant(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	_ = s.cfg.Store.SyncCloudAssistants(r.Context(), []domain.Assistant{updated})
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"assistant": updated})
}

func (s *Server) handleDeleteAssistant(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	if err := s.cfg.Cloud.DeleteAssistant(r.Context(), r.PathValue("id")); err != nil {
		writeDesktopError(w, err)
		return
	}
	if items, err := s.cfg.Cloud.ListAssistants(r.Context()); err == nil {
		_ = s.cfg.Store.SyncCloudAssistants(r.Context(), items)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		if prefs, initialized, err := s.cfg.Cloud.GetSettings(r.Context()); err == nil {
			_ = s.cfg.Store.SaveCachedPreferences(r.Context(), prefs)
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"preferences": prefs,
				"initialized": initialized,
			})
			return
		}
	}
	if prefs, ok, err := s.cfg.Store.LoadCachedPreferences(r.Context()); err == nil && ok {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"preferences": prefs,
			"initialized": true,
		})
		return
	}
	s.localPrefH.Get(w, r)
}

func (s *Server) handlePatchSettings(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		body, err := readRawBody(r, 16*1024*1024)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		raw, err := s.cfg.Cloud.PatchSettings(r.Context(), body)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		var env struct {
			Preferences domain.Preferences `json:"preferences"`
		}
		if json.Unmarshal(raw, &env) == nil {
			_ = s.cfg.Store.SaveCachedPreferences(r.Context(), env.Preferences)
		}
		writeRawJSON(w, http.StatusOK, raw)
		return
	}
	s.localPrefH.Patch(w, r)
}

func (s *Server) handleImportSettings(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		body, err := readRawBody(r, 16*1024*1024)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		raw, err := s.cfg.Cloud.ImportSettingsOnce(r.Context(), body)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		var env struct {
			Preferences domain.Preferences `json:"preferences"`
		}
		if json.Unmarshal(raw, &env) == nil {
			_ = s.cfg.Store.SaveCachedPreferences(r.Context(), env.Preferences)
		}
		writeRawJSON(w, http.StatusOK, raw)
		return
	}
	s.localPrefH.ImportOnce(w, r)
}

func (s *Server) handleListSearchEngines(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		if engines, err := s.cfg.Cloud.ListSearchEngines(r.Context()); err == nil {
			_ = s.cfg.Store.SaveCachedSearchEngines(r.Context(), engines)
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"engines": engines})
			return
		}
	}
	if cached, err := s.cfg.Store.LoadCachedSearchEngines(r.Context()); err == nil && len(cached) > 0 {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"engines": cached})
		return
	}
	s.localPluginH.ListSearchEngines(w, r)
}

func (s *Server) handleUpdateSearchEngine(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	id := r.PathValue("id")
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.UpdateSearchEngine(r.Context(), id, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if s.cfg.CredCache != nil {
		s.cfg.CredCache.InvalidateSearch(id)
	}
	if engines, lErr := s.cfg.Cloud.ListSearchEngines(r.Context()); lErr == nil {
		_ = s.cfg.Store.SaveCachedSearchEngines(r.Context(), engines)
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleTestSearchEngine(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.TestSearchEngine(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleListMCPServers(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localPluginH.ListMCPServers(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	servers, err := s.cfg.Cloud.ListMCPServers(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"servers": servers})
}

func (s *Server) handleCreateMCPServer(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localPluginH.CreateMCPServer(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.CreateMCPServer(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusCreated, raw)
}

func (s *Server) handleUpdateMCPServer(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localPluginH.UpdateMCPServer(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.UpdateMCPServer(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleDeleteMCPServer(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localPluginH.DeleteMCPServer(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	if err := s.cfg.Cloud.DeleteMCPServer(r.Context(), r.PathValue("id")); err != nil {
		writeDesktopError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListMCPServerTools(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localPluginH.ListMCPServerTools(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	id := r.PathValue("id")
	tools, err := s.cfg.Cloud.ListMCPServerTools(r.Context(), id)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"serverId": id,
		"tools":    tools,
	})
}

func (s *Server) handleTestMCPServer(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localPluginH.TestMCPServer(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.TestMCPServer(r.Context(), r.PathValue("id"))
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

type statusTrackingWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusTrackingWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusTrackingWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.ListGroups(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.ListGroups(r.Context(), r.URL.Query().Get("assistantId"))
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.CreateGroup(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.CreateGroup(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusCreated, raw)
}

func (s *Server) handleReorderGroups(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.ReorderGroups(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.ReorderGroups(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleRenameGroup(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.RenameGroup(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.RenameGroup(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.DeleteGroup(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.DeleteGroup(r.Context(), r.PathValue("id"))
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.List(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.ListConversations(r.Context(), r.URL.Query().Get("assistantId"))
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.Create(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.CreateConversation(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusCreated, raw)
}

func (s *Server) handleBatchConversations(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.Batch(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.BatchConversations(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleCleanupUngrouped(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.CleanupUngrouped(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.CleanupUngrouped(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleReorderConversations(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.Reorder(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.ReorderConversations(r.Context(), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleGetConversation(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.GetDetail(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	detail, err := s.cfg.Cloud.GetConversationDetail(r.Context(), r.PathValue("id"))
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, detail)
}

func (s *Server) handlePatchConversation(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		rec := &statusTrackingWriter{ResponseWriter: w, status: http.StatusOK}
		s.localConvHandler.Patch(rec, r)
		if rec.status < 400 {
			_ = s.cfg.Store.MarkConversationPending(r.Context(), r.PathValue("id"))
		}
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	updated, err := s.cfg.Cloud.PatchConversation(r.Context(), r.PathValue("id"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"conversation": updated})
}

func (s *Server) handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.Delete(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	if err := s.cfg.Cloud.DeleteConversation(r.Context(), r.PathValue("id")); err != nil {
		writeDesktopError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		rec := &statusTrackingWriter{ResponseWriter: w, status: http.StatusOK}
		s.localConvHandler.CreateMessage(rec, r)
		if rec.status < 400 {
			_ = s.cfg.Store.MarkConversationPending(r.Context(), r.PathValue("id"))
		}
		return
	}
	if !s.requireCloud(w) {
		return
	}
	var in service.CreateMessageInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024)).Decode(&in); err != nil {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
		return
	}
	res, err := s.cfg.Cloud.CreateMessage(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusCreated, res)
}

func (s *Server) handleUpdateMessage(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		rec := &statusTrackingWriter{ResponseWriter: w, status: http.StatusOK}
		s.localConvHandler.UpdateMessage(rec, r)
		if rec.status < 400 {
			_ = s.cfg.Store.MarkConversationPending(r.Context(), r.PathValue("id"))
		}
		return
	}
	if !s.requireCloud(w) {
		return
	}
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.UpdateMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId"), body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		rec := &statusTrackingWriter{ResponseWriter: w, status: http.StatusOK}
		s.localConvHandler.DeleteMessage(rec, r)
		if rec.status < 400 {
			_ = s.cfg.Store.MarkConversationPending(r.Context(), r.PathValue("id"))
		}
		return
	}
	if !s.requireCloud(w) {
		return
	}
	if err := s.cfg.Cloud.DeleteMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId")); err != nil {
		writeDesktopError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBranchConversation(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		s.localConvHandler.BranchFromMessage(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.BranchConversation(r.Context(), r.PathValue("id"), r.PathValue("messageId"))
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusCreated, raw)
}

func (s *Server) handleChatStream(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	var in service.StreamChatInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024)).Decode(&in); err != nil {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
		return
	}
	in.ConversationID = r.PathValue("id")

	prepared, err := s.cfg.ChatEngine.Prepare(r.Context(), scope, in)
	if err != nil {
		writeDesktopError(w, err)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	_ = rc.Flush()

	_ = prepared.Stream(r.Context(), func(ev domain.StreamEvent) error {
		payload, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
			return err
		}
		return rc.Flush()
	})
}

func (s *Server) handleChatCompact(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	var in service.CompactConversationInput
	if r.ContentLength != 0 {
		if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
			writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
			return
		}
	}
	in.ConversationID = r.PathValue("id")

	res, err := s.cfg.ChatEngine.Compact(r.Context(), scope, in)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) handleChatExecuteTools(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	var in service.ExecuteToolsInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024)).Decode(&in); err != nil {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
		return
	}
	in.ConversationID = r.PathValue("id")

	rc := http.NewResponseController(w)
	headersSent := false
	sendEvent := func(ev domain.StreamEvent) error {
		if !headersSent {
			headersSent = true
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)
			_ = rc.Flush()
		}
		payload, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
			return err
		}
		return rc.Flush()
	}

	if err := s.cfg.ChatEngine.ExecuteTools(r.Context(), scope, in, sendEvent); err != nil {
		if !headersSent {
			writeDesktopError(w, err)
			return
		}
		_ = sendEvent(domain.StreamEvent{
			Type:           domain.StreamEventError,
			ConversationID: in.ConversationID,
			Error:          &domain.StreamError{Code: domain.ErrCodeInternalError, Message: err.Error()},
		})
	} else if !headersSent {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = rc.Flush()
	}
}

func (s *Server) handleCloudStorage(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	usage, err := s.cfg.Cloud.GetStorage(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, usage)
}

func (s *Server) handleCloudStorageCompact(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	res, err := s.cfg.Cloud.CompactStorage(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) computeDesktopStatus(ctx context.Context) DesktopStatus {
	conn, _ := s.cfg.Store.GetConnection(ctx)
	status := DesktopStatus{
		Mode:            s.cfg.Paths.Mode,
		DataDir:         s.cfg.Paths.DataDir,
		DBPath:          s.cfg.Paths.DBPath,
		CloudConfigured: strings.TrimSpace(conn.GatewayBaseURL) != "",
		CloudState:      "disconnected",
		GatewayBaseURL:  conn.GatewayBaseURL,
		TokenSet:        conn.TokenSet,
		Version:         s.cfg.Version,
	}
	if !status.CloudConfigured {
		return status
	}
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	authRequired, err := s.cfg.Cloud.HealthCheck(probeCtx)
	status.AuthRequired = authRequired
	if err != nil {
		if appErr, ok := domain.AsAppError(err); ok && appErr.Code == domain.ErrCodeUnauthorized {
			status.CloudState = "auth-required"
		} else {
			status.CloudState = "error"
		}
		return status
	}
	if _, _, err := s.cfg.Cloud.GetSettings(probeCtx); err != nil {
		if appErr, ok := domain.AsAppError(err); ok && appErr.Code == domain.ErrCodeUnauthorized {
			status.CloudState = "auth-required"
		} else {
			status.CloudState = "error"
		}
		return status
	}
	status.CloudState = "connected"
	return status
}

func (s *Server) handleDesktopStatus(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, s.computeDesktopStatus(r.Context()))
}

func (s *Server) handleGetDesktopConnection(w http.ResponseWriter, r *http.Request) {
	conn, err := s.cfg.Store.GetConnection(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	conn.AccessToken = ""
	httpapi.WriteJSON(w, http.StatusOK, conn)
}

func (s *Server) handleSaveDesktopConnection(w http.ResponseWriter, r *http.Request) {
	var in struct {
		GatewayBaseURL string `json:"gatewayBaseUrl"`
		AccessToken    string `json:"accessToken"`
		ClearToken     bool   `json:"clearToken,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&in); err != nil {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
		return
	}
	cleanURL := strings.TrimRight(strings.TrimSpace(in.GatewayBaseURL), "/")
	if cleanURL == "" {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "gatewayBaseUrl is required", nil))
		return
	}
	token := strings.TrimSpace(in.AccessToken)
	if token == "" && !in.ClearToken {
		if existing, err := s.cfg.Store.GetConnection(r.Context()); err == nil && existing.GatewayBaseURL == cleanURL {
			token = existing.AccessToken
		}
	}
	saved, err := s.cfg.Store.SaveConnection(r.Context(), cleanURL, token)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	s.cfg.Cloud.SetCredentials(saved.GatewayBaseURL, saved.AccessToken)
	if s.cfg.CredCache != nil {
		s.cfg.CredCache.ClearAll()
	}
	// Best-effort initial warm sync of assistants, providers, search, and preferences.
	s.warmSyncFromCloud(r.Context())
	saved.AccessToken = ""
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"connection": saved,
		"status":     s.computeDesktopStatus(r.Context()),
	})
}

func (s *Server) warmSyncFromCloud(ctx context.Context) {
	if s.cfg.Cloud == nil || !s.cfg.Cloud.IsConfigured() {
		return
	}
	syncCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if assistants, err := s.cfg.Cloud.ListAssistants(syncCtx); err == nil {
		_ = s.cfg.Store.SyncCloudAssistants(syncCtx, assistants)
	}
	if providers, err := s.cfg.Cloud.ListProviders(syncCtx); err == nil {
		_ = s.cfg.Store.SaveCachedProviders(syncCtx, providers)
	}
	if engines, err := s.cfg.Cloud.ListSearchEngines(syncCtx); err == nil {
		_ = s.cfg.Store.SaveCachedSearchEngines(syncCtx, engines)
	}
	if prefs, _, err := s.cfg.Cloud.GetSettings(syncCtx); err == nil {
		_ = s.cfg.Store.SaveCachedPreferences(syncCtx, prefs)
	}
}

func (s *Server) handleDeleteDesktopConnection(w http.ResponseWriter, r *http.Request) {
	if err := s.cfg.Store.DisconnectCloud(r.Context()); err != nil {
		writeDesktopError(w, err)
		return
	}
	s.cfg.Cloud.SetCredentials("", "")
	if s.cfg.CredCache != nil {
		s.cfg.CredCache.ClearAll()
	}
	httpapi.WriteJSON(w, http.StatusOK, s.computeDesktopStatus(r.Context()))
}

func (s *Server) handleTestDesktopConnection(w http.ResponseWriter, r *http.Request) {
	var in struct {
		GatewayBaseURL string `json:"gatewayBaseUrl"`
		AccessToken    string `json:"accessToken"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&in); err != nil {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
		return
	}
	cleanURL := strings.TrimRight(strings.TrimSpace(in.GatewayBaseURL), "/")
	if cleanURL == "" {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "gatewayBaseUrl is required", nil))
		return
	}
	token := strings.TrimSpace(in.AccessToken)
	if token == "" {
		if existing, err := s.cfg.Store.GetConnection(r.Context()); err == nil && existing.GatewayBaseURL == cleanURL {
			token = existing.AccessToken
		}
	}
	res, err := s.cfg.Cloud.TestConnection(r.Context(), cleanURL, token)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) handleUploadConversation(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Force bool `json:"force"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
			writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
			return
		}
	}
	res, err := s.cfg.SyncService.UploadConversation(r.Context(), r.PathValue("id"), in.Force)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) handlePullConversation(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Force bool `json:"force"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&in); err != nil && !errors.Is(err, io.EOF) {
			writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
			return
		}
	}
	res, err := s.cfg.SyncService.PullConversation(r.Context(), r.PathValue("id"), in.Force)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) handleBatchTransfer(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Direction string   `json:"direction"`
		IDs       []string `json:"ids"`
		Force     bool     `json:"force"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&in); err != nil {
		writeDesktopError(w, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err))
		return
	}
	res, err := s.cfg.SyncService.BatchTransfer(r.Context(), in.Direction, in.IDs, in.Force)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) handleDesktopStorage(w http.ResponseWriter, r *http.Request) {
	info, err := s.cfg.Store.StorageInfo(r.Context(), s.cfg.Paths)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, info)
}

func (s *Server) handleCompactLocalStorage(w http.ResponseWriter, r *http.Request) {
	res, err := s.cfg.Store.CompactLocalStorage(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, res)
}

func (s *Server) handleCleanupLocalUngrouped(w http.ResponseWriter, r *http.Request) {
	deleted, err := s.cfg.Store.CleanupLocalUngrouped(r.Context())
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (s *Server) handleClearLocalCache(w http.ResponseWriter, r *http.Request) {
	if err := s.cfg.Store.ClearLocalCache(r.Context()); err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"cleared": true})
}
