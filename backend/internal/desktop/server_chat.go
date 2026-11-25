package desktop

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
)

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
	if prepared.response != nil {
		defer prepared.release()
		copyAgentResponse(w, prepared.response, true)
		return
	}

	sse := httpapi.NewSSEWriter(w)
	sse.Start()
	_ = prepared.Stream(r.Context(), sse.WriteEvent)
}

func (s *Server) handleAttachRunStream(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	id := r.PathValue("id")
	if scope == plugin.ExecutionScopeLocal {
		if s.cfg.ChatEngine == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		sse := httpapi.NewSSEWriter(w)
		attached, _ := s.cfg.ChatEngine.SubscribeLocalRun(r.Context(), id, sse.Start, sse.WriteEvent)
		if !attached {
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	target := "/api/v1/conversations/" + url.PathEscape(id) + "/run/stream"
	resp, proxyErr := s.cfg.Cloud.proxyRequest(ctx, http.MethodGet, target, http.Header{"Accept": {"text/event-stream"}}, nil, 0)
	if proxyErr != nil {
		writeDesktopError(w, proxyErr)
		return
	}
	copyAgentResponse(w, resp, true)
}

func (s *Server) handleCancelRun(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	id := r.PathValue("id")
	if scope == plugin.ExecutionScopeLocal {
		cancelled := s.cfg.ChatEngine != nil && s.cfg.ChatEngine.CancelLocalRun(id)
		httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"cancelled": cancelled})
		return
	}
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	target := "/api/v1/conversations/" + url.PathEscape(id) + "/run/cancel"
	resp, proxyErr := s.cfg.Cloud.proxyRequest(ctx, http.MethodPost, target, http.Header{"Content-Type": {"application/json"}}, nil, 0)
	if proxyErr != nil {
		writeDesktopError(w, proxyErr)
		return
	}
	copyAgentResponse(w, resp, false)
}

func (s *Server) handleListActiveRuns(w http.ResponseWriter, r *http.Request) {
	scope, err := scopeFromRequest(r)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if scope == plugin.ExecutionScopeLocal {
		ids := []string{}
		if s.cfg.ChatEngine != nil {
			ids = s.cfg.ChatEngine.ActiveLocalRunIDs()
			if ids == nil {
				ids = []string{}
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string][]string{"conversationIds": ids})
		return
	}
	if s.cfg.Cloud == nil || !s.cfg.Cloud.IsConfigured() {
		httpapi.WriteJSON(w, http.StatusOK, map[string][]string{"conversationIds": {}})
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	resp, proxyErr := s.cfg.Cloud.proxyRequest(ctx, http.MethodGet, "/api/v1/agent/runs", nil, nil, 0)
	if proxyErr != nil {
		httpapi.WriteJSON(w, http.StatusOK, map[string][]string{"conversationIds": {}})
		return
	}
	copyAgentResponse(w, resp, false)
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

	httpapi.StreamSSEToolEvents(w, in.ConversationID, writeDesktopError, func(emit func(domain.StreamEvent) error) error {
		return s.cfg.ChatEngine.ExecuteTools(r.Context(), scope, in, emit)
	})
}
