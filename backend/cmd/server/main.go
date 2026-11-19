package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/mcp"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/search"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, cfg.DBPath)
	if err != nil {
		log.Fatalf("database initialization failed: %v", err)
	}
	defer db.Close()

	providerStore := store.NewProviderStore(db)
	assistantStore := store.NewAssistantStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	searchStore := store.NewSearchConfigStore(db)
	mcpStore := store.NewMCPServerStore(db)
	prefStore := store.NewPreferenceStore(db)

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	formats.MustRegister(format.NewOpenAIResponsesFormat())
	formats.MustRegister(format.NewAnthropicMessagesFormat())
	formats.MustRegister(format.NewGoogleGenAIFormat())

	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	searchEngines := plugin.NewSearchRegistry()
	searchEngines.MustRegister(search.NewTavilyEngine(nil))
	searchEngines.MustRegister(search.NewSearXNGEngine(nil))

	mcpRuntime := mcp.NewRuntime()
	defer mcpRuntime.Close()

	providerSvc := service.NewProviderService(providerStore, formats, adapters)
	assistantSvc := service.NewAssistantService(assistantStore)
	convSvc := service.NewConversationService(convStore, msgStore).WithAssistants(assistantStore)
	pluginSvc := service.NewPluginService(searchEngines, searchStore, mcpStore).WithMCPClient(mcpRuntime)
	prefSvc := service.NewPreferenceService(prefStore)
	storageSvc := service.NewStorageService(store.NewStorageMaintenance(db, cfg.DBPath))
	chatSvc := service.NewChatService(providerStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithAssistants(assistantStore).
		WithSearch(searchEngines, searchStore).
		WithPreferences(prefSvc).
		WithMCP(mcpStore, mcpRuntime)

	router := httpapi.NewRouter(httpapi.RouterDeps{
		Config:              cfg,
		Formats:             formats,
		Adapters:            adapters,
		ProviderService:     providerSvc,
		AssistantService:    assistantSvc,
		ConversationService: convSvc,
		PluginService:       pluginSvc,
		ChatService:         chatSvc,
		PreferenceService:   prefSvc,
		StorageService:      storageSvc,
	})

	srv := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("llmstudio server listening on %s (devMode=%v)", cfg.Addr(), cfg.DevMode)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server failed: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown error: %v", err)
	}
	if err := mcpRuntime.Close(); err != nil {
		log.Printf("mcp runtime shutdown error: %v", err)
	}
}
