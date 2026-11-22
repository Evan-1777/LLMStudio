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
} from '../../core/types';
import { MarkdownDocument } from '../../rendering/ContentRenderer';
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
  gateway,
  scope,
  onClose,
}: {
  entry: WorkspaceEntry | null;
  gateway: GatewayClient;
  scope?: TopicScope;
  onClose: () => void;
}) {
  const { toast } = useApp();

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
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'close' | 'reload' | null>(null);

  const loadAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const open = entry !== null;
  const unsupported = entry?.previewKind === 'unsupported';
  const isDirty = Boolean(doc && draftContent !== doc.content);

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
    async (target: WorkspaceEntry) => {
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
        setMode(fileRes.previewKind === 'markdown' ? 'preview' : 'edit');
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

    if (!entry) {
      setFullscreen(false);
      return;
    }
    if (entry.previewKind === 'unsupported') {
      setLoading(false);
      return;
    }
    void fetchDocument(entry);
  }, [entry, fetchDocument]);

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
    [doc, draftContent, gateway, saving, scope, toast],
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

  const requestClose = useCallback(() => {
    if (saving) return;
    if (isDirty) {
      setPendingAction('close');
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [isDirty, onClose, saving]);

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
              if (saving || discardConfirmOpen) {
                e.preventDefault();
                return;
              }
              if (isDirty) {
                e.preventDefault();
                requestClose();
              }
            }}
            onPointerDownOutside={(e) => {
              if (saving || discardConfirmOpen) {
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
    </>
  );
}
