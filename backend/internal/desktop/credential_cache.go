package desktop

import (
	"context"
	"sync"
	"time"

	"llmstudio/backend/internal/service"
)

const defaultCredentialTTL = 15 * time.Minute

type providerCacheKey struct {
	id         string
	version    time.Time
	revision   uint64
	connection *cloudConnection
}

type cachedProviderEntry struct {
	key       providerCacheKey
	cred      service.ProviderRuntimeCredential
	fetchedAt time.Time
}

type cachedSearchEntry struct {
	cred      service.SearchEngineRuntimeCredential
	fetchedAt time.Time
}

type inflightCall[T any] struct {
	done chan struct{}
	val  T
	err  error
}

// MemoryCredentialCache keeps fetched cloud API keys strictly in process memory
// with soft TTL expiration, version invalidation, and singleflight coalescing.
type MemoryCredentialCache struct {
	client *CloudClient
	ttl    time.Duration
	nowFn  func() time.Time

	mu             sync.RWMutex
	providers      map[string]cachedProviderEntry
	searches       map[string]cachedSearchEntry
	provInflight   map[providerCacheKey]*inflightCall[service.ProviderRuntimeCredential]
	searchInflight map[string]*inflightCall[service.SearchEngineRuntimeCredential]
}

// NewMemoryCredentialCache constructs a MemoryCredentialCache backed by client.
func NewMemoryCredentialCache(client *CloudClient) *MemoryCredentialCache {
	return &MemoryCredentialCache{
		client:         client,
		ttl:            defaultCredentialTTL,
		nowFn:          func() time.Time { return time.Now().UTC() },
		providers:      make(map[string]cachedProviderEntry),
		searches:       make(map[string]cachedSearchEntry),
		provInflight:   make(map[providerCacheKey]*inflightCall[service.ProviderRuntimeCredential]),
		searchInflight: make(map[string]*inflightCall[service.SearchEngineRuntimeCredential]),
	}
}

// ResolveProviderCredential resolves the model key for a provider version.
func (m *MemoryCredentialCache) ResolveProviderCredential(ctx context.Context, id string, version time.Time) (service.ProviderRuntimeCredential, error) {
	return m.resolveProviderCredential(ctx, nil, 0, id, version)
}

func (m *MemoryCredentialCache) resolveProviderCredential(ctx context.Context, store *DesktopStore, revision uint64, id string, version time.Time) (service.ProviderRuntimeCredential, error) {
	ctx, release := m.client.bind(ctx)
	defer release()
	conn, _ := ctx.Value(cloudConnectionKey{}).(*cloudConnection)
	key := providerCacheKey{id, version.UTC(), revision, conn}
	if err := checkCloudConnection(ctx); err != nil {
		return service.ProviderRuntimeCredential{}, err
	}
	m.mu.Lock()
	if entry, ok := m.providers[id]; ok && entry.key == key && m.isFresh(entry.fetchedAt, m.nowFn()) {
		m.mu.Unlock()
		return entry.cred, nil
	}
	if flight := m.provInflight[key]; flight != nil {
		m.mu.Unlock()
		select {
		case <-flight.done:
			return flight.val, flight.err
		case <-ctx.Done():
			return service.ProviderRuntimeCredential{}, ctx.Err()
		}
	}
	flight := &inflightCall[service.ProviderRuntimeCredential]{done: make(chan struct{})}
	m.provInflight[key] = flight
	m.mu.Unlock()

	cred, err := fetchProviderCredential(ctx, m.client, store, key)
	m.mu.Lock()
	if m.provInflight[key] == flight {
		delete(m.provInflight, key)
		if err == nil && (version.IsZero() || cred.UpdatedAt.Equal(version)) {
			m.providers[id] = cachedProviderEntry{key, cred, m.nowFn()}
		}
	}
	flight.val, flight.err = cred, err
	close(flight.done)
	m.mu.Unlock()
	return cred, err
}

func fetchProviderCredential(ctx context.Context, cloud *CloudClient, store *DesktopStore, key providerCacheKey) (service.ProviderRuntimeCredential, error) {
	if store != nil {
		store.providerMu.Lock()
		err := store.checkProviderRevision(ctx, key.revision)
		var apiKey string
		if err == nil {
			apiKey = store.loadProviderKey(ctx, key.id, key.version)
		}
		store.providerMu.Unlock()
		if err != nil {
			return service.ProviderRuntimeCredential{}, err
		}
		if apiKey != "" {
			return service.ProviderRuntimeCredential{ProviderID: key.id, APIKey: apiKey, UpdatedAt: key.version}, nil
		}
	}
	cred, err := cloud.GetProviderCredential(ctx, key.id)
	if err != nil || store == nil {
		return cred, err
	}
	store.providerMu.Lock()
	defer store.providerMu.Unlock()
	if err := store.checkProviderRevision(ctx, key.revision); err != nil {
		return service.ProviderRuntimeCredential{}, err
	}
	if cred.UpdatedAt.Equal(key.version) {
		store.saveProviderKey(ctx, key.id, key.version, cred.APIKey)
	}
	return cred, nil
}

// ResolveSearchCredential returns an in-memory cached search credential when fresh and matching expectedUpdatedAt.
func (m *MemoryCredentialCache) ResolveSearchCredential(
	ctx context.Context,
	engineID string,
	expectedUpdatedAt time.Time,
) (service.SearchEngineRuntimeCredential, error) {
	now := m.nowFn()
	m.mu.RLock()
	if entry, ok := m.searches[engineID]; ok && m.isFresh(entry.fetchedAt, now) {
		if expectedUpdatedAt.IsZero() || entry.cred.UpdatedAt.Equal(expectedUpdatedAt) {
			m.mu.RUnlock()
			return entry.cred, nil
		}
	}
	m.mu.RUnlock()

	m.mu.Lock()
	if entry, ok := m.searches[engineID]; ok && m.isFresh(entry.fetchedAt, now) {
		if expectedUpdatedAt.IsZero() || entry.cred.UpdatedAt.Equal(expectedUpdatedAt) {
			m.mu.Unlock()
			return entry.cred, nil
		}
	}
	if flight, ok := m.searchInflight[engineID]; ok {
		m.mu.Unlock()
		select {
		case <-flight.done:
			return flight.val, flight.err
		case <-ctx.Done():
			return service.SearchEngineRuntimeCredential{}, ctx.Err()
		}
	}
	flight := &inflightCall[service.SearchEngineRuntimeCredential]{done: make(chan struct{})}
	m.searchInflight[engineID] = flight
	m.mu.Unlock()

	cred, err := m.client.GetSearchCredential(ctx, engineID)

	m.mu.Lock()
	if m.searchInflight[engineID] == flight {
		delete(m.searchInflight, engineID)
		if err == nil {
			m.searches[engineID] = cachedSearchEntry{cred: cred, fetchedAt: m.nowFn()}
		}
	}
	flight.val, flight.err = cred, err
	close(flight.done)
	m.mu.Unlock()
	return cred, err
}

func (m *MemoryCredentialCache) isFresh(fetchedAt, now time.Time) bool {
	return now.Sub(fetchedAt) < m.ttl
}

// InvalidateProvider removes any cached credential for providerID.
func (m *MemoryCredentialCache) InvalidateProvider(providerID string) {
	m.mu.Lock()
	delete(m.providers, providerID)
	for key := range m.provInflight {
		if key.id == providerID {
			delete(m.provInflight, key)
		}
	}
	m.mu.Unlock()
}

// InvalidateSearch removes any cached credential for engineID.
func (m *MemoryCredentialCache) InvalidateSearch(engineID string) {
	m.mu.Lock()
	delete(m.searches, engineID)
	m.mu.Unlock()
}

// ClearAll wipes all cached credentials from process memory.
func (m *MemoryCredentialCache) ClearAll() {
	m.mu.Lock()
	m.providers = make(map[string]cachedProviderEntry)
	m.searches = make(map[string]cachedSearchEntry)
	clear(m.provInflight)
	clear(m.searchInflight)
	m.mu.Unlock()
}
