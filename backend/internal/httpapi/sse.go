package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"

	"llmstudio/backend/internal/domain"
)

// SSEWriter manages standard Server-Sent Events headers and JSON frame flushing.
type SSEWriter struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	started bool
}

// NewSSEWriter constructs an SSEWriter bound to w.
func NewSSEWriter(w http.ResponseWriter) *SSEWriter {
	return &SSEWriter{
		w:  w,
		rc: http.NewResponseController(w),
	}
}

// Started reports whether SSE response headers have already been written.
func (s *SSEWriter) Started() bool {
	return s.started
}

// Start writes standard SSE response headers and flushes once. Subsequent calls are no-ops.
func (s *SSEWriter) Start() {
	if s.started {
		return
	}
	s.started = true
	s.w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	s.w.Header().Set("Cache-Control", "no-cache")
	s.w.Header().Set("Connection", "keep-alive")
	s.w.Header().Set("X-Accel-Buffering", "no")
	s.w.WriteHeader(http.StatusOK)
	_ = s.rc.Flush()
}

// WriteEvent ensures SSE headers are sent, writes one JSON event frame, and flushes.
func (s *SSEWriter) WriteEvent(ev domain.StreamEvent) error {
	s.Start()
	payload, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
		return err
	}
	return s.rc.Flush()
}

// StreamSSEToolEvents executes run and streams emitted events over SSE.
// Errors returned before any event is written are delegated to onPreHeaderError;
// errors returned mid-stream are emitted as a terminal SSE error event.
func StreamSSEToolEvents(
	w http.ResponseWriter,
	conversationID string,
	onPreHeaderError func(http.ResponseWriter, error),
	run func(emit func(domain.StreamEvent) error) error,
) {
	sse := NewSSEWriter(w)
	if err := run(sse.WriteEvent); err != nil {
		if !sse.Started() {
			onPreHeaderError(w, err)
			return
		}
		_ = sse.WriteEvent(domain.StreamEvent{
			Type:           domain.StreamEventError,
			ConversationID: conversationID,
			Error: &domain.StreamError{
				Code:    domain.ErrCodeInternalError,
				Message: err.Error(),
			},
		})
		return
	}
	if !sse.Started() {
		sse.Start()
	}
}
