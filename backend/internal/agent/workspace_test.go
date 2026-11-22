package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

func TestWorkspaceBrowserListingReadWriteAndSecurity(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	outside := t.TempDir()

	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("OUTSIDE"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".agent", "skills", "demo"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".agent", "skills", "demo", "SKILL.md"), []byte("# Demo Skill\nHello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Root Readme"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.ts"), []byte("export const x = 1;\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "logo.png"), []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "archive.bin"), []byte{0x00, 0x01, 0x02}, 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(outside, filepath.Join(dir, "escape-dir"))
	_ = os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "escape.txt"))

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rt := NewGateway(store.NewAgentStore(db), dir, true)

	// 1. Listing sorts directories first, shows dotfiles like .agent, skips symlinks, and classifies files.
	listing, err := rt.ListWorkspaceEntries(ctx, "")
	if err != nil {
		t.Fatalf("ListWorkspaceEntries root: %v", err)
	}
	if listing.Truncated || len(listing.Entries) != 5 {
		t.Fatalf("unexpected root listing: %+v", listing)
	}
	if listing.Entries[0].Name != ".agent" || listing.Entries[0].Kind != "dir" {
		t.Fatalf("expected .agent dir first, got %+v", listing.Entries[0])
	}
	var seenNames []string
	for _, e := range listing.Entries {
		seenNames = append(seenNames, e.Name)
		switch e.Name {
		case "README.md":
			if e.PreviewKind != "markdown" || !e.Editable {
				t.Fatalf("unexpected README classification: %+v", e)
			}
		case "app.ts":
			if e.PreviewKind != "text" || !e.Editable {
				t.Fatalf("unexpected app.ts classification: %+v", e)
			}
		case "logo.png":
			if e.PreviewKind != "unsupported" || e.Editable || e.UnsupportedReason != "image" {
				t.Fatalf("unexpected logo.png classification: %+v", e)
			}
		case "archive.bin":
			if e.PreviewKind != "unsupported" || e.Editable || e.UnsupportedReason != "binary" {
				t.Fatalf("unexpected archive.bin classification: %+v", e)
			}
		case "escape-dir", "escape.txt":
			t.Fatalf("symlink escaped into listing: %+v", e)
		}
	}

	// Subdirectory listing works for .agent/skills/demo.
	sub, err := rt.ListWorkspaceEntries(ctx, ".agent/skills/demo")
	if err != nil || len(sub.Entries) != 1 || sub.Entries[0].Path != ".agent/skills/demo/SKILL.md" {
		t.Fatalf("unexpected sub listing: %+v err=%v", sub, err)
	}

	// 2. Traversal and symlinks are rejected on list, read, and write.
	for _, bad := range []string{"../secret.txt", "/etc/passwd", "escape.txt", "escape-dir/secret.txt"} {
		if _, err := rt.ListWorkspaceEntries(ctx, bad); err == nil {
			t.Fatalf("expected list %q to fail", bad)
		}
		if _, err := rt.ReadWorkspaceFile(ctx, bad); err == nil {
			t.Fatalf("expected read %q to fail", bad)
		}
		if _, err := rt.WriteWorkspaceFile(ctx, bad, "x", ""); err == nil {
			t.Fatalf("expected write %q to fail", bad)
		}
	}

	// 3. Images and binary files are rejected on read and write.
	docImgErr, err := rt.ReadWorkspaceFile(ctx, "logo.png")
	if err == nil || !strings.Contains(err.Error(), "图片暂不支持预览") {
		t.Fatalf("expected image unsupported error, got %+v err=%v", docImgErr, err)
	}
	if _, err := rt.ReadWorkspaceFile(ctx, "archive.bin"); err == nil {
		t.Fatal("expected binary file read rejection")
	}
	if _, err := rt.WriteWorkspaceFile(ctx, "logo.png", "not-png", ""); err == nil {
		t.Fatal("expected image write rejection")
	}

	// 4. Read + ETag optimistic lock + conflict + force overwrite + creating new files disallowed.
	doc, err := rt.ReadWorkspaceFile(ctx, ".agent/skills/demo/SKILL.md")
	if err != nil {
		t.Fatalf("ReadWorkspaceFile: %v", err)
	}
	if doc.PreviewKind != "markdown" || !doc.Editable || doc.ETag == "" || !strings.Contains(doc.Content, "Demo Skill") {
		t.Fatalf("unexpected doc: %+v", doc)
	}

	// Wrong ETag fails with ErrCodeConflict and leaves file untouched.
	_, err = rt.WriteWorkspaceFile(ctx, ".agent/skills/demo/SKILL.md", "corrupted", "deadbeef")
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeConflict {
		t.Fatalf("expected CONFLICT error, got %v", err)
	}
	afterConflict, err := rt.ReadWorkspaceFile(ctx, ".agent/skills/demo/SKILL.md")
	if err != nil || afterConflict.Content != doc.Content {
		t.Fatalf("file changed after conflict: %+v err=%v", afterConflict, err)
	}

	// Matching ETag updates atomically and returns new ETag.
	saved, err := rt.WriteWorkspaceFile(ctx, ".agent/skills/demo/SKILL.md", "# Updated Skill\n", doc.ETag)
	if err != nil || saved.ETag == "" || saved.ETag == doc.ETag {
		t.Fatalf("WriteWorkspaceFile: %+v err=%v", saved, err)
	}
	// Empty ETag forces overwrite.
	forced, err := rt.WriteWorkspaceFile(ctx, ".agent/skills/demo/SKILL.md", "# Forced Skill\n", "")
	if err != nil || forced.ETag == saved.ETag {
		t.Fatalf("forced WriteWorkspaceFile: %+v err=%v", forced, err)
	}
	// Saving nonexistent file is rejected.
	if _, err := rt.WriteWorkspaceFile(ctx, "new-file.md", "hi", ""); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeNotFound {
		t.Fatalf("expected NOT_FOUND for nonexistent file, got %v", err)
	}

	// 5. Unauthorized and non-gateway runtimes are rejected.
	unauth := NewGateway(store.NewAgentStore(db), dir, false)
	if _, err := unauth.ListWorkspaceEntries(ctx, ""); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeUnauthorized {
		t.Fatalf("expected UNAUTHORIZED, got %v", err)
	}
	localOnly := NewDesktop(store.NewAgentStore(db))
	if _, err := localOnly.ListWorkspaceEntries(ctx, ""); !errors.As(err, &appErr) || appErr.Code != domain.ErrCodeNotFound {
		t.Fatalf("expected NOT_FOUND on desktop local runtime, got %v", err)
	}
}

func TestWorkspaceListingTruncatesAt500Entries(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	for i := 0; i < 510; i++ {
		name := fmt.Sprintf("file-%03d.txt", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rt := NewGateway(store.NewAgentStore(db), dir, true)
	res, err := rt.ListWorkspaceEntries(ctx, "")
	if err != nil {
		t.Fatalf("ListWorkspaceEntries: %v", err)
	}
	if !res.Truncated || len(res.Entries) != 500 || res.Entries[0].Name != "file-000.txt" || res.Entries[499].Name != "file-499.txt" {
		t.Fatalf("unexpected truncation result: len=%d truncated=%v", len(res.Entries), res.Truncated)
	}
}
