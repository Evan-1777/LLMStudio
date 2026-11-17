package httpapi

import "net/http"

const appVersion = "0.1.0"

// HandleHealthz responds with service liveness and version metadata.
func HandleHealthz(w http.ResponseWriter, r *http.Request) {
	NewHealthHandler(false)(w, r)
}

// NewHealthHandler responds with service liveness, version, and whether Bearer auth is required.
func NewHealthHandler(authRequired bool) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{
			"status":       "ok",
			"version":      appVersion,
			"authRequired": authRequired,
		})
	}
}
