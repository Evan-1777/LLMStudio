import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  Dropdown,
  DropdownItem,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
} from '../../components/ui';
import { GatewayError } from '../../core/gateway';
import type { Conversation, ConversationGroup } from '../../core/types';
import {
  SessionInspector,
  type DraftSessionParams,
} from './SessionInspector';

function formatShortTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface DropTarget {
  bucketKey: string;
  pinned: boolean;
  groupId: string | null;
  beforeId: string | null;
}

interface BucketSection {
  key: string;
  label: string;
  pinned: boolean;
  group: ConversationGroup | null;
  items: Conversation[];
}

function bucketKeyForTarget(pinned: boolean, groupId: string | null): string {
  if (pinned) return 'pinned';
  return groupId ? `group:${groupId}` : 'ungrouped';
}

export function ConversationSidebar({
  assistantId,
  conversations,
  groups,
  activeConversationId,
  activeConversation,
  draftSessionParams,
  inspectorOpen,
  drawerOpen,
  manageMode,
  isBusy,
  onManageModeChange,
  onSelectConversation,
  onNewConversation,
  onCloseInspector,
  onCloseDrawer,
  onConversationPatched,
  onConversationsDeleted,
  onSaveDraftSessionParams,
}: {
  assistantId: string;
  conversations: Conversation[];
  groups: ConversationGroup[];
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  draftSessionParams: DraftSessionParams;
  inspectorOpen: boolean;
  drawerOpen: boolean;
  manageMode: boolean;
  isBusy: boolean;
  onManageModeChange: (next: boolean) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onCloseInspector: () => void;
  onCloseDrawer: () => void;
  onConversationPatched: (updated: Conversation) => void;
  onConversationsDeleted: (
    deletedIds: string[],
    remaining: Conversation[],
  ) => void;
  onSaveDraftSessionParams: (next: DraftSessionParams) => void;
}) {
  const {
    gateway,
    connectionEpoch,
    upsertLocalConversation,
    applyConversationOrganizationSnapshot,
    toast,
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mutating, setMutating] = useState(false);

  // Conversation rename modal
  const [renamingConv, setRenamingConv] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // Group create / rename modal
  const [groupModalMode, setGroupModalMode] = useState<
    { kind: 'create' } | { kind: 'rename'; group: ConversationGroup } | null
  >(null);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [groupFormError, setGroupFormError] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState(false);

  // Delete conversation(s) confirm
  const [deletingConvs, setDeletingConvs] = useState<Conversation[] | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  // Delete group confirm
  const [deletingGroup, setDeletingGroup] = useState<ConversationGroup | null>(
    null,
  );
  const [deletingGroupBusy, setDeletingGroupBusy] = useState(false);

  // Shared move-to-group modal (used by both row menu and manage mode)
  const [moveTargetIds, setMoveTargetIds] = useState<string[] | null>(null);
  const [selectedMoveGroupId, setSelectedMoveGroupId] = useState<string | null>(
    null,
  );
  const [movingBusy, setMovingBusy] = useState(false);

  // Pointer drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const dragSessionRef = useRef<{
    conv: Conversation;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  dropTargetRef.current = dropTarget;

  // Clear local selection & search on assistant or gateway switch.
  useEffect(() => {
    setSelectedIds(new Set());
    setSearchQuery('');
    setDraggingId(null);
    setDropTarget(null);
    dragSessionRef.current = null;
    onManageModeChange(false);
  }, [assistantId, connectionEpoch, onManageModeChange]);

  useEffect(() => {
    if (!manageMode) {
      setSelectedIds(new Set());
    }
  }, [manageMode]);

  const sortedGroups = useMemo(
    () =>
      [...groups].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        const createdCmp = a.createdAt.localeCompare(b.createdAt);
        if (createdCmp !== 0) return createdCmp;
        return a.id.localeCompare(b.id);
      }),
    [groups],
  );

  const groupById = useMemo(() => {
    const map = new Map<string, ConversationGroup>();
    for (const g of sortedGroups) {
      map.set(g.id, g);
    }
    return map;
  }, [sortedGroups]);

  const trimmedSearch = searchQuery.trim().toLowerCase();
  const isSearching = trimmedSearch.length > 0;

  const filtered = useMemo(() => {
    if (!trimmedSearch) return conversations;
    return conversations.filter((c) =>
      c.title.toLowerCase().includes(trimmedSearch),
    );
  }, [conversations, trimmedSearch]);

  const sections = useMemo<BucketSection[]>(() => {
    const pinnedItems: Conversation[] = [];
    const byGroup = new Map<string, Conversation[]>();
    for (const g of sortedGroups) {
      byGroup.set(g.id, []);
    }
    const ungroupedItems: Conversation[] = [];

    for (const conv of filtered) {
      if (conv.pinned) {
        pinnedItems.push(conv);
      } else if (conv.groupId && byGroup.has(conv.groupId)) {
        byGroup.get(conv.groupId)!.push(conv);
      } else {
        ungroupedItems.push(conv);
      }
    }

    const out: BucketSection[] = [];
    if (pinnedItems.length > 0 || draggingId !== null) {
      out.push({
        key: 'pinned',
        label: '置顶',
        pinned: true,
        group: null,
        items: pinnedItems,
      });
    }
    for (const g of sortedGroups) {
      const items = byGroup.get(g.id) ?? [];
      if (isSearching && items.length === 0) continue;
      out.push({
        key: `group:${g.id}`,
        label: g.name,
        pinned: false,
        group: g,
        items,
      });
    }
    if (
      ungroupedItems.length > 0 ||
      draggingId !== null ||
      (!isSearching && sortedGroups.length > 0)
    ) {
      out.push({
        key: 'ungrouped',
        label: sortedGroups.length > 0 || pinnedItems.length > 0 ? '未分组' : '全部话题',
        pinned: false,
        group: null,
        items: ungroupedItems,
      });
    }
    return out;
  }, [draggingId, filtered, isSearching, sortedGroups]);

  const bucketItemsMap = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of conversations) {
      const key = bucketKeyForTarget(
        Boolean(c.pinned),
        c.groupId && groupById.has(c.groupId) ? c.groupId : null,
      );
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [conversations, groupById]);

  const visibleFilteredIds = useMemo(
    () => filtered.map((c) => c.id),
    [filtered],
  );
  const selectedVisibleCount = useMemo(
    () => visibleFilteredIds.filter((id) => selectedIds.has(id)).length,
    [selectedIds, visibleFilteredIds],
  );
  const allFilteredSelected =
    visibleFilteredIds.length > 0 &&
    selectedVisibleCount === visibleFilteredIds.length;

  const selectedConvs = useMemo(
    () => conversations.filter((c) => selectedIds.has(c.id)),
    [conversations, selectedIds],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const id of visibleFilteredIds) next.delete(id);
      } else {
        for (const id of visibleFilteredIds) next.add(id);
      }
      return next;
    });
  };

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

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

  const handleGroupFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!groupModalMode) return;
    const trimmed = groupNameInput.trim();
    if (!trimmed) {
      setGroupFormError('分组名称不能为空');
      return;
    }
    setSavingGroup(true);
    setGroupFormError(null);
    try {
      const res =
        groupModalMode.kind === 'create'
          ? await gateway.createConversationGroup({ assistantId, name: trimmed })
          : await gateway.renameConversationGroup(groupModalMode.group.id, {
              name: trimmed,
            });
      applyConversationOrganizationSnapshot(assistantId, {
        conversations: res.conversations,
        groups: res.groups,
      });
      setGroupModalMode(null);
    } catch (err) {
      setGroupFormError(
        err instanceof GatewayError ? err.message : '保存分组失败',
      );
    } finally {
      setSavingGroup(false);
    }
  };

  const handleDeleteGroupConfirm = async () => {
    if (!deletingGroup) return;
    setDeletingGroupBusy(true);
    try {
      const res = await gateway.deleteConversationGroup(deletingGroup.id);
      applyConversationOrganizationSnapshot(assistantId, {
        conversations: res.conversations,
        groups: res.groups,
      });
      setDeletingGroup(null);
      toast('分组已删除，话题已移至未分组');
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除分组失败', 'error');
    } finally {
      setDeletingGroupBusy(false);
    }
  };

  const handleDeleteConvsConfirm = async () => {
    if (!deletingConvs || deletingConvs.length === 0) return;
    const ids = deletingConvs.map((c) => c.id);
    setDeleting(true);
    try {
      const snap = await gateway.batchConversations({
        assistantId,
        ids,
        operation: 'delete',
      });
      applyConversationOrganizationSnapshot(assistantId, {
        conversations: snap.conversations,
        groups: snap.groups,
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setDeletingConvs(null);
      onConversationsDeleted(snap.deletedIds ?? ids, snap.conversations);
      toast(ids.length > 1 ? `已删除 ${ids.length} 个话题` : '话题已删除');
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleBatchPin = async (ids: string[], pinned: boolean) => {
    if (ids.length === 0 || mutating) return;
    setMutating(true);
    try {
      const snap = await gateway.batchConversations({
        assistantId,
        ids,
        operation: 'pin',
        pinned,
      });
      applyConversationOrganizationSnapshot(assistantId, {
        conversations: snap.conversations,
        groups: snap.groups,
      });
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '置顶操作失败', 'error');
    } finally {
      setMutating(false);
    }
  };

  const openMoveModal = (ids: string[], initialGroupId: string | null) => {
    setMoveTargetIds(ids);
    setSelectedMoveGroupId(initialGroupId);
  };

  const handleMoveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!moveTargetIds || moveTargetIds.length === 0) return;
    setMovingBusy(true);
    try {
      const snap = await gateway.batchConversations({
        assistantId,
        ids: moveTargetIds,
        operation: 'move',
        groupId: selectedMoveGroupId ?? null,
      });
      applyConversationOrganizationSnapshot(assistantId, {
        conversations: snap.conversations,
        groups: snap.groups,
      });
      setMoveTargetIds(null);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '移动分组失败', 'error');
    } finally {
      setMovingBusy(false);
    }
  };

  const executeReorder = useCallback(
    async (conv: Conversation, target: DropTarget) => {
      const prevSnapshot = {
        conversations,
        groups: sortedGroups,
      };
      const sourceBucketKey = bucketKeyForTarget(
        Boolean(conv.pinned),
        conv.groupId && groupById.has(conv.groupId) ? conv.groupId : null,
      );
      const targetItems = bucketItemsMap.get(target.bucketKey) ?? [];
      const currentIdx =
        sourceBucketKey === target.bucketKey
          ? targetItems.findIndex((c) => c.id === conv.id)
          : -1;
      const currentNextId =
        currentIdx >= 0 ? (targetItems[currentIdx + 1]?.id ?? null) : undefined;
      if (
        sourceBucketKey === target.bucketKey &&
        target.beforeId === currentNextId
      ) {
        return;
      }

      // Optimistic preview in memory; rolled back cleanly if server fails.
      const remainingInBucket = targetItems.filter((c) => c.id !== conv.id);
      const insertAt =
        target.beforeId === null
          ? remainingInBucket.length
          : remainingInBucket.findIndex((c) => c.id === target.beforeId);
      const safeInsert = insertAt >= 0 ? insertAt : remainingInBucket.length;
      const updatedConv: Conversation = {
        ...conv,
        pinned: target.pinned,
        groupId: target.pinned ? conv.groupId : target.groupId,
      };
      const reorderedBucket = [
        ...remainingInBucket.slice(0, safeInsert),
        updatedConv,
        ...remainingInBucket.slice(safeInsert),
      ].map((c, idx) => ({ ...c, sortOrder: idx + 1 }));
      const reorderedMap = new Map(reorderedBucket.map((c) => [c.id, c]));
      const previewConvs = conversations.map((c) =>
        reorderedMap.get(c.id) ?? c,
      );
      applyConversationOrganizationSnapshot(assistantId, {
        conversations: previewConvs,
        groups: sortedGroups,
      });

      setMutating(true);
      try {
        const snap = await gateway.reorderConversations(
          target.pinned
            ? {
                assistantId,
                ids: [conv.id],
                pinned: true,
                beforeId: target.beforeId,
              }
            : {
                assistantId,
                ids: [conv.id],
                pinned: false,
                groupId: target.groupId,
                beforeId: target.beforeId,
              },
        );
        applyConversationOrganizationSnapshot(assistantId, {
          conversations: snap.conversations,
          groups: snap.groups,
        });
      } catch (err) {
        applyConversationOrganizationSnapshot(assistantId, prevSnapshot);
        toast(err instanceof GatewayError ? err.message : '排序保存失败', 'error');
      } finally {
        setMutating(false);
      }
    },
    [
      applyConversationOrganizationSnapshot,
      assistantId,
      bucketItemsMap,
      conversations,
      gateway,
      groupById,
      sortedGroups,
      toast,
    ],
  );

  const handleStepMove = (conv: Conversation, direction: 'up' | 'down') => {
    const isPinned = Boolean(conv.pinned);
    const validGroupId =
      conv.groupId && groupById.has(conv.groupId) ? conv.groupId : null;
    const key = bucketKeyForTarget(isPinned, validGroupId);
    const items = bucketItemsMap.get(key) ?? [];
    const idx = items.findIndex((c) => c.id === conv.id);
    if (idx < 0) return;

    let beforeId: string | null = null;
    if (direction === 'up') {
      if (idx === 0) return;
      beforeId = items[idx - 1].id;
    } else {
      if (idx >= items.length - 1) return;
      beforeId = items[idx + 2]?.id ?? null;
    }

    void executeReorder(conv, {
      bucketKey: key,
      pinned: isPinned,
      groupId: isPinned ? null : validGroupId,
      beforeId,
    });
  };

  const computeDropTarget = useCallback(
    (clientY: number, draggingConvId: string): DropTarget | null => {
      const container = listContainerRef.current;
      if (!container) return null;

      const sectionEls = Array.from(
        container.querySelectorAll<HTMLElement>('[data-drop-bucket]'),
      );
      if (sectionEls.length === 0) return null;

      let chosenSection = sectionEls[sectionEls.length - 1];
      let bestDist = Infinity;
      for (const sec of sectionEls) {
        const r = sec.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          chosenSection = sec;
          break;
        }
        const dist =
          clientY < r.top ? r.top - clientY : clientY - r.bottom;
        if (dist < bestDist) {
          bestDist = dist;
          chosenSection = sec;
        }
      }

      const bucketKey = chosenSection.dataset.dropBucket || 'ungrouped';
      const pinned = chosenSection.dataset.dropPinned === 'true';
      const rawGroup = chosenSection.dataset.dropGroupId ?? '';
      const groupId = pinned ? null : rawGroup || null;

      const rowEls = Array.from(
        chosenSection.querySelectorAll<HTMLElement>('[data-topic-id]'),
      ).filter((el) => el.dataset.topicId !== draggingConvId);

      let beforeId: string | null = null;
      for (const rowEl of rowEls) {
        const r = rowEl.getBoundingClientRect();
        const midY = r.top + r.height / 2;
        if (clientY < midY) {
          beforeId = rowEl.dataset.topicId ?? null;
          break;
        }
      }
      return { bucketKey, pinned, groupId, beforeId };
    },
    [],
  );

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      if (!session.active) {
        const dist = Math.hypot(
          e.clientX - session.startX,
          e.clientY - session.startY,
        );
        if (dist < 6) return;
        session.active = true;
        setDraggingId(session.conv.id);
      }
      e.preventDefault();
      const target = computeDropTarget(e.clientY, session.conv.id);
      setDropTarget(target);
    };

    const finishDrag = (e: PointerEvent, commit: boolean) => {
      const session = dragSessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      const wasActive = session.active;
      const target = dropTargetRef.current;
      dragSessionRef.current = null;
      setDraggingId(null);
      setDropTarget(null);
      if (commit && wasActive && target) {
        void executeReorder(session.conv, target);
      }
    };

    const onPointerUp = (e: PointerEvent) => finishDrag(e, true);
    const onPointerCancel = (e: PointerEvent) => finishDrag(e, false);
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && dragSessionRef.current?.active) {
        e.preventDefault();
        dragSessionRef.current = null;
        setDraggingId(null);
        setDropTarget(null);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [computeDropTarget, executeReorder]);

  const handleDragPointerDown = (
    e: ReactPointerEvent<HTMLButtonElement>,
    conv: Conversation,
  ) => {
    if (isSearching || manageMode || mutating) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore environments without pointer capture support.
    }
    dragSessionRef.current = {
      conv,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
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
                  icon="folderPlus"
                  label="新建分组"
                  disabled={mutating}
                  onClick={() => {
                    setGroupNameInput('');
                    setGroupFormError(null);
                    setGroupModalMode({ kind: 'create' });
                  }}
                />
                <IconButton
                  size="sm"
                  icon="checkSquare"
                  label={manageMode ? '退出管理' : '管理话题'}
                  active={manageMode}
                  onClick={() => onManageModeChange(!manageMode)}
                />
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

            {manageMode ? (
              <div className="wb-manage-bar" role="region" aria-label="批量管理">
                <div className="wb-manage-bar__top">
                  <span className="wb-manage-bar__count">
                    已选 {selectedIds.size} 项
                  </span>
                  <div style={{ display: 'inline-flex', gap: 4 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={visibleFilteredIds.length === 0 || mutating}
                      onClick={toggleSelectAllFiltered}
                    >
                      {allFilteredSelected ? '取消全选' : '全选'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onManageModeChange(false)}
                    >
                      完成
                    </Button>
                  </div>
                </div>
                <div className="wb-manage-bar__actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={selectedIds.size === 0 || mutating}
                    onClick={() =>
                      openMoveModal(
                        Array.from(selectedIds),
                        selectedConvs[0]?.groupId ?? null,
                      )
                    }
                  >
                    移至分组
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={selectedIds.size === 0 || mutating}
                    onClick={() => {
                      const allPinned =
                        selectedConvs.length > 0 &&
                        selectedConvs.every((c) => Boolean(c.pinned));
                      void handleBatchPin(Array.from(selectedIds), !allPinned);
                    }}
                  >
                    {selectedConvs.length > 0 &&
                    selectedConvs.every((c) => Boolean(c.pinned))
                      ? '取消置顶'
                      : '置顶'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={selectedIds.size === 0 || mutating}
                    onClick={() => setDeletingConvs(selectedConvs)}
                  >
                    删除 ({selectedIds.size})
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="wb-topic-groups" ref={listContainerRef}>
              {conversations.length === 0 && sortedGroups.length === 0 ? (
                <div className="wb-topic-empty">暂无话题</div>
              ) : isSearching && filtered.length === 0 ? (
                <div className="wb-topic-empty">无匹配话题</div>
              ) : (
                sections.map((section) => {
                  const isCollapsed =
                    section.group !== null &&
                    !isSearching &&
                    collapsedGroupIds.has(section.group.id);
                  const isBucketDropTarget =
                    draggingId !== null &&
                    dropTarget?.bucketKey === section.key;
                  const isTailDropTarget =
                    isBucketDropTarget && dropTarget?.beforeId === null;

                  return (
                    <section
                      key={section.key}
                      className={`wb-topic-section ${
                        isBucketDropTarget ? 'wb-topic-section--drop' : ''
                      }`.trim()}
                      data-drop-bucket={section.key}
                      data-drop-pinned={section.pinned ? 'true' : 'false'}
                      data-drop-group-id={section.group?.id ?? ''}
                    >
                      <div className="wb-topic-section__head">
                        {section.group ? (
                          <button
                            type="button"
                            className="wb-topic-group__toggle"
                            aria-expanded={!isCollapsed}
                            onClick={() =>
                              toggleGroupCollapse(section.group!.id)
                            }
                          >
                            <Icon
                              name={isCollapsed ? 'chevronRight' : 'chevronDown'}
                              size={12}
                            />
                            <span className="wb-topic-group__name">
                              {section.label}
                            </span>
                            <span className="wb-topic-group__count">
                              {section.items.length}
                            </span>
                          </button>
                        ) : (
                          <span className="wb-topic-group__label">
                            {section.label}
                          </span>
                        )}

                        {section.group ? (
                          <Dropdown
                            align="end"
                            trigger={
                              <IconButton
                                size="sm"
                                icon="ellipsis"
                                label={`分组操作 ${section.group.name}`}
                              />
                            }
                          >
                            <DropdownItem
                              onSelect={() => {
                                setGroupNameInput(section.group!.name);
                                setGroupFormError(null);
                                setGroupModalMode({
                                  kind: 'rename',
                                  group: section.group!,
                                });
                              }}
                            >
                              <Icon name="edit" size={14} />
                              <span>重命名分组</span>
                            </DropdownItem>
                            <DropdownItem
                              onSelect={() => setDeletingGroup(section.group!)}
                            >
                              <Icon name="trash" size={14} />
                              <span>删除分组</span>
                            </DropdownItem>
                          </Dropdown>
                        ) : null}
                      </div>

                      {!isCollapsed ? (
                        section.items.length === 0 ? (
                          <div
                            className={`wb-topic-section__empty ${
                              isTailDropTarget ? 'wb-topic-row--drop-tail' : ''
                            }`.trim()}
                          >
                            {draggingId ? '拖放至此' : '空分组'}
                          </div>
                        ) : (
                          <div
                            className={
                              isTailDropTarget ? 'wb-topic-list--drop-tail' : ''
                            }
                          >
                            {section.items.map((conv) => {
                              const active = conv.id === activeConversationId;
                              const selected = selectedIds.has(conv.id);
                              const bucketKey = bucketKeyForTarget(
                                Boolean(conv.pinned),
                                conv.groupId && groupById.has(conv.groupId)
                                  ? conv.groupId
                                  : null,
                              );
                              const fullBucket =
                                bucketItemsMap.get(bucketKey) ?? [];
                              const posInBucket = fullBucket.findIndex(
                                (c) => c.id === conv.id,
                              );
                              const canMoveUp = !isSearching && posInBucket > 0;
                              const canMoveDown =
                                !isSearching &&
                                posInBucket >= 0 &&
                                posInBucket < fullBucket.length - 1;
                              const pinnedGroupName =
                                conv.pinned && conv.groupId
                                  ? groupById.get(conv.groupId)?.name
                                  : undefined;
                              const isDropBefore =
                                draggingId !== null &&
                                dropTarget?.bucketKey === section.key &&
                                dropTarget?.beforeId === conv.id;

                              return (
                                <div
                                  key={conv.id}
                                  data-topic-id={conv.id}
                                  className={[
                                    'wb-topic-row',
                                    active ? 'wb-topic-row--active' : '',
                                    selected ? 'wb-topic-row--selected' : '',
                                    draggingId === conv.id
                                      ? 'wb-topic-row--dragging'
                                      : '',
                                    isDropBefore
                                      ? 'wb-topic-row--drop-before'
                                      : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                >
                                  {manageMode ? (
                                    <label
                                      className="wb-topic-check"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        aria-label={`选择 ${conv.title}`}
                                        checked={selected}
                                        onChange={() => toggleSelect(conv.id)}
                                      />
                                    </label>
                                  ) : !isSearching ? (
                                    <button
                                      type="button"
                                      className="wb-drag-handle"
                                      aria-label={`拖动排序 ${conv.title}`}
                                      title="拖动排序"
                                      disabled={mutating}
                                      onPointerDown={(e) =>
                                        handleDragPointerDown(e, conv)
                                      }
                                    >
                                      <Icon name="grip" size={13} />
                                    </button>
                                  ) : null}

                                  <button
                                    type="button"
                                    className="wb-topic-row__btn"
                                    title={conv.title}
                                    aria-current={
                                      !manageMode && active ? 'true' : undefined
                                    }
                                    onClick={() => {
                                      if (manageMode) {
                                        toggleSelect(conv.id);
                                      } else {
                                        onSelectConversation(conv.id);
                                      }
                                    }}
                                  >
                                    <span className="wb-topic-row__title">
                                      {conv.title}
                                    </span>
                                    <span className="wb-topic-row__sub">
                                      <span className="wb-topic-row__time">
                                        {formatShortTime(
                                          conv.updatedAt || conv.createdAt,
                                        )}
                                      </span>
                                      {pinnedGroupName ? (
                                        <span className="wb-topic-row__group-tag">
                                          {pinnedGroupName}
                                        </span>
                                      ) : null}
                                    </span>
                                  </button>

                                  {!manageMode ? (
                                    <div
                                      className="wb-topic-row__actions"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <Dropdown
                                        align="end"
                                        trigger={
                                          <IconButton
                                            size="sm"
                                            icon="ellipsis"
                                            label={`更多操作 ${conv.title}`}
                                            disabled={mutating}
                                          />
                                        }
                                      >
                                        <DropdownItem
                                          onSelect={() => openRename(conv)}
                                        >
                                          <Icon name="edit" size={14} />
                                          <span>重命名</span>
                                        </DropdownItem>
                                        <DropdownItem
                                          onSelect={() =>
                                            void handleBatchPin(
                                              [conv.id],
                                              !conv.pinned,
                                            )
                                          }
                                        >
                                          <Icon name="pin" size={14} />
                                          <span>
                                            {conv.pinned ? '取消置顶' : '置顶'}
                                          </span>
                                        </DropdownItem>
                                        <DropdownItem
                                          onSelect={() =>
                                            openMoveModal(
                                              [conv.id],
                                              conv.groupId ?? null,
                                            )
                                          }
                                        >
                                          <Icon name="folder" size={14} />
                                          <span>移至分组</span>
                                        </DropdownItem>
                                        {canMoveUp ? (
                                          <DropdownItem
                                            onSelect={() =>
                                              handleStepMove(conv, 'up')
                                            }
                                          >
                                            <Icon name="arrowUp" size={14} />
                                            <span>上移</span>
                                          </DropdownItem>
                                        ) : null}
                                        {canMoveDown ? (
                                          <DropdownItem
                                            onSelect={() =>
                                              handleStepMove(conv, 'down')
                                            }
                                          >
                                            <Icon name="arrowDown" size={14} />
                                            <span>下移</span>
                                          </DropdownItem>
                                        ) : null}
                                        <DropdownItem
                                          onSelect={() =>
                                            setDeletingConvs([conv])
                                          }
                                        >
                                          <Icon name="trash" size={14} />
                                          <span>删除</span>
                                        </DropdownItem>
                                      </Dropdown>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )
                      ) : null}
                    </section>
                  );
                })
              )}
            </div>
          </>
        )}
      </aside>

      {/* Rename Conversation Modal */}
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

      {/* Create / Rename Group Modal */}
      <Modal
        open={groupModalMode !== null}
        busy={savingGroup}
        onOpenChange={(open) => {
          if (!open && !savingGroup) setGroupModalMode(null);
        }}
        title={groupModalMode?.kind === 'rename' ? '重命名分组' : '新建分组'}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={savingGroup}
              onClick={() => setGroupModalMode(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="group-name-form"
              variant="primary"
              loading={savingGroup}
            >
              {savingGroup ? '保存中...' : '保存'}
            </Button>
          </>
        }
      >
        <form
          id="group-name-form"
          noValidate
          onSubmit={(e) => void handleGroupFormSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {groupFormError ? <ErrorBanner message={groupFormError} /> : null}
          <Field label="分组名称" htmlFor="group-name-input">
            <Input
              id="group-name-input"
              value={groupNameInput}
              onChange={(e) => setGroupNameInput(e.target.value)}
              maxLength={60}
              required
              autoFocus
            />
          </Field>
        </form>
      </Modal>

      {/* Move to Group Modal */}
      <Modal
        open={moveTargetIds !== null}
        busy={movingBusy}
        onOpenChange={(open) => {
          if (!open && !movingBusy) setMoveTargetIds(null);
        }}
        title={
          moveTargetIds && moveTargetIds.length > 1
            ? `移动 ${moveTargetIds.length} 个话题到分组`
            : '移动到分组'
        }
        footer={
          <>
            <Button
              variant="secondary"
              disabled={movingBusy}
              onClick={() => setMoveTargetIds(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="move-group-form"
              variant="primary"
              loading={movingBusy}
            >
              {movingBusy ? '移动中...' : '确定'}
            </Button>
          </>
        }
      >
        <form
          id="move-group-form"
          onSubmit={(e) => void handleMoveSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <div role="radiogroup" aria-label="目标分组" className="wb-move-options">
            <label className="wb-move-option">
              <input
                type="radio"
                name="target-group"
                checked={selectedMoveGroupId === null}
                onChange={() => setSelectedMoveGroupId(null)}
              />
              <span>未分组</span>
            </label>
            {sortedGroups.map((g) => (
              <label key={g.id} className="wb-move-option">
                <input
                  type="radio"
                  name="target-group"
                  checked={selectedMoveGroupId === g.id}
                  onChange={() => setSelectedMoveGroupId(g.id)}
                />
                <span>{g.name}</span>
              </label>
            ))}
          </div>
        </form>
      </Modal>

      {/* Delete Conversation(s) Confirm */}
      <ConfirmDialog
        open={deletingConvs !== null && deletingConvs.length > 0}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeletingConvs(null);
        }}
        title={
          deletingConvs && deletingConvs.length > 1
            ? `删除 ${deletingConvs.length} 个话题？`
            : '删除话题？'
        }
        message={
          deletingConvs && deletingConvs.length > 1
            ? `确认删除选中的 ${deletingConvs.length} 个话题及其中的全部消息？此操作无法撤销。`
            : `确认删除「${deletingConvs?.[0]?.title ?? ''}」及其中的全部消息？此操作无法撤销。`
        }
        confirmLabel="删除"
        busy={deleting}
        onConfirm={handleDeleteConvsConfirm}
      />

      {/* Delete Group Confirm */}
      <ConfirmDialog
        open={deletingGroup !== null}
        onOpenChange={(open) => {
          if (!open && !deletingGroupBusy) setDeletingGroup(null);
        }}
        title="删除分组？"
        message={`确认删除分组「${deletingGroup?.name ?? ''}」？组内话题与消息将被保留并移回未分组。`}
        confirmLabel="删除"
        busy={deletingGroupBusy}
        onConfirm={handleDeleteGroupConfirm}
      />
    </>
  );
}
