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

type sseTransport struct {
	server        domain.MCPServerConfig
	configuredURL *url.URL
	postClient    *http.Client
	peer          *rpcPeer

	sessionCtx    context.Context
	sessionCancel context.CancelFunc
	closing       atomic.Bool
	closeOnce     sync.Once
	doneCh        chan struct{}
	loopDoneCh    chan struct{}

	endpointOnce  sync.Once
	endpointReady chan struct{}

	stateMu   sync.RWMutex
	postURL   *url.URL
	version   string
	fatalErr  error
}

func startSSETransport(
	ctx context.Context,
	baseClient *http.Client,
	server domain.MCPServerConfig,
	onNotify func(method string, params json.RawMessage),
) (*sseTransport, error) {
	u, err := parseEndpointURL(server.Endpoint)
	if err != nil {
		return nil, err
	}
	streamClient := newScopedHTTPClient(baseClient, u, server, 0)
	postClient := newScopedHTTPClient(baseClient, u, server, defaultHTTPClientTimeout)
	if baseClient != nil && baseClient.Timeout > 0 {
		postClient = newScopedHTTPClient(baseClient, u, server, baseClient.Timeout)
	}

	sessionCtx, sessionCancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(sessionCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		sessionCancel()
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	applyConfiguredHeaders(req, u, server)

	resp, err := streamClient.Do(req)
	if err != nil {
		sessionCancel()
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("connect MCP SSE server %q: %v", server.Name, redactSecrets(err.Error(), server)), err)
	}
	if resp.StatusCode >= 400 {
		err := httpStatusError(server, resp.StatusCode, resp.Status, resp.Body)
		_ = resp.Body.Close()
		sessionCancel()
		return nil, err
	}

	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if mediaType != "" && mediaType != "text/event-stream" {
		_ = resp.Body.Close()
		sessionCancel()
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP SSE endpoint %q returned unexpected content-type %q", server.Name, mediaType), nil)
	}

	t := &sseTransport{
		server:        server,
		configuredURL: u,
		postClient:    postClient,
		sessionCtx:    sessionCtx,
		sessionCancel: sessionCancel,
		doneCh:        make(chan struct{}),
		loopDoneCh:    make(chan struct{}),
		endpointReady: make(chan struct{}),
	}
	t.peer = newRPCPeer(t.postRaw, func(method string, params json.RawMessage) {
		if onNotify != nil {
			onNotify(method, params)
		}
	})

	go t.readLoop(resp)

	select {
	case <-t.endpointReady:
		return t, nil
	case <-t.doneCh:
		_ = t.Close()
		return nil, t.exitError()
	case <-ctx.Done():
		_ = t.Close()
		return nil, ctx.Err()
	}
}

func (t *sseTransport) SetProtocolVersion(version string) {
	t.stateMu.Lock()
	t.version = version
	t.stateMu.Unlock()
}

func (t *sseTransport) ProtocolVersion() string {
	t.stateMu.RLock()
	defer t.stateMu.RUnlock()
	return t.version
}

func (t *sseTransport) Alive() bool {
	select {
	case <-t.doneCh:
		return false
	default:
		return !t.closing.Load()
	}
}

func (t *sseTransport) Done() <-chan struct{} {
	return t.doneCh
}

func (t *sseTransport) currentPostURL() (*url.URL, string, error) {
	t.stateMu.RLock()
	u := t.postURL
	ver := t.version
	t.stateMu.RUnlock()
	if u == nil {
		return nil, "", errors.New("mcp sse message endpoint not established")
	}
	return u, ver, nil
}

func (t *sseTransport) readLoop(resp *http.Response) {
	defer close(t.loopDoneCh)
	defer resp.Body.Close()

	baseReqURL := resp.Request.URL
	if baseReqURL == nil {
		baseReqURL = t.configuredURL
	}

	scanErr := scanSSE(t.sessionCtx, resp.Body, func(frame sseFrame) error {
		switch frame.Event {
		case "endpoint":
			rawEP := strings.TrimSpace(frame.Data)
			if rawEP == "" {
				return errors.New("empty mcp sse endpoint event")
			}
			rel, err := url.Parse(rawEP)
			if err != nil {
				return fmt.Errorf("invalid mcp sse endpoint %q: %w", rawEP, err)
			}
			resolved := baseReqURL.ResolveReference(rel)
			scheme := strings.ToLower(resolved.Scheme)
			if (scheme != "http" && scheme != "https") || resolved.Host == "" {
				return fmt.Errorf("invalid resolved mcp sse endpoint scheme %q", resolved.Scheme)
			}
			resolved.Scheme = scheme
			t.stateMu.Lock()
			t.postURL = resolved
			t.stateMu.Unlock()
			t.endpointOnce.Do(func() {
				close(t.endpointReady)
			})
			return nil

		case "", "message":
			trimmed := strings.TrimSpace(frame.Data)
			if trimmed == "" {
				return nil
			}
			return t.peer.handleIncoming(t.sessionCtx, []byte(trimmed))
		default:
			return nil
		}
	})

	finalErr := t.buildStreamError(scanErr)
	t.stateMu.Lock()
	if t.fatalErr == nil {
		t.fatalErr = finalErr
	}
	t.stateMu.Unlock()
	t.closeOnce.Do(func() {
		close(t.doneCh)
	})
	t.peer.failAllPending(finalErr)
}

func (t *sseTransport) buildStreamError(scanErr error) error {
	if t.closing.Load() {
		return errors.New("mcp sse session closed")
	}
	if scanErr != nil {
		return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP SSE stream closed for %q: %v", t.server.Name, redactSecrets(scanErr.Error(), t.server)), scanErr)
	}
	return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP SSE stream ended unexpectedly for %q", t.server.Name), nil)
}

func (t *sseTransport) exitError() error {
	t.stateMu.RLock()
	err := t.fatalErr
	t.stateMu.RUnlock()
	if err != nil {
		return err
	}
	return errors.New("mcp sse session closed")
}

func (t *sseTransport) postRaw(ctx context.Context, payload []byte) error {
	postURL, ver, err := t.currentPostURL()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, postURL.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	// Only attach configured custom headers if POST endpoint stays on configured origin.
	applyConfiguredHeaders(req, t.configuredURL, t.server)
	if ver != "" {
		req.Header.Set("MCP-Protocol-Version", ver)
	}

	resp, err := t.postClient.Do(req)
	if err != nil {
		return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("MCP SSE POST failed for %q: %v", t.server.Name, redactSecrets(err.Error(), t.server)), err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return httpStatusError(t.server, resp.StatusCode, resp.Status, resp.Body)
	}

	// Some hybrid servers also echo synchronous JSON-RPC payloads directly in POST response.
	mediaType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if mediaType == "application/json" {
		rawBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxHTTPResponseBodyBytes))
		if readErr == nil && len(bytes.TrimSpace(rawBody)) > 0 {
			_ = t.peer.handleIncoming(ctx, rawBody)
		}
		return nil
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return nil
}

func (t *sseTransport) Notify(ctx context.Context, method string, params any) error {
	if !t.Alive() {
		return t.exitError()
	}
	payload, err := encodeRPCNotification(method, params)
	if err != nil {
		return err
	}
	return t.postRaw(ctx, payload)
}

func (t *sseTransport) Call(ctx context.Context, method string, params any) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !t.Alive() {
		return nil, t.exitError()
	}

	id, idKey := t.peer.allocID()
	payload, err := encodeRPCRequest(id, method, params)
	if err != nil {
		return nil, err
	}

	waitCh := t.peer.registerWaiter(idKey)
	if err := t.postRaw(ctx, payload); err != nil {
		t.peer.unregisterWaiter(idKey)
		return nil, err
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
	case <-t.doneCh:
		t.peer.unregisterWaiter(idKey)
		return nil, t.exitError()
	case <-ctx.Done():
		t.peer.unregisterWaiter(idKey)
		cancelCtx, cancel := context.WithTimeout(context.Background(), cancelNotifyTimeout)
		defer cancel()
		_ = t.Notify(cancelCtx, "notifications/cancelled", map[string]any{
			"requestId": id,
			"reason":    "client request cancelled",
		})
		return nil, ctx.Err()
	}
}

func (t *sseTransport) Close() error {
	t.closing.Store(true)
	t.sessionCancel()
	t.closeOnce.Do(func() {
		close(t.doneCh)
	})
	<-t.loopDoneCh
	return nil
}
