package desktop

import (
	"errors"
	"io"
	"net/http"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
)

func (s *Server) dispatchAgent(local http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, err := scopeFromRequest(r)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		if scope == plugin.ExecutionScopeLocal {
			local(w, r)
			return
		}
		if s.cfg.Cloud == nil || !s.cfg.Cloud.IsConfigured() {
			httpapi.WriteError(w, http.StatusServiceUnavailable, domain.ErrCodeCloudNotConnected, "cloud gateway is not connected")
			return
		}
		ctx, release := s.cfg.Cloud.bind(r.Context())
		defer release()
		q := r.URL.Query()
		q.Del("scope")
		target := r.URL.EscapedPath()
		if len(q) > 0 {
			target += "?" + q.Encode()
		}
		maxBody := int64(64 << 10)
		switch {
		case (r.Method == http.MethodPut || r.Method == http.MethodPost) && r.URL.Path == "/api/v1/agent/workspace/file":
			maxBody = 3 << 20
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agent/workspace/upload":
			maxBody = (32 << 20) + (64 << 10)
		}
		resp, err := s.cfg.Cloud.proxyRequest(ctx, r.Method, target, r.Header, http.MaxBytesReader(w, r.Body, maxBody), r.ContentLength)
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeDesktopError(w, domain.NewError(domain.ErrCodePayloadTooLarge, "请求体超过大小限制", err))
				return
			}
			writeDesktopError(w, err)
			return
		}
		copyAgentResponse(w, resp, false)
	}
}

func copyAgentResponse(w http.ResponseWriter, resp *http.Response, stream bool) {
	defer resp.Body.Close()
	for _, key := range []string{"Content-Type", "Cache-Control", "X-Accel-Buffering", "Content-Disposition", "Content-Length", "X-Content-Type-Options"} {
		if value := resp.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if stream && resp.StatusCode == http.StatusOK {
		controller := http.NewResponseController(w)
		if controller.Flush() != nil {
			return
		}
		buf := make([]byte, 16<<10)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, err := w.Write(buf[:n]); err != nil {
					return
				}
				if controller.Flush() != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}
	_, _ = io.Copy(w, resp.Body)
}
