package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	defaultIdleTimeout       = 5 * time.Minute
	defaultJanitorInterval   = 30 * time.Second
	defaultHTTPClientTimeout = 5 * time.Minute
)

// Option configures an MCP Runtime instance.
type Option func(*Runtime)

// WithIdleTimeout overrides the session idle eviction timeout (primarily for tests).
func WithIdleTimeout(d time.Duration) Option {
	return func(r *Runtime) {
		if d > 0 {
			r.idleTimeout = d
		}
	}
}

// WithJanitorInterval overrides how frequently idle sessions are swept (primarily for tests).
func WithJanitorInterval(d time.Duration) Option {
	return func(r *Runtime) {
		if d > 0 {
			r.janitorInterval = d
		}
	}
}

// WithHTTPClient overrides the base http.Client configuration (timeout/transport) for remote MCP calls.
func WithHTTPClient(client *http.Client) Option {
	return func(r *Runtime) {
		if client != nil {
			r.httpClient = client
		}
	}
}

type serverEntry struct {
	initMu sync.Mutex
	epoch  uint64
	sess   *managedSession
}

// Runtime implements plugin.MCPClientBoundary with stateful session reuse and lifecycle cleanup.
type Runtime struct {
	idleTimeout     time.Duration
	janitorInterval time.Duration
	httpClient      *http.Client

	mu        sync.Mutex
	closed    bool
	entries   map[string]*serverEntry
	stopCh    chan struct{}
	closeOnce sync.Once
	janitorWg sync.WaitGroup
}

// NewRuntime creates a new shared MCP client runtime with background idle eviction.
func NewRuntime(opts ...Option) *Runtime {
	r := &Runtime{
		idleTimeout:     defaultIdleTimeout,
		janitorInterval: defaultJanitorInterval,
		httpClient:      &http.Client{Timeout: defaultHTTPClientTimeout},
		entries:         make(map[string]*serverEntry),
		stopCh:          make(chan struct{}),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(r)
		}
	}
	r.janitorWg.Add(1)
	go r.janitorLoop()
	return r
}

// ID identifies this MCP client plugin.
func (r *Runtime) ID() string {
	return "mcp-runtime"
}

// ListTools discovers tools exposed by server, reusing an active matching session when healthy.
func (r *Runtime) ListTools(ctx context.Context, server domain.MCPServerConfig) ([]plugin.MCPToolDescriptor, error) {
	sess, err := r.getOrInitSession(ctx, server)
	if err != nil {
		return nil, err
	}
	tools, err := sess.listTools(ctx)
	if err != nil {
		if !sess.isHealthy() {
			r.evictIfSame(server.ID, sess)
		}
		return nil, err
	}
	return tools, nil
}

// CallTool invokes a named tool on server using its pooled session without auto-replaying submitted calls.
func (r *Runtime) CallTool(
	ctx context.Context,
	server domain.MCPServerConfig,
	name string,
	arguments json.RawMessage,
) (plugin.MCPCallToolResult, error) {
	sess, err := r.getOrInitSession(ctx, server)
	if err != nil {
		return plugin.MCPCallToolResult{}, err
	}
	res, err := sess.callTool(ctx, name, arguments)
	if err != nil {
		if !sess.isHealthy() {
			r.evictIfSame(server.ID, sess)
		}
		return plugin.MCPCallToolResult{}, err
	}
	return res, nil
}

// CloseServer terminates any active session for serverID so updated or disabled configurations cannot reuse it.
func (r *Runtime) CloseServer(serverID string) error {
	id := strings.TrimSpace(serverID)
	if id == "" {
		return nil
	}
	r.mu.Lock()
	entry, ok := r.entries[id]
	var oldSess *managedSession
	if ok {
		entry.epoch++
		oldSess = entry.sess
		entry.sess = nil
	}
	r.mu.Unlock()

	if oldSess != nil {
		return oldSess.close()
	}
	return nil
}

// Close stops the idle janitor and terminates all active MCP sessions cleanly.
func (r *Runtime) Close() error {
	var sessions []*managedSession
	r.closeOnce.Do(func() {
		close(r.stopCh)
		r.mu.Lock()
		r.closed = true
		for _, entry := range r.entries {
			entry.epoch++
			if entry.sess != nil {
				sessions = append(sessions, entry.sess)
				entry.sess = nil
			}
		}
		r.mu.Unlock()
	})
	r.janitorWg.Wait()

	var firstErr error
	for _, sess := range sessions {
		if err := sess.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (r *Runtime) getOrInitSession(ctx context.Context, server domain.MCPServerConfig) (*managedSession, error) {
	if !server.Enabled {
		_ = r.CloseServer(server.ID)
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "MCP server is disabled", nil)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	fp := serverFingerprint(server)

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, domain.NewError(domain.ErrCodeInternalError, "MCP runtime is closed", nil)
	}
	entry, ok := r.entries[server.ID]
	if !ok {
		entry = &serverEntry{}
		r.entries[server.ID] = entry
	}
	r.mu.Unlock()

	entry.initMu.Lock()
	defer entry.initMu.Unlock()

	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, domain.NewError(domain.ErrCodeInternalError, "MCP runtime is closed", nil)
	}
	existing := entry.sess
	startEpoch := entry.epoch
	r.mu.Unlock()

	if existing != nil {
		if existing.fingerprint == fp && existing.isHealthy() {
			return existing, nil
		}
		r.mu.Lock()
		if entry.sess == existing {
			entry.sess = nil
		}
		startEpoch = entry.epoch
		r.mu.Unlock()
		_ = existing.close()
	}

	newSess, err := startManagedSession(ctx, server, fp, r.httpClient)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	if r.closed || entry.epoch != startEpoch {
		r.mu.Unlock()
		_ = newSess.close()
		return nil, domain.NewError(domain.ErrCodeConflict, "MCP server session invalidated during initialization", nil)
	}
	entry.sess = newSess
	r.mu.Unlock()

	return newSess, nil
}

func (r *Runtime) evictIfSame(serverID string, target *managedSession) {
	r.mu.Lock()
	entry, ok := r.entries[serverID]
	var toClose *managedSession
	if ok && entry.sess == target {
		entry.sess = nil
		toClose = target
	}
	r.mu.Unlock()
	if toClose != nil {
		_ = toClose.close()
	}
}

func (r *Runtime) janitorLoop() {
	defer r.janitorWg.Done()
	ticker := time.NewTicker(r.janitorInterval)
	defer ticker.Stop()

	for {
		select {
		case <-r.stopCh:
			return
		case now := <-ticker.C:
			r.sweepIdle(now)
		}
	}
}

func (r *Runtime) sweepIdle(now time.Time) {
	var expired []*managedSession
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	for _, entry := range r.entries {
		if entry.sess == nil {
			continue
		}
		if entry.sess.idleSince(now) >= r.idleTimeout {
			expired = append(expired, entry.sess)
			entry.sess = nil
		}
	}
	r.mu.Unlock()

	for _, sess := range expired {
		_ = sess.close()
	}
}

func serverFingerprint(server domain.MCPServerConfig) string {
	type kv struct {
		K string `json:"k"`
		V string `json:"v"`
	}
	sortedPairs := func(m map[string]string) []kv {
		if len(m) == 0 {
			return nil
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		out := make([]kv, 0, len(keys))
		for _, k := range keys {
			out = append(out, kv{K: k, V: m[k]})
		}
		return out
	}

	raw, _ := json.Marshal(struct {
		ID        string   `json:"id"`
		Transport string   `json:"transport"`
		Endpoint  string   `json:"endpoint"`
		Command   string   `json:"command"`
		Args      []string `json:"args"`
		Env       []kv     `json:"env"`
		Headers   []kv     `json:"headers"`
		Enabled   bool     `json:"enabled"`
	}{
		ID:        server.ID,
		Transport: server.Transport,
		Endpoint:  server.Endpoint,
		Command:   server.Command,
		Args:      server.Args,
		Env:       sortedPairs(server.Env),
		Headers:   sortedPairs(server.Headers),
		Enabled:   server.Enabled,
	})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
