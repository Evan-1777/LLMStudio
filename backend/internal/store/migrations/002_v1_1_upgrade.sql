CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    default_provider_id TEXT NOT NULL DEFAULT '',
    default_model_id TEXT NOT NULL DEFAULT '',
    params_json TEXT NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO assistants (
    id, name, system_prompt, default_provider_id, default_model_id,
    params_json, is_default, created_at, updated_at
) VALUES (
    'default',
    '默认助手',
    '',
    '',
    '',
    '{}',
    1,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
);

ALTER TABLE conversations ADD COLUMN assistant_id TEXT NOT NULL DEFAULT 'default';
UPDATE conversations SET assistant_id = 'default' WHERE assistant_id = '';
CREATE INDEX IF NOT EXISTS idx_conversations_assistant_updated
    ON conversations(assistant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS search_configs (
    engine_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    max_results INTEGER NOT NULL DEFAULT 5,
    is_default INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL,
    endpoint TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL DEFAULT '',
    args_json TEXT NOT NULL DEFAULT '[]',
    env_json TEXT NOT NULL DEFAULT '{}',
    headers_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
