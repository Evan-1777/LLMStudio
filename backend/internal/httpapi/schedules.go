package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
)

// ScheduleHandler serves cloud-only Agent scheduled task CRUD and manual execution endpoints.
type ScheduleHandler struct {
	svc *service.ScheduleService
}

// NewScheduleHandler constructs a ScheduleHandler.
func NewScheduleHandler(svc *service.ScheduleService) *ScheduleHandler {
	return &ScheduleHandler{svc: svc}
}

func (h *ScheduleHandler) List(w http.ResponseWriter, r *http.Request) {
	tasks, err := h.svc.List(r.Context(), r.URL.Query().Get("conversationId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, map[string]any{"schedules": tasks})
}

func (h *ScheduleHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in domain.ScheduleCreateInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	created, err := h.svc.Create(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusCreated, map[string]any{"schedule": created})
}

func (h *ScheduleHandler) Update(w http.ResponseWriter, r *http.Request) {
	var in domain.ScheduleUpdateInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	updated, err := h.svc.Update(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, map[string]any{"schedule": updated})
}

func (h *ScheduleHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *ScheduleHandler) RunNow(w http.ResponseWriter, r *http.Request) {
	task, convID, err := h.svc.RunNow(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	WriteJSON(w, http.StatusOK, map[string]any{
		"schedule":       task,
		"conversationId": convID,
	})
}
