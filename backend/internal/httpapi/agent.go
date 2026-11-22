package httpapi

import (
	"net/http"

	"llmstudio/backend/internal/agent"
)

// RegisterAgentRoutes mounts policy and directory selection, not native execution.
// The optional dispatch wrapper separates desktop local requests from its cloud proxy.
func RegisterAgentRoutes(mux *http.ServeMux, runtime *agent.Runtime, dispatch func(http.HandlerFunc) http.HandlerFunc) {
	mount := func(path string, f http.HandlerFunc) {
		if dispatch != nil {
			f = dispatch(f)
		}
		mux.HandleFunc(path, f)
	}
	mount("GET /api/v1/agent/settings", func(w http.ResponseWriter, r *http.Request) {
		data, err := runtime.Settings(r.Context())
		writeAgent(w, data, err)
	})
	mount("PATCH /api/v1/agent/settings", func(w http.ResponseWriter, r *http.Request) {
		var patch agent.SettingsPatch
		if err := decodeJSONBody(r, &patch); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.UpdateSettings(r.Context(), patch)
		writeAgent(w, data, err)
	})
	mount("GET /api/v1/agent/directories", func(w http.ResponseWriter, r *http.Request) {
		data, err := runtime.ListDirectories(r.Context(), r.URL.Query().Get("path"))
		writeAgent(w, data, err)
	})
	mount("GET /api/v1/agent/conversations/{id}/directory", func(w http.ResponseWriter, r *http.Request) {
		data, err := runtime.TopicDirectory(r.Context(), r.PathValue("id"))
		writeAgent(w, data, err)
	})
	mount("PUT /api/v1/agent/conversations/{id}/directory", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path string `json:"path"`
		}
		if err := decodeJSONBody(r, &in); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.UpdateTopic(r.Context(), r.PathValue("id"), in.Path)
		writeAgent(w, data, err)
	})
}

func writeAgent(w http.ResponseWriter, data any, err error) {
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, data)
}
