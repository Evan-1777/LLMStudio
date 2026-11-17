package httpapi

import (
	"encoding/json"
	"io"
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func decodeJSONBody(r *http.Request, dst any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024))
	if err := dec.Decode(dst); err != nil {
		return domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err)
	}
	return nil
}

func writeServiceError(w http.ResponseWriter, err error) {
	if appErr, ok := domain.AsAppError(err); ok {
		WriteError(w, appErr.HTTPStatus(), appErr.Code, appErr.Message)
		return
	}
	WriteError(w, http.StatusInternalServerError, domain.ErrCodeInternalError, err.Error())
}

// HandleListFormats returns all registered APIFormat metadata entries.
func HandleListFormats(formats *plugin.FormatRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{
			"formats": formats.List(),
		})
	}
}
