ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'agent'));

CREATE TABLE agent_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_directory TEXT NOT NULL DEFAULT '',
    allowed_tools_json TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO agent_settings (id) VALUES (1);

CREATE TABLE agent_conversation_directories (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    directory TEXT NOT NULL
);
