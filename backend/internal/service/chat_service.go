package service

import (
	"context"
	"encoding/json"
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
	MCPToolsEnabled     *bool                      `json:"mcpToolsEnabled,omitempty"`
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
	baseCtx     context.Context
	baseCancel  context.CancelFunc
	runs        *chatRunManager
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
	baseCtx, baseCancel := context.WithCancel(context.Background())
	return &ChatService{
		providers:  providers,
		convs:      convs,
		msgs:       msgs,
		formats:    formats,
		adapters:   adapters,
		httpClient: httpClient,
		cacheStore: newPromptCacheStore(defaultPromptCacheMaxEntries),
		baseCtx:    baseCtx,
		baseCancel: baseCancel,
		runs:       newChatRunManager(),
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

type pendingUserWrite struct {
	blocks          []domain.ContentBlock
	graphWrite      *domain.MessageGraphWrite
	shouldAutoTitle bool
	createdAt       time.Time
}

// PreparedStream holds a validated, open upstream HTTP response ready to stream SSE events to the client.
type PreparedStream struct {
	graphWrite           *domain.MessageGraphWrite
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
	assistantID          string
	detachedRun          *detachedRun
	isRegen              bool
	pendingUser          *pendingUserWrite
}

// ConversationID returns the target conversation ID of the prepared stream.
func (p *PreparedStream) ConversationID() string {
	if p == nil {
		return ""
	}
	return p.conversation.ID
}

// WaitDetachedOutcome blocks until a detached background Agent run finishes or ctx is canceled,
// returning the terminal stopReason and error summary derived from terminal stream events.
func (p *PreparedStream) WaitDetachedOutcome(ctx context.Context) (stopReason, errMsg string, completed bool) {
	if p == nil || p.detachedRun == nil {
		return "", "", false
	}
	return p.detachedRun.waitOutcome(ctx)
}

type preparedUpstream struct {
	graphWrite           *domain.MessageGraphWrite
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
// and opens the upstream HTTP connection. The new user prompt is persisted lazily right
// before the first substantive assistant block, so an empty rollback writes nothing.
func (s *ChatService) Prepare(ctx context.Context, in StreamChatInput) (*PreparedStream, error) {
	prepareStartedAt := time.Now()
	workCtx := ctx
	var (
		detached        *detachedRun
		detachedStarted bool
	)
	if s.agent != nil && s.convs != nil && s.runs != nil && strings.TrimSpace(in.ConversationID) != "" {
		if conv, getErr := s.convs.Get(ctx, in.ConversationID); getErr == nil &&
			conv.Mode == domain.ConversationModeAgent && !conv.Ephemeral {
			run, runCtx, resErr := s.runs.reserve(conv.ID, s.baseCtx, prepareStartedAt)
			if resErr != nil {
				return nil, resErr
			}
			detached = run
			workCtx = runCtx
			defer func() {
				if !detachedStarted {
					detached.cancel()
					s.runs.release(conv.ID, detached)
				}
			}()
		}
	}

	prep, err := s.prepareUpstream(workCtx, in, false)
	if err != nil {
		return nil, err
	}

	assistantID := domain.NewUUID()
	if detached != nil {
		assistantID = detached.snapshotInfo().MessageID
	}
	if graphEnabled(prep.conversation) && prep.replaceMessageID != "" {
		assistantID = prep.replaceMessageID
	}
	if detached != nil {
		detached.updateInfo(func(info *ActiveRunInfo) {
			info.MessageID = assistantID
			info.ProviderID = prep.provider.ID
			info.ModelID = prep.model.ID
			info.ReplaceMessageID = prep.replaceMessageID
			info.InsertAfterMessageID = prep.insertAfterMessageID
		})
	}

	chatInput := prep.chatInput
	currentCache := s.cacheStore.Get(prep.cacheScope)
	activeCache, plan, planErr := s.executeCachePlan(
		workCtx,
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
		workCtx,
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
	var pendingUser *pendingUserWrite
	if !prep.isRegen {
		pendingUser = &pendingUserWrite{
			blocks:          prep.userBlocks,
			graphWrite:      prep.graphWrite,
			shouldAutoTitle: (conv.Title == "" || conv.Title == "New Chat") && prep.historyLen == 1,
			createdAt:       time.Now().UTC(),
		}
		if detached != nil {
			detached.updateInfo(func(info *ActiveRunInfo) {
				info.PendingUserMessage = &domain.Message{
					ID:             "pending-user-" + assistantID,
					ConversationID: conv.ID,
					Role:           domain.RoleUser,
					Blocks:         prep.userBlocks,
					CreatedAt:      pendingUser.createdAt,
				}
			})
		}
	}

	ps := &PreparedStream{
		graphWrite:           nil,
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
		assistantID:          assistantID,
		detachedRun:          detached,
		isRegen:              prep.isRegen,
		pendingUser:          pendingUser,
	}

	if detached != nil {
		detachedStarted = true
		go func() {
			defer func() {
				detached.cancel()
				s.runs.release(ps.conversation.ID, detached)
			}()
			_ = ps.runStream(workCtx, detached.publish, detached.setUsage, detached.snapshotState, true)
		}()
	}

	return ps, nil
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

type resolvedTurnHistory struct {
	allMessages          []domain.Message
	history              []domain.Message
	graphWrite           *domain.MessageGraphWrite
	replaceMessageID     string
	insertAfterMessageID string
}

func resolveTurnHistory(
	conv domain.Conversation,
	prov domain.ProviderConfig,
	model domain.ModelConfig,
	in StreamChatInput,
	allMessages []domain.Message,
	isRegen bool,
	isLocalCont bool,
	userBlocks []domain.ContentBlock,
) (resolvedTurnHistory, error) {
	history := allMessages
	active := resolveActiveBranchPath(conv, history)
	var (
		graphWrite           *domain.MessageGraphWrite
		replaceMessageID     string
		insertAfterMessageID string
		err                  error
	)
	switch {
	case isRegen:
		if graphEnabled(conv) {
			history, err = resolvePathUpToMessage(history, in.RegenerateMessageID)
			if err != nil {
				return resolvedTurnHistory{}, err
			}
		}
		targetIdx := -1
		for i, m := range history {
			if m.ID == in.RegenerateMessageID {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			return resolvedTurnHistory{}, domain.NewError(domain.ErrCodeNotFound, "target message not found in conversation", nil)
		}
		target := history[targetIdx]
		if target.Role == domain.RoleUser {
			if graphEnabled(conv) {
				insertAfterMessageID = target.ID
			}
			for i, m := range active {
				if m.ID != target.ID || i+1 == len(active) {
					continue
				}
				if active[i+1].Role == domain.RoleAssistant {
					replaceMessageID, insertAfterMessageID = active[i+1].ID, ""
				} else {
					insertAfterMessageID = target.ID
				}
				break
			}
			history = history[:targetIdx+1]
		} else {
			replaceMessageID = target.ID
			history = history[:targetIdx]
		}
	case isLocalCont:
		anchorID := strings.TrimSpace(in.LocalContinuation.UserMessageID)
		if graphEnabled(conv) {
			history, err = resolvePathUpToMessage(history, anchorID)
			if err != nil {
				return resolvedTurnHistory{}, err
			}
		} else {
			for i, m := range history {
				if m.ID == anchorID {
					history = history[:i+1]
					break
				}
			}
		}
		if len(history) == 0 || history[len(history)-1].ID != anchorID {
			return resolvedTurnHistory{}, domain.NewError(domain.ErrCodeNotFound, "anchor user message not found in conversation", nil)
		}
	default:
		if graphEnabled(conv) {
			parentID := ""
			if len(active) > 0 {
				parentID = active[len(active)-1].ID
			}
			graphWrite = &domain.MessageGraphWrite{ParentID: &parentID, ConsumeBranchID: conv.GraphState.ActiveBranchID}
		}
		history = append(active, domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleUser,
			Blocks:         userBlocks,
			CreatedAt:      time.Now().UTC(),
		})
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
	return resolvedTurnHistory{
		allMessages:          allMessages,
		history:              history,
		graphWrite:           graphWrite,
		replaceMessageID:     replaceMessageID,
		insertAfterMessageID: insertAfterMessageID,
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
		var agentSuffix string
		agentSuffix, nativeTools, err = s.agent.PrepareContext(ctx, conv.ID)
		if err != nil {
			return preparedUpstream{}, err
		}
		if agentSuffix != "" {
			if strings.TrimSpace(up.systemPrompt) == "" {
				up.systemPrompt = agentSuffix
			} else {
				up.systemPrompt = up.systemPrompt + "\n\n" + agentSuffix
			}
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

	allMessages, err := s.msgs.ListByConversation(ctx, conv.ID)
	if err != nil {
		return preparedUpstream{}, err
	}
	turnHist, err := resolveTurnHistory(conv, prov, model, in, allMessages, isRegen, isLocalCont, userBlocks)
	if err != nil {
		return preparedUpstream{}, err
	}

	rawHistoryLen := len(turnHist.history)
	history := projectModelHistory(turnHist.history)

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
	history = expandSideReferences(turnHist.allMessages, history)

	prefs := s.resolvePreferencesSnapshot(ctx)

	tools, toolBindings, err := s.discoverActiveTools(ctx, prefs.BuiltinTimeToolEnabled, conv.ID, nativeTools, in.MCPToolsEnabled == nil || *in.MCPToolsEnabled)
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
		graphWrite:           turnHist.graphWrite,
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
		replaceMessageID:     turnHist.replaceMessageID,
		insertAfterMessageID: turnHist.insertAfterMessageID,
		autoCreateCache:      autoCreateCache,
		mcpMaxToolRounds:     prefs.MCPMaxToolRounds,
		credentialEnvelope:   in.CredentialEnvelope,
		cacheScope:           cacheScope,
		chatInput:            chatInput,
	}, nil
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
			if first, _, ok := strings.Cut(line, "\n"); ok {
				line = strings.TrimSpace(first)
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
