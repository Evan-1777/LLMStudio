package httpapi

import (
	"net/http"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
)

// PluginHandler serves search plugin and MCP server configuration endpoints.
type PluginHandler struct {
	svc     *service.PluginService
	chatSvc *service.ChatService
}

// NewPluginHandler constructs a PluginHandler.
func NewPluginHandler(svc *service.PluginService) *PluginHandler {
	return &PluginHandler{svc: svc}
}

// WithChatService attaches ChatService so stateless MCP execution can reuse its runtime.
func (h *PluginHandler) WithChatService(chatSvc *service.ChatService) *PluginHandler {
	h.chatSvc = chatSvc
	return h
}

func (h *PluginHandler) ListSearchEngines(w http.ResponseWriter, r *http.Request) {
	engines, err := h.svc.ListSearchEngines(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"engines": engines,
	})
}

func (h *PluginHandler) GetSearchEngineCredential(w http.ResponseWriter, r *http.Request) {
	cred, err := h.svc.GetSearchEngineRuntimeCredential(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	WriteJSON(w, http.StatusOK, cred)
}

func (h *PluginHandler) UpdateSearchEngine(w http.ResponseWriter, r *http.Request) {
	var in service.SearchEngineUpdateInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	updated, err := h.svc.UpdateSearchEngine(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"engine": updated,
	})
}

func (h *PluginHandler) TestSearchEngine(w http.ResponseWriter, r *http.Request) {
	var in service.SearchEngineTestInput
	if err := decodeOptionalJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	res, err := h.svc.TestSearchEngine(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *PluginHandler) ListMCPServers(w http.ResponseWriter, r *http.Request) {
	servers, err := h.svc.ListMCPServers(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"servers": servers,
	})
}

func (h *PluginHandler) CreateMCPServer(w http.ResponseWriter, r *http.Request) {
	var in service.MCPServerInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	created, err := h.svc.CreateMCPServer(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]any{
		"server": created,
	})
}

func (h *PluginHandler) UpdateMCPServer(w http.ResponseWriter, r *http.Request) {
	var in service.MCPServerInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	updated, err := h.svc.UpdateMCPServer(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"server": updated,
	})
}

func (h *PluginHandler) DeleteMCPServer(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteMCPServer(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *PluginHandler) ListMCPServerTools(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	tools, err := h.svc.ListMCPServerTools(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"serverId": id,
		"tools":    tools,
	})
}

func (h *PluginHandler) TestMCPServer(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.TestMCPServer(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *PluginHandler) ExecuteMCPTools(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Calls []service.StatelessToolCallInput `json:"calls"`
	}
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}

	run := func(emit func(domain.StreamEvent) error) error {
		if h.chatSvc != nil {
			return h.chatSvc.ExecuteToolsStateless(r.Context(), in.Calls, emit)
		}
		return h.svc.ExecuteMCPTools(r.Context(), in.Calls, emit)
	}

	if strings.Contains(r.Header.Get("Accept"), "text/event-stream") || r.URL.Query().Get("stream") == "true" {
		streamSSEToolEvents(w, "", run)
		return
	}

	results := make([]domain.ContentBlock, 0, len(in.Calls))
	if err := run(func(ev domain.StreamEvent) error {
		if ev.Type == domain.StreamEventBlockEnd && ev.Block != nil {
			results = append(results, *ev.Block)
		}
		return nil
	}); err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"toolResults": results,
	})
}
