ALTER TABLE user_preferences ADD COLUMN default_topic_mode TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE user_preferences ADD COLUMN last_provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_preferences ADD COLUMN last_model_id TEXT NOT NULL DEFAULT '';
