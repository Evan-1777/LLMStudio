package httpapi

import (
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

	sse := NewSSEWriter(w)
	sse.Start()
	_ = prepared.Stream(r.Context(), sse.WriteEvent)
}

func (h *ChatHandler) AttachRunStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sse := NewSSEWriter(w)
	attached, _ := h.svc.SubscribeRun(r.Context(), id, sse.Start, sse.WriteEvent)
	if !attached {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *ChatHandler) CancelRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cancelled := h.svc.CancelRun(id)
	WriteJSON(w, http.StatusOK, map[string]bool{"cancelled": cancelled})
}

func (h *ChatHandler) ListActiveRuns(w http.ResponseWriter, _ *http.Request) {
	ids := h.svc.ActiveRunConversationIDs()
	if ids == nil {
		ids = []string{}
	}
	WriteJSON(w, http.StatusOK, map[string][]string{"conversationIds": ids})
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
	StreamSSEToolEvents(w, in.ConversationID, writeServiceError, func(emit func(domain.StreamEvent) error) error {
		return h.svc.ExecuteTools(r.Context(), in, emit)
	})
}
