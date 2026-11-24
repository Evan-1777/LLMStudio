package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestAgentRunEndpointsGateway(t *testing.T) {
	ctx := t.Context()
	const tok = "run-secret"
	entered := make(chan struct{})
	release := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		close(entered)
		select {
		case <-release:
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"hello-after-attach"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	p, err := provStore.Create(ctx, domain.ProviderConfig{
		ID: "p1", Name: "Mock", Adapter: provider.AdapterGenericHTTP, BaseURL: upstream.URL,
		AuthType: domain.AuthTypeNone, Enabled: true,
		Models: []domain.ModelConfig{{ID: "m1", Name: "M1", APIFormat: format.FormatIDOpenAICompletions}},
	})
	if err != nil {
		t.Fatal(err)
	}
	conv, err := convStore.Create(ctx, domain.Conversation{
		ID: "agent-c1", ProviderID: p.ID, ModelID: "m1", Mode: domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatal(err)
	}

	rt := agent.NewGateway(store.NewAgentStore(db), t.TempDir(), true)
	chatSvc := service.NewChatService(provStore, convStore, msgStore, formats, adapters, nil).WithAgent(rt)
	defer func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = chatSvc.Shutdown(shutCtx)
	}()
	convSvc := service.NewConversationService(convStore, msgStore).
		WithRunTracker(chatSvc.ActiveRun, chatSvc.ActiveRunConversationIDs, chatSvc.CancelRunsAndWait)

	router := NewRouter(RouterDeps{
		Config:              config.Config{AccessToken: tok, CORSOrigins: []string{"*"}},
		ConversationService: convSvc,
		ChatService:         chatSvc,
		AgentRuntime:        rt,
	})

	// Idle state: /run/stream returns 204, /agent/runs returns [].
	if rec := doJSONReq(t, router, http.MethodGet, "/api/v1/conversations/"+conv.ID+"/run/stream", tok, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("idle /run/stream status=%d want 204", rec.Code)
	}
	rec := doJSONReq(t, router, http.MethodGet, "/api/v1/agent/runs", tok, nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"conversationIds":[]}` {
		t.Fatalf("idle /agent/runs status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Start detached run via Prepare.
	if _, err := chatSvc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "go"}); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	<-entered

	// GET /agent/runs lists conv.ID; GET /conversations/{id} exposes activeRun & running=true.
	rec = doJSONReq(t, router, http.MethodGet, "/api/v1/agent/runs", tok, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), conv.ID) {
		t.Fatalf("active /agent/runs status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSONReq(t, router, http.MethodGet, "/api/v1/conversations/"+conv.ID, tok, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET detail status=%d", rec.Code)
	}
	var detail service.ConversationDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if !detail.Conversation.Running || detail.ActiveRun == nil || detail.ActiveRun.MessageID == "" {
		t.Fatalf("expected activeRun + running=true, got %+v", detail)
	}

	// Attach via GET /run/stream on live httptest server.
	srv := httptest.NewServer(router)
	defer srv.Close()
	attachReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/v1/conversations/"+conv.ID+"/run/stream", nil)
	attachReq.Header.Set("Authorization", "Bearer "+tok)
	attachRespCh := make(chan *http.Response, 1)
	go func() {
		resp, err := http.DefaultClient.Do(attachReq)
		if err != nil {
			t.Errorf("attach request: %v", err)
			return
		}
		attachRespCh <- resp
	}()
	close(release)
	attachResp := <-attachRespCh
	defer attachResp.Body.Close()
	if attachResp.StatusCode != http.StatusOK {
		t.Fatalf("attach status=%d want 200", attachResp.StatusCode)
	}
	var bodyBuf strings.Builder
	buf := make([]byte, 4096)
	for {
		n, rErr := attachResp.Body.Read(buf)
		if n > 0 {
			bodyBuf.Write(buf[:n])
		}
		if rErr != nil {
			break
		}
	}
	if !strings.Contains(bodyBuf.String(), "hello-after-attach") || !strings.Contains(bodyBuf.String(), `"type":"message_end"`) {
		t.Fatalf("unexpected attach SSE body: %s", bodyBuf.String())
	}

	// POST /run/cancel on idle returns cancelled=false.
	rec = doJSONReq(t, router, http.MethodPost, "/api/v1/conversations/"+conv.ID+"/run/cancel", tok, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"cancelled":false`) {
		t.Fatalf("idle cancel status=%d body=%s", rec.Code, rec.Body.String())
	}
}
