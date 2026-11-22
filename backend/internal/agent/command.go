package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"llmstudio/backend/internal/plugin"
)

func commandTool() plugin.ChatTool {
	return plugin.ChatTool{Alias: "bash", Description: "Run a command using " + shellSyntax + " from the workspace. The working directory is not a sandbox.", InputSchema: schema([]string{"command"}, map[string]string{"command": "string"})}
}

func runCommand(ctx context.Context, root *os.Root, raw json.RawMessage) (string, error) {
	var args struct{ Command string }
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil || strings.TrimSpace(args.Command) == "" || len(args.Command) > 16000 || strings.ContainsRune(args.Command, 0) {
		return "", errors.New("a valid command is required (maximum 16000 bytes)")
	}
	shell := commandPath()
	if shell == "" {
		return "", errors.New("shell unavailable")
	}
	r, w, err := os.Pipe()
	if err != nil {
		return "", err
	}
	defer r.Close()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var out commandOutput
	done := make(chan struct{})
	go func() { defer close(done); _, _ = io.Copy(&out, r) }()
	err = launchCommand(ctx, shell, root.Name(), args.Command, w)
	w.Close()
	select {
	case <-done:
	case <-ctx.Done():
		r.Close()
		<-done
	}
	return strings.ToValidUTF8(out.String(), "?"), err
}

type commandOutput struct{ strings.Builder }

func (o *commandOutput) Write(p []byte) (int, error) {
	const marker = "\n[output truncated]"
	budget := maxOutput - len(marker) - o.Len()
	if budget >= 0 {
		o.Builder.Write(p[:min(len(p), budget)])
		if len(p) > budget {
			o.WriteString(marker)
		}
	}
	return len(p), nil
}

// Only shell/user environment is inherited, not gateway connection variables.
func commandEnvironment() []string {
	var env []string
	for _, name := range []string{"PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "LOCALAPPDATA", "APPDATA"} {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}
