CREATE TABLE IF NOT EXISTS conversation_groups (
    id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_groups_assistant_sort
    ON conversation_groups(assistant_id, sort_order ASC, created_at ASC, id ASC);

ALTER TABLE conversations ADD COLUMN group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY assistant_id
               ORDER BY updated_at DESC, rowid DESC
           ) AS rn
    FROM conversations
)
UPDATE conversations
SET sort_order = (SELECT rn FROM ranked WHERE ranked.id = conversations.id);

CREATE INDEX IF NOT EXISTS idx_conversations_org_order
    ON conversations(assistant_id, pinned DESC, group_id, sort_order ASC, id ASC);
