package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
)

// ChatHandler serves SSE streaming chat completion requests.
type ChatHandler struct {
	svc *service.ChatService
}

// NewChatHandler constructs a ChatHandler.
func NewChatHandler(svc *service.ChatService) *ChatHandler {
	return &ChatHandler{svc: svc}
}

func (h *ChatHandler) Stream(w http.ResponseWriter, r *http.Request) {
	var in service.StreamChatInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	in.ConversationID = r.PathValue("id")

	prepared, err := h.svc.Prepare(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	_ = rc.Flush()

	_ = prepared.Stream(r.Context(), func(ev domain.StreamEvent) error {
		payload, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
			return err
		}
		return rc.Flush()
	})
}
