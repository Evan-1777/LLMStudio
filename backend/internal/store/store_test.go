package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/domain"
)

func TestSQLiteMigrationsAndStores(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "test.db")

	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("first OpenSQLite failed: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close first db: %v", err)
	}

	// Re-open the same database file to verify migration idempotency.
	db, err = OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("second OpenSQLite failed: %v", err)
	}
	defer db.Close()

	providers := NewProviderStore(db)
	convs := NewConversationStore(db)
	msgs := NewMessageStore(db)

	// Provider CRUD + EnsureBuiltIn non-overwrite.
	p, err := providers.Create(ctx, domain.ProviderConfig{
		ID:       "openai",
		Name:     "OpenAI",
		Adapter:  "generic-http",
		BaseURL:  "https://api.openai.com/v1",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-user-key",
		Enabled:  true,
		BuiltIn:  true,
		Models: []domain.ModelConfig{
			{
				ID:        "gpt-4o",
				Name:      "GPT-4o",
				APIFormat: "openai-completions",
				Compat:    domain.CompatConfig{MaxTokensField: "max_completion_tokens"},
			},
		},
	})
	if err != nil {
		t.Fatalf("create provider failed: %v", err)
	}
	if len(p.Models) != 1 || p.Models[0].ID != "gpt-4o" {
		t.Fatalf("unexpected provider models: %+v", p.Models)
	}

	if err := providers.EnsureBuiltIn(ctx, domain.ProviderConfig{
		ID:       "openai",
		Name:     "Overwritten Name",
		Adapter:  "generic-http",
		BaseURL:  "https://wrong.example.com",
		AuthType: domain.AuthTypeNone,
		BuiltIn:  true,
	}); err != nil {
		t.Fatalf("EnsureBuiltIn failed: %v", err)
	}
	fetchedP, err := providers.Get(ctx, "openai")
	if err != nil {
		t.Fatalf("get provider failed: %v", err)
	}
	if fetchedP.BaseURL != "https://api.openai.com/v1" || fetchedP.APIKey != "sk-user-key" {
		t.Fatalf("EnsureBuiltIn overwrote existing provider: %+v", fetchedP)
	}

	fetchedP.Name = "OpenAI Updated"
	updatedP, err := providers.Update(ctx, fetchedP)
	if err != nil {
		t.Fatalf("update provider failed: %v", err)
	}
	if updatedP.Name != "OpenAI Updated" {
		t.Fatalf("expected updated name, got %q", updatedP.Name)
	}

	// Conversation CRUD + sync_enabled persistence.
	temp := 0.7
	conv, err := convs.Create(ctx, domain.Conversation{
		Title:        "Test Chat",
		ProviderID:   "openai",
		ModelID:      "gpt-4o",
		SystemPrompt: "Be concise.",
		Params:       domain.GenerationParams{Temperature: &temp},
	})
	if err != nil {
		t.Fatalf("create conversation failed: %v", err)
	}
	if conv.SyncEnabled || conv.SyncState != domain.SyncStateLocalOnly || conv.SyncVersion != 0 {
		t.Fatalf("unexpected default sync state: %+v", conv)
	}

	conv.SyncEnabled = true
	conv.Title = "Renamed Chat"
	updatedConv, err := convs.Update(ctx, conv)
	if err != nil {
		t.Fatalf("update conversation failed: %v", err)
	}
	if !updatedConv.SyncEnabled || updatedConv.SyncState != domain.SyncStateLocalOnly || updatedConv.SyncVersion != 0 {
		t.Fatalf("unexpected updated sync fields: %+v", updatedConv)
	}

	// Messages CRUD + DeleteFrom + Cascade delete.
	m1, err := msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Hello"}},
	})
	if err != nil {
		t.Fatalf("create m1 failed: %v", err)
	}
	m2, err := msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleAssistant,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Hi there"}},
		StopReason:     domain.StopReasonStop,
	})
	if err != nil {
		t.Fatalf("create m2 failed: %v", err)
	}
	_, err = msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "Follow-up"}},
	})
	if err != nil {
		t.Fatalf("create m3 failed: %v", err)
	}

	if err := msgs.DeleteFrom(ctx, conv.ID, m2.ID); err != nil {
		t.Fatalf("DeleteFrom failed: %v", err)
	}
	remaining, err := msgs.ListByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("ListByConversation failed: %v", err)
	}
	if len(remaining) != 1 || remaining[0].ID != m1.ID {
		t.Fatalf("expected only m1 remaining after DeleteFrom(m2), got %+v", remaining)
	}

	if err := convs.Delete(ctx, conv.ID); err != nil {
		t.Fatalf("delete conversation failed: %v", err)
	}
	afterCascade, err := msgs.ListByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("ListByConversation after cascade failed: %v", err)
	}
	if len(afterCascade) != 0 {
		t.Fatalf("expected 0 messages after cascade delete, got %d", len(afterCascade))
	}

	if err := providers.Delete(ctx, "openai"); err != nil {
		t.Fatalf("delete provider failed: %v", err)
	}
}

func TestV1UpgradeAssistantsSearchMCPAndMessageOps(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "upgrade.db")

	// Simulate an existing v1 database that has only 001_init.sql applied and a legacy conversation row.
	rawDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	initSQL, err := os.ReadFile(filepath.Join("migrations", "001_init.sql"))
	if err != nil {
		t.Fatalf("read 001_init.sql: %v", err)
	}
	if _, err := rawDB.ExecContext(ctx, string(initSQL)); err != nil {
		t.Fatalf("exec 001_init.sql: %v", err)
	}
	if _, err := rawDB.ExecContext(ctx, `
		CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
		INSERT INTO schema_migrations(version, applied_at) VALUES ('001_init.sql', '2026-11-17T00:00:00Z');
		INSERT INTO conversations(id, title, created_at, updated_at) VALUES ('legacy-conv', 'Legacy', '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z');
	`); err != nil {
		t.Fatalf("seed legacy v1 db: %v", err)
	}
	_ = rawDB.Close()

	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite upgrade failed: %v", err)
	}
	defer db.Close()

	assistants := NewAssistantStore(db)
	convs := NewConversationStore(db)
	msgs := NewMessageStore(db)
	searches := NewSearchConfigStore(db)
	mcps := NewMCPServerStore(db)

	// Legacy conversation should automatically belong to default assistant.
	legacy, err := convs.Get(ctx, "legacy-conv")
	if err != nil {
		t.Fatalf("get legacy conv: %v", err)
	}
	if legacy.AssistantID != domain.DefaultAssistantID {
		t.Fatalf("expected legacy conv assistantId 'default', got %q", legacy.AssistantID)
	}

	// Default assistant exists and cannot be deleted.
	if err := assistants.Delete(ctx, domain.DefaultAssistantID); err == nil {
		t.Fatal("expected deleting default assistant to fail")
	}

	// Custom assistant CRUD + conversation reassignment on delete.
	customA, err := assistants.Create(ctx, domain.Assistant{
		Name:         "Coder",
		SystemPrompt: "Write Go.",
	})
	if err != nil {
		t.Fatalf("create assistant: %v", err)
	}
	convA, err := convs.Create(ctx, domain.Conversation{
		AssistantID: customA.ID,
		Title:       "Go Task",
	})
	if err != nil {
		t.Fatalf("create convA: %v", err)
	}

	// Message DeleteByID and ListUpTo.
	m1, _ := msgs.Create(ctx, domain.Message{ConversationID: convA.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "1"}}})
	m2, _ := msgs.Create(ctx, domain.Message{ConversationID: convA.ID, Role: domain.RoleAssistant, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "2"}}})
	m3, _ := msgs.Create(ctx, domain.Message{ConversationID: convA.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "3"}}})

	upTo, err := msgs.ListUpTo(ctx, convA.ID, m2.ID)
	if err != nil || len(upTo) != 2 || upTo[0].ID != m1.ID || upTo[1].ID != m2.ID {
		t.Fatalf("unexpected ListUpTo result: err=%v msgs=%+v", err, upTo)
	}
	if err := msgs.DeleteByID(ctx, convA.ID, m2.ID); err != nil {
		t.Fatalf("DeleteByID failed: %v", err)
	}
	afterDel, _ := msgs.ListByConversation(ctx, convA.ID)
	if len(afterDel) != 2 || afterDel[0].ID != m1.ID || afterDel[1].ID != m3.ID {
		t.Fatalf("expected m1 and m3 after DeleteByID(m2), got %+v", afterDel)
	}

	// Delete custom assistant -> convA reassigned to default.
	if err := assistants.Delete(ctx, customA.ID); err != nil {
		t.Fatalf("delete custom assistant: %v", err)
	}
	reassigned, err := convs.Get(ctx, convA.ID)
	if err != nil || reassigned.AssistantID != domain.DefaultAssistantID {
		t.Fatalf("expected reassigned assistantId 'default', got err=%v conv=%+v", err, reassigned)
	}

	// SearchConfigStore CRUD & single default guarantee.
	if _, err := searches.Upsert(ctx, domain.SearchEngineConfig{EngineID: "tavily", Enabled: true, APIKey: "k1", IsDefault: true}); err != nil {
		t.Fatalf("upsert tavily failed: %v", err)
	}
	if _, err := searches.Upsert(ctx, domain.SearchEngineConfig{EngineID: "searxng", Enabled: true, IsDefault: true}); err != nil {
		t.Fatalf("upsert searxng failed: %v", err)
	}
	tav, _ := searches.Get(ctx, "tavily")
	if tav.IsDefault {
		t.Fatal("expected tavily IsDefault to be cleared when searxng became default")
	}

	// MCPServerStore CRUD.
	mcpSrv, err := mcps.Create(ctx, domain.MCPServerConfig{
		Name:      "fs",
		Transport: domain.MCPTransportStdio,
		Command:   "npx",
		Args:      []string{"-y", "@modelcontextprotocol/server-filesystem"},
		Enabled:   true,
	})
	if err != nil || len(mcpSrv.Args) != 2 {
		t.Fatalf("create mcp server failed: err=%v srv=%+v", err, mcpSrv)
	}
	mcpSrv.Enabled = false
	updatedMCP, err := mcps.Update(ctx, mcpSrv)
	if err != nil || updatedMCP.Enabled {
		t.Fatalf("update mcp server failed: err=%v srv=%+v", err, updatedMCP)
	}
	if err := mcps.Delete(ctx, mcpSrv.ID); err != nil {
		t.Fatalf("delete mcp server failed: %v", err)
	}
}
