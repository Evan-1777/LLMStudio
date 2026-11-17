package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/store"
)

// StreamChatInput defines the payload accepted by the streaming chat endpoint.
type StreamChatInput struct {
	ConversationID      string                  `json:"-"`
	Blocks              []domain.ContentBlock   `json:"blocks"`
	Text                string                  `json:"text"`
	ProviderID          string                  `json:"providerId"`
	ModelID             string                  `json:"modelId"`
	Params              domain.GenerationParams `json:"params"`
	RegenerateMessageID string                  `json:"regenerateMessageId"`
	WebSearch           bool                    `json:"webSearch"`
	SearchEngineID      string                  `json:"searchEngineId,omitempty"`
}

// ChatService orchestrates upstream LLM requests, SSE normalization, cancellation, and persistence.
type ChatService struct {
	providers   *store.ProviderStore
	convs       *store.ConversationStore
	msgs        *store.MessageStore
	formats     *plugin.FormatRegistry
	adapters    *plugin.ProviderRegistry
	httpClient  *http.Client
	assistants  *store.AssistantStore
	searchReg   *plugin.SearchRegistry
	searchStore *store.SearchConfigStore
}

// NewChatService constructs a ChatService. If httpClient is nil, a default client with no overall request timeout is used.
func NewChatService(
	providers *store.ProviderStore,
	convs *store.ConversationStore,
	msgs *store.MessageStore,
	formats *plugin.FormatRegistry,
	adapters *plugin.ProviderRegistry,
	httpClient *http.Client,
) *ChatService {
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
	}
}

// WithAssistants injects an AssistantStore so chat requests inherit assistant presets.
func (s *ChatService) WithAssistants(assistants *store.AssistantStore) *ChatService {
	s.assistants = assistants
	return s
}

// WithSearch injects the orthogonal SearchRegistry and SearchConfigStore for web search augmentation.
func (s *ChatService) WithSearch(searchReg *plugin.SearchRegistry, searchStore *store.SearchConfigStore) *ChatService {
	s.searchReg = searchReg
	s.searchStore = searchStore
	return s
}

// PreparedStream holds a validated, open upstream HTTP response ready to stream SSE events to the client.
type PreparedStream struct {
	service              *ChatService
	conversation         domain.Conversation
	provider             domain.ProviderConfig
	model                domain.ModelConfig
	apiFormat            plugin.APIFormat
	resp                 *http.Response
	webSearchBlock       *domain.ContentBlock
	replaceMessageID     string
	insertAfterMessageID string
}

// PreparedLocalRequest holds a pre-encoded upstream request for browser-direct execution.
// Server-stored API keys are never included in URL or Headers.
type PreparedLocalRequest struct {
	Method               string               `json:"method"`
	URL                  string               `json:"url"`
	Headers              map[string]string    `json:"headers"`
	Body                 json.RawMessage      `json:"body"`
	AuthType             string               `json:"authType"`
	WebSearchBlock       *domain.ContentBlock `json:"webSearchBlock,omitempty"`
	ReplaceMessageID     string               `json:"replaceMessageId,omitempty"`
	InsertAfterMessageID string               `json:"insertAfterMessageId,omitempty"`
}

type preparedUpstream struct {
	conversation         domain.Conversation
	provider             domain.ProviderConfig
	model                domain.ModelConfig
	apiFormat            plugin.APIFormat
	encoded              plugin.EncodedRequest
	endpoint             plugin.ResolvedEndpoint
	webSearchBlock       *domain.ContentBlock
	isRegen              bool
	userBlocks           []domain.ContentBlock
	historyLen           int
	replaceMessageID     string
	insertAfterMessageID string
}

// Prepare validates inputs, encodes the upstream payload, opens the upstream HTTP connection,
// and persists any new user prompt BEFORE SSE headers are sent.
func (s *ChatService) Prepare(ctx context.Context, in StreamChatInput) (*PreparedStream, error) {
	prep, err := s.prepareUpstream(ctx, in, false)
	if err != nil {
		return nil, err
	}

	upReq, err := http.NewRequestWithContext(ctx, prep.encoded.Method, prep.endpoint.URL, bytes.NewReader(prep.encoded.Body))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInternalError, "construct upstream request failed", err)
	}
	upReq.Header = mergeRequestHeaders(prep.encoded.Headers, prep.endpoint.Headers)

	resp, err := s.httpClient.Do(upReq)
	if err != nil {
		if ctx.Err() != nil {
			return nil, domain.NewError(domain.ErrCodeUpstreamError, "request canceled", ctx.Err())
		}
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("upstream request failed: %v", err), err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodySnippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		msg := strings.TrimSpace(string(bodySnippet))
		if msg == "" {
			msg = resp.Status
		}
		return nil, domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("upstream returned HTTP %d: %s", resp.StatusCode, msg), nil)
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
		service:              s,
		conversation:         conv,
		provider:             prep.provider,
		model:                prep.model,
		apiFormat:            prep.apiFormat,
		resp:                 resp,
		webSearchBlock:       prep.webSearchBlock,
		replaceMessageID:     prep.replaceMessageID,
		insertAfterMessageID: prep.insertAfterMessageID,
	}, nil
}

// PrepareLocal validates inputs, runs optional web search, and encodes the upstream request
// without mutating SQLite or emitting server-stored API keys.
func (s *ChatService) PrepareLocal(ctx context.Context, in StreamChatInput) (PreparedLocalRequest, error) {
	prep, err := s.prepareUpstream(ctx, in, true)
	if err != nil {
		return PreparedLocalRequest{}, err
	}

	merged := mergeRequestHeaders(prep.encoded.Headers, prep.endpoint.Headers)
	headers := make(map[string]string, len(merged))
	for k, vals := range merged {
		if len(vals) > 0 {
			headers[k] = strings.Join(vals, ", ")
		}
	}
	body := json.RawMessage(prep.encoded.Body)
	if len(body) == 0 {
		body = json.RawMessage("{}")
	}

	authType := strings.TrimSpace(prep.provider.AuthType)
	if authType == "" {
		authType = domain.AuthTypeBearer
	}

	return PreparedLocalRequest{
		Method:               prep.encoded.Method,
		URL:                  prep.endpoint.URL,
		Headers:              headers,
		Body:                 body,
		AuthType:             authType,
		WebSearchBlock:       prep.webSearchBlock,
		ReplaceMessageID:     prep.replaceMessageID,
		InsertAfterMessageID: prep.insertAfterMessageID,
	}, nil
}

func (s *ChatService) prepareUpstream(ctx context.Context, in StreamChatInput, allowMissingLocalKey bool) (preparedUpstream, error) {
	conv, err := s.convs.Get(ctx, in.ConversationID)
	if err != nil {
		return preparedUpstream{}, err
	}

	providerID := strings.TrimSpace(in.ProviderID)
	if providerID == "" {
		providerID = conv.ProviderID
	}
	modelID := strings.TrimSpace(in.ModelID)
	if modelID == "" {
		modelID = conv.ModelID
	}
	if providerID == "" || modelID == "" {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, "providerId and modelId are required", nil)
	}

	prov, err := s.providers.Get(ctx, providerID)
	if err != nil {
		return preparedUpstream{}, err
	}
	if !prov.Enabled {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("provider %q is disabled", prov.Name), nil)
	}
	model, ok := findModel(prov.Models, modelID)
	if !ok {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("model %q not found on provider %q", modelID, prov.Name), nil)
	}

	apiFormat, ok := s.formats.Get(model.APIFormat)
	if !ok {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unregistered apiFormat %q", model.APIFormat), nil)
	}
	adapter, ok := s.adapters.Get(prov.Adapter)
	if !ok {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unregistered provider adapter %q", prov.Adapter), nil)
	}

	isRegen := strings.TrimSpace(in.RegenerateMessageID) != ""
	var userBlocks []domain.ContentBlock
	if !isRegen {
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
	} else {
		history = append(history, domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleUser,
			Blocks:         userBlocks,
			CreatedAt:      time.Now().UTC(),
		})
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
	effectiveParams = mergeGenerationParams(effectiveParams, in.Params)

	var webSearchBlock *domain.ContentBlock
	if in.WebSearch {
		block, searchPrompt := s.runWebSearch(ctx, in.SearchEngineID, latestUserQuery(history))
		webSearchBlock = block
		if searchPrompt != "" {
			if strings.TrimSpace(effectiveSystemPrompt) == "" {
				effectiveSystemPrompt = searchPrompt
			} else {
				effectiveSystemPrompt = effectiveSystemPrompt + "\n\n" + searchPrompt
			}
		}
	}

	mergedCompat := format.MergeCompat(apiFormat.DefaultCompat(), model.Compat)
	encoded, err := apiFormat.EncodeRequest(ctx, plugin.ChatInput{
		ConversationID: conv.ID,
		Provider:       prov,
		Model:          model,
		SystemPrompt:   effectiveSystemPrompt,
		Messages:       history,
		Params:         effectiveParams,
		Compat:         mergedCompat,
	})
	if err != nil {
		return preparedUpstream{}, domain.NewError(domain.ErrCodeInternalError, "encode upstream request failed", err)
	}

	resolveProv := prov
	if allowMissingLocalKey {
		authType := strings.TrimSpace(prov.AuthType)
		if authType == "" {
			authType = domain.AuthTypeBearer
		}
		if !prov.LocalRequest && authType != domain.AuthTypeNone && strings.TrimSpace(prov.APIKey) == "" {
			return preparedUpstream{}, domain.NewError(
				domain.ErrCodeInvalidArgument,
				fmt.Sprintf("provider %q API key is required for authType %q", prov.Name, authType),
				nil,
			)
		}
		// Never emit server-stored API keys in pre-encoded browser-direct responses.
		resolveProv.AuthType = domain.AuthTypeNone
		resolveProv.APIKey = ""
	}

	endpoint, err := adapter.ResolveEndpoint(resolveProv, model, encoded.DefaultPath, encoded.Query, mergedCompat)
	if err != nil {
		return preparedUpstream{}, err
	}

	return preparedUpstream{
		conversation:         conv,
		provider:             prov,
		model:                model,
		apiFormat:            apiFormat,
		encoded:              encoded,
		endpoint:             endpoint,
		webSearchBlock:       webSearchBlock,
		isRegen:              isRegen,
		userBlocks:           userBlocks,
		historyLen:           len(history),
		replaceMessageID:     replaceMessageID,
		insertAfterMessageID: insertAfterMessageID,
	}, nil
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

// Stream consumes the upstream response body, translates events via emit, handles cancellation,
// and persists the resulting assistant message (complete, aborted, or error).
func (p *PreparedStream) Stream(ctx context.Context, emit func(domain.StreamEvent) error) error {
	defer p.resp.Body.Close()

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
		p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
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
			p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
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
			p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
			return err
		}
		indexOffset = 1
	}

	var streamErrMsg string
	decodeErr := p.apiFormat.DecodeStream(ctx, p.resp.Body, func(ev domain.StreamEvent) error {
		ev.ConversationID = p.conversation.ID
		ev.MessageID = assistantID
		ev.ProviderID = p.provider.ID
		ev.ModelID = p.model.ID
		if indexOffset > 0 && ev.Index != nil {
			shifted := *ev.Index + indexOffset
			ev.Index = &shifted
		}

		acc.apply(ev)
		if ev.Type == domain.StreamEventError && ev.Error != nil {
			streamErrMsg = ev.Error.Message
		}
		return emit(ev)
	})

	// Aborted by caller context cancellation (client disconnect or abort trigger).
	if ctx.Err() != nil || errors.Is(decodeErr, context.Canceled) {
		p.persistResult(ctx, assistantID, acc, domain.StopReasonAborted, "")
		return nil
	}

	// Stream failed mid-flight or emitted an upstream error event.
	if decodeErr != nil || streamErrMsg != "" {
		errMsg := streamErrMsg
		if errMsg == "" && decodeErr != nil {
			errMsg = decodeErr.Error()
		}
		p.persistResult(ctx, assistantID, acc, domain.StopReasonError, errMsg)
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

	stopReason := acc.stopReason
	if stopReason == "" {
		stopReason = domain.StopReasonStop
	}
	saved := p.persistResult(ctx, assistantID, acc, stopReason, "")
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
) domain.Message {
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
		return msg
	}
	_ = p.service.convs.TouchUpdatedAt(persistCtx, p.conversation.ID, time.Now().UTC())
	return saved
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

	var sb strings.Builder
	sb.WriteString("[联网搜索结果]\n")
	for i, r := range results {
		fmt.Fprintf(&sb, "%d. %s (%s)\n", i+1, r.Title, r.URL)
		if r.Snippet != "" {
			fmt.Fprintf(&sb, "   %s\n", r.Snippet)
		}
	}
	sb.WriteString("请结合以上联网搜索结果回答用户问题，并在合适位置引用来源链接。")
	return block, sb.String()
}
