package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	defaultProtocolVersion = "2025-11-25"
	maxToolListPages       = 200
)

type initializeResult struct {
	ProtocolVersion string `json:"protocolVersion"`
	Capabilities    struct {
		Tools json.RawMessage `json:"tools,omitempty"`
	} `json:"capabilities"`
	ServerInfo struct {
		Name    string `json:"name,omitempty"`
		Version string `json:"version,omitempty"`
	} `json:"serverInfo,omitempty"`
}

type toolsListResult struct {
	Tools      []plugin.MCPToolDescriptor `json:"tools"`
	NextCursor string                     `json:"nextCursor,omitempty"`
}

type managedSession struct {
	server          domain.MCPServerConfig
	fingerprint     string
	transport       transportClient
	toolsCapability bool

	listMu sync.Mutex

	mu         sync.Mutex
	toolsValid bool
	listGen    uint64
	tools      []plugin.MCPToolDescriptor
	lastUsed   time.Time
	broken     bool
}

func startManagedSession(
	ctx context.Context,
	server domain.MCPServerConfig,
	fingerprint string,
	httpClient *http.Client,
) (*managedSession, error) {
	sess := &managedSession{
		server:      server,
		fingerprint: fingerprint,
		lastUsed:    time.Now(),
	}

	onNotify := func(method string, _ json.RawMessage) {
		if method == "notifications/tools/list_changed" {
			sess.invalidateTools()
		}
	}

	var transport transportClient
	var err error
	switch strings.TrimSpace(server.Transport) {
	case domain.MCPTransportStdio:
		transport, err = startStdioTransport(server, onNotify)
	case domain.MCPTransportSSE:
		transport, err = startSSETransport(ctx, httpClient, server, onNotify)
	case domain.MCPTransportStreamableHTTP:
		transport, err = startStreamableHTTPTransport(httpClient, server, onNotify)
	default:
		return nil, domain.NewError(
			domain.ErrCodeInvalidArgument,
			fmt.Sprintf("unsupported MCP transport %q", server.Transport),
			nil,
		)
	}
	if err != nil {
		return nil, err
	}
	sess.transport = transport

	if err := sess.handshake(ctx); err != nil {
		_ = transport.Close()
		return nil, err
	}
	return sess, nil
}

func (s *managedSession) handshake(ctx context.Context) error {
	initParams := map[string]any{
		"protocolVersion": defaultProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo": map[string]string{
			"name":    "llmstudio",
			"version": "1.2.0",
		},
	}
	raw, err := s.transport.Call(ctx, "initialize", initParams)
	if err != nil {
		return domain.NewError(
			domain.ErrCodeUpstreamError,
			fmt.Sprintf("MCP initialize failed for %q: %v", s.server.Name, redactSecrets(err.Error(), s.server)),
			err,
		)
	}

	var res initializeResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return domain.NewError(
			domain.ErrCodeUpstreamError,
			fmt.Sprintf("invalid MCP initialize response from %q: %v", s.server.Name, err),
			err,
		)
	}
	if strings.TrimSpace(res.ProtocolVersion) == "" {
		return domain.NewError(
			domain.ErrCodeUpstreamError,
			fmt.Sprintf("MCP server %q returned empty protocolVersion", s.server.Name),
			nil,
		)
	}
	s.transport.SetProtocolVersion(strings.TrimSpace(res.ProtocolVersion))

	toolsCap := bytes.TrimSpace(res.Capabilities.Tools)
	s.toolsCapability = len(toolsCap) > 0 && !bytes.Equal(toolsCap, []byte("null"))

	if err := s.transport.Notify(ctx, "notifications/initialized", map[string]any{}); err != nil {
		return domain.NewError(
			domain.ErrCodeUpstreamError,
			fmt.Sprintf("MCP notifications/initialized failed for %q: %v", s.server.Name, redactSecrets(err.Error(), s.server)),
			err,
		)
	}
	return nil
}

func (s *managedSession) invalidateTools() {
	s.mu.Lock()
	s.listGen++
	s.toolsValid = false
	s.tools = nil
	s.mu.Unlock()
}

func (s *managedSession) markBroken() {
	s.mu.Lock()
	s.broken = true
	s.mu.Unlock()
	_ = s.transport.Close()
}

func (s *managedSession) isHealthy() bool {
	s.mu.Lock()
	broken := s.broken
	s.mu.Unlock()
	if broken {
		return false
	}
	return s.transport.Alive()
}

func (s *managedSession) touch() {
	s.mu.Lock()
	s.lastUsed = time.Now()
	s.mu.Unlock()
}

func (s *managedSession) idleSince(now time.Time) time.Duration {
	s.mu.Lock()
	last := s.lastUsed
	s.mu.Unlock()
	return now.Sub(last)
}

func (s *managedSession) listTools(ctx context.Context) ([]plugin.MCPToolDescriptor, error) {
	s.touch()

	s.mu.Lock()
	if s.toolsValid {
		cached := cloneToolDescriptors(s.tools)
		s.mu.Unlock()
		return cached, nil
	}
	s.mu.Unlock()

	s.listMu.Lock()
	defer s.listMu.Unlock()

	s.mu.Lock()
	if s.toolsValid {
		cached := cloneToolDescriptors(s.tools)
		s.mu.Unlock()
		return cached, nil
	}
	startGen := s.listGen
	s.mu.Unlock()

	if !s.toolsCapability {
		empty := []plugin.MCPToolDescriptor{}
		s.mu.Lock()
		if s.listGen == startGen {
			s.tools = cloneToolDescriptors(empty)
			s.toolsValid = true
		}
		s.mu.Unlock()
		return empty, nil
	}

	var all []plugin.MCPToolDescriptor
	cursor := ""
	visited := make(map[string]struct{})
	for page := 0; page < maxToolListPages; page++ {
		var params any
		if cursor != "" {
			params = map[string]string{"cursor": cursor}
		}
		raw, err := s.transport.Call(ctx, "tools/list", params)
		if err != nil {
			s.handleCallError(ctx, err)
			return nil, domain.NewError(
				domain.ErrCodeUpstreamError,
				fmt.Sprintf("MCP tools/list failed for %q: %v", s.server.Name, redactSecrets(err.Error(), s.server)),
				err,
			)
		}

		var res toolsListResult
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, domain.NewError(
				domain.ErrCodeUpstreamError,
				fmt.Sprintf("invalid MCP tools/list response from %q: %v", s.server.Name, err),
				err,
			)
		}
		all = append(all, res.Tools...)

		next := strings.TrimSpace(res.NextCursor)
		if next == "" {
			break
		}
		if _, seen := visited[next]; seen {
			return nil, domain.NewError(
				domain.ErrCodeUpstreamError,
				fmt.Sprintf("MCP server %q returned cyclic pagination cursor", s.server.Name),
				nil,
			)
		}
		visited[next] = struct{}{}
		cursor = next
		if page == maxToolListPages-1 {
			return nil, domain.NewError(
				domain.ErrCodeUpstreamError,
				fmt.Sprintf("MCP server %q exceeded max tools/list pagination depth", s.server.Name),
				nil,
			)
		}
	}
	if all == nil {
		all = []plugin.MCPToolDescriptor{}
	}

	s.mu.Lock()
	if s.listGen == startGen {
		s.tools = cloneToolDescriptors(all)
		s.toolsValid = true
	}
	s.mu.Unlock()

	return cloneToolDescriptors(all), nil
}

func (s *managedSession) callTool(
	ctx context.Context,
	name string,
	arguments json.RawMessage,
) (plugin.MCPCallToolResult, error) {
	s.touch()

	if strings.TrimSpace(name) == "" {
		return plugin.MCPCallToolResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "tool name is required", nil)
	}
	if !s.toolsCapability {
		return plugin.MCPCallToolResult{}, domain.NewError(
			domain.ErrCodeInvalidArgument,
			fmt.Sprintf("MCP server %q does not advertise tools capability", s.server.Name),
			nil,
		)
	}

	normalizedArgs, err := normalizeToolArguments(arguments)
	if err != nil {
		return plugin.MCPCallToolResult{}, err
	}

	// Never auto-replay a committed tools/call invocation on failure.
	raw, err := s.transport.Call(ctx, "tools/call", struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}{
		Name:      name,
		Arguments: normalizedArgs,
	})
	if err != nil {
		s.handleCallError(ctx, err)
		return plugin.MCPCallToolResult{}, domain.NewError(
			domain.ErrCodeUpstreamError,
			fmt.Sprintf("MCP tool %q on %q failed: %v", name, s.server.Name, redactSecrets(err.Error(), s.server)),
			err,
		)
	}

	var result plugin.MCPCallToolResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return plugin.MCPCallToolResult{}, domain.NewError(
			domain.ErrCodeUpstreamError,
			fmt.Sprintf("invalid MCP tools/call response from %q: %v", s.server.Name, err),
			err,
		)
	}
	s.touch()
	return result, nil
}

func (s *managedSession) handleCallError(ctx context.Context, err error) {
	if ctx.Err() != nil {
		return
	}
	var rpcErr *RPCError
	if errors.As(err, &rpcErr) {
		return
	}
	if !s.transport.Alive() {
		s.markBroken()
	}
}

func (s *managedSession) close() error {
	return s.transport.Close()
}

func normalizeToolArguments(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage(`{}`), nil
	}
	if !json.Valid(trimmed) {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "tool arguments must be valid JSON", nil)
	}
	if trimmed[0] != '{' {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "tool arguments must be a JSON object", nil)
	}
	return json.RawMessage(trimmed), nil
}

func cloneToolDescriptors(src []plugin.MCPToolDescriptor) []plugin.MCPToolDescriptor {
	if len(src) == 0 {
		return []plugin.MCPToolDescriptor{}
	}
	out := make([]plugin.MCPToolDescriptor, len(src))
	for i, t := range src {
		out[i] = t
		if t.InputSchema != nil {
			out[i].InputSchema = append(json.RawMessage(nil), t.InputSchema...)
		}
		if t.OutputSchema != nil {
			out[i].OutputSchema = append(json.RawMessage(nil), t.OutputSchema...)
		}
		if t.Annotations != nil {
			ann := *t.Annotations
			if ann.ReadOnlyHint != nil {
				ann.ReadOnlyHint = domain.BoolPtr(*ann.ReadOnlyHint)
			}
			if ann.DestructiveHint != nil {
				ann.DestructiveHint = domain.BoolPtr(*ann.DestructiveHint)
			}
			if ann.IdempotentHint != nil {
				ann.IdempotentHint = domain.BoolPtr(*ann.IdempotentHint)
			}
			if ann.OpenWorldHint != nil {
				ann.OpenWorldHint = domain.BoolPtr(*ann.OpenWorldHint)
			}
			out[i].Annotations = &ann
		}
	}
	return out
}
