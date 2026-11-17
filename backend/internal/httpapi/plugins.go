package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/service"
)

// PluginHandler serves search plugin and MCP server configuration endpoints.
type PluginHandler struct {
	svc *service.PluginService
}

// NewPluginHandler constructs a PluginHandler.
func NewPluginHandler(svc *service.PluginService) *PluginHandler {
	return &PluginHandler{svc: svc}
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
