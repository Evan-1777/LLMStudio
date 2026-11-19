ALTER TABLE conversations ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN chat_width_mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_preferences ADD COLUMN chat_manual_width INTEGER NOT NULL DEFAULT 780;
