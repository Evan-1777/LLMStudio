package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/service"
)

// ConversationHandler serves conversation CRUD and message detail endpoints.
type ConversationHandler struct {
	svc *service.ConversationService
}

// NewConversationHandler constructs a ConversationHandler.
func NewConversationHandler(svc *service.ConversationService) *ConversationHandler {
	return &ConversationHandler{svc: svc}
}

func (h *ConversationHandler) List(w http.ResponseWriter, r *http.Request) {
	convs, err := h.svc.List(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"conversations": convs,
	})
}

func (h *ConversationHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CreateConversationInput
	if r.ContentLength != 0 {
		if err := decodeJSONBody(r, &in); err != nil {
			writeServiceError(w, err)
			return
		}
	}
	created, err := h.svc.Create(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]any{
		"conversation": created,
	})
}

func (h *ConversationHandler) GetDetail(w http.ResponseWriter, r *http.Request) {
	detail, err := h.svc.GetDetail(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, detail)
}

func (h *ConversationHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.PatchConversationInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	updated, err := h.svc.Patch(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"conversation": updated,
	})
}

func (h *ConversationHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
