package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	jsonRPCVersion        = "2.0"
	jsonRPCMethodNotFound = -32601
)

// RPCError represents a JSON-RPC 2.0 error object returned by an MCP server.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("mcp rpc error (%d): %s", e.Code, e.Message)
}

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type rpcResultMsg struct {
	result json.RawMessage
	rpcErr *RPCError
	err    error
}

type rpcPeer struct {
	nextID atomic.Int64

	pendingMu sync.Mutex
	pending   map[string]chan rpcResultMsg

	sendFn   func(ctx context.Context, payload []byte) error
	onNotify func(method string, params json.RawMessage)
}

func newRPCPeer(
	sendFn func(ctx context.Context, payload []byte) error,
	onNotify func(method string, params json.RawMessage),
) *rpcPeer {
	return &rpcPeer{
		pending:  make(map[string]chan rpcResultMsg),
		sendFn:   sendFn,
		onNotify: onNotify,
	}
}

func (p *rpcPeer) allocID() (int64, string) {
	id := p.nextID.Add(1)
	return id, strconv.FormatInt(id, 10)
}

func (p *rpcPeer) registerWaiter(idKey string) chan rpcResultMsg {
	ch := make(chan rpcResultMsg, 1)
	p.pendingMu.Lock()
	p.pending[idKey] = ch
	p.pendingMu.Unlock()
	return ch
}

func (p *rpcPeer) unregisterWaiter(idKey string) {
	p.pendingMu.Lock()
	delete(p.pending, idKey)
	p.pendingMu.Unlock()
}

func (p *rpcPeer) failAllPending(err error) {
	p.pendingMu.Lock()
	waiters := make([]chan rpcResultMsg, 0, len(p.pending))
	for id, ch := range p.pending {
		waiters = append(waiters, ch)
		delete(p.pending, id)
	}
	p.pendingMu.Unlock()
	for _, ch := range waiters {
		select {
		case ch <- rpcResultMsg{err: err}:
		default:
		}
	}
}

func encodeRPCRequest(id int64, method string, params any) ([]byte, error) {
	req := struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int64  `json:"id"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{
		JSONRPC: jsonRPCVersion,
		ID:      id,
		Method:  method,
		Params:  params,
	}
	return json.Marshal(req)
}

func encodeRPCNotification(method string, params any) ([]byte, error) {
	notif := struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{
		JSONRPC: jsonRPCVersion,
		Method:  method,
		Params:  params,
	}
	return json.Marshal(notif)
}

func canonicalRPCID(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", false
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err == nil {
			return "s:" + s, true
		}
	}
	// Numbers match directly by lexical representation for JSON-RPC correlation.
	var n json.Number
	if err := json.Unmarshal(trimmed, &n); err == nil {
		return string(trimmed), true
	}
	return string(trimmed), true
}

func (p *rpcPeer) handleIncoming(ctx context.Context, raw []byte) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] == '[' {
		var batch []json.RawMessage
		if err := json.Unmarshal(trimmed, &batch); err != nil {
			return fmt.Errorf("invalid json-rpc batch payload: %w", err)
		}
		for _, item := range batch {
			if err := p.handleSingle(ctx, item); err != nil {
				return err
			}
		}
		return nil
	}
	return p.handleSingle(ctx, trimmed)
}

func (p *rpcPeer) handleSingle(ctx context.Context, raw json.RawMessage) error {
	var env rpcEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("invalid json-rpc message: %w", err)
	}
	idKey, hasID := canonicalRPCID(env.ID)
	hasMethod := strings.TrimSpace(env.Method) != ""

	// Response to client request.
	if hasID && !hasMethod {
		p.pendingMu.Lock()
		ch, ok := p.pending[idKey]
		if ok {
			delete(p.pending, idKey)
		}
		p.pendingMu.Unlock()
		if ok {
			ch <- rpcResultMsg{
				result: env.Result,
				rpcErr: env.Error,
			}
		}
		return nil
	}

	// Server notification.
	if !hasID && hasMethod {
		if p.onNotify != nil {
			p.onNotify(env.Method, env.Params)
		}
		return nil
	}

	// Server-initiated request: reply only to ping; reject unsupported capabilities (e.g. sampling/roots).
	if hasID && hasMethod {
		var replyBytes []byte
		var err error
		if env.Method == "ping" {
			replyBytes, err = json.Marshal(struct {
				JSONRPC string          `json:"jsonrpc"`
				ID      json.RawMessage `json:"id"`
				Result  struct{}        `json:"result"`
			}{
				JSONRPC: jsonRPCVersion,
				ID:      env.ID,
			})
		} else {
			replyBytes, err = json.Marshal(struct {
				JSONRPC string          `json:"jsonrpc"`
				ID      json.RawMessage `json:"id"`
				Error   RPCError        `json:"error"`
			}{
				JSONRPC: jsonRPCVersion,
				ID:      env.ID,
				Error: RPCError{
					Code:    jsonRPCMethodNotFound,
					Message: fmt.Sprintf("method not found: %s", env.Method),
				},
			})
		}
		if err != nil {
			return err
		}
		if p.sendFn != nil {
			// Best-effort response to server-initiated request so peer doesn't stall.
			_ = p.sendFn(ctx, replyBytes)
		}
		return nil
	}

	return errors.New("malformed json-rpc message: missing id and method")
}
