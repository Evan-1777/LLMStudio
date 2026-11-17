package mcp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
)

type sseFrame struct {
	ID    string
	Event string
	Data  string
}

func scanSSE(ctx context.Context, body io.Reader, handle func(sseFrame) error) error {
	reader := bufio.NewReaderSize(body, 64*1024)

	var (
		idValue   string
		eventName string
		dataLines []string
	)

	dispatch := func() error {
		if idValue == "" && eventName == "" && len(dataLines) == 0 {
			return nil
		}
		frame := sseFrame{
			ID:    idValue,
			Event: eventName,
			Data:  strings.Join(dataLines, "\n"),
		}
		idValue = ""
		eventName = ""
		dataLines = dataLines[:0]
		return handle(frame)
	}

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")
			if trimmed == "" {
				if handleErr := dispatch(); handleErr != nil {
					return handleErr
				}
			} else if !strings.HasPrefix(trimmed, ":") {
				field, value, hasColon := strings.Cut(trimmed, ":")
				if hasColon && strings.HasPrefix(value, " ") {
					value = value[1:]
				}
				switch field {
				case "event":
					eventName = value
				case "data":
					dataLines = append(dataLines, value)
				case "id":
					if !strings.ContainsRune(value, '\x00') {
						idValue = value
					}
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if err := ctx.Err(); err != nil {
					return err
				}
				return dispatch()
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			return fmt.Errorf("read MCP SSE stream: %w", err)
		}
	}
}
