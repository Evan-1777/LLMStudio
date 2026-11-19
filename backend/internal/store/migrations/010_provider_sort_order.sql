ALTER TABLE providers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
        ORDER BY built_in DESC, created_at ASC, name ASC, id ASC
    ) AS position
    FROM providers
)
UPDATE providers
SET sort_order = (SELECT position FROM ranked WHERE ranked.id = providers.id);
