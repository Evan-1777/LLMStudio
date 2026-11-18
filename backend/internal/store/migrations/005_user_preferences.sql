ALTER TABLE providers ADD COLUMN api_key_managed INTEGER NOT NULL DEFAULT 0 CHECK (api_key_managed IN (0, 1));
UPDATE providers SET api_key_managed = 1 WHERE TRIM(api_key) <> '';

CREATE TABLE IF NOT EXISTS user_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme_mode TEXT NOT NULL DEFAULT 'system',
    seed_color_value INTEGER NOT NULL DEFAULT 4278221567,
    enter_to_send INTEGER NOT NULL DEFAULT 1,
    visual_html_render INTEGER NOT NULL DEFAULT 1,
    default_html_preview INTEGER NOT NULL DEFAULT 0,
    chat_display_mode TEXT NOT NULL DEFAULT 'bubble',
    auto_collapse_enabled INTEGER NOT NULL DEFAULT 1,
    auto_collapse_thinking_on_complete INTEGER NOT NULL DEFAULT 1,
    auto_collapse_tools_on_complete INTEGER NOT NULL DEFAULT 1,
    auto_create_cache INTEGER NOT NULL DEFAULT 0,
    collapse_line_threshold INTEGER NOT NULL DEFAULT 24,
    collapse_char_threshold INTEGER NOT NULL DEFAULT 1200,
    imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1)),
    updated_at TEXT NOT NULL
);
