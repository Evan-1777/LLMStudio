package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"llmstudio/backend/internal/domain"
)

const (
	maxStderrCaptureBytes = 4096
	stdioWaitDelay        = 300 * time.Millisecond
	cancelNotifyTimeout   = 500 * time.Millisecond
)

type transportClient interface {
	Call(ctx context.Context, method string, params any) ([]byte, error)
	Notify(ctx context.Context, method string, params any) error
	ProtocolVersion() string
	SetProtocolVersion(version string)
	Alive() bool
	Done() <-chan struct{}
	Close() error
}

type stdioTransport struct {
	server  domain.MCPServerConfig
	peer    *rpcPeer
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	closing   atomic.Bool
	doneCh    chan struct{}

	errMu    sync.Mutex
	fatalErr error

	versionMu sync.RWMutex
	version   string
}

func startStdioTransport(
	server domain.MCPServerConfig,
	onNotify func(method string, params json.RawMessage),
) (*stdioTransport, error) {
	command := strings.TrimSpace(server.Command)
	if command == "" {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "MCP stdio command is required", nil)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, command, server.Args...)
	configureStdioCmd(cmd)
	cmd.Env = buildStdioEnv(os.Environ(), server.Env)
	cmd.WaitDelay = stdioWaitDelay

	stderrTail := newCappedTailBuffer(maxStderrCaptureBytes)
	cmd.Stderr = stderrTail

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("open mcp stdio stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		cancel()
		return nil, fmt.Errorf("open mcp stdio stdout: %w", err)
	}

	t := &stdioTransport{
		server: server,
		cmd:    cmd,
		stdin:  stdin,
		ctx:    ctx,
		cancel: cancel,
		doneCh: make(chan struct{}),
	}
	cmd.Cancel = func() error {
		_ = stdin.Close()
		if cmd.Process != nil {
			return cmd.Process.Kill()
		}
		return nil
	}

	t.peer = newRPCPeer(t.writeLine, onNotify)

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		cancel()
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("start MCP stdio server %q: %v", server.Name, redactSecrets(err.Error(), server)), err)
	}

	go t.readLoop(stdout, stderrTail)

	return t, nil
}

func (t *stdioTransport) SetProtocolVersion(version string) {
	t.versionMu.Lock()
	t.version = version
	t.versionMu.Unlock()
}

func (t *stdioTransport) ProtocolVersion() string {
	t.versionMu.RLock()
	defer t.versionMu.RUnlock()
	return t.version
}

func (t *stdioTransport) Done() <-chan struct{} {
	return t.doneCh
}

func (t *stdioTransport) Alive() bool {
	select {
	case <-t.doneCh:
		return false
	default:
		return true
	}
}

func (t *stdioTransport) writeLine(ctx context.Context, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !t.Alive() {
		return t.exitError()
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if !t.Alive() {
		return t.exitError()
	}
	line := make([]byte, len(payload)+1)
	copy(line, payload)
	line[len(payload)] = '\n'
	_, err := t.stdin.Write(line)
	if err != nil {
		return fmt.Errorf("write mcp stdio request: %w", err)
	}
	return nil
}

func (t *stdioTransport) Call(ctx context.Context, method string, params any) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !t.Alive() {
		return nil, t.exitError()
	}

	id, idKey := t.peer.allocID()
	payload, err := encodeRPCRequest(id, method, params)
	if err != nil {
		return nil, err
	}

	waitCh := t.peer.registerWaiter(idKey)
	if err := t.writeLine(ctx, payload); err != nil {
		t.peer.unregisterWaiter(idKey)
		return nil, err
	}

	select {
	case msg := <-waitCh:
		if msg.err != nil {
			return nil, msg.err
		}
		if msg.rpcErr != nil {
			return nil, msg.rpcErr
		}
		return msg.result, nil
	case <-t.doneCh:
		t.peer.unregisterWaiter(idKey)
		return nil, t.exitError()
	case <-ctx.Done():
		t.peer.unregisterWaiter(idKey)
		// Cooperative cancellation notification; bounded and best-effort.
		cancelCtx, cancel := context.WithTimeout(context.Background(), cancelNotifyTimeout)
		defer cancel()
		_ = t.Notify(cancelCtx, "notifications/cancelled", map[string]any{
			"requestId": id,
			"reason":    "client request cancelled",
		})
		return nil, ctx.Err()
	}
}

func (t *stdioTransport) Notify(ctx context.Context, method string, params any) error {
	payload, err := encodeRPCNotification(method, params)
	if err != nil {
		return err
	}
	return t.writeLine(ctx, payload)
}

func (t *stdioTransport) readLoop(stdout io.Reader, stderrTail *cappedTailBuffer) {
	reader := bufio.NewReaderSize(stdout, 64*1024)
	var readErr error
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := bytes.TrimSpace(line)
			if len(trimmed) > 0 {
				if handleErr := t.peer.handleIncoming(t.ctx, trimmed); handleErr != nil {
					readErr = handleErr
					break
				}
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}

	if readErr != nil {
		t.cancel()
	}
	waitErr := t.cmd.Wait()
	finalErr := t.buildExitError(readErr, waitErr, redactSecrets(stderrTail.String(), t.server))
	t.setFatalErr(finalErr)
	close(t.doneCh)
	t.peer.failAllPending(finalErr)
}

func (t *stdioTransport) buildExitError(readErr, waitErr error, stderrSnippet string) error {
	if t.closing.Load() {
		return errors.New("mcp stdio session closed")
	}
	parts := make([]string, 0, 3)
	if readErr != nil {
		parts = append(parts, readErr.Error())
	} else if waitErr != nil {
		parts = append(parts, waitErr.Error())
	} else {
		parts = append(parts, "eof")
	}
	if stderrSnippet != "" {
		parts = append(parts, "stderr: "+stderrSnippet)
	}
	return fmt.Errorf("mcp stdio server %q terminated (%s)", t.server.Name, strings.Join(parts, "; "))
}

func (t *stdioTransport) setFatalErr(err error) {
	t.errMu.Lock()
	if t.fatalErr == nil {
		t.fatalErr = err
	}
	t.errMu.Unlock()
}

func (t *stdioTransport) exitError() error {
	t.errMu.Lock()
	err := t.fatalErr
	t.errMu.Unlock()
	if err != nil {
		return err
	}
	return errors.New("mcp stdio session closed")
}

func (t *stdioTransport) Close() error {
	t.closeOnce.Do(func() {
		t.closing.Store(true)
		_ = t.stdin.Close()
		t.cancel()
	})
	<-t.doneCh
	return nil
}

func buildStdioEnv(base []string, overrides map[string]string) []string {
	merged := make(map[string]string, len(base)+len(overrides))
	order := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		k, v, ok := strings.Cut(entry, "=")
		if !ok || k == "" {
			continue
		}
		if _, exists := merged[k]; !exists {
			order = append(order, k)
		}
		merged[k] = v
	}
	overrideKeys := make([]string, 0, len(overrides))
	for k := range overrides {
		overrideKeys = append(overrideKeys, k)
	}
	slices.Sort(overrideKeys)
	for _, k := range overrideKeys {
		kClean := strings.TrimSpace(k)
		if kClean == "" {
			continue
		}
		if _, exists := merged[kClean]; !exists {
			order = append(order, kClean)
		}
		merged[kClean] = overrides[k]
	}
	out := make([]string, 0, len(order))
	for _, k := range order {
		out = append(out, k+"="+merged[k])
	}
	return out
}

func redactSecrets(text string, server domain.MCPServerConfig) string {
	cleaned := strings.TrimSpace(text)
	if cleaned == "" {
		return ""
	}
	for _, val := range server.Env {
		if len(val) >= 4 {
			cleaned = strings.ReplaceAll(cleaned, val, "[REDACTED]")
		}
	}
	for _, val := range server.Headers {
		if len(val) >= 4 {
			cleaned = strings.ReplaceAll(cleaned, val, "[REDACTED]")
		}
	}
	return cleaned
}

type cappedTailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newCappedTailBuffer(max int) *cappedTailBuffer {
	return &cappedTailBuffer{max: max}
}

func (b *cappedTailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(p) >= b.max {
		b.buf = append(b.buf[:0], p[len(p)-b.max:]...)
		return len(p), nil
	}
	overflow := len(b.buf) + len(p) - b.max
	if overflow > 0 {
		b.buf = append(b.buf[:0], b.buf[overflow:]...)
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *cappedTailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}
