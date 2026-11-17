package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestStreamableHTTPJSONSSESessionRedirectAndAuthErrors(t *testing.T) {
	ctx := context.Background()

	// 1. Streamable HTTP JSON server tracking Mcp-Session-Id, MCP-Protocol-Version, Headers, and DELETE.
	var deleteCalled atomic.Bool
	var seenProtoHeaders []string
	var seenCustomHeaders []string
	var mu sync.Mutex
	counter := 0

	jsonSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleteCalled.Store(true)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var env rpcEnvelope
		if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		seenCustomHeaders = append(seenCustomHeaders, r.Header.Get("X-Custom-Token"))
		if ver := r.Header.Get("MCP-Protocol-Version"); ver != "" {
			seenProtoHeaders = append(seenProtoHeaders, ver)
		}
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "sess-http-1")

		if len(env.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}

		switch env.Method {
		case "initialize":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(env.ID),
				"result": map[string]any{
					"protocolVersion": "2025-11-25",
					"capabilities":    map[string]any{"tools": map[string]any{}},
				},
			})
		case "tools/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(env.ID),
				"result": map[string]any{
					"tools": []plugin.MCPToolDescriptor{
						{Name: "bump", InputSchema: json.RawMessage(`{"type":"object"}`)},
					},
				},
			})
		case "tools/call":
			if r.Header.Get("Mcp-Session-Id") != "sess-http-1" {
				http.Error(w, "missing session id", http.StatusBadRequest)
				return
			}
			counter++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(env.ID),
				"result": plugin.MCPCallToolResult{
					Content:           []plugin.MCPToolContent{{Type: "text", Text: fmt.Sprintf("n=%d", counter)}},
					StructuredContent: json.RawMessage(fmt.Sprintf(`{"n":%d}`, counter)),
				},
			})
		}
	}))
	defer jsonSrv.Close()

	rt := NewRuntime()
	defer rt.Close()

	cfgJSON := domain.MCPServerConfig{
		ID:        "http-json-1",
		Name:      "http-json",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  jsonSrv.URL,
		Headers:   map[string]string{"X-Custom-Token": "origin-secret-123"},
		Enabled:   true,
	}
	tools, err := rt.ListTools(ctx, cfgJSON)
	if err != nil || len(tools) != 1 || tools[0].Name != "bump" {
		t.Fatalf("Streamable HTTP JSON ListTools failed: tools=%+v err=%v", tools, err)
	}
	res1, err := rt.CallTool(ctx, cfgJSON, "bump", nil)
	if err != nil || len(res1.Content) == 0 || res1.Content[0].Text != "n=1" {
		t.Fatalf("Streamable HTTP JSON CallTool failed: res=%+v err=%v", res1, err)
	}
	_ = rt.CloseServer(cfgJSON.ID)
	if !deleteCalled.Load() {
		t.Fatalf("expected DELETE session cleanup on CloseServer")
	}
	mu.Lock()
	if len(seenProtoHeaders) == 0 || seenProtoHeaders[0] != "2025-11-25" {
		t.Fatalf("expected MCP-Protocol-Version header after initialize, got %v", seenProtoHeaders)
	}
	if len(seenCustomHeaders) == 0 || seenCustomHeaders[0] != "origin-secret-123" {
		t.Fatalf("expected configured header on same-origin requests, got %v", seenCustomHeaders)
	}
	mu.Unlock()

	// 2. Streamable HTTP text/event-stream fragmented multi-line SSE + cancellation.
	sseCancelSeen := make(chan struct{})
	sseStreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var env rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&env)
		if len(env.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)

		writeFragmented := func(data string) {
			half := len(data) / 2
			_, _ = fmt.Fprint(w, ": heartbeat comment\n")
			_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n", data[:half])
			flusher.Flush()
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data[half:])
			flusher.Flush()
		}

		switch env.Method {
		case "initialize":
			// First test JSON-RPC across fragmented lines (split as valid multiline JSON wait: SSE joins lines with \n!)
			_, _ = fmt.Fprint(w, ": comment\nevent: message\n")
			_, _ = fmt.Fprint(w, "data: {\"jsonrpc\":\"2.0\",\n")
			flusher.Flush()
			_, _ = fmt.Fprintf(w, "data: \"id\":%s,\"result\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}}}}\n\n", string(env.ID))
			flusher.Flush()
		case "tools/list":
			writeFragmented(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"sse_echo","inputSchema":{"type":"object"}}]}}`, string(env.ID)))
		case "tools/call":
			var p struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(env.Params, &p)
			if p.Name == "hang" {
				flusher.Flush()
				<-r.Context().Done()
				close(sseCancelSeen)
				return
			}
			_, _ = fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"from-sse\"}]}}\n\n", string(env.ID))
			flusher.Flush()
		}
	}))
	defer sseStreamSrv.Close()

	cfgStreamSSE := domain.MCPServerConfig{
		ID:        "http-sse-1",
		Name:      "http-sse",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  sseStreamSrv.URL,
		Enabled:   true,
	}
	resSSE, err := rt.CallTool(ctx, cfgStreamSSE, "sse_echo", json.RawMessage(`{}`))
	if err != nil || len(resSSE.Content) == 0 || resSSE.Content[0].Text != "from-sse" {
		t.Fatalf("Streamable HTTP SSE response failed: res=%+v err=%v", resSSE, err)
	}

	cancelCtx, cancel := context.WithTimeout(ctx, 60*time.Millisecond)
	defer cancel()
	_, hangErr := rt.CallTool(cancelCtx, cfgStreamSSE, "hang", nil)
	if !errors.Is(hangErr, context.DeadlineExceeded) && !errors.Is(hangErr, context.Canceled) {
		t.Fatalf("expected cancel/deadline error, got %v", hangErr)
	}
	select {
	case <-sseCancelSeen:
	case <-time.After(time.Second):
		t.Fatalf("expected server SSE request context to abort when client cancelled")
	}

	// 3. Cross-origin redirect MUST strip custom headers and Authorization/Cookie.
	var targetAuthHeader, targetCustomHeader string
	targetSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetAuthHeader = r.Header.Get("Authorization")
		targetCustomHeader = r.Header.Get("X-Secret-Header")
		w.WriteHeader(http.StatusForbidden)
		_, _ = fmt.Fprint(w, "forbidden cross origin")
	}))
	defer targetSrv.Close()

	redirectSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, targetSrv.URL+"/mcp", http.StatusTemporaryRedirect)
	}))
	defer redirectSrv.Close()

	cfgRedir := domain.MCPServerConfig{
		ID:        "http-redir",
		Name:      "redir",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  redirectSrv.URL,
		Headers: map[string]string{
			"Authorization":   "Bearer secret-redirect-token",
			"X-Secret-Header": "must-not-leak-cross-origin",
		},
		Enabled: true,
	}
	_, redirErr := rt.ListTools(ctx, cfgRedir)
	if redirErr == nil {
		t.Fatalf("expected redirect to 403 target to fail")
	}
	if targetAuthHeader != "" || targetCustomHeader != "" {
		t.Fatalf("cross-origin redirect leaked headers: Authorization=%q X-Secret-Header=%q", targetAuthHeader, targetCustomHeader)
	}
	if strings.Contains(redirErr.Error(), "secret-redirect-token") || strings.Contains(redirErr.Error(), "must-not-leak-cross-origin") {
		t.Fatalf("error leaked secret header value: %q", redirErr.Error())
	}

	// 4. Direct 401 returns clear authentication failure (never 0 tools success).
	unauthSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad api key", http.StatusUnauthorized)
	}))
	defer unauthSrv.Close()
	_, unauthErr := rt.ListTools(ctx, domain.MCPServerConfig{
		ID:        "http-401",
		Name:      "unauth",
		Transport: domain.MCPTransportStreamableHTTP,
		Endpoint:  unauthSrv.URL,
		Enabled:   true,
	})
	if unauthErr == nil || !strings.Contains(unauthErr.Error(), "401") {
		t.Fatalf("expected clear 401 error, got %v", unauthErr)
	}
}

func TestLegacySSEInitializeListCallAndZeroTools(t *testing.T) {
	ctx := context.Background()

	var (
		sseWriterMu sync.Mutex
		sseEvents   chan string
	)
	postCount := 0
	var seenHeaders []string

	legacySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sse" && r.Method == http.MethodGet {
			seenHeaders = append(seenHeaders, r.Header.Get("X-Legacy-Key"))
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)

			sseWriterMu.Lock()
			sseEvents = make(chan string, 16)
			ch := sseEvents
			sseWriterMu.Unlock()

			_, _ = fmt.Fprint(w, "event: endpoint\ndata: /messages?session=legacy-1\n\n")
			flusher.Flush()

			for {
				select {
				case msg, ok := <-ch:
					if !ok {
						return
					}
					_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
					flusher.Flush()
				case <-r.Context().Done():
					return
				}
			}
		}
		if r.URL.Path == "/messages" && r.Method == http.MethodPost {
			seenHeaders = append(seenHeaders, r.Header.Get("X-Legacy-Key"))
			var env rpcEnvelope
			if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			postCount++
			sseWriterMu.Lock()
			ch := sseEvents
			sseWriterMu.Unlock()

			if len(env.ID) == 0 {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			var payload []byte
			switch env.Method {
			case "initialize":
				payload, _ = json.Marshal(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": map[string]any{
						"protocolVersion": "2024-11-05",
						"capabilities":    map[string]any{"tools": map[string]any{}},
					},
				})
			case "tools/list":
				payload, _ = json.Marshal(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": map[string]any{
						"tools": []plugin.MCPToolDescriptor{}, // legitimate empty tool list!
					},
				})
			case "tools/call":
				payload, _ = json.Marshal(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": plugin.MCPCallToolResult{
						Content: []plugin.MCPToolContent{{Type: "text", Text: "legacy-ok"}},
					},
				})
			}
			ch <- string(payload)
			w.WriteHeader(http.StatusAccepted)
			return
		}
		http.NotFound(w, r)
	}))
	defer legacySrv.Close()

	rt := NewRuntime()
	defer rt.Close()

	cfg := domain.MCPServerConfig{
		ID:        "legacy-sse-1",
		Name:      "legacy",
		Transport: domain.MCPTransportSSE,
		Endpoint:  legacySrv.URL + "/sse",
		Headers:   map[string]string{"X-Legacy-Key": "legacy-secret"},
		Enabled:   true,
	}

	tools, err := rt.ListTools(ctx, cfg)
	if err != nil {
		t.Fatalf("legacy SSE ListTools failed: %v", err)
	}
	if tools == nil || len(tools) != 0 {
		t.Fatalf("expected non-nil empty tools slice [], got %#v", tools)
	}
	res, err := rt.CallTool(ctx, cfg, "legacy_tool", json.RawMessage(`{"a":1}`))
	if err != nil || len(res.Content) == 0 || res.Content[0].Text != "legacy-ok" {
		t.Fatalf("legacy SSE CallTool failed: res=%+v err=%v", res, err)
	}
	if len(seenHeaders) == 0 || seenHeaders[0] != "legacy-secret" {
		t.Fatalf("expected configured header on legacy SSE requests, got %v", seenHeaders)
	}
	if postCount < 3 {
		t.Fatalf("expected initialize + initialized + tools/list + tools/call POSTs, got %d", postCount)
	}
}
