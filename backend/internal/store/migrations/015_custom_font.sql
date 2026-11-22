CREATE TABLE IF NOT EXISTS custom_font (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
