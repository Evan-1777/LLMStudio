package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"llmstudio/backend/internal/domain"
)

type AgentStore struct{ db *sql.DB }

func NewAgentStore(db *sql.DB) *AgentStore { return &AgentStore{db} }

func (s *AgentStore) AgentSettings(ctx context.Context) (string, []string, error) {
	var path, raw string
	if err := s.db.QueryRowContext(ctx, "SELECT default_directory, allowed_tools_json FROM agent_settings WHERE id = 1").Scan(&path, &raw); err != nil {
		return "", nil, err
	}
	tools := []string{}
	if err := json.Unmarshal([]byte(raw), &tools); err != nil {
		return "", nil, err
	}
	if tools == nil {
		return "", nil, errors.New("invalid agent allowlist")
	}
	return path, tools, nil
}

func (s *AgentStore) UpdateAgentSettings(ctx context.Context, directory *string, tools *[]string) error {
	var raw *string
	if tools != nil {
		data, err := json.Marshal(*tools)
		if err != nil {
			return err
		}
		text := string(data)
		raw = &text
	}
	_, err := s.db.ExecContext(ctx, "UPDATE agent_settings SET default_directory = COALESCE(?, default_directory), allowed_tools_json = COALESCE(?, allowed_tools_json) WHERE id = 1", directory, raw)
	return err
}

func (s *AgentStore) AgentTopic(ctx context.Context, id string) (mode, directory string, err error) {
	err = s.db.QueryRowContext(ctx, "SELECT c.mode, COALESCE(d.directory, '') FROM conversations c LEFT JOIN agent_conversation_directories d ON d.conversation_id = c.id WHERE c.id = ?", id).Scan(&mode, &directory)
	if errors.Is(err, sql.ErrNoRows) {
		err = domain.NewError(domain.ErrCodeNotFound, "conversation not found", err)
	}
	return
}

func (s *AgentStore) SetAgentDirectory(ctx context.Context, id, directory string) error {
	if directory == "" {
		_, err := s.db.ExecContext(ctx, "DELETE FROM agent_conversation_directories WHERE conversation_id = ?", id)
		return err
	}
	_, err := s.db.ExecContext(ctx, "INSERT INTO agent_conversation_directories(conversation_id, directory) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET directory = excluded.directory", id, directory)
	return err
}
