package desktop

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

const (
	cacheKeyProviders     = "providers"
	cacheKeySearchEngines = "search_engines"
	cacheKeyPreferences   = "preferences"
)

// DesktopConnection stores the persisted remote cloud gateway connection info.
type DesktopConnection struct {
	GatewayBaseURL string    `json:"gatewayBaseUrl"`
	AccessToken    string    `json:"accessToken,omitempty"`
	TokenSet       bool      `json:"tokenSet"`
	UpdatedAt      time.Time `json:"updatedAt,omitempty"`
}

// CachedProvider stores redacted provider metadata and models without any plaintext API key.
type CachedProvider struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	Adapter      string               `json:"adapter"`
	BaseURL      string               `json:"baseURL"`
	AuthType     string               `json:"authType"`
	APIKeyMasked string               `json:"apiKeyMasked"`
	APIKeySet    bool                 `json:"apiKeySet"`
	Headers      map[string]string    `json:"headers,omitempty"`
	Models       []domain.ModelConfig `json:"models"`
	Enabled      bool                 `json:"enabled"`
	BuiltIn      bool                 `json:"builtIn"`
	LocalRequest bool                 `json:"localRequest"`
	CreatedAt    time.Time            `json:"createdAt"`
	UpdatedAt    time.Time            `json:"updatedAt"`
}

func (p CachedProvider) ToDomainConfig() domain.ProviderConfig {
	models := p.Models
	if models == nil {
		models = []domain.ModelConfig{}
	}
	return domain.ProviderConfig{
		ID:           p.ID,
		Name:         p.Name,
		Adapter:      p.Adapter,
		BaseURL:      p.BaseURL,
		AuthType:     p.AuthType,
		APIKey:       "",
		Headers:      p.Headers,
		Models:       models,
		Enabled:      p.Enabled,
		BuiltIn:      p.BuiltIn,
		LocalRequest: p.LocalRequest,
		CreatedAt:    p.CreatedAt,
		UpdatedAt:    p.UpdatedAt,
	}
}

// DesktopStorageInfo reports local SQLite usage, runtime mode, and local topic counts.
type DesktopStorageInfo struct {
	MainBytes         int64    `json:"mainBytes"`
	WALBytes          int64    `json:"walBytes"`
	TotalBytes        int64    `json:"totalBytes"`
	Compactable       bool     `json:"compactable"`
	Mode              DataMode `json:"mode"`
	DataDir           string   `json:"dataDir"`
	ConversationCount int      `json:"conversationCount"`
	MessageCount      int      `json:"messageCount"`
}

// DesktopStore wraps local SQLite stores and client-only persistence tables.
type DesktopStore struct {
	DB            *sql.DB
	Providers     *store.ProviderStore
	Assistants    *store.AssistantStore
	Conversations *store.ConversationStore
	Messages      *store.MessageStore
	Searches      *store.SearchConfigStore
	MCPs          *store.MCPServerStore
	Preferences   *store.PreferenceStore
	Storage       *store.StorageMaintenance

	providerMu              sync.Mutex
	providerRevision        uint64
	credentialProtector     CredentialProtector
	onInvalidateMemoryCache func()
}

// OpenDesktopStore opens the desktop SQLite database, runs standard migrations,
// ensures desktop tables exist, and cleans up orphaned ephemeral conversations.
func OpenDesktopStore(ctx context.Context, dbPath string) (*DesktopStore, error) {
	db, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		return nil, err
	}
	if err := ensureDesktopTables(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	convStore := store.NewConversationStore(db)
	if _, err := convStore.CleanupEphemeral(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("cleanup desktop ephemeral conversations: %w", err)
	}
	return &DesktopStore{
		DB:            db,
		Providers:     store.NewProviderStore(db),
		Assistants:    store.NewAssistantStore(db),
		Conversations: convStore,
		Messages:      store.NewMessageStore(db),
		Searches:      store.NewSearchConfigStore(db),
		MCPs:          store.NewMCPServerStore(db),
		Preferences:   store.NewPreferenceStore(db),
		Storage:       store.NewStorageMaintenance(db, dbPath),
	}, nil
}

// SetMemoryCacheInvalidator attaches a callback invoked when clearing cache or disconnecting cloud.
func (s *DesktopStore) SetMemoryCacheInvalidator(fn func()) {
	s.onInvalidateMemoryCache = fn
}

// Close closes the underlying SQLite database connection.
func (s *DesktopStore) Close() error {
	if s == nil || s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

func ensureDesktopTables(ctx context.Context, db *sql.DB) error {
	const ddl = `
		CREATE TABLE IF NOT EXISTS desktop_connection (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			gateway_base_url TEXT NOT NULL DEFAULT '',
			access_token TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS desktop_cache (
			key TEXT PRIMARY KEY,
			value_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		-- Older builds did not retire provider snapshots on connection switches.
		DELETE FROM desktop_cache WHERE key = 'providers' AND NOT EXISTS (
			SELECT 1 FROM sqlite_schema WHERE name = 'desktop_provider_credentials'
		);
		CREATE TABLE IF NOT EXISTS desktop_provider_credentials (
			provider_id TEXT PRIMARY KEY,
			connection_version TEXT NOT NULL,
			provider_version TEXT NOT NULL,
			ciphertext BLOB NOT NULL
		);
		CREATE TABLE IF NOT EXISTS desktop_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			close_to_tray INTEGER NOT NULL DEFAULT 0
		);
	`
	if _, err := db.ExecContext(ctx, ddl); err != nil {
		return fmt.Errorf("init desktop tables: %w", err)
	}
	return nil
}

// GetConnection loads the persisted remote cloud gateway URL and access token.
func (s *DesktopStore) GetConnection(ctx context.Context) (DesktopConnection, error) {
	var (
		conn       DesktopConnection
		updatedRaw string
	)
	err := s.DB.QueryRowContext(ctx, `
		SELECT gateway_base_url, access_token, updated_at
		FROM desktop_connection
		WHERE id = 1
	`).Scan(&conn.GatewayBaseURL, &conn.AccessToken, &updatedRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return DesktopConnection{}, nil
	}
	if err != nil {
		return DesktopConnection{}, fmt.Errorf("get desktop connection: %w", err)
	}
	conn.TokenSet = strings.TrimSpace(conn.AccessToken) != ""
	if updatedRaw != "" {
		if t, pErr := time.Parse(time.RFC3339Nano, updatedRaw); pErr == nil {
			conn.UpdatedAt = t
		}
	}
	return conn, nil
}

// SaveConnection persists normalized credentials and retires the previous provider snapshot atomically.
func (s *DesktopStore) SaveConnection(ctx context.Context, gatewayBaseURL, accessToken string) (DesktopConnection, error) {
	cleanURL := strings.TrimRight(strings.TrimSpace(gatewayBaseURL), "/")
	cleanTok := strings.TrimSpace(accessToken)
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return DesktopConnection{}, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, `
  INSERT INTO desktop_connection (id, gateway_base_url, access_token, updated_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET gateway_base_url = excluded.gateway_base_url,
   access_token = excluded.access_token, updated_at = excluded.updated_at
  WHERE gateway_base_url != excluded.gateway_base_url OR access_token != excluded.access_token
 `, cleanURL, cleanTok, now.Format(time.RFC3339Nano))
	if err != nil {
		return DesktopConnection{}, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return DesktopConnection{}, err
	}
	if changed != 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM desktop_cache WHERE key = ?`, cacheKeyProviders); err != nil {
			return DesktopConnection{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM desktop_provider_credentials`); err != nil {
			return DesktopConnection{}, err
		}
	} else {
		var stamp string
		if err := tx.QueryRowContext(ctx, `SELECT updated_at FROM desktop_connection WHERE id = 1`).Scan(&stamp); err != nil {
			return DesktopConnection{}, err
		}
		now, _ = time.Parse(time.RFC3339Nano, stamp)
	}
	if err := tx.Commit(); err != nil {
		return DesktopConnection{}, err
	}
	if changed != 0 {
		s.invalidateProviderState()
	}
	return DesktopConnection{GatewayBaseURL: cleanURL, AccessToken: cleanTok, TokenSet: cleanTok != "", UpdatedAt: now}, nil
}

// DisconnectCloud clears the stored connection and its provider cache.
func (s *DesktopStore) DisconnectCloud(ctx context.Context) error {
	_, err := s.SaveConnection(ctx, "", "")
	return err
}

// GetCloseToTray reports whether the window close button hides to the tray.
// Desktop settings live in their own single-row table, apart from cloud
// connection and cached cloud metadata.
func (s *DesktopStore) GetCloseToTray(ctx context.Context) (bool, error) {
	var value int
	err := s.DB.QueryRowContext(ctx, `SELECT close_to_tray FROM desktop_settings WHERE id = 1`).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get close to tray: %w", err)
	}
	return value != 0, nil
}

// SetCloseToTray persists whether the window close button hides to the tray.
func (s *DesktopStore) SetCloseToTray(ctx context.Context, value bool) error {
	flag := 0
	if value {
		flag = 1
	}
	if _, err := s.DB.ExecContext(ctx, `
		INSERT INTO desktop_settings (id, close_to_tray)
		VALUES (1, ?)
		ON CONFLICT(id) DO UPDATE SET close_to_tray = excluded.close_to_tray
	`, flag); err != nil {
		return fmt.Errorf("save close to tray: %w", err)
	}
	return nil
}

// SyncCloudAssistants idempotently upserts cloud assistant presets into the local assistants table,
// preserving the built-in default assistant seed so local topics can use cloud assistants offline.
func (s *DesktopStore) SyncCloudAssistants(ctx context.Context, assistants []domain.Assistant) error {
	if len(assistants) == 0 {
		return nil
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin sync cloud assistants tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	for _, a := range assistants {
		id := strings.TrimSpace(a.ID)
		if id == "" {
			continue
		}
		created := a.CreatedAt
		if created.IsZero() {
			created = now
		}
		updated := a.UpdatedAt
		if updated.IsZero() {
			updated = created
		}
		paramsBytes, err := json.Marshal(a.Params)
		if err != nil {
			return fmt.Errorf("encode assistant %s params: %w", id, err)
		}
		isDefault := 0
		if a.IsDefault || id == domain.DefaultAssistantID {
			isDefault = 1
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO assistants (
				id, name, system_prompt, default_provider_id, default_model_id, params_json, avatar_data_url, is_default, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				system_prompt = excluded.system_prompt,
				default_provider_id = excluded.default_provider_id,
				default_model_id = excluded.default_model_id,
				params_json = excluded.params_json,
				avatar_data_url = excluded.avatar_data_url,
				is_default = CASE WHEN assistants.id = 'default' THEN 1 ELSE excluded.is_default END,
				updated_at = excluded.updated_at
		`, id, a.Name, a.SystemPrompt, a.DefaultProviderID, a.DefaultModelID, string(paramsBytes), a.AvatarDataURL,
			isDefault, created.UTC().Format(time.RFC3339Nano), updated.UTC().Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("upsert assistant %s: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit sync cloud assistants tx: %w", err)
	}
	return nil
}

// SaveCachedProviders stores redacted provider metadata (stripping all plaintext API keys).
func (s *DesktopStore) SaveCachedProviders(ctx context.Context, providers []CachedProvider) error {
	return s.publishProviders(ctx, s.providerSnapshotRevision(), providers)
}

// SaveCachedProviderConfigs converts domain ProviderConfig entries into redacted cache records.
func (s *DesktopStore) SaveCachedProviderConfigs(ctx context.Context, providers []domain.ProviderConfig) error {
	out := make([]CachedProvider, 0, len(providers))
	for _, p := range providers {
		models := p.Models
		if models == nil {
			models = []domain.ModelConfig{}
		}
		out = append(out, CachedProvider{
			ID:           p.ID,
			Name:         p.Name,
			Adapter:      p.Adapter,
			BaseURL:      p.BaseURL,
			AuthType:     p.AuthType,
			APIKeyMasked: domain.MaskAPIKey(p.APIKey),
			APIKeySet:    strings.TrimSpace(p.APIKey) != "",
			Headers:      p.Headers,
			Models:       models,
			Enabled:      p.Enabled,
			BuiltIn:      p.BuiltIn,
			LocalRequest: p.LocalRequest,
			CreatedAt:    p.CreatedAt,
			UpdatedAt:    p.UpdatedAt,
		})
	}
	return s.SaveCachedProviders(ctx, out)
}

// LoadCachedProviders loads cached provider view records from desktop_cache.
func (s *DesktopStore) LoadCachedProviders(ctx context.Context) ([]CachedProvider, error) {
	providers, _, err := s.providerSnapshot(ctx)
	if providers == nil {
		providers = []CachedProvider{}
	}
	return providers, err
}

// SaveCachedSearchEngines stores masked search engine metadata in desktop_cache (no plaintext apiKey).
func (s *DesktopStore) SaveCachedSearchEngines(ctx context.Context, engines []service.SearchEngineView) error {
	if engines == nil {
		engines = []service.SearchEngineView{}
	}
	return s.putCacheJSON(ctx, cacheKeySearchEngines, engines)
}

// LoadCachedSearchEngines loads masked search engine views from desktop_cache.
func (s *DesktopStore) LoadCachedSearchEngines(ctx context.Context) ([]service.SearchEngineView, error) {
	var out []service.SearchEngineView
	found, err := s.getCacheJSON(ctx, cacheKeySearchEngines, &out)
	if err != nil || !found {
		return []service.SearchEngineView{}, err
	}
	if out == nil {
		return []service.SearchEngineView{}, nil
	}
	return out, nil
}

// SaveCachedPreferences stores synced cloud user preferences in desktop_cache.
func (s *DesktopStore) SaveCachedPreferences(ctx context.Context, prefs domain.Preferences) error {
	return s.putCacheJSON(ctx, cacheKeyPreferences, prefs.Normalize())
}

// LoadCachedPreferences loads cached user preferences from desktop_cache.
func (s *DesktopStore) LoadCachedPreferences(ctx context.Context) (domain.Preferences, bool, error) {
	var out domain.Preferences
	found, err := s.getCacheJSON(ctx, cacheKeyPreferences, &out)
	if err != nil || !found {
		return domain.DefaultPreferences(), false, err
	}
	return out.Normalize(), true, nil
}

func (s *DesktopStore) putCacheJSON(ctx context.Context, key string, val any) error {
	raw, err := json.Marshal(val)
	if err != nil {
		return fmt.Errorf("encode desktop_cache %s: %w", key, err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.DB.ExecContext(ctx, `
		INSERT INTO desktop_cache (key, value_json, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = excluded.updated_at
	`, key, string(raw), now); err != nil {
		return fmt.Errorf("write desktop_cache %s: %w", key, err)
	}
	return nil
}

func (s *DesktopStore) getCacheJSON(ctx context.Context, key string, dst any) (bool, error) {
	var raw string
	err := s.DB.QueryRowContext(ctx, `SELECT value_json FROM desktop_cache WHERE key = ?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read desktop_cache %s: %w", key, err)
	}
	if err := json.Unmarshal([]byte(raw), dst); err != nil {
		return false, fmt.Errorf("decode desktop_cache %s: %w", key, err)
	}
	return true, nil
}

// MarkConversationPending transitions a synced local conversation to pending after local edits.
func (s *DesktopStore) MarkConversationPending(ctx context.Context, convID string) error {
	if strings.TrimSpace(convID) == "" {
		return nil
	}
	if _, err := s.DB.ExecContext(ctx, `
		UPDATE conversations
		SET sync_state = ?
		WHERE id = ? AND sync_state = ?
	`, domain.SyncStatePending, convID, domain.SyncStateSynced); err != nil {
		return fmt.Errorf("mark conversation pending %s: %w", convID, err)
	}
	return nil
}

// MarkConversationSynced records a successful upload against the local conversation record.
func (s *DesktopStore) MarkConversationSynced(ctx context.Context, convID string, syncVersion int64, syncedAt time.Time) error {
	if syncedAt.IsZero() {
		syncedAt = time.Now().UTC()
	}
	if _, err := s.DB.ExecContext(ctx, `
		UPDATE conversations
		SET sync_state = ?, sync_version = ?, last_synced_at = ?
		WHERE id = ?
	`, domain.SyncStateSynced, syncVersion, syncedAt.UTC().Format(time.RFC3339Nano), convID); err != nil {
		return fmt.Errorf("mark conversation synced %s: %w", convID, err)
	}
	return nil
}

// StorageInfo reports SQLite byte usage, runtime mode, data directory, and local record counts.
func (s *DesktopStore) StorageInfo(ctx context.Context, paths StoragePaths) (DesktopStorageInfo, error) {
	usage, err := s.Storage.Usage(ctx)
	if err != nil {
		return DesktopStorageInfo{}, err
	}
	var convCount, msgCount int
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations WHERE ephemeral = 0`).Scan(&convCount); err != nil {
		return DesktopStorageInfo{}, fmt.Errorf("count local conversations: %w", err)
	}
	if err := s.DB.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM messages m
		JOIN conversations c ON m.conversation_id = c.id
		WHERE c.ephemeral = 0
	`).Scan(&msgCount); err != nil {
		return DesktopStorageInfo{}, fmt.Errorf("count local messages: %w", err)
	}
	return DesktopStorageInfo{
		MainBytes:         usage.MainBytes,
		WALBytes:          usage.WALBytes,
		TotalBytes:        usage.TotalBytes,
		Compactable:       usage.Compactable,
		Mode:              paths.Mode,
		DataDir:           paths.DataDir,
		ConversationCount: convCount,
		MessageCount:      msgCount,
	}, nil
}

// CompactLocalStorage runs SQLite checkpoint + VACUUM on the local database.
func (s *DesktopStore) CompactLocalStorage(ctx context.Context) (domain.StorageCompactResult, error) {
	return s.Storage.Compact(ctx)
}

// CleanupLocalUngrouped removes local ungrouped, unpinned, non-ephemeral topics.
func (s *DesktopStore) CleanupLocalUngrouped(ctx context.Context) ([]domain.DeletedConversation, error) {
	return s.Conversations.CleanupUngrouped(ctx)
}

// ClearLocalCache removes cached cloud metadata and invalidates in-memory credentials,
// preserving local conversations, messages, groups, MCP configs, and connection settings.
func (s *DesktopStore) ClearLocalCache(ctx context.Context) error {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM desktop_cache; DELETE FROM desktop_provider_credentials`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.invalidateProviderState()
	return nil
}
