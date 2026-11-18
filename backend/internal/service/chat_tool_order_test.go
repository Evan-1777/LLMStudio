package service_test

import (
	"context"
	"encoding/json"
	"sort"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
)

// TestDiscoverActiveToolsKeepsAliasesStableAcrossUpstreamOrdering proves that a
// permuted upstream tool listing encodes the same aliases and the same tool block.
func TestDiscoverActiveToolsKeepsAliasesStableAcrossUpstreamOrdering(t *testing.T) {
	ctx := context.Background()

	toolsFor := func(reverse bool) map[string][]plugin.MCPToolDescriptor {
		servers := []string{"srv-a", "srv-b"}
		if reverse {
			servers = []string{"srv-b", "srv-a"}
		}
		out := map[string][]plugin.MCPToolDescriptor{}
		for _, id := range servers {
			descriptors := []plugin.MCPToolDescriptor{
				{Name: "zeta", Description: id + " zeta"},
				{Name: "alpha", Description: id + " alpha"},
				{Name: "mid", Description: id + " mid"},
			}
			if reverse {
				sort.Slice(descriptors, func(i, j int) bool { return descriptors[i].Name > descriptors[j].Name })
			}
			out[id] = descriptors
		}
		return out
	}

	encodedTools := func(reverse bool) []any {
		stub := &stubMCPClient{toolsBySrv: toolsFor(reverse)}
		svc, _, _, mcpStore, conv, _ := setupChatMCPFixture(t, "http://127.0.0.1:1/v1", stub)
		serverOrder := []string{"srv-a", "srv-b"}
		if reverse {
			serverOrder = []string{"srv-b", "srv-a"}
		}
		for _, id := range serverOrder {
			if _, err := mcpStore.Create(ctx, domain.MCPServerConfig{
				ID:        id,
				Name:      id,
				Transport: domain.MCPTransportStreamableHTTP,
				Endpoint:  "http://127.0.0.1:1/mcp",
				Enabled:   true,
			}); err != nil {
				t.Fatalf("create mcp server %s: %v", id, err)
			}
		}

		prep, err := svc.PrepareLocal(ctx, service.StreamChatInput{
			ConversationID: conv.ID,
			Text:           "list tools",
			ProviderID:     "prov-1",
			ModelID:        "gpt-test",
		})
		if err != nil {
			t.Fatalf("PrepareLocal: %v", err)
		}
		var body struct {
			Tools []any `json:"tools"`
		}
		if err := json.Unmarshal(prep.Body, &body); err != nil {
			t.Fatalf("decode prepared body: %v", err)
		}
		return body.Tools
	}

	first := encodedTools(false)
	second := encodedTools(true)
	if len(first) == 0 {
		t.Fatal("expected discovered MCP tools in the encoded request")
	}
	firstJSON, _ := json.Marshal(first)
	secondJSON, _ := json.Marshal(second)
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("tool block changed with upstream ordering:\n%s\n%s", firstJSON, secondJSON)
	}
}
