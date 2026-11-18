package store

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"sync"

	"llmstudio/backend/internal/domain"
)

// StorageMaintenance reports and reclaims SQLite file space for one database.
// Compaction uses a dedicated pooled connection and never touches stored rows.
type StorageMaintenance struct {
	db       *sql.DB
	path     string
	fileMode bool
	mu       sync.Mutex
}

// NewStorageMaintenance binds the maintenance operations to an open database.
func NewStorageMaintenance(db *sql.DB, dbPath string) *StorageMaintenance {
	return &StorageMaintenance{
		db:       db,
		path:     dbPath,
		fileMode: dbPath != "" && dbPath != ":memory:" && !strings.Contains(dbPath, "mode=memory"),
	}
}

// Usage reports the main and WAL file sizes. An in-memory database reports that
// it cannot be compacted instead of pretending to own files.
func (m *StorageMaintenance) Usage(_ context.Context) (domain.StorageUsage, error) {
	if m == nil || !m.fileMode {
		return domain.StorageUsage{}, nil
	}
	mainBytes := fileSize(m.path)
	walBytes := fileSize(m.path + "-wal")
	return domain.StorageUsage{
		MainBytes:   mainBytes,
		WALBytes:    walBytes,
		TotalBytes:  mainBytes + walBytes,
		Compactable: true,
	}, nil
}

// Compact runs checkpoint, VACUUM and checkpoint again on one dedicated
// connection, releasing it before normal reads and writes resume.
func (m *StorageMaintenance) Compact(ctx context.Context) (domain.StorageCompactResult, error) {
	if m == nil || !m.fileMode {
		return domain.StorageCompactResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "database is not file-backed", nil)
	}
	if !m.mu.TryLock() {
		return domain.StorageCompactResult{}, domain.NewError(domain.ErrCodeConflict, "database compaction already running", nil)
	}
	defer m.mu.Unlock()

	before, err := m.Usage(ctx)
	if err != nil {
		return domain.StorageCompactResult{}, err
	}

	conn, err := m.db.Conn(ctx)
	if err != nil {
		return domain.StorageCompactResult{}, domain.NewError(domain.ErrCodeInternalError, "acquire database connection failed", err)
	}
	defer func() { _ = conn.Close() }()

	checkpoint := func() error {
		var busy, logFrames, checkpointed int
		if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logFrames, &checkpointed); err != nil {
			return domain.NewError(domain.ErrCodeInternalError, "wal checkpoint failed", err)
		}
		if busy != 0 {
			return domain.NewError(domain.ErrCodeConflict, "database is busy, retry compaction later", nil)
		}
		return nil
	}
	if err := checkpoint(); err != nil {
		return domain.StorageCompactResult{}, err
	}
	if _, err := conn.ExecContext(ctx, "VACUUM"); err != nil {
		return domain.StorageCompactResult{}, domain.NewError(domain.ErrCodeInternalError, "vacuum failed", err)
	}
	if err := checkpoint(); err != nil {
		return domain.StorageCompactResult{}, err
	}

	after, err := m.Usage(ctx)
	if err != nil {
		return domain.StorageCompactResult{}, err
	}
	freed := before.TotalBytes - after.TotalBytes
	if freed < 0 {
		freed = 0
	}
	return domain.StorageCompactResult{
		BeforeBytes: before.TotalBytes,
		AfterBytes:  after.TotalBytes,
		FreedBytes:  freed,
		Usage:       after,
	}, nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
