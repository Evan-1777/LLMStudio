package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
)

// MCPServerStore manages persisted MCPServerConfig records in SQLite.
type MCPServerStore struct {
	db *sql.DB
}

// NewMCPServerStore constructs an MCPServerStore backed by db.
func NewMCPServerStore(db *sql.DB) *MCPServerStore {
	return &MCPServerStore{db: db}
}

// List returns all configured MCP servers ordered by creation time and name.
func (s *MCPServerStore) List(ctx context.Context) ([]domain.MCPServerConfig, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, transport, endpoint, command, args_json, env_json, headers_json, enabled, disabled_tools_json, created_at, updated_at
		FROM mcp_servers
		ORDER BY created_at ASC, name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list mcp servers: %w", err)
	}
	defer rows.Close()

	items := make([]domain.MCPServerConfig, 0)
	for rows.Next() {
		srv, err := scanMCPServer(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, srv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate mcp servers: %w", err)
	}
	return items, nil
}

// Get fetches a single MCP server configuration by ID.
func (s *MCPServerStore) Get(ctx context.Context, id string) (domain.MCPServerConfig, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, transport, endpoint, command, args_json, env_json, headers_json, enabled, disabled_tools_json, created_at, updated_at
		FROM mcp_servers
		WHERE id = ?
	`, id)
	srv, err := scanMCPServer(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeNotFound, "mcp server not found", err)
	}
	if err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("get mcp server %s: %w", id, err)
	}
	return srv, nil
}

// Create inserts a new MCP server configuration.
func (s *MCPServerStore) Create(ctx context.Context, srv domain.MCPServerConfig) (domain.MCPServerConfig, error) {
	now := time.Now().UTC()
	if srv.ID == "" {
		srv.ID = domain.NewUUID()
	}
	if srv.CreatedAt.IsZero() {
		srv.CreatedAt = now
	}
	if srv.UpdatedAt.IsZero() {
		srv.UpdatedAt = srv.CreatedAt
	}
	argsJSON, envJSON, headersJSON, err := encodeMCPJSON(srv.Args, srv.Env, srv.Headers)
	if err != nil {
		return domain.MCPServerConfig{}, err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO mcp_servers (
			id, name, transport, endpoint, command, args_json, env_json, headers_json, enabled, disabled_tools_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?)
	`, srv.ID, srv.Name, srv.Transport, srv.Endpoint, srv.Command, argsJSON, envJSON, headersJSON,
		boolToInt(srv.Enabled), encodeDisabledTools(srv.DisabledTools), formatTime(srv.CreatedAt), formatTime(srv.UpdatedAt))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeConflict, "mcp server already exists", err)
		}
		return domain.MCPServerConfig{}, fmt.Errorf("create mcp server: %w", err)
	}
	return s.Get(ctx, srv.ID)
}

// Update overwrites mutable fields of an existing MCP server configuration.
func (s *MCPServerStore) Update(ctx context.Context, srv domain.MCPServerConfig) (domain.MCPServerConfig, error) {
	srv.UpdatedAt = time.Now().UTC()
	argsJSON, envJSON, headersJSON, err := encodeMCPJSON(srv.Args, srv.Env, srv.Headers)
	if err != nil {
		return domain.MCPServerConfig{}, err
	}

	res, err := s.db.ExecContext(ctx, `
		UPDATE mcp_servers
		SET name = ?, transport = ?, endpoint = ?, command = ?, args_json = ?, env_json = ?, headers_json = ?, enabled = ?, disabled_tools_json = COALESCE(?, disabled_tools_json), updated_at = ?
		WHERE id = ?
	`, srv.Name, srv.Transport, srv.Endpoint, srv.Command, argsJSON, envJSON, headersJSON,
		boolToInt(srv.Enabled), encodeDisabledTools(srv.DisabledTools), formatTime(srv.UpdatedAt), srv.ID)
	if err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("update mcp server %s: %w", srv.ID, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("rows affected update mcp server %s: %w", srv.ID, err)
	}
	if affected == 0 {
		return domain.MCPServerConfig{}, domain.NewError(domain.ErrCodeNotFound, "mcp server not found", nil)
	}
	return s.Get(ctx, srv.ID)
}

// Delete removes an MCP server configuration by ID.
func (s *MCPServerStore) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM mcp_servers WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete mcp server %s: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected delete mcp server %s: %w", id, err)
	}
	if affected == 0 {
		return domain.NewError(domain.ErrCodeNotFound, "mcp server not found", nil)
	}
	return nil
}

func scanMCPServer(row rowScanner) (domain.MCPServerConfig, error) {
	var (
		srv          domain.MCPServerConfig
		argsJSON     string
		envJSON      string
		headersJSON  string
		disabledJSON string
		enabledInt   int
		createdRaw   string
		updatedRaw   string
	)
	if err := row.Scan(
		&srv.ID, &srv.Name, &srv.Transport, &srv.Endpoint, &srv.Command,
		&argsJSON, &envJSON, &headersJSON, &enabledInt, &disabledJSON, &createdRaw, &updatedRaw,
	); err != nil {
		return domain.MCPServerConfig{}, err
	}
	srv.Enabled = enabledInt != 0
	if err := json.Unmarshal([]byte(disabledJSON), &srv.DisabledTools); err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("decode disabled MCP tools: %w", err)
	}
	if argsJSON == "" {
		srv.Args = []string{}
	} else if err := json.Unmarshal([]byte(argsJSON), &srv.Args); err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("decode mcp args: %w", err)
	}
	if srv.Args == nil {
		srv.Args = []string{}
	}
	if envJSON != "" && envJSON != "{}" {
		if err := json.Unmarshal([]byte(envJSON), &srv.Env); err != nil {
			return domain.MCPServerConfig{}, fmt.Errorf("decode mcp env: %w", err)
		}
	}
	if headersJSON != "" && headersJSON != "{}" {
		if err := json.Unmarshal([]byte(headersJSON), &srv.Headers); err != nil {
			return domain.MCPServerConfig{}, fmt.Errorf("decode mcp headers: %w", err)
		}
	}
	var err error
	if srv.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("parse mcp created_at: %w", err)
	}
	if srv.UpdatedAt, err = parseTime(updatedRaw); err != nil {
		return domain.MCPServerConfig{}, fmt.Errorf("parse mcp updated_at: %w", err)
	}
	return srv, nil
}

// A nil list preserves the stored value on update; an empty list clears it.
func encodeDisabledTools(tools []string) any {
	if tools == nil {
		return nil
	}
	b, _ := json.Marshal(tools)
	return string(b)
}

func encodeMCPJSON(args []string, env, headers map[string]string) (string, string, string, error) {
	if args == nil {
		args = []string{}
	}
	if env == nil {
		env = map[string]string{}
	}
	if headers == nil {
		headers = map[string]string{}
	}
	aBytes, err := json.Marshal(args)
	if err != nil {
		return "", "", "", fmt.Errorf("encode mcp args: %w", err)
	}
	eBytes, err := json.Marshal(env)
	if err != nil {
		return "", "", "", fmt.Errorf("encode mcp env: %w", err)
	}
	hBytes, err := json.Marshal(headers)
	if err != nil {
		return "", "", "", fmt.Errorf("encode mcp headers: %w", err)
	}
	return string(aBytes), string(eBytes), string(hBytes), nil
}
