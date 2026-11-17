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

const defaultPromptCacheMaxEntries = 64

type cacheStoreEntry struct {
	state    plugin.PromptCacheState
	lastUsed time.Time
}

type promptCacheStore struct {
	mu         sync.Mutex
	maxEntries int
	entries    map[plugin.PromptCacheScope]cacheStoreEntry
}

func newPromptCacheStore(maxEntries int) *promptCacheStore {
	if maxEntries <= 0 {
		maxEntries = defaultPromptCacheMaxEntries
	}
	return &promptCacheStore{
		maxEntries: maxEntries,
		entries:    make(map[plugin.PromptCacheScope]cacheStoreEntry),
	}
}

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
	if !entry.state.ExpireTime.IsZero() && !now.Before(entry.state.ExpireTime) {
		delete(s.entries, scope)
		return nil
	}
	entry.lastUsed = now
	s.entries[scope] = entry
	cp := entry.state
	return &cp
}

func (s *promptCacheStore) Set(scope plugin.PromptCacheScope, state plugin.PromptCacheState) {
	if s == nil {
		return
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	if !state.ExpireTime.IsZero() && !now.Before(state.ExpireTime) {
		delete(s.entries, scope)
		return
	}
	if _, exists := s.entries[scope]; !exists && len(s.entries) >= s.maxEntries {
		// Lazy eviction of expired entries before evicting least-recently-used.
		for k, v := range s.entries {
			if !v.state.ExpireTime.IsZero() && !now.Before(v.state.ExpireTime) {
				delete(s.entries, k)
			}
		}
		if len(s.entries) >= s.maxEntries {
			var oldestKey plugin.PromptCacheScope
			var oldestTime time.Time
			first := true
			for k, v := range s.entries {
				if first || v.lastUsed.Before(oldestTime) {
					oldestKey = k
					oldestTime = v.lastUsed
					first = false
				}
			}
			if !first {
				delete(s.entries, oldestKey)
			}
		}
	}
	s.entries[scope] = cacheStoreEntry{
		state:    state,
		lastUsed: now,
	}
}

func (s *promptCacheStore) Delete(scope plugin.PromptCacheScope) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, scope)
}

func buildPromptCacheScope(
	prov domain.ProviderConfig,
	model domain.ModelConfig,
	formatID string,
	compat domain.CompatConfig,
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
	_, _ = h.Write([]byte{0})
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
	if !ok || !chatInput.AutoCreateCache {
		return nil, plugin.CachePlan{}, nil
	}

	plan, err := planner.PlanCache(ctx, chatInput, current)
	if err != nil {
		return nil, plugin.CachePlan{}, err
	}
	if plan.CreateRequest == nil {
		return plan.ReuseState, plan, nil
	}

	endpoint, err := resolveEndpointForCacheCreate(
		adapter,
		chatInput.Provider,
		chatInput.Model,
		*plan.CreateRequest,
		chatInput.Compat,
	)
	if err != nil {
		return nil, plan, err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		plan.CreateRequest.Method,
		endpoint.URL,
		bytes.NewReader(plan.CreateRequest.Body),
	)
	if err != nil {
		return nil, plan, domain.NewError(domain.ErrCodeInternalError, "construct cache create request failed", err)
	}
	req.Header = mergeRequestHeaders(plan.CreateRequest.Headers, endpoint.Headers)

	resp, doErr := s.httpClient.Do(req)
	if doErr != nil {
		if ctx.Err() != nil {
			return nil, plan, domain.NewError(domain.ErrCodeUpstreamError, "request canceled", ctx.Err())
		}
		return nil, plan, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("cache create request failed: %v", doErr), doErr)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	_ = resp.Body.Close()
	if readErr != nil {
		return nil, plan, domain.NewError(domain.ErrCodeUpstreamError, "failed to read cache create response", readErr)
	}

	res, resErr := planner.ResolveCache(ctx, chatInput, plan, plugin.CacheResolutionInput{
		StatusCode: resp.StatusCode,
		Body:       body,
		PlanKey:    plan.PlanKey,
	})
	if resErr != nil {
		return nil, plan, resErr
	}
	if res.State != nil {
		s.cacheStore.Set(scope, *res.State)
	}
	if res.HardError != nil {
		return nil, plan, res.HardError
	}
	if res.Degrade {
		return res.State, plan, nil
	}
	return res.State, plan, nil
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
