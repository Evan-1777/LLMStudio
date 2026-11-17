package store

import (
	"context"
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
