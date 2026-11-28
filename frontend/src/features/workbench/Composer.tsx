import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useApp } from '../../app/AppProvider';
import {
  ErrorBanner,
  Icon,
  IconButton,
} from '../../components/ui';
import type {
  ContentBlock,
  Message,
  ReasoningEffort,
} from '../../core/types';
import type { StreamingDraft } from '../chat/chatReducer';
import { AttachmentChips } from './AttachmentChips';
import { ContextUsageRing } from './ContextUsageRing';
import { ModelPicker } from './ModelPicker';
import { computeContextUsage } from './contextUsage';
import {
  FILE_INPUT_ACCEPT,
  attachmentToContentBlock,
  clipboardHasPlainText,
  collectClipboardImageFiles,
  isWithinRequestLimit,
  readAttachmentFile,
  revokeAttachmentResources,
  type PendingAttachment,
} from './attachments';

export function Composer({
  compact = false,
  selectedProviderId,
  selectedModelId,
  reasoningEffort,
  mcpActive = false,
  onToggleMcp,
  savingModel = false,
  savingEffort,
  isBusy,
  canStop,
  messages = [],
  allMessages,
  streaming = null,
  systemPrompt = '',
  contextWindow,
  onSelectModel,
  onChangeReasoningEffort,
  onStop,
  onSend,
  onCompact,
  canCompact = false,
  isCompacting = false,
}: {
  compact?: boolean;
  selectedProviderId: string;
  selectedModelId: string;
  reasoningEffort: ReasoningEffort;
  mcpActive?: boolean;
  onToggleMcp?: () => void;
  savingModel?: boolean;
  savingEffort: boolean;
  isBusy: boolean;
  canStop?: boolean;
  messages?: readonly Message[];
  allMessages?: readonly Message[];
  streaming?: StreamingDraft | null;
  systemPrompt?: string;
  contextWindow?: number;
  onSelectModel: (providerId: string, modelId: string) => void;
  onChangeReasoningEffort: (effort: ReasoningEffort) => Promise<boolean> | void;
  onStop: () => void;
  onSend: (opts: {
    blocks: ContentBlock[];
    text: string;
    webSearch: boolean;
    searchEngineId?: string;
    onOptimisticStart: () => void;
    onPrepareRollback: () => void;
    onAccepted: () => void;
  }) => Promise<boolean>;
  onCompact?: () => Promise<void> | void;
  canCompact?: boolean;
  isCompacting?: boolean;
}) {
  const { settings, resources, toast } = useApp();

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerId = useId();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const drawerToggleRef = useRef<HTMLButtonElement | null>(null);
  const drawerInnerRef = useRef<HTMLDivElement | null>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;
  const pendingSnapshotRef = useRef<PendingAttachment[] | null>(null);
  const draftVersionRef = useRef(0);

  useEffect(() => {
    if (!compact) {
      setDrawerOpen(false);
    }
  }, [compact]);

  useEffect(() => {
    const inner = drawerInnerRef.current;
    if (!inner) return;
    inner.inert = compact && !drawerOpen;
  }, [compact, drawerOpen]);

  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        revokeAttachmentResources(att);
      }
      if (pendingSnapshotRef.current) {
        for (const att of pendingSnapshotRef.current) {
          revokeAttachmentResources(att);
        }
        pendingSnapshotRef.current = null;
      }
    };
  }, []);

  const enabledEngines = useMemo(
    () => resources.searchEngines.filter((e) => e.enabled),
    [resources.searchEngines],
  );

  const activeEngine = enabledEngines.find((engine) => engine.isDefault) ?? enabledEngines[0];

  const contextUsage = useMemo(
    () =>
      computeContextUsage({
        messages,
        allMessages,
        streaming,
        systemPrompt,
        draft,
        attachments,
        contextWindow,
      }),
    [allMessages, attachments, contextWindow, draft, messages, streaming, systemPrompt],
  );

  const readyAttachments = attachments.filter((a) => a.status === 'ready');
  const hasReading = attachments.some((a) => a.status === 'reading');
  const hasAttachmentErrors = attachments.some((a) => a.status === 'error');
  const hasContent = draft.trim().length > 0 || readyAttachments.length > 0;
  const canSend =
    !isBusy &&
    !savingModel &&
    !savingEffort &&
    !submitting &&
    !hasReading &&
    hasContent &&
    Boolean(selectedProviderId && selectedModelId);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const addFiles = (files: Iterable<File>) => {
    const added: PendingAttachment[] = [];
    for (const file of files) {
      if (!file) continue;
      added.push(
        readAttachmentFile(file, {
          onUpdate: (updated) => {
            setAttachments((prev) =>
              prev.map((p) => (p.id === updated.id ? updated : p)),
            );
          },
        }),
      );
    }
    if (added.length === 0) return;
    draftVersionRef.current += 1;
    setAttachments((prev) => [...prev, ...added]);
    setBodyError(null);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    addFiles(Array.from(files));
    e.target.value = '';
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = collectClipboardImageFiles(e.clipboardData);
    if (images.length === 0) return;
    // An image-only clipboard is consumed; mixed content keeps the native text
    // insertion, caret and undo behaviour alongside the added images.
    if (!clipboardHasPlainText(e.clipboardData)) {
      e.preventDefault();
    }
    addFiles(images);
  };

  const handleRemoveAttachment = (id: string) => {
    const target = attachmentsRef.current.find((a) => a.id === id);
    if (target) revokeAttachmentResources(target);
    draftVersionRef.current += 1;
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setBodyError(null);
  };

  const submitCurrent = async () => {
    if (!canSend) return;
    if (hasAttachmentErrors) {
      setBodyError('存在无效附件，请移除后再发送');
      return;
    }
    setBodyError(null);

    const trimmed = draft.trim();
    const blocks: ContentBlock[] = [
      ...readyAttachments.map(attachmentToContentBlock),
      ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
    ];

    if (blocks.length === 0) return;

    const sizeCheckPayload = {
      blocks,
      providerId: selectedProviderId,
      modelId: selectedModelId,
      params: { reasoningEffort },
      ...(webSearch && activeEngine
        ? { webSearch: true, searchEngineId: activeEngine.engineId }
        : {}),
    };

    if (!isWithinRequestLimit(sizeCheckPayload)) {
      setBodyError('请求总大小超过 16 MiB 限制，请缩减文本或附件');
      return;
    }

    const submitVersion = draftVersionRef.current;
    const snapshotDraft = draft;
    const snapshotAttachments = attachments;

    setSubmitting(true);
    try {
      await onSend({
        blocks,
        text: trimmed,
        webSearch: Boolean(webSearch && activeEngine),
        searchEngineId: activeEngine?.engineId,
        onOptimisticStart: () => {
          pendingSnapshotRef.current = snapshotAttachments;
          setDraft('');
          setAttachments([]);
          setBodyError(null);
          setDrawerOpen(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = '40px';
          }
        },
        onPrepareRollback: () => {
          pendingSnapshotRef.current = null;
          if (draftVersionRef.current === submitVersion) {
            setDraft(snapshotDraft);
            setAttachments(snapshotAttachments);
            window.requestAnimationFrame(() => {
              adjustHeight();
              textareaRef.current?.focus();
            });
          } else {
            for (const att of snapshotAttachments) {
              revokeAttachmentResources(att);
            }
          }
        },
        onAccepted: () => {
          pendingSnapshotRef.current = null;
          for (const att of snapshotAttachments) {
            revokeAttachmentResources(att);
          }
        },
      });
    } finally {
      setSubmitting(false);
    }
  };

  const stoppable = canStop ?? isBusy;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (stoppable) {
      onStop();
      return;
    }
    if (isBusy) return;
    void submitCurrent();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }
    if (e.key !== 'Enter') return;

    const shouldSend = settings.enterToSend
      ? !e.shiftKey
      : e.ctrlKey || e.metaKey;
    if (!shouldSend) return;

    e.preventDefault();
    if (isBusy) return;
    void submitCurrent();
  };

  const handleToggleSearch = () => {
    if (enabledEngines.length === 0) {
      toast('请先在设置中启用搜索引擎', 'error');
      return;
    }
    setWebSearch((v) => !v);
  };

  const handleDrawerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    e.preventDefault();
    e.stopPropagation();
    setDrawerOpen(false);
    drawerToggleRef.current?.focus({ preventScroll: true });
  };

  const webSearchActive = webSearch && Boolean(activeEngine);
  const drawerIndicatorLevel: 'danger' | 'warning' | 'active' | undefined =
    contextUsage.rawPercent !== null && contextUsage.rawPercent >= 90
      ? 'danger'
      : contextUsage.rawPercent !== null && contextUsage.rawPercent >= 70
        ? 'warning'
        : webSearchActive || mcpActive
          ? 'active'
          : undefined;

  const drawerTabIndex = compact && !drawerOpen ? -1 : undefined;

  const webSearchButton = (
    <IconButton
      size="sm"
      icon="globe"
      tabIndex={drawerTabIndex}
      active={webSearchActive}
      aria-pressed={webSearchActive}
      label={webSearchActive ? '关闭联网搜索' : '开启联网搜索'}
      disabled={isBusy}
      onClick={handleToggleSearch}
    />
  );

  const mcpButton = onToggleMcp ? (
    <IconButton
      size="sm"
      icon="wrench"
      tabIndex={drawerTabIndex}
      active={mcpActive}
      aria-pressed={mcpActive}
      label={mcpActive ? '关闭 MCP 工具' : '开启 MCP 工具'}
      disabled={isBusy}
      onClick={onToggleMcp}
    />
  ) : null;

  const attachButton = (
    <IconButton
      size="sm"
      icon="paperclip"
      tabIndex={drawerTabIndex}
      label="添加附件"
      disabled={isBusy}
      onClick={() => fileInputRef.current?.click()}
    />
  );

  const contextRingControl = (
    <ContextUsageRing
      usage={contextUsage}
      onCompact={onCompact}
      canCompact={Boolean(
        canCompact && !isBusy && !isCompacting && contextUsage.canCompact,
      )}
      isCompacting={isCompacting}
      triggerTabIndex={drawerTabIndex}
    />
  );

  const primaryActionButton = stoppable ? (
    <button
      key="stop-btn"
      type="button"
      className="wb-send-btn wb-send-btn--stop"
      aria-label="停止生成"
      title="停止生成"
      onClick={onStop}
    >
      <Icon name="stop" size={14} />
    </button>
  ) : (
    <button
      key="send-btn"
      type="submit"
      className="wb-send-btn"
      aria-label="发送消息"
      title="发送消息"
      disabled={!canSend}
    >
      <Icon name="arrowUp" size={16} />
    </button>
  );

  return (
    <div className="wb-composer-wrap">
      <form className="wb-composer" onSubmit={handleSubmit}>
        {bodyError ? (
          <div style={{ marginBottom: 6 }}>
            <ErrorBanner message={bodyError} />
          </div>
        ) : null}

        <AttachmentChips
          attachments={attachments}
          onRemove={handleRemoveAttachment}
        />

        <textarea
          ref={textareaRef}
          className="wb-draft"
          aria-label="消息输入框"
          placeholder={
            selectedModelId
              ? '输入消息'
              : '未选择模型'
          }
          rows={1}
          value={draft}
          onChange={(e) => {
            draftVersionRef.current += 1;
            setDraft(e.target.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept={FILE_INPUT_ACCEPT}
          onChange={handleFileChange}
        />

        <div className="wb-composer__tools">
          {compact ? (
            <IconButton
              ref={drawerToggleRef}
              size="sm"
              className="wb-composer-drawer-toggle"
              icon="plus"
              active={drawerOpen}
              aria-expanded={drawerOpen}
              aria-controls={drawerId}
              data-indicator={!drawerOpen ? drawerIndicatorLevel : undefined}
              label={drawerOpen ? '收起工具' : '展开工具'}
              onClick={() => setDrawerOpen((v) => !v)}
            />
          ) : (
            <>
              {webSearchButton}
              {mcpButton}
              {attachButton}
            </>
          )}

          <ModelPicker
            providers={resources.providers}
            selectedProviderId={selectedProviderId}
            selectedModelId={selectedModelId}
            reasoningEffort={reasoningEffort}
            disabled={isBusy}
            busy={savingModel}
            savingEffort={savingEffort}
            onSelect={onSelectModel}
            onChangeReasoningEffort={onChangeReasoningEffort}
          />

          <div className="wb-composer__right">
            {!compact && contextRingControl}
            {primaryActionButton}
          </div>
        </div>

        {compact && (
          <div
            id={drawerId}
            className={`wb-composer-drawer${
              drawerOpen ? ' wb-composer-drawer--open' : ''
            }`}
            aria-hidden={!drawerOpen}
            onKeyDown={handleDrawerKeyDown}
          >
            <div ref={drawerInnerRef} className="wb-composer-drawer__inner">
              <div className="wb-composer-drawer__tray">
                <div className="wb-composer-drawer__actions">
                  {attachButton}
                  {webSearchButton}
                  {mcpButton}
                </div>
                <div className="wb-composer-drawer__right">
                  {contextRingControl}
                </div>
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
