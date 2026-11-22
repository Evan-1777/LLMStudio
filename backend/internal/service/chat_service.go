package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"time"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
)

// LocalContinuationInput supplies the saved anchor turn and in-progress assistant blocks
// for stateless browser-direct MCP continuation rounds.
type LocalContinuationInput struct {
	UserMessageID string                `json:"userMessageId,omitempty"`
	Blocks        []domain.ContentBlock `json:"blocks"`
}

// PreparedSearchInput distinguishes an omitted search step (nil) from an already-executed
// search step (non-nil, including nil or error block) during stateless local continuations.
type PreparedSearchInput struct {
	Block *domain.ContentBlock `json:"block"`
}

// LocalCacheResultData carries only non-sensitive metadata from a browser-executed cache creation response.
type LocalCacheResultData struct {
	Name         string `json:"name,omitempty"`
	ExpireTime   string `json:"expireTime,omitempty"`
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// LocalMainFailureInput carries a rejected browser-direct main request back to
// the gateway for the same cache failure classification used on the server path.
type LocalMainFailureInput struct {
	Status int    `json:"status"`
	Body   string `json:"body,omitempty"`
}

// LocalCacheResolutionInput supplies the browser-side cache pre-request outcome for stateless verification.
type LocalCacheResolutionInput struct {
	PlanKey string               `json:"planKey"`
	Status  int                  `json:"status"`
	Result  LocalCacheResultData `json:"result"`
}

// StreamChatInput defines the payload accepted by the streaming chat endpoint.
type StreamChatInput struct {
	ConversationID      string                     `json:"-"`
	Blocks              []domain.ContentBlock      `json:"blocks"`
	Text                string                     `json:"text"`
	ProviderID          string                     `json:"providerId"`
	ModelID             string                     `json:"modelId"`
	Params              domain.GenerationParams    `json:"params"`
	RegenerateMessageID string                     `json:"regenerateMessageId"`
	WebSearch           bool                       `json:"webSearch"`
	SearchEngineID      string                     `json:"searchEngineId,omitempty"`
	LocalContinuation   *LocalContinuationInput    `json:"localContinuation,omitempty"`
	PreparedSearch      *PreparedSearchInput       `json:"preparedSearch,omitempty"`
	CacheState          *plugin.PromptCacheState   `json:"cacheState,omitempty"`
	CacheResolution     *LocalCacheResolutionInput `json:"cacheResolution,omitempty"`
	// LocalMainFailure reports a rejected browser-direct main request so the
	// gateway classifies it with the server-side cache rules.
	LocalMainFailure *LocalMainFailureInput `json:"localMainFailure,omitempty"`
	// CredentialEnvelope opts a browser-direct request into receiving the stored
	// provider credential inside the encoded request envelope. Older clients omit
	// it and keep receiving the credential-free shape.
	CredentialEnvelope bool `json:"credentialEnvelope,omitempty"`
}

// ProviderLookup fetches provider configurations needed to encode and route a chat turn.
type ProviderLookup interface {
	Get(ctx context.Context, id string) (domain.ProviderConfig, error)
}

// ConversationRepo reads and updates conversation metadata during a chat turn.
type ConversationRepo interface {
	Get(ctx context.Context, id string) (domain.Conversation, error)
	Update(ctx context.Context, c domain.Conversation) (domain.Conversation, error)
	TouchUpdatedAt(ctx context.Context, id string, updatedAt time.Time) error
}

// MessageRepo reads and persists conversation messages.
type MessageRepo interface {
	Get(ctx context.Context, id string) (domain.Message, error)
	ListByConversation(ctx context.Context, conversationID string) ([]domain.Message, error)
	Create(ctx context.Context, m domain.Message) (domain.Message, error)
	ReplaceByID(ctx context.Context, conversationID, targetMessageID string, next domain.Message) (domain.Message, error)
	InsertAfter(ctx context.Context, conversationID, afterMessageID string, next domain.Message) (domain.Message, error)
}

// AssistantLookup loads assistant presets for system prompts and sampling overrides.
type AssistantLookup interface {
	Get(ctx context.Context, id string) (domain.Assistant, error)
}

// SearchConfigLookup reads configured search engine settings.
type SearchConfigLookup interface {
	Get(ctx context.Context, engineID string) (domain.SearchEngineConfig, error)
	List(ctx context.Context) ([]domain.SearchEngineConfig, error)
}

// PreferenceLookup reads runtime generation preferences.
type PreferenceLookup interface {
	Get(ctx context.Context) (domain.Preferences, bool, error)
}

// MCPCatalog lists and fetches configured MCP servers.
type MCPCatalog interface {
	List(ctx context.Context) ([]domain.MCPServerConfig, error)
	Get(ctx context.Context, id string) (domain.MCPServerConfig, error)
}

func isNilDependency(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Ptr, reflect.Interface, reflect.Slice, reflect.Map, reflect.Func:
		return rv.IsNil()
	default:
		return false
	}
}

// ChatService orchestrates upstream LLM requests, SSE normalization, cancellation, and persistence.
type ChatService struct {
	providers   ProviderLookup
	convs       ConversationRepo
	msgs        MessageRepo
	formats     *plugin.FormatRegistry
	adapters    *plugin.ProviderRegistry
	httpClient  *http.Client
	assistants  AssistantLookup
	searchReg   *plugin.SearchRegistry
	searchStore SearchConfigLookup
	mcpStore    MCPCatalog
	mcpClient   plugin.MCPClientBoundary
	cacheStore  *promptCacheStore
	preferences PreferenceLookup
	agent       *agent.Runtime
}

// ErrAgentExecutor identifies an Agent topic that must run on its owning gateway.
var ErrAgentExecutor = domain.NewError(domain.ErrCodeInvalidArgument, "Agent 话题需要在所属网关运行", nil)

func (s *ChatService) WithAgent(runtime *agent.Runtime) *ChatService {
	s.agent = runtime
	return s
}

// NewChatService constructs a ChatService. If httpClient is nil, a default client with no overall request timeout is used.
func NewChatService(
	providers ProviderLookup,
	convs ConversationRepo,
	msgs MessageRepo,
	formats *plugin.FormatRegistry,
	adapters *plugin.ProviderRegistry,
	httpClient *http.Client,
) *ChatService {
	if isNilDependency(providers) {
		providers = nil
	}
	if isNilDependency(convs) {
		convs = nil
	}
	if isNilDependency(msgs) {
		msgs = nil
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &ChatService{
		providers:  providers,
		convs:      convs,
		msgs:       msgs,
		formats:    formats,
		adapters:   adapters,
		httpClient: httpClient,
		cacheStore: newPromptCacheStore(defaultPromptCacheMaxEntries),
	}
}

// WithAssistants injects an AssistantLookup so chat requests inherit assistant presets.
func (s *ChatService) WithAssistants(assistants AssistantLookup) *ChatService {
	if isNilDependency(assistants) {
		assistants = nil
	}
	s.assistants = assistants
	return s
}

// WithSearch injects the orthogonal SearchRegistry and SearchConfigLookup for web search augmentation.
func (s *ChatService) WithSearch(searchReg *plugin.SearchRegistry, searchStore SearchConfigLookup) *ChatService {
	s.searchReg = searchReg
	if isNilDependency(searchStore) {
		searchStore = nil
	}
	s.searchStore = searchStore
	return s
}

// WithPreferences injects the gateway-managed preferences used to resolve the
// automatic caching policy and tool round limit for each generation.
func (s *ChatService) WithPreferences(preferences PreferenceLookup) *ChatService {
	if isNilDependency(preferences) {
		preferences = nil
	}
	s.preferences = preferences
	return s
}

// resolvePreferencesSnapshot loads runtime preferences once per generation, falling back to defaults.
func (s *ChatService) resolvePreferencesSnapshot(ctx context.Context) domain.Preferences {
	if s.preferences == nil {
		return domain.DefaultPreferences()
	}
	prefs, _, err := s.preferences.Get(ctx)
	if err != nil {
		return domain.DefaultPreferences()
	}
	if prefs.MCPMaxToolRounds <= 0 {
		prefs.MCPMaxToolRounds = domain.DefaultMCPMaxToolRounds
	}
	return prefs
}

// WithMCP injects MCP server metadata and runtime boundary for tool discovery and execution.
func (s *ChatService) WithMCP(mcpStore MCPCatalog, mcpClient plugin.MCPClientBoundary) *ChatService {
	if isNilDependency(mcpStore) {
		mcpStore = nil
	}
	if isNilDependency(mcpClient) {
		mcpClient = nil
	}
	s.mcpStore = mcpStore
	s.mcpClient = mcpClient
	return s
}

// PreparedStream holds a validated, open upstream HTTP response ready to stream SSE events to the client.
type PreparedStream struct {
	maxToolRounds        int
	service              *ChatService
	conversation         domain.Conversation
	provider             domain.ProviderConfig
	model                domain.ModelConfig
	apiFormat            plugin.APIFormat
	adapter              plugin.ProviderAdapter
	resp                 *http.Response
	history              []domain.Message
	systemPrompt         string
	params               domain.GenerationParams
	compat               domain.CompatConfig
	tools                []plugin.ChatTool
	toolBindings         map[string]mcpToolBinding
	webSearchBlock       *domain.ContentBlock
	replaceMessageID     string
	insertAfterMessageID string
	autoCreateCache      bool
	cacheScope           plugin.PromptCacheScope
}

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

type preparedUpstream struct {
	conversation         domain.Conversation
	provider             domain.ProviderConfig
	resolveProv          domain.ProviderConfig
	model                domain.ModelConfig
	apiFormat            plugin.APIFormat
	adapter              plugin.ProviderAdapter
	history              []domain.Message
	systemPrompt         string
	params               domain.GenerationParams
	compat               domain.CompatConfig
	tools                []plugin.ChatTool
	toolBindings         map[string]mcpToolBinding
	webSearchBlock       *domain.ContentBlock
	isRegen              bool
	userBlocks           []domain.ContentBlock
	historyLen           int
	replaceMessageID     string
	insertAfterMessageID string
	autoCreateCache      bool
	mcpMaxToolRounds     int
	credentialEnvelope   bool
	cacheScope           plugin.PromptCacheScope
	chatInput            plugin.ChatInput
}

// Prepare validates inputs, runs optional cache planning, encodes the upstream payload,
// opens the upstream HTTP connection, and persists any new user prompt BEFORE SSE headers are sent.
func (s *ChatService) Prepare(ctx context.Context, in StreamChatInput) (*PreparedStream, error) {
	prep, err := s.prepareUpstream(ctx, in, false)
	if err != nil {
		return nil, err
	}

	chatInput := prep.chatInput
	currentCache := s.cacheStore.Get(prep.cacheScope)
	activeCache, plan, planErr := s.executeCachePlan(
		ctx,
		chatInput,
		prep.apiFormat,
		prep.adapter,
		prep.cacheScope,
		currentCache,
	)
	if planErr != nil {
		return nil, planErr
	}
	chatInput.PromptCache = activeCache
	usedInlineCache := plan.InlineCache

	resp, _, err := s.encodeAndOpenMainRequest(
		ctx,
		chatInput,
		prep.apiFormat,
		prep.adapter,
		prep.cacheScope,
		usedInlineCache,
		true,
	)
	if err != nil {
		return nil, err
	}

	conv := prep.conversation
	if !prep.isRegen {
		if _, err := s.msgs.Create(ctx, domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleUser,
			Blocks:         prep.userBlocks,
			CreatedAt:      time.Now().UTC(),
		}); err != nil {
			_ = resp.Body.Close()
			return nil, err
		}
		// Auto-title freshly created conversations from the first user prompt.
		if (conv.Title == "" || conv.Title == "New Chat") && prep.historyLen == 1 {
			if derived := deriveTitleFromBlocks(prep.userBlocks); derived != "" {
				conv.Title = derived
				if updated, uErr := s.convs.Update(ctx, conv); uErr == nil {
					conv = updated
				}
			}
		}
	}

	return &PreparedStream{
		maxToolRounds:        prep.mcpMaxToolRounds,
		service:              s,
		conversation:         conv,
		provider:             prep.provider,
		model:                prep.model,
		apiFormat:            prep.apiFormat,
		adapter:              prep.adapter,
		resp:                 resp,
		history:              prep.history,
		systemPrompt:         prep.systemPrompt,
		params:               prep.params,
		compat:               prep.compat,
		tools:                prep.tools,
		toolBindings:         prep.toolBindings,
		webSearchBlock:       prep.webSearchBlock,
		replaceMessageID:     prep.replaceMessageID,
		insertAfterMessageID: prep.insertAfterMessageID,
		autoCreateCache:      prep.autoCreateCache,
		cacheScope:           prep.cacheScope,
	}, nil
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
	var (
		cacheStep     *PreparedLocalCacheStep
		outCacheState *plugin.PromptCacheState
		cacheRetry    bool
	)
	planner, hasPlanner := prep.apiFormat.(plugin.PromptCachePlanner)

	// A rejected browser-direct main request is classified by the same rules as
	// the server path, allowing at most one cache-less resend.
	if hasPlanner && in.LocalMainFailure != nil {
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

	if hasPlanner && !cacheRetry {
		// The gateway owns the reusable state; the browser only echoes the state of
		// the request it just executed.
		current := in.CacheState
		if current == nil {
			current = s.cacheStore.Get(prep.cacheScope)
		}
		plan, planErr := planner.PlanCache(ctx, chatInput, current)
		if planErr != nil {
			return PreparedLocalRequest{}, planErr
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
				res, resErr := planner.ResolveCache(ctx, chatInput, plan, plugin.CacheResolutionInput{
					StatusCode: in.CacheResolution.Status,
					Body:       resBody,
					PlanKey:    plan.PlanKey,
				})
				if resErr != nil {
					s.cacheStore.FinishCreate(prep.cacheScope, plan.PlanKey, nil)
					return PreparedLocalRequest{}, resErr
				}
				if res.HardError != nil {
					s.cacheStore.FinishCreate(prep.cacheScope, plan.PlanKey, nil)
					return PreparedLocalRequest{}, res.HardError
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
				plan, shouldCreate, planErr = s.recheckCachePlanAfterClaim(ctx, chatInput, planner, prep.cacheScope, plan)
				if planErr != nil {
					return PreparedLocalRequest{}, planErr
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
				return PreparedLocalRequest{}, epErr
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
	}

	if cacheRetry {
		outCacheState = &plugin.PromptCacheState{Unsupported: true}
		chatInput.PromptCache = outCacheState
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

	return PreparedLocalRequest{
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

type conversationUpstreamContext struct {
	conversation  domain.Conversation
	provider      domain.ProviderConfig
	resolveProv   domain.ProviderConfig
	model         domain.ModelConfig
	apiFormat     plugin.APIFormat
	adapter       plugin.ProviderAdapter
	systemPrompt  string
	params        domain.GenerationParams
	compat        domain.CompatConfig
	generationURL string
}

func (s *ChatService) resolveConversationUpstreamContext(
	ctx context.Context,
	convID string,
	rawProviderID string,
	rawModelID string,
	overrideParams domain.GenerationParams,
	allowMissingLocalKey bool,
) (conversationUpstreamContext, error) {
	conv, err := s.convs.Get(ctx, convID)
	if err != nil {
		return conversationUpstreamContext{}, err
	}

	if conv.Mode == domain.ConversationModeAgent {
		if allowMissingLocalKey {
			return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeInvalidArgument, "Agent 不支持浏览器直连模式", nil)
		}
		if s.agent == nil {
			return conversationUpstreamContext{}, ErrAgentExecutor
		}
		if err := s.agent.RequireAccess(); err != nil {
			return conversationUpstreamContext{}, err
		}
	}

	providerID := strings.TrimSpace(rawProviderID)
	if providerID == "" {
		providerID = conv.ProviderID
	}
	modelID := strings.TrimSpace(rawModelID)
	if modelID == "" {
		modelID = conv.ModelID
	}
	if providerID == "" || modelID == "" {
		return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeInvalidArgument, "providerId and modelId are required", nil)
	}

	prov, err := s.providers.Get(ctx, providerID)
	if err != nil {
		return conversationUpstreamContext{}, err
	}
	if conv.Mode == domain.ConversationModeAgent && s.agent.IsGateway() && prov.LocalRequest {
		return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeInvalidArgument, "该模型依赖浏览器直连，无法在网关运行 Agent", nil)
	}
	if !prov.Enabled {
		return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("provider %q is disabled", prov.Name), nil)
	}
	model, ok := findModel(prov.Models, modelID)
	if !ok {
		return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("model %q not found on provider %q", modelID, prov.Name), nil)
	}

	apiFormat, ok := s.formats.Get(model.APIFormat)
	if !ok {
		return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unregistered apiFormat %q", model.APIFormat), nil)
	}
	adapter, ok := s.adapters.Get(prov.Adapter)
	if !ok {
		return conversationUpstreamContext{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unregistered provider adapter %q", prov.Adapter), nil)
	}

	effectiveSystemPrompt := conv.SystemPrompt
	effectiveParams := conv.Params
	if s.assistants != nil {
		assistantID := conv.AssistantID
		if assistantID == "" {
			assistantID = domain.DefaultAssistantID
		}
		if assistant, aErr := s.assistants.Get(ctx, assistantID); aErr == nil {
			if strings.TrimSpace(effectiveSystemPrompt) == "" && strings.TrimSpace(assistant.SystemPrompt) != "" {
				effectiveSystemPrompt = assistant.SystemPrompt
			}
			effectiveParams = mergeGenerationParams(assistant.Params, conv.Params)
		}
	}
	effectiveParams = mergeGenerationParams(effectiveParams, overrideParams)

	mergedCompat := format.MergeCompat(apiFormat.DefaultCompat(), model.Compat)
	resolveProv := prov
	if allowMissingLocalKey {
		authType := strings.TrimSpace(prov.AuthType)
		if authType == "" {
			authType = domain.AuthTypeBearer
		}
		if !prov.LocalRequest && authType != domain.AuthTypeNone && strings.TrimSpace(prov.APIKey) == "" {
			return conversationUpstreamContext{}, domain.NewError(
				domain.ErrCodeInvalidArgument,
				fmt.Sprintf("provider %q API key is required for authType %q", prov.Name, authType),
				nil,
			)
		}
		// Never emit server-stored API keys in pre-encoded browser-direct responses.
		resolveProv.AuthType = domain.AuthTypeNone
		resolveProv.APIKey = ""
	}

	var generationURL string
	if resolved, rErr := adapter.ResolveEndpoint(resolveProv, model, apiFormat.DefaultPath(), nil, mergedCompat); rErr == nil {
		generationURL = resolved.URL
	}

	return conversationUpstreamContext{
		conversation:  conv,
		provider:      prov,
		resolveProv:   resolveProv,
		model:         model,
		apiFormat:     apiFormat,
		adapter:       adapter,
		systemPrompt:  effectiveSystemPrompt,
		params:        effectiveParams,
		compat:        mergedCompat,
		generationURL: generationURL,
	}, nil
}

func (s *ChatService) prepareUpstream(ctx context.Context, in StreamChatInput, allowMissingLocalKey bool) (preparedUpstream, error) {
	up, err := s.resolveConversationUpstreamContext(ctx, in.ConversationID, in.ProviderID, in.ModelID, in.Params, allowMissingLocalKey)
	if err != nil {
		return preparedUpstream{}, err
	}
	conv := up.conversation
	prov := up.provider
	model := up.model
	var nativeTools []plugin.ChatTool
	if conv.Mode == domain.ConversationModeAgent {
		nativeTools, err = s.agent.Tools(ctx, conv.ID)
		if err != nil {
			return preparedUpstream{}, err
		}
	}

	isRegen := strings.TrimSpace(in.RegenerateMessageID) != ""
	isLocalCont := in.LocalContinuation != nil
	if !allowMissingLocalKey && (in.PreparedSearch != nil || in.CacheState != nil || in.CacheResolution != nil) {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "preparedSearch/cacheState/cacheResolution are only supported by prepare-local", nil)
	}
	if isLocalCont {
		if !allowMissingLocalKey {
			return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "localContinuation is only supported by prepare-local", nil)
		}
		if len(in.LocalContinuation.Blocks) == 0 {
			return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "localContinuation.blocks are required", nil)
		}
	}

	var userBlocks []domain.ContentBlock
	if isLocalCont {
		if isRegen {
			if _, err := s.msgs.Get(ctx, in.RegenerateMessageID); err != nil {
				return preparedUpstream{}, err
			}
		} else {
			anchorID := strings.TrimSpace(in.LocalContinuation.UserMessageID)
			if anchorID == "" {
				return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "localContinuation.userMessageId or regenerateMessageId is required", nil)
			}
			anchorMsg, err := s.msgs.Get(ctx, anchorID)
			if err != nil {
				return preparedUpstream{}, err
			}
			if anchorMsg.ConversationID != conv.ID || anchorMsg.Role != domain.RoleUser {
				return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "localContinuation.userMessageId does not belong to a user message in this conversation", nil)
			}
		}
	} else if !isRegen {
		userBlocks = in.Blocks
		if len(userBlocks) == 0 && strings.TrimSpace(in.Text) != "" {
			userBlocks = []domain.ContentBlock{{
				Type: domain.BlockTypeText,
				Text: in.Text,
			}}
		}
		if len(userBlocks) == 0 {
			return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "message blocks or text are required", nil)
		}
	} else {
		if _, err := s.msgs.Get(ctx, in.RegenerateMessageID); err != nil {
			return preparedUpstream{}, err
		}
	}

	history, err := s.msgs.ListByConversation(ctx, conv.ID)
	if err != nil {
		return preparedUpstream{}, err
	}

	var replaceMessageID, insertAfterMessageID string
	if isRegen {
		targetIdx := -1
		for i, m := range history {
			if m.ID == in.RegenerateMessageID {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			return preparedUpstream{}, domain.NewError(domain.ErrCodeNotFound, "target message not found in conversation", nil)
		}
		if history[targetIdx].Role == domain.RoleUser {
			if targetIdx+1 < len(history) {
				if history[targetIdx+1].Role == domain.RoleAssistant {
					replaceMessageID = history[targetIdx+1].ID
				} else {
					insertAfterMessageID = history[targetIdx].ID
				}
			}
			history = history[:targetIdx+1]
		} else {
			replaceMessageID = history[targetIdx].ID
			history = history[:targetIdx]
		}
		if isLocalCont {
			history = append(history, domain.Message{
				ConversationID: conv.ID,
				Role:           domain.RoleAssistant,
				Blocks:         filterBlocksForModelHistory(in.LocalContinuation.Blocks),
				ProviderID:     prov.ID,
				ModelID:        model.ID,
			})
		}
	} else if isLocalCont {
		anchorID := strings.TrimSpace(in.LocalContinuation.UserMessageID)
		anchorIdx := -1
		for i, m := range history {
			if m.ID == anchorID {
				anchorIdx = i
				break
			}
		}
		if anchorIdx < 0 || history[anchorIdx].Role != domain.RoleUser {
			return preparedUpstream{}, domain.NewError(domain.ErrCodeNotFound, "anchor user message not found in conversation", nil)
		}
		history = append(history[:anchorIdx+1], domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleAssistant,
			Blocks:         filterBlocksForModelHistory(in.LocalContinuation.Blocks),
			ProviderID:     prov.ID,
			ModelID:        model.ID,
		})
	} else {
		history = append(history, domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleUser,
			Blocks:         userBlocks,
			CreatedAt:      time.Now().UTC(),
		})
	}

	rawHistoryLen := len(history)
	history = projectModelHistory(history)

	// Search results belong to the current user turn, not to the reusable system
	// prompt: appending them after the user input keeps every earlier prefix stable.
	var webSearchBlock *domain.ContentBlock
	var searchPrompt string
	if in.WebSearch {
		if in.PreparedSearch != nil {
			if in.PreparedSearch.Block != nil {
				searchPrompt = rebuildSearchPromptFromBlock(*in.PreparedSearch.Block)
			}
		} else if isLocalCont {
			searchPrompt = rebuildSearchPromptFromBlocks(in.LocalContinuation.Blocks)
		} else {
			block, prompt := s.runWebSearch(ctx, in.SearchEngineID, latestUserQuery(history))
			webSearchBlock = block
			searchPrompt = prompt
		}
	}
	if searchPrompt != "" {
		history = appendSearchContext(history, searchPrompt)
	}

	prefs := s.resolvePreferencesSnapshot(ctx)

	tools, toolBindings, err := s.discoverActiveTools(ctx, prefs.BuiltinTimeToolEnabled, conv.ID, nativeTools)
	if err != nil {
		return preparedUpstream{}, err
	}

	autoCreateCache := prefs.AutoCreateCache
	chatInput := plugin.ChatInput{
		ConversationID:  conv.ID,
		Provider:        prov,
		Model:           model,
		SystemPrompt:    up.systemPrompt,
		Messages:        history,
		Params:          up.params,
		Compat:          up.compat,
		Tools:           tools,
		AutoCreateCache: autoCreateCache,
		GenerationURL:   up.generationURL,
	}
	cacheScope := buildPromptCacheScope(prov, model, up.apiFormat.ID(), up.compat, conv.ID)

	return preparedUpstream{
		conversation:         conv,
		provider:             prov,
		resolveProv:          up.resolveProv,
		model:                model,
		apiFormat:            up.apiFormat,
		adapter:              up.adapter,
		history:              history,
		systemPrompt:         up.systemPrompt,
		params:               up.params,
		compat:               up.compat,
		tools:                tools,
		toolBindings:         toolBindings,
		webSearchBlock:       webSearchBlock,
		isRegen:              isRegen,
		userBlocks:           userBlocks,
		historyLen:           rawHistoryLen,
		replaceMessageID:     replaceMessageID,
		insertAfterMessageID: insertAfterMessageID,
		autoCreateCache:      autoCreateCache,
		mcpMaxToolRounds:     prefs.MCPMaxToolRounds,
		credentialEnvelope:   in.CredentialEnvelope,
		cacheScope:           cacheScope,
		chatInput:            chatInput,
	}, nil
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

// appendSearchContext projects search results onto the tail of the current turn.
// They join the existing user message instead of creating a second consecutive
// user turn, which some protocols reject or merge.
func appendSearchContext(history []domain.Message, searchPrompt string) []domain.Message {
	if len(history) > 0 && history[len(history)-1].Role == domain.RoleUser {
		out := make([]domain.Message, len(history))
		copy(out, history)
		last := out[len(out)-1]
		last.Blocks = append(append([]domain.ContentBlock(nil), last.Blocks...), domain.ContentBlock{
			Type: domain.BlockTypeText,
			Text: searchPrompt,
		})
		out[len(out)-1] = last
		return out
	}
	return append(history, domain.Message{
		ConversationID: historyConversationID(history),
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: searchPrompt}},
		CreatedAt:      time.Now().UTC(),
	})
}

func historyConversationID(history []domain.Message) string {
	if len(history) == 0 {
		return ""
	}
	return history[0].ConversationID
}

func mergeRequestHeaders(encodedHeaders, endpointHeaders http.Header) http.Header {
	merged := make(http.Header)
	for k, vals := range encodedHeaders {
		for _, v := range vals {
			merged.Add(k, v)
		}
	}
	for k, vals := range endpointHeaders {
		merged.Del(k)
		for _, v := range vals {
			merged.Add(k, v)
		}
	}
	return merged
}

// Stream consumes upstream response bodies across tool-use rounds, translates events via emit,
// handles cancellation, and persists the single resulting assistant message.
func (p *PreparedStream) Stream(ctx context.Context, emit func(domain.StreamEvent) error) error {
	assistantID := domain.NewUUID()
	acc := newStreamAccumulator()

	startEvent := domain.StreamEvent{
		Type:           domain.StreamEventMessageStart,
		ConversationID: p.conversation.ID,
		MessageID:      assistantID,
		ProviderID:     p.provider.ID,
		ModelID:        p.model.ID,
	}
	if err := emit(startEvent); err != nil {
		_ = p.resp.Body.Close()
		_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
		return err
	}

	indexOffset := 0
	if p.webSearchBlock != nil {
		idxZero := domain.IntPtr(0)
		wsStart := domain.StreamEvent{
			Type:           domain.StreamEventBlockStart,
			ConversationID: p.conversation.ID,
			MessageID:      assistantID,
			ProviderID:     p.provider.ID,
			ModelID:        p.model.ID,
			Index:          idxZero,
			BlockType:      domain.BlockTypeWebSearch,
			Block:          p.webSearchBlock,
		}
		acc.apply(wsStart)
		if err := emit(wsStart); err != nil {
			_ = p.resp.Body.Close()
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
			return err
		}

		wsEnd := domain.StreamEvent{
			Type:           domain.StreamEventBlockEnd,
			ConversationID: p.conversation.ID,
			MessageID:      assistantID,
			ProviderID:     p.provider.ID,
			ModelID:        p.model.ID,
			Index:          idxZero,
			BlockType:      domain.BlockTypeWebSearch,
			Block:          p.webSearchBlock,
		}
		acc.apply(wsEnd)
		if err := emit(wsEnd); err != nil {
			_ = p.resp.Body.Close()
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
			return err
		}
		indexOffset = 1
	}

	seenCallIDs := make(map[string]struct{})
	var cumulativeUsage *domain.Usage
	finalStopReason := domain.StopReasonStop
	resp := p.resp
	maxRounds := p.maxToolRounds
	if maxRounds <= 0 {
		maxRounds = domain.DefaultMCPMaxToolRounds
	}

	for round := 0; ; round++ {
		var (
			streamErrMsg string
			roundUsage   *domain.Usage
			roundStop    string
			roundCalls   []domain.ContentBlock
			roundCallIDs = make(map[int]string)
			maxSeenIdx   = indexOffset - 1
		)

		decodeErr := p.apiFormat.DecodeStream(ctx, resp.Body, func(ev domain.StreamEvent) error {
			ev.ConversationID = p.conversation.ID
			ev.MessageID = assistantID
			ev.ProviderID = p.provider.ID
			ev.ModelID = p.model.ID
			if ev.Index != nil {
				shifted := *ev.Index + indexOffset
				ev.Index = &shifted
				if shifted > maxSeenIdx {
					maxSeenIdx = shifted
				}
			}

			if ev.Block != nil && ev.Block.Type == domain.BlockTypeToolCall && ev.Index != nil {
				bCopy := *ev.Block
				bCopy.ToolSource = p.toolBindings[bCopy.Name].source()
				idx := *ev.Index
				switch ev.Type {
				case domain.StreamEventBlockStart:
					id := strings.TrimSpace(bCopy.ID)
					if id == "" {
						id = fmt.Sprintf("call_r%d_%d", round+1, idx)
					}
					if _, exists := seenCallIDs[id]; exists {
						base := fmt.Sprintf("call_r%d_%d", round+1, idx)
						id = base
						for suffix := 2; ; suffix++ {
							if _, clash := seenCallIDs[id]; !clash {
								break
							}
							id = fmt.Sprintf("%s_%d", base, suffix)
						}
					}
					seenCallIDs[id] = struct{}{}
					roundCallIDs[idx] = id
					bCopy.ID = id
					ev.Block = &bCopy
				case domain.StreamEventBlockEnd:
					id, ok := roundCallIDs[idx]
					if !ok {
						id = strings.TrimSpace(bCopy.ID)
						if id == "" {
							id = fmt.Sprintf("call_r%d_%d", round+1, idx)
						}
						if _, exists := seenCallIDs[id]; exists {
							base := fmt.Sprintf("call_r%d_%d", round+1, idx)
							id = base
							for suffix := 2; ; suffix++ {
								if _, clash := seenCallIDs[id]; !clash {
									break
								}
								id = fmt.Sprintf("%s_%d", base, suffix)
							}
						}
						seenCallIDs[id] = struct{}{}
						roundCallIDs[idx] = id
					}
					bCopy.ID = id
					ev.Block = &bCopy
					roundCalls = append(roundCalls, bCopy)
				}
			}

			if ev.Type == domain.StreamEventMessageDelta {
				if ev.Usage != nil {
					u := *ev.Usage
					roundUsage = &u
					ev.Usage = addUsage(addUsage(nil, cumulativeUsage), roundUsage)
				}
				if ev.StopReason != "" {
					roundStop = ev.StopReason
				}
			}

			acc.apply(ev)
			if ev.Type == domain.StreamEventError && ev.Error != nil {
				streamErrMsg = ev.Error.Message
			}
			return emit(ev)
		})
		_ = resp.Body.Close()

		if ctx.Err() != nil || errors.Is(decodeErr, context.Canceled) {
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
			return nil
		}

		if decodeErr != nil || streamErrMsg != "" {
			errMsg := streamErrMsg
			if errMsg == "" && decodeErr != nil {
				errMsg = decodeErr.Error()
			}
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonError, errMsg)
			if streamErrMsg == "" {
				_ = emit(domain.StreamEvent{
					Type:           domain.StreamEventError,
					ConversationID: p.conversation.ID,
					MessageID:      assistantID,
					ProviderID:     p.provider.ID,
					ModelID:        p.model.ID,
					Error: &domain.StreamError{
						Code:    domain.ErrCodeUpstreamError,
						Message: errMsg,
					},
				})
			}
			return nil
		}

		cumulativeUsage = addUsage(cumulativeUsage, roundUsage)
		acc.usage = cumulativeUsage
		indexOffset = maxSeenIdx + 1

		effectiveStop := roundStop
		if effectiveStop == "" {
			if len(roundCalls) > 0 {
				effectiveStop = domain.StopReasonToolUse
			} else {
				effectiveStop = domain.StopReasonStop
			}
		}

		if effectiveStop != domain.StopReasonToolUse || len(roundCalls) == 0 {
			finalStopReason = effectiveStop
			break
		}
		if len(p.tools) == 0 && p.service.mcpClient == nil {
			finalStopReason = effectiveStop
			break
		}

		if round >= maxRounds {
			limitMsg := fmt.Sprintf("达到最大工具调用轮数上限（%d 轮）", maxRounds)
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonError, limitMsg)
			_ = emit(domain.StreamEvent{
				Type:           domain.StreamEventError,
				ConversationID: p.conversation.ID,
				MessageID:      assistantID,
				ProviderID:     p.provider.ID,
				ModelID:        p.model.ID,
				Error: &domain.StreamError{
					Code:    "MCP_ROUND_LIMIT",
					Message: limitMsg,
				},
			})
			return nil
		}

		for _, tc := range roundCalls {
			if ctx.Err() != nil {
				_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
				return nil
			}
			trBlock, execErr := p.service.executeToolCall(ctx, p.toolBindings, tc)
			if execErr != nil || ctx.Err() != nil {
				_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
				return nil
			}
			resIdx := indexOffset
			indexOffset++
			trCopy := trBlock
			evStart := domain.StreamEvent{
				Type:           domain.StreamEventBlockStart,
				ConversationID: p.conversation.ID,
				MessageID:      assistantID,
				ProviderID:     p.provider.ID,
				ModelID:        p.model.ID,
				Index:          domain.IntPtr(resIdx),
				BlockType:      domain.BlockTypeToolResult,
				Block:          &trCopy,
			}
			acc.apply(evStart)
			if err := emit(evStart); err != nil {
				_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
				return err
			}
			evEnd := domain.StreamEvent{
				Type:           domain.StreamEventBlockEnd,
				ConversationID: p.conversation.ID,
				MessageID:      assistantID,
				ProviderID:     p.provider.ID,
				ModelID:        p.model.ID,
				Index:          domain.IntPtr(resIdx),
				BlockType:      domain.BlockTypeToolResult,
				Block:          &trCopy,
			}
			acc.apply(evEnd)
			if err := emit(evEnd); err != nil {
				_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
				return err
			}
		}

		if ctx.Err() != nil {
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
			return nil
		}

		nextHistory := make([]domain.Message, len(p.history)+1)
		copy(nextHistory, p.history)
		nextHistory[len(p.history)] = domain.Message{
			ConversationID: p.conversation.ID,
			Role:           domain.RoleAssistant,
			Blocks:         filterBlocksForModelHistory(acc.blocksSlice()),
			ProviderID:     p.provider.ID,
			ModelID:        p.model.ID,
		}
		activeTools := p.service.filterEnabledToolsWithBindings(ctx, p.tools, p.toolBindings)
		nextInput := plugin.ChatInput{
			ConversationID:  p.conversation.ID,
			Provider:        p.provider,
			Model:           p.model,
			SystemPrompt:    p.systemPrompt,
			Messages:        nextHistory,
			Params:          p.params,
			Compat:          p.compat,
			Tools:           activeTools,
			AutoCreateCache: p.autoCreateCache,
		}
		var usedInlineCache bool
		if p.autoCreateCache {
			curCache := p.service.cacheStore.Get(p.cacheScope)
			activeCache, nextPlan, planErr := p.service.executeCachePlan(
				ctx,
				nextInput,
				p.apiFormat,
				p.adapter,
				p.cacheScope,
				curCache,
			)
			if planErr != nil {
				if ctx.Err() != nil {
					_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
					return nil
				}
				errMsg := planErr.Error()
				_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonError, errMsg)
				_ = emit(domain.StreamEvent{
					Type:           domain.StreamEventError,
					ConversationID: p.conversation.ID,
					MessageID:      assistantID,
					ProviderID:     p.provider.ID,
					ModelID:        p.model.ID,
					Error:          &domain.StreamError{Code: domain.ErrCodeUpstreamError, Message: errMsg},
				})
				return nil
			}
			nextInput.PromptCache = activeCache
			usedInlineCache = nextPlan.InlineCache
		}
		nextResp, _, openErr := p.service.encodeAndOpenMainRequest(
			ctx,
			nextInput,
			p.apiFormat,
			p.adapter,
			p.cacheScope,
			usedInlineCache,
			true,
		)
		if openErr != nil {
			if ctx.Err() != nil {
				_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
				return nil
			}
			errMsg := openErr.Error()
			_, _ = p.persistResult(ctx, assistantID, acc, domain.StopReasonError, errMsg)
			_ = emit(domain.StreamEvent{
				Type:           domain.StreamEventError,
				ConversationID: p.conversation.ID,
				MessageID:      assistantID,
				ProviderID:     p.provider.ID,
				ModelID:        p.model.ID,
				Error:          &domain.StreamError{Code: domain.ErrCodeUpstreamError, Message: errMsg},
			})
			return nil
		}
		resp = nextResp
	}

	saved, persistErr := p.persistResult(ctx, assistantID, acc, finalStopReason, "")
	if persistErr != nil {
		_ = emit(domain.StreamEvent{
			Type:           domain.StreamEventError,
			ConversationID: p.conversation.ID,
			MessageID:      assistantID,
			ProviderID:     p.provider.ID,
			ModelID:        p.model.ID,
			Error: &domain.StreamError{
				Code:    "PERSIST_FAILED",
				Message: fmt.Sprintf("保存消息失败: %v", persistErr),
			},
		})
		return nil
	}
	return emit(domain.StreamEvent{
		Type:           domain.StreamEventMessageEnd,
		ConversationID: p.conversation.ID,
		MessageID:      assistantID,
		ProviderID:     p.provider.ID,
		ModelID:        p.model.ID,
		Message:        &saved,
	})
}

func (p *PreparedStream) persistResult(
	ctx context.Context,
	assistantID string,
	acc *streamAccumulator,
	stopReason string,
	errMsg string,
) (domain.Message, error) {
	// Detach from canceled request context so partial responses persist reliably on abort.
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()

	blocks := acc.blocksSlice()
	msg := domain.Message{
		ID:             assistantID,
		ConversationID: p.conversation.ID,
		Role:           domain.RoleAssistant,
		Blocks:         blocks,
		ProviderID:     p.provider.ID,
		ModelID:        p.model.ID,
		Usage:          acc.usage,
		StopReason:     stopReason,
		ErrorMessage:   errMsg,
		CreatedAt:      time.Now().UTC(),
	}
	var (
		saved domain.Message
		err   error
	)
	switch {
	case p.replaceMessageID != "":
		saved, err = p.service.msgs.ReplaceByID(persistCtx, p.conversation.ID, p.replaceMessageID, msg)
	case p.insertAfterMessageID != "":
		saved, err = p.service.msgs.InsertAfter(persistCtx, p.conversation.ID, p.insertAfterMessageID, msg)
	default:
		saved, err = p.service.msgs.Create(persistCtx, msg)
	}
	if err != nil {
		return domain.Message{}, err
	}
	_ = p.service.convs.TouchUpdatedAt(persistCtx, p.conversation.ID, time.Now().UTC())
	return saved, nil
}

type blockAccum struct {
	blockType string
	id        string
	name      string
	text      strings.Builder
	signature strings.Builder
	finalized *domain.ContentBlock
}

type streamAccumulator struct {
	order      []int
	blocks     map[int]*blockAccum
	usage      *domain.Usage
	stopReason string
}

func newStreamAccumulator() *streamAccumulator {
	return &streamAccumulator{
		blocks: make(map[int]*blockAccum),
	}
}

func (a *streamAccumulator) apply(ev domain.StreamEvent) {
	switch ev.Type {
	case domain.StreamEventBlockStart:
		if ev.Index == nil {
			return
		}
		idx := *ev.Index
		if _, exists := a.blocks[idx]; !exists {
			a.order = append(a.order, idx)
			b := &blockAccum{blockType: ev.BlockType}
			if ev.Block != nil {
				b.id = ev.Block.ID
				b.name = ev.Block.Name
			}
			a.blocks[idx] = b
		}
	case domain.StreamEventBlockDelta:
		if ev.Index == nil {
			return
		}
		b, ok := a.blocks[*ev.Index]
		if !ok {
			b = &blockAccum{blockType: ev.BlockType}
			a.order = append(a.order, *ev.Index)
			a.blocks[*ev.Index] = b
		}
		switch ev.DeltaType {
		case domain.DeltaTypeSignature:
			b.signature.WriteString(ev.Delta)
		default:
			b.text.WriteString(ev.Delta)
		}
	case domain.StreamEventBlockEnd:
		if ev.Index == nil || ev.Block == nil {
			return
		}
		b, ok := a.blocks[*ev.Index]
		if !ok {
			b = &blockAccum{blockType: ev.Block.Type}
			a.order = append(a.order, *ev.Index)
			a.blocks[*ev.Index] = b
		}
		cp := *ev.Block
		b.finalized = &cp
	case domain.StreamEventMessageDelta:
		if ev.Usage != nil {
			a.usage = ev.Usage
		}
		if ev.StopReason != "" {
			a.stopReason = ev.StopReason
		}
	}
}

func (a *streamAccumulator) blocksSlice() []domain.ContentBlock {
	out := make([]domain.ContentBlock, 0, len(a.order))
	for _, idx := range a.order {
		b := a.blocks[idx]
		if b.finalized != nil {
			out = append(out, *b.finalized)
			continue
		}
		switch b.blockType {
		case domain.BlockTypeThinking:
			out = append(out, domain.ContentBlock{
				Type:      domain.BlockTypeThinking,
				Thinking:  b.text.String(),
				Signature: b.signature.String(),
			})
		case domain.BlockTypeToolCall:
			var args json.RawMessage
			if raw := strings.TrimSpace(b.text.String()); raw != "" {
				if json.Valid([]byte(raw)) {
					args = json.RawMessage(raw)
				} else if encoded, err := json.Marshal(raw); err == nil {
					args = json.RawMessage(encoded)
				}
			}
			out = append(out, domain.ContentBlock{
				Type:      domain.BlockTypeToolCall,
				ID:        b.id,
				Name:      b.name,
				Arguments: args,
			})
		default:
			out = append(out, domain.ContentBlock{
				Type: domain.BlockTypeText,
				Text: b.text.String(),
			})
		}
	}
	return out
}

func findModel(models []domain.ModelConfig, modelID string) (domain.ModelConfig, bool) {
	for _, m := range models {
		if m.ID == modelID {
			return m, true
		}
	}
	return domain.ModelConfig{}, false
}

func mergeGenerationParams(base, override domain.GenerationParams) domain.GenerationParams {
	out := base
	if override.Temperature != nil {
		v := *override.Temperature
		out.Temperature = &v
	}
	if override.MaxTokens != nil {
		v := *override.MaxTokens
		out.MaxTokens = &v
	}
	if override.ReasoningEffort != "" {
		out.ReasoningEffort = override.ReasoningEffort
	}
	return out
}

func deriveTitleFromBlocks(blocks []domain.ContentBlock) string {
	for _, b := range blocks {
		if b.Type == domain.BlockTypeText {
			line := strings.TrimSpace(b.Text)
			if line == "" {
				continue
			}
			if idx := strings.IndexByte(line, '\n'); idx >= 0 {
				line = strings.TrimSpace(line[:idx])
			}
			runes := []rune(line)
			if len(runes) > 40 {
				return string(runes[:40]) + "..."
			}
			return line
		}
	}
	return ""
}

func latestUserQuery(history []domain.Message) string {
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role != domain.RoleUser {
			continue
		}
		var parts []string
		for _, b := range history[i].Blocks {
			if b.Type == domain.BlockTypeText && strings.TrimSpace(b.Text) != "" {
				parts = append(parts, strings.TrimSpace(b.Text))
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	return ""
}

func (s *ChatService) runWebSearch(ctx context.Context, requestedEngineID, query string) (*domain.ContentBlock, string) {
	makeErrorBlock := func(engineID, errMsg string) (*domain.ContentBlock, string) {
		raw, _ := json.Marshal(map[string]any{
			"query":    query,
			"engineId": engineID,
			"error":    errMsg,
		})
		return &domain.ContentBlock{
			Type:  domain.BlockTypeWebSearch,
			Extra: raw,
		}, ""
	}

	engineID := strings.TrimSpace(requestedEngineID)
	if s.searchReg == nil || s.searchStore == nil {
		return makeErrorBlock(engineID, "搜索引擎服务未启用")
	}

	var (
		cfg domain.SearchEngineConfig
		ok  bool
	)
	if engineID != "" {
		if stored, err := s.searchStore.Get(ctx, engineID); err == nil {
			cfg = stored
			ok = true
		} else {
			cfg = domain.SearchEngineConfig{EngineID: engineID, MaxResults: 5}
			ok = true
		}
	} else {
		storedList, err := s.searchStore.List(ctx)
		if err == nil {
			for _, item := range storedList {
				if item.IsDefault && item.Enabled {
					cfg = item
					engineID = item.EngineID
					ok = true
					break
				}
			}
			if !ok {
				for _, item := range storedList {
					if item.Enabled {
						cfg = item
						engineID = item.EngineID
						ok = true
						break
					}
				}
			}
		}
	}

	if !ok || engineID == "" {
		return makeErrorBlock(engineID, "未配置或未启用联网搜索引擎")
	}
	engine, exists := s.searchReg.Get(engineID)
	if !exists {
		return makeErrorBlock(engineID, fmt.Sprintf("未注册搜索引擎 %q", engineID))
	}
	if strings.TrimSpace(query) == "" {
		return makeErrorBlock(engineID, "检索内容为空")
	}

	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = engine.DefaultEndpoint()
	}
	maxResults := cfg.MaxResults
	if maxResults <= 0 {
		maxResults = 5
	}

	searchCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	results, err := engine.Search(searchCtx, plugin.SearchQueryInput{
		Query:      query,
		Endpoint:   endpoint,
		APIKey:     cfg.APIKey,
		MaxResults: maxResults,
	})
	if err != nil {
		return makeErrorBlock(engineID, err.Error())
	}

	raw, _ := json.Marshal(map[string]any{
		"query":    query,
		"engineId": engineID,
		"results":  results,
	})
	block := &domain.ContentBlock{
		Type:  domain.BlockTypeWebSearch,
		Extra: raw,
	}

	return block, formatSearchResultsPrompt(results)
}
