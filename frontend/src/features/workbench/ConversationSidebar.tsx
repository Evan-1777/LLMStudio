import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
} from '../../components/ui';
import { GatewayError } from '../../core/gateway';
import type { Conversation } from '../../core/types';
import {
  SessionInspector,
  type DraftSessionParams,
} from './SessionInspector';

function formatShortTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getDateBucket(iso: string): '今天' | '昨天' | '更早' {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '更早';
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const ts = dt.getTime();
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfYesterday) return '昨天';
  return '更早';
}

export function ConversationSidebar({
  conversations,
  activeConversationId,
  activeConversation,
  draftSessionParams,
  inspectorOpen,
  drawerOpen,
  isBusy,
  onSelectConversation,
  onNewConversation,
  onCloseInspector,
  onCloseDrawer,
  onConversationPatched,
  onConversationDeleted,
  onSaveDraftSessionParams,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  draftSessionParams: DraftSessionParams;
  inspectorOpen: boolean;
  drawerOpen: boolean;
  isBusy: boolean;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onCloseInspector: () => void;
  onCloseDrawer: () => void;
  onConversationPatched: (updated: Conversation) => void;
  onConversationDeleted: (deletedId: string) => void;
  onSaveDraftSessionParams: (next: DraftSessionParams) => void;
}) {
  const { gateway, upsertLocalConversation, removeLocalConversation, toast } =
    useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [renamingConv, setRenamingConv] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const [deletingConv, setDeletingConv] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, searchQuery]);

  // Group in server-returned order without resorting by UUID.
  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: Conversation[] }> = [];
    for (const c of filtered) {
      const bucket = getDateBucket(c.updatedAt || c.createdAt);
      const last = groups[groups.length - 1];
      if (!last || last.label !== bucket) {
        groups.push({ label: bucket, items: [c] });
      } else {
        last.items.push(c);
      }
    }
    return groups;
  }, [filtered]);

  const openRename = (conv: Conversation) => {
    setRenamingConv(conv);
    setRenameTitle(conv.title);
    setRenameError(null);
  };

  const handleRenameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!renamingConv) return;
    const trimmed = renameTitle.trim();
    if (!trimmed) {
      setRenameError('话题标题不能为空');
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const updated = await gateway.patchConversation(renamingConv.id, {
        title: trimmed,
      });
      upsertLocalConversation(updated);
      onConversationPatched(updated);
      setRenamingConv(null);
    } catch (err) {
      setRenameError(
        err instanceof GatewayError ? err.message : '重命名失败，请重试',
      );
    } finally {
      setRenaming(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingConv) return;
    setDeleting(true);
    try {
      await gateway.deleteConversation(deletingConv.id);
      removeLocalConversation(deletingConv.id);
      const deletedId = deletingConv.id;
      setDeletingConv(null);
      onConversationDeleted(deletedId);
      toast('话题已删除');
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <aside
        className={`wb-history ${drawerOpen ? 'wb-history--drawer-open' : ''}`.trim()}
        aria-label={inspectorOpen ? '话题参数' : '话题'}
      >
        {inspectorOpen ? (
          <SessionInspector
            conversation={activeConversation}
            draftParams={draftSessionParams}
            isBusy={isBusy}
            onClose={onCloseInspector}
            onSaved={(updated) => {
              upsertLocalConversation(updated);
              onConversationPatched(updated);
            }}
            onSaveDraft={onSaveDraftSessionParams}
          />
        ) : (
          <>
            <div className="wb-history__head">
              <span>话题</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <IconButton
                  size="sm"
                  icon="plus"
                  label="新建话题"
                  onClick={onNewConversation}
                />
                {drawerOpen ? (
                  <IconButton
                    size="sm"
                    icon="close"
                    label="关闭话题栏"
                    className="wb-mobile-only"
                    onClick={onCloseDrawer}
                  />
                ) : null}
              </div>
            </div>

            <div className="wb-search-wrap">
              <Icon name="search" size={14} className="wb-search-icon" />
              <input
                type="search"
                className="wb-search-input"
                aria-label="搜索话题"
                placeholder="搜索话题"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="wb-topic-groups">
              {grouped.length === 0 ? (
                <div
                  style={{
                    padding: '24px 10px',
                    textAlign: 'center',
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {searchQuery.trim() ? '无匹配话题' : '暂无话题'}
                </div>
              ) : (
                grouped.map((group) => (
                  <div key={group.label}>
                    <div className="wb-topic-group__label">{group.label}</div>
                    {group.items.map((conv) => {
                      const active = conv.id === activeConversationId;
                      return (
                        <div
                          key={conv.id}
                          className={`wb-topic-row ${active ? 'wb-topic-row--active' : ''}`.trim()}
                        >
                          <button
                            type="button"
                            className="wb-topic-row__btn"
                            title={conv.title}
                            aria-current={active ? 'true' : undefined}
                            onClick={() => onSelectConversation(conv.id)}
                          >
                            <span className="wb-topic-row__title">
                              {conv.title}
                            </span>
                            <span className="wb-topic-row__time">
                              {formatShortTime(conv.updatedAt || conv.createdAt)}
                            </span>
                          </button>
                          <div className="wb-topic-row__actions">
                            <IconButton
                              size="sm"
                              icon="edit"
                              label={`重命名 ${conv.title}`}
                              disabled={isBusy && active}
                              onClick={() => openRename(conv)}
                            />
                            <IconButton
                              size="sm"
                              icon="trash"
                              tone="danger"
                              label={`删除 ${conv.title}`}
                              disabled={isBusy && active}
                              onClick={() => setDeletingConv(conv)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </aside>

      <Modal
        open={renamingConv !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) setRenamingConv(null);
        }}
        title="重命名话题"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={renaming}
              onClick={() => setRenamingConv(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="rename-topic-form"
              variant="primary"
              disabled={renaming}
            >
              {renaming ? '保存中...' : '保存'}
            </Button>
          </>
        }
      >
        <form
          id="rename-topic-form"
          noValidate
          onSubmit={(e) => void handleRenameSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {renameError ? <ErrorBanner message={renameError} /> : null}
          <Field label="标题" htmlFor="rename-topic-input">
            <Input
              id="rename-topic-input"
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deletingConv !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeletingConv(null);
        }}
        title="删除话题？"
        message={`确认删除「${deletingConv?.title ?? ''}」及其中的全部消息？此操作无法撤销。`}
        confirmLabel="删除"
        busy={deleting}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
