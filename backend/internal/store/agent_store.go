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

// AgentPolicyRecord represents the persisted execution-endpoint Agent policy.
type AgentPolicyRecord struct {
	DefaultDirectory     string
	AllowedTools         []string
	InjectAgentMD        bool
	MarkdownVisualRender bool
}

// AgentPolicyPatch updates selected Agent policy fields while leaving nil fields unchanged.
type AgentPolicyPatch struct {
	DefaultDirectory     *string
	AllowedTools         *[]string
	InjectAgentMD        *bool
	MarkdownVisualRender *bool
}

func (s *AgentStore) AgentSettings(ctx context.Context) (AgentPolicyRecord, error) {
	var (
		path, raw              string
		injectInt, visualInt   int
	)
	if err := s.db.QueryRowContext(
		ctx,
		"SELECT default_directory, allowed_tools_json, inject_agent_md, markdown_visual_render FROM agent_settings WHERE id = 1",
	).Scan(&path, &raw, &injectInt, &visualInt); err != nil {
		return AgentPolicyRecord{}, err
	}
	tools := []string{}
	if err := json.Unmarshal([]byte(raw), &tools); err != nil {
		return AgentPolicyRecord{}, err
	}
	if tools == nil {
		return AgentPolicyRecord{}, errors.New("invalid agent allowlist")
	}
	return AgentPolicyRecord{
		DefaultDirectory:     path,
		AllowedTools:         tools,
		InjectAgentMD:        injectInt != 0,
		MarkdownVisualRender: visualInt != 0,
	}, nil
}

func (s *AgentStore) UpdateAgentSettings(ctx context.Context, patch AgentPolicyPatch) error {
	var raw *string
	if patch.AllowedTools != nil {
		data, err := json.Marshal(*patch.AllowedTools)
		if err != nil {
			return err
		}
		text := string(data)
		raw = &text
	}
	var injectInt, visualInt *int
	if patch.InjectAgentMD != nil {
		v := boolToInt(*patch.InjectAgentMD)
		injectInt = &v
	}
	if patch.MarkdownVisualRender != nil {
		v := boolToInt(*patch.MarkdownVisualRender)
		visualInt = &v
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE agent_settings SET
			default_directory = COALESCE(?, default_directory),
			allowed_tools_json = COALESCE(?, allowed_tools_json),
			inject_agent_md = COALESCE(?, inject_agent_md),
			markdown_visual_render = COALESCE(?, markdown_visual_render)
		WHERE id = 1`,
		patch.DefaultDirectory,
		raw,
		injectInt,
		visualInt,
	)
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
