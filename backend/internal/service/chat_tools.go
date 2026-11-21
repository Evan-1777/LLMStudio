package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	mcpDiscoveryTimeout = 10 * time.Second
	mcpToolCallTimeout  = 30 * time.Second
)

type mcpToolBinding struct {
	BuiltIn    bool
	Scope      plugin.ExecutionScope
	ServerID   string
	ServerName string
	ToolName   string
}

// ScopedMCPServer pairs an MCP server configuration with its execution scope.
type ScopedMCPServer struct {
	Scope  plugin.ExecutionScope
	Server domain.MCPServerConfig
}

// ScopedMCPCatalog is optionally implemented by dual-domain catalogs to expose
// servers partitioned by execution scope without ID collisions.
type ScopedMCPCatalog interface {
	ListScoped(ctx context.Context) ([]ScopedMCPServer, error)
	GetScoped(ctx context.Context, scope plugin.ExecutionScope, id string) (domain.MCPServerConfig, error)
}

// ScopedMCPClient is optionally implemented by dual-domain MCP runtimes to route
// list/call operations using both scope and original server ID.
type ScopedMCPClient interface {
	ListScopedTools(ctx context.Context, scope plugin.ExecutionScope, server domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error)
	CallScopedTool(ctx context.Context, scope plugin.ExecutionScope, server domain.MCPServerConfig, name string, arguments json.RawMessage) (plugin.MCPCallToolResult, error)
	CloseScopedServer(scope plugin.ExecutionScope, serverID string) error
}

func listNormalizedScopedServers(ctx context.Context, catalog MCPCatalog) ([]ScopedMCPServer, bool, error) {
	if scoped, ok := catalog.(ScopedMCPCatalog); ok {
		entries, err := scoped.ListScoped(ctx)
		if err != nil {
			return nil, true, err
		}
		out := make([]ScopedMCPServer, 0, len(entries))
		for _, entry := range entries {
			if entry.Server.Enabled {
				out = append(out, entry)
			}
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Scope != out[j].Scope {
				return out[i].Scope < out[j].Scope
			}
			return out[i].Server.ID < out[j].Server.ID
		})
		return out, true, nil
	}
	servers, err := catalog.List(ctx)
	if err != nil {
		return nil, false, err
	}
	norm := normalizedServers(servers)
	out := make([]ScopedMCPServer, len(norm))
	for i, srv := range norm {
		out[i] = ScopedMCPServer{Server: srv}
	}
	return out, false, nil
}

func mcpServerAliasKey(entry ScopedMCPServer) string {
	if entry.Scope != "" {
		return string(entry.Scope) + "\x00" + entry.Server.ID
	}
	return entry.Server.ID
}

func listServerTools(ctx context.Context, client plugin.MCPClientBoundary, entry ScopedMCPServer) ([]plugin.MCPToolDescriptor, error) {
	if entry.Scope != "" {
		if sc, ok := client.(ScopedMCPClient); ok {
			return sc.ListScopedTools(ctx, entry.Scope, entry.Server)
		}
	}
	return client.ListTools(ctx, entry.Server)
}

func lookupMCPServer(ctx context.Context, catalog MCPCatalog, scope plugin.ExecutionScope, serverID string) (domain.MCPServerConfig, error) {
	if scope != "" {
		if sc, ok := catalog.(ScopedMCPCatalog); ok {
			return sc.GetScoped(ctx, scope, serverID)
		}
	}
	return catalog.Get(ctx, serverID)
}

func callMCPServerTool(ctx context.Context, client plugin.MCPClientBoundary, scope plugin.ExecutionScope, srv domain.MCPServerConfig, toolName string, args json.RawMessage) (plugin.MCPCallToolResult, error) {
	if scope != "" {
		if sc, ok := client.(ScopedMCPClient); ok {
			return sc.CallScopedTool(ctx, scope, srv, toolName, args)
		}
	}
	return client.CallTool(ctx, srv, toolName, args)
}

func closeMCPServer(client plugin.MCPClientBoundary, scope plugin.ExecutionScope, serverID string) {
	if scope != "" {
		if sc, ok := client.(ScopedMCPClient); ok {
			_ = sc.CloseScopedServer(scope, serverID)
			return
		}
	}
	_ = client.CloseServer(serverID)
}

type serverDiscoveryResult struct {
	descriptors []plugin.MCPToolDescriptor
	err         error
}

func discoverToolsConcurrent(ctx context.Context, mcpClient plugin.MCPClientBoundary, entries []ScopedMCPServer) []serverDiscoveryResult {
	results := make([]serverDiscoveryResult, len(entries))
	if len(entries) == 0 {
		return results
	}
	const maxDiscoveryConcurrency = 8
	sem := make(chan struct{}, min(maxDiscoveryConcurrency, len(entries)))
	var wg sync.WaitGroup
	for i, entry := range entries {
		wg.Add(1)
		go func(idx int, e ScopedMCPServer) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				results[idx].err = ctx.Err()
				return
			}
			discCtx, cancel := context.WithTimeout(ctx, mcpDiscoveryTimeout)
			descriptors, listErr := listServerTools(discCtx, mcpClient, e)
			cancel()
			results[idx] = serverDiscoveryResult{
				descriptors: descriptors,
				err:         listErr,
			}
		}(i, entry)
	}
	wg.Wait()
	return results
}

func (s *ChatService) discoverActiveTools(ctx context.Context, builtinTimeEnabled bool) ([]plugin.ChatTool, map[string]mcpToolBinding, error) {
	usedAliases := make(map[string]struct{})
	var tools []plugin.ChatTool
	var bindings map[string]mcpToolBinding

	if builtinTimeEnabled {
		usedAliases[BuiltinTimeToolName] = struct{}{}
		bindings = map[string]mcpToolBinding{
			BuiltinTimeToolName: {
				BuiltIn:    true,
				ServerID:   BuiltinServerID,
				ServerName: BuiltinServerName,
				ToolName:   BuiltinTimeToolName,
			},
		}
		tools = append(tools, BuiltinTimeChatTool())
	}

	if s.mcpStore == nil || s.mcpClient == nil {
		return tools, bindings, nil
	}
	entries, _, err := listNormalizedScopedServers(ctx, s.mcpStore)
	if err != nil {
		return nil, nil, err
	}

	results := discoverToolsConcurrent(ctx, s.mcpClient, entries)

	// Upstream servers may report the same tool set in any order; iterating in sorted
	// (scope, server ID) and tool name order keeps aliases and encoded tool blocks byte-stable.
	for i, entry := range entries {
		srv := entry.Server
		res := results[i]
		if res.err != nil {
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			return nil, nil, res.err
		}
		for _, desc := range normalizedDescriptors(res.descriptors) {
			alias := plugin.BuildChatToolAlias(mcpServerAliasKey(entry), desc.Name, usedAliases)
			if !srv.ToolEnabled(desc.Name) {
				continue
			}
			if bindings == nil {
				bindings = make(map[string]mcpToolBinding)
			}
			bindings[alias] = mcpToolBinding{
				Scope:      entry.Scope,
				ServerID:   srv.ID,
				ServerName: srv.Name,
				ToolName:   desc.Name,
			}
			tools = append(tools, plugin.ChatTool{
				Alias:       alias,
				ServerID:    srv.ID,
				ServerName:  srv.Name,
				ToolName:    desc.Name,
				Description: desc.Description,
				InputSchema: desc.InputSchema,
			})
		}
	}
	return tools, bindings, nil
}

// normalizedServers returns enabled servers ordered by ID.
func normalizedServers(servers []domain.MCPServerConfig) []domain.MCPServerConfig {
	out := make([]domain.MCPServerConfig, 0, len(servers))
	for _, srv := range servers {
		if srv.Enabled {
			out = append(out, srv)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// normalizedDescriptors returns upstream tools ordered by name.
func normalizedDescriptors(descriptors []plugin.MCPToolDescriptor) []plugin.MCPToolDescriptor {
	out := append([]plugin.MCPToolDescriptor(nil), descriptors...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (s *ChatService) filterEnabledToolsWithBindings(ctx context.Context, tools []plugin.ChatTool, bindings map[string]mcpToolBinding) []plugin.ChatTool {
	if len(tools) == 0 {
		return tools
	}
	var hasBuiltin, hasExternal bool
	for _, t := range tools {
		if b, ok := bindings[t.Alias]; ok && b.BuiltIn {
			hasBuiltin = true
		} else {
			hasExternal = true
		}
	}
	builtinEnabled := false
	if hasBuiltin {
		builtinEnabled = s.resolvePreferencesSnapshot(ctx).BuiltinTimeToolEnabled
	}
	if !hasExternal || s.mcpStore == nil {
		filtered := make([]plugin.ChatTool, 0, len(tools))
		for _, t := range tools {
			if b, ok := bindings[t.Alias]; ok && b.BuiltIn && builtinEnabled {
				filtered = append(filtered, t)
			}
		}
		return filtered
	}
	entries, scoped, err := listNormalizedScopedServers(ctx, s.mcpStore)
	if err != nil {
		return nil
	}
	if !scoped {
		byID := make(map[string]domain.MCPServerConfig, len(entries))
		for _, entry := range entries {
			byID[entry.Server.ID] = entry.Server
		}
		filtered := make([]plugin.ChatTool, 0, len(tools))
		for _, t := range tools {
			if b, ok := bindings[t.Alias]; ok && b.BuiltIn {
				if builtinEnabled {
					filtered = append(filtered, t)
				}
				continue
			}
			if byID[t.ServerID].ToolEnabled(t.ToolName) {
				filtered = append(filtered, t)
			}
		}
		return filtered
	}
	type scopedKey struct {
		scope plugin.ExecutionScope
		id    string
	}
	byScoped := make(map[scopedKey]domain.MCPServerConfig, len(entries))
	for _, entry := range entries {
		byScoped[scopedKey{scope: entry.Scope, id: entry.Server.ID}] = entry.Server
	}
	filtered := make([]plugin.ChatTool, 0, len(tools))
	for _, t := range tools {
		b, hasB := bindings[t.Alias]
		if hasB && b.BuiltIn {
			if builtinEnabled {
				filtered = append(filtered, t)
			}
			continue
		}
		var scope plugin.ExecutionScope
		if hasB {
			scope = b.Scope
		}
		if byScoped[scopedKey{scope: scope, id: t.ServerID}].ToolEnabled(t.ToolName) {
			filtered = append(filtered, t)
		}
	}
	return filtered
}

func (s *ChatService) executeToolCall(
	ctx context.Context,
	bindings map[string]mcpToolBinding,
	call domain.ContentBlock,
) (domain.ContentBlock, error) {
	if binding, ok := bindings[call.Name]; ok && binding.BuiltIn {
		return executeBuiltinBindingCall(ctx, s.preferences, binding, call), nil
	}
	return executeToolCallWithRuntime(ctx, s.mcpStore, s.mcpClient, bindings, call)
}

func executeBuiltinBindingCall(
	ctx context.Context,
	prefsLookup PreferenceLookup,
	binding mcpToolBinding,
	call domain.ContentBlock,
) domain.ContentBlock {
	resultBlock := domain.ContentBlock{
		Type:       domain.BlockTypeToolResult,
		ToolCallID: call.ID,
		ToolName:   call.Name,
	}
	enabled := false
	if prefsLookup != nil {
		if prefs, _, err := prefsLookup.Get(ctx); err == nil {
			enabled = prefs.BuiltinTimeToolEnabled
		}
	}
	if !enabled {
		resultBlock.IsError = true
		resultBlock.Content = fmt.Sprintf("builtin tool %q is disabled", binding.ToolName)
		return resultBlock
	}
	argsJSON, argErr := normalizeCallArguments(call.Arguments)
	if argErr != nil {
		resultBlock.IsError = true
		resultBlock.Content = argErr.Error()
		return resultBlock
	}
	var res plugin.MCPCallToolResult
	switch binding.ToolName {
	case BuiltinTimeToolName:
		res = executeBuiltinTimeTool(time.Now(), argsJSON)
	default:
		resultBlock.IsError = true
		resultBlock.Content = fmt.Sprintf("unknown builtin tool %q", binding.ToolName)
		return resultBlock
	}
	resultBlock.IsError = res.IsError
	resultBlock.Content = summarizeMCPResultText(res)
	resultBlock.Extra = encodeMCPResultExtra(res)
	return resultBlock
}

func executeToolCallWithRuntime(
	ctx context.Context,
	mcpStore MCPCatalog,
	mcpClient plugin.MCPClientBoundary,
	bindings map[string]mcpToolBinding,
	call domain.ContentBlock,
) (domain.ContentBlock, error) {
	binding, ok := bindings[call.Name]
	if !ok {
		return domain.ContentBlock{
			Type:       domain.BlockTypeToolResult,
			ToolCallID: call.ID,
			ToolName:   call.Name,
			IsError:    true,
			Content:    fmt.Sprintf("unknown or disabled tool %q", call.Name),
		}, nil
	}
	return executeResolvedToolCall(ctx, mcpStore, mcpClient, binding, call)
}

func executeResolvedToolCall(
	ctx context.Context,
	mcpStore MCPCatalog,
	mcpClient plugin.MCPClientBoundary,
	binding mcpToolBinding,
	call domain.ContentBlock,
) (domain.ContentBlock, error) {
	resultBlock := domain.ContentBlock{
		Type:       domain.BlockTypeToolResult,
		ToolCallID: call.ID,
		ToolName:   call.Name,
	}

	if mcpStore == nil || mcpClient == nil {
		resultBlock.IsError = true
		resultBlock.Content = "MCP runtime is unavailable"
		return resultBlock, nil
	}

	srv, err := lookupMCPServer(ctx, mcpStore, binding.Scope, binding.ServerID)
	if err != nil || !srv.Enabled {
		closeMCPServer(mcpClient, binding.Scope, binding.ServerID)
		serverLabel := binding.ServerName
		if serverLabel == "" {
			serverLabel = binding.ServerID
		}
		resultBlock.IsError = true
		resultBlock.Content = fmt.Sprintf("MCP server %q is unavailable or disabled", serverLabel)
		return resultBlock, nil
	}

	if !srv.ToolEnabled(binding.ToolName) {
		resultBlock.IsError = true
		resultBlock.Content = fmt.Sprintf("MCP tool %q is disabled", binding.ToolName)
		return resultBlock, nil
	}

	argsJSON, argErr := normalizeCallArguments(call.Arguments)
	if argErr != nil {
		resultBlock.IsError = true
		resultBlock.Content = argErr.Error()
		return resultBlock, nil
	}

	callCtx, cancel := context.WithTimeout(ctx, mcpToolCallTimeout)
	res, callErr := callMCPServerTool(callCtx, mcpClient, binding.Scope, srv, binding.ToolName, argsJSON)
	cancel()
	if ctx.Err() != nil {
		return domain.ContentBlock{}, ctx.Err()
	}
	if callErr != nil {
		resultBlock.IsError = true
		resultBlock.Content = callErr.Error()
		return resultBlock, nil
	}

	resultBlock.IsError = res.IsError
	resultBlock.Content = summarizeMCPResultText(res)
	resultBlock.Extra = encodeMCPResultExtra(res)
	return resultBlock, nil
}

func normalizeCallArguments(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage(`{}`), nil
	}
	if !json.Valid(trimmed) {
		return nil, fmt.Errorf("invalid JSON arguments for tool call")
	}
	if trimmed[0] != '{' {
		return nil, fmt.Errorf("tool arguments must be a JSON object")
	}
	return json.RawMessage(trimmed), nil
}

func summarizeMCPResultText(res plugin.MCPCallToolResult) string {
	var parts []string
	for _, item := range res.Content {
		switch item.Type {
		case "text":
			if item.Text != "" {
				parts = append(parts, item.Text)
			}
		case "image", "audio":
			label := item.Type
			if item.MimeType != "" {
				label += " (" + item.MimeType + ")"
			}
			parts = append(parts, "["+label+"]")
		case "resource":
			if item.Resource != nil {
				if item.Resource.Text != "" {
					parts = append(parts, item.Resource.Text)
				} else if item.Resource.URI != "" {
					parts = append(parts, fmt.Sprintf("[resource: %s]", item.Resource.URI))
				}
			}
		case "resource_link":
			if item.URI != "" {
				if item.Name != "" {
					parts = append(parts, fmt.Sprintf("[%s](%s)", item.Name, item.URI))
				} else {
					parts = append(parts, item.URI)
				}
			}
		default:
			if item.Text != "" {
				parts = append(parts, item.Text)
			}
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n")
	}
	sc := strings.TrimSpace(string(res.StructuredContent))
	if sc != "" && sc != "null" {
		return sc
	}
	return ""
}

func encodeMCPResultExtra(res plugin.MCPCallToolResult) json.RawMessage {
	sc := bytes.TrimSpace(res.StructuredContent)
	hasStructured := len(sc) > 0 && !bytes.Equal(sc, []byte("null"))
	if len(res.Content) == 0 && !hasStructured {
		return nil
	}
	payload := struct {
		Content           []plugin.MCPToolContent `json:"content,omitempty"`
		StructuredContent json.RawMessage         `json:"structuredContent,omitempty"`
	}{
		Content: res.Content,
	}
	if hasStructured {
		payload.StructuredContent = json.RawMessage(sc)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return raw
}

func filterBlocksForModelHistory(blocks []domain.ContentBlock) []domain.ContentBlock {
	out := make([]domain.ContentBlock, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == domain.BlockTypeWebSearch {
			continue
		}
		out = append(out, b)
	}
	return out
}

func roundContextTokens(u *domain.Usage) int {
	if u == nil {
		return 0
	}
	if u.ContextTokens > 0 {
		return u.ContextTokens
	}
	if ctx := u.InputTokens + u.OutputTokens; ctx > 0 {
		return ctx
	}
	if u.TotalTokens > 0 {
		return u.TotalTokens
	}
	return 0
}

func addUsage(acc, round *domain.Usage) *domain.Usage {
	if round == nil {
		return acc
	}
	roundCtx := roundContextTokens(round)
	if acc == nil {
		cp := *round
		if roundCtx > 0 && cp.ContextTokens == 0 {
			cp.ContextTokens = roundCtx
		}
		return &cp
	}
	acc.InputTokens += round.InputTokens
	acc.OutputTokens += round.OutputTokens
	acc.ThinkingTokens += round.ThinkingTokens
	acc.CacheReadInputTokens += round.CacheReadInputTokens
	acc.CacheCreationInputTokens += round.CacheCreationInputTokens
	acc.TotalTokens += round.TotalTokens
	if roundCtx > 0 {
		acc.ContextTokens = roundCtx
	}
	return acc
}

// ToolCallInput describes a single tool invocation requested by the client during browser-direct continuation.
type ToolCallInput struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// StatelessToolCallInput describes a single stateless MCP tool invocation, targeting
// either explicit (serverId, toolName) or an alias name fallback.
type StatelessToolCallInput struct {
	ID        string          `json:"id"`
	Name      string          `json:"name,omitempty"`
	ServerID  string          `json:"serverId,omitempty"`
	ToolName  string          `json:"toolName,omitempty"`
	Arguments json.RawMessage `json:"arguments"`
}

// ExecuteToolsInput holds validated parameters for streaming gateway-side MCP tool execution.
type ExecuteToolsInput struct {
	ConversationID string          `json:"-"`
	Calls          []ToolCallInput `json:"calls"`
}

// ExecuteTools runs the requested tool calls sequentially against currently enabled MCP aliases,
// emitting block_start and block_end events for each toolResult block.
func (s *ChatService) ExecuteTools(
	ctx context.Context,
	in ExecuteToolsInput,
	emit func(domain.StreamEvent) error,
) error {
	if _, err := s.convs.Get(ctx, in.ConversationID); err != nil {
		return err
	}
	if len(in.Calls) == 0 {
		return domain.NewError(domain.ErrCodeInvalidArgument, "calls are required", nil)
	}
	bindings, serverErrs, err := s.discoverActiveBindingsLenient(ctx)
	if err != nil {
		return err
	}

	for idx, call := range in.Calls {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		blockCall := domain.ContentBlock{
			Type:      domain.BlockTypeToolCall,
			ID:        strings.TrimSpace(call.ID),
			Name:      strings.TrimSpace(call.Name),
			Arguments: call.Arguments,
		}
		trBlock, execErr := s.executeToolCall(ctx, bindings, blockCall)
		if execErr != nil {
			return execErr
		}
		if trBlock.IsError && strings.HasPrefix(trBlock.Content, "unknown or disabled tool ") && len(serverErrs) > 0 {
			trBlock.Content = fmt.Sprintf("%s (%s)", trBlock.Content, strings.Join(serverErrs, "; "))
		}
		if err := emitToolResultEvents(emit, in.ConversationID, idx, trBlock); err != nil {
			return err
		}
	}
	return nil
}

// ExecuteToolsStateless runs tool calls without requiring an existing conversation record.
func (s *ChatService) ExecuteToolsStateless(
	ctx context.Context,
	calls []StatelessToolCallInput,
	emit func(domain.StreamEvent) error,
) error {
	return executeToolsStateless(ctx, s.mcpStore, s.mcpClient, calls, emit)
}

func executeToolsStateless(
	ctx context.Context,
	mcpStore MCPCatalog,
	mcpClient plugin.MCPClientBoundary,
	calls []StatelessToolCallInput,
	emit func(domain.StreamEvent) error,
) error {
	if len(calls) == 0 {
		return domain.NewError(domain.ErrCodeInvalidArgument, "calls are required", nil)
	}
	var (
		bindings          map[string]mcpToolBinding
		serverErrs        []string
		bindingsDiscovered bool
	)
	for idx, call := range calls {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		serverID := strings.TrimSpace(call.ServerID)
		toolName := strings.TrimSpace(call.ToolName)
		displayName := strings.TrimSpace(call.Name)
		if displayName == "" {
			displayName = toolName
		}
		blockCall := domain.ContentBlock{
			Type:      domain.BlockTypeToolCall,
			ID:        strings.TrimSpace(call.ID),
			Name:      displayName,
			Arguments: call.Arguments,
		}

		var (
			trBlock domain.ContentBlock
			execErr error
		)
		if serverID != "" && toolName != "" {
			trBlock, execErr = executeResolvedToolCall(ctx, mcpStore, mcpClient, mcpToolBinding{
				ServerID:   serverID,
				ServerName: serverID,
				ToolName:   toolName,
			}, blockCall)
		} else {
			if !bindingsDiscovered {
				bindings, serverErrs, execErr = discoverActiveBindingsLenientWithRuntime(ctx, mcpStore, mcpClient)
				if execErr != nil {
					return execErr
				}
				bindingsDiscovered = true
			}
			trBlock, execErr = executeToolCallWithRuntime(ctx, mcpStore, mcpClient, bindings, blockCall)
			if trBlock.IsError && strings.HasPrefix(trBlock.Content, "unknown or disabled tool ") && len(serverErrs) > 0 {
				trBlock.Content = fmt.Sprintf("%s (%s)", trBlock.Content, strings.Join(serverErrs, "; "))
			}
		}
		if execErr != nil {
			return execErr
		}
		if emit != nil {
			if err := emitToolResultEvents(emit, "", idx, trBlock); err != nil {
				return err
			}
		}
	}
	return nil
}

func emitToolResultEvents(emit func(domain.StreamEvent) error, conversationID string, idx int, trBlock domain.ContentBlock) error {
	trCopy := trBlock
	if err := emit(domain.StreamEvent{
		Type:           domain.StreamEventBlockStart,
		ConversationID: conversationID,
		Index:          domain.IntPtr(idx),
		BlockType:      domain.BlockTypeToolResult,
		Block:          &trCopy,
	}); err != nil {
		return err
	}
	return emit(domain.StreamEvent{
		Type:           domain.StreamEventBlockEnd,
		ConversationID: conversationID,
		Index:          domain.IntPtr(idx),
		BlockType:      domain.BlockTypeToolResult,
		Block:          &trCopy,
	})
}

func (s *ChatService) discoverActiveBindingsLenient(ctx context.Context) (map[string]mcpToolBinding, []string, error) {
	bindings, serverErrs, err := discoverActiveBindingsLenientWithRuntime(ctx, s.mcpStore, s.mcpClient)
	if err != nil {
		return nil, nil, err
	}
	if s.resolvePreferencesSnapshot(ctx).BuiltinTimeToolEnabled {
		if bindings == nil {
			bindings = make(map[string]mcpToolBinding)
		}
		bindings[BuiltinTimeToolName] = mcpToolBinding{
			BuiltIn:    true,
			ServerID:   BuiltinServerID,
			ServerName: BuiltinServerName,
			ToolName:   BuiltinTimeToolName,
		}
	}
	return bindings, serverErrs, nil
}

func discoverActiveBindingsLenientWithRuntime(
	ctx context.Context,
	mcpStore MCPCatalog,
	mcpClient plugin.MCPClientBoundary,
) (map[string]mcpToolBinding, []string, error) {
	if mcpStore == nil || mcpClient == nil {
		return nil, nil, nil
	}
	entries, _, err := listNormalizedScopedServers(ctx, mcpStore)
	if err != nil {
		return nil, nil, err
	}
	results := discoverToolsConcurrent(ctx, mcpClient, entries)
	usedAliases := make(map[string]struct{})
	bindings := make(map[string]mcpToolBinding)
	var serverErrs []string

	// Execute the same deterministic ordering as discoverActiveTools so aliases
	// produced while encoding the request resolve back to the same tool here.
	for i, entry := range entries {
		srv := entry.Server
		res := results[i]
		if res.err != nil {
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			serverErrs = append(serverErrs, fmt.Sprintf("%s: %v", srv.Name, res.err))
			continue
		}
		for _, desc := range normalizedDescriptors(res.descriptors) {
			alias := plugin.BuildChatToolAlias(mcpServerAliasKey(entry), desc.Name, usedAliases)
			if !srv.ToolEnabled(desc.Name) {
				continue
			}
			bindings[alias] = mcpToolBinding{
				Scope:      entry.Scope,
				ServerID:   srv.ID,
				ServerName: srv.Name,
				ToolName:   desc.Name,
			}
		}
	}
	return bindings, serverErrs, nil
}

func formatSearchResultsPrompt(results []plugin.SearchResult) string {
	if len(results) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("[联网搜索结果]\n")
	for i, r := range results {
		fmt.Fprintf(&sb, "%d. %s (%s)\n", i+1, r.Title, r.URL)
		if r.Snippet != "" {
			fmt.Fprintf(&sb, "   %s\n", r.Snippet)
		}
	}
	sb.WriteString("请结合以上联网搜索结果回答用户问题，并在合适位置引用来源链接。")
	return sb.String()
}

func rebuildSearchPromptFromBlock(b domain.ContentBlock) string {
	if b.Type != domain.BlockTypeWebSearch || len(b.Extra) == 0 {
		return ""
	}
	var extra struct {
		Results []plugin.SearchResult `json:"results"`
	}
	if err := json.Unmarshal(b.Extra, &extra); err == nil && len(extra.Results) > 0 {
		return formatSearchResultsPrompt(extra.Results)
	}
	return ""
}

func rebuildSearchPromptFromBlocks(blocks []domain.ContentBlock) string {
	for _, b := range blocks {
		if prompt := rebuildSearchPromptFromBlock(b); prompt != "" {
			return prompt
		}
	}
	return ""
}
