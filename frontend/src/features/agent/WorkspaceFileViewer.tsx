import * as Dialog from '@radix-ui/react-dialog';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  LoadingSpinner,
  SegmentedControl,
} from '../../components/ui';
import { GatewayError, type GatewayClient } from '../../core/gateway';
import type {
  TopicScope,
  WorkspaceEntry,
  WorkspaceFileDocument,
  WorkspaceFileWriteResult,
} from '../../core/types';
import { MarkdownDocument } from '../../rendering/ContentRenderer';
import {
  WorkspaceNameDialog,
  parentDirOf,
  triggerBlobDownload,
  useWorkspaceMenuDialog,
} from './WorkspaceDialogs';
import './workspace.css';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function fileHeaderIcon(entry: WorkspaceEntry): 'fileText' | 'fileCode' | 'image' | 'file' {
  if (entry.previewKind === 'markdown') return 'fileText';
  if (entry.previewKind === 'text') return 'fileCode';
  if (entry.unsupportedReason === 'image') return 'image';
  return 'file';
}

export function WorkspaceFileViewer({
  entry,
  initialMode,
  gateway,
  scope,
  onClose,
  onSaved,
  onRenamed,
  onDeleted,
}: {
  entry: WorkspaceEntry | null;
  initialMode?: 'preview' | 'edit';
  gateway: GatewayClient;
  scope?: TopicScope;
  onClose: () => void;
  onSaved?: (res: WorkspaceFileWriteResult) => void;
  onRenamed?: (oldPath: string, nextEntry: WorkspaceEntry) => void;
  onDeleted?: (deletedPath: string) => void;
}) {
  const { toast } = useApp();
  const { openAfterMenu, onCloseAutoFocus } = useWorkspaceMenuDialog();

  const [doc, setDoc] = useState<WorkspaceFileDocument | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [markdownVisualRender, setMarkdownVisualRender] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'close' | 'reload' | null>(null);

  // Rename & delete modals inside viewer
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const loadAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const open = entry !== null;
  const unsupported = entry?.previewKind === 'unsupported';
  const isDirty = Boolean(doc && draftContent !== doc.content);
  const subDialogOpen = discardConfirmOpen || renameOpen || deleteOpen;

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      loadAbortRef.current?.abort();
      saveAbortRef.current?.abort();
    };
  }, []);

  const fetchDocument = useCallback(
    async (target: WorkspaceEntry, preferredMode?: 'preview' | 'edit') => {
      loadAbortRef.current?.abort();
      const ctrl = new AbortController();
      loadAbortRef.current = ctrl;

      setLoading(true);
      setLoadError(null);
      setSaveError(null);

      try {
        const isMarkdown = target.previewKind === 'markdown';
        const [fileRes, settingsRes] = await Promise.all([
          gateway.readWorkspaceFile(target.path, scope, ctrl.signal),
          isMarkdown
            ? gateway.getAgentSettings(scope, ctrl.signal).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (ctrl.signal.aborted) return;
        setDoc(fileRes);
        setDraftContent(fileRes.content);
        setMode(
          preferredMode === 'edit'
            ? 'edit'
            : fileRes.previewKind === 'markdown'
              ? 'preview'
              : 'edit',
        );
        setMarkdownVisualRender(Boolean(settingsRes?.markdownVisualRender));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof GatewayError ? err.message : '无法读取文件');
      } finally {
        if (loadAbortRef.current === ctrl) {
          loadAbortRef.current = null;
        }
        if (!ctrl.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [gateway, scope],
  );

  useEffect(() => {
    loadAbortRef.current?.abort();
    saveAbortRef.current?.abort();
    setDoc(null);
    setDraftContent('');
    setLoadError(null);
    setSaveError(null);
    setSaving(false);
    setCopied(false);
    setDiscardConfirmOpen(false);
    setPendingAction(null);
    setRenameOpen(false);
    setRenameError(null);
    setDeleteOpen(false);

    if (!entry) {
      setFullscreen(false);
      return;
    }
    if (entry.previewKind === 'unsupported') {
      setLoading(false);
      return;
    }
    void fetchDocument(entry, initialMode);
  }, [entry, fetchDocument, initialMode]);

  const handleSave = useCallback(
    async (forceOverwrite: boolean) => {
      if (!doc || saving) return;
      saveAbortRef.current?.abort();
      const ctrl = new AbortController();
      saveAbortRef.current = ctrl;

      setSaving(true);
      setSaveError(null);
      try {
        const res = await gateway.writeWorkspaceFile(
          {
            path: doc.path,
            content: draftContent,
            expectedEtag: forceOverwrite ? undefined : doc.etag,
          },
          scope,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setDoc({
          ...doc,
          size: res.size,
          modTime: res.modTime,
          etag: res.etag,
          content: draftContent,
        });
        toast('已保存');
        onSaved?.(res);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const isConflict =
          err instanceof GatewayError &&
          (err.statusCode === 409 || err.code === 'CONFLICT');
        const message =
          err instanceof GatewayError ? err.message : '保存文件失败';
        setSaveError({ message, conflict: isConflict });
      } finally {
        if (saveAbortRef.current === ctrl) {
          saveAbortRef.current = null;
        }
        if (!ctrl.signal.aborted) {
          setSaving(false);
        }
      }
    },
    [doc, draftContent, gateway, onSaved, saving, scope, toast],
  );

  const handleCopy = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(draftContent);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('无法写入剪贴板', 'error');
    }
  };

  const handleDownload = async () => {
    if (!entry || downloading) return;
    setDownloading(true);
    try {
      const { blob, filename } = await gateway.downloadWorkspaceFile(entry.path, scope);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '下载文件失败', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyPath = async () => {
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.path);
      toast('已复制路径');
    } catch {
      toast('无法写入剪贴板', 'error');
    }
  };

  const handleRenameSubmit = async (resolvedPath: string) => {
    if (!entry) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const moved = await gateway.moveWorkspaceEntry(
        { fromPath: entry.path, toPath: resolvedPath },
        scope,
      );
      setRenameOpen(false);
      toast('已重命名');
      onRenamed?.(entry.path, moved);
    } catch (err) {
      setRenameError(err instanceof GatewayError ? err.message : '重命名失败');
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!entry) return;
    setDeleteBusy(true);
    try {
      const deletedPath = entry.path;
      await gateway.deleteWorkspaceEntry(deletedPath, scope);
      setDeleteOpen(false);
      toast('已删除');
      onDeleted?.(deletedPath);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除失败', 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const requestClose = useCallback(() => {
    if (saving || renameBusy || deleteBusy) return;
    if (isDirty) {
      setPendingAction('close');
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [deleteBusy, isDirty, onClose, renameBusy, saving]);

  const requestReload = useCallback(() => {
    if (!entry || loading || saving) return;
    if (isDirty) {
      setPendingAction('reload');
      setDiscardConfirmOpen(true);
      return;
    }
    void fetchDocument(entry);
  }, [entry, fetchDocument, isDirty, loading, saving]);

  const handleConfirmDiscard = () => {
    const action = pendingAction;
    setDiscardConfirmOpen(false);
    setPendingAction(null);
    if (action === 'close') {
      onClose();
    } else if (action === 'reload' && entry) {
      void fetchDocument(entry);
    }
  };

  const handleUndo = () => {
    if (!doc || saving) return;
    setDraftContent(doc.content);
    setSaveError(null);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (doc && isDirty && !saving) {
        void handleSave(false);
      }
    }
  };

  const lineCount = useMemo(() => {
    if (!doc) return 0;
    if (draftContent.length === 0) return 0;
    return draftContent.split('\n').length;
  }, [doc, draftContent]);

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="ui-dialog-overlay" />
          <Dialog.Content
            className={`ui-dialog-content ws-viewer-dialog ${fullscreen ? 'ws-viewer-dialog--fullscreen' : ''}`.trim()}
            aria-busy={saving || loading || undefined}
            aria-describedby={undefined}
            onKeyDown={handleKeyDown}
            onEscapeKeyDown={(e) => {
              if (saving || subDialogOpen) {
                e.preventDefault();
                return;
              }
              if (isDirty) {
                e.preventDefault();
                requestClose();
              }
            }}
            onPointerDownOutside={(e) => {
              if (saving || subDialogOpen) {
                e.preventDefault();
                return;
              }
              if (isDirty) {
                e.preventDefault();
                requestClose();
              }
            }}
            onCloseAutoFocus={(e) => {
              const target = previousFocusRef.current;
              previousFocusRef.current = null;
              if (target && target.isConnected) {
                e.preventDefault();
                target.focus({ preventScroll: true });
              }
            }}
          >
            <header className="ws-viewer__head">
              <div className="ws-viewer__title-wrap">
                {entry ? (
                  <Icon
                    name={fileHeaderIcon(entry)}
                    size={16}
                    className="ws-viewer__title-icon"
                  />
                ) : null}
                <Dialog.Title className="ws-viewer__title" title={entry?.path}>
                  {entry?.path ?? ''}
                </Dialog.Title>
                {isDirty ? (
                  <span
                    className="ws-viewer__dirty-dot"
                    aria-label="未保存"
                    title="有未保存的更改"
                  />
                ) : null}
              </div>

              <div className="ws-viewer__actions">
                {doc?.previewKind === 'markdown' ? (
                  <SegmentedControl<'preview' | 'edit'>
                    ariaLabel="文档视图"
                    value={mode}
                    onChange={setMode}
                    options={[
                      {
                        value: 'preview',
                        label: <Icon name="eye" size={14} />,
                        ariaLabel: '预览',
                        title: '预览',
                      },
                      {
                        value: 'edit',
                        label: <Icon name="edit" size={14} />,
                        ariaLabel: '编辑',
                        title: '编辑',
                      },
                    ]}
                  />
                ) : null}

                {!unsupported && doc ? (
                  <>
                    <IconButton
                      size="sm"
                      icon={copied ? 'check' : 'copy'}
                      label="复制内容"
                      onClick={() => void handleCopy()}
                    />
                    <IconButton
                      size="sm"
                      icon="refresh"
                      label="重新加载"
                      disabled={loading || saving}
                      onClick={requestReload}
                    />
                    <IconButton
                      size="sm"
                      icon="undo"
                      label="撤销修改"
                      disabled={!isDirty || saving}
                      onClick={handleUndo}
                    />
                    <IconButton
                      size="sm"
                      icon="save"
                      label="保存"
                      loading={saving}
                      disabled={!isDirty || saving}
                      active={isDirty}
                      onClick={() => void handleSave(false)}
                    />
                  </>
                ) : null}

                {entry ? (
                  <>
                    <IconButton
                      size="sm"
                      icon="download"
                      label="下载文件"
                      loading={downloading}
                      disabled={downloading}
                      onClick={() => void handleDownload()}
                    />
                    <Dropdown
                      align="end"
                      modal={false}
                      onCloseAutoFocus={onCloseAutoFocus}
                      trigger={
                        <IconButton
                          size="sm"
                          icon="ellipsis"
                          label="文件操作"
                          disabled={saving}
                        />
                      }
                    >
                      <DropdownItem
                        disabled={isDirty || saving}
                        onSelect={() => openAfterMenu(() => {
                          setRenameError(null);
                          setRenameOpen(true);
                        })}
                      >
                        <Icon name="edit" size={14} />
                        <span>重命名</span>
                      </DropdownItem>
                      <DropdownItem onSelect={() => void handleCopyPath()}>
                        <Icon name="link" size={14} />
                        <span>复制路径</span>
                      </DropdownItem>
                      <DropdownSeparator />
                      <DropdownItem
                        danger
                        disabled={saving}
                        onSelect={() => openAfterMenu(() => setDeleteOpen(true))}
                      >
                        <Icon name="trash" size={14} />
                        <span>删除</span>
                      </DropdownItem>
                    </Dropdown>
                  </>
                ) : null}

                <span className="ws-viewer__divider" aria-hidden="true" />

                <IconButton
                  size="sm"
                  icon={fullscreen ? 'compress' : 'expand'}
                  label={fullscreen ? '退出全屏' : '全屏'}
                  className="ws-viewer__expand-btn"
                  onClick={() => setFullscreen((v) => !v)}
                />
                <IconButton
                  size="sm"
                  icon="close"
                  label="关闭"
                  disabled={saving}
                  onClick={requestClose}
                />
              </div>
            </header>

            {saveError ? (
              <div className="ws-viewer__banner">
                <ErrorBanner
                  message={saveError.message}
                  onRetry={
                    saveError.conflict ? undefined : () => void handleSave(false)
                  }
                />
                {saveError.conflict ? (
                  <div className="ws-viewer__conflict-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={saving || loading}
                      onClick={() => entry && void fetchDocument(entry)}
                    >
                      重新加载
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={saving}
                      onClick={() => void handleSave(true)}
                    >
                      覆盖保存
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="ws-viewer__body">
              {unsupported && entry ? (
                <div className="ws-viewer__center">
                  <EmptyState
                    icon={entry.unsupportedReason === 'image' ? 'image' : 'file'}
                    title={
                      entry.unsupportedReason === 'image'
                        ? '图片暂不支持预览'
                        : '暂不支持预览此文件类型'
                    }
                    action={
                      <span className="ws-viewer__unsupported-meta">
                        {entry.name} · {formatBytes(entry.size)}
                      </span>
                    }
                  />
                </div>
              ) : loading && !doc ? (
                <div className="ws-viewer__center">
                  <LoadingSpinner label="读取文件内容" />
                </div>
              ) : loadError && !doc ? (
                <div className="ws-viewer__center">
                  <ErrorBanner
                    message={loadError}
                    onRetry={() => entry && void fetchDocument(entry)}
                  />
                </div>
              ) : doc ? (
                doc.previewKind === 'markdown' && mode === 'preview' ? (
                  <div className="ws-viewer__prose-scroll">
                    <div className="ws-viewer__prose-inner content-stack">
                      <MarkdownDocument
                        content={draftContent}
                        collapsePrefix={`ws-file:${doc.path}`}
                        visualHtmlRender={markdownVisualRender}
                        defaultHtmlPreview={markdownVisualRender}
                      />
                    </div>
                  </div>
                ) : (
                  <textarea
                    aria-label="文件内容编辑"
                    className="ws-viewer__editor"
                    value={draftContent}
                    readOnly={saving}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(e) => {
                      setDraftContent(e.target.value);
                      if (saveError) setSaveError(null);
                    }}
                  />
                )
              ) : null}
            </div>

            {doc ? (
              <footer className="ws-viewer__foot">
                <span>{doc.previewKind === 'markdown' ? 'Markdown' : '文本'}</span>
                <span>{lineCount} 行</span>
                <span>{formatBytes(doc.size)}</span>
                {isDirty ? (
                  <span className="ws-viewer__foot-dirty">未保存</span>
                ) : null}
              </footer>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={(next) => {
          if (!next) {
            setDiscardConfirmOpen(false);
            setPendingAction(null);
          }
        }}
        title="放弃未保存的更改？"
        message={`「${entry?.name ?? ''}」包含未保存的修改，确认放弃？`}
        confirmLabel="放弃"
        danger
        onConfirm={handleConfirmDiscard}
      />

      <WorkspaceNameDialog
        open={renameOpen && entry !== null}
        mode="rename"
        parentDir={entry ? parentDirOf(entry.path) : ''}
        initialName={entry?.name ?? ''}
        entryKind={entry?.kind ?? 'file'}
        busy={renameBusy}
        error={renameError}
        onOpenChange={(next) => {
          if (!next && !renameBusy) {
            setRenameOpen(false);
            setRenameError(null);
          }
        }}
        onSubmit={handleRenameSubmit}
      />

      <ConfirmDialog
        open={deleteOpen && entry !== null}
        onOpenChange={(next) => {
          if (!next && !deleteBusy) setDeleteOpen(false);
        }}
        title="删除文件？"
        message={`确认永久删除「${entry?.name ?? ''}」？此操作无法撤销。`}
        confirmLabel="删除"
        danger
        busy={deleteBusy}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
