import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Input,
  LoadingSpinner,
  Modal,
} from '../../components/ui';
import { GatewayError, type GatewayClient } from '../../core/gateway';
import type { TopicScope, WorkspaceEntry } from '../../core/types';
import './workspace.css';

export type WorkspaceNameDialogMode = 'create-file' | 'create-dir' | 'rename';

function normalizeWorkspaceName(raw: string, mode: WorkspaceNameDialogMode): string {
  const trimmed = raw.trim();
  return mode === 'create-dir' ? trimmed.replace(/\/+$/, '') : trimmed;
}

// Radix restores menu focus on exit, which may finish after the dialog has opened.
export function useWorkspaceMenuDialog() {
  const frame = useRef<number | null>(null);
  const handingOff = useRef(false);
  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
  }, []);
  return {
    openAfterMenu(open: () => void) {
      handingOff.current = true;
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        open();
      });
    },
    onCloseAutoFocus(event: Event) {
      if (!handingOff.current) return;
      event.preventDefault();
      handingOff.current = false;
    },
  };
}

export function validateWorkspaceNameInput(
  raw: string,
  mode: WorkspaceNameDialogMode,
): string | null {
  const value = normalizeWorkspaceName(raw, mode);
  if (!value) {
    return mode === 'create-dir' ? '请输入文件夹名称' : '请输入名称';
  }
  if (/[\\:]/.test(value)) {
    return '名称不能包含 \\ 或 :';
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return '名称包含非法控制字符';
    }
  }
  if (mode === 'rename' && value.includes('/')) {
    return '重命名不能包含路径分隔符 /';
  }
  const segments = value.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return '路径包含无效片段';
    }
  }
  return null;
}

export function WorkspaceNameDialog({
  open,
  mode,
  parentDir = '',
  initialName = '',
  entryKind = 'file',
  busy = false,
  error = null,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  mode: WorkspaceNameDialogMode;
  parentDir?: string;
  initialName?: string;
  entryKind?: 'file' | 'dir';
  busy?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (resolvedPath: string) => Promise<void> | void;
}) {
  const formId = useId();
  const inputId = useId();
  const [value, setValue] = useState(initialName);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialName);
    setLocalError(null);
    const frame = window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (mode === 'rename' && initialName) {
        if (entryKind === 'file') {
          const dotIdx = initialName.lastIndexOf('.');
          if (dotIdx > 0) {
            el.setSelectionRange(0, dotIdx);
            return;
          }
        }
        el.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entryKind, initialName, mode, open]);

  const title =
    mode === 'create-file'
      ? '新建文件'
      : mode === 'create-dir'
        ? '新建文件夹'
        : '重命名';

  const placeholder =
    mode === 'create-file'
      ? 'notes.md'
      : mode === 'create-dir'
        ? 'docs'
        : initialName;

  const submitLabel =
    mode === 'rename' ? (busy ? '保存中…' : '重命名') : busy ? '创建中…' : '创建';

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const validationErr = validateWorkspaceNameInput(value, mode);
    if (validationErr) {
      setLocalError(validationErr);
      return;
    }
    const clean = normalizeWorkspaceName(value, mode);
    if (mode === 'rename' && clean === initialName) {
      onOpenChange(false);
      return;
    }
    const resolved = parentDir ? `${parentDir}/${clean}` : clean;
    setLocalError(null);
    void onSubmit(resolved);
  };

  const displayError = localError ?? error;

  return (
    <Modal
      open={open}
      busy={busy}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={title}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={busy}
            disabled={busy}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="ws-dialog-form"
        noValidate
        onSubmit={handleSubmit}
      >
        {displayError ? <ErrorBanner message={displayError} /> : null}
        {mode !== 'rename' && parentDir ? (
          <div className="ws-dialog-location" title={parentDir}>
            <Icon name="folder" size={13} className="ws-dialog-location__icon" />
            <span className="ws-dialog-location__path">{parentDir}/</span>
          </div>
        ) : null}
        <Field
          label={mode === 'create-dir' ? '文件夹名称' : '名称'}
          htmlFor={inputId}
        >
          <Input
            ref={inputRef}
            id={inputId}
            value={value}
            placeholder={placeholder}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setValue(e.target.value);
              if (localError) setLocalError(null);
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}

export function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx > 0 ? relPath.slice(0, idx) : '';
}

export function nextCopyName(entry: WorkspaceEntry, existingNames: Set<string>): string {
  const isFile = entry.kind === 'file';
  const dotIdx = isFile ? entry.name.lastIndexOf('.') : -1;
  const stem = dotIdx > 0 ? entry.name.slice(0, dotIdx) : entry.name;
  const ext = dotIdx > 0 ? entry.name.slice(dotIdx) : '';

  const first = `${stem} copy${ext}`;
  if (!existingNames.has(first)) return first;
  for (let i = 2; i <= 999; i++) {
    const candidate = `${stem} copy ${i}${ext}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${stem} copy ${Date.now()}${ext}`;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkspaceMoveDialog({
  open,
  gateway,
  scope,
  sourcePaths,
  sourceLabel,
  busy = false,
  error = null,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  gateway: GatewayClient;
  scope?: TopicScope;
  sourcePaths: string[];
  sourceLabel: string;
  busy?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (targetDir: string) => Promise<void> | void;
}) {
  const [currentDir, setCurrentDir] = useState('');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const dialogBusy = busy || creatingFolder;
  const [dirs, setDirs] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSubdirs = useCallback(
    async (dirPath: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await gateway.listWorkspaceEntries(dirPath, scope, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setDirs((res.entries ?? []).filter((item) => item.kind === 'dir'));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof GatewayError ? err.message : '无法读取目录');
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [gateway, scope],
  );

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      return;
    }
    setCurrentDir('');
    setFolderName(null);
    setFolderError(null);
    void loadSubdirs('');
    return () => {
      abortRef.current?.abort();
    };
  }, [loadSubdirs, open]);

  const navigateTo = (nextDir: string) => {
    setFolderName(null);
    setFolderError(null);
    setCurrentDir(nextDir);
    void loadSubdirs(nextDir);
  };

  const createTargetFolder = async (event: FormEvent) => {
    event.preventDefault();
    if (folderName === null || dialogBusy) return;
    const error = validateWorkspaceNameInput(folderName, 'create-dir');
    if (error) {
      setFolderError(error);
      return;
    }
    const name = normalizeWorkspaceName(folderName, 'create-dir');
    const path = currentDir ? `${currentDir}/${name}` : name;
    setCreatingFolder(true);
    setFolderError(null);
    try {
      const created = await gateway.createWorkspaceDir(path, scope);
      navigateTo(created.path);
    } catch (err) {
      setFolderError(err instanceof GatewayError ? err.message : '无法创建文件夹');
    } finally {
      setCreatingFolder(false);
    }
  };

  const segments = useMemo(
    () => (currentDir ? currentDir.split('/').filter(Boolean) : []),
    [currentDir],
  );

  const isForbiddenTarget = useCallback(
    (dirPath: string) =>
      sourcePaths.some(
        (src) => dirPath === src || dirPath.startsWith(`${src}/`),
      ),
    [sourcePaths],
  );

  const allAlreadyInCurrentDir = useMemo(
    () =>
      sourcePaths.length > 0 &&
      sourcePaths.every((src) => parentDirOf(src) === currentDir),
    [currentDir, sourcePaths],
  );

  const title =
    sourcePaths.length <= 1
      ? `移动「${sourceLabel}」`
      : `移动 ${sourcePaths.length} 项`;

  return (
    <Modal
      open={open}
      busy={dialogBusy}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={dialogBusy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={dialogBusy || folderName !== null || loading || !!loadError || allAlreadyInCurrentDir}
            onClick={() => void onConfirm(currentDir)}
          >
            {busy ? '移动中…' : '移至此处'}
          </Button>
        </>
      }
    >
      <div className="ws-move-picker">
        {error ? <ErrorBanner message={error} /> : null}

        <div className="ws-move-picker__head">
          <nav className="ws-breadcrumb" aria-label="目标目录路径">
            <button
              type="button"
              className={`ws-breadcrumb__seg ${segments.length === 0 ? 'ws-breadcrumb__seg--current' : ''}`.trim()}
              disabled={dialogBusy || segments.length === 0}
              onClick={() => navigateTo('')}
            >
              <Icon name="folder" size={13} />
              <span>工作区</span>
            </button>
            {segments.map((seg, idx) => {
              const target = segments.slice(0, idx + 1).join('/');
              const isCurrent = idx === segments.length - 1;
              return (
                <span key={target} className="ws-breadcrumb__item">
                  <Icon name="chevronRight" size={11} className="ws-breadcrumb__sep" />
                  <button
                    type="button"
                    className={`ws-breadcrumb__seg ${isCurrent ? 'ws-breadcrumb__seg--current' : ''}`.trim()}
                    disabled={dialogBusy || isCurrent}
                    onClick={() => navigateTo(target)}
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </nav>
          <IconButton
            size="sm"
            icon="folderPlus"
            label="新建文件夹"
            disabled={dialogBusy || loading || !!loadError || folderName !== null}
            onClick={() => setFolderName('')}
          />
        </div>
        {folderName !== null ? (
          <form className="ws-dialog-form" onSubmit={createTargetFolder}>
            {folderError ? <ErrorBanner message={folderError} /> : null}
            <div className="ws-move-picker__create">
              <Input
                autoFocus
                aria-label="文件夹名称"
                value={folderName}
                disabled={dialogBusy}
                onChange={(event) => {
                  setFolderName(event.target.value);
                  setFolderError(null);
                }}
              />
              <Button type="submit" loading={creatingFolder} disabled={dialogBusy}>创建</Button>
              <IconButton
                size="sm"
                icon="close"
                label="取消新建文件夹"
                disabled={dialogBusy}
                onClick={() => {
                  setFolderName(null);
                  setFolderError(null);
                }}
              />
            </div>
          </form>
        ) : null}

        <div className="ws-move-list" role="list" aria-label="子目录列表">
          {loading ? (
            <div className="ws-move-list__state">
              <LoadingSpinner label="加载目录" />
            </div>
          ) : loadError ? (
            <div className="ws-move-list__state">
              <ErrorBanner
                message={loadError}
                onRetry={() => void loadSubdirs(currentDir)}
              />
            </div>
          ) : dirs.length === 0 ? (
            <div className="ws-move-list__empty">无子文件夹</div>
          ) : (
            dirs.map((dir) => {
              const disabled = dialogBusy || isForbiddenTarget(dir.path);
              return (
                <button
                  key={dir.path}
                  type="button"
                  role="listitem"
                  className={`ws-move-row ${disabled ? 'ws-move-row--disabled' : ''}`.trim()}
                  disabled={disabled}
                  title={dir.path}
                  onClick={() => navigateTo(dir.path)}
                >
                  <Icon name="folder" size={15} className="ws-tree-icon ws-tree-icon--dir" />
                  <span className="ws-move-row__name">{dir.name}</span>
                  <Icon name="chevronRight" size={13} className="ws-move-row__chevron" />
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
