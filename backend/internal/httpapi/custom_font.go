package httpapi

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
)

// CustomFontHandler serves authenticated metadata, upload, toggle, delete, and binary file routes.
type CustomFontHandler struct {
	svc *service.CustomFontService
}

// NewCustomFontHandler constructs a CustomFontHandler.
func NewCustomFontHandler(svc *service.CustomFontService) *CustomFontHandler {
	return &CustomFontHandler{svc: svc}
}

type customFontEnvelope struct {
	Font *domain.CustomFontMeta `json:"font"`
}

func (h *CustomFontHandler) Get(w http.ResponseWriter, r *http.Request) {
	meta, err := h.svc.GetMeta(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	WriteJSON(w, http.StatusOK, customFontEnvelope{Font: meta})
}

func (h *CustomFontHandler) Put(w http.ResponseWriter, r *http.Request) {
	rawName := strings.TrimSpace(r.Header.Get("X-Font-Name"))
	if rawName == "" {
		WriteError(w, http.StatusBadRequest, domain.ErrCodeInvalidArgument, "missing X-Font-Name header")
		return
	}
	decodedName, err := url.PathUnescape(rawName)
	if err != nil {
		WriteError(w, http.StatusBadRequest, domain.ErrCodeInvalidArgument, "invalid X-Font-Name encoding")
		return
	}
	if _, err := domain.ValidateCustomFontName(decodedName); err != nil {
		writeServiceError(w, err)
		return
	}
	if r.ContentLength > domain.CustomFontMaxBytes {
		WriteError(w, http.StatusRequestEntityTooLarge, domain.ErrCodePayloadTooLarge, "字体文件不能超过 32 MiB")
		return
	}

	data, err := io.ReadAll(io.LimitReader(r.Body, domain.CustomFontMaxBytes+1))
	if err != nil {
		WriteError(w, http.StatusBadRequest, domain.ErrCodeInvalidArgument, "failed to read font payload")
		return
	}
	if len(data) > domain.CustomFontMaxBytes {
		WriteError(w, http.StatusRequestEntityTooLarge, domain.ErrCodePayloadTooLarge, "字体文件不能超过 32 MiB")
		return
	}

	meta, err := h.svc.Put(r.Context(), decodedName, data)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, customFontEnvelope{Font: &meta})
}

func (h *CustomFontHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeJSONBody(r, &in); err != nil {
		writeServiceError(w, err)
		return
	}
	if in.Enabled == nil {
		WriteError(w, http.StatusBadRequest, domain.ErrCodeInvalidArgument, "enabled field is required")
		return
	}
	meta, err := h.svc.SetEnabled(r.Context(), *in.Enabled)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, customFontEnvelope{Font: &meta})
}

func (h *CustomFontHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context()); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *CustomFontHandler) GetFile(w http.ResponseWriter, r *http.Request) {
	rec, err := h.svc.GetFile(r.Context())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if rec == nil {
		WriteError(w, http.StatusNotFound, domain.ErrCodeNotFound, "custom font not found")
		return
	}

	etag := fmt.Sprintf("\"%s\"", rec.SHA256)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")

	if matchesCurrentETag(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "font/ttf")
	w.Header().Set("Content-Length", strconv.Itoa(len(rec.Data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rec.Data)
}

func matchesCurrentETag(ifNoneMatch, currentETag string) bool {
	if strings.TrimSpace(ifNoneMatch) == "" || currentETag == "" {
		return false
	}
	for _, part := range strings.Split(ifNoneMatch, ",") {
		candidate := strings.TrimSpace(part)
		if candidate == currentETag {
			return true
		}
	}
	return false
}
