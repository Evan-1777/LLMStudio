package desktop

import (
	"encoding/json"
	"io"
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
)

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

func (s *Server) handleProxyCustomFont(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Cloud == nil || !s.cfg.Cloud.IsConfigured() {
		httpapi.WriteError(w, http.StatusServiceUnavailable, domain.ErrCodeCloudNotConnected, "cloud gateway is not connected")
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()

	var (
		body          io.Reader
		contentLength int64 = -1
	)
	switch r.Method {
	case http.MethodPut:
		if r.ContentLength > domain.CustomFontMaxBytes {
			httpapi.WriteError(w, http.StatusRequestEntityTooLarge, domain.ErrCodePayloadTooLarge, "字体文件不能超过 32 MiB")
			return
		}
		if r.Body != nil {
			body = http.MaxBytesReader(w, r.Body, domain.CustomFontMaxBytes)
			contentLength = r.ContentLength
		}
	case http.MethodPatch:
		if r.Body != nil {
			body = http.MaxBytesReader(w, r.Body, 64*1024)
			contentLength = r.ContentLength
		}
	}

	resp, err := s.cfg.Cloud.ProxyCustomFont(ctx, r.Method, r.URL.Path, r.Header, body, contentLength)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	defer resp.Body.Close()

	if connErr := checkCloudConnection(ctx); connErr != nil {
		writeDesktopError(w, connErr)
		return
	}

	for _, key := range []string{"Content-Type", "ETag", "Cache-Control", "Content-Length"} {
		if val := resp.Header.Get(key); val != "" {
			w.Header().Set(key, val)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified {
		return
	}
	_, _ = io.Copy(w, io.LimitReader(resp.Body, domain.CustomFontMaxBytes+1024*1024))
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
	readAndProxyCloudRaw(w, r, http.StatusOK, func(body json.RawMessage) (json.RawMessage, error) {
		return s.cfg.Cloud.TestSearchEngine(r.Context(), r.PathValue("id"), body)
	})
}

func (s *Server) handleListMCPServers(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localPluginH.ListMCPServers, func(w http.ResponseWriter, r *http.Request) {
		servers, err := s.cfg.Cloud.ListMCPServers(r.Context())
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		if s.cfg.CompositeTools != nil {
			s.cfg.CompositeTools.SetCloudServers(s.cfg.Cloud.currentConnection(), servers)
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"servers": servers})
	})
}

func (s *Server) handleCreateMCPServer(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localPluginH.CreateMCPServer, func(w http.ResponseWriter, r *http.Request) {
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
		if s.cfg.CompositeTools != nil {
			s.cfg.CompositeTools.InvalidateCloudCache()
		}
		writeRawJSON(w, http.StatusCreated, raw)
	})
}

func (s *Server) handleUpdateMCPServer(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localPluginH.UpdateMCPServer, func(w http.ResponseWriter, r *http.Request) {
		body, err := readRawBody(r, 16*1024*1024)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		id := r.PathValue("id")
		raw, err := s.cfg.Cloud.UpdateMCPServer(r.Context(), id, body)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		if s.cfg.CompositeTools != nil {
			s.cfg.CompositeTools.InvalidateCloudServer(id)
		}
		writeRawJSON(w, http.StatusOK, raw)
	})
}

func (s *Server) handleDeleteMCPServer(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localPluginH.DeleteMCPServer, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := s.cfg.Cloud.DeleteMCPServer(r.Context(), id); err != nil {
			writeDesktopError(w, err)
			return
		}
		if s.cfg.CompositeTools != nil {
			s.cfg.CompositeTools.InvalidateCloudServer(id)
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Server) handleListMCPServerTools(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localPluginH.ListMCPServerTools, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		tools, err := s.cfg.Cloud.ListMCPServerTools(r.Context(), id)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		if s.cfg.CompositeTools != nil {
			if srv, sErr := s.cfg.CompositeTools.GetScoped(r.Context(), plugin.ExecutionScopeCloud, id); sErr == nil {
				s.cfg.CompositeTools.SetCloudServerTools(s.cfg.Cloud.currentConnection(), id, srv.UpdatedAt, tools)
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"serverId": id,
			"tools":    tools,
		})
	})
}

func (s *Server) handleTestMCPServer(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localPluginH.TestMCPServer, func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		raw, err := s.cfg.Cloud.TestMCPServer(r.Context(), id)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		if s.cfg.CompositeTools != nil {
			s.cfg.CompositeTools.InvalidateCloudServer(id)
		}
		writeRawJSON(w, http.StatusOK, raw)
	})
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
