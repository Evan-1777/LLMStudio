package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	defaultPromptCacheMaxEntries = 64
	// promptCacheUnsupportedTTL bounds how long a declined capability is remembered.
	promptCacheUnsupportedTTL = 5 * time.Minute
	// promptCacheSmallPrefixTTL bounds the per-candidate too-short suppression.
	promptCacheSmallPrefixTTL = 2 * time.Minute
	// promptCachePendingTTL bounds a browser-executed create that never reports back.
	promptCachePendingTTL = 2 * time.Minute
)

// cacheCreateFlight tracks one in-flight cache creation per scope so concurrent
// requests for the same candidate execute it once and share the result.
type cacheCreateFlight struct {
	planKey   string
	done      chan struct{}
	state     *plugin.PromptCacheState
	expiresAt time.Time
}

// cacheScopeEntry keeps at most one valid resource per scope plus time-bounded
// negative markers. A negative marker never replaces a valid resource.
type cacheScopeEntry struct {
	resource         plugin.PromptCacheState
	unsupportedUntil time.Time
	failedPlanKey    string
	failedUntil      time.Time
	flight           *cacheCreateFlight
	lastUsed         time.Time
}

type promptCacheStore struct {
	mu         sync.Mutex
	maxEntries int
	entries    map[plugin.PromptCacheScope]cacheScopeEntry
}

func newPromptCacheStore(maxEntries int) *promptCacheStore {
	if maxEntries <= 0 {
		maxEntries = defaultPromptCacheMaxEntries
	}
	return &promptCacheStore{
		maxEntries: maxEntries,
		entries:    make(map[plugin.PromptCacheScope]cacheScopeEntry),
	}
}

// Get returns the valid resource for a scope, or the active negative marker when
// no reusable resource exists.
func (s *promptCacheStore) Get(scope plugin.PromptCacheScope) *plugin.PromptCacheState {
	if s == nil {
		return nil
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.entries[scope]
	if !ok {
		return nil
	}
	if entry.resource.ResourceName != "" && (entry.resource.ExpireTime.IsZero() || now.Before(entry.resource.ExpireTime)) {
		entry.lastUsed = now
		s.entries[scope] = entry
		cp := entry.resource
		return &cp
	}
	res := plugin.PromptCacheState{}
	if !entry.unsupportedUntil.IsZero() && now.Before(entry.unsupportedUntil) {
		res.Unsupported = true
	}
	if entry.failedPlanKey != "" && now.Before(entry.failedUntil) {
		res.FailedPrefixHash = entry.failedPlanKey
	}
	if res.ResourceName == "" && !res.Unsupported && res.FailedPrefixHash == "" {
		return nil
	}
	return &res
}

// Set records a resource or a time-bounded negative marker for a scope.
func (s *promptCacheStore) Set(scope plugin.PromptCacheScope, state plugin.PromptCacheState) {
	if s == nil {
		return
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	entry := s.entries[scope]
	switch {
	case strings.TrimSpace(state.ResourceName) != "":
		entry.resource = state
		entry.unsupportedUntil = time.Time{}
		entry.failedPlanKey = ""
		entry.failedUntil = time.Time{}
	case state.Unsupported:
		entry.unsupportedUntil = now.Add(promptCacheUnsupportedTTL)
	case state.FailedPrefixHash != "":
		entry.failedPlanKey = state.FailedPrefixHash
		entry.failedUntil = now.Add(promptCacheSmallPrefixTTL)
	default:
		return
	}
	entry.lastUsed = now
	s.putLocked(scope, entry)
}

// Delete drops a scope, releasing any waiter with an unknown result.
func (s *promptCacheStore) Delete(scope plugin.PromptCacheScope) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[scope]
	if !ok {
		return
	}
	if flight := entry.flight; flight != nil {
		flight.state = nil
		close(flight.done)
	}
	delete(s.entries, scope)
}

// cacheCreateClaim tells a caller how to participate in a candidate's creation.
type cacheCreateClaim struct {
	leader  bool
	blocked bool
	wait    func(context.Context) (*plugin.PromptCacheState, bool)
}

// ClaimCreate registers an in-flight creation for a scope and candidate. The
// leader executes the create; a concurrent caller for the same candidate waits
// for the shared result, while a different candidate is turned away uncached.
// A positive ttl bounds a create that another party (the browser) executes.
func (s *promptCacheStore) ClaimCreate(scope plugin.PromptCacheScope, planKey string, ttl time.Duration) cacheCreateClaim {
	if s == nil {
		return cacheCreateClaim{leader: true}
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	entry := s.entries[scope]
	if flight := entry.flight; flight != nil {
		if !flight.expiresAt.IsZero() && !now.Before(flight.expiresAt) {
			entry.flight = nil
			close(flight.done)
		} else if flight.planKey == planKey {
			return cacheCreateClaim{wait: func(ctx context.Context) (*plugin.PromptCacheState, bool) {
				select {
				case <-flight.done:
					return flight.state, true
				case <-ctx.Done():
					return nil, false
				}
			}}
		} else {
			return cacheCreateClaim{blocked: true}
		}
	}

	flight := &cacheCreateFlight{planKey: planKey, done: make(chan struct{})}
	if ttl > 0 {
		flight.expiresAt = now.Add(ttl)
	}
	entry.flight = flight
	entry.lastUsed = now
	if !s.putLocked(scope, entry) {
		// Capacity is exhausted; skip the creation rather than evicting live state.
		entry.flight = nil
		close(flight.done)
		return cacheCreateClaim{blocked: true}
	}
	return cacheCreateClaim{leader: true}
}

// FinishCreate releases the in-flight marker and publishes the shared result.
func (s *promptCacheStore) FinishCreate(scope plugin.PromptCacheScope, planKey string, state *plugin.PromptCacheState) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[scope]
	if !ok || entry.flight == nil || entry.flight.planKey != planKey {
		return
	}
	entry.flight.state = state
	close(entry.flight.done)
	entry.flight = nil
	entry.lastUsed = time.Now().UTC()
	s.entries[scope] = entry
}

// putLocked stores an entry, evicting expired then least-recently-used state.
// It reports false when no room can be made.
func (s *promptCacheStore) putLocked(scope plugin.PromptCacheScope, entry cacheScopeEntry) bool {
	if _, exists := s.entries[scope]; !exists && len(s.entries) >= s.maxEntries {
		now := time.Now().UTC()
		for key, candidate := range s.entries {
			expired := candidate.resource.ResourceName == "" ||
				(!candidate.resource.ExpireTime.IsZero() && !now.Before(candidate.resource.ExpireTime))
			if expired && candidate.flight == nil {
				delete(s.entries, key)
			}
		}
		for len(s.entries) >= s.maxEntries {
			oldestKey, oldest := plugin.PromptCacheScope{}, time.Time{}
			found := false
			for key, candidate := range s.entries {
				if candidate.flight != nil {
					continue
				}
				if !found || candidate.lastUsed.Before(oldest) {
					oldestKey, oldest, found = key, candidate.lastUsed, true
				}
			}
			if !found {
				return false
			}
			delete(s.entries, oldestKey)
		}
	}
	s.entries[scope] = entry
	return true
}

func buildPromptCacheScope(
	prov domain.ProviderConfig,
	model domain.ModelConfig,
	formatID string,
	compat domain.CompatConfig,
	topicID string,
) plugin.PromptCacheScope {
	endpoint := strings.TrimRight(strings.TrimSpace(prov.BaseURL), "/") + "|" + strings.TrimSpace(compat.PathOverride)

	h := sha256.New()
	_, _ = io.WriteString(h, strings.TrimSpace(prov.AuthType))
	_, _ = h.Write([]byte{0})
	_, _ = io.WriteString(h, strings.TrimSpace(prov.APIKey))
	_, _ = h.Write([]byte{0})
	writeSortedHeaderHash(h, prov.Headers)
	_, _ = h.Write([]byte{0})
	writeSortedHeaderHash(h, compat.ExtraHeaders)

	return plugin.PromptCacheScope{
		ProviderID: prov.ID,
		TopicID:    topicID,
		Endpoint:   endpoint,
		AuthHash:   hex.EncodeToString(h.Sum(nil)),
		FormatID:   formatID,
		ModelID:    model.ID,
	}
}

func writeSortedHeaderHash(h io.Writer, headers map[string]string) {
	if len(headers) == 0 {
		return
	}
	keys := make([]string, 0, len(headers))
	for k := range headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		_, _ = io.WriteString(h, k)
		_, _ = io.WriteString(h, ":")
		_, _ = io.WriteString(h, headers[k])
		_, _ = io.WriteString(h, "\n")
	}
}

func headersToStringMap(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, vals := range h {
		if len(vals) > 0 {
			out[k] = strings.Join(vals, ", ")
		}
	}
	return out
}

func buildLocalPlanKey(
	scope plugin.PromptCacheScope,
	systemPrompt string,
	tools []plugin.ChatTool,
	pluginPlanKey string,
) string {
	h := sha256.New()
	_, _ = io.WriteString(h, scope.ProviderID)
	_, _ = h.Write([]byte{0})
	_, _ = io.WriteString(h, scope.Endpoint)
	_, _ = h.Write([]byte{0})
	_, _ = io.WriteString(h, scope.FormatID)
	_, _ = io.WriteString(h, scope.ModelID)
	_, _ = h.Write([]byte{0})
	_, _ = io.WriteString(h, systemPrompt)
	_, _ = h.Write([]byte{0})
	for _, t := range tools {
		_, _ = io.WriteString(h, t.Alias)
		_, _ = h.Write([]byte{0})
		_, _ = io.WriteString(h, t.Description)
		_, _ = h.Write([]byte{0})
		_, _ = h.Write(t.InputSchema)
		_, _ = h.Write([]byte{0})
	}
	_, _ = io.WriteString(h, pluginPlanKey)
	return hex.EncodeToString(h.Sum(nil))
}

func sanitizeLocalCacheResolutionBody(in LocalCacheResolutionInput) []byte {
	if in.Status >= 200 && in.Status < 300 {
		raw, _ := json.Marshal(struct {
			Name       string `json:"name,omitempty"`
			ExpireTime string `json:"expireTime,omitempty"`
		}{
			Name:       strings.TrimSpace(in.Result.Name),
			ExpireTime: strings.TrimSpace(in.Result.ExpireTime),
		})
		return raw
	}
	raw, _ := json.Marshal(struct {
		Error struct {
			Code    string `json:"code,omitempty"`
			Message string `json:"message,omitempty"`
		} `json:"error"`
	}{
		Error: struct {
			Code    string `json:"code,omitempty"`
			Message string `json:"message,omitempty"`
		}{
			Code:    strings.TrimSpace(in.Result.ErrorCode),
			Message: strings.TrimSpace(in.Result.ErrorMessage),
		},
	})
	return raw
}

func resolveEndpointForCacheCreate(
	adapter plugin.ProviderAdapter,
	prov domain.ProviderConfig,
	model domain.ModelConfig,
	createReq plugin.EncodedRequest,
	compat domain.CompatConfig,
) (plugin.ResolvedEndpoint, error) {
	// Never inherit the generation PathOverride when calling a separate cache resource endpoint.
	cacheCompat := compat
	cacheCompat.PathOverride = ""
	return adapter.ResolveEndpoint(prov, model, createReq.DefaultPath, createReq.Query, cacheCompat)
}

func (s *ChatService) executeCachePlan(
	ctx context.Context,
	chatInput plugin.ChatInput,
	apiFormat plugin.APIFormat,
	adapter plugin.ProviderAdapter,
	scope plugin.PromptCacheScope,
	current *plugin.PromptCacheState,
) (*plugin.PromptCacheState, plugin.CachePlan, error) {
	planner, ok := apiFormat.(plugin.PromptCachePlanner)
	if !ok {
		return nil, plugin.CachePlan{}, nil
	}

	plan, err := planner.PlanCache(ctx, chatInput, current)
	if err != nil {
		return nil, plugin.CachePlan{}, err
	}
	if plan.CreateRequest == nil {
		return plan.ReuseState, plan, nil
	}

	claim := s.cacheStore.ClaimCreate(scope, plan.PlanKey, 0)
	if claim.blocked {
		// Another candidate for this topic is being created; send uncached once.
		return plan.ReuseState, plugin.CachePlan{ReuseState: plan.ReuseState, InlineCache: plan.InlineCache}, nil
	}
	if !claim.leader {
		// A concurrent request already creates this candidate; reuse its result.
		shared, ok := claim.wait(ctx)
		if !ok {
			return nil, plan, domain.NewError(domain.ErrCodeUpstreamError, "waiting for cache creation canceled", ctx.Err())
		}
		return shared, plugin.CachePlan{ReuseState: shared, InlineCache: plan.InlineCache}, nil
	}

	flightPlanKey := plan.PlanKey
	plan, shouldCreate, err := s.recheckCachePlanAfterClaim(ctx, chatInput, planner, scope, plan)
	if err != nil {
		return nil, plugin.CachePlan{}, err
	}
	if !shouldCreate {
		return plan.ReuseState, plan, nil
	}

	state, createErr := s.runCacheCreate(ctx, chatInput, planner, adapter, scope, plan)
	s.cacheStore.FinishCreate(scope, flightPlanKey, state)
	return state, plan, createErr
}

// recheckCachePlanAfterClaim re-evaluates PlanCache against the store while
// holding plan.PlanKey's leadership, releasing the flight early if another
// request populated a reusable or negative cache state before ClaimCreate.
func (s *ChatService) recheckCachePlanAfterClaim(
	ctx context.Context,
	chatInput plugin.ChatInput,
	planner plugin.PromptCachePlanner,
	scope plugin.PromptCacheScope,
	plan plugin.CachePlan,
) (plugin.CachePlan, bool, error) {
	latest := s.cacheStore.Get(scope)
	if latest == nil {
		return plan, true, nil
	}
	latestPlan, err := planner.PlanCache(ctx, chatInput, latest)
	if err != nil {
		s.cacheStore.FinishCreate(scope, plan.PlanKey, nil)
		return plugin.CachePlan{}, false, err
	}
	if latestPlan.CreateRequest == nil {
		s.cacheStore.FinishCreate(scope, plan.PlanKey, latestPlan.ReuseState)
		return latestPlan, false, nil
	}
	return latestPlan, true, nil
}

// runCacheCreate executes one planned cache creation request and records its result.
func (s *ChatService) runCacheCreate(
	ctx context.Context,
	chatInput plugin.ChatInput,
	planner plugin.PromptCachePlanner,
	adapter plugin.ProviderAdapter,
	scope plugin.PromptCacheScope,
	plan plugin.CachePlan,
) (*plugin.PromptCacheState, error) {
	endpoint, err := resolveEndpointForCacheCreate(
		adapter,
		chatInput.Provider,
		chatInput.Model,
		*plan.CreateRequest,
		chatInput.Compat,
	)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		plan.CreateRequest.Method,
		endpoint.URL,
		bytes.NewReader(plan.CreateRequest.Body),
	)
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInternalError, "construct cache create request failed", err)
	}
	req.Header = mergeRequestHeaders(plan.CreateRequest.Headers, endpoint.Headers)

	resp, doErr := s.httpClient.Do(req)
	if doErr != nil {
		if ctx.Err() != nil {
			return nil, domain.NewError(domain.ErrCodeUpstreamError, "request canceled", ctx.Err())
		}
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("cache create request failed: %v", doErr), doErr)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	_ = resp.Body.Close()
	if readErr != nil {
		return nil, domain.NewError(domain.ErrCodeUpstreamError, "failed to read cache create response", readErr)
	}

	res, resErr := planner.ResolveCache(ctx, chatInput, plan, plugin.CacheResolutionInput{
		StatusCode: resp.StatusCode,
		Body:       body,
		PlanKey:    plan.PlanKey,
	})
	if resErr != nil {
		return nil, resErr
	}
	if res.State != nil {
		s.cacheStore.Set(scope, *res.State)
	}
	if res.HardError != nil {
		return nil, res.HardError
	}
	return res.State, nil
}

func (s *ChatService) encodeAndOpenMainRequest(
	ctx context.Context,
	chatInput plugin.ChatInput,
	apiFormat plugin.APIFormat,
	adapter plugin.ProviderAdapter,
	scope plugin.PromptCacheScope,
	usedInlineCache bool,
	allowReplan bool,
) (*http.Response, *plugin.PromptCacheState, error) {
	sendOnce := func(in plugin.ChatInput) (*http.Response, int, []byte, error) {
		encoded, err := apiFormat.EncodeRequest(ctx, in)
		if err != nil {
			if appErr, ok := domain.AsAppError(err); ok {
				return nil, 0, nil, appErr
			}
			return nil, 0, nil, domain.NewError(domain.ErrCodeInternalError, "encode upstream request failed", err)
		}
		endpoint, err := adapter.ResolveEndpoint(in.Provider, in.Model, encoded.DefaultPath, encoded.Query, in.Compat)
		if err != nil {
			return nil, 0, nil, err
		}
		upReq, err := http.NewRequestWithContext(ctx, encoded.Method, endpoint.URL, bytes.NewReader(encoded.Body))
		if err != nil {
			return nil, 0, nil, domain.NewError(domain.ErrCodeInternalError, "construct upstream request failed", err)
		}
		upReq.Header = mergeRequestHeaders(encoded.Headers, endpoint.Headers)
		resp, doErr := s.httpClient.Do(upReq)
		if doErr != nil {
			if ctx.Err() != nil {
				return nil, 0, nil, domain.NewError(domain.ErrCodeUpstreamError, "request canceled", ctx.Err())
			}
			return nil, 0, nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("upstream request failed: %v", doErr), doErr)
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return resp, resp.StatusCode, nil, nil
		}
		bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		return nil, resp.StatusCode, bodySnippet, nil
	}

	resp, statusCode, bodySnippet, err := sendOnce(chatInput)
	if err != nil {
		return nil, chatInput.PromptCache, err
	}
	if resp != nil {
		return resp, chatInput.PromptCache, nil
	}

	if planner, ok := apiFormat.(plugin.PromptCachePlanner); ok && (chatInput.PromptCache != nil || usedInlineCache) {
		action := planner.ClassifyCacheError(statusCode, bodySnippet, chatInput.PromptCache)
		if action.InvalidateScope {
			s.cacheStore.Delete(scope)
		}
		if action.MarkUnsupported {
			s.cacheStore.Set(scope, plugin.PromptCacheState{Unsupported: true})
		}

		if allowReplan && action.ReplanCache {
			nextState, _, planErr := s.executeCachePlan(ctx, chatInput, apiFormat, adapter, scope, nil)
			if planErr != nil {
				return nil, nil, planErr
			}
			retryInput := chatInput
			retryInput.PromptCache = nextState
			rResp, rStatus, rBody, rErr := sendOnce(retryInput)
			if rErr != nil {
				return nil, nextState, rErr
			}
			if rResp != nil {
				return rResp, nextState, nil
			}
			statusCode = rStatus
			bodySnippet = rBody
		} else if action.RetryWithoutCache {
			retryInput := chatInput
			retryInput.PromptCache = &plugin.PromptCacheState{Unsupported: true}
			rResp, rStatus, rBody, rErr := sendOnce(retryInput)
			if rErr != nil {
				return nil, retryInput.PromptCache, rErr
			}
			if rResp != nil {
				return rResp, retryInput.PromptCache, nil
			}
			statusCode = rStatus
			bodySnippet = rBody
		}
	}

	msg := strings.TrimSpace(string(bodySnippet))
	if msg == "" {
		msg = http.StatusText(statusCode)
	}
	return nil, chatInput.PromptCache, domain.NewError(
		domain.ErrCodeUpstreamError,
		fmt.Sprintf("upstream returned HTTP %d: %s", statusCode, msg),
		nil,
	)
}
