package format

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
)

const maxSSELineBytes = 2 * 1024 * 1024 // 2MB per-line buffer limit

// SSEFrame represents a single parsed Server-Sent Events frame.
type SSEFrame struct {
	Event string
	Data  string
}

// ScanSSE reads SSE frames from body and invokes handle for each complete frame.
// Comments (lines beginning with ':') are ignored, multi-line data fields are joined with '\n',
// and context cancellation aborts scanning immediately.
func ScanSSE(ctx context.Context, body io.Reader, handle func(SSEFrame) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), maxSSELineBytes)

	var (
		eventName string
		dataLines []string
	)

	dispatch := func() error {
		if eventName == "" && len(dataLines) == 0 {
			return nil
		}
		frame := SSEFrame{
			Event: eventName,
			Data:  strings.Join(dataLines, "\n"),
		}
		eventName = ""
		dataLines = dataLines[:0]
		return handle(frame)
	}

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, hasColon := strings.Cut(line, ":")
		if hasColon && strings.HasPrefix(value, " ") {
			value = value[1:]
		}
		switch field {
		case "event":
			eventName = value
		case "data":
			dataLines = append(dataLines, value)
		}
	}

	if err := scanner.Err(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("read SSE stream: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return dispatch()
}
