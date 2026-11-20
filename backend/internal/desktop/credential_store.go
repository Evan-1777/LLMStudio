package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"llmstudio/backend/internal/domain"
)

// CredentialProtector wraps model API keys before they reach SQLite.
type CredentialProtector interface {
	Protect([]byte) ([]byte, error)
	Unprotect([]byte) ([]byte, error)
}

// SetCredentialProtector configures device-local protection before serving requests.
func (s *DesktopStore) SetCredentialProtector(p CredentialProtector) { s.credentialProtector = p }

// invalidateProviderState is called with providerMu held, after committing invalidation.
func (s *DesktopStore) invalidateProviderState() {
	s.providerRevision++
	if s.onInvalidateMemoryCache != nil {
		s.onInvalidateMemoryCache()
	}
}

func (s *DesktopStore) loadProviderKey(ctx context.Context, id string, version time.Time) string {
	if s.credentialProtector == nil || version.IsZero() {
		return ""
	}
	var encrypted []byte
	err := s.DB.QueryRowContext(ctx, `SELECT ciphertext FROM desktop_provider_credentials
  WHERE provider_id = ? AND provider_version = ?
  AND connection_version = (SELECT updated_at FROM desktop_connection WHERE id = 1)`,
		id, version.UTC().Format(time.RFC3339Nano)).Scan(&encrypted)
	if err != nil {
		return ""
	}
	plain, err := s.credentialProtector.Unprotect(encrypted)
	if err != nil {
		return ""
	}
	defer clear(plain)
	return string(plain)
}

// saveProviderKey is called under providerMu after checking the snapshot revision.
func (s *DesktopStore) saveProviderKey(ctx context.Context, id string, version time.Time, key string) {
	if s.credentialProtector == nil || key == "" || version.IsZero() {
		return
	}
	plain := []byte(key)
	defer clear(plain)
	encrypted, err := s.credentialProtector.Protect(plain)
	if err != nil || len(encrypted) == 0 {
		return
	}
	_, _ = s.DB.ExecContext(ctx, `INSERT INTO desktop_provider_credentials
  (provider_id, connection_version, provider_version, ciphertext)
  SELECT ?, updated_at, ?, ? FROM desktop_connection WHERE id = 1 AND gateway_base_url != ''
  ON CONFLICT(provider_id) DO UPDATE SET connection_version = excluded.connection_version,
  provider_version = excluded.provider_version, ciphertext = excluded.ciphertext`,
		id, version.UTC().Format(time.RFC3339Nano), encrypted)
}

func (s *DesktopStore) providerSnapshotRevision() uint64 {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	return s.providerRevision
}

func (s *DesktopStore) providerSnapshot(ctx context.Context) ([]CachedProvider, uint64, error) {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	if err := checkCloudConnection(ctx); err != nil {
		return nil, 0, err
	}
	var list []CachedProvider
	_, err := s.getCacheJSON(ctx, cacheKeyProviders, &list)
	return list, s.providerRevision, err
}

func (s *DesktopStore) checkProviderRevision(ctx context.Context, revision uint64) error {
	if err := checkCloudConnection(ctx); err != nil {
		return err
	}
	if s.providerRevision != revision {
		return domain.NewError(domain.ErrCodeConflict, "provider snapshot changed", nil)
	}
	return nil
}

// publishProviders rejects a list fetched before a newer publication or invalidation.
func (s *DesktopStore) publishProviders(ctx context.Context, revision uint64, list []CachedProvider) error {
	normalized := make([]CachedProvider, len(list))
	for i, p := range list {
		p.UpdatedAt = p.UpdatedAt.UTC()
		if p.Models == nil {
			p.Models = []domain.ModelConfig{}
		}
		normalized[i] = p
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	if err := checkCloudConnection(ctx); err != nil {
		return err
	}
	var current json.RawMessage
	if _, err := s.getCacheJSON(ctx, cacheKeyProviders, &current); err != nil {
		return err
	}
	if bytes.Equal(current, raw) {
		return nil
	}
	if err := s.checkProviderRevision(ctx, revision); err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM desktop_provider_credentials WHERE NOT EXISTS (
  SELECT 1 FROM json_each(?) AS p WHERE json_extract(p.value, '$.id') = provider_id
  AND json_extract(p.value, '$.apiKeySet') AND json_extract(p.value, '$.updatedAt') = provider_version)`, string(raw)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO desktop_cache (key, value_json, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		cacheKeyProviders, string(raw), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.providerRevision++
	return nil
}

func (s *DesktopStore) invalidateProviderSnapshot(ctx context.Context, id string) error {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	if err := checkCloudConnection(ctx); err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM desktop_cache WHERE key = ?`, cacheKeyProviders); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM desktop_provider_credentials WHERE provider_id = ?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.providerRevision++
	return nil
}

func (c *CloudClient) refreshProviderSnapshot(ctx context.Context, store *DesktopStore) ([]CachedProvider, error) {
	ctx, release := c.bind(ctx)
	defer release()
	revision := store.providerSnapshotRevision()
	list, err := c.ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	if err := store.publishProviders(ctx, revision, list); err != nil {
		return nil, err
	}
	return list, nil
}
