package httpapi

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
)

const maxWorkspaceUploadBodyBytes = 32 << 20

// RegisterAgentRoutes mounts policy and directory selection, not native execution.
// The optional dispatch wrapper separates desktop local requests from its cloud proxy.
func RegisterAgentRoutes(mux *http.ServeMux, runtime *agent.Runtime, dispatch func(http.HandlerFunc) http.HandlerFunc) {
	mount := func(route string, f http.HandlerFunc) {
		if dispatch != nil {
			f = dispatch(f)
		}
		mux.HandleFunc(route, f)
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
	mount("GET /api/v1/agent/workspace/entries", func(w http.ResponseWriter, r *http.Request) {
		data, err := runtime.ListWorkspaceEntries(r.Context(), r.URL.Query().Get("path"))
		writeAgent(w, data, err)
	})
	mount("GET /api/v1/agent/workspace/file", func(w http.ResponseWriter, r *http.Request) {
		data, err := runtime.ReadWorkspaceFile(r.Context(), r.URL.Query().Get("path"))
		writeAgent(w, data, err)
	})
	mount("PUT /api/v1/agent/workspace/file", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path         string `json:"path"`
			Content      string `json:"content"`
			ExpectedETag string `json:"expectedEtag"`
		}
		if err := decodeJSONBodyWithLimit(r, &in, 3<<20); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.WriteWorkspaceFile(r.Context(), in.Path, in.Content, in.ExpectedETag)
		writeAgent(w, data, err)
	})
	mount("POST /api/v1/agent/workspace/file", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := decodeJSONBodyWithLimit(r, &in, 3<<20); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.CreateWorkspaceFile(r.Context(), in.Path, in.Content)
		writeAgentStatus(w, http.StatusCreated, data, err)
	})
	mount("POST /api/v1/agent/workspace/dir", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path string `json:"path"`
		}
		if err := decodeJSONBodyWithLimit(r, &in, 64<<10); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.CreateWorkspaceDir(r.Context(), in.Path)
		writeAgentStatus(w, http.StatusCreated, data, err)
	})
	mount("POST /api/v1/agent/workspace/move", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			FromPath string `json:"fromPath"`
			ToPath   string `json:"toPath"`
		}
		if err := decodeJSONBodyWithLimit(r, &in, 64<<10); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.MoveWorkspaceEntry(r.Context(), in.FromPath, in.ToPath)
		writeAgent(w, data, err)
	})
	mount("POST /api/v1/agent/workspace/copy", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			FromPath string `json:"fromPath"`
			ToPath   string `json:"toPath"`
		}
		if err := decodeJSONBodyWithLimit(r, &in, 64<<10); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.CopyWorkspaceEntry(r.Context(), in.FromPath, in.ToPath)
		writeAgentStatus(w, http.StatusCreated, data, err)
	})
	mount("DELETE /api/v1/agent/workspace/entry", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := runtime.DeleteWorkspaceEntry(r.Context(), r.URL.Query().Get("path")); err != nil {
			writeServiceError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mount("POST /api/v1/agent/workspace/batch", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Operation string   `json:"operation"`
			Paths     []string `json:"paths"`
			TargetDir string   `json:"targetDir"`
		}
		if err := decodeJSONBodyWithLimit(r, &in, 64<<10); err != nil {
			writeServiceError(w, err)
			return
		}
		data, err := runtime.BatchWorkspaceEntries(r.Context(), in.Operation, in.Paths, in.TargetDir)
		writeAgent(w, data, err)
	})
	mount("POST /api/v1/agent/workspace/upload", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.ContentLength > maxWorkspaceUploadBodyBytes {
			writeServiceError(w, domain.NewError(domain.ErrCodePayloadTooLarge, "上传文件不能超过 32 MiB", nil))
			return
		}
		q := r.URL.Query()
		ov := strings.ToLower(strings.TrimSpace(q.Get("overwrite")))
		overwrite := ov == "true" || ov == "1"
		data, err := runtime.UploadWorkspaceFile(r.Context(), q.Get("path"), r.Body, overwrite)
		writeAgentStatus(w, http.StatusCreated, data, err)
	})
	mount("GET /api/v1/agent/workspace/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		f, info, base, closeFn, err := runtime.OpenWorkspaceFileDownload(r.Context(), r.URL.Query().Get("path"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		defer closeFn()

		contentType := mime.TypeByExtension(path.Ext(base))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", formatAttachmentDisposition(base))
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, f)
	})
	mount("GET /api/v1/agent/workspace/search", func(w http.ResponseWriter, r *http.Request) {
		data, err := runtime.SearchWorkspaceEntries(r.Context(), r.URL.Query().Get("q"))
		writeAgent(w, data, err)
	})
}

func formatAttachmentDisposition(filename string) string {
	var ascii strings.Builder
	for i := 0; i < len(filename); i++ {
		c := filename[i]
		if c >= 0x20 && c < 0x7f && c != '"' && c != '\\' && c != ';' {
			ascii.WriteByte(c)
		} else {
			ascii.WriteByte('_')
		}
	}
	fallback := ascii.String()
	if fallback == "" {
		fallback = "download"
	}
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", fallback, url.PathEscape(filename))
}

func writeAgent(w http.ResponseWriter, data any, err error) {
	writeAgentStatus(w, http.StatusOK, data, err)
}

func writeAgentStatus(w http.ResponseWriter, status int, data any, err error) {
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		writeServiceError(w, err)
		return
	}
	WriteJSON(w, status, data)
}
