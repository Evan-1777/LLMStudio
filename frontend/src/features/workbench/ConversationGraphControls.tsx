import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  DropdownItem,
  DropdownSeparator,
  Icon,
  IconButton,
} from '../../components/ui';
import type {
  ConversationDetail,
  ConversationGraphNoteEdge,
  GraphMutationInput,
  Message,
} from '../../core/types';
import { imageBlockSource } from '../../rendering/ContentRenderer';
import {
  collectSubtreeIds,
  type GraphNode,
  type Point,
} from './conversationGraph';

const isCollapsedSummary = (node: GraphNode) =>
  node.message?.role === 'user' && node.message.graphMeta?.collapsed;

const isSideRefEligible = (msg?: Message) =>
  Boolean(msg && (msg.role === 'user' || msg.role === 'assistant'));

export function PlainMessageDetail({ message }: { message: Message }) {
  const texts = message.blocks
    .filter(
      (b): b is Extract<Message['blocks'][number], { type: 'text' | 'compaction' }> =>
        (b.type === 'text' || b.type === 'compaction') &&
        typeof b.text === 'string' &&
        b.text.length > 0,
    )
    .map((b) => b.text);
  const images = message.blocks.filter(
    (b): b is Extract<Message['blocks'][number], { type: 'image' }> =>
      b.type === 'image',
  );
  const thinkingCount = message.blocks.filter((b) => b.type === 'thinking').length;
  const toolCount = message.blocks.filter((b) => b.type === 'toolCall').length;
  const searchCount = message.blocks.filter((b) => b.type === 'webSearch').length;
  const hasTags =
    thinkingCount > 0 ||
    toolCount > 0 ||
    searchCount > 0 ||
    Boolean(message.errorMessage);

  return (
    <div className="cg-node__plain">
      {texts.length > 0 ? (
        <div className="cg-node__plain-text">{texts.join('\n\n')}</div>
      ) : !images.length && !hasTags ? (
        <div className="cg-node__plain-empty">—</div>
      ) : null}
      {images.length > 0 && (
        <div className="cg-node__plain-images">
          {images.map((img, i) => {
            const src = imageBlockSource(img);
            return src ? (
              <img
                key={i}
                src={src}
                alt=""
                className="cg-node__plain-img"
                loading="lazy"
              />
            ) : null;
          })}
        </div>
      )}
      {hasTags && (
        <div className="cg-node__plain-tags">
          {thinkingCount > 0 && (
            <span>
              <Icon name="brain" size={12} />思考 ×{thinkingCount}
            </span>
          )}
          {toolCount > 0 && (
            <span>
              <Icon name="wrench" size={12} />工具 ×{toolCount}
            </span>
          )}
          {searchCount > 0 && (
            <span>
              <Icon name="globe" size={12} />检索 ×{searchCount}
            </span>
          )}
          {message.errorMessage && (
            <span className="cg-node__plain-tag--error">
              <Icon name="warning" size={12} />
              {message.errorMessage}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function GraphFloatingBatchBar({
  selectedCount,
  hasSelectedMessages,
  hasUnexpandedSelected,
  canExpandSubtree,
  hasDisconnectable,
  busy,
  onToggleExpandSelected,
  onSelectSubtree,
  onDisconnectSelected,
  onDeleteSelected,
  onClearSelection,
}: {
  selectedCount: number;
  hasSelectedMessages: boolean;
  hasUnexpandedSelected: boolean;
  canExpandSubtree: boolean;
  hasDisconnectable: boolean;
  busy: boolean;
  onToggleExpandSelected: () => void;
  onSelectSubtree: () => void;
  onDisconnectSelected: () => void;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
}) {
  if (selectedCount <= 0) return null;
  return (
    <div
      className="cg-selection-bar"
      role="toolbar"
      aria-label="批量操作"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="cg-selection-bar__count">已选 {selectedCount} 项</span>
      <span className="cg-controls__divider" aria-hidden="true" />
      {hasSelectedMessages && (
        <IconButton
          icon={hasUnexpandedSelected ? 'expand' : 'compress'}
          label={hasUnexpandedSelected ? '展开信息' : '收起信息'}
          size="sm"
          onClick={onToggleExpandSelected}
        />
      )}
      {canExpandSubtree && (
        <IconButton
          icon="mindMap"
          label="选中子树"
          size="sm"
          onClick={onSelectSubtree}
        />
      )}
      {hasDisconnectable && (
        <IconButton
          icon="unlink"
          label="断开上下文"
          size="sm"
          disabled={busy}
          onClick={onDisconnectSelected}
        />
      )}
      <IconButton
        icon="trash"
        tone="danger"
        label="删除所选"
        size="sm"
        disabled={busy}
        onClick={onDeleteSelected}
      />
      <span className="cg-controls__divider" aria-hidden="true" />
      <IconButton
        icon="close"
        label="取消选择"
        size="sm"
        onClick={onClearSelection}
      />
    </div>
  );
}

export function GraphBottomControls({
  selectMode,
  scale,
  minZoom,
  maxZoom,
  allUsersCollapsed,
  allAssistantsExpanded,
  hasUserMessages,
  hasAssistantMessages,
  hasNodes,
  busy,
  onToggleSelectMode,
  onZoomOut,
  onFit,
  onZoomIn,
  onToggleAllUsersSummary,
  onToggleAllAssistantsExpand,
  onAutoLayout,
  onCreateNote,
  onCreateBranch,
}: {
  selectMode: boolean;
  scale: number;
  minZoom: number;
  maxZoom: number;
  allUsersCollapsed: boolean;
  allAssistantsExpanded: boolean;
  hasUserMessages: boolean;
  hasAssistantMessages: boolean;
  hasNodes: boolean;
  busy: boolean;
  onToggleSelectMode: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onZoomIn: () => void;
  onToggleAllUsersSummary: () => void;
  onToggleAllAssistantsExpand: () => void;
  onAutoLayout: () => void;
  onCreateNote: () => void;
  onCreateBranch: () => void;
}) {
  return (
    <div className="cg-controls" role="group" aria-label="图谱控制">
      <IconButton
        icon="boxSelect"
        label="框选模式"
        size="sm"
        active={selectMode}
        aria-pressed={selectMode}
        onClick={onToggleSelectMode}
      />
      <span className="cg-controls__divider" aria-hidden="true" />
      <IconButton
        icon="zoomOut"
        label="缩小"
        size="sm"
        disabled={scale <= minZoom}
        onClick={onZoomOut}
      />
      <button
        type="button"
        className="cg-controls__fit"
        title="适配画布"
        aria-label="适配画布"
        onClick={onFit}
      >
        <Icon name="fitView" size={15} />
        <span>{Math.round(scale * 100)}%</span>
      </button>
      <IconButton
        icon="zoomIn"
        label="放大"
        size="sm"
        disabled={scale >= maxZoom}
        onClick={onZoomIn}
      />
      <span className="cg-controls__divider" aria-hidden="true" />
      <IconButton
        icon="userSummary"
        label={allUsersCollapsed ? '一键恢复用户消息' : '一键缩放用户信息为摘要'}
        size="sm"
        active={allUsersCollapsed}
        aria-pressed={allUsersCollapsed}
        disabled={busy || !hasUserMessages}
        onClick={onToggleAllUsersSummary}
      />
      <IconButton
        icon="botExpand"
        label={allAssistantsExpanded ? '一键收起助手信息' : '一键展开助手信息'}
        size="sm"
        active={allAssistantsExpanded}
        aria-pressed={allAssistantsExpanded}
        disabled={!hasAssistantMessages}
        onClick={onToggleAllAssistantsExpand}
      />
      <span className="cg-controls__divider" aria-hidden="true" />
      <IconButton
        icon="autoLayout"
        label="自动整理布局"
        size="sm"
        disabled={busy || !hasNodes}
        onClick={onAutoLayout}
      />
      <IconButton
        icon="stickyNote"
        label="新建文字标注"
        size="sm"
        disabled={busy}
        onClick={onCreateNote}
      />
      <IconButton
        icon="plus"
        label="新建空白分支"
        size="sm"
        disabled={busy}
        onClick={onCreateBranch}
      />
    </div>
  );
}

export function GraphContextMenu({
  menu,
  menuNode,
  isBatchMenu,
  busy,
  nodes,
  display,
  messagesCount,
  userMessagesCount,
  assistantMessagesCount,
  validMessageIds,
  allUsersCollapsed,
  allAssistantsExpanded,
  allMessagesExpanded,
  effectiveSelectedIds,
  effectiveExpandedIds,
  selectedNodes,
  selectedMessages,
  selectedUserMessages,
  selectedSubtree,
  hasUnexpandedSelected,
  disconnectableSelectedIds,
  noteEdges,
  isLeaf,
  onClose,
  onRestoreFocus,
  onMakeBranch,
  onStartDraftNote,
  onToggleAllUsersSummary,
  onToggleAllAssistantsExpand,
  onPersistExpanded,
  onAutoLayout,
  onFit,
  onToggleExpandTargets,
  onSetSelectedIds,
  onDisconnectIds,
  onSetDeletingNodes,
  onSetEditingNote,
  onToggleExpandNode,
  onSetEditingSummary,
  onActivateNode,
  onJump,
  onPickParent,
  onPickSideRef,
  mutate,
}: {
  menu: { client: Point; world: Point; nodeId?: string } | null;
  menuNode?: GraphNode;
  isBatchMenu: boolean;
  busy: boolean;
  nodes: GraphNode[];
  display: GraphNode[];
  messagesCount: number;
  userMessagesCount: number;
  assistantMessagesCount: number;
  validMessageIds: ReadonlySet<string>;
  allUsersCollapsed: boolean;
  allAssistantsExpanded: boolean;
  allMessagesExpanded: boolean;
  effectiveSelectedIds: ReadonlySet<string>;
  effectiveExpandedIds: ReadonlySet<string>;
  selectedNodes: GraphNode[];
  selectedMessages: GraphNode[];
  selectedUserMessages: GraphNode[];
  selectedSubtree: ReadonlySet<string>;
  hasUnexpandedSelected: boolean;
  disconnectableSelectedIds: string[];
  noteEdges: ConversationGraphNoteEdge[];
  isLeaf: (node: GraphNode) => boolean;
  onClose: () => void;
  onRestoreFocus: () => void;
  onMakeBranch: (pos: Point, parentMessageId?: string) => void;
  onStartDraftNote: (pos: Point) => void;
  onToggleAllUsersSummary: () => void;
  onToggleAllAssistantsExpand: () => void;
  onPersistExpanded: (ids: string[], expanded: boolean) => void;
  onAutoLayout: () => void;
  onFit: () => void;
  onToggleExpandTargets: (targets: GraphNode[]) => void;
  onSetSelectedIds: (ids: Set<string>) => void;
  onDisconnectIds: (ids: string[]) => void;
  onSetDeletingNodes: (targets: GraphNode[]) => void;
  onSetEditingNote: (note: { id: string; text: string }) => void;
  onToggleExpandNode: (id: string) => void;
  onSetEditingSummary: (target: { id: string; text: string }) => void;
  onActivateNode: (node: GraphNode) => void;
  onJump: (messageId: string) => void;
  onPickParent: (nodeId: string) => void;
  onPickSideRef: (nodeId: string) => void;
  mutate: (input: GraphMutationInput) => Promise<ConversationDetail | null>;
}) {
  return (
    <DropdownMenu.Root
      modal={false}
      open={!!menu}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <span
          className="cg-menu-anchor"
          style={{ left: menu?.client.x, top: menu?.client.y }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="ui-menu-content cg-menu"
          align="start"
          collisionPadding={12}
          sideOffset={3}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus();
          }}
        >
          {!menuNode ? (
            <>
              <DropdownItem disabled={busy} onSelect={() => menu && onMakeBranch(menu.world)}>
                <Icon name="plus" size={15} />新建空白分支
              </DropdownItem>
              <DropdownItem disabled={busy} onSelect={() => menu && onStartDraftNote(menu.world)}>
                <Icon name="stickyNote" size={15} />新建文字标注
              </DropdownItem>
              {userMessagesCount > 0 && (
                <DropdownItem disabled={busy} onSelect={onToggleAllUsersSummary}>
                  <Icon name="userSummary" size={15} />
                  {allUsersCollapsed ? '一键恢复用户消息' : '一键缩放用户信息为摘要'}
                </DropdownItem>
              )}
              {assistantMessagesCount > 0 && (
                <DropdownItem onSelect={onToggleAllAssistantsExpand}>
                  <Icon name="botExpand" size={15} />
                  {allAssistantsExpanded ? '一键收起助手信息' : '一键展开助手信息'}
                </DropdownItem>
              )}
              {validMessageIds.size > 0 && (
                <DropdownItem
                  onSelect={() =>
                    onPersistExpanded(Array.from(validMessageIds), !allMessagesExpanded)
                  }
                >
                  <Icon name={allMessagesExpanded ? 'compress' : 'expand'} size={15} />
                  {allMessagesExpanded ? '全部收起信息' : '全部展开信息'}
                </DropdownItem>
              )}
              <DropdownItem disabled={busy || !nodes.length} onSelect={onAutoLayout}>
                <Icon name="autoLayout" size={15} />自动整理布局
              </DropdownItem>
              <DropdownItem onSelect={onFit}>
                <Icon name="fitView" size={15} />适配画布
              </DropdownItem>
            </>
          ) : isBatchMenu ? (
            <>
              {selectedMessages.length > 0 && (
                <DropdownItem onSelect={() => onToggleExpandTargets(selectedMessages)}>
                  <Icon name={hasUnexpandedSelected ? 'expand' : 'compress'} size={15} />
                  {hasUnexpandedSelected ? '展开所选信息' : '收起所选信息'}
                </DropdownItem>
              )}
              {selectedSubtree.size > effectiveSelectedIds.size && (
                <DropdownItem onSelect={() => onSetSelectedIds(new Set(selectedSubtree))}>
                  <Icon name="mindMap" size={15} />选中子树
                </DropdownItem>
              )}
              {selectedUserMessages.length > 0 &&
                (() => {
                  const hasUncollapsed = selectedUserMessages.some(
                    (n) => !isCollapsedSummary(n),
                  );
                  return (
                    <DropdownItem
                      disabled={busy}
                      onSelect={() =>
                        void mutate({
                          op: 'setNodeMeta',
                          messageIds: selectedUserMessages.map((n) => n.id),
                          graphMeta: hasUncollapsed
                            ? { collapsed: true, expanded: false }
                            : { collapsed: false },
                        })
                      }
                    >
                      <Icon name={hasUncollapsed ? 'compress' : 'expand'} size={15} />
                      {hasUncollapsed ? '缩略所选用户节点' : '恢复所选完整节点'}
                    </DropdownItem>
                  );
                })()}
              {disconnectableSelectedIds.length > 0 && (
                <DropdownItem
                  disabled={busy}
                  onSelect={() => onDisconnectIds(disconnectableSelectedIds)}
                >
                  <Icon name="unlink" size={15} />断开所选上下文
                </DropdownItem>
              )}
              <DropdownSeparator />
              <DropdownItem
                danger
                disabled={busy}
                onSelect={() =>
                  requestAnimationFrame(() => onSetDeletingNodes(selectedNodes))
                }
              >
                <Icon name="trash" size={15} />删除所选 {selectedNodes.length} 个节点
              </DropdownItem>
            </>
          ) : menuNode.note ? (
            <>
              <DropdownItem
                disabled={busy}
                onSelect={() =>
                  requestAnimationFrame(() =>
                    onSetEditingNote({ id: menuNode.id, text: menuNode.note!.text }),
                  )
                }
              >
                <Icon name="edit" size={15} />编辑标注
              </DropdownItem>
              {noteEdges
                .filter((e) => e.sourceId === menuNode.id || e.targetId === menuNode.id)
                .map((edge) => (
                  <DropdownItem
                    key={edge.id}
                    disabled={busy}
                    onSelect={() =>
                      void mutate({ op: 'deleteNoteEdge', edgeId: edge.id })
                    }
                  >
                    <Icon name="unlink" size={15} />断开标注连线
                  </DropdownItem>
                ))}
              <DropdownSeparator />
              <DropdownItem
                danger
                disabled={busy}
                onSelect={() =>
                  requestAnimationFrame(() => onSetDeletingNodes([menuNode]))
                }
              >
                <Icon name="trash" size={15} />删除标注
              </DropdownItem>
            </>
          ) : (
            <>
              {menuNode.message && (
                <DropdownItem onSelect={() => onToggleExpandNode(menuNode.id)}>
                  <Icon
                    name={effectiveExpandedIds.has(menuNode.id) ? 'compress' : 'expand'}
                    size={15}
                  />
                  {effectiveExpandedIds.has(menuNode.id) ? '收起信息' : '展开信息'}
                </DropdownItem>
              )}
              {collectSubtreeIds(display, [menuNode.id]).size > 1 && (
                <DropdownItem
                  onSelect={() =>
                    onSetSelectedIds(collectSubtreeIds(display, [menuNode.id]))
                  }
                >
                  <Icon name="mindMap" size={15} />选中子树
                </DropdownItem>
              )}
              {menuNode.message?.role === 'user' && (
                <>
                  <DropdownItem
                    disabled={busy}
                    onSelect={() =>
                      void mutate({
                        op: 'setNodeMeta',
                        messageId: menuNode.id,
                        graphMeta: isCollapsedSummary(menuNode)
                          ? { collapsed: false }
                          : { collapsed: true, expanded: false },
                      })
                    }
                  >
                    <Icon
                      name={isCollapsedSummary(menuNode) ? 'expand' : 'compress'}
                      size={15}
                    />
                    {isCollapsedSummary(menuNode) ? '展开为完整节点' : '缩略为箭头摘要'}
                  </DropdownItem>
                  <DropdownItem
                    disabled={busy}
                    onSelect={() =>
                      requestAnimationFrame(() =>
                        onSetEditingSummary({
                          id: menuNode.id,
                          text: menuNode.message?.graphMeta?.summary ?? '',
                        }),
                      )
                    }
                  >
                    <Icon name="edit" size={15} />编辑摘要
                  </DropdownItem>
                </>
              )}
              {isLeaf(menuNode) && (
                <DropdownItem disabled={busy} onSelect={() => onActivateNode(menuNode)}>
                  <Icon name="arrowUp" size={15} />在此分支继续
                </DropdownItem>
              )}
              {menuNode.message && (
                <>
                  <DropdownItem disabled={busy} onSelect={() => onJump(menuNode.id)}>
                    <Icon name="messageSquare" size={15} />跳转至此消息
                  </DropdownItem>
                  <DropdownItem
                    disabled={busy}
                    onSelect={() =>
                      onMakeBranch(
                        {
                          x: menuNode.x + menuNode.width / 2,
                          y: menuNode.y + menuNode.height + 86,
                        },
                        menuNode.id,
                      )
                    }
                  >
                    <Icon name="branch" size={15} />从此处新建分支
                  </DropdownItem>
                  <DropdownItem
                    disabled={busy || messagesCount < 2}
                    onSelect={() => onPickParent(menuNode.id)}
                  >
                    <Icon name="link" size={15} />更改上游节点
                  </DropdownItem>
                  {isSideRefEligible(menuNode.message) && (
                    <DropdownItem
                      disabled={busy || messagesCount < 2}
                      onSelect={() => onPickSideRef(menuNode.id)}
                    >
                      <Icon name="sideLink" size={15} />侧边接入至…
                    </DropdownItem>
                  )}
                  {menuNode.message.graphMeta?.sideRefs?.map((ref, idx) => (
                    <DropdownItem
                      key={ref.sourceMessageId}
                      disabled={busy}
                      onSelect={() =>
                        void mutate({
                          op: 'removeSideRef',
                          messageId: menuNode.id,
                          sourceMessageId: ref.sourceMessageId,
                        })
                      }
                    >
                      <Icon name="unlink" size={15} />
                      {menuNode.message!.graphMeta!.sideRefs!.length > 1
                        ? `断开侧边接入 ${idx + 1}`
                        : '断开侧边接入'}
                    </DropdownItem>
                  ))}
                  {menuNode.parentId && (
                    <DropdownItem
                      disabled={busy}
                      onSelect={() =>
                        void mutate({
                          op: 'reparent',
                          messageId: menuNode.id,
                          parentId: '',
                        })
                      }
                    >
                      <Icon name="unlink" size={15} />断开上下文
                    </DropdownItem>
                  )}
                </>
              )}
              <DropdownSeparator />
              <DropdownItem
                danger
                disabled={busy}
                onSelect={() =>
                  requestAnimationFrame(() => onSetDeletingNodes([menuNode]))
                }
              >
                <Icon name="trash" size={15} />
                {menuNode.branch ? '删除分支' : '删除消息'}
              </DropdownItem>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
