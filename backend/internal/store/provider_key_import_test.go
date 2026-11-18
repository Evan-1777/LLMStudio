package store

import (
	"context"
	"path/filepath"
	"testing"

	"llmstudio/backend/internal/domain"
)

func newKeyImportProvider(t *testing.T, dbPath, id string, localRequest bool) *ProviderStore {
	t.Helper()
	ctx := context.Background()
	db, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := NewProviderStore(db)
	if _, err := store.Create(ctx, domain.ProviderConfig{
		ID:           id,
		Name:         id,
		Adapter:      "generic-http",
		BaseURL:      "https://example.com",
		AuthType:     domain.AuthTypeBearer,
		LocalRequest: localRequest,
	}); err != nil {
		t.Fatalf("create provider %s: %v", id, err)
	}
	return store
}

func TestImportAPIKeyConditions(t *testing.T) {
	ctx := context.Background()
	providers := newKeyImportProvider(t, filepath.Join(t.TempDir(), "main.db"), "local", true)

	// A credential written by the gateway is never replaced by a browser copy.
	managed := domain.ProviderConfig{
		ID: "local", Name: "local", Adapter: "generic-http",
		BaseURL: "https://example.com", AuthType: domain.AuthTypeBearer,
		LocalRequest: true, APIKey: "sk-server",
	}
	managed.MarkAPIKeyManaged()
	if _, err := providers.Update(ctx, managed); err != nil {
		t.Fatalf("set managed key: %v", err)
	}
	outcome, err := providers.ImportAPIKey(ctx, "local", "sk-browser")
	if err != nil {
		t.Fatalf("import over managed key: %v", err)
	}
	if outcome != KeyImportAlreadyManaged {
		t.Fatalf("expected already managed, got %v", outcome)
	}
	cfg, err := providers.Get(ctx, "local")
	if err != nil {
		t.Fatalf("get provider: %v", err)
	}
	if cfg.APIKey != "sk-server" {
		t.Fatalf("managed key overwritten: %q", cfg.APIKey)
	}

	// Clearing marks the credential gateway-owned so a stale copy cannot revive it.
	clearedInput := domain.ProviderConfig{
		ID: "local", Name: "local", Adapter: "generic-http",
		BaseURL: "https://example.com", AuthType: domain.AuthTypeBearer,
		LocalRequest: true, APIKey: "",
	}
	clearedInput.MarkAPIKeyManaged()
	cleared, err := providers.Update(ctx, clearedInput)
	if err != nil {
		t.Fatalf("clear key: %v", err)
	}
	if cleared.APIKeyManaged() != true {
		t.Fatal("explicit clear did not keep the credential managed")
	}
	if outcome, err = providers.ImportAPIKey(ctx, "local", "sk-revive"); err != nil || outcome != KeyImportAlreadyManaged {
		t.Fatalf("cleared key was revived: outcome=%v err=%v", outcome, err)
	}

	// A fresh unmanaged local-request provider accepts exactly one non-empty import.
	freshStore := newKeyImportProvider(t, filepath.Join(t.TempDir(), "fresh.db"), "fresh", true)
	if outcome, err = freshStore.ImportAPIKey(ctx, "fresh", "  sk-adopted  "); err != nil || outcome != KeyImportApplied {
		t.Fatalf("first import: outcome=%v err=%v", outcome, err)
	}
	adopted, err := freshStore.Get(ctx, "fresh")
	if err != nil {
		t.Fatalf("get adopted provider: %v", err)
	}
	if adopted.APIKey != "sk-adopted" || !adopted.APIKeyManaged() {
		t.Fatalf("import did not trim/store the key or mark it managed: %+v", adopted)
	}
	if outcome, err = freshStore.ImportAPIKey(ctx, "fresh", "sk-second"); err != nil || outcome != KeyImportAlreadyManaged {
		t.Fatalf("replayed import: outcome=%v err=%v", outcome, err)
	}

	// Empty keys are rejected without touching the stored value.
	if outcome, err = freshStore.ImportAPIKey(ctx, "fresh", "   "); err != nil || outcome != KeyImportAlreadyManaged {
		t.Fatalf("empty import: outcome=%v err=%v", outcome, err)
	}

	// Non-local-request providers and unknown ids keep their own outcomes.
	forwardStore := newKeyImportProvider(t, filepath.Join(t.TempDir(), "fwd.db"), "fwd", false)
	if outcome, err = forwardStore.ImportAPIKey(ctx, "fwd", "sk-x"); err != nil || outcome != KeyImportNotEligible {
		t.Fatalf("forward import: outcome=%v err=%v", outcome, err)
	}
	if outcome, err = forwardStore.ImportAPIKey(ctx, "missing", "sk-x"); err != nil || outcome != KeyImportNotFound {
		t.Fatalf("missing import: outcome=%v err=%v", outcome, err)
	}
}
