package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func TestStdioLifecycleStatefulPaginationCancelAndCrash(t *testing.T) {
	tempDir := t.TempDir()
	pidLogPath := filepath.Join(tempDir, "pids.log")
	callLogPath := filepath.Join(tempDir, "calls.log")

	rt := NewRuntime()
	defer func() {
		if err := rt.Close(); err != nil {
			t.Fatalf("runtime close: %v", err)
		}
	}()

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}

	server := domain.MCPServerConfig{
		ID:        "srv-stdio-1",
		Name:      "helper-stdio",
		Transport: domain.MCPTransportStdio,
		Command:   exe,
		Args:      []string{"-test.run=^TestMCPStdioHelperProcess$"},
		Env: map[string]string{
			"LLMSTUDIO_MCP_HELPER": "1",
			"HELPER_PID_LOG":       pidLogPath,
			"HELPER_CALL_LOG":      callLogPath,
			"HELPER_API_SECRET":    "super-secret-token-value",
		},
		Enabled: true,
	}

	ctx := context.Background()

	// 1. Initialize + paginated tools/list across two pages + server ping & unsupported sampling request.
	tools, err := rt.ListTools(ctx, server)
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	if len(tools) != 3 {
		t.Fatalf("expected 3 tools across 2 pages, got %d (%+v)", len(tools), tools)
	}
	if tools[0].Name != "counter_inc" || tools[0].Annotations == nil || tools[0].Annotations.ReadOnlyHint == nil || *tools[0].Annotations.ReadOnlyHint {
		t.Fatalf("unexpected first tool metadata: %+v", tools[0])
	}
	if len(tools[0].OutputSchema) == 0 {
		t.Fatalf("expected outputSchema preserved on tool descriptor")
	}

	// 2. Two stateful calls reuse the same process and increment session counter.
	res1, err := rt.CallTool(ctx, server, "counter_inc", json.RawMessage(`{"delta":2}`))
	if err != nil {
		t.Fatalf("first CallTool failed: %v", err)
	}
	if res1.IsError || len(res1.Content) == 0 || !strings.Contains(res1.Content[0].Text, "count=2") {
		t.Fatalf("unexpected first CallTool result: %+v", res1)
	}
	var sc1 struct {
		Count             int  `json:"count"`
		SamplingRejected  bool `json:"samplingRejected"`
		HelperEnvReceived bool `json:"helperEnvReceived"`
	}
	if err := json.Unmarshal(res1.StructuredContent, &sc1); err != nil {
		t.Fatalf("unmarshal structuredContent: %v", err)
	}
	if sc1.Count != 2 || !sc1.SamplingRejected || !sc1.HelperEnvReceived {
		t.Fatalf("unexpected structuredContent state: %+v", sc1)
	}

	res2, err := rt.CallTool(ctx, server, "counter_inc", json.RawMessage(`{"delta":3}`))
	if err != nil {
		t.Fatalf("second CallTool failed: %v", err)
	}
	var sc2 struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(res2.StructuredContent, &sc2); err != nil {
		t.Fatalf("unmarshal structuredContent #2: %v", err)
	}
	if sc2.Count != 5 {
		t.Fatalf("expected cumulative stateful count=5 on reused stdio process, got %d", sc2.Count)
	}

	// Verify only 1 process spawned so far.
	pidLines := readLines(t, pidLogPath)
	if len(pidLines) != 1 {
		t.Fatalf("expected 1 spawned stdio process before restart, got %d (%v)", len(pidLines), pidLines)
	}

	// 3. Tool-level isError preserves structuredContent/content and keeps session alive.
	errRes, err := rt.CallTool(ctx, server, "fail_soft", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("soft tool error should return MCPCallToolResult without RPC failure: %v", err)
	}
	if !errRes.IsError || len(errRes.Content) == 0 || errRes.Content[0].Text != "business failure" {
		t.Fatalf("unexpected soft isError result: %+v", errRes)
	}

	// 4. Context cancellation interrupts an in-flight slow tool call quickly without leaking or spawning another process.
	cancelCtx, cancel := context.WithTimeout(ctx, 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = rt.CallTool(cancelCtx, server, "slow_tool", json.RawMessage(`{}`))
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Fatalf("expected deadline/cancel error on slow_tool, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("CallTool cancellation took too long: %v", time.Since(start))
	}

	// Session remains usable after per-call cancellation and refreshes tools on list_changed.
	_, err = rt.CallTool(ctx, server, "emit_list_changed", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("emit_list_changed failed: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		updatedTools, listErr := rt.ListTools(ctx, server)
		if listErr != nil {
			t.Fatalf("ListTools after list_changed failed: %v", listErr)
		}
		if len(updatedTools) == 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected tools catalog invalidated to 4 tools, still %d", len(updatedTools))
		}
		time.Sleep(15 * time.Millisecond)
	}

	// 5. Process crash during committed call MUST fail without auto-replaying the call, and redact secret env values.
	callsBeforeCrash := len(readLines(t, callLogPath))
	_, crashErr := rt.CallTool(ctx, server, "crash_after_commit", json.RawMessage(`{"op":"charge-once"}`))
	if crashErr == nil {
		t.Fatalf("expected error when stdio child crashes mid-call")
	}
	if strings.Contains(crashErr.Error(), "super-secret-token-value") {
		t.Fatalf("error leaked secret env value: %q", crashErr.Error())
	}
	callsAfterCrash := readLines(t, callLogPath)
	crashCount := 0
	for _, line := range callsAfterCrash {
		if line == "crash_after_commit" {
			crashCount++
		}
	}
	if crashCount != 1 || len(callsAfterCrash) != callsBeforeCrash+1 {
		t.Fatalf("committed tool call must NEVER auto-replay (crashCount=%d, calls=%v)", crashCount, callsAfterCrash)
	}

	// 6. Next fresh call re-initializes a clean process cleanly with reset state.
	resFresh, err := rt.CallTool(ctx, server, "counter_inc", json.RawMessage(`{"delta":1}`))
	if err != nil {
		t.Fatalf("fresh CallTool after crash recovery failed: %v", err)
	}
	var scFresh struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(resFresh.StructuredContent, &scFresh); err != nil {
		t.Fatalf("unmarshal fresh structuredContent: %v", err)
	}
	if scFresh.Count != 1 {
		t.Fatalf("expected reset count=1 in newly spawned stdio process, got %d", scFresh.Count)
	}
	if pids := readLines(t, pidLogPath); len(pids) != 2 {
		t.Fatalf("expected exactly 2 processes total (initial + post-crash), got %d", len(pids))
	}

	// 7. Close runtime kills helper cleanly without hanging.
	if err := rt.Close(); err != nil {
		t.Fatalf("explicit close failed: %v", err)
	}
	if _, err := rt.ListTools(ctx, server); err == nil {
		t.Fatalf("expected error using closed runtime")
	}
}

func TestStdioIdleEvictionAndConfigChangeInvalidation(t *testing.T) {
	tempDir := t.TempDir()
	pidLogPath := filepath.Join(tempDir, "idle-pids.log")

	rt := NewRuntime(
		WithIdleTimeout(60*time.Millisecond),
		WithJanitorInterval(15*time.Millisecond),
	)
	defer rt.Close()

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}

	server := domain.MCPServerConfig{
		ID:        "srv-idle",
		Name:      "idle-stdio",
		Transport: domain.MCPTransportStdio,
		Command:   exe,
		Args:      []string{"-test.run=^TestMCPStdioHelperProcess$"},
		Env: map[string]string{
			"LLMSTUDIO_MCP_HELPER": "1",
			"HELPER_PID_LOG":       pidLogPath,
		},
		Enabled: true,
	}

	if _, err := rt.ListTools(context.Background(), server); err != nil {
		t.Fatalf("initial ListTools failed: %v", err)
	}

	// Wait past idle timeout so janitor evicts the idle session.
	time.Sleep(160 * time.Millisecond)

	if _, err := rt.ListTools(context.Background(), server); err != nil {
		t.Fatalf("re-init ListTools after idle eviction failed: %v", err)
	}
	if pids := readLines(t, pidLogPath); len(pids) != 2 {
		t.Fatalf("expected idle timeout eviction to spawn a fresh 2nd process, got %d", len(pids))
	}

	// Config change spawns a new process immediately.
	updated := server
	updated.Env = map[string]string{
		"LLMSTUDIO_MCP_HELPER": "1",
		"HELPER_PID_LOG":       pidLogPath,
		"EXTRA_FLAG":           "changed",
	}
	if _, err := rt.ListTools(context.Background(), updated); err != nil {
		t.Fatalf("ListTools with updated config failed: %v", err)
	}
	if pids := readLines(t, pidLogPath); len(pids) != 3 {
		t.Fatalf("expected config change to invalidate old session and start 3rd process, got %d", len(pids))
	}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read file %s: %v", path, err)
	}
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// TestMCPStdioHelperProcess acts as a real child MCP stdio server when LLMSTUDIO_MCP_HELPER=1.
func TestMCPStdioHelperProcess(t *testing.T) {
	if os.Getenv("LLMSTUDIO_MCP_HELPER") != "1" {
		return
	}

	appendLine := func(path, line string) {
		if path == "" {
			return
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return
		}
		_, _ = fmt.Fprintln(f, line)
		_ = f.Close()
	}

	appendLine(os.Getenv("HELPER_PID_LOG"), strconv.Itoa(os.Getpid()))

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	writeMsg := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = fmt.Fprintf(os.Stdout, "%s\n", b)
	}

	readCh := make(chan rpcEnvelope, 16)
	go func() {
		defer close(readCh)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var env rpcEnvelope
			if err := json.Unmarshal([]byte(line), &env); err != nil {
				continue
			}
			readCh <- env
		}
	}()

	readOne := func() (rpcEnvelope, bool) {
		env, ok := <-readCh
		return env, ok
	}

	counter := 0
	samplingRejected := false
	listExpanded := false

	for {
		env, ok := readOne()
		if !ok {
			os.Exit(0)
		}

		// Server notifications do not get responses.
		if len(env.ID) == 0 && env.Method != "" {
			continue
		}

		switch env.Method {
		case "initialize":
			// First verify client handles server->client ping and rejects unsupported sampling with -32601.
			writeMsg(map[string]any{
				"jsonrpc": "2.0",
				"id":      "srv-ping-1",
				"method":  "ping",
			})
			if pong, ok := readOne(); !ok || pong.Error != nil {
				os.Exit(2)
			}
			writeMsg(map[string]any{
				"jsonrpc": "2.0",
				"id":      "srv-sample-1",
				"method":  "sampling/createMessage",
				"params":  map[string]any{},
			})
			if sampleResp, ok := readOne(); ok && sampleResp.Error != nil && sampleResp.Error.Code == -32601 {
				samplingRejected = true
			}

			writeMsg(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(env.ID),
				"result": map[string]any{
					"protocolVersion": "2025-11-25",
					"capabilities": map[string]any{
						"tools": map[string]any{"listChanged": true},
					},
					"serverInfo": map[string]string{"name": "helper", "version": "1.0.0"},
				},
			})

		case "tools/list":
			var params struct {
				Cursor string `json:"cursor"`
			}
			_ = json.Unmarshal(env.Params, &params)
			if params.Cursor == "" {
				writeMsg(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": map[string]any{
						"tools": []plugin.MCPToolDescriptor{
							{
								Name:         "counter_inc",
								Description:  "Increment stateful counter",
								InputSchema:  json.RawMessage(`{"type":"object","properties":{"delta":{"type":"integer"}}}`),
								OutputSchema: json.RawMessage(`{"type":"object","properties":{"count":{"type":"integer"}}}`),
								Annotations:  &plugin.MCPToolAnnotations{ReadOnlyHint: domain.BoolPtr(false)},
							},
							{
								Name:        "fail_soft",
								Description: "Returns MCP isError=true",
								InputSchema: json.RawMessage(`{"type":"object"}`),
							},
						},
						"nextCursor": "page-2",
					},
				})
			} else {
				page2Tools := []plugin.MCPToolDescriptor{
					{
						Name:        "slow_tool",
						Description: "Waits unless cancelled",
						InputSchema: json.RawMessage(`{"type":"object"}`),
					},
				}
				if listExpanded {
					page2Tools = append(page2Tools, plugin.MCPToolDescriptor{
						Name:        "extra_dynamic_tool",
						Description: "Appears after list_changed",
						InputSchema: json.RawMessage(`{"type":"object"}`),
					})
				}
				writeMsg(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": map[string]any{
						"tools": page2Tools,
					},
				})
			}

		case "tools/call":
			var callParams struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			_ = json.Unmarshal(env.Params, &callParams)
			appendLine(os.Getenv("HELPER_CALL_LOG"), callParams.Name)

			switch callParams.Name {
			case "counter_inc":
				var args struct {
					Delta int `json:"delta"`
				}
				_ = json.Unmarshal(callParams.Arguments, &args)
				if args.Delta == 0 {
					args.Delta = 1
				}
				counter += args.Delta
				writeMsg(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": plugin.MCPCallToolResult{
						Content: []plugin.MCPToolContent{
							{Type: "text", Text: fmt.Sprintf("count=%d", counter)},
						},
						StructuredContent: json.RawMessage(fmt.Sprintf(
							`{"count":%d,"samplingRejected":%t,"helperEnvReceived":%t}`,
							counter,
							samplingRejected,
							os.Getenv("HELPER_API_SECRET") == "super-secret-token-value",
						)),
					},
				})

			case "fail_soft":
				writeMsg(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": plugin.MCPCallToolResult{
						Content: []plugin.MCPToolContent{{Type: "text", Text: "business failure"}},
						IsError: true,
					},
				})

			case "slow_tool":
				cancelled := false
				timer := time.NewTimer(6 * time.Second)
				for !cancelled {
					select {
					case next, ok := <-readCh:
						if !ok {
							timer.Stop()
							os.Exit(0)
						}
						if next.Method == "notifications/cancelled" {
							cancelled = true
						}
					case <-timer.C:
						goto finishSlow
					}
				}
			finishSlow:
				timer.Stop()
				if !cancelled {
					writeMsg(map[string]any{
						"jsonrpc": "2.0",
						"id":      json.RawMessage(env.ID),
						"result": plugin.MCPCallToolResult{
							Content: []plugin.MCPToolContent{{Type: "text", Text: "slow finished"}},
						},
					})
				}

			case "emit_list_changed":
				listExpanded = true
				writeMsg(map[string]any{
					"jsonrpc": "2.0",
					"method":  "notifications/tools/list_changed",
				})
				writeMsg(map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(env.ID),
					"result": plugin.MCPCallToolResult{
						Content: []plugin.MCPToolContent{{Type: "text", Text: "notified"}},
					},
				})

			case "crash_after_commit":
				_, _ = fmt.Fprintf(os.Stderr, "fatal error with %s", os.Getenv("HELPER_API_SECRET"))
				os.Exit(17)
			}
		}
	}
}
