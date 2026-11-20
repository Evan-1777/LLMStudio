package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func decodeJSONBody(r *http.Request, dst any) error {
	return decodeJSONBodyWithLimit(r, dst, 16*1024*1024)
}

func decodeJSONBodyWithLimit(r *http.Request, dst any, maxBytes int64) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBytes))
	if err := dec.Decode(dst); err != nil {
		return domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err)
	}
	return nil
}

func decodeOptionalJSONBody(r *http.Request, dst any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 16*1024*1024))
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
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

// HandleListFormats returns all registered APIFormat metadata entries and optional adapter metadata.
func HandleListFormats(formats *plugin.FormatRegistry, adapters *plugin.ProviderRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		resp := map[string]any{
			"formats": formats.List(),
		}
		if adapters != nil {
			resp["adapters"] = adapters.List()
		}
		WriteJSON(w, http.StatusOK, resp)
	}
}
