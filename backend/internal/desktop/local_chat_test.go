package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

type desktopRoundTripper func(*http.Request) (*http.Response, error)

func (f desktopRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type onResponseClose struct {
	io.ReadCloser
	after func()
}

func (r onResponseClose) Close() error { err := r.ReadCloser.Close(); r.after(); return err }

func TestLocalTopicWithCloudAssistantImageDirectAndCloudCancelContract(t *testing.T) {
	ctx := context.Background()

	// 1. Real cloud gateway backed by its own SQLite DB.
	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open cloud sqlite: %v", err)
	}
	defer cloudDB.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	// Upstream mock LLM server capturing direct calls and supporting cancelable mid-stream hang.
	var (
		llmMu          sync.Mutex
		llmRequests    []map[string]any
		blockAfterText bool
	)
	var rotated atomic.Bool
	var authFailures atomic.Int32
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "Bearer sk-cloud-upstream-key"
		if rotated.Load() {
			expected = "Bearer sk-rotated"
		}
		if r.Header.Get("Authorization") != expected {
			authFailures.Add(1)
			http.Error(w, "invalid api key", http.StatusUnauthorized)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		llmMu.Lock()
		llmRequests = append(llmRequests, body)
		shouldBlock := blockAfterText
		llmMu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Part 1 \"}}]}\n\n")
		flusher.Flush()
		if shouldBlock {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(5 * time.Second):
			}
			return
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Part 2\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":6,\"total_tokens\":18}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer llmSrv.Close()

	cloudProvStore := store.NewProviderStore(cloudDB)
	cloudAssistStore := store.NewAssistantStore(cloudDB)
	cloudConvStore := store.NewConversationStore(cloudDB)
	cloudMsgStore := store.NewMessageStore(cloudDB)
	cloudSearchStore := store.NewSearchConfigStore(cloudDB)
	cloudMCPStore := store.NewMCPServerStore(cloudDB)
	cloudPrefStore := store.NewPreferenceStore(cloudDB)

	prov, err := cloudProvStore.Create(ctx, domain.ProviderConfig{
		ID:       "prov-1",
		Name:     "Cloud OpenAI",
		Adapter:  provider.AdapterGenericHTTP,
		BaseURL:  llmSrv.URL,
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-cloud-upstream-key",
		Enabled:  true,
		Models: []domain.ModelConfig{
			{ID: "gpt-4o", Name: "GPT-4o", APIFormat: format.FormatIDOpenAICompletions},
		},
	})
	if err != nil {
		t.Fatalf("create cloud provider: %v", err)
	}
	customAssistant, err := cloudAssistStore.Create(ctx, domain.Assistant{
		ID:                "asst-custom",
		Name:              "Vision Analyst",
		SystemPrompt:      "Analyze images precisely.",
		DefaultProviderID: prov.ID,
		DefaultModelID:    "gpt-4o",
	})
	if err != nil {
		t.Fatalf("create cloud assistant: %v", err)
	}
	cloudConv, err := cloudConvStore.Create(ctx, domain.Conversation{
		ID:          "cloud-conv-1",
		AssistantID: customAssistant.ID,
		Title:       "Cloud Topic",
		ProviderID:  prov.ID,
		ModelID:     "gpt-4o",
	})
	if err != nil {
		t.Fatalf("create cloud conv: %v", err)
	}

	var credHits, listHits atomic.Int32
	var cloudReceivedPrepareLocal atomic.Bool
	var cloudReceivedLocalImage atomic.Bool

	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:              config.Config{AccessToken: "cloud-secret", DevMode: false},
		Formats:             formats,
		Adapters:            adapters,
		ProviderService:     service.NewProviderService(cloudProvStore, formats, adapters),
		AssistantService:    service.NewAssistantService(cloudAssistStore),
		ConversationService: service.NewConversationService(cloudConvStore, cloudMsgStore).WithAssistants(cloudAssistStore),
		PluginService:       service.NewPluginService(plugin.NewSearchRegistry(), cloudSearchStore, cloudMCPStore),
		ChatService:         service.NewChatService(cloudProvStore, cloudConvStore, cloudMsgStore, formats, adapters, &http.Client{}).WithAssistants(cloudAssistStore),
		PreferenceService:   service.NewPreferenceService(cloudPrefStore),
	})
	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/providers" {
			listHits.Add(1)
		}
		if r.URL.Path == "/api/v1/providers/prov-1/credential" {
			credHits.Add(1)
		}
		if strings.Contains(r.URL.Path, "prepare-local") {
			cloudReceivedPrepareLocal.Store(true)
		}
		if strings.Contains(r.URL.Path, "local-conv-1") {
			cloudReceivedLocalImage.Store(true)
		}
		cloudRouter.ServeHTTP(w, r)
	}))
	defer cloudSrv.Close()

	// 2. Desktop local store + engine.
	localDBPath := filepath.Join(t.TempDir(), "local.db")
	localStore, err := OpenDesktopStore(ctx, localDBPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer func() { _ = localStore.Close() }()
	if _, err := localStore.SaveConnection(ctx, cloudSrv.URL, "cloud-secret"); err != nil {
		t.Fatal(err)
	}
	protector := newTestProtector(t, 1)
	cloud := NewCloudClient(cloudSrv.URL, "cloud-secret")
	newEngine := func() (*DesktopChatEngine, *MemoryCredentialCache) {
		localStore.SetCredentialProtector(protector)
		cache := NewMemoryCredentialCache(cloud)
		localStore.SetMemoryCacheInvalidator(cache.ClearAll)
		composite := NewCompositeToolRuntime(localStore.MCPs, nil, cloud)
		return NewDesktopChatEngine(localStore, cloud, cache, formats, adapters, nil, composite, &http.Client{}), cache
	}
	engine, _ := newEngine()

	// Mirror cloud assistants locally and create a local topic bound to the cloud custom assistant.
	assistants, err := cloud.ListAssistants(ctx)
	if err != nil {
		t.Fatalf("ListAssistants: %v", err)
	}
	if err := localStore.SyncCloudAssistants(ctx, assistants); err != nil {
		t.Fatalf("SyncCloudAssistants: %v", err)
	}
	localConv, err := localStore.Conversations.Create(ctx, domain.Conversation{
		ID:          "local-conv-1",
		AssistantID: customAssistant.ID,
		Title:       "Local Image Topic",
		ProviderID:  prov.ID,
		ModelID:     "gpt-4o",
	})
	if err != nil {
		t.Fatalf("create local conv: %v", err)
	}

	// Send image + text on local topic -> direct to upstream LLM, zero message/image traffic to cloud, only 1 cred fetch.
	imgInput := service.StreamChatInput{
		ConversationID: localConv.ID,
		Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeImage, MimeType: "image/png", Data: "iVBORw0KGgo="},
			{Type: domain.BlockTypeText, Text: "describe this image"},
		},
	}
	prepLocal, err := engine.Prepare(ctx, plugin.ExecutionScopeLocal, imgInput)
	if err != nil {
		t.Fatalf("desktop local Prepare: %v", err)
	}
	var localEvents []domain.StreamEvent
	if err := prepLocal.Stream(ctx, func(ev domain.StreamEvent) error {
		localEvents = append(localEvents, ev)
		return nil
	}); err != nil {
		t.Fatalf("desktop local Stream: %v", err)
	}
	if cloudReceivedPrepareLocal.Load() || cloudReceivedLocalImage.Load() {
		t.Fatal("cloud gateway must not receive local topic message or prepare-local request")
	}
	if credHits.Load() != 1 {
		t.Fatalf("expected 1 credential fetch for local topic, got %d", credHits.Load())
	}
	localMsgs, _ := localStore.Messages.ListByConversation(ctx, localConv.ID)
	if len(localMsgs) != 2 || localMsgs[0].Blocks[0].Type != domain.BlockTypeImage || localMsgs[1].Usage == nil || localMsgs[1].Usage.TotalTokens != 18 {
		t.Fatalf("unexpected local persisted messages: %+v", localMsgs)
	}

	if listHits.Load() != 1 {
		t.Fatalf("first generation fetched %d provider lists", listHits.Load())
	}
	if err := localStore.Close(); err != nil {
		t.Fatal(err)
	}
	localStore, err = OpenDesktopStore(ctx, localDBPath)
	if err != nil {
		t.Fatal(err)
	}
	engine, cache := newEngine()

	// 3. Contract test: identical request via standard ChatService (Web) vs Desktop local vs Desktop cloud produces equivalent events & usage.
	webConv, err := cloudConvStore.Create(ctx, domain.Conversation{
		ID:          "web-conv-contract",
		AssistantID: customAssistant.ID,
		Title:       "Contract",
		ProviderID:  prov.ID,
		ModelID:     "gpt-4o",
	})
	if err != nil {
		t.Fatalf("create web conv: %v", err)
	}
	webChatSvc := service.NewChatService(cloudProvStore, cloudConvStore, cloudMsgStore, formats, adapters, &http.Client{}).
		WithAssistants(cloudAssistStore)

	runAndCollect := func(prep interface {
		Stream(context.Context, func(domain.StreamEvent) error) error
	}) ([]string, *domain.Usage, string) {
		var kinds []string
		var text strings.Builder
		var finalUsage *domain.Usage
		if err := prep.Stream(ctx, func(ev domain.StreamEvent) error {
			kinds = append(kinds, ev.Type)
			if ev.Delta != "" {
				text.WriteString(ev.Delta)
			}
			if ev.Type == domain.StreamEventMessageEnd && ev.Message != nil {
				finalUsage = ev.Message.Usage
			}
			return nil
		}); err != nil {
			t.Fatalf("Stream: %v", err)
		}
		return kinds, finalUsage, text.String()
	}

	webPrep, err := webChatSvc.Prepare(ctx, service.StreamChatInput{
		ConversationID: webConv.ID,
		Text:           "contract hello",
	})
	if err != nil {
		t.Fatalf("web Prepare: %v", err)
	}
	webKinds, webUsage, webText := runAndCollect(webPrep)

	localContractConv, _ := localStore.Conversations.Create(ctx, domain.Conversation{
		ID:          "local-conv-contract",
		AssistantID: customAssistant.ID,
		Title:       "Contract",
		ProviderID:  prov.ID,
		ModelID:     "gpt-4o",
	})
	deskLocalPrep, err := engine.Prepare(ctx, plugin.ExecutionScopeLocal, service.StreamChatInput{
		ConversationID: localContractConv.ID,
		Text:           "contract hello",
	})
	if err != nil {
		t.Fatalf("desktop local contract Prepare: %v", err)
	}
	deskLocalKinds, deskLocalUsage, deskLocalText := runAndCollect(deskLocalPrep)

	now := time.Now()
	cache.nowFn = func() time.Time { return now.Add(2 * defaultCredentialTTL) }
	deskCloudPrep, err := engine.Prepare(ctx, plugin.ExecutionScopeCloud, service.StreamChatInput{
		ConversationID: cloudConv.ID,
		Text:           "contract hello",
	})
	if err != nil {
		t.Fatalf("desktop cloud contract Prepare: %v", err)
	}
	deskCloudKinds, deskCloudUsage, deskCloudText := runAndCollect(deskCloudPrep)

	if !reflect.DeepEqual(webKinds, deskLocalKinds) || !reflect.DeepEqual(webKinds, deskCloudKinds) {
		t.Fatalf("event sequences diverged: web=%v local=%v cloud=%v", webKinds, deskLocalKinds, deskCloudKinds)
	}
	if !reflect.DeepEqual(webUsage, deskLocalUsage) || !reflect.DeepEqual(webUsage, deskCloudUsage) {
		t.Fatalf("usage diverged: web=%+v local=%+v cloud=%+v", webUsage, deskLocalUsage, deskCloudUsage)
	}
	if webText != "Part 1 Part 2" || deskLocalText != webText || deskCloudText != webText {
		t.Fatalf("stream text diverged: web=%q local=%q cloud=%q", webText, deskLocalText, deskCloudText)
	}
	// Cached credential reused across local & cloud contract turns without extra fetches.
	if listHits.Load() != 1 || credHits.Load() != 1 {
		t.Fatalf("reopen and TTL expiry made provider calls: list=%d credentials=%d", listHits.Load(), credHits.Load())
	}

	// 4. Cloud topic mid-stream cancel preserves user message saved before stream + partial assistant message.
	llmMu.Lock()
	blockAfterText = true
	llmMu.Unlock()

	cancelCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()

	cloudCancelPrep, err := engine.Prepare(cancelCtx, plugin.ExecutionScopeCloud, service.StreamChatInput{
		ConversationID: cloudConv.ID,
		Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeImage, MimeType: "image/png", Data: "iVBORw0KGgo="},
			{Type: domain.BlockTypeText, Text: "interruptible prompt"},
		},
	})
	if err != nil {
		t.Fatalf("cloud cancel Prepare: %v", err)
	}

	// Verify user message is already persisted on cloud BEFORE Stream() consumes any event.
	midMsgs, err := cloudMsgStore.ListByConversation(ctx, cloudConv.ID)
	if err != nil || len(midMsgs) != 3 || midMsgs[2].Role != domain.RoleUser || midMsgs[2].Blocks[0].Type != domain.BlockTypeImage {
		t.Fatalf("expected user image message persisted on cloud before stream consumption, got %+v err=%v", midMsgs, err)
	}

	var cancelOnce sync.Once
	_ = cloudCancelPrep.Stream(cancelCtx, func(ev domain.StreamEvent) error {
		if strings.Contains(ev.Delta, "Part 1") {
			cancelOnce.Do(cancelStream)
		}
		return nil
	})

	afterMsgs, err := cloudMsgStore.ListByConversation(ctx, cloudConv.ID)
	if err != nil || len(afterMsgs) != 4 {
		t.Fatalf("expected 4 cloud messages after cancel (2 prior + user + aborted assistant), got %d err=%v", len(afterMsgs), err)
	}
	last := afterMsgs[3]
	if last.Role != domain.RoleAssistant || last.StopReason != domain.StopReasonAborted || len(last.Blocks) == 0 || !strings.Contains(last.Blocks[0].Text, "Part 1") {
		t.Fatalf("expected partial aborted assistant message persisted on cloud, got %+v", last)
	}

	llmMu.Lock()
	blockAfterText = false
	llmMu.Unlock()
	if _, err := engine.Compact(ctx, plugin.ExecutionScopeLocal, service.CompactConversationInput{ConversationID: localConv.ID}); err != nil {
		t.Fatal(err)
	}
	if listHits.Load() != 1 || credHits.Load() != 1 {
		t.Fatal("warm compaction fetched provider metadata or credential")
	}

	prov.APIKey = "sk-rotated"
	if _, err := cloudProvStore.Update(ctx, prov); err != nil {
		t.Fatal(err)
	}
	rotated.Store(true)
	prep, err := engine.Prepare(ctx, plugin.ExecutionScopeLocal, imgInput)
	if err != nil {
		t.Fatalf("one-shot credential refresh: %v", err)
	}
	runAndCollect(prep)
	localMsgs, _ = localStore.Messages.ListByConversation(ctx, localConv.ID)
	var users int
	for _, msg := range localMsgs {
		if msg.Role == domain.RoleUser {
			users++
		}
	}
	if users != 2 || authFailures.Load() != 1 || listHits.Load() != 2 || credHits.Load() != 2 {
		t.Fatalf("refresh duplicated work: users=%d auth=%d list=%d cred=%d", users, authFailures.Load(), listHits.Load(), credHits.Load())
	}

	// A second 401 stops recovery without writing another user message.
	rotated.Store(false)
	if _, err := engine.Prepare(ctx, plugin.ExecutionScopeLocal, imgInput); err == nil {
		t.Fatal("repeated 401 was swallowed")
	}
	afterRejected, _ := localStore.Messages.ListByConversation(ctx, localConv.ID)
	if len(afterRejected) != len(localMsgs) || authFailures.Load() != 3 || listHits.Load() != 3 || credHits.Load() != 3 {
		t.Fatalf("persistent 401 was retried more than once or wrote messages: auth=%d list=%d cred=%d", authFailures.Load(), listHits.Load(), credHits.Load())
	}
	rotated.Store(true)

	// Switch exactly after A's detail is decoded, before looking up the provider.
	var bRequests atomic.Int32
	gatewayB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bRequests.Add(1)
		t.Errorf("old request reached gateway B: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer gatewayB.Close()
	llmMu.Lock()
	before := len(llmRequests)
	llmMu.Unlock()
	cloud.SetHTTPClient(&http.Client{Transport: desktopRoundTripper(func(r *http.Request) (*http.Response, error) {
		resp, err := http.DefaultTransport.RoundTrip(r)
		if err == nil && r.Method == http.MethodGet && r.URL.Path == "/api/v1/conversations/"+cloudConv.ID {
			resp.Body = onResponseClose{resp.Body, func() { cloud.SetCredentials(gatewayB.URL, "token-b") }}
		}
		return resp, err
	})})
	for _, compact := range []bool{false, true} {
		cloud.SetCredentials(cloudSrv.URL, "cloud-secret")
		if compact {
			_, err = engine.Compact(ctx, plugin.ExecutionScopeCloud, service.CompactConversationInput{ConversationID: cloudConv.ID})
		} else {
			_, err = engine.Prepare(ctx, plugin.ExecutionScopeCloud, service.StreamChatInput{ConversationID: cloudConv.ID, Text: "must not cross gateways"})
		}
		if err == nil {
			t.Fatalf("request survived connection change (compact=%v)", compact)
		}
	}
	llmMu.Lock()
	sent := len(llmRequests) - before
	llmMu.Unlock()
	if sent != 0 || bRequests.Load() != 0 {
		t.Fatalf("obsolete request reached upstream=%d or gateway B=%d", sent, bRequests.Load())
	}
}
