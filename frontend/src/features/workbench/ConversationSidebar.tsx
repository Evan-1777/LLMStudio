import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  Dropdown,
  DropdownItem,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
} from '../../components/ui';
import { useRowDrag } from '../../components/ui/useRowDrag';
import { GatewayError } from '../../core/gateway';
import type {
  CloudConnectionState,
  Conversation,
  ConversationGroup,
  TopicScope,
} from '../../core/types';
import {
  SessionInspector,
  type DraftSessionParams,
} from './SessionInspector';

function formatShortTime(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function cloudDotClass(state: CloudConnectionState): string {
  switch (state) {
    case 'connected':
      return '';
    case 'checking':
    case 'auth-required':
      return 'wb-status-dot--warn';
    case 'error':
      return 'wb-status-dot--error';
    case 'disconnected':
      return 'wb-status-dot--muted';
  }
}

function cloudStatusLabel(state: CloudConnectionState): string {
  switch (state) {
    case 'connected':
      return '云端在线';
    case 'checking':
      return '连接中';
    case 'auth-required':
      return '云端需令牌';
    case 'error':
      return '云端异常';
    case 'disconnected':
      return '云端离线';
  }
}

function isConflictError(err: unknown): boolean {
  return (
    err instanceof GatewayError &&
    (err.statusCode === 409 || err.code === 'CONFLICT')
  );
}

interface DropTarget {
  bucketKey: string;
  pinned: boolean;
  groupId: string | null;
  beforeId: string | null;
}

type GroupDrop = { groupId: string; beforeId: string | null; edge: 'before' | 'after' };
type OrganizationDrop = { kind: 'topic'; target: DropTarget } | { kind: 'group'; target: GroupDrop };

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
  scope = 'cloud',
  onScopeChange,
  onManageModeChange,
  onSelectConversation,
  onNewConversation,
  onCloseInspector,
  onCloseDrawer,
  onConversationPatched,
  onConversationsDeleted,
  onSaveDraftSessionParams,
  lastSyncedAt = null,
  syncingServer = false,
  onSyncServer,
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
  scope?: TopicScope;
  onScopeChange?: (next: TopicScope) => void;
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
  lastSyncedAt?: string | null;
  syncingServer?: boolean;
  onSyncServer?: () => void;
}) {
  const navigate = useNavigate();
  const {
    gateway,
    isDesktop,
    cloudConnectionState,
    resources,
    connectionEpoch,
    upsertLocalConversation,
    applyConversationOrganizationSnapshot,
    uploadConversations,
    pullConversations,
    toast,
  } = useApp();

  const reqScope: TopicScope | undefined = isDesktop ? scope : undefined;
  const cloudOffline = isDesktop && scope === 'cloud' && cloudConnectionState !== 'connected';

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mutating, setMutating] = useState(false);
  const [transferringIds, setTransferringIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [batchTransferring, setBatchTransferring] = useState(false);
  const [conflictPrompt, setConflictPrompt] = useState<{
    direction: 'upload' | 'pull';
    ids: string[];
  } | null>(null);
  const [forcingConflict, setForcingConflict] = useState(false);

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

  const listContainerRef = useRef<HTMLDivElement>(null);
  const currentEpoch = useRef(connectionEpoch);
  currentEpoch.current = connectionEpoch;

  // Clear local selection & search on assistant, scope, or gateway switch.
  useEffect(() => {
    setSelectedIds(new Set());
    setSearchQuery('');
    onManageModeChange(false);
  }, [assistantId, connectionEpoch, onManageModeChange, scope]);

  useEffect(() => {
    setExpandedGroupIds(new Set());
  }, [connectionEpoch]);

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

  const toggleSelection = (ids: readonly string[], allSelected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAllFiltered = () => toggleSelection(visibleFilteredIds, allFilteredSelected);

  const toggleGroupCollapse = (groupId: string) => {
    setExpandedGroupIds((prev) => {
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
      const updated = await gateway.patchConversation(
        renamingConv.id,
        { title: trimmed },
        undefined,
        reqScope,
      );
      upsertLocalConversation(updated, reqScope);
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
          ? await gateway.createConversationGroup(
              { assistantId, name: trimmed },
              undefined,
              reqScope,
            )
          : await gateway.renameConversationGroup(
              groupModalMode.group.id,
              { name: trimmed },
              undefined,
              reqScope,
            );
      applyConversationOrganizationSnapshot(
        assistantId,
        { conversations: res.conversations, groups: res.groups },
        undefined,
        reqScope,
      );
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
      const res = await gateway.deleteConversationGroup(
        deletingGroup.id,
        undefined,
        reqScope,
      );
      applyConversationOrganizationSnapshot(
        assistantId,
        { conversations: res.conversations, groups: res.groups },
        undefined,
        reqScope,
      );
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
      const snap = await gateway.batchConversations(
        {
          assistantId,
          ids,
          operation: 'delete',
        },
        undefined,
        reqScope,
      );
      applyConversationOrganizationSnapshot(
        assistantId,
        { conversations: snap.conversations, groups: snap.groups },
        undefined,
        reqScope,
      );
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
      const snap = await gateway.batchConversations(
        {
          assistantId,
          ids,
          operation: 'pin',
          pinned,
        },
        undefined,
        reqScope,
      );
      applyConversationOrganizationSnapshot(
        assistantId,
        { conversations: snap.conversations, groups: snap.groups },
        undefined,
        reqScope,
      );
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
      const snap = await gateway.batchConversations(
        {
          assistantId,
          ids: moveTargetIds,
          operation: 'move',
          groupId: selectedMoveGroupId ?? null,
        },
        undefined,
        reqScope,
      );
      applyConversationOrganizationSnapshot(
        assistantId,
        { conversations: snap.conversations, groups: snap.groups },
        undefined,
        reqScope,
      );
      setMoveTargetIds(null);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '移动分组失败', 'error');
    } finally {
      setMovingBusy(false);
    }
  };

  const canReorder = !isSearching && !manageMode && !mutating && !inspectorOpen &&
    !renamingConv && !groupModalMode && !moveTargetIds && !deletingConvs && !deletingGroup;

  const runReorder = async (request: () => Promise<{ conversations: Conversation[]; groups: ConversationGroup[] }>) => {
    if (!canReorder) return;
    setMutating(true);
    try {
      const snap = await request();
      applyConversationOrganizationSnapshot(assistantId, snap, connectionEpoch, reqScope);
    } catch (err) {
      if (connectionEpoch === currentEpoch.current) {
        toast(err instanceof GatewayError ? err.message : '排序保存失败', 'error');
      }
    } finally {
      setMutating(false);
    }
  };

  const executeReorder = (conv: Conversation, target: DropTarget) => {
    const sourceBucket = bucketKeyForTarget(
      Boolean(conv.pinned),
      conv.groupId && groupById.has(conv.groupId) ? conv.groupId : null,
    );
    if (sourceBucket === target.bucketKey) {
      const items = bucketItemsMap.get(sourceBucket) ?? [];
      const i = items.findIndex((c) => c.id === conv.id);
      if (i < 0 || (items[i + 1]?.id ?? null) === target.beforeId) return;
    }
    return runReorder(() =>
      gateway.reorderConversations(
        {
          assistantId,
          ids: [conv.id],
          ...(target.pinned ? { pinned: true } : { pinned: false, groupId: target.groupId }),
          beforeId: target.beforeId,
        },
        undefined,
        reqScope,
      ),
    );
  };

  const moveGroup = (id: string, beforeId: string | null) => {
    const i = sortedGroups.findIndex((g) => g.id === id);
    if (i < 0 || (sortedGroups[i + 1]?.id ?? null) === beforeId) return;
    return runReorder(() =>
      gateway.reorderConversationGroup({ assistantId, id, beforeId }, undefined, reqScope),
    );
  };

  const handleSingleTransfer = async (
    direction: 'upload' | 'pull',
    conv: Conversation,
  ) => {
    if (transferringIds.has(conv.id) || batchTransferring) return;
    setTransferringIds((prev) => new Set(prev).add(conv.id));
    try {
      if (direction === 'upload') {
        await uploadConversations([conv.id], false);
        toast('已上传至云端');
      } else {
        await pullConversations([conv.id], false);
        toast('已拉取至本地');
      }
    } catch (err) {
      if (isConflictError(err)) {
        setConflictPrompt({ direction, ids: [conv.id] });
      } else {
        toast(err instanceof GatewayError ? err.message : '传输失败', 'error');
      }
    } finally {
      setTransferringIds((prev) => {
        const next = new Set(prev);
        next.delete(conv.id);
        return next;
      });
    }
  };

  const handleBatchTransfer = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || batchTransferring) return;
    const direction: 'upload' | 'pull' = scope === 'local' ? 'upload' : 'pull';
    setBatchTransferring(true);
    try {
      const result =
        direction === 'upload'
          ? await uploadConversations(ids, false)
          : await pullConversations(ids, false);
      if ('succeeded' in result) {
        const conflicts = result.failed.filter(
          (item) => item.conflict || item.code === 'CONFLICT',
        );
        const nonConflicts = result.failed.filter(
          (item) => !(item.conflict || item.code === 'CONFLICT'),
        );
        if (result.succeeded.length > 0 && conflicts.length === 0 && nonConflicts.length === 0) {
          toast(
            direction === 'upload'
              ? `已上传 ${result.succeeded.length} 个话题`
              : `已拉取 ${result.succeeded.length} 个话题`,
          );
          onManageModeChange(false);
        } else if (nonConflicts.length > 0) {
          toast(nonConflicts[0].message || '部分话题传输失败', 'error');
        }
        if (conflicts.length > 0) {
          setConflictPrompt({ direction, ids: conflicts.map((c) => c.id) });
        }
      } else {
        toast(direction === 'upload' ? '已上传至云端' : '已拉取至本地');
        onManageModeChange(false);
      }
    } catch (err) {
      if (isConflictError(err)) {
        setConflictPrompt({ direction, ids });
      } else {
        toast(err instanceof GatewayError ? err.message : '批量传输失败', 'error');
      }
    } finally {
      setBatchTransferring(false);
    }
  };

  const handleConfirmConflictForce = async () => {
    if (!conflictPrompt || forcingConflict) return;
    const { direction, ids } = conflictPrompt;
    setForcingConflict(true);
    try {
      const result =
        direction === 'upload'
          ? await uploadConversations(ids, true)
          : await pullConversations(ids, true);
      if ('succeeded' in result) {
        if (result.failed.length > 0) {
          toast(result.failed[0].message || '覆盖失败', 'error');
        } else {
          toast(
            direction === 'upload'
              ? `已覆盖云端 ${result.succeeded.length} 个话题`
              : `已覆盖本地 ${result.succeeded.length} 个话题`,
          );
        }
      } else {
        toast(direction === 'upload' ? '已覆盖云端话题' : '已覆盖本地话题');
      }
      setConflictPrompt(null);
      if (manageMode) onManageModeChange(false);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '覆盖失败', 'error');
    } finally {
      setForcingConflict(false);
    }
  };

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

  const computeDropTarget = (container: HTMLElement, clientY: number, draggingConvId: string): DropTarget | null => {

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
  };

  const { drag, bind } = useRowDrag<OrganizationDrop>(canReorder, (source, { clientX, clientY }) => {
    const container = listContainerRef.current;
    if (!container) return null;
    const bounds = container.getBoundingClientRect();
    if (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return null;
    if (source.startsWith('topic:')) {
      const target = computeDropTarget(container, clientY, source.slice(6));
      return target ? { kind: 'topic', target } : null;
    }

    const id = source.slice(6);
    const head = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-group-head]');
    const groupId = head?.dataset.groupHead;
    if (!head || !groupId || id === groupId || !container.contains(head)) return null;
    const rect = head.getBoundingClientRect();
    const edge = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const candidates = sortedGroups.filter((g) => g.id !== id);
    const i = candidates.findIndex((g) => g.id === groupId);
    if (i < 0) return null;
    const beforeId = candidates[i + (edge === 'after' ? 1 : 0)]?.id ?? null;
    if ((sortedGroups[sortedGroups.findIndex((g) => g.id === id) + 1]?.id ?? null) === beforeId) return null;
    return { kind: 'group', target: { groupId, beforeId, edge } };
  }, (source, drop) => {
    const id = source.slice(6);
    if (drop.kind === 'group') {
      void moveGroup(id, drop.target.beforeId);
    } else {
      const conv = conversations.find((c) => c.id === id);
      if (conv) void executeReorder(conv, drop.target);
    }
  }, `${connectionEpoch}:${assistantId}`);

  const draggingId = drag?.id.startsWith('topic:') ? drag.id.slice(6) : null;
  const dropTarget = drag?.target?.kind === 'topic' ? drag.target.target : null;
  const groupDrop = drag?.target?.kind === 'group' ? drag.target.target : null;

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
            scope={reqScope}
            onClose={onCloseInspector}
            onSaved={(updated) => {
              upsertLocalConversation(updated, reqScope);
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
                  disabled={mutating || cloudOffline}
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
                  disabled={cloudOffline}
                  onClick={() => onManageModeChange(!manageMode)}
                />
                <IconButton
                  size="sm"
                  icon="plus"
                  label="新建话题"
                  disabled={cloudOffline}
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

            <div className="wb-history__body">
              {isDesktop ? (
                <div className="wb-scope-switch">
                  <SegmentedControl<TopicScope>
                    ariaLabel="话题存储域"
                    value={scope}
                    onChange={(next) => onScopeChange?.(next)}
                    options={[
                      {
                        value: 'local',
                        ariaLabel: '本地话题',
                        title: '本地话题',
                        label: (
                          <>
                            <Icon name="hardDrive" size={14} />
                            {resources.localConversations.length > 0 ? (
                              <span className="wb-scope-count">
                                {resources.localConversations.length}
                              </span>
                            ) : null}
                          </>
                        ),
                      },
                      {
                        value: 'cloud',
                        ariaLabel: '云端话题',
                        title: '云端话题',
                        label: (
                          <>
                            <Icon name="cloud" size={14} />
                            {cloudConnectionState === 'connected' &&
                            resources.cloudConversations.length > 0 ? (
                              <span className="wb-scope-count">
                                {resources.cloudConversations.length}
                              </span>
                            ) : null}
                          </>
                        ),
                      },
                    ]}
                  />
                </div>
              ) : null}

              {!cloudOffline ? (
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
              ) : null}

            {manageMode && !cloudOffline ? (
              <div className="wb-manage-bar" role="region" aria-label="批量管理">
                <span className="wb-manage-bar__count">
                  <span aria-hidden="true">{selectedIds.size}</span>
                  <span className="sr-only">已选 {selectedIds.size} 项</span>
                </span>
                <div className="wb-manage-bar__actions">
                  <IconButton
                    size="sm"
                    icon="checkSquare"
                    active={allFilteredSelected}
                    label={allFilteredSelected ? '取消全选' : '全选'}
                    disabled={visibleFilteredIds.length === 0 || mutating}
                    onClick={toggleSelectAllFiltered}
                  />
                  {isDesktop ? (
                    <IconButton
                      size="sm"
                      icon={scope === 'local' ? 'cloudUpload' : 'cloudDownload'}
                      label={scope === 'local' ? '批量上传至云端' : '批量拉取至本地'}
                      loading={batchTransferring}
                      disabled={
                        selectedIds.size === 0 ||
                        mutating ||
                        cloudConnectionState !== 'connected'
                      }
                      onClick={() => void handleBatchTransfer()}
                    />
                  ) : null}
                  <IconButton
                    size="sm"
                    icon="folder"
                    label="移至分组"
                    disabled={selectedIds.size === 0 || mutating}
                    onClick={() =>
                      openMoveModal(
                        Array.from(selectedIds),
                        selectedConvs[0]?.groupId ?? null,
                      )
                    }
                  />
                  <IconButton
                    size="sm"
                    icon={
                      selectedConvs.length > 0 &&
                      selectedConvs.every((c) => Boolean(c.pinned))
                        ? 'pinOff'
                        : 'pin'
                    }
                    label={
                      selectedConvs.length > 0 &&
                      selectedConvs.every((c) => Boolean(c.pinned))
                        ? '取消置顶'
                        : '置顶'
                    }
                    disabled={selectedIds.size === 0 || mutating}
                    onClick={() => {
                      const allPinned =
                        selectedConvs.length > 0 &&
                        selectedConvs.every((c) => Boolean(c.pinned));
                      void handleBatchPin(Array.from(selectedIds), !allPinned);
                    }}
                  />
                  <button
                    type="button"
                    className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--danger wb-manage-bar__delete"
                    aria-label={`删除 (${selectedIds.size})`}
                    title={`删除 (${selectedIds.size})`}
                    disabled={selectedIds.size === 0 || mutating}
                    onClick={() => setDeletingConvs(selectedConvs)}
                  >
                    <Icon name="trash" size={14} />
                    <span className="wb-badge-count" aria-hidden="true">
                      {selectedIds.size}
                    </span>
                  </button>
                  <IconButton
                    size="sm"
                    icon="close"
                    label="完成"
                    onClick={() => onManageModeChange(false)}
                  />
                </div>
              </div>
            ) : null}

            <div className="wb-topic-groups" ref={listContainerRef}>
              {cloudOffline ? (
                <div className="wb-scope-empty">
                  <EmptyState
                    icon="cloud"
                    title="未连接云端"
                    action={
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => navigate('/settings/connection')}
                      >
                        连接云端
                      </Button>
                    }
                  />
                </div>
              ) : conversations.length === 0 && sortedGroups.length === 0 ? (
                <div className="wb-topic-empty">暂无话题</div>
              ) : isSearching && filtered.length === 0 ? (
                <div className="wb-topic-empty">无匹配话题</div>
              ) : (
                sections.map((section) => {
                  const group = section.group;
                  const sectionSelectedCount = manageMode
                    ? section.items.filter(({ id }) => selectedIds.has(id)).length
                    : 0;
                  const sectionChecked = section.items.length > 0 && sectionSelectedCount === section.items.length;
                  const groupIndex = group ? sortedGroups.findIndex((g) => g.id === group.id) : -1;
                  const isCollapsed =
                    section.group !== null &&
                    !isSearching &&
                    !expandedGroupIds.has(section.group.id);
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
                      <div
                        className="wb-topic-section__head"
                        data-group-head={group?.id}
                        data-group-drop={groupDrop && groupDrop.groupId === group?.id ? groupDrop.edge : undefined}
                      >
                        {manageMode ? (
                          <label className="wb-topic-check wb-topic-check--section">
                            <input
                              type="checkbox"
                              aria-label={`选择分区 ${section.label}${isSearching ? '的搜索结果' : ''}`}
                              checked={sectionChecked}
                              disabled={section.items.length === 0 || mutating}
                              ref={(input) => {
                                if (input) input.indeterminate = sectionSelectedCount > 0 && !sectionChecked;
                              }}
                              onChange={() => toggleSelection(section.items.map(({ id }) => id), sectionChecked)}
                            />
                          </label>
                        ) : null}
                        {section.group ? (
                          <button
                            {...bind(`group:${section.group.id}`)}
                            type="button"
                            draggable={false}
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
                                disabled={mutating}
                              />
                            }
                          >
                            {canReorder && sortedGroups.length > 1 ? (
                              <>
                                <DropdownItem disabled={groupIndex === 0} onSelect={() => void moveGroup(group!.id, sortedGroups[groupIndex - 1]?.id ?? null)}>
                                  <Icon name="arrowUp" size={14} /><span>上移</span>
                                </DropdownItem>
                                <DropdownItem disabled={groupIndex === sortedGroups.length - 1} onSelect={() => void moveGroup(group!.id, sortedGroups[groupIndex + 2]?.id ?? null)}>
                                  <Icon name="arrowDown" size={14} /><span>下移</span>
                                </DropdownItem>
                              </>
                            ) : null}
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
                          group || draggingId !== null ? (
                            <div
                              className={`wb-topic-section__empty ${
                                isTailDropTarget ? 'wb-topic-row--drop-tail' : ''
                              }`.trim()}
                            >
                              {group ? '空分组' : null}
                            </div>
                          ) : null
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
                                  ) : null}

                                  <button
                                    {...bind(`topic:${conv.id}`)}
                                    type="button"
                                    draggable={false}
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
                                      {isDesktop && conv.syncState === 'synced' ? (
                                        <span
                                          className="wb-topic-sync-dot"
                                          aria-label="已同步"
                                          title="已同步"
                                        />
                                      ) : null}
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
                                      {isDesktop && !conv.ephemeral ? (
                                        <IconButton
                                          size="sm"
                                          icon={
                                            scope === 'local'
                                              ? 'cloudUpload'
                                              : 'cloudDownload'
                                          }
                                          label={
                                            scope === 'local'
                                              ? '上传至云端'
                                              : '拉取至本地'
                                          }
                                          loading={transferringIds.has(conv.id)}
                                          disabled={
                                            mutating ||
                                            batchTransferring ||
                                            cloudConnectionState !== 'connected'
                                          }
                                          onClick={() =>
                                            void handleSingleTransfer(
                                              scope === 'local' ? 'upload' : 'pull',
                                              conv,
                                            )
                                          }
                                        />
                                      ) : null}
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
                                        {isDesktop && !conv.ephemeral ? (
                                          <DropdownItem
                                            disabled={
                                              cloudConnectionState !== 'connected' ||
                                              transferringIds.has(conv.id) ||
                                              batchTransferring
                                            }
                                            onSelect={() =>
                                              void handleSingleTransfer(
                                                scope === 'local' ? 'upload' : 'pull',
                                                conv,
                                              )
                                            }
                                          >
                                            <Icon
                                              name={
                                                scope === 'local'
                                                  ? 'cloudUpload'
                                                  : 'cloudDownload'
                                              }
                                              size={14}
                                            />
                                            <span>
                                              {scope === 'local'
                                                ? '上传至云端'
                                                : '拉取至本地'}
                                            </span>
                                          </DropdownItem>
                                        ) : null}
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
            </div>
            <div className="wb-history__foot">
              {isDesktop ? (
                <div className="wb-foot-status">
                  <button
                    type="button"
                    className="wb-foot-status__cloud"
                    onClick={() => navigate('/settings/connection')}
                    title={
                      cloudConnectionState === 'connected'
                        ? '云端连接设置'
                        : '前往连接云端'
                    }
                  >
                    <span
                      className={`wb-status-dot ${cloudDotClass(cloudConnectionState)}`.trim()}
                      aria-hidden="true"
                    />
                    <span className="wb-foot-status__label">
                      {cloudStatusLabel(cloudConnectionState)}
                    </span>
                  </button>
                  <IconButton
                    size="sm"
                    icon="refresh"
                    label="刷新数据"
                    loading={Boolean(syncingServer)}
                    disabled={Boolean(syncingServer || isBusy)}
                    onClick={() => onSyncServer?.()}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="wb-sync-bar"
                  aria-label="刷新服务端数据"
                  title="从服务端刷新最新数据"
                  aria-busy={syncingServer || undefined}
                  disabled={Boolean(syncingServer || isBusy)}
                  onClick={() => onSyncServer?.()}
                >
                  <Icon
                    name="refresh"
                    size={13}
                    className={syncingServer ? 'wb-spin' : undefined}
                  />
                  <span>
                    {syncingServer
                      ? '同步中…'
                      : lastSyncedAt
                        ? `${formatShortTime(lastSyncedAt)} 已同步`
                        : '同步服务端'}
                  </span>
                </button>
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

      {/* Conflict Transfer Confirm */}
      <ConfirmDialog
        open={conflictPrompt !== null}
        onOpenChange={(open) => {
          if (!open && !forcingConflict) setConflictPrompt(null);
        }}
        title={
          conflictPrompt?.direction === 'upload'
            ? '覆盖云端话题？'
            : '覆盖本地话题？'
        }
        message="目标端存在较新未同步更改。确认覆盖将继续传输；话题分组不跨端迁移，覆盖后将落入目标端未分组（保留置顶状态）。"
        confirmLabel="覆盖"
        danger={false}
        busy={forcingConflict}
        onConfirm={handleConfirmConflictForce}
      />
    </>
  );
}
