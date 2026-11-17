package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/service"
)

// AssistantHandler serves assistant preset CRUD endpoints.
type AssistantHandler struct {
	svc *service.AssistantService
}

// NewAssistantHandler constructs an AssistantHandler.
func NewAssistantHandler(svc *service.AssistantService) *AssistantHandler {
	return &AssistantHandler{svc: svc}
}

func (h *AssistantHandler) List(w http.ResponseWriter, r *http.Request) {
	items, err := h.svc.List(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"assistants": items,
	})
}

func (h *AssistantHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.AssistantInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	created, err := h.svc.Create(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]any{
		"assistant": created,
	})
}

func (h *AssistantHandler) Update(w http.ResponseWriter, r *http.Request) {
	var in service.AssistantInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	updated, err := h.svc.Update(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"assistant": updated,
	})
}

func (h *AssistantHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
