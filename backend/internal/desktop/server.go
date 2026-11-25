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
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/agent"
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
	HTTPClient     *http.Client
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
	if cfg.ChatEngine != nil {
		localConvSvc.WithRunTracker(
			cfg.ChatEngine.ActiveLocalRun,
			cfg.ChatEngine.ActiveLocalRunIDs,
			cfg.ChatEngine.CancelLocalRunsAndWait,
		)
	}
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

	// Cloud custom font: transparent binary/metadata proxy without desktop SQLite BLOB storage.
	mux.HandleFunc("GET /api/v1/settings/custom-font", s.handleProxyCustomFont)
	mux.HandleFunc("PUT /api/v1/settings/custom-font", s.handleProxyCustomFont)
	mux.HandleFunc("PATCH /api/v1/settings/custom-font", s.handleProxyCustomFont)
	mux.HandleFunc("DELETE /api/v1/settings/custom-font", s.handleProxyCustomFont)
	mux.HandleFunc("GET /api/v1/settings/custom-font/file", s.handleProxyCustomFont)

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
	mux.HandleFunc("GET /api/v1/conversations/search", s.handleSearchConversations)
	mux.HandleFunc("POST /api/v1/conversations", s.handleCreateConversation)
	mux.HandleFunc("POST /api/v1/conversations/batch", s.handleBatchConversations)
	mux.HandleFunc("POST /api/v1/conversations/cleanup-ungrouped", s.handleCleanupUngrouped)
	mux.HandleFunc("POST /api/v1/conversations/reorder", s.handleReorderConversations)
	mux.HandleFunc("GET /api/v1/conversations/{id}", s.handleGetConversation)
	mux.HandleFunc("PATCH /api/v1/conversations/{id}", s.handlePatchConversation)
	mux.HandleFunc("PATCH /api/v1/conversations/{id}/graph", s.handleMutateConversationGraph)
	mux.HandleFunc("DELETE /api/v1/conversations/{id}", s.handleDeleteConversation)
	mux.HandleFunc("POST /api/v1/conversations/{id}/messages", s.handleCreateMessage)
	mux.HandleFunc("PATCH /api/v1/conversations/{id}/messages/{messageId}", s.handleUpdateMessage)
	mux.HandleFunc("DELETE /api/v1/conversations/{id}/messages/{messageId}", s.handleDeleteMessage)
	mux.HandleFunc("POST /api/v1/conversations/{id}/messages/{messageId}/branch", s.handleBranchConversation)

	httpapi.RegisterAgentRoutes(mux, agent.NewDesktop(s.cfg.Store.Agent), s.dispatchAgent)

	// Local-first chat streaming, compaction, and MCP tool execution for both domains.
	mux.HandleFunc("POST /api/v1/conversations/{id}/messages/stream", s.handleChatStream)
	mux.HandleFunc("GET /api/v1/conversations/{id}/run/stream", s.handleAttachRunStream)
	mux.HandleFunc("POST /api/v1/conversations/{id}/run/cancel", s.handleCancelRun)
	mux.HandleFunc("GET /api/v1/agent/runs", s.handleListActiveRuns)
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
	return httpapi.CORSMiddleware(allowedOrigins, s.bearerAuthMiddleware(mux))
}

func (s *Server) bearerAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		token, ok := httpapi.ExtractBearerToken(r.Header.Get("Authorization"))
		if !ok {
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

func (s *Server) dispatchScoped(w http.ResponseWriter, r *http.Request, localFn, cloudFn http.HandlerFunc) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		localFn(w, r)
		return
	}
	if !s.requireCloud(w) {
		return
	}
	cloudFn(w, r)
}

func (s *Server) dispatchScopedLocalPending(w http.ResponseWriter, r *http.Request, localFn, cloudFn http.HandlerFunc) {
	s.dispatchScoped(w, r, func(w http.ResponseWriter, r *http.Request) {
		rec := &statusTrackingWriter{ResponseWriter: w, status: http.StatusOK}
		localFn(rec, r)
		if rec.status < 400 {
			_ = s.cfg.Store.MarkConversationPending(r.Context(), r.PathValue("id"))
		}
	}, cloudFn)
}

func proxyCloudRaw(w http.ResponseWriter, status int, raw json.RawMessage, err error) {
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, status, raw)
}

func readAndProxyCloudRaw(w http.ResponseWriter, r *http.Request, status int, call func(json.RawMessage) (json.RawMessage, error)) {
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := call(body)
	proxyCloudRaw(w, status, raw, err)
}
