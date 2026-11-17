package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/service"
)

// ProviderHandler serves provider CRUD endpoints.
type ProviderHandler struct {
	svc *service.ProviderService
}

// NewProviderHandler constructs a ProviderHandler.
func NewProviderHandler(svc *service.ProviderService) *ProviderHandler {
	return &ProviderHandler{svc: svc}
}

func (h *ProviderHandler) List(w http.ResponseWriter, r *http.Request) {
	providers, err := h.svc.List(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"providers": providers,
	})
}

func (h *ProviderHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.ProviderInput
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
		"provider": created,
	})
}

func (h *ProviderHandler) Update(w http.ResponseWriter, r *http.Request) {
	var in service.ProviderInput
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
		"provider": updated,
	})
}

func (h *ProviderHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
