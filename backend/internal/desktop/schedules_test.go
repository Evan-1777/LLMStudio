package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/mcp"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestDesktopScheduleScopeIsolationAndCloudProxy(t *testing.T) {
	ctx := context.Background()

	cloudDB, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open cloud db: %v", err)
	}
	defer cloudDB.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())
	searchReg := plugin.NewSearchRegistry()
	searchReg.MustRegister(search.NewTavilyEngine(nil))

	provStore := store.NewProviderStore(cloudDB)
	assistStore := store.NewAssistantStore(cloudDB)
	convStore := store.NewConversationStore(cloudDB)
	msgStore := store.NewMessageStore(cloudDB)
	taskStore := store.NewScheduledTaskStore(cloudDB)

	prov, err := provStore.Create(ctx, domain.ProviderConfig{
		Name:     "Cloud",
		Adapter:  "generic-http",
		BaseURL:  "https://api.example.com/v1",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-1",
		Enabled:  true,
		Models:   []domain.ModelConfig{{ID: "m1", Name: "M1", APIFormat: format.FormatIDOpenAICompletions}},
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	conv1, err := convStore.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Cloud Agent 1",
		ProviderID:  prov.ID,
		ModelID:     "m1",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create conv1: %v", err)
	}
	conv2, err := convStore.Create(ctx, domain.Conversation{
		AssistantID: domain.DefaultAssistantID,
		Title:       "Cloud Agent 2",
		ProviderID:  prov.ID,
		ModelID:     "m1",
		Mode:        domain.ConversationModeAgent,
	})
	if err != nil {
		t.Fatalf("create conv2: %v", err)
	}

	chatSvc := service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithAssistants(assistStore)
	schedSvc := service.NewScheduleService(taskStore, convStore, provStore, assistStore, chatSvc)

	var seenQueries []string
	cloudRouter := httpapi.NewRouter(httpapi.RouterDeps{
		Config:          config.Config{AccessToken: "cloud-tok"},
		ScheduleService: schedSvc,
	})
	cloudSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenQueries = append(seenQueries, r.URL.RawQuery)
		cloudRouter.ServeHTTP(w, r)
	}))
	defer cloudSrv.Close()

	tmpDir := t.TempDir()
	paths := StoragePaths{Mode: DataModePortable, DataDir: tmpDir, DBPath: filepath.Join(tmpDir, "local.db")}
	localStore, err := OpenDesktopStore(ctx, paths.DBPath)
	if err != nil {
		t.Fatalf("OpenDesktopStore: %v", err)
	}
	defer localStore.Close()

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()
	cloud := NewCloudClient("", "")
	credCache := NewMemoryCredentialCache(cloud)
	composite := NewCompositeToolRuntime(localStore.MCPs, mcpRuntime, cloud)
	chatEngine := NewDesktopChatEngine(localStore, cloud, credCache, formats, adapters, searchReg, composite, &http.Client{})

	srv, err := NewServer(ServerConfig{
		Paths:          paths,
		Store:          localStore,
		Cloud:          cloud,
		CredCache:      credCache,
		Formats:        formats,
		Adapters:       adapters,
		SearchReg:      searchReg,
		LocalMCPClient: mcpRuntime,
		CompositeTools: composite,
		ChatEngine:     chatEngine,
		SyncService:    NewSyncService(localStore, cloud),
		Version:        "1.5.0",
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	h := srv.Handler()
	tok := srv.Token()

	doReq := func(method, path string, body any) *httptest.ResponseRecorder {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Local scope returns 404 NOT_FOUND.
	for _, target := range []string{"/api/v1/schedules", "/api/v1/schedules?scope=local"} {
		rec := doReq(http.MethodGet, target, nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d body=%s, want 404", target, rec.Code, rec.Body.String())
		}
	}

	// 2. Cloud scope when disconnected returns 503 CLOUD_NOT_CONNECTED.
	disconn := doReq(http.MethodGet, "/api/v1/schedules?scope=cloud", nil)
	if disconn.Code != http.StatusServiceUnavailable {
		t.Fatalf("disconnected status=%d body=%s, want 503", disconn.Code, disconn.Body.String())
	}

	// 3. Connect cloud -> POST/GET/PATCH/DELETE proxy cleanly, stripping scope and keeping conversationId.
	cloud.SetCredentials(cloudSrv.URL, "cloud-tok")

	create1 := doReq(http.MethodPost, "/api/v1/schedules?scope=cloud", domain.ScheduleCreateInput{
		Name:           "Task 1",
		Prompt:         "p1",
		Hour:           8,
		Minute:         0,
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &conv1.ID,
	})
	if create1.Code != http.StatusCreated {
		t.Fatalf("create1 status=%d body=%s", create1.Code, create1.Body.String())
	}
	create2 := doReq(http.MethodPost, "/api/v1/schedules?scope=cloud", domain.ScheduleCreateInput{
		Name:           "Task 2",
		Prompt:         "p2",
		Hour:           9,
		Minute:         0,
		BindMode:       domain.ScheduleBindModeConversation,
		ConversationID: &conv2.ID,
	})
	if create2.Code != http.StatusCreated {
		t.Fatalf("create2 status=%d body=%s", create2.Code, create2.Body.String())
	}
	var c1Res struct {
		Schedule domain.ScheduledTask `json:"schedule"`
	}
	_ = json.Unmarshal(create1.Body.Bytes(), &c1Res)

	listFiltered := doReq(http.MethodGet, "/api/v1/schedules?scope=cloud&conversationId="+conv1.ID, nil)
	if listFiltered.Code != http.StatusOK {
		t.Fatalf("list filtered status=%d body=%s", listFiltered.Code, listFiltered.Body.String())
	}
	var listRes struct {
		Schedules []domain.ScheduledTask `json:"schedules"`
	}
	if err := json.Unmarshal(listFiltered.Body.Bytes(), &listRes); err != nil {
		t.Fatal(err)
	}
	if len(listRes.Schedules) != 1 || listRes.Schedules[0].ID != c1Res.Schedule.ID {
		t.Fatalf("expected filtered proxy result for conv1 only, got %+v", listRes.Schedules)
	}
	if len(seenQueries) == 0 || seenQueries[len(seenQueries)-1] != "conversationId="+conv1.ID {
		t.Fatalf("expected scope stripped and conversationId preserved, got %v", seenQueries)
	}

	delRec := doReq(http.MethodDelete, "/api/v1/schedules/"+c1Res.Schedule.ID+"?scope=cloud", nil)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", delRec.Code, delRec.Body.String())
	}
}
