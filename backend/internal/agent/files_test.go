package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileToolsWorkspaceBoundary(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "sentinel.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "src", "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ctx := context.Background()
	run := func(name, raw string) (string, error) { return runFile(ctx, root, name, json.RawMessage(raw)) }
	check := func(name, raw, contains string) {
		t.Helper()
		out, err := run(name, raw)
		if err != nil || !strings.Contains(out, contains) {
			t.Fatalf("%s = %q, %v; wanted %q", name, out, err, contains)
		}
	}
	fail := func(name, raw string) {
		t.Helper()
		if out, err := run(name, raw); err == nil {
			t.Fatalf("%s unexpectedly succeeded: %q", name, out)
		}
	}
	check("write", `{"path":"src/nested/a.txt","content":"first\nsecond\nrepeat repeat"}`, "26 bytes")
	check("read", `{"path":"src/nested/a.txt","offset":2,"limit":1}`, "2: second")
	check("ls", `{"path":"src"}`, "nested/")
	check("find", `{"pattern":"src/**/*.txt"}`, "src/nested/a.txt")
	check("grep", `{"pattern":"^sec","regex":true,"glob":"*.txt"}`, "src/nested/a.txt:2: second")
	check("grep", `{"pattern":"repeat repeat"}`, "repeat repeat")
	fail("edit", `{"path":"src/nested/a.txt","oldText":"repeat","newText":"X"}`)
	fail("edit", `{"path":"src/nested/a.txt","oldText":"missing","newText":"X"}`)
	check("read", `{"path":"src/nested/a.txt"}`, "repeat repeat")
	check("edit", `{"path":"src/nested/a.txt","oldText":"second","newText":"fixed"}`, "bytes")
	check("read", `{"path":"src/nested/a.txt","offset":2,"limit":1}`, "2: fixed")
	for _, path := range []string{"../sentinel.txt", outside, `C:/outside.txt`} {
		payload, _ := json.Marshal(map[string]string{"path": path})
		fail("read", string(payload))
		payload, _ = json.Marshal(map[string]string{"path": path, "content": "changed"})
		fail("write", string(payload))
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err == nil {
		fail("read", `{"path":"link.txt"}`)
		fail("write", `{"path":"link.txt","content":"changed"}`)
		fail("edit", `{"path":"link.txt","oldText":"outside","newText":"changed"}`)
	}
	if b, err := os.ReadFile(outside); err != nil || string(b) != "outside" {
		t.Fatalf("outside: %q %v", b, err)
	}
	if err := root.WriteFile("big.txt", []byte(strings.Repeat("x", maxOutput*2)), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := run("read", `{"path":"big.txt"}`)
	if err != nil || len(out) > maxOutput || !strings.Contains(out, "[output truncated]") {
		t.Fatalf("output length %d: %v", len(out), err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := runFile(canceled, root, "grep", json.RawMessage(`{"pattern":"x"}`)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
