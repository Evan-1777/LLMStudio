package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
)

func TestStorageMaintenanceCompactsFileBackedDatabase(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "storage.db")
	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	if _, err := db.ExecContext(ctx, "CREATE TABLE payload (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)"); err != nil {
		t.Fatalf("create table: %v", err)
	}
	blob := strings.Repeat("x", 4096)
	for i := 0; i < 300; i++ {
		if _, err := db.ExecContext(ctx, "INSERT INTO payload(blob) VALUES (?)", blob); err != nil {
			t.Fatalf("insert row %d: %v", i, err)
		}
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM payload WHERE id > 10"); err != nil {
		t.Fatalf("delete rows: %v", err)
	}

	maintenance := NewStorageMaintenance(db, dbPath)
	before, err := maintenance.Usage(ctx)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if !before.Compactable || before.TotalBytes == 0 {
		t.Fatalf("expected a compactable file-backed database, got %+v", before)
	}

	result, err := maintenance.Compact(ctx)
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result.FreedBytes <= 0 || result.AfterBytes >= result.BeforeBytes {
		t.Fatalf("expected reclaimed space, got %+v", result)
	}
	if result.Usage.WALBytes > before.WALBytes {
		t.Fatalf("expected WAL to be truncated, before=%d after=%d", before.WALBytes, result.Usage.WALBytes)
	}

	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM payload").Scan(&count); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if count != 10 {
		t.Fatalf("compaction must preserve rows, got %d", count)
	}

	// Repeating the request succeeds and reports no further gain.
	second, err := maintenance.Compact(ctx)
	if err != nil {
		t.Fatalf("second compact: %v", err)
	}
	if second.FreedBytes < 0 || second.AfterBytes > second.BeforeBytes {
		t.Fatalf("unexpected second compaction result: %+v", second)
	}
}

func TestStorageMaintenanceGuardsMemoryDatabasesAndConcurrency(t *testing.T) {
	ctx := context.Background()
	mem, err := OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open memory sqlite: %v", err)
	}
	defer func() { _ = mem.Close() }()

	memory := NewStorageMaintenance(mem, ":memory:")
	usage, err := memory.Usage(ctx)
	if err != nil {
		t.Fatalf("memory usage: %v", err)
	}
	if usage.Compactable || usage.TotalBytes != 0 {
		t.Fatalf("memory databases must not pretend to be compactable, got %+v", usage)
	}
	if _, err := memory.Compact(ctx); err == nil {
		t.Fatal("expected compaction of a memory database to fail")
	} else if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeInvalidArgument {
		t.Fatalf("expected INVALID_ARGUMENT, got %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "guard.db")
	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()
	maintenance := NewStorageMaintenance(db, dbPath)
	maintenance.mu.Lock()
	_, err = maintenance.Compact(ctx)
	maintenance.mu.Unlock()
	if appErr, ok := domain.AsAppError(err); !ok || appErr.Code != domain.ErrCodeConflict {
		t.Fatalf("concurrent compaction must report CONFLICT, got %v", err)
	}
}
