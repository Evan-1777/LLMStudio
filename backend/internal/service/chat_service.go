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
}

// ChatService orchestrates upstream LLM requests, SSE normalization, cancellation, and persistence.
type ChatService struct {
	providers  *store.ProviderStore
	convs      *store.ConversationStore
	msgs       *store.MessageStore
	formats    *plugin.FormatRegistry
	adapters   *plugin.ProviderRegistry
	httpClient *http.Client
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

// PreparedStream holds a validated, open upstream HTTP response ready to stream SSE events to the client.
type PreparedStream struct {
	service      *ChatService
	conversation domain.Conversation
	provider     domain.ProviderConfig
	model        domain.ModelConfig
	apiFormat    plugin.APIFormat
	resp         *http.Response
}

// Prepare validates inputs, persists user message (or trims regenerated assistant messages),
// encodes the upstream payload, and opens the upstream HTTP connection BEFORE SSE headers are sent.
func (s *ChatService) Prepare(ctx context.Context, in StreamChatInput) (*PreparedStream, error) {
	conv, err := s.convs.Get(ctx, in.ConversationID)
	if err != nil {
		return nil, err
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
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, "providerId and modelId are required", nil)
	}

	prov, err := s.providers.Get(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if !prov.Enabled {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("provider %q is disabled", prov.Name), nil)
	}
	model, ok := findModel(prov.Models, modelID)
	if !ok {
		return nil, domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("model %q not found on provider %q", modelID, prov.Name), nil)
	}

	apiFormat, ok := s.formats.Get(model.APIFormat)
	if !ok {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unregistered apiFormat %q", model.APIFormat), nil)
	}
	adapter, ok := s.adapters.Get(prov.Adapter)
	if !ok {
		return nil, domain.NewError(domain.ErrCodeInvalidArgument, fmt.Sprintf("unregistered provider adapter %q", prov.Adapter), nil)
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
			return nil, domain.NewError(domain.ErrCodeInvalidArgument, "message blocks or text are required", nil)
		}
	} else {
		if _, err := s.msgs.Get(ctx, in.RegenerateMessageID); err != nil {
			return nil, err
		}
	}

	history, err := s.msgs.ListByConversation(ctx, conv.ID)
	if err != nil {
		return nil, err
	}

	if isRegen {
		targetIdx := -1
		for i, m := range history {
			if m.ID == in.RegenerateMessageID {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			return nil, domain.NewError(domain.ErrCodeNotFound, "target message not found in conversation", nil)
		}
		history = history[:targetIdx]
	} else {
		history = append(history, domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleUser,
			Blocks:         userBlocks,
			CreatedAt:      time.Now().UTC(),
		})
	}

	effectiveParams := mergeGenerationParams(conv.Params, in.Params)
	mergedCompat := format.MergeCompat(apiFormat.DefaultCompat(), model.Compat)
	encoded, err := apiFormat.EncodeRequest(ctx, plugin.ChatInput{
		ConversationID: conv.ID,
		Provider:       prov,
		Model:          model,
		SystemPrompt:   conv.SystemPrompt,
		Messages:       history,
		Params:         effectiveParams,
		Compat:         mergedCompat,
	})
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInternalError, "encode upstream request failed", err)
	}

	endpoint, err := adapter.ResolveEndpoint(prov, model, encoded.DefaultPath, encoded.Query, mergedCompat)
	if err != nil {
		return nil, err
	}

	upReq, err := http.NewRequestWithContext(ctx, encoded.Method, endpoint.URL, bytes.NewReader(encoded.Body))
	if err != nil {
		return nil, domain.NewError(domain.ErrCodeInternalError, "construct upstream request failed", err)
	}
	for k, vals := range encoded.Headers {
		for _, v := range vals {
			upReq.Header.Add(k, v)
		}
	}
	for k, vals := range endpoint.Headers {
		upReq.Header.Del(k)
		for _, v := range vals {
			upReq.Header.Add(k, v)
		}
	}

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

	if isRegen {
		if err := s.msgs.DeleteFrom(ctx, conv.ID, in.RegenerateMessageID); err != nil {
			_ = resp.Body.Close()
			return nil, err
		}
	} else {
		if _, err := s.msgs.Create(ctx, domain.Message{
			ConversationID: conv.ID,
			Role:           domain.RoleUser,
			Blocks:         userBlocks,
			CreatedAt:      time.Now().UTC(),
		}); err != nil {
			_ = resp.Body.Close()
			return nil, err
		}
		// Auto-title freshly created conversations from the first user prompt.
		if (conv.Title == "" || conv.Title == "New Chat") && len(history) == 1 {
			if derived := deriveTitleFromBlocks(userBlocks); derived != "" {
				conv.Title = derived
				if updated, uErr := s.convs.Update(ctx, conv); uErr == nil {
					conv = updated
				}
			}
		}
	}

	return &PreparedStream{
		service:      s,
		conversation: conv,
		provider:     prov,
		model:        model,
		apiFormat:    apiFormat,
		resp:         resp,
	}, nil
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

	var streamErrMsg string
	decodeErr := p.apiFormat.DecodeStream(ctx, p.resp.Body, func(ev domain.StreamEvent) error {
		ev.ConversationID = p.conversation.ID
		ev.MessageID = assistantID
		ev.ProviderID = p.provider.ID
		ev.ModelID = p.model.ID

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
	saved, err := p.service.msgs.Create(persistCtx, msg)
	if err != nil {
		return msg
	}
	_ = p.service.convs.TouchUpdatedAt(persistCtx, p.conversation.ID, saved.CreatedAt)
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
