package desktop

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
)

// DesktopProviderLookup resolves upstream configuration from the current provider snapshot.
type DesktopProviderLookup struct {
	store     *DesktopStore
	cloud     *CloudClient
	credCache *MemoryCredentialCache
}

func (l *DesktopProviderLookup) Get(ctx context.Context, id string) (domain.ProviderConfig, error) {
	ctx, release := l.cloud.bind(ctx)
	defer release()
	for attempt := 0; attempt < 2; attempt++ {
		providers, revision, err := l.store.providerSnapshot(ctx)
		if err != nil {
			return domain.ProviderConfig{}, err
		}
		if providers == nil && l.cloud != nil && l.cloud.IsConfigured() {
			if _, err := l.cloud.refreshProviderSnapshot(ctx, l.store); err != nil {
				return domain.ProviderConfig{}, err
			}
			providers, revision, err = l.store.providerSnapshot(ctx)
			if err != nil {
				return domain.ProviderConfig{}, err
			}
		}
		index := slices.IndexFunc(providers, func(p CachedProvider) bool { return p.ID == id })
		if index < 0 {
			return domain.ProviderConfig{}, domain.NewError(domain.ErrCodeNotFound, "provider not found", nil)
		}
		meta := providers[index]
		cfg := meta.ToDomainConfig()
		if meta.APIKeySet && l.credCache != nil {
			cred, err := l.credCache.resolveProviderCredential(ctx, l.store, revision, id, meta.UpdatedAt)
			if err != nil {
				return domain.ProviderConfig{}, err
			}
			if !cred.UpdatedAt.Equal(meta.UpdatedAt) {
				if attempt == 0 {
					if _, err := l.cloud.refreshProviderSnapshot(ctx, l.store); err != nil {
						return domain.ProviderConfig{}, err
					}
				}
				continue
			}
			cfg.APIKey = cred.APIKey
		}
		l.store.providerMu.Lock()
		err = l.store.checkProviderRevision(ctx, revision)
		l.store.providerMu.Unlock()
		return cfg, err
	}

	return domain.ProviderConfig{}, domain.NewError(domain.ErrCodeConflict, "provider credential version does not match snapshot", nil)
}

// DesktopSearchLookup resolves search engine config from cloud/local cache and
// injects credentials strictly from MemoryCredentialCache.
type DesktopSearchLookup struct {
	store     *DesktopStore
	cloud     *CloudClient
	credCache *MemoryCredentialCache
}

func (l *DesktopSearchLookup) List(ctx context.Context) ([]domain.SearchEngineConfig, error) {
	views, err := l.loadViews(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.SearchEngineConfig, 0, len(views))
	for _, v := range views {
		out = append(out, l.hydrateView(ctx, v))
	}
	return out, nil
}

func (l *DesktopSearchLookup) Get(ctx context.Context, engineID string) (domain.SearchEngineConfig, error) {
	views, err := l.loadViews(ctx)
	if err != nil {
		return domain.SearchEngineConfig{}, err
	}
	for _, v := range views {
		if v.EngineID == engineID {
			return l.hydrateView(ctx, v), nil
		}
	}
	return domain.SearchEngineConfig{}, domain.NewError(domain.ErrCodeNotFound, "search config not found", nil)
}

func (l *DesktopSearchLookup) loadViews(ctx context.Context) ([]service.SearchEngineView, error) {
	if l.cloud != nil && l.cloud.IsConfigured() {
		if list, err := l.cloud.ListSearchEngines(ctx); err == nil {
			_ = l.store.SaveCachedSearchEngines(ctx, list)
			return list, nil
		}
	}
	return l.store.LoadCachedSearchEngines(ctx)
}

func (l *DesktopSearchLookup) hydrateView(ctx context.Context, v service.SearchEngineView) domain.SearchEngineConfig {
	cfg := domain.SearchEngineConfig{
		EngineID:   v.EngineID,
		Enabled:    v.Enabled,
		Endpoint:   v.Endpoint,
		MaxResults: v.MaxResults,
		IsDefault:  v.IsDefault,
		UpdatedAt:  v.UpdatedAt,
	}
	if v.Enabled && v.APIKeySet && l.credCache != nil {
		if cred, err := l.credCache.ResolveSearchCredential(ctx, v.EngineID, v.UpdatedAt); err == nil {
			cfg.APIKey = cred.APIKey
			if strings.TrimSpace(cred.Endpoint) != "" {
				cfg.Endpoint = cred.Endpoint
			}
			if cred.MaxResults > 0 {
				cfg.MaxResults = cred.MaxResults
			}
		}
	}
	return cfg
}

// DesktopPreferenceLookup reads preferences from cloud when online and falls back to local cache.
type DesktopPreferenceLookup struct {
	store *DesktopStore
	cloud *CloudClient
}

func (l *DesktopPreferenceLookup) Get(ctx context.Context) (domain.Preferences, bool, error) {
	if l.cloud != nil && l.cloud.IsConfigured() {
		if prefs, initialized, err := l.cloud.GetSettings(ctx); err == nil {
			_ = l.store.SaveCachedPreferences(ctx, prefs)
			return prefs, initialized, nil
		}
	}
	if prefs, ok, err := l.store.LoadCachedPreferences(ctx); err == nil && ok {
		return prefs, true, nil
	}
	return l.store.Preferences.Get(ctx)
}

// localConversationRepo wraps local ConversationStore to track pending sync edits.
type localConversationRepo struct {
	store *DesktopStore
}

func (r *localConversationRepo) Get(ctx context.Context, id string) (domain.Conversation, error) {
	return r.store.Conversations.Get(ctx, id)
}

func (r *localConversationRepo) Update(ctx context.Context, c domain.Conversation) (domain.Conversation, error) {
	updated, err := r.store.Conversations.Update(ctx, c)
	if err != nil {
		return domain.Conversation{}, err
	}
	_ = r.store.MarkConversationPending(ctx, updated.ID)
	return r.store.Conversations.Get(ctx, updated.ID)
}

func (r *localConversationRepo) TouchUpdatedAt(ctx context.Context, id string, updatedAt time.Time) error {
	if err := r.store.Conversations.TouchUpdatedAt(ctx, id, updatedAt); err != nil {
		return err
	}
	return r.store.MarkConversationPending(ctx, id)
}

// localMessageRepo wraps local MessageStore to mark synced local topics pending on mutation.
type localMessageRepo struct {
	store *DesktopStore
}

func (r *localMessageRepo) Get(ctx context.Context, id string) (domain.Message, error) {
	return r.store.Messages.Get(ctx, id)
}

func (r *localMessageRepo) ListByConversation(ctx context.Context, conversationID string) ([]domain.Message, error) {
	return r.store.Messages.ListByConversation(ctx, conversationID)
}

func (r *localMessageRepo) Create(ctx context.Context, m domain.Message) (domain.Message, error) {
	saved, err := r.store.Messages.Create(ctx, m)
	if err == nil {
		_ = r.store.MarkConversationPending(ctx, saved.ConversationID)
	}
	return saved, err
}

func (r *localMessageRepo) ReplaceByID(ctx context.Context, conversationID, targetMessageID string, next domain.Message) (domain.Message, error) {
	saved, err := r.store.Messages.ReplaceByID(ctx, conversationID, targetMessageID, next)
	if err == nil {
		_ = r.store.MarkConversationPending(ctx, conversationID)
	}
	return saved, err
}

func (r *localMessageRepo) InsertAfter(ctx context.Context, conversationID, afterMessageID string, next domain.Message) (domain.Message, error) {
	saved, err := r.store.Messages.InsertAfter(ctx, conversationID, afterMessageID, next)
	if err == nil {
		_ = r.store.MarkConversationPending(ctx, conversationID)
	}
	return saved, err
}

// cloudChatRepo adapts CloudClient for ChatService.Prepare/Stream/Compact on cloud topics,
// caching ConversationDetail per conversation so Get/ListByConversation avoid redundant roundtrips
// and persisting user/assistant turns directly to the cloud gateway.
type cloudChatRepo struct {
	cloud *CloudClient

	mu       sync.RWMutex
	msgsByID map[string]domain.Message
	convMsgs map[string][]domain.Message
}

func newCloudChatRepo(cloud *CloudClient) *cloudChatRepo {
	return &cloudChatRepo{
		cloud:    cloud,
		msgsByID: make(map[string]domain.Message),
		convMsgs: make(map[string][]domain.Message),
	}
}

func (r *cloudChatRepo) recordDetail(detail service.ConversationDetail) {
	r.mu.Lock()
	defer r.mu.Unlock()
	copied := make([]domain.Message, len(detail.Messages))
	copy(copied, detail.Messages)
	r.convMsgs[detail.Conversation.ID] = copied
	for _, m := range detail.Messages {
		r.msgsByID[m.ID] = m
	}
}

func (r *cloudChatRepo) invalidateConversation(convID string) {
	r.mu.Lock()
	delete(r.convMsgs, convID)
	r.mu.Unlock()
}

func (r *cloudChatRepo) Get(ctx context.Context, id string) (domain.Conversation, error) {
	detail, err := r.cloud.GetConversationDetail(ctx, id)
	if err != nil {
		return domain.Conversation{}, err
	}
	r.recordDetail(detail)
	return detail.Conversation, nil
}

func (r *cloudChatRepo) Update(ctx context.Context, c domain.Conversation) (domain.Conversation, error) {
	return r.cloud.PatchConversation(ctx, c.ID, map[string]any{
		"assistantId":  c.AssistantID,
		"title":        c.Title,
		"providerId":   c.ProviderID,
		"modelId":      c.ModelID,
		"systemPrompt": c.SystemPrompt,
		"params":       c.Params,
		"syncEnabled":  c.SyncEnabled,
	})
}

func (r *cloudChatRepo) TouchUpdatedAt(_ context.Context, _ string, _ time.Time) error {
	// Cloud CreateMessage already advances updated_at monotonically.
	return nil
}

func (r *cloudChatRepo) GetMessage(ctx context.Context, id string) (domain.Message, error) {
	r.mu.RLock()
	m, ok := r.msgsByID[id]
	r.mu.RUnlock()
	if !ok {
		return domain.Message{}, domain.NewError(domain.ErrCodeNotFound, "message not found", nil)
	}
	return m, nil
}

func (r *cloudChatRepo) ListByConversation(ctx context.Context, conversationID string) ([]domain.Message, error) {
	r.mu.RLock()
	cached, ok := r.convMsgs[conversationID]
	r.mu.RUnlock()
	if ok {
		out := make([]domain.Message, len(cached))
		copy(out, cached)
		return out, nil
	}
	detail, err := r.cloud.GetConversationDetail(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	r.recordDetail(detail)
	return detail.Messages, nil
}

func (r *cloudChatRepo) Create(ctx context.Context, m domain.Message) (domain.Message, error) {
	return r.createMessage(ctx, m.ConversationID, m, "", "")
}

func (r *cloudChatRepo) ReplaceByID(ctx context.Context, conversationID, targetMessageID string, next domain.Message) (domain.Message, error) {
	return r.createMessage(ctx, conversationID, next, targetMessageID, "")
}

func (r *cloudChatRepo) InsertAfter(ctx context.Context, conversationID, afterMessageID string, next domain.Message) (domain.Message, error) {
	return r.createMessage(ctx, conversationID, next, "", afterMessageID)
}

func (r *cloudChatRepo) createMessage(ctx context.Context, convID string, m domain.Message, replaceID, afterID string) (domain.Message, error) {
	res, err := r.cloud.CreateMessage(ctx, convID, service.CreateMessageInput{
		Role:             m.Role,
		Blocks:           m.Blocks,
		ProviderID:       m.ProviderID,
		ModelID:          m.ModelID,
		Usage:            m.Usage,
		StopReason:       m.StopReason,
		ErrorMessage:     m.ErrorMessage,
		ReplaceMessageID: replaceID,
		AfterMessageID:   afterID,
	})
	if err != nil {
		return domain.Message{}, err
	}
	r.invalidateConversation(convID)
	r.mu.Lock()
	r.msgsByID[res.Message.ID] = res.Message
	r.mu.Unlock()
	return res.Message, nil
}

type cloudMessageRepo struct{ *cloudChatRepo }

func (m cloudMessageRepo) Get(ctx context.Context, id string) (domain.Message, error) {
	return m.cloudChatRepo.GetMessage(ctx, id)
}

type desktopAssistantLookup struct {
	store *DesktopStore
	cloud *CloudClient
	live  bool
}

func (l *desktopAssistantLookup) Get(ctx context.Context, id string) (domain.Assistant, error) {
	if l.live && l.cloud != nil && l.cloud.IsConfigured() {
		if list, err := l.cloud.ListAssistants(ctx); err == nil {
			_ = l.store.SyncCloudAssistants(ctx, list)
			for _, a := range list {
				if a.ID == id {
					return a, nil
				}
			}
		}
	}
	return l.store.Assistants.Get(ctx, id)
}

// DesktopChatEngine provides local-first ChatService orchestration for both local and cloud topics.
type DesktopChatEngine struct {
	store          *DesktopStore
	cloud          *CloudClient
	credCache      *MemoryCredentialCache
	formats        *plugin.FormatRegistry
	adapters       *plugin.ProviderRegistry
	searchReg      *plugin.SearchRegistry
	compositeTools *CompositeToolRuntime
	httpClient     *http.Client

	localChat *service.ChatService
}

// NewDesktopChatEngine builds the shared ChatService orchestrator for local and cloud topics.
func NewDesktopChatEngine(
	store *DesktopStore,
	cloud *CloudClient,
	credCache *MemoryCredentialCache,
	formats *plugin.FormatRegistry,
	adapters *plugin.ProviderRegistry,
	searchReg *plugin.SearchRegistry,
	compositeTools *CompositeToolRuntime,
	httpClient *http.Client,
) *DesktopChatEngine {
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	provLookup := &DesktopProviderLookup{store: store, cloud: cloud, credCache: credCache}
	searchLookup := &DesktopSearchLookup{store: store, cloud: cloud, credCache: credCache}
	prefLookup := &DesktopPreferenceLookup{store: store, cloud: cloud}

	localChat := service.NewChatService(
		provLookup,
		&localConversationRepo{store: store},
		&localMessageRepo{store: store},
		formats,
		adapters,
		httpClient,
	).
		WithAssistants(&desktopAssistantLookup{store: store, cloud: cloud, live: false}).
		WithSearch(searchReg, searchLookup).
		WithPreferences(prefLookup).
		WithMCP(compositeTools, compositeTools)

	return &DesktopChatEngine{
		store:          store,
		cloud:          cloud,
		credCache:      credCache,
		formats:        formats,
		adapters:       adapters,
		searchReg:      searchReg,
		compositeTools: compositeTools,
		httpClient:     httpClient,
		localChat:      localChat,
	}
}

func (e *DesktopChatEngine) newCloudChatService() *service.ChatService {
	provLookup := &DesktopProviderLookup{store: e.store, cloud: e.cloud, credCache: e.credCache}
	searchLookup := &DesktopSearchLookup{store: e.store, cloud: e.cloud, credCache: e.credCache}
	prefLookup := &DesktopPreferenceLookup{store: e.store, cloud: e.cloud}
	repo := newCloudChatRepo(e.cloud)

	return service.NewChatService(
		provLookup,
		repo,
		cloudMessageRepo{repo},
		e.formats,
		e.adapters,
		e.httpClient,
	).
		WithAssistants(&desktopAssistantLookup{store: e.store, cloud: e.cloud, live: true}).
		WithSearch(e.searchReg, searchLookup).
		WithPreferences(prefLookup).
		WithMCP(e.compositeTools, e.compositeTools)
}

func (e *DesktopChatEngine) serviceForScope(scope plugin.ExecutionScope) (*service.ChatService, error) {
	switch scope {
	case "", plugin.ExecutionScopeLocal:
		return e.localChat, nil
	case plugin.ExecutionScopeCloud:
		if e.cloud == nil || !e.cloud.IsConfigured() {
			return nil, domain.NewError(domain.ErrCodeUnauthorized, "cloud gateway is not connected", nil)
		}
		return e.newCloudChatService(), nil
	default:
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "unsupported execution scope", nil)
	}
}

// DesktopPreparedStream keeps the connection bound through stream completion.
type DesktopPreparedStream struct {
	stream  *service.PreparedStream
	ctx     context.Context
	release func()
}

func (p *DesktopPreparedStream) Stream(ctx context.Context, emit func(domain.StreamEvent) error) error {
	defer p.release()
	streamCtx, cancel := context.WithCancel(p.ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	return p.stream.Stream(streamCtx, emit)
}

// Prepare opens an upstream stream, refreshing credentials at most once on 401/403.
func (e *DesktopChatEngine) Prepare(ctx context.Context, scope plugin.ExecutionScope, in service.StreamChatInput) (*DesktopPreparedStream, error) {
	ctx, release := e.cloud.bind(ctx)
	svc, err := e.serviceForScope(scope)
	if err != nil {
		release()
		return nil, err
	}
	prepared, err := svc.Prepare(ctx, in)
	if errors.Is(err, service.ErrUpstreamAuth) && e.credCache != nil {
		if err = e.refreshProvider(ctx, scope, in.ConversationID, in.ProviderID); err == nil {
			prepared, err = svc.Prepare(ctx, in)
		}
	}
	if err != nil {
		release()
		return nil, err
	}
	return &DesktopPreparedStream{prepared, ctx, release}, nil
}

// Compact compacts conversation history without switching connections mid-request.
func (e *DesktopChatEngine) Compact(ctx context.Context, scope plugin.ExecutionScope, in service.CompactConversationInput) (service.CompactConversationResult, error) {
	ctx, release := e.cloud.bind(ctx)
	defer release()
	svc, err := e.serviceForScope(scope)
	if err != nil {
		return service.CompactConversationResult{}, err
	}
	res, err := svc.Compact(ctx, in)
	if errors.Is(err, service.ErrUpstreamAuth) && e.credCache != nil {
		if err = e.refreshProvider(ctx, scope, in.ConversationID, in.ProviderID); err == nil {
			return svc.Compact(ctx, in)
		}
	}
	return res, err
}

// ExecuteTools runs conversation-scoped MCP tools via the composite dual-domain runtime.
func (e *DesktopChatEngine) ExecuteTools(ctx context.Context, scope plugin.ExecutionScope, in service.ExecuteToolsInput, emit func(domain.StreamEvent) error) error {
	svc, err := e.serviceForScope(scope)
	if err != nil {
		return err
	}
	return svc.ExecuteTools(ctx, in, emit)
}

func (e *DesktopChatEngine) refreshProvider(ctx context.Context, scope plugin.ExecutionScope, convID, providerID string) error {
	if err := checkCloudConnection(ctx); err != nil {
		return err
	}
	pid := strings.TrimSpace(providerID)
	if pid == "" {
		if scope == plugin.ExecutionScopeCloud && e.cloud != nil {
			if detail, err := e.cloud.GetConversationDetail(ctx, convID); err == nil {
				pid = detail.Conversation.ProviderID
			}
		} else if e.store != nil {
			if conv, err := e.store.Conversations.Get(ctx, convID); err == nil {
				pid = conv.ProviderID
			}
		}
	}
	if pid == "" {
		return domain.NewError(domain.ErrCodeNotFound, "provider not found for credential refresh", nil)
	}
	if err := e.store.invalidateProviderSnapshot(ctx, pid); err != nil {
		return err
	}
	_, err := e.cloud.refreshProviderSnapshot(ctx, e.store)
	return err
}
