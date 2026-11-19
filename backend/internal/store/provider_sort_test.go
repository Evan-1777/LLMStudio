package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
)

func TestProviderOrderMigrationAndPersistence(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	stamp := formatTime(time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC))
	for _, entry := range entries {
		name := entry.Name()
		if name >= "010" {
			break
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		exec(string(body))
		exec("INSERT INTO schema_migrations VALUES (?, ?)", name, stamp)
	}
	// Same timestamps and names: ID breaks the old ordering tie. Another old preset was deleted.
	for _, p := range []struct {
		id      string
		builtIn int
	}{{"legacy-b", 1}, {"custom", 0}, {"legacy-a", 1}, {"deleted-preset", 1}} {
		exec(`INSERT INTO providers (id,name,adapter,base_url,auth_type,api_key,models_json,built_in,created_at,updated_at)
    VALUES (?, 'Same', 'generic-http', 'https://example.com/v1', 'bearer', 'test-key',
    '[{"id":"model","apiFormat":"openai-completions"}]', ?, ?, ?)`, p.id, p.builtIn, stamp, stamp)
	}
	exec("DELETE FROM providers WHERE id='deleted-preset'")
	original := map[string]domain.ProviderConfig{}
	for _, id := range []string{"legacy-a", "legacy-b", "custom"} {
		p, err := NewProviderStore(db).Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		original[id] = p
	}
	reopen := func() *ProviderStore {
		t.Helper()
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		db, err = OpenSQLite(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		return NewProviderStore(db)
	}
	defer func() { db.Close() }()
	s := reopen()
	check := func(want ...string) []domain.ProviderConfig {
		t.Helper()
		ps, err := s.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(ps))
		for _, p := range ps {
			got = append(got, p.ID)
		}
		if !slices.Equal(got, want) {
			t.Fatalf("order %v, want %v", got, want)
		}
		return ps
	}
	for _, p := range check("legacy-a", "legacy-b", "custom") {
		if got, err := s.Get(ctx, p.ID); err != nil || !reflect.DeepEqual(got, original[p.ID]) {
			t.Fatalf("migration changed config %s: %v", p.ID, err)
		}
	}
	first := "legacy-a"
	if _, err := s.Reorder(ctx, "custom", &first); err != nil {
		t.Fatal(err)
	}
	s = reopen()
	ps := check("custom", "legacy-a", "legacy-b")
	if _, err := s.Create(ctx, domain.ProviderConfig{ID: "new", Name: "New", Adapter: "generic-http", BaseURL: "https://example.com", AuthType: domain.AuthTypeNone}); err != nil {
		t.Fatal(err)
	}
	ps[1].Name = "Renamed"
	if _, err := s.Update(ctx, ps[1]); err != nil {
		t.Fatal(err)
	}
	check("custom", "legacy-a", "legacy-b", "new")
	if err := s.Delete(ctx, "legacy-b"); err != nil {
		t.Fatal(err)
	}
	check("custom", "legacy-a", "new")
}
