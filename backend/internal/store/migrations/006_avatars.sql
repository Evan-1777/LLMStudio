ALTER TABLE assistants ADD COLUMN avatar_data_url TEXT NOT NULL DEFAULT '';
ALTER TABLE user_preferences ADD COLUMN user_avatar_data_url TEXT NOT NULL DEFAULT '';
