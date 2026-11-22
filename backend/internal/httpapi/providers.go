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

func (h *ProviderHandler) GetCredential(w http.ResponseWriter, r *http.Request) {
	cred, err := h.svc.GetRuntimeCredential(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	WriteJSON(w, http.StatusOK, cred)
}

func (h *ProviderHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID       string  `json:"id"`
		BeforeID *string `json:"beforeId"`
	}
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	providers, err := h.svc.Reorder(r.Context(), in.ID, in.BeforeID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"providers": providers})
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

func (h *ProviderHandler) ImportAPIKey(w http.ResponseWriter, r *http.Request) {
	var in struct {
		APIKey string `json:"apiKey"`
	}
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	res, err := h.svc.ImportAPIKey(r.Context(), r.PathValue("id"), in.APIKey)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *ProviderHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ProviderHandler) TestConnection(w http.ResponseWriter, r *http.Request) {
	var in service.ProviderProbeInput
	if err := decodeOptionalJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	res, err := h.svc.TestConnection(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *ProviderHandler) FetchModels(w http.ResponseWriter, r *http.Request) {
	var in service.ProviderProbeInput
	if err := decodeOptionalJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	models, err := h.svc.FetchUpstreamModels(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"models": models,
	})
}

func (h *ProviderHandler) PrepareLocalModels(w http.ResponseWriter, r *http.Request) {
	var rawOverrides map[string]any
	if err := decodeOptionalJSONBody(r, &rawOverrides); err != nil {
		writeServiceError(w, err)
		return
	}
	if len(rawOverrides) > 0 {
		WriteError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "local model probe envelope does not accept target or credential overrides")
		return
	}
	prepared, err := h.svc.PrepareLocalModelProbe(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	WriteJSON(w, http.StatusOK, prepared)
}
