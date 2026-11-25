package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"llmstudio/backend/internal/domain"
)

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
		return WorkspaceEntry{}, mapWorkspaceWriteError(err, "无法创建文件")
	}
	_, writeErr := io.WriteString(f, content)
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = parent.Remove(base)
		return WorkspaceEntry{}, mapWorkspaceWriteError(err, "写入文件失败")
	}
	info, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取新建文件信息失败", err)
	}
	return buildWorkspaceEntry(parent, base, slashRel, base, info), nil
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
		return WorkspaceEntry{}, mapWorkspaceWriteError(err, "无法创建目录")
	}
	info, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取新建目录信息失败", err)
	}
	return buildWorkspaceEntry(parent, base, slashRel, base, info), nil
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
		return WorkspaceEntry{}, mapWorkspaceWriteError(err, "移动失败")
	}
	info, err := dstParent.Lstat(dstBase)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取目标信息失败", err)
	}
	return buildWorkspaceEntry(dstParent, dstBase, to, dstBase, info), nil
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
		return 0, mapWorkspaceWriteError(err, "无法创建临时文件")
	}
	defer dstParent.Remove(tmp)

	n, copyErr := io.Copy(dstFile, io.LimitReader(srcFile, maxBytes+1))
	closeErr := dstFile.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return 0, mapWorkspaceWriteError(err, "复制文件失败")
	}
	if n > maxBytes {
		return 0, domain.NewError(domain.ErrCodePayloadTooLarge, "文件超出复制大小限制", nil)
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := dstParent.Rename(tmp, dstBase); err != nil {
		return 0, mapWorkspaceWriteError(err, "提交复制文件失败")
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
				return mapWorkspaceWriteError(err, "创建目标子目录失败")
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
			return WorkspaceEntry{}, mapWorkspaceWriteError(err, "创建目标目录失败")
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
	return buildWorkspaceEntry(dstParent, dstBase, to, dstBase, info), nil
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
			return mapWorkspaceWriteError(err, "删除目录失败")
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return domain.NewError(domain.ErrCodeInvalidArgument, "不支持删除非常规文件", nil)
	}
	if err := parent.Remove(base); err != nil {
		return mapWorkspaceWriteError(err, "删除文件失败")
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
		return WorkspaceEntry{}, mapWorkspaceWriteError(err, "无法创建上传临时文件")
	}
	defer parent.Remove(tmp)

	n, copyErr := io.Copy(f, io.LimitReader(body, maxWorkspaceUploadBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return WorkspaceEntry{}, mapWorkspaceWriteError(copyErr, "读取上传内容失败")
	}
	if closeErr != nil {
		return WorkspaceEntry{}, mapWorkspaceWriteError(closeErr, "保存上传临时文件失败")
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
		return WorkspaceEntry{}, mapWorkspaceWriteError(err, "写入上传文件失败")
	}
	info, err := parent.Lstat(base)
	if err != nil {
		return WorkspaceEntry{}, domain.NewError(domain.ErrCodeInternalError, "读取上传文件信息失败", err)
	}
	return buildWorkspaceEntry(parent, base, slashRel, base, info), nil
}
