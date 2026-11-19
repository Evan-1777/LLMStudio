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

func (h *ChatHandler) PrepareLocal(w http.ResponseWriter, r *http.Request) {
	var in service.StreamChatInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	in.ConversationID = r.PathValue("id")

	prepared, err := h.svc.PrepareLocal(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if in.CredentialEnvelope {
		// The response carries an upstream credential; never let it be cached.
		w.Header().Set("Cache-Control", "no-store")
	}
	WriteJSON(w, http.StatusOK, prepared)
}

func (h *ChatHandler) Compact(w http.ResponseWriter, r *http.Request) {
	var in service.CompactConversationInput
	if r.ContentLength != 0 {
		if err := decodeJSONBody(r, &in); err != nil {
			writeServiceError(w, err)
			return
		}
	}
	in.ConversationID = r.PathValue("id")

	res, err := h.svc.Compact(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *ChatHandler) PrepareLocalCompact(w http.ResponseWriter, r *http.Request) {
	var in service.CompactConversationInput
	if r.ContentLength != 0 {
		if err := decodeJSONBody(r, &in); err != nil {
			writeServiceError(w, err)
			return
		}
	}
	in.ConversationID = r.PathValue("id")

	prepared, err := h.svc.PrepareLocalCompact(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if in.CredentialEnvelope {
		// The response carries an upstream credential; never let it be cached.
		w.Header().Set("Cache-Control", "no-store")
	}
	WriteJSON(w, http.StatusOK, prepared)
}

func (h *ChatHandler) ExecuteTools(w http.ResponseWriter, r *http.Request) {
	var in service.ExecuteToolsInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	in.ConversationID = r.PathValue("id")

	rc := http.NewResponseController(w)
	headersSent := false
	sendEvent := func(ev domain.StreamEvent) error {
		if !headersSent {
			headersSent = true
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)
			_ = rc.Flush()
		}
		payload, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
			return err
		}
		return rc.Flush()
	}

	if err := h.svc.ExecuteTools(r.Context(), in, sendEvent); err != nil {
		if !headersSent {
			writeServiceError(w, err)
			return
		}
		_ = sendEvent(domain.StreamEvent{
			Type:           domain.StreamEventError,
			ConversationID: in.ConversationID,
			Error: &domain.StreamError{
				Code:    domain.ErrCodeInternalError,
				Message: err.Error(),
			},
		})
	} else if !headersSent {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = rc.Flush()
	}
}
