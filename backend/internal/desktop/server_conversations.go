package desktop

import (
	"encoding/json"
	"io"
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/service"
)

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.ListGroups, func(w http.ResponseWriter, r *http.Request) {
		raw, err := s.cfg.Cloud.ListGroups(r.Context(), r.URL.Query().Get("assistantId"))
		proxyCloudRaw(w, http.StatusOK, raw, err)
	})
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.CreateGroup, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusCreated, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.CreateGroup(r.Context(), body)
		})
	})
}

func (s *Server) handleReorderGroups(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.ReorderGroups, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusOK, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.ReorderGroups(r.Context(), body)
		})
	})
}

func (s *Server) handleRenameGroup(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.RenameGroup, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusOK, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.RenameGroup(r.Context(), r.PathValue("id"), body)
		})
	})
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.DeleteGroup, func(w http.ResponseWriter, r *http.Request) {
		raw, err := s.cfg.Cloud.DeleteGroup(r.Context(), r.PathValue("id"))
		proxyCloudRaw(w, http.StatusOK, raw, err)
	})
}

func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.List, func(w http.ResponseWriter, r *http.Request) {
		raw, err := s.cfg.Cloud.ListConversations(r.Context(), r.URL.Query().Get("assistantId"))
		proxyCloudRaw(w, http.StatusOK, raw, err)
	})
}

func (s *Server) handleSearchConversations(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.Search, func(w http.ResponseWriter, r *http.Request) {
		raw, err := s.cfg.Cloud.SearchConversations(r.Context(), r.URL.Query().Get("assistantId"), r.URL.Query().Get("q"))
		proxyCloudRaw(w, http.StatusOK, raw, err)
	})
}

func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.Create, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusCreated, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.CreateConversation(r.Context(), body)
		})
	})
}

func (s *Server) handleBatchConversations(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.Batch, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusOK, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.BatchConversations(r.Context(), body)
		})
	})
}

func (s *Server) handleCleanupUngrouped(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.CleanupUngrouped, func(w http.ResponseWriter, r *http.Request) {
		raw, err := s.cfg.Cloud.CleanupUngrouped(r.Context())
		proxyCloudRaw(w, http.StatusOK, raw, err)
	})
}

func (s *Server) handleReorderConversations(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.Reorder, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusOK, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.ReorderConversations(r.Context(), body)
		})
	})
}

func (s *Server) handleGetConversation(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.GetDetail, func(w http.ResponseWriter, r *http.Request) {
		detail, err := s.cfg.Cloud.GetConversationDetail(r.Context(), r.PathValue("id"))
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, detail)
	})
}

func (s *Server) handlePatchConversation(w http.ResponseWriter, r *http.Request) {
	s.dispatchScopedLocalPending(w, r, s.localConvHandler.Patch, func(w http.ResponseWriter, r *http.Request) {
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
	})
}

func (s *Server) handleMutateConversationGraph(w http.ResponseWriter, r *http.Request) {
	s.dispatchScopedLocalPending(w, r, s.localConvHandler.MutateGraph, func(w http.ResponseWriter, r *http.Request) {
		body, err := readRawBody(r, 16*1024*1024)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		// Cloud chat details are cached per generation, not shared across requests.
		detail, err := s.cfg.Cloud.MutateConversationGraph(r.Context(), r.PathValue("id"), body)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, detail)
	})
}

func (s *Server) handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.Delete, func(w http.ResponseWriter, r *http.Request) {
		if err := s.cfg.Cloud.DeleteConversation(r.Context(), r.PathValue("id")); err != nil {
			writeDesktopError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Server) handleCreateMessage(w http.ResponseWriter, r *http.Request) {
	s.dispatchScopedLocalPending(w, r, s.localConvHandler.CreateMessage, func(w http.ResponseWriter, r *http.Request) {
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
	})
}

func (s *Server) handleUpdateMessage(w http.ResponseWriter, r *http.Request) {
	s.dispatchScopedLocalPending(w, r, s.localConvHandler.UpdateMessage, func(w http.ResponseWriter, r *http.Request) {
		readAndProxyCloudRaw(w, r, http.StatusOK, func(body json.RawMessage) (json.RawMessage, error) {
			return s.cfg.Cloud.UpdateMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId"), body)
		})
	})
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	s.dispatchScopedLocalPending(w, r, s.localConvHandler.DeleteMessage, func(w http.ResponseWriter, r *http.Request) {
		if err := s.cfg.Cloud.DeleteMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId")); err != nil {
			writeDesktopError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Server) handleBranchConversation(w http.ResponseWriter, r *http.Request) {
	s.dispatchScoped(w, r, s.localConvHandler.BranchFromMessage, func(w http.ResponseWriter, r *http.Request) {
		raw, err := s.cfg.Cloud.BranchConversation(r.Context(), r.PathValue("id"), r.PathValue("messageId"))
		proxyCloudRaw(w, http.StatusCreated, raw, err)
	})
}
