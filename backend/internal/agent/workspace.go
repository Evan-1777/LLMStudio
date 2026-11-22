package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
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

const (
	maxWorkspaceListEntries   = 500
	maxWorkspaceUploadBytes   = 32 << 20
	maxWorkspaceCopyEntries   = 500
	maxWorkspaceCopyBytes     = 64 << 20
	maxWorkspaceSearchVisited = 5000
	maxWorkspaceSearchResults = 100
	maxWorkspaceBatchPaths    = 100
)

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

// WorkspaceSearchResponse is returned by SearchWorkspaceEntries.
type WorkspaceSearchResponse struct {
	Query     string           `json:"query"`
	Entries   []WorkspaceEntry `json:"entries"`
	Truncated bool             `json:"truncated"`
}

// WorkspaceBatchItemError describes a per-item failure in a batch workspace operation.
type WorkspaceBatchItemError struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WorkspaceBatchResult is returned by BatchWorkspaceEntries.
type WorkspaceBatchResult struct {
	Operation string                    `json:"operation"`
	Succeeded []string                  `json:"succeeded"`
	Failed    []WorkspaceBatchItemError `json:"failed"`
}

var markdownExtensions = map[string]bool{
	".md":       true,
	".markdown": true,
	".mdx":      true,
}

var textExtensions = map[string]bool{
	".txt": true, ".log": true, ".csv": true, ".tsv": true, ".rst": true, ".org": true, ".tex": true,
	".json": true, ".jsonc": true, ".json5": true, ".jsonl": true, ".yaml": true, ".yml": true, ".toml": true,
	".ini": true, ".cfg": true, ".conf": true, ".env": true, ".properties": true, ".xml": true, ".plist": true,
	".html": true, ".htm": true, ".css": true, ".scss": true, ".less": true, ".svg": true,
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".go": true, ".mod": true, ".sum": true, ".py": true, ".rs": true, ".java": true, ".kt": true, ".kts": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cc": true, ".cs": true,
	".rb": true, ".php": true, ".swift": true, ".sh": true, ".bash": true, ".zsh": true,
	".ps1": true, ".bat": true, ".cmd": true, ".sql": true, ".graphql": true, ".proto": true,
	".dockerfile": true, ".mk": true, ".lua": true, ".r": true, ".vue": true, ".svelte": true,
	".astro": true, ".diff": true, ".patch": true,
	".hcl": true, ".tf": true, ".nix": true, ".zig": true, ".ex": true, ".exs": true,
	".dart": true, ".scala": true, ".gradle": true, ".cmake": true, ".mmd": true, ".mermaid": true,
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

func validateWorkspaceRelPath(raw string) (string, error) {
	rel, err := relative(raw)
	if err != nil || rel == "." {
		return "", domain.NewError(domain.ErrCodeInvalidArgument, "无效的工作区路径", err)
	}
	slashRel := filepath.ToSlash(rel)
	parts := strings.Split(slashRel, "/")
	for _, seg := range parts {
		if seg == "" || seg == "." || seg == ".." || len(seg) > 255 {
			return "", domain.NewError(domain.ErrCodeInvalidArgument, "无效的工作区路径", nil)
		}
		for i := 0; i < len(seg); i++ {
			if seg[i] < 0x20 || seg[i] == 0x7f {
				return "", domain.NewError(domain.ErrCodeInvalidArgument, "路径包含非法控制字符", nil)
			}
		}
	}
	return slashRel, nil
}

func ensureRegularSubdir(root *os.Root, slashRel string) (*os.Root, error) {
	parts := strings.Split(slashRel, "/")
	cur := root
	var opened []*os.Root
	closeOpened := func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = opened[i].Close()
		}
	}
	for _, part := range parts {
		info, err := cur.Lstat(part)
		if errors.Is(err, fs.ErrNotExist) {
			if mkErr := cur.Mkdir(part, 0755); mkErr != nil && !errors.Is(mkErr, fs.ErrExist) {
				closeOpened()
				return nil, domain.NewError(domain.ErrCodeInvalidArgument, "无法创建目录", mkErr)
			}
			info, err = cur.Lstat(part)
		}
		if err != nil {
			closeOpened()
			return nil, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问目录", err)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			closeOpened()
			return nil, domain.NewError(domain.ErrCodeInvalidArgument, "路径中包含非目录或符号链接", nil)
		}
		next, err := cur.OpenRoot(part)
		if err != nil {
			closeOpened()
			return nil, domain.NewError(domain.ErrCodeInvalidArgument, "无法打开目录", err)
		}
		opened = append(opened, next)
		cur = next
	}
	for i := len(opened) - 2; i >= 0; i-- {
		_ = opened[i].Close()
	}
	return cur, nil
}

func buildWorkspaceEntry(slashRel, base string, info fs.FileInfo) WorkspaceEntry {
	modTime := info.ModTime().UTC().Format(time.RFC3339)
	if info.IsDir() {
		return WorkspaceEntry{
			Name:    base,
			Path:    slashRel,
			Kind:    "dir",
			ModTime: modTime,
		}
	}
	previewKind, editable, unsupportedReason := classifyWorkspaceFile(base)
	return WorkspaceEntry{
		Name:              base,
		Path:              slashRel,
		Kind:              "file",
		Size:              info.Size(),
		ModTime:           modTime,
		PreviewKind:       previewKind,
		Editable:          editable,
		UnsupportedReason: unsupportedReason,
	}
}

func randomTempName(prefix string) string {
	var id [12]byte
	_, _ = rand.Read(id[:])
	return prefix + hex.EncodeToString(id[:])
}

func (a *Runtime) CreateWorkspaceFile(ctx context.Context, relPath, content string) (WorkspaceEntry, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceEntry{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceEntry{}, err
	}
	defer root.Close()

	slashRel, err := validateWorkspaceRelPath(relPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if len(content) > maxFile || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "文件内容必须为 2 MiB 以内的有效 UTF-8 文本", nil)
	}

	dir, base := path.Dir(slashRel), path.Base(slashRel)
	parent := root
	if dir != "." {
		sub, subErr := ensureRegularSubdir(root, dir)
		if subErr != nil {
			return WorkspaceEntry{}, subErr
		}
		defer sub.Close()
		parent = sub
	}

	f, err := parent.OpenFile(base, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标已存在", err)
		}
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法创建文件", err)
	}
	_, writeErr := io.WriteString(f, content)
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = parent.Remove(base)
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "写入文件失败", err)
	}
	info, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取新建文件信息失败", err)
	}
	return buildWorkspaceEntry(slashRel, base, info), nil
}

func (a *Runtime) CreateWorkspaceDir(ctx context.Context, relPath string) (WorkspaceEntry, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceEntry{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceEntry{}, err
	}
	defer root.Close()

	slashRel, err := validateWorkspaceRelPath(relPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	dir, base := path.Dir(slashRel), path.Base(slashRel)
	parent := root
	if dir != "." {
		sub, subErr := ensureRegularSubdir(root, dir)
		if subErr != nil {
			return WorkspaceEntry{}, subErr
		}
		defer sub.Close()
		parent = sub
	}

	if err := parent.Mkdir(base, 0755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标已存在", err)
		}
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法创建目录", err)
	}
	info, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取新建目录信息失败", err)
	}
	return buildWorkspaceEntry(slashRel, base, info), nil
}

func (a *Runtime) MoveWorkspaceEntry(ctx context.Context, fromPath, toPath string) (WorkspaceEntry, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceEntry{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceEntry{}, err
	}
	defer root.Close()

	from, err := validateWorkspaceRelPath(fromPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	to, err := validateWorkspaceRelPath(toPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "不能将目录移动到其自身或子目录中", nil)
	}

	srcParent, _, srcBase, err := openWorkspaceParent(root, from)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if srcParent != root {
		defer srcParent.Close()
	}
	srcInfo, err := srcParent.Lstat(srcBase)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeNotFound, "源路径不存在", err)
		}
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问源路径", err)
	}
	if srcInfo.Mode()&os.ModeSymlink != 0 || (!srcInfo.IsDir() && !srcInfo.Mode().IsRegular()) {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "不支持移动符号链接或非常规文件", nil)
	}

	dstParent, _, dstBase, err := openWorkspaceParent(root, to)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if dstParent != root {
		defer dstParent.Close()
	}
	if _, err := dstParent.Lstat(dstBase); err == nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标已存在", nil)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问目标路径", err)
	}

	if err := root.Rename(filepath.FromSlash(from), filepath.FromSlash(to)); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标已存在", err)
		}
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "移动失败", err)
	}
	info, err := dstParent.Lstat(dstBase)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取目标信息失败", err)
	}
	return buildWorkspaceEntry(to, dstBase, info), nil
}

func copyRegularFileBetweenRoots(ctx context.Context, srcParent *os.Root, srcBase string, dstParent *os.Root, dstBase string, maxBytes int64) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	srcFile, err := srcParent.Open(srcBase)
	if err != nil {
		return 0, domain.NewError(domain.ErrCodeInvalidArgument, "无法打开源文件", err)
	}
	defer srcFile.Close()
	srcInfo, err := srcFile.Stat()
	if err != nil || !srcInfo.Mode().IsRegular() {
		return 0, domain.NewError(domain.ErrCodeInvalidArgument, "源路径不是常规文件", err)
	}
	if srcInfo.Size() > maxBytes {
		return 0, domain.NewError(domain.ErrCodePayloadTooLarge, "文件超出复制大小限制", nil)
	}

	mode := srcInfo.Mode().Perm()
	if mode == 0 {
		mode = 0600
	}
	tmp := randomTempName(".llmstudio-copy-")
	dstFile, err := dstParent.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return 0, domain.NewError(domain.ErrCodeInternalError, "无法创建临时文件", err)
	}
	defer dstParent.Remove(tmp)

	n, copyErr := io.Copy(dstFile, io.LimitReader(srcFile, maxBytes+1))
	closeErr := dstFile.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return 0, domain.NewError(domain.ErrCodeInternalError, "复制文件失败", err)
	}
	if n > maxBytes {
		return 0, domain.NewError(domain.ErrCodePayloadTooLarge, "文件超出复制大小限制", nil)
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := dstParent.Rename(tmp, dstBase); err != nil {
		return 0, domain.NewError(domain.ErrCodeInternalError, "提交复制文件失败", err)
	}
	return n, nil
}

type copyBudget struct {
	entries int
	bytes   int64
}

func copyDirRecursive(ctx context.Context, srcDir, dstDir *os.Root, budget *copyBudget) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := fs.ReadDir(srcDir.FS(), ".")
	if err != nil {
		return domain.NewError(domain.ErrCodeInternalError, "读取源目录失败", err)
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := entry.Name()
		info, infoErr := srcDir.Lstat(name)
		if infoErr != nil || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if info.IsDir() {
			budget.entries++
			if budget.entries > maxWorkspaceCopyEntries {
				return domain.NewError(domain.ErrCodePayloadTooLarge, "复制条目数超出上限", nil)
			}
			if err := dstDir.Mkdir(name, 0755); err != nil {
				return domain.NewError(domain.ErrCodeInternalError, "创建目标子目录失败", err)
			}
			subSrc, err := srcDir.OpenRoot(name)
			if err != nil {
				return domain.NewError(domain.ErrCodeInvalidArgument, "无法打开源子目录", err)
			}
			subDst, err := dstDir.OpenRoot(name)
			if err != nil {
				_ = subSrc.Close()
				return domain.NewError(domain.ErrCodeInternalError, "无法打开目标子目录", err)
			}
			recErr := copyDirRecursive(ctx, subSrc, subDst, budget)
			_ = subDst.Close()
			_ = subSrc.Close()
			if recErr != nil {
				return recErr
			}
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		budget.entries++
		if budget.entries > maxWorkspaceCopyEntries {
			return domain.NewError(domain.ErrCodePayloadTooLarge, "复制条目数超出上限", nil)
		}
		remaining := maxWorkspaceCopyBytes - budget.bytes
		if remaining < 0 || info.Size() > remaining {
			return domain.NewError(domain.ErrCodePayloadTooLarge, "复制总大小超出 64 MiB 上限", nil)
		}
		copied, err := copyRegularFileBetweenRoots(ctx, srcDir, name, dstDir, name, min(int64(maxWorkspaceUploadBytes), remaining))
		if err != nil {
			return err
		}
		budget.bytes += copied
	}
	return nil
}

func (a *Runtime) CopyWorkspaceEntry(ctx context.Context, fromPath, toPath string) (WorkspaceEntry, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceEntry{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceEntry{}, err
	}
	defer root.Close()

	from, err := validateWorkspaceRelPath(fromPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	to, err := validateWorkspaceRelPath(toPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "不能将目录复制到其自身或子目录中", nil)
	}

	srcParent, _, srcBase, err := openWorkspaceParent(root, from)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if srcParent != root {
		defer srcParent.Close()
	}
	srcInfo, err := srcParent.Lstat(srcBase)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeNotFound, "源路径不存在", err)
		}
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问源路径", err)
	}
	if srcInfo.Mode()&os.ModeSymlink != 0 || (!srcInfo.IsDir() && !srcInfo.Mode().IsRegular()) {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "不支持复制符号链接或非常规文件", nil)
	}

	dstParent, _, dstBase, err := openWorkspaceParent(root, to)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if dstParent != root {
		defer dstParent.Close()
	}
	if _, err := dstParent.Lstat(dstBase); err == nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标已存在", nil)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问目标路径", err)
	}

	if !srcInfo.IsDir() {
		if _, err := copyRegularFileBetweenRoots(ctx, srcParent, srcBase, dstParent, dstBase, maxWorkspaceUploadBytes); err != nil {
			return WorkspaceEntry{}, err
		}
	} else {
		srcDir, err := srcParent.OpenRoot(srcBase)
		if err != nil {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法打开源目录", err)
		}
		defer srcDir.Close()
		if err := dstParent.Mkdir(dstBase, 0755); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标已存在", err)
			}
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "创建目标目录失败", err)
		}
		dstDir, err := dstParent.OpenRoot(dstBase)
		if err != nil {
			_ = dstParent.RemoveAll(dstBase)
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "无法打开目标目录", err)
		}
		budget := &copyBudget{}
		recErr := copyDirRecursive(ctx, srcDir, dstDir, budget)
		_ = dstDir.Close()
		if recErr != nil {
			_ = dstParent.RemoveAll(dstBase)
			return WorkspaceEntry{}, recErr
		}
	}

	info, err := dstParent.Lstat(dstBase)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取目标信息失败", err)
	}
	return buildWorkspaceEntry(to, dstBase, info), nil
}

func (a *Runtime) DeleteWorkspaceEntry(ctx context.Context, relPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return err
	}
	defer root.Close()

	slashRel, err := validateWorkspaceRelPath(relPath)
	if err != nil {
		return err
	}
	parent, _, base, err := openWorkspaceParent(root, slashRel)
	if err != nil {
		return err
	}
	if parent != root {
		defer parent.Close()
	}
	info, err := parent.Lstat(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return domain.NewError(domain.ErrCodeNotFound, "目标不存在", err)
		}
		return domain.NewError(domain.ErrCodeInvalidArgument, "无法访问目标路径", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return domain.NewError(domain.ErrCodeInvalidArgument, "不允许删除符号链接", nil)
	}
	if info.IsDir() {
		if err := parent.RemoveAll(base); err != nil {
			return domain.NewError(domain.ErrCodeInternalError, "删除目录失败", err)
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return domain.NewError(domain.ErrCodeInvalidArgument, "不支持删除非常规文件", nil)
	}
	if err := parent.Remove(base); err != nil {
		return domain.NewError(domain.ErrCodeInternalError, "删除文件失败", err)
	}
	return nil
}

func (a *Runtime) BatchWorkspaceEntries(ctx context.Context, operation string, paths []string, targetDir string) (WorkspaceBatchResult, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceBatchResult{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceBatchResult{}, err
	}
	defer root.Close()

	if operation != "delete" && operation != "move" {
		return WorkspaceBatchResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "不支持的批量操作类型", nil)
	}
	if len(paths) == 0 || len(paths) > maxWorkspaceBatchPaths {
		return WorkspaceBatchResult{}, domain.NewError(domain.ErrCodeInvalidArgument, "批量路径数量必须在 1 到 100 之间", nil)
	}

	result := WorkspaceBatchResult{
		Operation: operation,
		Succeeded: []string{},
		Failed:    []WorkspaceBatchItemError{},
	}

	seen := make(map[string]struct{}, len(paths))
	normalized := make([]string, 0, len(paths))
	for _, raw := range paths {
		clean, err := validateWorkspaceRelPath(raw)
		if err != nil {
			code, msg := domain.ErrCodeInvalidArgument, "无效的工作区路径"
			if appErr, ok := domain.AsAppError(err); ok {
				code, msg = appErr.Code, appErr.Message
			}
			result.Failed = append(result.Failed, WorkspaceBatchItemError{
				Path:    raw,
				Code:    code,
				Message: msg,
			})
			continue
		}
		if _, dup := seen[clean]; dup {
			continue
		}
		seen[clean] = struct{}{}
		normalized = append(normalized, clean)
	}

	recordErr := func(p string, opErr error) {
		code, msg := domain.ErrCodeInternalError, opErr.Error()
		if appErr, ok := domain.AsAppError(opErr); ok {
			code, msg = appErr.Code, appErr.Message
		}
		result.Failed = append(result.Failed, WorkspaceBatchItemError{
			Path:    p,
			Code:    code,
			Message: msg,
		})
	}

	if operation == "delete" {
		slices.Sort(normalized)
		pruned := make([]string, 0, len(normalized))
		for _, p := range normalized {
			covered := false
			for _, anc := range pruned {
				if strings.HasPrefix(p, anc+"/") {
					covered = true
					break
				}
			}
			if !covered {
				pruned = append(pruned, p)
			}
		}
		for _, p := range pruned {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			if err := a.DeleteWorkspaceEntry(ctx, p); err != nil {
				recordErr(p, err)
				continue
			}
			result.Succeeded = append(result.Succeeded, p)
		}
		return result, nil
	}

	cleanTarget := ""
	trimmedTarget := strings.TrimSpace(targetDir)
	if trimmedTarget != "" && trimmedTarget != "." {
		validatedTarget, err := validateWorkspaceRelPath(trimmedTarget)
		if err != nil {
			return WorkspaceBatchResult{}, err
		}
		sub, ok := openRegularSubdir(root, validatedTarget)
		if !ok {
			return WorkspaceBatchResult{}, domain.NewError(domain.ErrCodeNotFound, "目标目录不存在", nil)
		}
		_ = sub.Close()
		cleanTarget = validatedTarget
	}

	for _, p := range normalized {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		dest := path.Base(p)
		if cleanTarget != "" {
			dest = path.Join(cleanTarget, dest)
		}
		if _, err := a.MoveWorkspaceEntry(ctx, p, dest); err != nil {
			recordErr(p, err)
			continue
		}
		result.Succeeded = append(result.Succeeded, p)
	}
	return result, nil
}

func (a *Runtime) UploadWorkspaceFile(ctx context.Context, relPath string, body io.Reader, overwrite bool) (WorkspaceEntry, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceEntry{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceEntry{}, err
	}
	defer root.Close()

	slashRel, err := validateWorkspaceRelPath(relPath)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	parent, _, base, err := openWorkspaceParent(root, slashRel)
	if err != nil {
		return WorkspaceEntry{}, err
	}
	if parent != root {
		defer parent.Close()
	}

	tmp := randomTempName(".llmstudio-upload-")
	f, err := parent.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "无法创建上传临时文件", err)
	}
	defer parent.Remove(tmp)

	n, copyErr := io.Copy(f, io.LimitReader(body, maxWorkspaceUploadBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "读取上传内容失败", copyErr)
	}
	if closeErr != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "保存上传临时文件失败", closeErr)
	}
	if n > maxWorkspaceUploadBytes {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodePayloadTooLarge, "上传文件不能超过 32 MiB", nil)
	}
	if err := ctx.Err(); err != nil {
		return WorkspaceEntry{}, err
	}

	if existing, statErr := parent.Lstat(base); statErr == nil {
		if existing.IsDir() || existing.Mode()&os.ModeSymlink != 0 || !existing.Mode().IsRegular() {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "目标不是常规文件", nil)
		}
		if !overwrite {
			return WorkspaceEntry{}, domain.NewError(domain.ErrCodeConflict, "目标文件已存在", nil)
		}
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问目标路径", statErr)
	}

	if err := parent.Rename(tmp, base); err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "写入上传文件失败", err)
	}
	info, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取上传文件信息失败", err)
	}
	return buildWorkspaceEntry(slashRel, base, info), nil
}

func (a *Runtime) OpenWorkspaceFileDownload(ctx context.Context, relPath string) (*os.File, fs.FileInfo, string, func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, "", nil, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return nil, nil, "", nil, err
	}
	slashRel, err := validateWorkspaceRelPath(relPath)
	if err != nil {
		_ = root.Close()
		return nil, nil, "", nil, err
	}
	parent, _, base, err := openWorkspaceParent(root, slashRel)
	if err != nil {
		_ = root.Close()
		return nil, nil, "", nil, err
	}
	closeParents := func() {
		if parent != root {
			_ = parent.Close()
		}
		_ = root.Close()
	}

	info, err := parent.Lstat(base)
	if err != nil {
		closeParents()
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, "", nil, domain.NewError(domain.ErrCodeNotFound, "文件不存在", err)
		}
		return nil, nil, "", nil, domain.NewError(domain.ErrCodeInvalidArgument, "无法访问文件", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		closeParents()
		return nil, nil, "", nil, domain.NewError(domain.ErrCodeInvalidArgument, "目标不是常规文件", nil)
	}
	f, err := parent.Open(base)
	if err != nil {
		closeParents()
		return nil, nil, "", nil, domain.NewError(domain.ErrCodeInvalidArgument, "无法打开文件", err)
	}
	fstat, err := f.Stat()
	if err != nil || !fstat.Mode().IsRegular() {
		_ = f.Close()
		closeParents()
		return nil, nil, "", nil, domain.NewError(domain.ErrCodeInvalidArgument, "目标不是常规文件", err)
	}
	closeFn := func() {
		_ = f.Close()
		closeParents()
	}
	return f, fstat, base, closeFn, nil
}

var errWorkspaceSearchLimit = errors.New("workspace search limit reached")

func (a *Runtime) SearchWorkspaceEntries(ctx context.Context, query string) (WorkspaceSearchResponse, error) {
	if err := ctx.Err(); err != nil {
		return WorkspaceSearchResponse{}, err
	}
	root, err := a.openWorkspaceRoot()
	if err != nil {
		return WorkspaceSearchResponse{}, err
	}
	defer root.Close()

	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return WorkspaceSearchResponse{
			Query:     "",
			Entries:   []WorkspaceEntry{},
			Truncated: false,
		}, nil
	}
	lowerQuery := strings.ToLower(trimmed)
	visited := 0
	truncated := false
	matches := make([]WorkspaceEntry, 0)

	walkErr := fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil {
			return nil
		}
		if p == "." {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return fs.SkipDir
		}
		visited++
		if visited > maxWorkspaceSearchVisited {
			truncated = true
			return errWorkspaceSearchLimit
		}
		if !strings.Contains(strings.ToLower(p), lowerQuery) {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		if !d.IsDir() && !info.Mode().IsRegular() {
			return nil
		}
		if len(matches) >= maxWorkspaceSearchResults {
			truncated = true
			return errWorkspaceSearchLimit
		}
		matches = append(matches, buildWorkspaceEntry(p, d.Name(), info))
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errWorkspaceSearchLimit) {
		return WorkspaceSearchResponse{}, walkErr
	}

	slices.SortFunc(matches, func(a, b WorkspaceEntry) int {
		aExact := strings.EqualFold(a.Name, trimmed)
		bExact := strings.EqualFold(b.Name, trimmed)
		if aExact != bExact {
			if aExact {
				return -1
			}
			return 1
		}
		if a.Kind != b.Kind {
			if a.Kind == "dir" {
				return -1
			}
			return 1
		}
		la, lb := strings.ToLower(a.Path), strings.ToLower(b.Path)
		if c := strings.Compare(la, lb); c != 0 {
			return c
		}
		return strings.Compare(a.Path, b.Path)
	})

	return WorkspaceSearchResponse{
		Query:     trimmed,
		Entries:   matches,
		Truncated: truncated,
	}, nil
}
