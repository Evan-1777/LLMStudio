package httpapi

import (
	"net/http"
	"strings"

	"llmstudio/backend/internal/domain"
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
	assistantID := strings.TrimSpace(r.URL.Query().Get("assistantId"))
	var (
		convs []domain.Conversation
		err   error
	)
	if assistantID != "" {
		convs, err = h.svc.ListByAssistant(r.Context(), assistantID)
	} else {
		convs, err = h.svc.List(r.Context())
	}
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

func (h *ConversationHandler) Import(w http.ResponseWriter, r *http.Request) {
	var in service.ImportConversationInput
	if err := decodeJSONBodyWithLimit(r, &in, 64*1024*1024); err != nil {
		writeServiceError(w, err)
		return
	}
	detail, err := h.svc.Import(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, detail)
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

func (h *ConversationHandler) MutateGraph(w http.ResponseWriter, r *http.Request) {
	var in service.GraphMutationInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	detail, err := h.svc.MutateGraph(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, detail)
}

func (h *ConversationHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ConversationHandler) CreateMessage(w http.ResponseWriter, r *http.Request) {
	var in service.CreateMessageInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	res, err := h.svc.CreateMessage(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, res)
}

func (h *ConversationHandler) UpdateMessage(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Blocks []domain.ContentBlock `json:"blocks"`
	}
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	updated, err := h.svc.UpdateMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId"), in.Blocks)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"message": updated,
	})
}

func (h *ConversationHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ConversationHandler) BranchFromMessage(w http.ResponseWriter, r *http.Request) {
	detail, err := h.svc.BranchFromMessage(r.Context(), r.PathValue("id"), r.PathValue("messageId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, detail)
}

func (h *ConversationHandler) ListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := h.svc.ListGroups(r.Context(), r.URL.Query().Get("assistantId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"groups": groups,
	})
}

func (h *ConversationHandler) CreateGroup(w http.ResponseWriter, r *http.Request) {
	var in service.CreateGroupInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	res, err := h.svc.CreateGroup(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, res)
}

func (h *ConversationHandler) ReorderGroups(w http.ResponseWriter, r *http.Request) {
	var in service.ReorderGroupsInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	snap, err := h.svc.ReorderGroups(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, snap)
}

func (h *ConversationHandler) RenameGroup(w http.ResponseWriter, r *http.Request) {
	var in service.RenameGroupInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	res, err := h.svc.RenameGroup(r.Context(), r.PathValue("id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *ConversationHandler) DeleteGroup(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.DeleteGroup(r.Context(), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

func (h *ConversationHandler) CleanupUngrouped(w http.ResponseWriter, r *http.Request) {
	deleted, err := h.svc.CleanupUngrouped(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *ConversationHandler) Batch(w http.ResponseWriter, r *http.Request) {
	var in service.BatchConversationsInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	snap, err := h.svc.BatchConversations(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, snap)
}

func (h *ConversationHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	var in service.ReorderConversationsInput
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	snap, err := h.svc.ReorderConversations(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, snap)
}
