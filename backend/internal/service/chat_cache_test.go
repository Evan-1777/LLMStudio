package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/store"
)

type fakePlannerFormat struct {
	id         string
	planCount  atomic.Int32
	createPath string
}

func (f *fakePlannerFormat) ID() string          { return f.id }
func (f *fakePlannerFormat) DisplayName() string { return "Fake Planner" }
func (f *fakePlannerFormat) DefaultPath() string { return "/v1/generate" }
func (f *fakePlannerFormat) DefaultCompat() domain.CompatConfig {
	return domain.CompatConfig{CacheMode: domain.CacheModeAuto}
}

func (f *fakePlannerFormat) PlanCache(_ context.Context, input plugin.ChatInput, current *plugin.PromptCacheState) (plugin.CachePlan, error) {
	f.planCount.Add(1)
	compat := format.MergeCompat(f.DefaultCompat(), input.Compat)
	if !input.AutoCreateCache || compat.CacheMode == domain.CacheModeDisabled || compat.CacheMode == domain.CacheModeImplicit {
		return plugin.CachePlan{}, nil
	}
	if current != nil && current.ResourceName != "" && !current.Unsupported {
		return plugin.CachePlan{ReuseState: current}, nil
	}
	body, _ := json.Marshal(map[string]any{
		"model":  input.Model.ID,
		"prefix": input.SystemPrompt,
	})
	return plugin.CachePlan{
		PlanKey: "plan-1",
		CreateRequest: &plugin.EncodedRequest{
			Method:      http.MethodPost,
			DefaultPath: f.createPath,
			Headers:     http.Header{"Content-Type": []string{"application/json"}},
			Body:        body,
		},
	}, nil
}

func (f *fakePlannerFormat) ResolveCache(_ context.Context, _ plugin.ChatInput, _ plugin.CachePlan, res plugin.CacheResolutionInput) (plugin.CacheResolutionResult, error) {
	if res.StatusCode == http.StatusUnauthorized {
		return plugin.CacheResolutionResult{
			HardError: domain.NewError(domain.ErrCodeUpstreamError, "cache auth error", nil),
		}, nil
	}
	var payload struct {
		Name       string `json:"name"`
		ExpireTime string `json:"expireTime"`
	}
	_ = json.Unmarshal(res.Body, &payload)
	var exp time.Time
	if payload.ExpireTime != "" {
		exp, _ = time.Parse(time.RFC3339Nano, payload.ExpireTime)
	}
	return plugin.CacheResolutionResult{
		State: &plugin.PromptCacheState{
			ResourceName: payload.Name,
			ExpireTime:   exp,
		},
	}, nil
}

func (f *fakePlannerFormat) ClassifyCacheError(statusCode int, _ []byte, used *plugin.PromptCacheState) plugin.CacheFailureAction {
	if used != nil && statusCode == http.StatusNotFound {
		return plugin.CacheFailureAction{InvalidateScope: true, RetryWithoutCache: true}
	}
	return plugin.CacheFailureAction{}
}

func (f *fakePlannerFormat) EncodeRequest(_ context.Context, input plugin.ChatInput) (plugin.EncodedRequest, error) {
	compat := format.MergeCompat(f.DefaultCompat(), input.Compat)
	body := map[string]any{
		"model":     input.Model.ID,
		"cacheMode": compat.CacheMode,
		"messages":  len(input.Messages),
	}
	if input.PromptCache != nil && input.PromptCache.ResourceName != "" {
		body["cachedContent"] = input.PromptCache.ResourceName
	}
	raw, _ := json.Marshal(body)
	return plugin.EncodedRequest{
		Method:      http.MethodPost,
		DefaultPath: f.DefaultPath(),
		Headers:     http.Header{"Content-Type": []string{"application/json"}},
		Body:        raw,
	}, nil
}

func (f *fakePlannerFormat) DecodeStream(_ context.Context, body io.Reader, emit func(domain.StreamEvent) error) error {
	raw, _ := io.ReadAll(body)
	text := strings.TrimSpace(string(raw))
	if text == "" {
		text = "ok"
	}
	if err := emit(domain.StreamEvent{Type: domain.StreamEventBlockStart, Index: domain.IntPtr(0), BlockType: domain.BlockTypeText}); err != nil {
		return err
	}
	if err := emit(domain.StreamEvent{Type: domain.StreamEventBlockDelta, Index: domain.IntPtr(0), BlockType: domain.BlockTypeText, DeltaType: domain.DeltaTypeText, Delta: text}); err != nil {
		return err
	}
	if err := emit(domain.StreamEvent{Type: domain.StreamEventBlockEnd, Index: domain.IntPtr(0), BlockType: domain.BlockTypeText, Block: &domain.ContentBlock{Type: domain.BlockTypeText, Text: text}}); err != nil {
		return err
	}
	return emit(domain.StreamEvent{Type: domain.StreamEventMessageDelta, StopReason: domain.StopReasonStop})
}

func TestProviderModelCacheModeValidationAndPersistence(t *testing.T) {
	ctx := context.Background()
	provSvc, _, _, _, _, _ := setupServiceTestEnv(t)

	_, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-bad",
		Name:     "Bad",
		Adapter:  "generic-http",
		BaseURL:  "https://example.com",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-1",
		Models: []domain.ModelConfig{{
			ID:        "m1",
			Name:      "M1",
			APIFormat: "openai-completions",
			Compat:    domain.CompatConfig{CacheMode: "bogus"},
		}},
	})
	if err == nil {
		t.Fatal("expected invalid cacheMode to be rejected")
	}

	created, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-good",
		Name:     "Good",
		Adapter:  "generic-http",
		BaseURL:  "https://example.com",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-1",
		Models: []domain.ModelConfig{{
			ID:        "m1",
			Name:      "M1",
			APIFormat: "openai-completions",
			Compat:    domain.CompatConfig{CacheMode: "explicit"},
		}},
	})
	if err != nil {
		t.Fatalf("create provider with explicit cacheMode: %v", err)
	}
	got, err := provSvc.Get(ctx, created.ID)
	if err != nil || got.Models[0].Compat.CacheMode != domain.CacheModeExplicit {
		t.Fatalf("expected persisted cacheMode explicit, got %+v err=%v", got, err)
	}

	// Updating display name while keeping cacheMode auto overrides default cleanly.
	updated, err := provSvc.Update(ctx, created.ID, ProviderInput{
		Models: []domain.ModelConfig{{
			ID:        "m1",
			Name:      "M1 Renamed",
			APIFormat: "openai-completions",
			Compat:    domain.CompatConfig{CacheMode: domain.CacheModeAuto},
		}},
	})
	if err != nil || updated.Models[0].Compat.CacheMode != domain.CacheModeAuto {
		t.Fatalf("expected updated cacheMode auto, got %+v err=%v", updated, err)
	}
}

func TestPromptCachePlannerExecutionOrderReuseScopeAndCancel(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	formats := plugin.NewFormatRegistry()
	fakeFmt := &fakePlannerFormat{id: "fake-planner", createPath: "/v1/cache"}
	formats.MustRegister(fakeFmt)
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provSvc := NewProviderService(provStore, formats, adapters)
	convSvc := NewConversationService(convStore, msgStore)
	chatSvc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithPreferences(NewPreferenceService(store.NewPreferenceStore(db)))

	var sequence []string
	var createHits atomic.Int32
	var mainHits atomic.Int32
	blockCreate := make(chan struct{})
	releaseCreate := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/cache":
			n := createHits.Add(1)
			sequence = append(sequence, fmt.Sprintf("create:%s", r.Header.Get("Authorization")))
			if r.Header.Get("X-Block") == "1" {
				close(blockCreate)
				select {
				case <-r.Context().Done():
					return
				case <-releaseCreate:
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":       fmt.Sprintf("caches/c-%d", n),
				"expireTime": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
			})
		case "/v1/generate":
			mainHits.Add(1)
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			ref, _ := body["cachedContent"].(string)
			sequence = append(sequence, fmt.Sprintf("main:%s", ref))
			_, _ = fmt.Fprintf(w, "ok:%s", ref)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	prov, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p1",
		Name:     "Fake",
		Adapter:  "generic-http",
		BaseURL:  srv.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-key-1",
		Models: []domain.ModelConfig{{
			ID:        "m1",
			Name:      "M1",
			APIFormat: "fake-planner",
		}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	conv, err := convSvc.Create(ctx, CreateConversationInput{
		ProviderID: prov.ID,
		ModelID:    "m1",
	})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}

	// 1. Gateway preference off: the planner is consulted but plans nothing, so a
	// single uncached main request is sent.
	prepOff, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "turn 0",
	})
	if err != nil {
		t.Fatalf("Prepare off: %v", err)
	}
	if err := prepOff.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream off: %v", err)
	}
	if createHits.Load() != 0 || mainHits.Load() != 1 {
		t.Fatalf("unexpected hits when the cache preference is off: create=%d main=%d", createHits.Load(), mainHits.Load())
	}

	// 2. Gateway preference on: executes create before main, then reuses cached ref on next turn.
	setAutoCache(t, chatSvc, true)
	prep1, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "turn 1",
	})
	if err != nil {
		t.Fatalf("Prepare 1: %v", err)
	}
	if err := prep1.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream 1: %v", err)
	}
	prep2, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "turn 2",
	})
	if err != nil {
		t.Fatalf("Prepare 2: %v", err)
	}
	if err := prep2.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream 2: %v", err)
	}
	if createHits.Load() != 1 || mainHits.Load() != 3 {
		t.Fatalf("expected 1 create and 3 main hits across reuse, got create=%d main=%d", createHits.Load(), mainHits.Load())
	}
	if len(sequence) != 4 || sequence[1] != "create:Bearer sk-key-1" || sequence[2] != "main:caches/c-1" || sequence[3] != "main:caches/c-1" {
		t.Fatalf("unexpected execution sequence: %v", sequence)
	}

	// 3. Key change isolates scope -> cannot reuse old cache ref.
	_, err = provSvc.Update(ctx, prov.ID, ProviderInput{APIKey: "sk-key-2"})
	if err != nil {
		t.Fatalf("update api key: %v", err)
	}
	prep3, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "turn 3",
	})
	if err != nil {
		t.Fatalf("Prepare 3: %v", err)
	}
	if err := prep3.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream 3: %v", err)
	}
	if createHits.Load() != 2 {
		t.Fatalf("expected key rotation to create new scoped cache, got create=%d", createHits.Load())
	}

	// 4. Context cancel during cache creation aborts before main request and leaves no new user message.
	_, err = provSvc.Update(ctx, prov.ID, ProviderInput{
		APIKey:  "sk-key-3",
		Headers: map[string]string{"X-Block": "1"},
	})
	if err != nil {
		t.Fatalf("update headers: %v", err)
	}
	beforeMsgs, _ := msgStore.ListByConversation(ctx, conv.ID)
	mainBefore := mainHits.Load()

	cancelCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan error, 1)
	go func() {
		_, pErr := chatSvc.Prepare(cancelCtx, StreamChatInput{
			ConversationID: conv.ID,
			Text:           "canceled turn",
		})
		doneCh <- pErr
	}()
	<-blockCreate
	cancel()
	if pErr := <-doneCh; pErr == nil {
		close(releaseCreate)
		t.Fatal("expected canceled Prepare to fail")
	}
	close(releaseCreate)
	if mainHits.Load() != mainBefore {
		t.Fatalf("main request must not fire after cache create cancel: before=%d after=%d", mainBefore, mainHits.Load())
	}
	afterMsgs, _ := msgStore.ListByConversation(ctx, conv.ID)
	if len(afterMsgs) != len(beforeMsgs) {
		t.Fatalf("user message must not persist when cache create cancels: %d vs %d", len(beforeMsgs), len(afterMsgs))
	}
}

func TestOpenAIExplicitFromPersistedModelAndSingleFallback(t *testing.T) {
	ctx := context.Background()
	provSvc, _, convSvc, _, chatSvc, _ := setupServiceTestEnv(t)
	setAutoCache(t, chatSvc, true)

	var seenBodies []map[string]any
	var rejectNext atomic.Bool
	rejectNext.Store(true)
	var statusToReturn atomic.Int32
	statusToReturn.Store(http.StatusBadRequest)
	var errPayload atomic.Value
	errPayload.Store(`{"error":{"message":"unknown field prompt_cache_options"}}`)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		seenBodies = append(seenBodies, body)

		if rejectNext.Load() {
			w.WriteHeader(int(statusToReturn.Load()))
			_, _ = io.WriteString(w, errPayload.Load().(string))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()

	prov, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-oai-exp",
		Name:     "OpenAI Explicit",
		Adapter:  "generic-http",
		BaseURL:  srv.URL + "/v1",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-1",
		Models: []domain.ModelConfig{{
			ID:        "gpt-5.6",
			Name:      "GPT-5.6",
			APIFormat: "openai-completions",
			Compat:    domain.CompatConfig{CacheMode: domain.CacheModeExplicit},
		}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	conv, err := convSvc.Create(ctx, CreateConversationInput{
		ProviderID: prov.ID,
		ModelID:    "gpt-5.6",
	})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}

	// Upstream rejects prompt_cache_options once -> falls back once without cache fields and remembers negative capability.
	rejectNext.Store(false)
	// First, intercept attempt 1 by overriding handler behavior via rejectOnce:
	var calls int
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		seenBodies = append(seenBodies, body)
		if calls == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"unknown field prompt_cache_options"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv2.Close()

	_, err = provSvc.Update(ctx, prov.ID, ProviderInput{BaseURL: srv2.URL + "/v1"})
	if err != nil {
		t.Fatalf("update baseURL: %v", err)
	}
	seenBodies = nil

	prep, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "turn 1",
	})
	if err != nil {
		t.Fatalf("Prepare fallback failed: %v", err)
	}
	if err := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream fallback failed: %v", err)
	}
	if len(seenBodies) != 2 {
		t.Fatalf("expected 2 requests (explicit attempt + 1 fallback), got %d", len(seenBodies))
	}
	if seenBodies[0]["prompt_cache_options"] == nil || seenBodies[1]["prompt_cache_options"] != nil {
		t.Fatalf("expected explicit cache options only on first attempt: %+v", seenBodies)
	}

	// Second turn remembers negative capability for this scope -> does not re-send prompt_cache_options.
	prep2, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "turn 2",
	})
	if err != nil {
		t.Fatalf("Prepare turn 2 failed: %v", err)
	}
	if err := prep2.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("Stream turn 2 failed: %v", err)
	}
	if len(seenBodies) != 3 || seenBodies[2]["prompt_cache_options"] != nil {
		t.Fatalf("expected remembered negative capability on turn 2: %+v", seenBodies)
	}

	// Non-cache 400 / 401 / 429 must NOT be swallowed as cache errors.
	provErr, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-err",
		Name:     "ErrProv",
		Adapter:  "generic-http",
		BaseURL:  srv.URL + "/v1",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-1",
		Models: []domain.ModelConfig{{
			ID:        "gpt-5.6",
			Name:      "GPT-5.6",
			APIFormat: "openai-completions",
			Compat:    domain.CompatConfig{CacheMode: domain.CacheModeExplicit},
		}},
	})
	if err != nil {
		t.Fatalf("create err prov: %v", err)
	}
	convErr, err := convSvc.Create(ctx, CreateConversationInput{ProviderID: provErr.ID, ModelID: "gpt-5.6"})
	if err != nil {
		t.Fatalf("create err conv: %v", err)
	}
	rejectNext.Store(true)
	for _, tc := range []struct {
		code int
		body string
	}{
		{http.StatusBadRequest, `{"error":{"message":"temperature must be <= 2"}}`},
		{http.StatusUnauthorized, `{"error":{"message":"invalid api key"}}`},
		{http.StatusTooManyRequests, `{"error":{"message":"rate limit exceeded"}}`},
	} {
		seenBodies = nil
		statusToReturn.Store(int32(tc.code))
		errPayload.Store(tc.body)
		if _, pErr := chatSvc.Prepare(ctx, StreamChatInput{
			ConversationID: convErr.ID,
			Text:           "fail",
		}); pErr == nil {
			t.Fatalf("expected HTTP %d to fail visibly without fallback", tc.code)
		}
		if len(seenBodies) != 1 {
			t.Fatalf("HTTP %d must not retry as cache error, got %d requests", tc.code, len(seenBodies))
		}
	}
}

func TestGeminiExplicitCachingLifecycleReuseExpiryEditSmallPrefixAndPathOverride(t *testing.T) {
	ctx := context.Background()
	provSvc, _, convSvc, _, chatSvc, msgStore := setupServiceTestEnv(t)
	setAutoCache(t, chatSvc, true)

	var (
		createCount    atomic.Int32
		generateCount  atomic.Int32
		createStatus   atomic.Int32
		createErrBody  atomic.Value
		nextExpire     atomic.Value
		expireFirstGen atomic.Bool
		lastAuthHeader atomic.Value
		lastCustomHdr  atomic.Value
		reconstructed  []string
		cachedStore    = make(map[string]map[string]any)
	)
	createStatus.Store(http.StatusOK)
	createErrBody.Store("")
	nextExpire.Store(time.Now().Add(10 * time.Minute).UTC())

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastAuthHeader.Store(r.URL.Query().Get("key"))
		lastCustomHdr.Store(r.Header.Get("X-Gemini-Custom"))

		switch r.URL.Path {
		case "/proxy/v1beta/cachedContents":
			n := createCount.Add(1)
			if st := int(createStatus.Load()); st != http.StatusOK {
				w.WriteHeader(st)
				_, _ = io.WriteString(w, createErrBody.Load().(string))
				return
			}
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			name := fmt.Sprintf("cachedContents/g-%d", n)
			cachedStore[name] = body
			exp := nextExpire.Load().(time.Time)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":       name,
				"expireTime": exp.Format(time.RFC3339Nano),
			})
		case "/proxy/v1beta/models/gemini-2.5-pro:customGenerate":
			g := generateCount.Add(1)
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)

			if expireFirstGen.Swap(false) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"error":{"message":"CachedContent not found or expired"}}`)
				return
			}

			var promptParts []string
			if ref, ok := body["cachedContent"].(string); ok && ref != "" {
				if _, hasSys := body["systemInstruction"]; hasSys {
					t.Fatalf("streamGenerateContent must omit systemInstruction when cachedContent=%q", ref)
				}
				if _, hasTools := body["tools"]; hasTools {
					t.Fatalf("streamGenerateContent must omit tools when cachedContent=%q", ref)
				}
				cached := cachedStore[ref]
				if sys, ok := cached["systemInstruction"].(map[string]any); ok {
					promptParts = append(promptParts, "SYS:"+sys["parts"].([]any)[0].(map[string]any)["text"].(string))
				}
				if pContents, ok := cached["contents"].([]any); ok {
					for _, c := range pContents {
						promptParts = append(promptParts, "C:"+c.(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string))
					}
				}
			} else if sys, ok := body["systemInstruction"].(map[string]any); ok {
				promptParts = append(promptParts, "SYS:"+sys["parts"].([]any)[0].(map[string]any)["text"].(string))
			}
			for _, c := range body["contents"].([]any) {
				promptParts = append(promptParts, "S:"+c.(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string))
			}
			reconstructed = append(reconstructed, strings.Join(promptParts, "|"))

			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"reply-%d\"}]},\"finishReason\":\"STOP\"}]}\n\n", g)
		default:
			t.Fatalf("unexpected path hit: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	prov, err := provSvc.Create(ctx, ProviderInput{
		ID:       "p-gem",
		Name:     "Gemini Proxy",
		Adapter:  "generic-http",
		BaseURL:  srv.URL + "/proxy/v1beta",
		AuthType: domain.AuthTypeQueryKey,
		APIKey:   "gem-secret",
		Headers:  map[string]string{"X-Gemini-Custom": "hdr-val"},
		Models: []domain.ModelConfig{{
			ID:        "gemini-2.5-pro",
			Name:      "Gemini 2.5 Pro",
			APIFormat: "google-generative-ai",
			Compat: domain.CompatConfig{
				PathOverride: "/v1beta/models/{model}:customGenerate",
			},
		}},
	})
	if err != nil {
		t.Fatalf("create gem prov: %v", err)
	}
	conv, err := convSvc.Create(ctx, CreateConversationInput{
		ProviderID:   prov.ID,
		ModelID:      "gemini-2.5-pro",
		SystemPrompt: "SysPrompt",
	})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}

	runTurn := func(text string) {
		t.Helper()
		prep, pErr := chatSvc.Prepare(ctx, StreamChatInput{
			ConversationID: conv.ID,
			Text:           text,
		})
		if pErr != nil {
			t.Fatalf("Prepare(%q) failed: %v", text, pErr)
		}
		if sErr := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); sErr != nil {
			t.Fatalf("Stream(%q) failed: %v", text, sErr)
		}
	}

	// 1. Create -> reuse -> reuse (3 turns, ONLY 1 cachedContents create!).
	runTurn("u1")
	runTurn("u2")
	runTurn("u3")
	if createCount.Load() != 1 || generateCount.Load() != 3 {
		t.Fatalf("expected 1 create and 3 generates, got create=%d gen=%d", createCount.Load(), generateCount.Load())
	}
	if lastAuthHeader.Load() != "gem-secret" || lastCustomHdr.Load() != "hdr-val" {
		t.Fatalf("custom headers or query-key lost: key=%v hdr=%v", lastAuthHeader.Load(), lastCustomHdr.Load())
	}
	if len(reconstructed) != 3 || reconstructed[2] != "SYS:SysPrompt|S:u1|S:reply-1|S:u2|S:reply-2|S:u3" {
		t.Fatalf("prompt reconstruction mismatch: %+v", reconstructed)
	}

	// 2. Upstream reports expired cache on main request -> invalidates & replans ONCE cleanly.
	expireFirstGen.Store(true)
	runTurn("u4")
	if createCount.Load() != 2 {
		t.Fatalf("expected 1 replan create after expired 404, got create=%d", createCount.Load())
	}

	// 3. Edit prefix message -> invalidates & recreates cache (doesn't reuse g-2).
	msgs, _ := msgStore.ListByConversation(ctx, conv.ID)
	msgs[0].Blocks = []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1-edited"}}
	if _, uErr := msgStore.UpdateBlocks(ctx, conv.ID, msgs[0].ID, msgs[0].Blocks); uErr != nil {
		t.Fatalf("UpdateBlocks: %v", uErr)
	}
	runTurn("u5")
	if createCount.Load() != 3 {
		t.Fatalf("expected prefix edit to trigger fresh create, got create=%d", createCount.Load())
	}

	// 4. Local expireTime expiration triggers automatic rebuild on next turn.
	provExp, _ := provSvc.Create(ctx, ProviderInput{
		ID:       "p-gem-exp",
		Name:     "GemExp",
		Adapter:  "generic-http",
		BaseURL:  srv.URL + "/proxy/v1beta",
		AuthType: domain.AuthTypeQueryKey,
		APIKey:   "gem-exp",
		Models: []domain.ModelConfig{{
			ID:        "gemini-2.5-pro",
			Name:      "GemExp",
			APIFormat: "google-generative-ai",
			Compat:    domain.CompatConfig{PathOverride: "/v1beta/models/{model}:customGenerate"},
		}},
	})
	convExp, _ := convSvc.Create(ctx, CreateConversationInput{ProviderID: provExp.ID, ModelID: "gemini-2.5-pro", SystemPrompt: "SysExp"})
	nextExpire.Store(time.Now().Add(40 * time.Millisecond).UTC())
	cBefore := createCount.Load()
	pExp1, err := chatSvc.Prepare(ctx, StreamChatInput{ConversationID: convExp.ID, Text: "e1"})
	if err != nil {
		t.Fatalf("Prepare exp1: %v", err)
	}
	_ = pExp1.Stream(ctx, func(domain.StreamEvent) error { return nil })
	time.Sleep(60 * time.Millisecond)
	nextExpire.Store(time.Now().Add(5 * time.Minute).UTC())
	pExp2, err := chatSvc.Prepare(ctx, StreamChatInput{ConversationID: convExp.ID, Text: "e2"})
	if err != nil {
		t.Fatalf("Prepare exp2: %v", err)
	}
	_ = pExp2.Stream(ctx, func(domain.StreamEvent) error { return nil })
	if createCount.Load() != cBefore+2 {
		t.Fatalf("expected expired expireTime to trigger rebuild (2 creates), got %d", createCount.Load()-cBefore)
	}

	// 5. Small-prefix failure degrades cleanly without blocking generation.
	convSmall, _ := convSvc.Create(ctx, CreateConversationInput{
		ProviderID:   prov.ID,
		ModelID:      "gemini-2.5-pro",
		SystemPrompt: "Tiny",
	})
	createStatus.Store(http.StatusBadRequest)
	createErrBody.Store(`{"error":{"message":"CachedContent token count 10 is too small; minimum is 1024"}}`)
	prepSmall, err := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: convSmall.ID,
		Text:           "hi",
	})
	if err != nil {
		t.Fatalf("small prefix should degrade cleanly, got err=%v", err)
	}
	if err := prepSmall.Stream(ctx, func(domain.StreamEvent) error { return nil }); err != nil {
		t.Fatalf("small prefix stream: %v", err)
	}
	// Auth 401 on cachedContents must fail visibly (not degrade).
	provAuth, _ := provSvc.Create(ctx, ProviderInput{
		ID:       "p-gem-auth",
		Name:     "GemAuth",
		Adapter:  "generic-http",
		BaseURL:  srv.URL + "/proxy/v1beta",
		AuthType: domain.AuthTypeQueryKey,
		APIKey:   "bad",
		Models:   []domain.ModelConfig{{ID: "gemini-2.5-pro", Name: "Gem", APIFormat: "google-generative-ai"}},
	})
	convAuth, _ := convSvc.Create(ctx, CreateConversationInput{ProviderID: provAuth.ID, ModelID: "gemini-2.5-pro", SystemPrompt: "Sys"})
	createStatus.Store(http.StatusUnauthorized)
	createErrBody.Store(`{"error":{"message":"API key not valid"}}`)
	if _, aErr := chatSvc.Prepare(ctx, StreamChatInput{
		ConversationID: convAuth.ID,
		Text:           "hi",
	}); aErr == nil {
		t.Fatal("expected 401 on cachedContents to return visible error")
	}
}

type countingStubSearchEngine struct {
	hits *atomic.Int32
}

func (e countingStubSearchEngine) ID() string              { return "tavily" }
func (e countingStubSearchEngine) DisplayName() string     { return "Counting Tavily" }
func (e countingStubSearchEngine) DefaultEndpoint() string { return "https://search.example" }
func (e countingStubSearchEngine) RequiresAPIKey() bool    { return false }
func (e countingStubSearchEngine) Search(_ context.Context, in plugin.SearchQueryInput) ([]plugin.SearchResult, error) {
	n := e.hits.Add(1)
	return []plugin.SearchResult{{
		Title:   fmt.Sprintf("Result %d", n),
		URL:     "https://docs.example",
		Snippet: "Query=" + in.Query,
	}}, nil
}

func TestStatelessPrepareLocalCacheContinuationAndSearchReuse(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	assistStore := store.NewAssistantStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	searchStore := store.NewSearchConfigStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewGoogleGenAIFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	var searchHits atomic.Int32
	searchReg := plugin.NewSearchRegistry()
	searchReg.MustRegister(countingStubSearchEngine{hits: &searchHits})
	if _, err := searchStore.Upsert(ctx, domain.SearchEngineConfig{
		EngineID:   "tavily",
		Enabled:    true,
		Endpoint:   "https://search.example",
		MaxResults: 3,
		IsDefault:  true,
	}); err != nil {
		t.Fatalf("upsert search config: %v", err)
	}

	provSvc := NewProviderService(provStore, formats, adapters)
	convSvc := NewConversationService(convStore, msgStore).WithAssistants(assistStore)

	// Two completely independent ChatService instances (no shared memory snapshot!).
	prefStore := store.NewPreferenceStore(db)
	chatSvcA := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithAssistants(assistStore).
		WithSearch(searchReg, searchStore).
		WithPreferences(NewPreferenceService(prefStore))
	chatSvcB := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithAssistants(assistStore).
		WithSearch(searchReg, searchStore).
		WithPreferences(NewPreferenceService(prefStore))
	setAutoCache(t, chatSvcA, true)
	setAutoCache(t, chatSvcB, true)

	prov, err := provSvc.Create(ctx, ProviderInput{
		ID:           "p-loc-gem",
		Name:         "Local Gemini",
		Adapter:      "generic-http",
		BaseURL:      "http://127.0.0.1:9999/v1beta",
		AuthType:     domain.AuthTypeQueryKey,
		LocalRequest: domain.BoolPtr(true),
		Models: []domain.ModelConfig{{
			ID:        "gemini-2.5-pro",
			Name:      "Gemini 2.5 Pro",
			APIFormat: "google-generative-ai",
		}},
	})
	if err != nil {
		t.Fatalf("create local gemini prov: %v", err)
	}
	conv, err := convSvc.Create(ctx, CreateConversationInput{
		ProviderID:   prov.ID,
		ModelID:      "gemini-2.5-pro",
		SystemPrompt: "BaseSys",
	})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}

	// 1. Instance A runs initial PrepareLocal -> runs webSearch ONCE, returns CacheStep + fallback main request, saves ZERO messages.
	prep1, err := chatSvcA.PrepareLocal(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "first local query",
		WebSearch:      true,
	})
	if err != nil {
		t.Fatalf("PrepareLocal 1: %v", err)
	}
	if searchHits.Load() != 1 {
		t.Fatalf("expected exactly 1 web search, got %d", searchHits.Load())
	}
	if prep1.CacheStep == nil || !strings.HasSuffix(prep1.CacheStep.Request.URL, "/v1beta/cachedContents") {
		t.Fatalf("expected CacheStep targeting /v1beta/cachedContents, got %+v", prep1.CacheStep)
	}
	if prep1.WebSearchBlock == nil || strings.Contains(prep1.CacheStep.Request.URL, "key=") || strings.Contains(prep1.URL, "key=") {
		t.Fatalf("missing webSearchBlock or leaked query key in PrepareLocal output: %+v", prep1)
	}
	if msgsAfterPrep1, _ := msgStore.ListByConversation(ctx, conv.ID); len(msgsAfterPrep1) != 0 {
		t.Fatalf("PrepareLocal must not prematurely persist user message, got %d", len(msgsAfterPrep1))
	}

	// 2. Instance B resolves cacheResolution + preparedSearch -> NO second search, encodes cachedContent + identical searchPrompt!
	prep2, err := chatSvcB.PrepareLocal(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "first local query",
		WebSearch:      true,
		PreparedSearch: &PreparedSearchInput{Block: prep1.WebSearchBlock},
		CacheResolution: &LocalCacheResolutionInput{
			PlanKey: prep1.CacheStep.PlanKey,
			Status:  http.StatusOK,
			Result: LocalCacheResultData{
				Name:       "cachedContents/local-1",
				ExpireTime: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
			},
		},
	})
	if err != nil {
		t.Fatalf("PrepareLocal 2: %v", err)
	}
	if searchHits.Load() != 1 {
		t.Fatalf("PrepareLocal continuation must reuse preparedSearch without re-searching, hits=%d", searchHits.Load())
	}
	if prep2.CacheStep != nil || prep2.CacheState == nil || prep2.CacheState.ResourceName != "cachedContents/local-1" {
		t.Fatalf("expected resolved CacheState without new CacheStep: %+v", prep2)
	}
	var mainBody map[string]any
	_ = json.Unmarshal(prep2.Body, &mainBody)
	if mainBody["cachedContent"] != "cachedContents/local-1" {
		t.Fatalf("expected cachedContent in resolved main request: %+v", mainBody)
	}
	var createBody map[string]any
	_ = json.Unmarshal(prep1.CacheStep.Request.Body, &createBody)
	sysText := createBody["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(sysText, "BaseSys") || strings.Contains(sysText, "Query=first local query") {
		t.Fatalf("expected the reusable system prompt to stay search-free, got %q", sysText)
	}
	// The search projection belongs to the current user turn of the main request.
	if !strings.Contains(string(prep1.Body), "Query=first local query") {
		t.Fatalf("expected the search projection in the current user turn: %s", string(prep1.Body))
	}

	// 3. A stale PlanKey discards the reported creation result, never starts a
	// second create from the same request, and falls back to the gateway-owned
	// resource instead of dropping to an uncached request.
	prepMismatch, err := chatSvcB.PrepareLocal(ctx, StreamChatInput{
		ConversationID: conv.ID,
		Text:           "changed query mid-flight",
		WebSearch:      true,
		PreparedSearch: &PreparedSearchInput{Block: nil}, // empty/nil preparedSearch must NOT trigger second search!
		CacheResolution: &LocalCacheResolutionInput{
			PlanKey: "stale-plan-key",
			Status:  http.StatusOK,
			Result:  LocalCacheResultData{Name: "cachedContents/local-1"},
		},
	})
	if err != nil {
		t.Fatalf("PrepareLocal mismatch: %v", err)
	}
	if searchHits.Load() != 1 {
		t.Fatalf("nil preparedSearch.block must still skip second search, hits=%d", searchHits.Load())
	}
	if prepMismatch.CacheStep != nil {
		t.Fatalf("planKey mismatch must not start another create: %+v", prepMismatch)
	}
	if prepMismatch.CacheState == nil || prepMismatch.CacheState.ResourceName != "cachedContents/local-1" {
		t.Fatalf("planKey mismatch must fall back to the gateway-owned resource: %+v", prepMismatch)
	}
	var mismatchBody map[string]any
	_ = json.Unmarshal(prepMismatch.Body, &mismatchBody)
	if mismatchBody["cachedContent"] != "cachedContents/local-1" {
		t.Fatalf("expected the gateway-owned resource on the fallback request: %+v", mismatchBody)
	}

	// 4. Saved user message + tool continuation reuses CacheState without extra search or create.
	savedUser, err := msgStore.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "first local query"}},
		CreatedAt:      time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("create user msg: %v", err)
	}
	prepToolCont, err := chatSvcB.PrepareLocal(ctx, StreamChatInput{
		ConversationID: conv.ID,
		WebSearch:      true,
		PreparedSearch: &PreparedSearchInput{Block: prep1.WebSearchBlock},
		CacheState:     prep2.CacheState,
		LocalContinuation: &LocalContinuationInput{
			UserMessageID: savedUser.ID,
			Blocks: []domain.ContentBlock{
				{Type: domain.BlockTypeToolCall, ID: "tc1", Name: "calc", Arguments: json.RawMessage(`{}`)},
				{Type: domain.BlockTypeToolResult, ToolCallID: "tc1", ToolName: "calc", Content: "7"},
			},
		},
	})
	if err != nil {
		t.Fatalf("PrepareLocal tool continuation: %v", err)
	}
	if searchHits.Load() != 1 || prepToolCont.CacheStep != nil {
		t.Fatalf("tool continuation must reuse search and cacheState: hits=%d step=%+v", searchHits.Load(), prepToolCont.CacheStep)
	}
	var contBody map[string]any
	_ = json.Unmarshal(prepToolCont.Body, &contBody)
	if contBody["cachedContent"] != "cachedContents/local-1" {
		t.Fatalf("expected cachedContent on tool continuation: %+v", contBody)
	}
}

type captureUpstreamTransport struct {
	mu     sync.Mutex
	urls   []string
	bodies []map[string]any
}

func (t *captureUpstreamTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	raw, _ := io.ReadAll(req.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	t.mu.Lock()
	t.urls = append(t.urls, req.URL.String())
	t.bodies = append(t.bodies, body)
	t.mu.Unlock()
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")),
		Request:    req,
	}, nil
}

func (t *captureUpstreamTransport) lastBody() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.bodies) == 0 {
		return nil
	}
	return t.bodies[len(t.bodies)-1]
}

// TestOfficialOpenAICacheFieldsFollowResolvedTarget proves the cache fields are
// chosen from the URL the adapter actually resolves for both request paths.
func TestOfficialOpenAICacheFieldsFollowResolvedTarget(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	transport := &captureUpstreamTransport{}
	chatSvc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{Transport: transport}).
		WithPreferences(NewPreferenceService(store.NewPreferenceStore(db)))
	setAutoCache(t, chatSvc, true)
	provSvc := NewProviderService(provStore, formats, adapters)

	official, err := provSvc.Create(ctx, ProviderInput{
		ID: "p-official", Name: "Official", Adapter: "generic-http",
		BaseURL: "https://api.openai.com/v1", AuthType: domain.AuthTypeBearer, APIKey: "sk-1",
		Models: []domain.ModelConfig{{ID: "gpt-4.1", Name: "GPT", APIFormat: "openai-completions"}},
	})
	if err != nil {
		t.Fatalf("create official provider: %v", err)
	}
	proxy, err := provSvc.Create(ctx, ProviderInput{
		ID: "p-proxy", Name: "Proxy", Adapter: "generic-http",
		BaseURL: "https://proxy.example/v1", AuthType: domain.AuthTypeBearer, APIKey: "sk-2",
		Models: []domain.ModelConfig{
			{ID: "gpt-auto", Name: "Auto", APIFormat: "openai-completions"},
			{ID: "gpt-explicit", Name: "Explicit", APIFormat: "openai-completions", Compat: domain.CompatConfig{CacheMode: domain.CacheModeExplicit}},
		},
	})
	if err != nil {
		t.Fatalf("create proxy provider: %v", err)
	}

	convOfficial, _ := convStore.Create(ctx, domain.Conversation{ProviderID: official.ID, ModelID: "gpt-4.1", AssistantID: domain.DefaultAssistantID})
	runTurn := func(convID string) {
		t.Helper()
		prep, pErr := chatSvc.Prepare(ctx, StreamChatInput{ConversationID: convID, Text: "hello"})
		if pErr != nil {
			t.Fatalf("Prepare: %v", pErr)
		}
		if sErr := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); sErr != nil {
			t.Fatalf("Stream: %v", sErr)
		}
	}

	runTurn(convOfficial.ID)
	body := transport.lastBody()
	if body["prompt_cache_key"] == nil || body["prompt_cache_options"] != nil {
		t.Fatalf("official endpoint must use only prompt_cache_key, got %+v", body)
	}
	if !strings.HasPrefix(transport.urls[len(transport.urls)-1], "https://api.openai.com/v1/chat/completions") {
		t.Fatalf("unexpected resolved URL %q", transport.urls[len(transport.urls)-1])
	}

	convProxyAuto, _ := convStore.Create(ctx, domain.Conversation{ProviderID: proxy.ID, ModelID: "gpt-auto", AssistantID: domain.DefaultAssistantID})
	runTurn(convProxyAuto.ID)
	if body = transport.lastBody(); body["prompt_cache_key"] != nil || body["prompt_cache_options"] != nil {
		t.Fatalf("auto mode on a compatibility endpoint must add no fields, got %+v", body)
	}

	convProxyExplicit, _ := convStore.Create(ctx, domain.Conversation{ProviderID: proxy.ID, ModelID: "gpt-explicit", AssistantID: domain.DefaultAssistantID})
	runTurn(convProxyExplicit.ID)
	if body = transport.lastBody(); body["prompt_cache_options"] == nil || body["prompt_cache_key"] != nil {
		t.Fatalf("explicit mode on a compatibility endpoint must use the compat extension, got %+v", body)
	}

	local, err := provSvc.Create(ctx, ProviderInput{
		ID: "p-local", Name: "Local", Adapter: "generic-http",
		BaseURL: "https://api.openai.com/v1", AuthType: domain.AuthTypeNone,
		LocalRequest: domain.BoolPtr(true),
		Models:       []domain.ModelConfig{{ID: "gpt-4.1", Name: "GPT", APIFormat: "openai-completions"}},
	})
	if err != nil {
		t.Fatalf("create local provider: %v", err)
	}
	convLocal, _ := convStore.Create(ctx, domain.Conversation{ProviderID: local.ID, ModelID: "gpt-4.1", AssistantID: domain.DefaultAssistantID})
	prepared, err := chatSvc.PrepareLocal(ctx, StreamChatInput{ConversationID: convLocal.ID, Text: "hello"})
	if err != nil {
		t.Fatalf("PrepareLocal: %v", err)
	}
	var localBody map[string]any
	_ = json.Unmarshal(prepared.Body, &localBody)
	if localBody["prompt_cache_key"] == nil || localBody["prompt_cache_options"] != nil {
		t.Fatalf("local path must use the same official route key, got %+v", localBody)
	}
}

func TestPromptCacheStoreScopingNegativesAndBound(t *testing.T) {
	cache := newPromptCacheStore(4)
	scope := func(topic string) plugin.PromptCacheScope {
		return plugin.PromptCacheScope{ProviderID: "p", TopicID: topic, FormatID: "f", ModelID: "m"}
	}
	// A negative marker never replaces a valid resource.
	cache.Set(scope("a"), plugin.PromptCacheState{ResourceName: "r-a", ExpireTime: time.Now().Add(time.Minute)})
	cache.Set(scope("a"), plugin.PromptCacheState{FailedPrefixHash: "cand-1"})
	if got := cache.Get(scope("a")); got == nil || got.ResourceName != "r-a" || got.FailedPrefixHash != "" || got.Unsupported {
		t.Fatalf("resource must survive negative markers, got %+v", got)
	}
	// Without a resource the marker is visible, scoped and time bounded.
	cache.Set(scope("b"), plugin.PromptCacheState{Unsupported: true})
	if got := cache.Get(scope("b")); got == nil || !got.Unsupported {
		t.Fatalf("expected unsupported marker, got %+v", got)
	}
	if got := cache.Get(scope("c")); got != nil {
		t.Fatalf("topics must not share state, got %+v", got)
	}

	// Capacity stays bounded no matter how many scopes appear.
	for i := 0; i < 20; i++ {
		cache.Set(scope(fmt.Sprintf("t%d", i)), plugin.PromptCacheState{
			ResourceName: fmt.Sprintf("r-%d", i),
			ExpireTime:   time.Now().Add(time.Minute),
		})
	}
	if len(cache.entries) > 4 {
		t.Fatalf("expected at most 4 entries, got %d", len(cache.entries))
	}

	// Concurrent callers share one candidate creation result.
	claim := cache.ClaimCreate(scope("x"), "candidate", 0)
	if !claim.leader {
		t.Fatal("first claim must lead")
	}
	waiter := cache.ClaimCreate(scope("x"), "candidate", 0)
	if waiter.leader || waiter.blocked || waiter.wait == nil {
		t.Fatalf("second claim for the same candidate must wait, got %+v", waiter)
	}
	cache.FinishCreate(scope("x"), "candidate", &plugin.PromptCacheState{ResourceName: "r-x"})
	shared, ok := waiter.wait(context.Background())
	if !ok || shared == nil || shared.ResourceName != "r-x" {
		t.Fatalf("waiter must observe the shared result, got %+v ok=%v", shared, ok)
	}

	// A different candidate while one is in flight is turned away uncached.
	if claim = cache.ClaimCreate(scope("y"), "candidate-1", 0); !claim.leader {
		t.Fatal("first candidate must lead")
	}
	if other := cache.ClaimCreate(scope("y"), "candidate-2", 0); !other.blocked {
		t.Fatalf("a different candidate must not join the flight, got %+v", other)
	}

	// A browser-executed create that never reports back expires.
	if claim = cache.ClaimCreate(scope("z"), "candidate", time.Millisecond); !claim.leader {
		t.Fatal("first pending create must lead")
	}
	time.Sleep(5 * time.Millisecond)
	if again := cache.ClaimCreate(scope("z"), "candidate", 0); !again.leader {
		t.Fatalf("expired pending create must be released, got %+v", again)
	}
}

func TestGeminiCacheTopicIsolationAcrossAlternatingConversations(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewGoogleGenAIFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	var creates atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ":streamGenerateContent"):
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, `data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}`+"\n\n")
		case strings.HasSuffix(r.URL.Path, "/cachedContents"):
			n := creates.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":       fmt.Sprintf("cachedContents/c-%d", n),
				"expireTime": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	provSvc := NewProviderService(provStore, formats, adapters)
	chatSvc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithPreferences(NewPreferenceService(store.NewPreferenceStore(db)))
	setAutoCache(t, chatSvc, true)

	prov, err := provSvc.Create(ctx, ProviderInput{
		ID: "p-topics", Name: "Topics", Adapter: "generic-http",
		BaseURL: srv.URL + "/v1beta", AuthType: domain.AuthTypeQueryKey, APIKey: "gk",
		Models: []domain.ModelConfig{{ID: "gemini-2.5-pro", Name: "Gemini", APIFormat: "google-generative-ai"}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	createConv := func(systemPrompt string) string {
		t.Helper()
		conv, cErr := convStore.Create(ctx, domain.Conversation{
			ProviderID: prov.ID, ModelID: "gemini-2.5-pro", SystemPrompt: systemPrompt, AssistantID: domain.DefaultAssistantID,
		})
		if cErr != nil {
			t.Fatalf("create conversation: %v", cErr)
		}
		return conv.ID
	}
	convA := createConv("System A")
	convB := createConv("System B")
	runTurn := func(convID, text string) {
		t.Helper()
		prep, pErr := chatSvc.Prepare(ctx, StreamChatInput{ConversationID: convID, Text: text})
		if pErr != nil {
			t.Fatalf("Prepare(%s): %v", convID, pErr)
		}
		if sErr := prep.Stream(ctx, func(domain.StreamEvent) error { return nil }); sErr != nil {
			t.Fatalf("Stream(%s): %v", convID, sErr)
		}
	}

	runTurn(convA, "a1")
	if got := creates.Load(); got != 1 {
		t.Fatalf("expected topic A to create once, got %d", got)
	}
	runTurn(convB, "b1")
	if got := creates.Load(); got != 2 {
		t.Fatalf("expected topic B to create its own resource, got %d creates", got)
	}
	runTurn(convA, "a2")
	runTurn(convB, "b2")
	if got := creates.Load(); got != 2 {
		t.Fatalf("alternating topics must keep reusing their own resources, got %d creates", got)
	}

	// A resource the upstream later rejects belongs to its topic only: B's
	// unsupported response must not invalidate A's reusable resource.
	scopeA := buildPromptCacheScope(prov, prov.Models[0], format.FormatIDGoogleGenAI, domain.CompatConfig{}, convA)
	scopeB := buildPromptCacheScope(prov, prov.Models[0], format.FormatIDGoogleGenAI, domain.CompatConfig{}, convB)
	chatSvc.cacheStore.Set(scopeB, plugin.PromptCacheState{Unsupported: true})
	if got := chatSvc.cacheStore.Get(scopeA); got == nil || got.ResourceName == "" {
		t.Fatalf("topic A resource must survive topic B failure, got %+v", got)
	}
	runTurn(convA, "a3")
	if got := creates.Load(); got != 2 {
		t.Fatalf("topic A must keep reusing after topic B failed, got %d creates", got)
	}
}

func TestGeminiCacheConcurrentCandidateCreatesOnce(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewGoogleGenAIFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	var (
		creates       atomic.Int32
		mu            sync.Mutex
		mainBodies    []map[string]any
		releaseCreate = make(chan struct{})
		createStarted = make(chan struct{}, 4)
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ":streamGenerateContent"):
			raw, _ := io.ReadAll(r.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			mu.Lock()
			mainBodies = append(mainBodies, body)
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprint(w, `data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}`+"\n\n")
		case strings.HasSuffix(r.URL.Path, "/cachedContents"):
			creates.Add(1)
			createStarted <- struct{}{}
			<-releaseCreate
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name":       "cachedContents/concurrent-1",
				"expireTime": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	provSvc := NewProviderService(provStore, formats, adapters)
	chatSvc := NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithPreferences(NewPreferenceService(store.NewPreferenceStore(db)))
	setAutoCache(t, chatSvc, true)

	prov, err := provSvc.Create(ctx, ProviderInput{
		ID: "p-conc", Name: "Concurrent", Adapter: "generic-http",
		BaseURL: srv.URL + "/v1beta", AuthType: domain.AuthTypeQueryKey, APIKey: "gk",
		Models: []domain.ModelConfig{{ID: "gemini-2.5-pro", Name: "Gemini", APIFormat: "google-generative-ai"}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	conv, err := convStore.Create(ctx, domain.Conversation{
		ProviderID: prov.ID, ModelID: "gemini-2.5-pro", SystemPrompt: "Sys", AssistantID: domain.DefaultAssistantID,
	})
	if err != nil {
		t.Fatalf("create conversation: %v", err)
	}

	prepared := make([]*PreparedStream, 2)
	failures := make([]error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			prepared[idx], failures[idx] = chatSvc.Prepare(ctx, StreamChatInput{ConversationID: conv.ID, Text: "same candidate"})
		}(i)
	}
	select {
	case <-createStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("cache creation never started")
	}
	close(releaseCreate)
	wg.Wait()

	if creates.Load() != 1 {
		t.Fatalf("expected exactly one create for one candidate, got %d", creates.Load())
	}
	for i, p := range prepared {
		if failures[i] != nil {
			t.Fatalf("Prepare #%d: %v", i, failures[i])
		}
		if sErr := p.Stream(ctx, func(domain.StreamEvent) error { return nil }); sErr != nil {
			t.Fatalf("Stream #%d: %v", i, sErr)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(mainBodies) != 2 {
		t.Fatalf("expected two main requests, got %d", len(mainBodies))
	}
	for i, body := range mainBodies {
		if body["cachedContent"] != "cachedContents/concurrent-1" {
			t.Fatalf("request #%d must reuse the shared resource: %+v", i, body)
		}
	}
}
