package agent

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

func TestWorkspaceExtensionlessTextAndBinary(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rt := NewGateway(store.NewAgentStore(db), dir, true)
	entry, err := rt.CreateWorkspaceFile(ctx, "notes", "")
	if err != nil || entry.PreviewKind != "text" || !entry.Editable {
		t.Fatalf("create: %+v %v", entry, err)
	}
	doc, err := rt.ReadWorkspaceFile(ctx, "notes")
	if err != nil || !doc.Editable || doc.Content != "" {
		t.Fatalf("read: %+v %v", doc, err)
	}
	if _, err := rt.WriteWorkspaceFile(ctx, "notes", "工作记录", doc.ETag); err != nil {
		t.Fatal(err)
	}
	doc, err = rt.ReadWorkspaceFile(ctx, "notes")
	if err != nil || doc.Content != "工作记录" {
		t.Fatalf("saved: %+v %v", doc, err)
	}
	for name, data := range map[string][]byte{"nul": {0}, "invalid": {0xff}} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := rt.ReadWorkspaceFile(ctx, name); err == nil {
			t.Fatalf("read accepted %s", name)
		}
		if _, err := rt.WriteWorkspaceFile(ctx, name, "overwrite", ""); err == nil {
			t.Fatalf("write accepted %s", name)
		}
	}
	listing, err := rt.ListWorkspaceEntries(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 3 {
		t.Fatalf("listing: %+v", listing)
	}
	for _, entry := range listing.Entries {
		if entry.Name == "notes" {
			if entry.PreviewKind != "text" || !entry.Editable {
				t.Fatalf("listing text: %+v", entry)
			}
		} else if entry.PreviewKind != "unsupported" || entry.Editable || entry.UnsupportedReason != "binary" {
			t.Fatalf("listing binary: %+v", entry)
		}
	}
}

func TestWorkspaceWritePermission(t *testing.T) {
	for _, tc := range []struct {
		err  error
		text string
	}{{os.ErrPermission, "工作区目录无写入权限"}, {syscall.EROFS, "工作区目录为只读状态"}} {
		err := mapWorkspaceWriteError(&os.PathError{Op: "create", Path: "notes", Err: tc.err}, "无法创建文件")
		if !strings.Contains(err.Error(), tc.text) {
			t.Fatalf("mapped error: %v", err)
		}
	}
	ctx := t.Context()
	dir := t.TempDir()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rt := NewGateway(store.NewAgentStore(db), dir, true)
	if err := os.Chmod(dir, 0500); err != nil {
		t.Skipf("chmod unavailable: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	if err := os.WriteFile(filepath.Join(dir, "permission-probe"), nil, 0600); !errors.Is(err, os.ErrPermission) {
		t.Skipf("runner does not enforce directory write mode: %v", err)
	}
	_, fileErr := rt.CreateWorkspaceFile(ctx, "notes", "")
	_, dirErr := rt.CreateWorkspaceDir(ctx, "docs")
	_, nestedErr := rt.CreateWorkspaceFile(ctx, "new/notes", "")
	for _, err := range []error{fileErr, dirErr, nestedErr} {
		if err == nil || !strings.Contains(err.Error(), "权限") {
			t.Fatalf("write error: %v", err)
		}
	}
}

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

func TestWorkspaceManagementOperationsAndSecurity(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	outside := t.TempDir()

	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("OUTSIDE"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "config"), []byte("git-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(outside, filepath.Join(dir, "sym-dir"))
	_ = os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "sym-file.txt"))

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rt := NewGateway(store.NewAgentStore(db), dir, true)

	assertCode := func(err error, want string) {
		t.Helper()
		var appErr *domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != want {
			t.Fatalf("expected error code %s, got %v", want, err)
		}
	}

	// 1. CreateWorkspaceFile: nested parent dir, conflict, NUL & >2 MiB rejection.
	created, err := rt.CreateWorkspaceFile(ctx, "docs/sub/guide.md", "# Guide\n")
	if err != nil || created.Path != "docs/sub/guide.md" || created.PreviewKind != "markdown" || !created.Editable {
		t.Fatalf("CreateWorkspaceFile: %+v err=%v", created, err)
	}
	_, err = rt.CreateWorkspaceFile(ctx, "docs/sub/guide.md", "dup")
	assertCode(err, domain.ErrCodeConflict)
	_, err = rt.CreateWorkspaceFile(ctx, "bad-nul.txt", "a\x00b")
	assertCode(err, domain.ErrCodeInvalidArgument)
	_, err = rt.CreateWorkspaceFile(ctx, "too-big.txt", strings.Repeat("a", maxFile+1))
	assertCode(err, domain.ErrCodeInvalidArgument)

	// New text extensions classified as text/editable.
	nixEntry, err := rt.CreateWorkspaceFile(ctx, "flake.nix", "{}\n")
	if err != nil || nixEntry.PreviewKind != "text" || !nixEntry.Editable {
		t.Fatalf("expected .nix text editable, got %+v err=%v", nixEntry, err)
	}

	// 2. CreateWorkspaceDir: nested dir & conflict.
	dirEntry, err := rt.CreateWorkspaceDir(ctx, "projects/alpha/nested")
	if err != nil || dirEntry.Kind != "dir" || dirEntry.Path != "projects/alpha/nested" {
		t.Fatalf("CreateWorkspaceDir: %+v err=%v", dirEntry, err)
	}
	_, err = rt.CreateWorkspaceDir(ctx, "projects/alpha/nested")
	assertCode(err, domain.ErrCodeConflict)

	// 3. MoveWorkspaceEntry: rename, cross-dir move, self/subdir rejection, conflict.
	renamed, err := rt.MoveWorkspaceEntry(ctx, "docs/sub/guide.md", "docs/sub/readme.md")
	if err != nil || renamed.Path != "docs/sub/readme.md" {
		t.Fatalf("MoveWorkspaceEntry rename: %+v err=%v", renamed, err)
	}
	moved, err := rt.MoveWorkspaceEntry(ctx, "docs/sub/readme.md", "projects/alpha/readme.md")
	if err != nil || moved.Path != "projects/alpha/readme.md" {
		t.Fatalf("MoveWorkspaceEntry cross-dir: %+v err=%v", moved, err)
	}
	_, err = rt.MoveWorkspaceEntry(ctx, "projects/alpha", "projects/alpha/nested/self")
	assertCode(err, domain.ErrCodeInvalidArgument)
	_, err = rt.MoveWorkspaceEntry(ctx, "projects/alpha", "projects/alpha")
	assertCode(err, domain.ErrCodeInvalidArgument)
	_, err = rt.CreateWorkspaceFile(ctx, "projects/alpha/conflict.txt", "orig")
	if err != nil {
		t.Fatal(err)
	}
	_, err = rt.MoveWorkspaceEntry(ctx, "projects/alpha/readme.md", "projects/alpha/conflict.txt")
	assertCode(err, domain.ErrCodeConflict)

	// 4. CopyWorkspaceEntry: file & recursive dir (skips symlinks), conflict, self/subdir rejection.
	copiedFile, err := rt.CopyWorkspaceEntry(ctx, "projects/alpha/readme.md", "projects/alpha/readme copy.md")
	if err != nil || copiedFile.Path != "projects/alpha/readme copy.md" {
		t.Fatalf("CopyWorkspaceEntry file: %+v err=%v", copiedFile, err)
	}
	_ = os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "projects", "alpha", "inner-sym.txt"))
	copiedDir, err := rt.CopyWorkspaceEntry(ctx, "projects/alpha", "projects/alpha-copy")
	if err != nil || copiedDir.Kind != "dir" {
		t.Fatalf("CopyWorkspaceEntry dir: %+v err=%v", copiedDir, err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "projects", "alpha-copy", "inner-sym.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected symlink skipped during recursive copy, got err=%v", err)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "projects", "alpha-copy", "readme.md")); err != nil || string(data) != "# Guide\n" {
		t.Fatalf("copied dir file content mismatch: %q err=%v", string(data), err)
	}
	_, err = rt.CopyWorkspaceEntry(ctx, "projects/alpha", "projects/alpha-copy")
	assertCode(err, domain.ErrCodeConflict)
	_, err = rt.CopyWorkspaceEntry(ctx, "projects/alpha", "projects/alpha/nested/loop")
	assertCode(err, domain.ErrCodeInvalidArgument)

	// 5. UploadWorkspaceFile: new, conflict, overwrite, dir/symlink rejection, >32 MiB.
	binData := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff}
	uploaded, err := rt.UploadWorkspaceFile(ctx, "projects/photo.png", bytes.NewReader(binData), false)
	if err != nil || uploaded.Size != int64(len(binData)) || uploaded.UnsupportedReason != "image" {
		t.Fatalf("UploadWorkspaceFile: %+v err=%v", uploaded, err)
	}
	_, err = rt.UploadWorkspaceFile(ctx, "projects/photo.png", bytes.NewReader([]byte("v2")), false)
	assertCode(err, domain.ErrCodeConflict)
	overwritten, err := rt.UploadWorkspaceFile(ctx, "projects/photo.png", bytes.NewReader([]byte("v2-bytes")), true)
	if err != nil || overwritten.Size != 8 {
		t.Fatalf("UploadWorkspaceFile overwrite: %+v err=%v", overwritten, err)
	}
	_, err = rt.UploadWorkspaceFile(ctx, "projects/alpha", bytes.NewReader([]byte("x")), true)
	assertCode(err, domain.ErrCodeInvalidArgument)
	_, err = rt.UploadWorkspaceFile(ctx, "sym-file.txt", bytes.NewReader([]byte("x")), true)
	assertCode(err, domain.ErrCodeInvalidArgument)
	_, err = rt.UploadWorkspaceFile(ctx, "projects/huge.bin", io.LimitReader(zeroReader{}, maxWorkspaceUploadBytes+1), false)
	assertCode(err, domain.ErrCodePayloadTooLarge)

	// 6. OpenWorkspaceFileDownload: text & binary, reject dir & symlink.
	f, info, base, closeFn, err := rt.OpenWorkspaceFileDownload(ctx, "projects/photo.png")
	if err != nil || base != "photo.png" || info.Size() != 8 {
		t.Fatalf("OpenWorkspaceFileDownload: base=%q info=%v err=%v", base, info, err)
	}
	gotBytes, _ := io.ReadAll(f)
	closeFn()
	if string(gotBytes) != "v2-bytes" {
		t.Fatalf("downloaded bytes mismatch: %q", string(gotBytes))
	}
	if _, _, _, _, err := rt.OpenWorkspaceFileDownload(ctx, "projects/alpha"); err == nil {
		t.Fatal("expected directory download rejection")
	}
	if _, _, _, _, err := rt.OpenWorkspaceFileDownload(ctx, "sym-file.txt"); err == nil {
		t.Fatal("expected symlink download rejection")
	}

	// 7. SearchWorkspaceEntries: cross-dir, skips .git & symlinks, case-insensitive, sorting.
	searchRes, err := rt.SearchWorkspaceEntries(ctx, "README.MD")
	if err != nil || len(searchRes.Entries) < 2 {
		t.Fatalf("SearchWorkspaceEntries: %+v err=%v", searchRes, err)
	}
	if searchRes.Entries[0].Name != "readme.md" {
		t.Fatalf("expected exact basename match first, got %+v", searchRes.Entries)
	}
	gitSearch, err := rt.SearchWorkspaceEntries(ctx, "config")
	if err != nil || len(gitSearch.Entries) != 0 {
		t.Fatalf("expected .git skipped in search, got %+v err=%v", gitSearch, err)
	}
	symSearch, err := rt.SearchWorkspaceEntries(ctx, "sym-")
	if err != nil || len(symSearch.Entries) != 0 {
		t.Fatalf("expected symlinks skipped in search, got %+v err=%v", symSearch, err)
	}

	// 8. DeleteWorkspaceEntry: file & non-empty dir, reject root & symlink.
	if err := rt.DeleteWorkspaceEntry(ctx, "."); err == nil {
		t.Fatal("expected root delete rejection")
	}
	assertCode(rt.DeleteWorkspaceEntry(ctx, "sym-file.txt"), domain.ErrCodeInvalidArgument)
	assertCode(rt.DeleteWorkspaceEntry(ctx, "sym-dir"), domain.ErrCodeInvalidArgument)
	if err := rt.DeleteWorkspaceEntry(ctx, "projects/alpha-copy"); err != nil {
		t.Fatalf("DeleteWorkspaceEntry dir: %v", err)
	}

	// 9. BatchWorkspaceEntries: batch move (partial success + conflict) & batch delete (ancestor dedup).
	_, _ = rt.CreateWorkspaceDir(ctx, "dest")
	_, _ = rt.CreateWorkspaceFile(ctx, "dest/conflict.txt", "already-there")
	moveBatch, err := rt.BatchWorkspaceEntries(ctx, "move", []string{
		"projects/alpha/readme.md",
		"projects/alpha/conflict.txt",
	}, "dest")
	if err != nil {
		t.Fatalf("BatchWorkspaceEntries move: %v", err)
	}
	if len(moveBatch.Succeeded) != 1 || moveBatch.Succeeded[0] != "projects/alpha/readme.md" || len(moveBatch.Failed) != 1 || moveBatch.Failed[0].Code != domain.ErrCodeConflict {
		t.Fatalf("unexpected batch move result: %+v", moveBatch)
	}
	delBatch, err := rt.BatchWorkspaceEntries(ctx, "delete", []string{
		"dest",
		"dest/readme.md",
		"dest/conflict.txt",
		"flake.nix",
	}, "")
	if err != nil {
		t.Fatalf("BatchWorkspaceEntries delete: %v", err)
	}
	if len(delBatch.Failed) != 0 || len(delBatch.Succeeded) != 2 {
		t.Fatalf("expected ancestor-deduped batch delete (dest + flake.nix), got %+v", delBatch)
	}

	// 10. Security negatives across all new methods + unauthorized & desktop local runtimes.
	for _, bad := range []string{"../escape.txt", "/etc/passwd", "sym-dir/secret.txt", "sym-file.txt"} {
		if _, err := rt.CreateWorkspaceFile(ctx, bad, "x"); err == nil {
			t.Fatalf("CreateWorkspaceFile %q should fail", bad)
		}
		if _, err := rt.CreateWorkspaceDir(ctx, bad); err == nil {
			t.Fatalf("CreateWorkspaceDir %q should fail", bad)
		}
		if _, err := rt.MoveWorkspaceEntry(ctx, bad, "docs/ok.txt"); err == nil {
			t.Fatalf("MoveWorkspaceEntry from %q should fail", bad)
		}
		if _, err := rt.CopyWorkspaceEntry(ctx, bad, "docs/ok.txt"); err == nil {
			t.Fatalf("CopyWorkspaceEntry from %q should fail", bad)
		}
		if err := rt.DeleteWorkspaceEntry(ctx, bad); err == nil {
			t.Fatalf("DeleteWorkspaceEntry %q should fail", bad)
		}
		if _, err := rt.UploadWorkspaceFile(ctx, bad, strings.NewReader("x"), true); err == nil {
			t.Fatalf("UploadWorkspaceFile %q should fail", bad)
		}
	}

	unauth := NewGateway(store.NewAgentStore(db), dir, false)
	_, err = unauth.CreateWorkspaceFile(ctx, "a.txt", "x")
	assertCode(err, domain.ErrCodeUnauthorized)
	_, err = unauth.SearchWorkspaceEntries(ctx, "a")
	assertCode(err, domain.ErrCodeUnauthorized)

	localOnly := NewDesktop(store.NewAgentStore(db))
	_, err = localOnly.CreateWorkspaceFile(ctx, "a.txt", "x")
	assertCode(err, domain.ErrCodeNotFound)
	_, err = localOnly.SearchWorkspaceEntries(ctx, "a")
	assertCode(err, domain.ErrCodeNotFound)
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}
