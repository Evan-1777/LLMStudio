import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import {
  Dropdown,
  DropdownItem,
  ErrorBanner,
  Icon,
  IconButton,
  Popover,
} from '../../components/ui';
import {
  REASONING_EFFORT_LEVELS,
  type ContentBlock,
  type ReasoningEffort,
} from '../../core/types';
import { AttachmentChips } from './AttachmentChips';
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

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

export function Composer({
  selectedProviderId,
  selectedModelId,
  reasoningEffort,
  savingEffort,
  isBusy,
  onChangeReasoningEffort,
  onStop,
  onSend,
}: {
  selectedProviderId: string;
  selectedModelId: string;
  reasoningEffort: ReasoningEffort;
  savingEffort: boolean;
  isBusy: boolean;
  onChangeReasoningEffort: (effort: ReasoningEffort) => void;
  onStop: () => void;
  onSend: (opts: {
    blocks: ContentBlock[];
    text: string;
    webSearch: boolean;
    searchEngineId?: string;
    onAccepted: () => void;
  }) => Promise<boolean>;
}) {
  const location = useLocation();
  const { settings, resources, toast } = useApp();

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [selectedEngineId, setSelectedEngineId] = useState<string>('');
  const [effortOpen, setEffortOpen] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;

  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        revokeAttachmentResources(att);
      }
    };
  }, []);

  const enabledEngines = useMemo(
    () => resources.searchEngines.filter((e) => e.enabled),
    [resources.searchEngines],
  );

  const activeEngine = useMemo(() => {
    if (enabledEngines.length === 0) return null;
    return (
      enabledEngines.find((e) => e.engineId === selectedEngineId) ??
      enabledEngines.find((e) => e.isDefault) ??
      enabledEngines[0]
    );
  }, [enabledEngines, selectedEngineId]);

  const readyAttachments = attachments.filter((a) => a.status === 'ready');
  const hasReading = attachments.some((a) => a.status === 'reading');
  const hasAttachmentErrors = attachments.some((a) => a.status === 'error');
  const hasContent = draft.trim().length > 0 || readyAttachments.length > 0;
  const canSend =
    !isBusy &&
    !savingEffort &&
    !submitting &&
    !hasReading &&
    hasContent &&
    Boolean(selectedProviderId && selectedModelId);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, Math.max(40, el.scrollHeight))}px`;
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

    setSubmitting(true);
    try {
      await onSend({
        blocks,
        text: trimmed,
        webSearch: Boolean(webSearch && activeEngine),
        searchEngineId: activeEngine?.engineId,
        onAccepted: () => {
          for (const att of attachmentsRef.current) {
            revokeAttachmentResources(att);
          }
          setDraft('');
          setAttachments([]);
          setBodyError(null);
          if (textareaRef.current) {
            textareaRef.current.style.height = '40px';
          }
        },
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isBusy) {
      onStop();
      return;
    }
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
              : '请先选择或配置可用模型'
          }
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        <div className="wb-composer__tools">
          {/* 1. Web Search Toggle + Engine Menu */}
          <div
            className={`wb-tool-pill ${
              webSearch && activeEngine ? 'wb-tool-pill--active' : ''
            }`.trim()}
          >
            <IconButton
              size="sm"
              icon="globe"
              active={webSearch && Boolean(activeEngine)}
              label={
                webSearch && activeEngine ? '关闭联网搜索' : '开启联网搜索'
              }
              disabled={isBusy}
              onClick={handleToggleSearch}
            />
            <Dropdown
              side="top"
              align="start"
              trigger={
                <IconButton
                  size="sm"
                  icon="chevronDown"
                  label="选择搜索引擎"
                  disabled={isBusy}
                  style={{ width: 20, minWidth: 20 }}
                />
              }
            >
              {enabledEngines.length === 0 ? (
                <div style={{ padding: '6px 8px', fontSize: 12 }}>
                  <Link
                    to="/settings/plugins"
                    state={{ from: `${location.pathname}${location.search}` }}
                    className="ui-menu-item"
                  >
                    <Icon name="settings" size={14} />
                    <span>配置搜索引擎</span>
                  </Link>
                </div>
              ) : (
                enabledEngines.map((eng) => {
                  const selected = activeEngine?.engineId === eng.engineId;
                  return (
                    <DropdownItem
                      key={eng.engineId}
                      active={selected}
                      onSelect={() => {
                        setSelectedEngineId(eng.engineId);
                        setWebSearch(true);
                      }}
                    >
                      <span>{eng.displayName || eng.engineId}</span>
                      {selected ? (
                        <Icon
                          name="check"
                          size={14}
                          className="wb-toolbar__spacer"
                        />
                      ) : null}
                    </DropdownItem>
                  );
                })
              )}
            </Dropdown>
          </div>

          {/* 2. Attachment Upload */}
          <IconButton
            size="sm"
            icon="paperclip"
            label="添加附件"
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
          />

          {/* 3. Reasoning Effort (6 levels always selectable) */}
          <Popover
            open={effortOpen}
            onOpenChange={setEffortOpen}
            side="top"
            align="start"
            trigger={
              <button
                type="button"
                className={`ui-icon-btn ui-icon-btn--sm ${
                  reasoningEffort !== 'none' ? 'ui-icon-btn--active' : ''
                }`.trim()}
                style={
                  reasoningEffort !== 'none'
                    ? { width: 'auto', padding: '0 7px', gap: 4 }
                    : undefined
                }
                aria-label={`思考强度 (${EFFORT_LABELS[reasoningEffort]})`}
                title={savingEffort ? '正在保存思考强度' : `思考强度 (${EFFORT_LABELS[reasoningEffort]})`}
                aria-busy={savingEffort}
                disabled={isBusy || savingEffort}
              >
                <Icon name="lightbulb" size={15} />
                {reasoningEffort !== 'none' ? (
                  <span className="wb-effort-badge">
                    {EFFORT_LABELS[reasoningEffort]}
                  </span>
                ) : null}
              </button>
            }
          >
            <div
              role="radiogroup"
              aria-label="思考强度"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 136,
              }}
            >
              {REASONING_EFFORT_LEVELS.map((level) => {
                const active = reasoningEffort === level;
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`ui-menu-item ${
                      active ? 'ui-menu-item--active' : ''
                    }`.trim()}
                    onClick={() => {
                      onChangeReasoningEffort(level);
                      setEffortOpen(false);
                    }}
                  >
                    <span style={{ flex: 1, textAlign: 'left' }}>
                      {EFFORT_LABELS[level]}
                    </span>
                    {active ? <Icon name="check" size={14} /> : null}
                  </button>
                );
              })}
            </div>
          </Popover>

          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept={FILE_INPUT_ACCEPT}
            onChange={handleFileChange}
          />

          {isBusy ? (
            <button
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
              type="submit"
              className="wb-send-btn"
              aria-label="发送消息"
              title="发送消息"
              disabled={!canSend}
            >
              <Icon name="arrowUp" size={16} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
