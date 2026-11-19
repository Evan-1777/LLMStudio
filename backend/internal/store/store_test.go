package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

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

	// Provider CRUD.
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

	fetchedP, err := providers.Get(ctx, "openai")
	if err != nil {
		t.Fatalf("get provider failed: %v", err)
	}
	if fetchedP.BaseURL != "https://api.openai.com/v1" || fetchedP.APIKey != "sk-user-key" {
		t.Fatalf("provider address or key did not round trip: %+v", fetchedP)
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

func TestLocalRequestAndNonDestructiveMessageOps(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "v13.db")
	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite failed: %v", err)
	}
	defer db.Close()

	providers := NewProviderStore(db)
	convs := NewConversationStore(db)
	msgs := NewMessageStore(db)

	// ProviderConfig.LocalRequest round-trip + default false.
	localProv, err := providers.Create(ctx, domain.ProviderConfig{
		ID:           "local-ollama",
		Name:         "Local Ollama",
		Adapter:      "generic-http",
		BaseURL:      "http://127.0.0.1:11434/v1",
		AuthType:     domain.AuthTypeNone,
		Enabled:      true,
		LocalRequest: true,
	})
	if err != nil || !localProv.LocalRequest {
		t.Fatalf("expected LocalRequest=true on create, err=%v prov=%+v", err, localProv)
	}
	localProv.LocalRequest = false
	updatedProv, err := providers.Update(ctx, localProv)
	if err != nil || updatedProv.LocalRequest {
		t.Fatalf("expected LocalRequest=false after update, err=%v prov=%+v", err, updatedProv)
	}
	defaultProv, err := providers.Create(ctx, domain.ProviderConfig{
		ID:       "remote-default",
		Name:     "Remote",
		Adapter:  "generic-http",
		BaseURL:  "https://api.example.com/v1",
		AuthType: domain.AuthTypeBearer,
		APIKey:   "sk-test",
		Enabled:  true,
	})
	if err != nil || defaultProv.LocalRequest {
		t.Fatalf("expected LocalRequest=false by default, err=%v prov=%+v", err, defaultProv)
	}

	// Conversation monotonic TouchUpdatedAt.
	conv, err := convs.Create(ctx, domain.Conversation{Title: "Monotonic Test"})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}
	initialUpdated := conv.UpdatedAt
	if err := convs.TouchUpdatedAt(ctx, conv.ID, initialUpdated.Add(-10*time.Minute)); err != nil {
		t.Fatalf("TouchUpdatedAt older: %v", err)
	}
	fetchedConv, _ := convs.Get(ctx, conv.ID)
	if !fetchedConv.UpdatedAt.Equal(initialUpdated) {
		t.Fatalf("expected updated_at not to regress: got %v want %v", fetchedConv.UpdatedAt, initialUpdated)
	}
	future := initialUpdated.Add(5 * time.Minute)
	if err := convs.TouchUpdatedAt(ctx, conv.ID, future); err != nil {
		t.Fatalf("TouchUpdatedAt newer: %v", err)
	}
	fetchedConv, _ = convs.Get(ctx, conv.ID)
	if !fetchedConv.UpdatedAt.Equal(future) {
		t.Fatalf("expected updated_at to advance to %v, got %v", future, fetchedConv.UpdatedAt)
	}

	// UpdateBlocks preserves id, role, created_at.
	t0 := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	u1, _ := msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1"}},
		CreatedAt:      t0,
	})
	u2, _ := msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u2"}},
		CreatedAt:      t0, // Exact timestamp collision with u1.
	})
	u3, _ := msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleUser,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u3"}},
		CreatedAt:      t0.Add(time.Nanosecond),
	})

	editedU1, err := msgs.UpdateBlocks(ctx, conv.ID, u1.ID, []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "u1-edited"}})
	if err != nil {
		t.Fatalf("UpdateBlocks failed: %v", err)
	}
	if editedU1.ID != u1.ID || editedU1.Role != domain.RoleUser || !editedU1.CreatedAt.Equal(u1.CreatedAt) || editedU1.Blocks[0].Text != "u1-edited" {
		t.Fatalf("unexpected UpdateBlocks result: %+v", editedU1)
	}

	// InsertAfter with timestamp collision places a1 strictly between u1 and u2, keeping u3 after u2.
	a1, err := msgs.InsertAfter(ctx, conv.ID, u1.ID, domain.Message{
		Role:       domain.RoleAssistant,
		Blocks:     []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a1"}},
		StopReason: domain.StopReasonStop,
	})
	if err != nil {
		t.Fatalf("InsertAfter collision failed: %v", err)
	}
	ordered, err := msgs.ListByConversation(ctx, conv.ID)
	if err != nil {
		t.Fatalf("ListByConversation failed: %v", err)
	}
	if len(ordered) != 4 || ordered[0].ID != u1.ID || ordered[1].ID != a1.ID || ordered[2].ID != u2.ID || ordered[3].ID != u3.ID {
		t.Fatalf("unexpected order after InsertAfter: %+v", ordered)
	}

	// ReplaceByID overwrites a1 in place while preserving its position and created_at.
	replaced, err := msgs.ReplaceByID(ctx, conv.ID, a1.ID, domain.Message{
		Role:       domain.RoleAssistant,
		Blocks:     []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "a1-replaced"}},
		StopReason: domain.StopReasonStop,
	})
	if err != nil {
		t.Fatalf("ReplaceByID failed: %v", err)
	}
	if !replaced.CreatedAt.Equal(a1.CreatedAt) || replaced.Blocks[0].Text != "a1-replaced" {
		t.Fatalf("unexpected ReplaceByID result: %+v", replaced)
	}
	orderedAfterReplace, _ := msgs.ListByConversation(ctx, conv.ID)
	if len(orderedAfterReplace) != 4 || orderedAfterReplace[0].ID != u1.ID || orderedAfterReplace[1].ID != replaced.ID || orderedAfterReplace[2].ID != u2.ID || orderedAfterReplace[3].ID != u3.ID {
		t.Fatalf("unexpected order after ReplaceByID: %+v", orderedAfterReplace)
	}
}

func TestMigration004OrganizationAndRankStability(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "v003.db")

	// Construct a 003 database without 004 migration, with multi-assistant rows and identical updated_at ties.
	rawDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	for _, mig := range []string{"001_init.sql", "002_v1_1_upgrade.sql", "003_provider_local_request.sql"} {
		sqlBytes, readErr := os.ReadFile(filepath.Join("migrations", mig))
		if readErr != nil {
			t.Fatalf("read %s: %v", mig, readErr)
		}
		if _, execErr := rawDB.ExecContext(ctx, string(sqlBytes)); execErr != nil {
			t.Fatalf("exec %s: %v", mig, execErr)
		}
	}
	if _, err := rawDB.ExecContext(ctx, `
		CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
		INSERT INTO schema_migrations(version, applied_at) VALUES
			('001_init.sql', '2026-11-17T00:00:00Z'),
			('002_v1_1_upgrade.sql', '2026-11-17T00:00:00Z'),
			('003_provider_local_request.sql', '2026-11-17T00:00:00Z');
		INSERT INTO providers (id, name, adapter, base_url, auth_type, local_request, created_at, updated_at)
			VALUES ('p-loc', 'Local', 'generic-http', 'http://127.0.0.1:11434/v1', 'none', 1, '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z');
		INSERT INTO assistants (id, name, is_default, created_at, updated_at)
			VALUES ('coder', 'Coder', 0, '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z');
		-- Insert 3 rows for default assistant with identical updated_at; IDs intentionally out of alphabetical order vs rowid DESC.
		INSERT INTO conversations (id, assistant_id, title, created_at, updated_at) VALUES
			('id-z-first-inserted', 'default', 'C', '2026-11-17T08:00:00Z', '2026-11-17T09:00:00Z'),
			('id-a-second-inserted', 'default', 'B', '2026-11-17T08:00:00Z', '2026-11-17T09:00:00Z'),
			('id-m-last-inserted', 'default', 'A', '2026-11-17T08:00:00Z', '2026-11-17T09:00:00Z'),
			('id-coder-1', 'coder', 'Coder 1', '2026-11-17T08:00:00Z', '2026-11-17T10:00:00Z');
		INSERT INTO messages (id, conversation_id, role, blocks_json, created_at)
			VALUES ('msg-keep', 'id-a-second-inserted', 'user', '[{"type":"text","text":"preserved"}]', '2026-11-17T09:00:00Z');
	`); err != nil {
		t.Fatalf("seed 003 db: %v", err)
	}
	_ = rawDB.Close()

	// Upgrade via OpenSQLite and re-open to test idempotency.
	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite 003->004 failed: %v", err)
	}
	_ = db.Close()
	db, err = OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("second OpenSQLite failed: %v", err)
	}
	defer db.Close()

	convs := NewConversationStore(db)
	msgs := NewMessageStore(db)
	provs := NewProviderStore(db)
	assistants := NewAssistantStore(db)

	prov, err := provs.Get(ctx, "p-loc")
	if err != nil || !prov.LocalRequest {
		t.Fatalf("expected local_request preserved after 004 migration: err=%v prov=%+v", err, prov)
	}
	savedMsgs, err := msgs.ListByConversation(ctx, "id-a-second-inserted")
	if err != nil || len(savedMsgs) != 1 || savedMsgs[0].Blocks[0].Text != "preserved" {
		t.Fatalf("expected messages preserved: err=%v msgs=%+v", err, savedMsgs)
	}

	// Tie-breaker rowid DESC must preserve A (rowid 3) -> B (rowid 2) -> C (rowid 1), NOT alphabetical ID order.
	defList, err := convs.ListByAssistant(ctx, "default")
	if err != nil || len(defList) != 3 {
		t.Fatalf("unexpected default list: err=%v list=%+v", err, defList)
	}
	if defList[0].Title != "A" || defList[1].Title != "B" || defList[2].Title != "C" {
		t.Fatalf("expected A, B, C preserving rowid DESC tie-breaker, got %s, %s, %s", defList[0].Title, defList[1].Title, defList[2].Title)
	}
	origRankA, origRankB, origRankC := defList[0].SortOrder, defList[1].SortOrder, defList[2].SortOrder

	// TouchUpdatedAt and Update on C must NOT change C's rank or bump C above A/B!
	if err := convs.TouchUpdatedAt(ctx, defList[2].ID, time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatalf("TouchUpdatedAt failed: %v", err)
	}
	cFetched, _ := convs.Get(ctx, defList[2].ID)
	cFetched.Title = "C Renamed"
	cFetched.ModelID = "new-model"
	if _, err := convs.Update(ctx, cFetched); err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	afterMeta, _ := convs.ListByAssistant(ctx, "default")
	if afterMeta[0].ID != defList[0].ID || afterMeta[1].ID != defList[1].ID || afterMeta[2].ID != defList[2].ID {
		t.Fatalf("expected order unchanged after touch/update, got %+v", afterMeta)
	}
	if afterMeta[0].SortOrder != origRankA || afterMeta[1].SortOrder != origRankB || afterMeta[2].SortOrder != origRankC {
		t.Fatalf("expected existing ranks unchanged, got %d,%d,%d want %d,%d,%d",
			afterMeta[0].SortOrder, afterMeta[1].SortOrder, afterMeta[2].SortOrder, origRankA, origRankB, origRankC)
	}

	// Create puts new conversation at head of ungrouped WITHOUT altering A/B/C ranks.
	newConv, err := convs.Create(ctx, domain.Conversation{AssistantID: "default", Title: "D New"})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	afterCreate, _ := convs.ListByAssistant(ctx, "default")
	if len(afterCreate) != 4 || afterCreate[0].ID != newConv.ID ||
		afterCreate[1].SortOrder != origRankA || afterCreate[2].SortOrder != origRankB || afterCreate[3].SortOrder != origRankC {
		t.Fatalf("expected new item at head without mutating existing ranks: %+v", afterCreate)
	}

	// Delete custom assistant cleans up its groups and preserves conversations.
	if _, err := db.ExecContext(ctx, `
		INSERT INTO conversation_groups (id, assistant_id, name, sort_order, created_at)
		VALUES ('g-coder', 'coder', 'Coder Group', 1, '2026-11-17T08:00:00Z');
		UPDATE conversations SET group_id = 'g-coder' WHERE id = 'id-coder-1';
	`); err != nil {
		t.Fatalf("seed coder group: %v", err)
	}
	if err := assistants.Delete(ctx, "coder"); err != nil {
		t.Fatalf("delete assistant failed: %v", err)
	}
	var groupCount int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversation_groups WHERE assistant_id = 'coder'`).Scan(&groupCount)
	if groupCount != 0 {
		t.Fatalf("expected coder groups cleaned up, got %d", groupCount)
	}
	reassignedCoder, err := convs.Get(ctx, "id-coder-1")
	if err != nil || reassignedCoder.AssistantID != domain.DefaultAssistantID || reassignedCoder.GroupID != nil {
		t.Fatalf("expected reassigned coder conversation in default ungrouped, got err=%v conv=%+v", err, reassignedCoder)
	}
}

func TestMessageUsageCacheStatsAndLegacyJSONCompatibility(t *testing.T) {
	ctx := context.Background()
	db, err := OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	convs := NewConversationStore(db)
	msgs := NewMessageStore(db)
	conv, err := convs.Create(ctx, domain.Conversation{Title: "Usage Test"})
	if err != nil {
		t.Fatalf("create conv: %v", err)
	}

	// Legacy usage JSON without cacheReadInputTokens / cacheCreationInputTokens decodes cleanly.
	if _, err := db.ExecContext(ctx, `
		INSERT INTO messages (id, conversation_id, role, blocks_json, usage_json, stop_reason, created_at)
		VALUES ('m-legacy', ?, 'assistant', '[{"type":"text","text":"old"}]', '{"inputTokens":12,"outputTokens":8,"totalTokens":20}', 'stop', '2026-11-17T08:00:00Z')
	`, conv.ID); err != nil {
		t.Fatalf("insert legacy msg: %v", err)
	}
	legacy, err := msgs.Get(ctx, "m-legacy")
	if err != nil || legacy.Usage == nil || legacy.Usage.InputTokens != 12 || legacy.Usage.CacheReadInputTokens != 0 || legacy.Usage.CacheCreationInputTokens != 0 {
		t.Fatalf("unexpected legacy usage decode: err=%v msg=%+v", err, legacy)
	}

	// Message with cache stats round-trips cleanly.
	created, err := msgs.Create(ctx, domain.Message{
		ConversationID: conv.ID,
		Role:           domain.RoleAssistant,
		Blocks:         []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "cached"}},
		Usage: &domain.Usage{
			InputTokens:              1000,
			OutputTokens:             40,
			CacheReadInputTokens:     750,
			CacheCreationInputTokens: 200,
			TotalTokens:              1040,
		},
		StopReason: domain.StopReasonStop,
	})
	if err != nil {
		t.Fatalf("create cached msg: %v", err)
	}
	reloaded, err := msgs.Get(ctx, created.ID)
	if err != nil || reloaded.Usage == nil || reloaded.Usage.CacheReadInputTokens != 750 || reloaded.Usage.CacheCreationInputTokens != 200 {
		t.Fatalf("expected persisted cache usage, got err=%v msg=%+v", err, reloaded)
	}
}
