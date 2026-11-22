package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"llmstudio/backend/internal/domain"
)

const maxWorkspaceListEntries = 500

// WorkspaceEntry describes a single directory or file entry in the gateway workspace browser.
type WorkspaceEntry struct {
	Name              string `json:"name"`
	Path              string `json:"path"`
	Kind              string `json:"kind"`
	Size              int64  `json:"size"`
	ModTime           string `json:"modTime"`
	PreviewKind       string `json:"previewKind,omitempty"`
	Editable          bool   `json:"editable"`
	UnsupportedReason string `json:"unsupportedReason,omitempty"`
}

// WorkspaceEntriesResponse is returned by ListWorkspaceEntries.
type WorkspaceEntriesResponse struct {
	Path      string           `json:"path"`
	Entries   []WorkspaceEntry `json:"entries"`
	Truncated bool             `json:"truncated"`
}

// WorkspaceFileDocument is returned by ReadWorkspaceFile for previewable text and Markdown files.
type WorkspaceFileDocument struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ModTime     string `json:"modTime"`
	PreviewKind string `json:"previewKind"`
	Editable    bool   `json:"editable"`
	ETag        string `json:"etag"`
	Content     string `json:"content"`
}

// WorkspaceFileWriteResult is returned after saving a workspace file.
type WorkspaceFileWriteResult struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ModTime     string `json:"modTime"`
	PreviewKind string `json:"previewKind"`
	Editable    bool   `json:"editable"`
	ETag        string `json:"etag"`
}

var markdownExtensions = map[string]bool{
	".md":       true,
	".markdown": true,
	".mdx":      true,
}

var textExtensions = map[string]bool{
	".txt": true, ".log": true, ".csv": true, ".tsv": true, ".rst": true, ".org": true, ".tex": true,
	".json": true, ".jsonc": true, ".jsonl": true, ".yaml": true, ".yml": true, ".toml": true,
	".ini": true, ".cfg": true, ".conf": true, ".env": true, ".properties": true, ".xml": true, ".plist": true,
	".html": true, ".htm": true, ".css": true, ".scss": true, ".less": true, ".svg": true,
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".go": true, ".py": true, ".rs": true, ".java": true, ".kt": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cc": true, ".cs": true,
	".rb": true, ".php": true, ".swift": true, ".sh": true, ".bash": true, ".zsh": true,
	".ps1": true, ".bat": true, ".cmd": true, ".sql": true, ".graphql": true, ".proto": true,
	".dockerfile": true, ".mk": true, ".lua": true, ".r": true, ".vue": true, ".svelte": true,
	".astro": true, ".diff": true, ".patch": true,
}

var textBasenames = map[string]bool{
	"dockerfile":     true,
	"makefile":       true,
	"license":        true,
	"readme":         true,
	"changelog":      true,
	".gitignore":     true,
	".dockerignore":  true,
	".editorconfig":  true,
	".gitattributes": true,
	".npmrc":         true,
}

var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".bmp": true, ".ico": true, ".avif": true, ".tif": true, ".tiff": true, ".heic": true,
}

func classifyWorkspaceFile(name string) (previewKind string, editable bool, unsupportedReason string) {
	lowerName := strings.ToLower(strings.TrimSpace(name))
	ext := strings.ToLower(path.Ext(lowerName))
	if markdownExtensions[ext] {
		return "markdown", true, ""
	}
	if imageExtensions[ext] {
		return "unsupported", false, "image"
	}
	if textExtensions[ext] || textBasenames[lowerName] || strings.HasPrefix(lowerName, ".env.") {
		return "text", true, ""
	}
	return "unsupported", false, "binary"
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (a *Runtime) openWorkspaceRoot() (*os.Root, error) {
	if err := a.RequireAccess(); err != nil {
		return nil, err
	}
	if !a.gateway {
		return nil, domain.NewError(domain.ErrCodeNotFound, "工作区文件浏览器仅支持网关", nil)
	}
	return a.open(".")
}

func (a *Runtime) ListWorkspaceEntries(ctx context.Context, relPath string) (WorkspaceEntriesResponse, error) {
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceEntriesResponse{}, err
	}
	defer root.Close()

	rel, err := relative(relPath)
	if err != nil {
		return WorkspaceEntriesResponse{}, domain.NewError(domain.ErrCodeInvalidArgument, "无效的工作区路径", err)
	}
	slashRel := filepath.ToSlash(rel)
	targetRoot := root
	if slashRel != "." {
		sub, ok := openRegularSubdir(root, slashRel)
		if !ok {
			return WorkspaceEntriesResponse{}, unavailable()
		}
		defer sub.Close()
		targetRoot = sub
	}

	dirEntries, err := fs.ReadDir(targetRoot.FS(), ".")
	if err != nil {
		return WorkspaceEntriesResponse{}, unavailable()
	}

	items := make([]WorkspaceEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		if err := ctx.Err(); err != nil {
			return WorkspaceEntriesResponse{}, err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		entryPath := entry.Name()
		if slashRel != "." {
			entryPath = path.Join(slashRel, entry.Name())
		}
		modTime := info.ModTime().UTC().Format(time.RFC3339)
		if entry.IsDir() {
			sub, openErr := targetRoot.OpenRoot(entry.Name())
			if openErr != nil {
				continue
			}
			_ = sub.Close()
			items = append(items, WorkspaceEntry{
				Name:    entry.Name(),
				Path:    entryPath,
				Kind:    "dir",
				ModTime: modTime,
			})
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		previewKind, editable, unsupportedReason := classifyWorkspaceFile(entry.Name())
		items = append(items, WorkspaceEntry{
			Name:              entry.Name(),
			Path:              entryPath,
			Kind:              "file",
			Size:              info.Size(),
			ModTime:           modTime,
			PreviewKind:       previewKind,
			Editable:          editable,
			UnsupportedReason: unsupportedReason,
		})
	}

	slices.SortFunc(items, func(a, b WorkspaceEntry) int {
		if a.Kind != b.Kind {
			if a.Kind == "dir" {
				return -1
			}
			return 1
		}
		la, lb := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if c := strings.Compare(la, lb); c != 0 {
			return c
		}
		return strings.Compare(a.Name, b.Name)
	})

	truncated := false
	if len(items) > maxWorkspaceListEntries {
		items = items[:maxWorkspaceListEntries]
		truncated = true
	}
	return WorkspaceEntriesResponse{
		Path:      slashRel,
		Entries:   items,
		Truncated: truncated,
	}, nil
}

func openWorkspaceParent(root *os.Root, relPath string) (*os.Root, string, string, error) {
	rel, err := relative(relPath)
	if err != nil || rel == "." {
		return nil, "", "", domain.NewError(domain.ErrCodeInvalidArgument, "无效的文件路径", err)
	}
	slashRel := filepath.ToSlash(rel)
	dir := path.Dir(slashRel)
	base := path.Base(slashRel)
	if dir == "." {
		return root, slashRel, base, nil
	}
	sub, ok := openRegularSubdir(root, dir)
	if !ok {
		return nil, "", "", domain.NewError(domain.ErrCodeNotFound, "文件所在目录不存在", nil)
	}
	return sub, slashRel, base, nil
}

func (a *Runtime) ReadWorkspaceFile(ctx context.Context, relPath string) (WorkspaceFileDocument, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceFileDocument{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceFileDocument{}, err
	}
	defer root.Close()

	parent, slashRel, base, err := openWorkspaceParent(root, relPath)
	if err != nil {
		return WorkspaceFileDocument{}, err
	}
	if parent != root {
		defer parent.Close()
	}

	info, err := parent.Lstat(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return WorkspaceFileDocument{}, domain.NewError(domain.ErrCodeNotFound, "文件不存在", err)
		}
		return WorkspaceFileDocument{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问文件", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return WorkspaceFileDocument{}, domain.NewError(domain.ErrCodeInvalidArgument, "目标不是常规文件", nil)
	}

	previewKind, editable, reason := classifyWorkspaceFile(base)
	if previewKind == "unsupported" {
		if reason == "image" {
			return WorkspaceFileDocument{}, domain.NewError(domain.ErrCodeInvalidArgument, "图片暂不支持预览", nil)
		}
		return WorkspaceFileDocument{}, domain.NewError(domain.ErrCodeInvalidArgument, "暂不支持预览此文件类型", nil)
	}

	data, err := readText(parent, base)
	if err != nil {
		return WorkspaceFileDocument{}, domain.NewError(domain.ErrCodeInvalidArgument, "暂不支持预览此文件类型", err)
	}

	return WorkspaceFileDocument{
		Path:        slashRel,
		Name:        base,
		Size:        info.Size(),
		ModTime:     info.ModTime().UTC().Format(time.RFC3339),
		PreviewKind: previewKind,
		Editable:    editable,
		ETag:        sha256Hex(data),
		Content:     string(data),
	}, nil
}

func (a *Runtime) WriteWorkspaceFile(ctx context.Context, relPath, content, expectedEtag string) (WorkspaceFileWriteResult, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceFileWriteResult{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceFileWriteResult{}, err
	}
	defer root.Close()

	parent, slashRel, base, err := openWorkspaceParent(root, relPath)
	if err != nil {
		return WorkspaceFileWriteResult{}, err
	}
	if parent != root {
		defer parent.Close()
	}

	info, err := parent.Lstat(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return WorkspaceFileWriteResult{}, domain.NewError(domain.ErrCodeNotFound, "文件不存在", err)
		}
		return WorkspaceFileWriteResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问文件", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return WorkspaceFileWriteResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "目标不是常规文件", nil)
	}

	previewKind, editable, _ := classifyWorkspaceFile(base)
	if !editable || previewKind == "unsupported" {
		return WorkspaceFileWriteResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "该文件类型不支持编辑保存", nil)
	}

	if len(content) > maxFile || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return WorkspaceFileWriteResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "文件内容必须为 2 MiB 以内的有效 UTF-8 文本", nil)
	}

	if expectedEtag != "" {
		current, readErr := readText(parent, base)
		if readErr != nil || sha256Hex(current) != expectedEtag {
			return WorkspaceFileWriteResult{}, domain.NewError(domain.ErrCodeConflict, "文件已被外部修改，请重新加载或确认覆盖", readErr)
		}
	}

	if err := writeText(ctx, parent, base, content); err != nil {
		return WorkspaceFileWriteResult{}, err
	}

	updatedInfo, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceFileWriteResult{}, err
	}
	return WorkspaceFileWriteResult{
		Path:        slashRel,
		Name:        base,
		Size:        updatedInfo.Size(),
		ModTime:     updatedInfo.ModTime().UTC().Format(time.RFC3339),
		PreviewKind: previewKind,
		Editable:    editable,
		ETag:        sha256Hex([]byte(content)),
	}, nil
}
