package service

import (
	"context"
	"encoding/json"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

// PreparedLocalHTTPRequest describes a pre-encoded HTTP request without server-stored secrets.
type PreparedLocalHTTPRequest struct {
	Method   string            `json:"method"`
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Body     json.RawMessage   `json:"body"`
	AuthType string            `json:"authType"`
}

// PreparedLocalCacheStep describes an optional explicit cache creation step to run before the main request.
type PreparedLocalCacheStep struct {
	Request PreparedLocalHTTPRequest `json:"request"`
	PlanKey string                   `json:"planKey"`
}

// PreparedLocalRequest holds a pre-encoded upstream request for browser-direct execution.
// Server-stored API keys are never included in URL or Headers.
type PreparedLocalRequest struct {
	ParentID             *string                  `json:"parentId,omitempty"`
	ConsumeBranchID      string                   `json:"consumeBranchId,omitempty"`
	Method               string                   `json:"method"`
	URL                  string                   `json:"url"`
	Headers              map[string]string        `json:"headers"`
	Body                 json.RawMessage          `json:"body"`
	AuthType             string                   `json:"authType"`
	WebSearchBlock       *domain.ContentBlock     `json:"webSearchBlock,omitempty"`
	ReplaceMessageID     string                   `json:"replaceMessageId,omitempty"`
	InsertAfterMessageID string                   `json:"insertAfterMessageId,omitempty"`
	CacheStep            *PreparedLocalCacheStep  `json:"cacheStep,omitempty"`
	CacheState           *plugin.PromptCacheState `json:"cacheState,omitempty"`
	// CacheRetry marks a prepared request that resends once without the rejected
	// cache resource.
	CacheRetry bool `json:"cacheRetry,omitempty"`
}

// PrepareLocal validates inputs, runs optional web search, plans stateless explicit cache steps,
// and encodes the upstream request without mutating SQLite or emitting server-stored API keys.
func (s *ChatService) PrepareLocal(ctx context.Context, in StreamChatInput) (PreparedLocalRequest, error) {
	prep, err := s.prepareUpstream(ctx, in, true)
	if err != nil {
		return PreparedLocalRequest{}, err
	}

	authType := strings.TrimSpace(prep.provider.AuthType)
	if authType == "" {
		authType = domain.AuthTypeBearer
	}

	chatInput := prep.chatInput
	cacheStep, outCacheState, cacheRetry, err := s.planLocalPromptCache(ctx, prep, in, &chatInput, authType)
	if err != nil {
		return PreparedLocalRequest{}, err
	}

	encoded, encErr := prep.apiFormat.EncodeRequest(ctx, chatInput)
	if encErr != nil {
		if appErr, ok := domain.AsAppError(encErr); ok {
			return PreparedLocalRequest{}, appErr
		}
		return PreparedLocalRequest{}, domain.NewError(domain.ErrCodeInternalError, "encode upstream request failed", encErr)
	}
	endpoint, epErr := prep.adapter.ResolveEndpoint(
		localEndpointProvider(prep.provider, prep.resolveProv, prep.credentialEnvelope),
		prep.model,
		encoded.DefaultPath,
		encoded.Query,
		prep.compat,
	)
	if epErr != nil {
		return PreparedLocalRequest{}, epErr
	}

	body := json.RawMessage(encoded.Body)
	if len(body) == 0 {
		body = json.RawMessage("{}")
	}

	var write domain.MessageGraphWrite
	if prep.graphWrite != nil {
		write = *prep.graphWrite
	}
	return PreparedLocalRequest{
		ParentID:             write.ParentID,
		ConsumeBranchID:      write.ConsumeBranchID,
		Method:               encoded.Method,
		URL:                  endpoint.URL,
		Headers:              headersToStringMap(mergeRequestHeaders(encoded.Headers, endpoint.Headers)),
		Body:                 body,
		AuthType:             authType,
		WebSearchBlock:       prep.webSearchBlock,
		ReplaceMessageID:     prep.replaceMessageID,
		InsertAfterMessageID: prep.insertAfterMessageID,
		CacheStep:            cacheStep,
		CacheState:           outCacheState,
		CacheRetry:           cacheRetry,
	}, nil
}

func (s *ChatService) planLocalPromptCache(
	ctx context.Context,
	prep preparedUpstream,
	in StreamChatInput,
	chatInput *plugin.ChatInput,
	authType string,
) (*PreparedLocalCacheStep, *plugin.PromptCacheState, bool, error) {
	var (
		cacheStep     *PreparedLocalCacheStep
		outCacheState *plugin.PromptCacheState
		cacheRetry    bool
	)
	planner, hasPlanner := prep.apiFormat.(plugin.PromptCachePlanner)
	if !hasPlanner {
		return nil, nil, false, nil
	}

	// A rejected browser-direct main request is classified by the same rules as
	// the server path, allowing at most one cache-less resend.
	if in.LocalMainFailure != nil {
		used := in.CacheState
		if used == nil {
			used = s.cacheStore.Get(prep.cacheScope)
		}
		if used != nil && strings.TrimSpace(used.ResourceName) != "" {
			action := planner.ClassifyCacheError(in.LocalMainFailure.Status, []byte(in.LocalMainFailure.Body), used)
			switch {
			case action.InvalidateScope:
				s.cacheStore.Delete(prep.cacheScope)
				cacheRetry = true
			case action.MarkUnsupported:
				s.cacheStore.Set(prep.cacheScope, plugin.PromptCacheState{Unsupported: true})
				cacheRetry = true
			case action.RetryWithoutCache:
				cacheRetry = true
			}
		}
	}

	if cacheRetry {
		outCacheState = &plugin.PromptCacheState{Unsupported: true}
		chatInput.PromptCache = outCacheState
		return nil, outCacheState, true, nil
	}

	// The gateway owns the reusable state; the browser only echoes the state of
	// the request it just executed.
	current := in.CacheState
	if current == nil {
		current = s.cacheStore.Get(prep.cacheScope)
	}
	plan, planErr := planner.PlanCache(ctx, *chatInput, current)
	if planErr != nil {
		return nil, nil, false, planErr
	}
	fullPlanKey := ""
	if plan.PlanKey != "" {
		fullPlanKey = buildLocalPlanKey(prep.cacheScope, prep.systemPrompt, prep.tools, plan.PlanKey)
	}

	switch {
	case in.CacheResolution != nil:
		// A resolution only registers when it labels the candidate planned for this
		// scope; stale or foreign resolutions are discarded.
		if plan.CreateRequest != nil && fullPlanKey != "" && in.CacheResolution.PlanKey == fullPlanKey {
			resBody := sanitizeLocalCacheResolutionBody(*in.CacheResolution)
			res, resErr := planner.ResolveCache(ctx, *chatInput, plan, plugin.CacheResolutionInput{
				StatusCode: in.CacheResolution.Status,
				Body:       resBody,
				PlanKey:    plan.PlanKey,
			})
			if resErr != nil {
				s.cacheStore.FinishCreate(prep.cacheScope, plan.PlanKey, nil)
				return nil, nil, false, resErr
			}
			if res.HardError != nil {
				s.cacheStore.FinishCreate(prep.cacheScope, plan.PlanKey, nil)
				return nil, nil, false, res.HardError
			}
			if res.State != nil {
				s.cacheStore.Set(prep.cacheScope, *res.State)
			}
			s.cacheStore.FinishCreate(prep.cacheScope, plan.PlanKey, res.State)
			outCacheState = res.State
			chatInput.PromptCache = res.State
		} else if plan.CreateRequest == nil && plan.ReuseState != nil {
			outCacheState = plan.ReuseState
			chatInput.PromptCache = plan.ReuseState
		}
	case plan.CreateRequest != nil:
		claim := s.cacheStore.ClaimCreate(prep.cacheScope, plan.PlanKey, promptCachePendingTTL)
		if !claim.leader {
			// The same candidate is already handed out elsewhere; this overlapping
			// request proceeds without the cache resource.
			break
		}
		flightPlanKey := plan.PlanKey
		if in.CacheState == nil {
			var shouldCreate bool
			plan, shouldCreate, planErr = s.recheckCachePlanAfterClaim(ctx, *chatInput, planner, prep.cacheScope, plan)
			if planErr != nil {
				return nil, nil, false, planErr
			}
			if !shouldCreate {
				outCacheState = plan.ReuseState
				chatInput.PromptCache = plan.ReuseState
				break
			}
			if plan.PlanKey != "" {
				fullPlanKey = buildLocalPlanKey(prep.cacheScope, prep.systemPrompt, prep.tools, plan.PlanKey)
			} else {
				fullPlanKey = ""
			}
		}
		createEndpoint, epErr := resolveEndpointForCacheCreate(
			prep.adapter,
			localEndpointProvider(prep.provider, prep.resolveProv, prep.credentialEnvelope),
			prep.model,
			*plan.CreateRequest,
			prep.compat,
		)
		if epErr != nil {
			s.cacheStore.FinishCreate(prep.cacheScope, flightPlanKey, nil)
			return nil, nil, false, epErr
		}
		createBody := json.RawMessage(plan.CreateRequest.Body)
		if len(createBody) == 0 {
			createBody = json.RawMessage("{}")
		}
		cacheStep = &PreparedLocalCacheStep{
			PlanKey: fullPlanKey,
			Request: PreparedLocalHTTPRequest{
				Method:   plan.CreateRequest.Method,
				URL:      createEndpoint.URL,
				Headers:  headersToStringMap(mergeRequestHeaders(plan.CreateRequest.Headers, createEndpoint.Headers)),
				Body:     createBody,
				AuthType: authType,
			},
		}
	default:
		outCacheState = plan.ReuseState
		chatInput.PromptCache = plan.ReuseState
	}

	return cacheStep, outCacheState, false, nil
}

// localEndpointProvider selects the provider used to build a browser-direct request
// envelope. Only an explicit credential request resolves against stored secrets;
// otherwise the credential-free copy keeps prior behaviour.
func localEndpointProvider(prov, resolveProv domain.ProviderConfig, includeCredentials bool) domain.ProviderConfig {
	if includeCredentials {
		return prov
	}
	return resolveProv
}
