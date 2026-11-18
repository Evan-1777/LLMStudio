package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
)

// PreferenceHandler serves the single-user application preference endpoints.
type PreferenceHandler struct {
	svc *service.PreferenceService
}

// NewPreferenceHandler constructs a PreferenceHandler.
func NewPreferenceHandler(svc *service.PreferenceService) *PreferenceHandler {
	return &PreferenceHandler{svc: svc}
}

type preferenceEnvelope struct {
	Preferences domain.Preferences `json:"preferences"`
	Initialized bool               `json:"initialized"`
}

func (h *PreferenceHandler) Get(w http.ResponseWriter, r *http.Request) {
	prefs, initialized, err := h.svc.Get(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, preferenceEnvelope{Preferences: prefs, Initialized: initialized})
}

// Import once seeds preferences from legacy browser storage. It only applies to
// a gateway that has not committed preferences yet, so a late import cannot
// overwrite values another browser already saved.
func (h *PreferenceHandler) ImportOnce(w http.ResponseWriter, r *http.Request) {
	var input domain.Preferences
	if err := decodeJSONBody(r, &input); err != nil {
		writeServiceError(w, err)
		return
	}
	prefs, initialized, err := h.svc.ImportLegacy(r.Context(), input)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, preferenceEnvelope{Preferences: prefs, Initialized: initialized})
}

func (h *PreferenceHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var patch domain.PreferencesPatch
	if err := decodeJSONBody(r, &patch); err != nil {
		writeServiceError(w, err)
		return
	}
	prefs, initialized, err := h.svc.Update(r.Context(), patch)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, preferenceEnvelope{Preferences: prefs, Initialized: initialized})
}
