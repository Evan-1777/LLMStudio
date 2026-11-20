package desktop

import (
	"context"
	"sync"
	"time"

	"llmstudio/backend/internal/service"
)

const defaultCredentialTTL = 15 * time.Minute

type cachedProviderEntry struct {
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
	provInflight   map[string]*inflightCall[service.ProviderRuntimeCredential]
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
		provInflight:   make(map[string]*inflightCall[service.ProviderRuntimeCredential]),
		searchInflight: make(map[string]*inflightCall[service.SearchEngineRuntimeCredential]),
	}
}

// ResolveProviderCredential returns an in-memory cached credential when fresh and
// matching expectedUpdatedAt, otherwise fetching once from CloudClient.
func (m *MemoryCredentialCache) ResolveProviderCredential(
	ctx context.Context,
	providerID string,
	expectedUpdatedAt time.Time,
) (service.ProviderRuntimeCredential, error) {
	now := m.nowFn()
	m.mu.RLock()
	if entry, ok := m.providers[providerID]; ok && m.isFresh(entry.fetchedAt, now) {
		if expectedUpdatedAt.IsZero() || entry.cred.UpdatedAt.Equal(expectedUpdatedAt) {
			m.mu.RUnlock()
			return entry.cred, nil
		}
	}
	m.mu.RUnlock()

	m.mu.Lock()
	if entry, ok := m.providers[providerID]; ok && m.isFresh(entry.fetchedAt, now) {
		if expectedUpdatedAt.IsZero() || entry.cred.UpdatedAt.Equal(expectedUpdatedAt) {
			m.mu.Unlock()
			return entry.cred, nil
		}
	}
	if flight, ok := m.provInflight[providerID]; ok {
		m.mu.Unlock()
		select {
		case <-flight.done:
			return flight.val, flight.err
		case <-ctx.Done():
			return service.ProviderRuntimeCredential{}, ctx.Err()
		}
	}
	flight := &inflightCall[service.ProviderRuntimeCredential]{done: make(chan struct{})}
	m.provInflight[providerID] = flight
	m.mu.Unlock()

	cred, err := m.client.GetProviderCredential(ctx, providerID)

	m.mu.Lock()
	delete(m.provInflight, providerID)
	if err == nil {
		m.providers[providerID] = cachedProviderEntry{
			cred:      cred,
			fetchedAt: m.nowFn(),
		}
	}
	flight.val, flight.err = cred, err
	close(flight.done)
	m.mu.Unlock()
	return cred, err
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
	delete(m.searchInflight, engineID)
	if err == nil {
		m.searches[engineID] = cachedSearchEntry{
			cred:      cred,
			fetchedAt: m.nowFn(),
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
	m.mu.Unlock()
}
