//go:build linux || darwin

package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCommandWorkingDirectoryAndCancellation(t *testing.T) {
	if commandPath() == "" {
		t.Skip("bash unavailable")
	}
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	t.Setenv("LLMSTUDIO_ACCESS_TOKEN", "must-not-inherit")
	run := func(ctx context.Context, cmd string) (string, error) {
		raw, _ := json.Marshal(map[string]string{"command": cmd})
		return runCommand(ctx, root, raw)
	}
	out, err := run(t.Context(), `printf 'ok' > marker; printf '%s' "${LLMSTUDIO_ACCESS_TOKEN:-empty}"`)
	if err != nil || strings.TrimSpace(out) != "empty" {
		t.Fatalf("command: %q %v", out, err)
	}
	if b, err := root.ReadFile("marker"); err != nil || string(b) != "ok" {
		t.Fatalf("marker: %q %v", b, err)
	}
	for _, timeout := range []bool{false, true} {
		name := "canceled"
		if timeout {
			name = "deadline"
		}
		t.Run(name, func(t *testing.T) {
			var ctx context.Context
			var cancel context.CancelFunc
			if timeout {
				ctx, cancel = context.WithTimeout(t.Context(), 350*time.Millisecond)
			} else {
				ctx, cancel = context.WithCancel(t.Context())
			}
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := run(ctx, "(sleep 0.7; printf bad > "+name+") & printf started > "+name+".started; wait")
				done <- err
			}()
			until := time.Now().Add(300 * time.Millisecond)
			for {
				if _, err := root.Stat(name + ".started"); err == nil {
					break
				}
				if time.Now().After(until) {
					t.Fatal("child did not start")
				}
				time.Sleep(5 * time.Millisecond)
			}
			want := context.DeadlineExceeded
			if !timeout {
				cancel()
				want = context.Canceled
			}
			if err := <-done; !errors.Is(err, want) {
				t.Fatalf("got %v; want %v", err, want)
			}
			time.Sleep(750 * time.Millisecond)
			if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
				t.Fatalf("descendant escaped cancellation: %v", err)
			}
		})
	}
}
