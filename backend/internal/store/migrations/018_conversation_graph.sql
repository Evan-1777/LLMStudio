ALTER TABLE messages ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN graph_meta_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN active_leaf_id TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN graph_state_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_messages_conversation_parent ON messages(conversation_id, parent_id);
