package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
)

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

const (
	desktopStatusProbeTimeout = 8 * time.Second
	desktopStatusRetryDelay   = 400 * time.Millisecond
)

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
	if !status.CloudConfigured || s.cfg.Cloud == nil {
		return status
	}

	probeCtx, release := s.cfg.Cloud.bind(ctx)
	defer release()

	probeOnce := func() (domain.Preferences, error) {
		attemptCtx, cancel := context.WithTimeout(probeCtx, desktopStatusProbeTimeout)
		defer cancel()
		prefs, _, err := s.cfg.Cloud.GetSettings(attemptCtx)
		return prefs, err
	}

	prefs, err := probeOnce()
	if err != nil {
		if appErr, ok := domain.AsAppError(err); ok && appErr.Code == domain.ErrCodeUnauthorized {
			status.AuthRequired = true
			status.CloudState = "auth-required"
			return status
		}
		if probeCtx.Err() != nil {
			status.CloudState = "error"
			return status
		}
		timer := time.NewTimer(desktopStatusRetryDelay)
		select {
		case <-probeCtx.Done():
			timer.Stop()
			status.CloudState = "error"
			return status
		case <-timer.C:
		}
		prefs, err = probeOnce()
		if err != nil {
			if appErr, ok := domain.AsAppError(err); ok && appErr.Code == domain.ErrCodeUnauthorized {
				status.AuthRequired = true
				status.CloudState = "auth-required"
			} else {
				status.CloudState = "error"
			}
			return status
		}
	}

	if s.cfg.Store != nil {
		_ = s.cfg.Store.SaveCachedPreferences(probeCtx, prefs)
	}
	status.AuthRequired = status.TokenSet
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
	s.cfg.Cloud.mu.Lock()
	token := strings.TrimSpace(in.AccessToken)
	if token == "" && !in.ClearToken {
		if existing, err := s.cfg.Store.GetConnection(r.Context()); err == nil && existing.GatewayBaseURL == cleanURL {
			token = existing.AccessToken
		}
	}
	saved, err := s.cfg.Store.SaveConnection(r.Context(), cleanURL, token)
	if err == nil {
		s.cfg.Cloud.setCredentials(saved.GatewayBaseURL, saved.AccessToken)
	}
	s.cfg.Cloud.mu.Unlock()
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if s.cfg.CompositeTools != nil {
		s.cfg.CompositeTools.InvalidateCloudCache()
	}
	// Best-effort initial warm sync of assistants, providers, search, preferences, and MCP.
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
	ctx, release := s.cfg.Cloud.bind(ctx)
	defer release()
	syncCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if assistants, err := s.cfg.Cloud.ListAssistants(syncCtx); err == nil {
		_ = s.cfg.Store.SyncCloudAssistants(syncCtx, assistants)
	}
	s.refreshProvidersCache(syncCtx)
	if engines, err := s.cfg.Cloud.ListSearchEngines(syncCtx); err == nil {
		_ = s.cfg.Store.SaveCachedSearchEngines(syncCtx, engines)
	}
	if prefs, _, err := s.cfg.Cloud.GetSettings(syncCtx); err == nil {
		_ = s.cfg.Store.SaveCachedPreferences(syncCtx, prefs)
	}
	if s.cfg.CompositeTools != nil {
		conn := s.cfg.Cloud.currentConnection()
		if servers, err := s.cfg.Cloud.ListMCPServers(syncCtx); err == nil {
			s.cfg.CompositeTools.SetCloudServers(conn, servers)
			var wg sync.WaitGroup
			for _, srv := range servers {
				if !srv.Enabled {
					continue
				}
				wg.Go(func() {
					if tools, tErr := s.cfg.Cloud.ListMCPServerTools(syncCtx, srv.ID); tErr == nil {
						s.cfg.CompositeTools.SetCloudServerTools(conn, srv.ID, srv.UpdatedAt, tools)
					}
				})
			}
			wg.Wait()
		}
	}
}

func (s *Server) handleDeleteDesktopConnection(w http.ResponseWriter, r *http.Request) {
	s.cfg.Cloud.mu.Lock()
	err := s.cfg.Store.DisconnectCloud(r.Context())
	if err == nil {
		s.cfg.Cloud.setCredentials("", "")
	}
	s.cfg.Cloud.mu.Unlock()
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if s.cfg.CompositeTools != nil {
		s.cfg.CompositeTools.InvalidateCloudCache()
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
	if s.cfg.CompositeTools != nil {
		s.cfg.CompositeTools.InvalidateCloudCache()
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"cleared": true})
}
