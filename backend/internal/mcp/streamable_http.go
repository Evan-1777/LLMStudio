package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"

	"llmstudio/backend/internal/domain"
)

var errSSECallCompleted = errors.New("mcp sse call response received")

type streamableHTTPTransport struct {
	server    domain.MCPServerConfig
	baseURL   *url.URL
	client    *http.Client
	peer      *rpcPeer
	closing   atomic.Bool
	dead      atomic.Bool
	doneCh    chan struct{}
	closeOnce sync.Once

	stateMu   sync.RWMutex
	sessionID string
	version   string
	fatalErr  error
}

func startStreamableHTTPTransport(
	baseClient *http.Client,
	server domain.MCPServerConfig,
	onNotify func(method string, params json.RawMessage),
) (*streamableHTTPTransport, error) {
	u, err := parseEndpointURL(server.Endpoint)
	if err != nil {
		return nil, err
	}
	client := newScopedHTTPClient(baseClient, u, server, 0)
	t := &streamableHTTPTransport{
		server:  server,
		baseURL: u,
		client:  client,
		doneCh:  make(chan struct{}),
	}
	t.peer = newRPCPeer(t.postRaw, func(method string, params json.RawMessage) {
		if onNotify != nil {
			onNotify(method, params)
		}
	})
	return t, nil
}

func (t *streamableHTTPTransport) SetProtocolVersion(version string) {
	t.stateMu.Lock()
	t.version = version
	t.stateMu.Unlock()
}

func (t *streamableHTTPTransport) ProtocolVersion() string {
	t.stateMu.RLock()
	defer t.stateMu.RUnlock()
	return t.version
}

func (t *streamableHTTPTransport) setSessionID(sid string) {
	trimmed := strings.TrimSpace(sid)
	if trimmed == "" {
		return
	}
	t.stateMu.Lock()
	t.sessionID = trimmed
	t.stateMu.Unlock()
}

func (t *streamableHTTPTransport) currentHeaders() (sessionID, version string) {
	t.stateMu.RLock()
	sessionID = t.sessionID
	version = t.version
	t.stateMu.RUnlock()
	return sessionID, version
}

func (t *streamableHTTPTransport) Alive() bool {
	return !t.closing.Load() && !t.dead.Load()
}

func (t *streamableHTTPTransport) Done() <-chan struct{} {
	return t.doneCh
}

func (t *streamableHTTPTransport) markDead(err error) {
	t.stateMu.Lock()
	if t.fatalErr == nil {
		t.fatalErr = err
	}
	t.stateMu.Unlock()
	t.dead.Store(true)
	t.closeOnce.Do(func() {
		close(t.doneCh)
	})
}

func (t *streamableHTTPTransport) postRaw(ctx context.Context, payload []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	applyConfiguredHeaders(req, t.baseURL, t.server)

	sid, ver := t.currentHeaders()
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	if ver != "" {
		req.Header.Set("MCP-Protocol-Version", ver)
	}

	resp, err := t.client.Do(req)
	if err != nil {
		return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP HTTP POST failed for %q: %v", t.server.Name, redactSecrets(err.Error(), t.server)), err)
	}
	defer resp.Body.Close()

	t.setSessionID(resp.Header.Get("Mcp-Session-Id"))
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusNotFound && sid != "" {
			err := httpStatusError(t.server, resp.StatusCode, resp.Status, resp.Body)
			t.markDead(err)
			return err
		}
		return httpStatusError(t.server, resp.StatusCode, resp.Status, resp.Body)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return nil
}

func (t *streamableHTTPTransport) Notify(ctx context.Context, method string, params any) error {
	if !t.Alive() {
		return errors.New("mcp streamable-http session is closed")
	}
	payload, err := encodeRPCNotification(method, params)
	if err != nil {
		return err
	}
	return t.postRaw(ctx, payload)
}

func (t *streamableHTTPTransport) Call(ctx context.Context, method string, params any) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !t.Alive() {
		return nil, errors.New("mcp streamable-http session is closed")
	}

	id, idKey := t.peer.allocID()
	payload, err := encodeRPCRequest(id, method, params)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	applyConfiguredHeaders(req, t.baseURL, t.server)

	sid, ver := t.currentHeaders()
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	if ver != "" {
		req.Header.Set("MCP-Protocol-Version", ver)
	}

	waitCh := t.peer.registerWaiter(idKey)
	defer t.peer.unregisterWaiter(idKey)

	resp, err := t.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			t.sendCancelledBestEffort(id)
			return nil, ctx.Err()
		}
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP request failed for %q: %v", t.server.Name, redactSecrets(err.Error(), t.server)), err)
	}
	defer resp.Body.Close()

	t.setSessionID(resp.Header.Get("Mcp-Session-Id"))

	if resp.StatusCode >= 400 {
		statusErr := httpStatusError(t.server, resp.StatusCode, resp.Status, resp.Body)
		if resp.StatusCode == http.StatusNotFound && sid != "" {
			t.markDead(statusErr)
		}
		return nil, statusErr
	}
	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusNoContent {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP server %q returned HTTP %d without JSON-RPC response for %s", t.server.Name, resp.StatusCode, method), nil)
	}

	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	switch mediaType {
	case "text/event-stream":
		var delivered *rpcResultMsg
		scanErr := scanSSE(ctx, resp.Body, func(frame sseFrame) error {
			if frame.Event != "" && frame.Event != "message" {
				return nil
			}
			trimmed := strings.TrimSpace(frame.Data)
			if trimmed == "" {
				return nil
			}
			if handleErr := t.peer.handleIncoming(ctx, []byte(trimmed)); handleErr != nil {
				return handleErr
			}
			select {
			case msg := <-waitCh:
				delivered = &msg
				return errSSECallCompleted
			default:
				return nil
			}
		})
		if delivered != nil {
			if delivered.err != nil {
				return nil, delivered.err
			}
			if delivered.rpcErr != nil {
				return nil, delivered.rpcErr
			}
			return delivered.result, nil
		}
		if ctx.Err() != nil {
			t.sendCancelledBestEffort(id)
			return nil, ctx.Err()
		}
		if scanErr != nil && !errors.Is(scanErr, errSSECallCompleted) {
			return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP SSE response error from %q: %v", t.server.Name, scanErr), scanErr)
		}
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP stream ended before delivering response for %s", method), nil)

	case "application/json", "":
		rawBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponseBodyBytes+1))
		if readErr != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("read MCP response from %q: %v", t.server.Name, readErr), readErr)
		}
		if len(rawBody) > maxHTTPResponseBodyBytes {
			return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP response from %q exceeds size limit", t.server.Name), nil)
		}
		if err := t.peer.handleIncoming(ctx, rawBody); err != nil {
			return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("invalid MCP JSON-RPC response from %q: %v", t.server.Name, err), err)
		}
		select {
		case msg := <-waitCh:
			if msg.err != nil {
				return nil, msg.err
			}
			if msg.rpcErr != nil {
				return nil, msg.rpcErr
			}
			return msg.result, nil
		default:
			return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP response from %q did not match request ID %d", t.server.Name, id), nil)
		}

	default:
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("unexpected MCP response content-type %q from %q", mediaType, t.server.Name), nil)
	}
}

func (t *streamableHTTPTransport) sendCancelledBestEffort(reqID int64) {
	cancelCtx, cancel := context.WithTimeout(context.Background(), cancelNotifyTimeout)
	defer cancel()
	payload, err := encodeRPCNotification("notifications/cancelled", map[string]any{
		"requestId": reqID,
		"reason":    "client request cancelled",
	})
	if err != nil {
		return
	}
	_ = t.postRaw(cancelCtx, payload)
}

func (t *streamableHTTPTransport) Close() error {
	t.closing.Store(true)
	t.closeOnce.Do(func() {
		close(t.doneCh)
	})
	sid, ver := t.currentHeaders()
	if sid == "" {
		return nil
	}
	delCtx, cancel := context.WithTimeout(context.Background(), deleteSessionTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(delCtx, http.MethodDelete, t.baseURL.String(), nil)
	if err != nil {
		return nil
	}
	applyConfiguredHeaders(req, t.baseURL, t.server)
	req.Header.Set("Mcp-Session-Id", sid)
	if ver != "" {
		req.Header.Set("MCP-Protocol-Version", ver)
	}
	resp, err := t.client.Do(req)
	if err == nil && resp != nil {
		_ = resp.Body.Close()
	}
	return nil
}
