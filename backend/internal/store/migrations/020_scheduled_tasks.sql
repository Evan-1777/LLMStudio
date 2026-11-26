CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    weekdays_json TEXT NOT NULL DEFAULT '[]',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    max_runs INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 0,
    bind_mode TEXT NOT NULL DEFAULT 'new' CHECK (bind_mode IN ('new', 'conversation')),
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    assistant_id TEXT NOT NULL DEFAULT 'default',
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    last_conversation_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks(enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_conv
    ON scheduled_tasks(conversation_id);

CREATE TRIGGER IF NOT EXISTS trg_scheduled_tasks_conv_deleted
BEFORE DELETE ON conversations
FOR EACH ROW
BEGIN
    UPDATE scheduled_tasks
    SET conversation_id = NULL,
        enabled = 0,
        next_run_at = NULL,
        last_error = '绑定话题已删除',
        updated_at = strftime('%Y-%m-%dT%H:%M:%f000000Z', 'now')
    WHERE conversation_id = OLD.id;
END;
