package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/service"
)

// StorageHandler serves the database footprint and compaction endpoints.
type StorageHandler struct {
	svc *service.StorageService
}

// NewStorageHandler constructs a StorageHandler.
func NewStorageHandler(svc *service.StorageService) *StorageHandler {
	return &StorageHandler{svc: svc}
}

func (h *StorageHandler) Get(w http.ResponseWriter, r *http.Request) {
	usage, err := h.svc.Usage(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, usage)
}

func (h *StorageHandler) Compact(w http.ResponseWriter, r *http.Request) {
	result, err := h.svc.Compact(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, result)
}
