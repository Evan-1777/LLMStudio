import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Field,
  Input,
  Modal,
} from '../../components/ui';
import { GatewayError } from '../../core/gateway';
import type {
  Conversation,
  ConversationGroup,
  TopicScope,
} from '../../core/types';

export type SidebarGroupModalMode =
  | { kind: 'create' }
  | { kind: 'rename'; group: ConversationGroup }
  | null;

export interface SidebarMoveTarget {
  ids: string[];
  initialGroupId: string | null;
}

export interface SidebarConflictPrompt {
  direction: 'upload' | 'pull';
  ids: string[];
}

export interface ConversationSidebarDialogsProps {
  assistantId: string;
  reqScope?: TopicScope;
  sortedGroups: ConversationGroup[];

  renamingConv: Conversation | null;
  onCloseRename: () => void;
  onConversationPatched: (updated: Conversation) => void;

  groupModalMode: SidebarGroupModalMode;
  onCloseGroupModal: () => void;

  moveTarget: SidebarMoveTarget | null;
  onCloseMoveModal: () => void;

  deletingConvs: Conversation[] | null;
  onCloseDeleteConvs: () => void;
  onConversationsDeleted: (
    deletedIds: string[],
    remaining: Conversation[],
  ) => void;

  deletingGroup: ConversationGroup | null;
  onCloseDeleteGroup: () => void;

  conflictPrompt: SidebarConflictPrompt | null;
  forcingConflict: boolean;
  onCloseConflict: () => void;
  onConfirmConflictForce: () => Promise<void>;
}

export function ConversationSidebarDialogs({
  assistantId,
  reqScope,
  sortedGroups,
  renamingConv,
  onCloseRename,
  onConversationPatched,
  groupModalMode,
  onCloseGroupModal,
  moveTarget,
  onCloseMoveModal,
  deletingConvs,
  onCloseDeleteConvs,
  onConversationsDeleted,
  deletingGroup,
  onCloseDeleteGroup,
  conflictPrompt,
  forcingConflict,
  onCloseConflict,
  onConfirmConflictForce,
}: ConversationSidebarDialogsProps) {
  const {
    gateway,
    upsertLocalConversation,
    applyConversationOrganizationSnapshot,
    toast,
  } = useApp();

  // Conversation rename modal state
  const [renameTitle, setRenameTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // Group create / rename modal state
  const [groupNameInput, setGroupNameInput] = useState('');
  const [groupFormError, setGroupFormError] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState(false);

  // Move-to-group modal state
  const [selectedMoveGroupId, setSelectedMoveGroupId] = useState<string | null>(
    null,
  );
  const [movingBusy, setMovingBusy] = useState(false);

  // Delete confirm busy states
  const [deleting, setDeleting] = useState(false);
  const [deletingGroupBusy, setDeletingGroupBusy] = useState(false);

  useEffect(() => {
    if (!renamingConv) return;
    setRenameTitle(renamingConv.title);
    setRenameError(null);
  }, [renamingConv]);

  useEffect(() => {
    if (!groupModalMode) return;
    setGroupNameInput(
      groupModalMode.kind === 'rename' ? groupModalMode.group.name : '',
    );
    setGroupFormError(null);
  }, [groupModalMode]);

  useEffect(() => {
    if (!moveTarget) return;
    setSelectedMoveGroupId(moveTarget.initialGroupId);
  }, [moveTarget]);

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
      onCloseRename();
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
      onCloseGroupModal();
    } catch (err) {
      setGroupFormError(
        err instanceof GatewayError ? err.message : '保存分组失败',
      );
    } finally {
      setSavingGroup(false);
    }
  };

  const handleMoveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!moveTarget || moveTarget.ids.length === 0) return;
    setMovingBusy(true);
    try {
      const snap = await gateway.batchConversations(
        {
          assistantId,
          ids: moveTarget.ids,
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
      onCloseMoveModal();
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '移动分组失败', 'error');
    } finally {
      setMovingBusy(false);
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
      onCloseDeleteConvs();
      onConversationsDeleted(snap.deletedIds ?? ids, snap.conversations);
      toast(ids.length > 1 ? `已删除 ${ids.length} 个话题` : '话题已删除');
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除失败', 'error');
    } finally {
      setDeleting(false);
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
      onCloseDeleteGroup();
      toast('分组已删除，话题已移至未分组');
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除分组失败', 'error');
    } finally {
      setDeletingGroupBusy(false);
    }
  };

  return (
    <>
      {/* Rename Conversation Modal */}
      <Modal
        open={renamingConv !== null}
        onOpenChange={(open) => {
          if (!open && !renaming) onCloseRename();
        }}
        title="重命名话题"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={renaming}
              onClick={onCloseRename}
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
          if (!open && !savingGroup) onCloseGroupModal();
        }}
        title={groupModalMode?.kind === 'rename' ? '重命名分组' : '新建分组'}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={savingGroup}
              onClick={onCloseGroupModal}
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
        open={moveTarget !== null}
        busy={movingBusy}
        onOpenChange={(open) => {
          if (!open && !movingBusy) onCloseMoveModal();
        }}
        title={
          moveTarget && moveTarget.ids.length > 1
            ? `移动 ${moveTarget.ids.length} 个话题到分组`
            : '移动到分组'
        }
        footer={
          <>
            <Button
              variant="secondary"
              disabled={movingBusy}
              onClick={onCloseMoveModal}
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
          if (!open && !deleting) onCloseDeleteConvs();
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
          if (!open && !deletingGroupBusy) onCloseDeleteGroup();
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
          if (!open && !forcingConflict) onCloseConflict();
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
        onConfirm={onConfirmConflictForce}
      />
    </>
  );
}
