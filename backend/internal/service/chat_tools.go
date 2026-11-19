package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	mcpDiscoveryTimeout = 10 * time.Second
	mcpToolCallTimeout  = 30 * time.Second
)

type mcpToolBinding struct {
	ServerID   string
	ServerName string
	ToolName   string
}

func (s *ChatService) discoverActiveTools(ctx context.Context) ([]plugin.ChatTool, map[string]mcpToolBinding, error) {
	if s.mcpStore == nil || s.mcpClient == nil {
		return nil, nil, nil
	}
	servers, err := s.mcpStore.List(ctx)
	if err != nil {
		return nil, nil, err
	}

	usedAliases := make(map[string]struct{})
	var tools []plugin.ChatTool
	var bindings map[string]mcpToolBinding

	// Upstream servers may report the same tool set in any order; sorting by server
	// ID and tool name keeps aliases and the encoded tool block byte-stable.
	for _, srv := range normalizedServers(servers) {
		discCtx, cancel := context.WithTimeout(ctx, mcpDiscoveryTimeout)
		descriptors, listErr := s.mcpClient.ListTools(discCtx, srv)
		cancel()
		if listErr != nil {
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			return nil, nil, listErr
		}
		for _, desc := range normalizedDescriptors(descriptors) {
			alias := plugin.BuildChatToolAlias(srv.ID, desc.Name, usedAliases)
			if !srv.ToolEnabled(desc.Name) {
				continue
			}
			if bindings == nil {
				bindings = make(map[string]mcpToolBinding)
			}
			bindings[alias] = mcpToolBinding{
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

func (s *ChatService) filterEnabledTools(ctx context.Context, tools []plugin.ChatTool) []plugin.ChatTool {
	if len(tools) == 0 || s.mcpStore == nil {
		return tools
	}
	servers, err := s.mcpStore.List(ctx)
	if err != nil {
		return nil
	}
	byID := make(map[string]domain.MCPServerConfig, len(servers))
	for _, srv := range servers {
		byID[srv.ID] = srv
	}
	filtered := make([]plugin.ChatTool, 0, len(tools))
	for _, t := range tools {
		if byID[t.ServerID].ToolEnabled(t.ToolName) {
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
	resultBlock := domain.ContentBlock{
		Type:       domain.BlockTypeToolResult,
		ToolCallID: call.ID,
		ToolName:   call.Name,
	}

	binding, ok := bindings[call.Name]
	if !ok {
		resultBlock.IsError = true
		resultBlock.Content = fmt.Sprintf("unknown or disabled tool %q", call.Name)
		return resultBlock, nil
	}

	if s.mcpStore == nil || s.mcpClient == nil {
		resultBlock.IsError = true
		resultBlock.Content = "MCP runtime is unavailable"
		return resultBlock, nil
	}

	srv, err := s.mcpStore.Get(ctx, binding.ServerID)
	if err != nil || !srv.Enabled {
		_ = s.mcpClient.CloseServer(binding.ServerID)
		resultBlock.IsError = true
		resultBlock.Content = fmt.Sprintf("MCP server %q is unavailable or disabled", binding.ServerName)
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
	res, callErr := s.mcpClient.CallTool(callCtx, srv, binding.ToolName, argsJSON)
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

func addUsage(acc, round *domain.Usage) *domain.Usage {
	if round == nil {
		return acc
	}
	if acc == nil {
		cp := *round
		return &cp
	}
	acc.InputTokens += round.InputTokens
	acc.OutputTokens += round.OutputTokens
	acc.ThinkingTokens += round.ThinkingTokens
	acc.CacheReadInputTokens += round.CacheReadInputTokens
	acc.CacheCreationInputTokens += round.CacheCreationInputTokens
	acc.TotalTokens += round.TotalTokens
	return acc
}

// ToolCallInput describes a single tool invocation requested by the client during browser-direct continuation.
type ToolCallInput struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
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
		trCopy := trBlock
		if err := emit(domain.StreamEvent{
			Type:           domain.StreamEventBlockStart,
			ConversationID: in.ConversationID,
			Index:          domain.IntPtr(idx),
			BlockType:      domain.BlockTypeToolResult,
			Block:          &trCopy,
		}); err != nil {
			return err
		}
		if err := emit(domain.StreamEvent{
			Type:           domain.StreamEventBlockEnd,
			ConversationID: in.ConversationID,
			Index:          domain.IntPtr(idx),
			BlockType:      domain.BlockTypeToolResult,
			Block:          &trCopy,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *ChatService) discoverActiveBindingsLenient(ctx context.Context) (map[string]mcpToolBinding, []string, error) {
	if s.mcpStore == nil || s.mcpClient == nil {
		return nil, nil, nil
	}
	servers, err := s.mcpStore.List(ctx)
	if err != nil {
		return nil, nil, err
	}
	usedAliases := make(map[string]struct{})
	bindings := make(map[string]mcpToolBinding)
	var serverErrs []string

	// Execute the same deterministic ordering as discoverActiveTools so aliases
	// produced while encoding the request resolve back to the same tool here.
	for _, srv := range normalizedServers(servers) {
		discCtx, cancel := context.WithTimeout(ctx, mcpDiscoveryTimeout)
		descriptors, listErr := s.mcpClient.ListTools(discCtx, srv)
		cancel()
		if listErr != nil {
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			serverErrs = append(serverErrs, fmt.Sprintf("%s: %v", srv.Name, listErr))
			continue
		}
		for _, desc := range normalizedDescriptors(descriptors) {
			alias := plugin.BuildChatToolAlias(srv.ID, desc.Name, usedAliases)
			if !srv.ToolEnabled(desc.Name) {
				continue
			}
			bindings[alias] = mcpToolBinding{
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
