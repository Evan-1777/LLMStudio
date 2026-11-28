import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { useApp } from '../../app/AppProvider';
import { Button, ConfirmDialog, Icon, IconButton, Modal, SegmentedControl, Textarea } from '../../components/ui';
import type {
  Conversation,
  ConversationDetail,
  GraphMutationInput,
  ContentBlock,
  GraphNotePort,
  Message,
  MessageSideRefScope,
} from '../../core/types';
import { ContentRenderer, MarkdownDocument } from '../../rendering/ContentRenderer';
import {
  collectSubtreeIds,
  computeAutoLayout,
  extractNodePreview,
  extractUserSummary,
  normalizeRect,
  rectIntersectsNode,
  wouldCreateCycle,
  wouldCreateDependencyCycle,
  type GraphNode,
  type Point,
} from './conversationGraph';
import {
  curve,
  moveTo,
  nearestNotePort,
  noteEdgeCurve,
  nodeSideOutPort,
  notePortPoint,
  port,
  sidePort,
  sideRefCurve,
} from './conversationGraphGeometry';
import {
  GraphBottomControls,
  GraphContextMenu,
  GraphFloatingBatchBar,
  PlainMessageDetail,
} from './ConversationGraphControls';
import { GraphNoteEditor } from './GraphNoteEditor';
import { replaceMessageTextBlocks } from './MessageEditor';
import './conversation-graph.css';

type View = Point & { scale: number };
type NodeSize = { width: number; height: number };
type DragOrigin = { node: GraphNode; x: number; y: number };
type Gesture =
  | { kind: 'pan'; id: number; start: Point; view: View; moved: boolean; button: number; modifiers: boolean }
  | { kind: 'marquee'; id: number; start: Point; additive: boolean; baseIds: Set<string>; moved: boolean }
  | { kind: 'move'; id: number; start: Point; node: GraphNode; origins: DragOrigin[]; modifiers: boolean; moved: boolean }
  | { kind: 'link'; id: number; start: Point; node: GraphNode; end: 'in' | 'out'; moved: boolean }
  | { kind: 'sideLink'; id: number; start: Point; node: GraphNode; side: 'left' | 'right'; moved: boolean }
  | { kind: 'nodeSideLink'; id: number; start: Point; node: GraphNode; moved: boolean }
  | { kind: 'noteLink'; id: number; start: Point; node: GraphNode; fromPort: GraphNotePort; moved: boolean }
  | { kind: 'pinch'; start: Point; distance: number; view: View };
type MarqueeState = { start: Point; current: Point; additive: boolean; baseIds: Set<string> };
type LinkDrag =
  | { mode: 'reparent'; node: GraphNode; end: 'in' | 'out'; pointer: Point; target?: GraphNode; valid: boolean; overNode: boolean }
  | { mode: 'sideRef'; origin: 'out' | 'side' | 'nodeOut'; scope: MessageSideRefScope; node: GraphNode; side: 'left' | 'right'; pointer: Point; target?: GraphNode; valid: boolean }
  | { mode: 'noteEdge'; node: GraphNode; fromPort: GraphNotePort; pointer: Point; target?: GraphNode; toPort?: GraphNotePort; valid: boolean };

const initialView: View = { x: 0, y: 0, scale: 1 };
const minZoom = 0.35;
const maxZoom = 1.8;
const defaultExpandedSize: NodeSize = { width: 420, height: 220 };
const clampZoom = (scale: number) => Math.min(maxZoom, Math.max(minZoom, scale));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const summary = (node: GraphNode) => node.message?.role === 'user' && node.message.graphMeta?.collapsed;
const isSideRefEligible = (msg?: Message) => Boolean(msg && (msg.role === 'user' || msg.role === 'assistant'));

const sideToward = (
  source: { x: number; width: number },
  target: { x: number; width: number },
): 'left' | 'right' =>
  source.x + source.width / 2 > target.x + target.width / 2 ? 'right' : 'left';
const zoomAt = (view: View, from: Point, to: Point, scale: number): View => ({
  scale, x: to.x - (from.x - view.x) * scale / view.scale, y: to.y - (from.y - view.y) * scale / view.scale,
});
const toWorld = (point: Point, view: View): Point => ({ x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale });

const NOTE_PORTS: readonly GraphNotePort[] = ['top', 'bottom', 'left', 'right'];

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function ConversationGraphView({
  conversation,
  messages,
  activeMessages,
  busy,
  mutate,
  onJump,
  onActivate,
  onUpdateMessage,
  focusNodeId,
  onFocusHandled,
}: {
  conversation: Conversation;
  messages: Message[];
  activeMessages: Message[];
  busy: boolean;
  mutate: (input: GraphMutationInput) => Promise<ConversationDetail | null>;
  onJump: (messageId: string) => void;
  onActivate: (branch: { leafMessageId: string } | { branchId: string }) => void;
  onDelete?: (message: Message) => Promise<boolean>;
  onUpdateMessage?: (messageId: string, blocks: ContentBlock[]) => Promise<boolean>;
  focusNodeId?: string | null;
  onFocusHandled?: () => void;
}) {
  const { settings } = useApp();
  const stage = useRef<HTMLDivElement>(null);
  const marker = useId();
  const summaryForm = useId();
  const createMsgForm = useId();
  const editMsgForm = useId();
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Point>());
  const viewRef = useRef(initialView);
  const spacePressedRef = useRef(false);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  const observedElements = useRef(new Map<string, HTMLDivElement>());
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const expandSeqRef = useRef(new Map<string, number>());

  const [view, setView] = useState(initialView);
  const [panning, setPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [moving, setMoving] = useState<ReadonlyMap<string, Point> | null>(null);
  const [optimisticExpanded, setOptimisticExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [measuredSizes, setMeasuredSizes] = useState<ReadonlyMap<string, NodeSize>>(() => new Map());
  const [link, setLink] = useState<LinkDrag | null>(null);
  const [pickParent, setPickParent] = useState<string | null>(null);
  const [pickSideRef, setPickSideRef] = useState<{ sourceId: string; scope: MessageSideRefScope } | null>(null);
  const [menu, setMenu] = useState<{ id?: string; client: Point; world: Point } | null>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [creatingMsg, setCreatingMsg] = useState<{
    role: 'user' | 'assistant';
    text: string;
    parentMessageId?: string;
    x: number;
    y: number;
  } | null>(null);
  const [editingMsgContent, setEditingMsgContent] = useState<{ message: Message; text: string } | null>(null);
  const [draftNote, setDraftNote] = useState<{ x: number; y: number; text: string } | null>(null);
  const [editingNote, setEditingNote] = useState<{ id: string; text: string } | null>(null);
  const [deletingNodes, setDeletingNodes] = useState<GraphNode[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nodes = useMemo(() => computeAutoLayout(conversation, messages), [conversation, messages]);
  const validNodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const validMessageIds = useMemo(
    () => new Set(nodes.filter((node) => Boolean(node.message)).map((node) => node.id)),
    [nodes],
  );
  const validNoteIds = useMemo(
    () => new Set(nodes.filter((node) => Boolean(node.note)).map((node) => node.id)),
    [nodes],
  );
  const effectiveSelectedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedIds) if (validNodeIds.has(id)) next.add(id);
    return next;
  }, [selectedIds, validNodeIds]);

  const effectiveExpandedIds = useMemo(() => {
    const next = new Set<string>();
    for (const msg of messages) {
      const override = optimisticExpanded.get(msg.id);
      const isExpanded = override !== undefined ? override : Boolean(msg.graphMeta?.expanded);
      if (isExpanded && validMessageIds.has(msg.id)) next.add(msg.id);
    }
    return next;
  }, [messages, optimisticExpanded, validMessageIds]);

  const activeIds = useMemo(() => new Set([
    ...activeMessages.map((m) => m.id), conversation.graphState?.activeBranchId,
  ]), [activeMessages, conversation.graphState?.activeBranchId]);

  const display = useMemo(() => nodes.map((node) => {
    let next = node;
    if (node.message && effectiveExpandedIds.has(node.id)) {
      const measured = measuredSizes.get(node.id);
      next = {
        ...next,
        width: measured?.width ?? defaultExpandedSize.width,
        height: measured?.height ?? defaultExpandedSize.height,
      };
    } else if (node.note) {
      const measured = measuredSizes.get(node.id);
      if (measured) {
        next = { ...next, width: measured.width, height: measured.height };
      }
    }
    const offset = moving?.get(node.id);
    return offset ? { ...next, x: offset.x, y: offset.y } : next;
  }), [nodes, effectiveExpandedIds, measuredSizes, moving]);

  const byId = useMemo(() => new Map(display.map((node) => [node.id, node])), [display]);
  const children = useMemo(() => {
    const result = new Map<string, GraphNode[]>();
    for (const node of display) {
      if (!node.parentId) continue;
      const row = result.get(node.parentId) ?? [];
      row.push(node);
      result.set(node.parentId, row);
    }
    return result;
  }, [display]);

  const computeMarqueeHits = useCallback((start: Point, current: Point, additive: boolean, baseIds: ReadonlySet<string>) => {
    const screenRect = normalizeRect(start, current);
    const tl = toWorld({ x: screenRect.left, y: screenRect.top }, viewRef.current);
    const br = toWorld({ x: screenRect.right, y: screenRect.bottom }, viewRef.current);
    const worldRect = normalizeRect(tl, br);
    const next = additive ? new Set(baseIds) : new Set<string>();
    for (const node of display) {
      if (rectIntersectsNode(worldRect, node)) next.add(node.id);
    }
    return next;
  }, [display]);

  const visualSelectedIds = useMemo(() => {
    if (!marquee) return effectiveSelectedIds;
    return computeMarqueeHits(marquee.start, marquee.current, marquee.additive, marquee.baseIds);
  }, [marquee, effectiveSelectedIds, computeMarqueeHits]);

  const selectedNodes = useMemo(
    () => display.filter((node) => effectiveSelectedIds.has(node.id)),
    [display, effectiveSelectedIds],
  );
  const selectedMessages = useMemo(
    () => selectedNodes.filter((node) => Boolean(node.message)),
    [selectedNodes],
  );
  const hasUnexpandedSelected = useMemo(
    () => selectedMessages.some((node) => !effectiveExpandedIds.has(node.id)),
    [selectedMessages, effectiveExpandedIds],
  );
  const selectedSubtree = useMemo(
    () => effectiveSelectedIds.size ? collectSubtreeIds(display, effectiveSelectedIds) : new Set<string>(),
    [display, effectiveSelectedIds],
  );
  const disconnectableSelectedIds = useMemo(
    () => selectedMessages.filter((node) => Boolean(node.parentId)).map((node) => node.id),
    [selectedMessages],
  );
  const selectedUserMessages = useMemo(
    () => selectedMessages.filter((node) => node.message?.role === 'user'),
    [selectedMessages],
  );
  const userMessages = useMemo(
    () => messages.filter((msg) => msg.role === 'user'),
    [messages],
  );
  const assistantMessages = useMemo(
    () => messages.filter((msg) => msg.role === 'assistant'),
    [messages],
  );
  const allUsersCollapsed = useMemo(
    () => userMessages.length > 0 && userMessages.every((msg) => Boolean(msg.graphMeta?.collapsed)),
    [userMessages],
  );
  const allAssistantsExpanded = useMemo(
    () => assistantMessages.length > 0 && assistantMessages.every((msg) => effectiveExpandedIds.has(msg.id)),
    [assistantMessages, effectiveExpandedIds],
  );
  const allMessagesExpanded = useMemo(
    () => validMessageIds.size > 0 && Array.from(validMessageIds).every((id) => effectiveExpandedIds.has(id)),
    [validMessageIds, effectiveExpandedIds],
  );

  const noteEdges = conversation.graphState?.noteEdges ?? [];

  const activeId = conversation.graphState?.activeBranchId || conversation.activeLeafId || activeMessages.at(-1)?.id;
  const menuNode = menu?.id ? byId.get(menu.id) : undefined;
  const isBatchMenu = Boolean(menuNode && effectiveSelectedIds.size > 1 && effectiveSelectedIds.has(menuNode.id));
  const setCamera = (next: View) => { viewRef.current = next; setView(next); };
  const origin = (clientX: number, clientY: number): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const center = (): Point => ({ x: (stage.current?.clientWidth ?? 0) / 2, y: (stage.current?.clientHeight ?? 0) / 2 });

  const fit = useCallback((entries: GraphNode[], preferReadable = false) => {
    if (!entries.length) { setCamera(initialView); return; }
    const rect = stage.current!.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of entries) {
      left = Math.min(left, node.x);
      top = Math.min(top, node.y);
      right = Math.max(right, node.x + node.width);
      bottom = Math.max(bottom, node.y + node.height);
    }
    const usableHeight = Math.max(1, rect.height - 76);
    const fitted = clampZoom(Math.min(1, (rect.width - 48) / Math.max(1, right - left), usableHeight / Math.max(1, bottom - top)));
    const scale = preferReadable && rect.width < 500 ? Math.max(fitted, 0.68) : fitted;
    const focus = entries.find((node) => node.id === activeId);
    const focusX = focus && (right - left) * scale > rect.width - 48 ? focus.x + focus.width / 2 : (left + right) / 2;
    const focusY = focus && (bottom - top) * scale > usableHeight ? focus.y + focus.height / 2 : (top + bottom) / 2;
    setCamera({ scale, x: rect.width / 2 - focusX * scale, y: usableHeight / 2 + 16 - focusY * scale });
  }, [activeId]);

  const centerOnNode = useCallback((target: GraphNode) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = clampZoom(Math.max(viewRef.current.scale, 1));
    const usableHeight = Math.max(1, rect.height - 76);
    const focusX = target.x + target.width / 2;
    const focusY = target.y + target.height / 2;
    setCamera({
      scale,
      x: rect.width / 2 - focusX * scale,
      y: usableHeight / 2 + 16 - focusY * scale,
    });
    setSelectedIds(new Set([target.id]));
  }, []);

  useLayoutEffect(() => {
    if (focusNodeId) {
      const target = display.find((node) => node.id === focusNodeId);
      if (target) {
        centerOnNode(target);
        onFocusHandled?.();
        return;
      }
    }
    fit(display, true);
  }, []); // A topic change remounts the viewport; graph edits preserve the camera.

  useEffect(() => {
    if (!focusNodeId) return;
    const target = byId.get(focusNodeId);
    if (!target) return;
    centerOnNode(target);
    onFocusHandled?.();
  }, [focusNodeId, byId, centerOnNode, onFocusHandled]);

  // Observe dynamic-sized nodes (expanded message cards and adaptive text notes) so SVG edges & ports stay aligned.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const measureEl = (el: HTMLDivElement) => {
      const id = el.dataset.graphNode;
      if (!id) return;
      const width = Math.round(el.offsetWidth);
      const height = Math.round(el.offsetHeight);
      if (width <= 0 || height <= 0) return;
      setMeasuredSizes((prev) => {
        const cur = prev.get(id);
        if (cur && cur.width === width && cur.height === height) return prev;
        const next = new Map(prev);
        next.set(id, { width, height });
        return next;
      });
    };
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLDivElement) measureEl(entry.target);
      }
    });
    resizeObserver.current = obs;
    for (const el of observedElements.current.values()) {
      obs.observe(el);
      measureEl(el);
    }
    return () => {
      obs.disconnect();
      resizeObserver.current = null;
    };
  }, []);

  // Prune measured sizes when nodes are collapsed or removed.
  useEffect(() => {
    setMeasuredSizes((prev) => {
      let changed = false;
      for (const id of prev.keys()) {
        if (!effectiveExpandedIds.has(id) && !validNoteIds.has(id)) { changed = true; break; }
      }
      if (!changed) return prev;
      const next = new Map<string, NodeSize>();
      for (const [id, size] of prev) {
        if (effectiveExpandedIds.has(id) || validNoteIds.has(id)) next.set(id, size);
      }
      return next;
    });
  }, [effectiveExpandedIds, validNoteIds]);

  const bindDynamicRef = useCallback((id: string, el: HTMLDivElement | null) => {
    const prev = observedElements.current.get(id);
    if (prev && prev !== el) {
      resizeObserver.current?.unobserve(prev);
      observedElements.current.delete(id);
    }
    if (el) {
      observedElements.current.set(id, el);
      resizeObserver.current?.observe(el);
      const width = Math.round(el.offsetWidth);
      const height = Math.round(el.offsetHeight);
      if (width > 0 && height > 0) {
        setMeasuredSizes((map) => {
          const cur = map.get(id);
          if (cur && cur.width === width && cur.height === height) return map;
          const next = new Map(map);
          next.set(id, { width, height });
          return next;
        });
      }
    }
  }, []);

  // Wheel zoom on stage, letting scrollable expanded card bodies scroll naturally.
  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        const detail = (event.target as Element | null)?.closest<HTMLElement>('.cg-node__detail');
        if (detail && detail.scrollHeight > detail.clientHeight + 1) {
          return;
        }
      }
      event.preventDefault();
      const point = origin(event.clientX, event.clientY);
      const current = viewRef.current;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      setCamera(zoomAt(current, point, point, clampZoom(current.scale * Math.exp(-delta * 0.0018))));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  // Keyboard shortcuts (capture phase so Escape unwinds graph state before WorkbenchPage closes the graph).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (menu || editing || deletingNodes || draftNote || editingNote || creatingMsg || editingMsgContent) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (isEditableElement(event.target) || isEditableElement(document.activeElement)) return;

      if (event.key === 'Escape') {
        if (pickParent) {
          event.preventDefault();
          event.stopPropagation();
          setPickParent(null);
          return;
        }
        if (pickSideRef) {
          event.preventDefault();
          event.stopPropagation();
          setPickSideRef(null);
          return;
        }
        if (effectiveSelectedIds.size > 0 || selectMode) {
          event.preventDefault();
          event.stopPropagation();
          lastClickRef.current = null;
          setSelectedIds(new Set());
          setSelectMode(false);
          return;
        }
        return;
      }

      if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!spacePressedRef.current) {
          spacePressedRef.current = true;
          setSpacePressed(true);
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        if (nodes.length > 0) {
          event.preventDefault();
          setSelectedIds(new Set(nodes.map((node) => node.id)));
        }
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && effectiveSelectedIds.size > 0 && !busy) {
        event.preventDefault();
        setDeletingNodes(display.filter((node) => effectiveSelectedIds.has(node.id)));
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && spacePressedRef.current) {
        spacePressedRef.current = false;
        setSpacePressed(false);
      }
    };

    const onBlur = () => {
      if (spacePressedRef.current) {
        spacePressedRef.current = false;
        setSpacePressed(false);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [busy, creatingMsg, deletingNodes, display, draftNote, editing, editingMsgContent, editingNote, effectiveSelectedIds, menu, nodes, pickParent, pickSideRef, selectMode]);

  const changeZoom = (factor: number) => {
    const point = center();
    const current = viewRef.current;
    setCamera(zoomAt(current, point, point, clampZoom(current.scale * factor)));
  };

  const makeBranch = (point: Point, parentMessageId = '') => {
    const x = Math.round(point.x - 106);
    const y = Math.round(point.y - 34);
    const vacant = (offset: number) => display.every((node) =>
      x + offset + 228 <= node.x || x + offset >= node.x + node.width + 16 || y + 84 <= node.y || y >= node.y + node.height + 16);
    let offset = 0;
    while (!vacant(offset)) offset += 248;
    void mutate({ op: 'createBranch', parentMessageId, x: x + offset, y }).then((result) => {
      if (!result || !stage.current) return;
      const camera = viewRef.current;
      const left = (x + offset) * camera.scale + camera.x;
      const top = y * camera.scale + camera.y;
      const right = left + 212 * camera.scale;
      const bottom = top + 68 * camera.scale;
      const dx = left < 16 ? 16 - left : Math.min(0, stage.current.clientWidth - 16 - right);
      const dy = top < 16 ? 16 - top : Math.min(0, stage.current.clientHeight - 68 - bottom);
      if (dx || dy) setCamera({ ...camera, x: camera.x + dx, y: camera.y + dy });
    });
  };

  const openCreateMessage = (
    role: 'user' | 'assistant',
    point: Point,
    parentMessageId?: string,
  ) => {
    setMenu(null);
    setEditingMsgContent(null);
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    const vacant = (offset: number) => display.every((node) =>
      x + offset + 248 <= node.x ||
      x + offset >= node.x + node.width + 16 ||
      y + 96 <= node.y ||
      y >= node.y + node.height + 16);
    let offset = 0;
    while (!vacant(offset)) offset += 264;
    setCreatingMsg({ role, text: '', parentMessageId, x: x + offset, y });
  };

  const startDraftNote = (point: Point) => {
    setMenu(null);
    setEditingNote(null);
    setDraftNote({ x: Math.round(point.x - 74), y: Math.round(point.y - 22), text: '' });
  };

  const revealAt = (x: number, y: number, width: number, height: number) => {
    if (!stage.current) return;
    const camera = viewRef.current;
    const left = x * camera.scale + camera.x;
    const top = y * camera.scale + camera.y;
    const right = left + width * camera.scale;
    const bottom = top + height * camera.scale;
    const dx = left < 16 ? 16 - left : Math.min(0, stage.current.clientWidth - 16 - right);
    const dy = top < 16 ? 16 - top : Math.min(0, stage.current.clientHeight - 16 - bottom);
    if (dx || dy) setCamera({ ...camera, x: camera.x + dx, y: camera.y + dy });
  };

  const submitCreatingMessage = async () => {
    if (!creatingMsg || submitting) return;
    const text = creatingMsg.text.trim();
    if (!text) return;
    const known = new Set(messages.map((message) => message.id));
    setSubmitting(true);
    const result = await mutate({
      op: 'createMessage',
      role: creatingMsg.role,
      text,
      parentMessageId: creatingMsg.parentMessageId,
      x: creatingMsg.x,
      y: creatingMsg.y,
    });
    setSubmitting(false);
    if (!result) return;
    const created = result.messages.find((message) => !known.has(message.id));
    if (created) setSelectedIds(new Set([created.id]));
    revealAt(creatingMsg.x, creatingMsg.y, 248, 96);
    setCreatingMsg(null);
  };

  const submitEditedMessage = async () => {
    if (!editingMsgContent || !onUpdateMessage || submitting) return;
    const { message, text } = editingMsgContent;
    const hasOtherBlocks = message.blocks.some((block) => block.type !== 'text');
    if (!text.trim() && !hasOtherBlocks) return;
    setSubmitting(true);
    const ok = await onUpdateMessage(message.id, replaceMessageTextBlocks(message.blocks, text));
    setSubmitting(false);
    if (ok) setEditingMsgContent(null);
  };

  const layout = async () => {
    const sizeOverrides = new Map<string, NodeSize>();
    for (const id of effectiveExpandedIds) {
      sizeOverrides.set(id, measuredSizes.get(id) ?? defaultExpandedSize);
    }
    for (const id of validNoteIds) {
      const measured = measuredSizes.get(id);
      if (measured) sizeOverrides.set(id, measured);
    }
    const arranged = computeAutoLayout(conversation, messages, false, sizeOverrides.size ? sizeOverrides : undefined);
    const movable = arranged.filter((node) => !node.note);
    if (!movable.length) return;
    const result = await mutate({
      op: 'setNodeMeta',
      positions: movable.map(({ id, branch, x, y }) => ({ ...(branch ? { branchId: id } : { messageId: id }), x, y })),
    });
    if (result) fit(arranged);
  };

  const isLeaf = (node: GraphNode) => Boolean(!node.note && !children.has(node.id));
  const activate = (node: GraphNode) => onActivate(node.branch ? { branchId: node.id } : { leafMessageId: node.id });
  const canConnect = (child: string, parent: GraphNode) => Boolean(parent.message) && !wouldCreateCycle(byId, child, parent.id);
  const canSideAttach = (targetId: string, sourceId: string) => !wouldCreateDependencyCycle(messages, targetId, sourceId);

  const persistExpanded = (ids: string[], expanded: boolean) => {
    if (!ids.length) return;
    const seqs = new Map<string, number>();
    setOptimisticExpanded((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const seq = (expandSeqRef.current.get(id) ?? 0) + 1;
        expandSeqRef.current.set(id, seq);
        seqs.set(id, seq);
        next.set(id, expanded);
      }
      return next;
    });
    const req: GraphMutationInput = ids.length === 1
      ? { op: 'setNodeMeta', messageId: ids[0], graphMeta: { expanded } }
      : { op: 'setNodeMeta', messageIds: ids, graphMeta: { expanded } };
    void mutate(req).finally(() => {
      setOptimisticExpanded((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, seq] of seqs) {
          if (expandSeqRef.current.get(id) === seq && next.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
  };

  const toggleExpandNode = (id: string) => {
    persistExpanded([id], !effectiveExpandedIds.has(id));
  };

  const toggleExpandTargets = (targets: GraphNode[]) => {
    const msgIds = targets.filter((n) => Boolean(n.message)).map((n) => n.id);
    if (!msgIds.length) return;
    const shouldExpand = msgIds.some((id) => !effectiveExpandedIds.has(id));
    persistExpanded(msgIds, shouldExpand);
  };

  const toggleAllUsersSummary = () => {
    if (!userMessages.length || busy) return;
    const ids = userMessages.map((m) => m.id);
    const shouldCollapse = !allUsersCollapsed;
    if (shouldCollapse) {
      setOptimisticExpanded((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
    void mutate({
      op: 'setNodeMeta',
      messageIds: ids,
      graphMeta: shouldCollapse ? { collapsed: true, expanded: false } : { collapsed: false },
    });
  };

  const toggleAllAssistantsExpand = () => {
    if (!assistantMessages.length) return;
    persistExpanded(assistantMessages.map((m) => m.id), !allAssistantsExpanded);
  };

  const disconnectIds = (ids: string[]) => {
    if (!ids.length) return;
    if (ids.length === 1) {
      void mutate({ op: 'reparent', messageId: ids[0], parentId: '' });
    } else {
      void mutate({ op: 'reparent', messageIds: ids, parentId: '' });
    }
  };

  const handleNodeSelect = (node: GraphNode, modifiers: boolean) => {
    if (busy) return;
    if (pickParent) {
      if (canConnect(pickParent, node)) {
        void mutate({ op: 'reparent', messageId: pickParent, parentId: node.id });
        setPickParent(null);
      }
      return;
    }
    if (pickSideRef) {
      if (isSideRefEligible(node.message) && canSideAttach(node.id, pickSideRef.sourceId)) {
        const sourceNode = byId.get(pickSideRef.sourceId);
        const side: 'left' | 'right' = sourceNode ? sideToward(sourceNode, node) : 'left';
        void mutate({
          op: 'addSideRef',
          messageId: node.id,
          sourceMessageId: pickSideRef.sourceId,
          side,
          scope: pickSideRef.scope,
        });
        setPickSideRef(null);
      }
      return;
    }
    if (modifiers || selectMode) {
      setSelectedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) if (validNodeIds.has(id)) next.add(id);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    } else {
      setSelectedIds(new Set([node.id]));
    }
  };

  function start(
    event: PointerEvent,
    spec:
      | { kind: 'move'; node: GraphNode }
      | { kind: 'link'; node: GraphNode; end: 'in' | 'out' }
      | { kind: 'sideLink'; node: GraphNode; side: 'left' | 'right' }
      | { kind: 'nodeSideLink'; node: GraphNode }
      | { kind: 'noteLink'; node: GraphNode; fromPort: GraphNotePort }
      | { kind: 'pan' }
      | { kind: 'marquee'; additive: boolean },
  ) {
    if (menu || editing || deletingNodes || draftNote || editingNote || creatingMsg || editingMsgContent) return;
    const isMiddle = event.button === 1;
    if (spec.kind === 'pan') {
      if (event.button !== 0 && !isMiddle) return;
      if (isMiddle) event.preventDefault();
    } else {
      if (event.button !== 0) return;
      event.stopPropagation();
    }
    const point = origin(event.clientX, event.clientY);
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, point);
      if (touches.current.size >= 2) {
        const [a, b] = touches.current.values();
        gesture.current = { kind: 'pinch', start: midpoint(a, b), distance: Math.max(distance(a, b), 1), view: viewRef.current };
        setMoving(null);
        setLink(null);
        setMarquee(null);
        setPanning(true);
        stage.current!.setPointerCapture(event.pointerId);
        return;
      }
    }
    if (gesture.current) return;
    stage.current!.setPointerCapture(event.pointerId);
    const modifiers = event.ctrlKey || event.metaKey || event.shiftKey;
    if (spec.kind === 'pan') {
      gesture.current = {
        kind: 'pan', id: event.pointerId, start: point, view: viewRef.current,
        moved: false, button: event.button, modifiers,
      };
    } else if (spec.kind === 'marquee') {
      const baseIds = new Set(effectiveSelectedIds);
      gesture.current = {
        kind: 'marquee', id: event.pointerId, start: point,
        additive: spec.additive, baseIds, moved: false,
      };
    } else if (spec.kind === 'move') {
      const isMulti = effectiveSelectedIds.has(spec.node.id) && effectiveSelectedIds.size > 1;
      const origins: DragOrigin[] = isMulti
        ? display.filter((n) => effectiveSelectedIds.has(n.id)).map((n) => ({ node: n, x: n.x, y: n.y }))
        : [{ node: spec.node, x: spec.node.x, y: spec.node.y }];
      gesture.current = {
        kind: 'move', id: event.pointerId, start: point,
        node: spec.node, origins, modifiers, moved: false,
      };
    } else if (spec.kind === 'link') {
      gesture.current = { kind: 'link', id: event.pointerId, start: point, node: spec.node, end: spec.end, moved: false };
    } else if (spec.kind === 'sideLink') {
      gesture.current = { kind: 'sideLink', id: event.pointerId, start: point, node: spec.node, side: spec.side, moved: false };
    } else if (spec.kind === 'nodeSideLink') {
      gesture.current = { kind: 'nodeSideLink', id: event.pointerId, start: point, node: spec.node, moved: false };
    } else {
      gesture.current = { kind: 'noteLink', id: event.pointerId, start: point, node: spec.node, fromPort: spec.fromPort, moved: false };
    }
  }

  function linkAt(
    event: PointerEvent,
    drag: Extract<Gesture, { kind: 'link' | 'sideLink' | 'nodeSideLink' | 'noteLink' }>,
  ): LinkDrag {
    const pointer = toWorld(origin(event.clientX, event.clientY), viewRef.current);
    const hitEl = document.elementFromPoint(event.clientX, event.clientY);
    const nodeEl = hitEl?.closest<HTMLElement>('[data-graph-node]');
    const target = nodeEl?.dataset.graphNode ? byId.get(nodeEl.dataset.graphNode) : undefined;

    if (drag.kind === 'noteLink') {
      const valid = Boolean(target && target.id !== drag.node.id);
      const toPort = valid && target ? nearestNotePort(target, pointer).port : undefined;
      return { mode: 'noteEdge', node: drag.node, fromPort: drag.fromPort, pointer, target, toPort, valid };
    }

    if (drag.kind === 'sideLink') {
      const valid = Boolean(target && isSideRefEligible(target.message) && canSideAttach(drag.node.id, target.id));
      return { mode: 'sideRef', origin: 'side', scope: 'branch', node: drag.node, side: drag.side, pointer, target, valid };
    }

    if (drag.kind === 'nodeSideLink') {
      if (!target || !isSideRefEligible(target.message)) {
        return { mode: 'sideRef', origin: 'nodeOut', scope: 'node', node: drag.node, side: 'right', pointer, valid: false };
      }
      const sidePortEl = hitEl?.closest<HTMLElement>('[data-port="side-left"], [data-port="side-right"]');
      const side: 'left' | 'right' = sidePortEl
        ? sidePortEl.dataset.port === 'side-left' ? 'left' : 'right'
        : sideToward(drag.node, target);
      const valid = canSideAttach(target.id, drag.node.id);
      return { mode: 'sideRef', origin: 'nodeOut', scope: 'node', node: drag.node, side, pointer, target, valid };
    }

    // Orthogonal gesture boundary: out -> explicit side-left/side-right port hotzone => addSideRef;
    // otherwise out -> node body/in => reparent.
    if (drag.end === 'out' && isSideRefEligible(drag.node.message)) {
      const sidePortEl = hitEl?.closest<HTMLElement>('[data-port="side-left"], [data-port="side-right"]');
      if (sidePortEl && target && isSideRefEligible(target.message)) {
        const side: 'left' | 'right' = sidePortEl.dataset.port === 'side-left' ? 'left' : 'right';
        const valid = canSideAttach(target.id, drag.node.id);
        return { mode: 'sideRef', origin: 'out', scope: 'branch', node: drag.node, side, pointer, target, valid };
      }
    }

    const valid = !!target && (drag.end === 'in'
      ? canConnect(drag.node.id, target)
      : !!target.message && canConnect(target.id, drag.node));
    return {
      mode: 'reparent', node: drag.node, end: drag.end, target, valid, overNode: !!target, pointer,
    };
  }

  function move(event: PointerEvent) {
    const drag = gesture.current;
    if (!drag) return;
    const current = origin(event.clientX, event.clientY);
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, current);
    if (drag.kind === 'pinch') {
      const [a, b] = touches.current.values();
      if (a && b) setCamera(zoomAt(drag.view, drag.start, midpoint(a, b), clampZoom(drag.view.scale * distance(a, b) / drag.distance)));
      return;
    }
    if (event.pointerId !== drag.id) return;
    drag.moved ||= distance(current, drag.start) > 5;
    if (!drag.moved) return;
    const dx = current.x - drag.start.x;
    const dy = current.y - drag.start.y;
    if (drag.kind === 'pan') {
      setPanning(true);
      setCamera({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
    } else if (drag.kind === 'marquee') {
      setMarquee({ start: drag.start, current, additive: drag.additive, baseIds: drag.baseIds });
    } else if (!busy && !pickParent && !pickSideRef) {
      if (drag.kind === 'move') {
        const wdx = dx / viewRef.current.scale;
        const wdy = dy / viewRef.current.scale;
        const next = new Map<string, Point>();
        for (const item of drag.origins) {
          next.set(item.node.id, { x: item.x + wdx, y: item.y + wdy });
        }
        setMoving(next);
      } else {
        setLink(linkAt(event, drag));
      }
    }
  }

  function end(event: PointerEvent, cancelled = false) {
    touches.current.delete(event.pointerId);
    const drag = gesture.current;
    if (!drag || (drag.kind !== 'pinch' && drag.id !== event.pointerId)) return;
    if (drag.kind === 'pinch' && touches.current.size) return;
    gesture.current = null;
    setPanning(false);
    setLink(null);
    setMarquee(null);
    const point = origin(event.clientX, event.clientY);
    const moved = drag.kind !== 'pinch' && (drag.moved || distance(point, drag.start) > 5);
    if (cancelled || drag.kind === 'pinch' || busy || !moved || drag.kind !== 'move') setMoving(null);
    if (cancelled || drag.kind === 'pinch') return;

    if (drag.kind === 'pan') {
      lastClickRef.current = null;
      if (!moved && drag.button === 0 && !drag.modifiers) {
        setSelectedIds(new Set());
      }
      return;
    }

    if (drag.kind === 'marquee') {
      lastClickRef.current = null;
      if (!moved) {
        if (!drag.additive) setSelectedIds(new Set());
      } else {
        setSelectedIds(computeMarqueeHits(drag.start, point, drag.additive, drag.baseIds));
      }
      return;
    }

    if (busy) return;
    if (drag.kind === 'move') {
      if (!moved) {
        const now = performance.now();
        const isDouble = !drag.modifiers && !pickParent && !pickSideRef && lastClickRef.current?.id === drag.node.id && now - lastClickRef.current.time < 360;
        if (isDouble) {
          lastClickRef.current = null;
          if (drag.node.note) setEditingNote({ id: drag.node.id, text: drag.node.note.text });
          else if (drag.node.branch) activate(drag.node);
          else if (drag.node.message) toggleExpandNode(drag.node.id);
        } else {
          lastClickRef.current = drag.modifiers || pickParent || pickSideRef ? null : { id: drag.node.id, time: now };
          handleNodeSelect(drag.node, drag.modifiers);
        }
      } else if (!pickParent && !pickSideRef) {
        lastClickRef.current = null;
        const wdx = (point.x - drag.start.x) / viewRef.current.scale;
        const wdy = (point.y - drag.start.y) / viewRef.current.scale;
        const next = new Map<string, Point>();
        const positions = drag.origins.map((item) => {
          const x = Math.round(item.x + wdx);
          const y = Math.round(item.y + wdy);
          next.set(item.node.id, { x, y });
          return {
            ...(item.node.note
              ? { noteId: item.node.id }
              : item.node.branch
                ? { branchId: item.node.id }
                : { messageId: item.node.id }),
            x,
            y,
          };
        });
        setMoving(next);
        void mutate({ op: 'setNodeMeta', positions }).finally(() => setMoving(null));
      }
    } else if ((drag.kind === 'link' || drag.kind === 'sideLink' || drag.kind === 'nodeSideLink' || drag.kind === 'noteLink') && moved) {
      const drop = linkAt(event, drag);
      if (drop.mode === 'noteEdge') {
        if (drop.valid && drop.target && drop.toPort) {
          void mutate({
            op: 'createNoteEdge',
            sourceId: drop.node.id,
            sourcePort: drop.fromPort,
            targetId: drop.target.id,
            targetPort: drop.toPort,
          });
        }
      } else if (drop.mode === 'sideRef') {
        if (drop.valid && drop.target) {
          const targetId = drop.origin === 'side' ? drop.node.id : drop.target.id;
          const sourceId = drop.origin === 'side' ? drop.target.id : drop.node.id;
          void mutate({
            op: 'addSideRef',
            messageId: targetId,
            sourceMessageId: sourceId,
            side: drop.side,
            scope: drop.scope,
          });
        }
      } else if (drop.mode === 'reparent') {
        if (drop.valid && drop.target) {
          const [child, parent] = drop.end === 'in' ? [drop.node, drop.target] : [drop.target, drop.node];
          if (child.parentId !== parent.id) void mutate({ op: 'reparent', messageId: child.id, parentId: parent.id });
        } else if (!drop.overNode && drop.end === 'in' && drop.node.parentId && distance(point, drag.start) > 32) {
          void mutate({ op: 'reparent', messageId: drop.node.id, parentId: '' });
        }
      }
    }
  }

  function openMenu(client: Point, id?: string, trigger?: HTMLElement) {
    menuOrigin.current = trigger ?? stage.current;
    setMenu({ client, world: toWorld(origin(client.x, client.y), viewRef.current), id });
  }

  const renderEdge = (node: GraphNode) => {
    if (node.note) return null;
    const parent = byId.get(node.parentId);
    const active = activeIds.has(node.id) && (!parent || activeIds.has(parent.id));
    const endPt = port(node, 'in');
    const parentEnd = parent && port(parent, 'out');
    if (!parentEnd && !summary(node)) return null;
    const startPt = parentEnd ?? { x: endPt.x, y: endPt.y - 28 };
    const intoSummary = summary(node) && !effectiveExpandedIds.has(node.id) && children.has(node.id);
    return (
      <g key={node.id} className={active ? 'cg-edge cg-edge--active' : 'cg-edge'}>
        {!parentEnd && <circle cx={startPt.x} cy={startPt.y} r={3} />}
        <path d={moveTo(startPt) + curve(startPt, endPt)} markerEnd={intoSummary ? undefined : 'url(#' + marker + (active ? '-active' : '') + ')'} />
      </g>
    );
  };

  const renderedNoteEdges = useMemo(() => {
    const items: Array<{ id: string; d: string; mid: Point }> = [];
    for (const edge of noteEdges) {
      const from = byId.get(edge.sourceId);
      const to = byId.get(edge.targetId);
      if (!from || !to) continue;
      const fromPt = notePortPoint(from, edge.sourcePort);
      const toPt = notePortPoint(to, edge.targetPort);
      const geom = noteEdgeCurve(fromPt, edge.sourcePort, toPt, edge.targetPort);
      items.push({ id: edge.id, ...geom });
    }
    return items;
  }, [byId, noteEdges]);

  const renderedSideRefEdges = useMemo(() => {
    const items: Array<{
      key: string;
      targetId: string;
      sourceId: string;
      scope: MessageSideRefScope;
      d: string;
      mid: Point;
    }> = [];
    for (const node of display) {
      const refs = node.message?.graphMeta?.sideRefs;
      if (!refs?.length) continue;
      for (const ref of refs) {
        const src = byId.get(ref.sourceMessageId);
        if (!src) continue;
        const side = ref.side ?? 'left';
        const scope: MessageSideRefScope = ref.scope === 'node' ? 'node' : 'branch';
        const fromPt = scope === 'node' ? nodeSideOutPort(src) : port(src, 'out');
        const toPt = sidePort(node, side);
        const geom = sideRefCurve(fromPt, toPt, side);
        items.push({
          key: `${node.id}:${ref.sourceMessageId}`,
          targetId: node.id,
          sourceId: ref.sourceMessageId,
          scope,
          ...geom,
        });
      }
    }
    return items;
  }, [byId, display]);

  const marqueeBox = marquee ? normalizeRect(marquee.start, marquee.current) : null;

  const deleteSummary = useMemo(() => {
    if (!deletingNodes?.length) return { title: '', message: '' };
    if (deletingNodes.length === 1) {
      const single = deletingNodes[0];
      if (single.note) return { title: '删除标注', message: '将删除该文字标注及其视觉连线。' };
      return {
        title: single.branch ? '删除分支' : '删除消息',
        message: single.branch ? '将删除该空白分支。' : '将删除该消息并重接后续上下文。',
      };
    }
    const msgCount = deletingNodes.filter((n) => Boolean(n.message)).length;
    const branchCount = deletingNodes.filter((n) => Boolean(n.branch)).length;
    const noteCount = deletingNodes.filter((n) => Boolean(n.note)).length;
    const parts: string[] = [];
    if (msgCount > 0) parts.push(`${msgCount} 条消息`);
    if (branchCount > 0) parts.push(`${branchCount} 个空白分支`);
    if (noteCount > 0) parts.push(`${noteCount} 条标注`);
    return {
      title: `删除选中的 ${deletingNodes.length} 个节点`,
      message: `将删除 ${parts.join('、')}，存活节点的后续上下文将自动重接。`,
    };
  }, [deletingNodes]);

  const stageClasses = [
    'cg-stage',
    panning && 'cg-stage--panning',
    spacePressed && !panning && 'cg-stage--space-pan',
    selectMode && !spacePressed && !panning && 'cg-stage--selecting',
    (link || pickParent || pickSideRef) && 'cg-stage--linking',
  ].filter(Boolean).join(' ');

  const renderDraftLink = () => {
    if (!link) return null;
    if (link.mode === 'noteEdge') {
      const fromPt = notePortPoint(link.node, link.fromPort);
      const toPt = link.valid && link.target && link.toPort
        ? notePortPoint(link.target, link.toPort)
        : link.pointer;
      const toPort = link.toPort ?? (link.fromPort === 'left' ? 'right' : link.fromPort === 'right' ? 'left' : link.fromPort === 'top' ? 'bottom' : 'top');
      return <path className="cg-edge-draft cg-edge-draft--note" d={noteEdgeCurve(fromPt, link.fromPort, toPt, toPort).d} />;
    }
    if (link.mode === 'sideRef') {
      if (link.origin === 'side') {
        const toPt = sidePort(link.node, link.side);
        return <path className="cg-edge-draft cg-edge-draft--side" d={sideRefCurve(link.pointer, toPt, link.side).d} />;
      }
      const fromPt = link.origin === 'nodeOut' ? nodeSideOutPort(link.node) : port(link.node, 'out');
      const toPt = link.target ? sidePort(link.target, link.side) : link.pointer;
      const className = link.scope === 'node' ? 'cg-edge-draft cg-edge-draft--side-node' : 'cg-edge-draft cg-edge-draft--side';
      return <path className={className} d={sideRefCurve(fromPt, toPt, link.side).d} />;
    }
    return (
      <path
        className="cg-edge-draft"
        d={link.end === 'in'
          ? moveTo(link.pointer) + curve(link.pointer, port(link.node, 'in'))
          : moveTo(port(link.node, 'out')) + curve(port(link.node, 'out'), link.pointer)}
      />
    );
  };

  return (
    <div
      ref={stage}
      className={stageClasses}
      role="region"
      aria-label="对话图谱"
      aria-busy={busy || undefined}
      tabIndex={0}
      style={{ backgroundPosition: view.x + 'px ' + view.y + 'px' }}
      onPointerDown={(event) => {
        if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
          start(event, { kind: 'pan' });
          return;
        }
        if (event.target !== event.currentTarget) return;
        if (event.button === 0 && (selectMode || event.shiftKey)) {
          start(event, { kind: 'marquee', additive: event.shiftKey && effectiveSelectedIds.size > 0 });
        } else {
          start(event, { kind: 'pan' });
        }
      }}
      onPointerMove={move}
      onPointerUp={(event) => end(event)}
      onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={(event) => end(event, true)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const delta = ({ ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] } as Record<string, number[]>)[event.key];
        if (delta) { event.preventDefault(); setCamera({ ...view, x: view.x + delta[0], y: view.y + delta[1] }); }
        if (event.key === '+' || event.key === '=') changeZoom(1.2);
        if (event.key === '-') changeZoom(1 / 1.2);
        if (event.key === '0') fit(display);
      }}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('.cg-controls, .cg-selection-bar, [role="dialog"], [role="menu"]')) return;
        event.preventDefault();
        const target = (event.target as Element).closest<HTMLElement>('[data-graph-node]');
        const rect = target?.getBoundingClientRect();
        openMenu(
          event.clientX || event.clientY
            ? { x: event.clientX, y: event.clientY }
            : rect
              ? { x: rect.left + 16, y: rect.top + 16 }
              : { x: stage.current!.getBoundingClientRect().left + center().x, y: stage.current!.getBoundingClientRect().top + center().y },
          target?.dataset.graphNode,
          target?.querySelector('button') ?? undefined,
        );
      }}
    >
      <div className="cg-world" style={{ transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')' }}>
        <svg className="cg-edges" aria-hidden="true" width="1" height="1">
          <defs>
            {[
              ['', 'cg-marker'],
              ['-active', 'cg-marker cg-marker--active'],
              ['-sideref', 'cg-marker cg-marker--sideref'],
              ['-sideref-node', 'cg-marker cg-marker--sideref-node'],
            ].map(([suffix, className]) => (
              <marker key={suffix} id={marker + suffix} viewBox="0 0 7 8" refX="6.5" refY="4" markerWidth="7" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse">
                <path d="m0 0 7 4-7 4 1.4-4Z" className={className} />
              </marker>
            ))}
          </defs>
          {display.map(renderEdge)}
          {renderedNoteEdges.map((edge) => (
            <g key={'note-' + edge.id} className="cg-edge cg-edge--note" data-note-edge={edge.id}>
              <path d={edge.d} />
            </g>
          ))}
          {renderedSideRefEdges.map((edge) => (
            <g
              key={'side-' + edge.key}
              className={'cg-edge ' + (edge.scope === 'node' ? 'cg-edge--sideref-node' : 'cg-edge--sideref')}
              data-sideref-edge={edge.key}
              data-sideref-scope={edge.scope}
            >
              <path
                d={edge.d}
                markerEnd={'url(#' + marker + (edge.scope === 'node' ? '-sideref-node' : '-sideref') + ')'}
              />
            </g>
          ))}
          {renderDraftLink()}
        </svg>

        {renderedNoteEdges.map((edge) => (
          <button
            key={'detach-note-' + edge.id}
            type="button"
            className="cg-edge-detach"
            style={{ left: edge.mid.x, top: edge.mid.y }}
            aria-label="断开标注连线"
            title="断开标注连线"
            disabled={busy}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void mutate({ op: 'deleteNoteEdge', edgeId: edge.id })}
          >
            <Icon name="unlink" size={12} />
          </button>
        ))}

        {renderedSideRefEdges.map((edge) => (
          <button
            key={'detach-side-' + edge.key}
            type="button"
            className="cg-edge-detach"
            style={{ left: edge.mid.x, top: edge.mid.y }}
            aria-label={edge.scope === 'node' ? '断开单节点接入' : '断开侧边接入'}
            title={edge.scope === 'node' ? '断开单节点接入' : '断开侧边接入'}
            disabled={busy}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void mutate({ op: 'removeSideRef', messageId: edge.targetId, sourceMessageId: edge.sourceId })}
          >
            <Icon name="unlink" size={12} />
          </button>
        ))}

        {display.map((node) => {
          if (node.note) {
            if (editingNote?.id === node.id) {
              return (
                <GraphNoteEditor
                  key={node.id}
                  position={{ x: node.x, y: node.y }}
                  text={editingNote.text}
                  onChange={(text) => setEditingNote((cur) => cur && { ...cur, text })}
                  onCancel={() => setEditingNote(null)}
                  onCommit={(text) => {
                    setEditingNote(null);
                    if (text !== node.note!.text) {
                      void mutate({ op: 'updateNote', noteId: node.id, text });
                    }
                  }}
                />
              );
            }
            const selected = visualSelectedIds.has(node.id);
            const valid = link?.mode === 'noteEdge' && link.target?.id === node.id ? link.valid : undefined;
            const nodeClasses = [
              'cg-node',
              selected && 'cg-node--selected',
              valid !== undefined && (valid ? 'cg-node--valid' : 'cg-node--invalid'),
            ].filter(Boolean).join(' ');
            return (
              <div
                key={node.id}
                ref={(el) => bindDynamicRef(node.id, el)}
                data-graph-node={node.id}
                data-kind="note"
                data-selected={selected || undefined}
                className={nodeClasses}
                style={{ left: node.x, top: node.y }}
              >
                <button
                  type="button"
                  className="cg-note__body"
                  aria-selected={selected || undefined}
                  aria-disabled={busy || undefined}
                  onPointerDown={(event) => {
                    if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
                      start(event, { kind: 'pan' });
                      return;
                    }
                    if (event.pointerType !== 'touch') event.currentTarget.focus({ preventScroll: true });
                    start(event, { kind: 'move', node });
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) handleNodeSelect(node, event.ctrlKey || event.metaKey || event.shiftKey);
                  }}
                >
                  {node.note.text}
                </button>
                <div className="cg-node__actions">
                  <IconButton
                    icon="edit"
                    label="编辑标注"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEditingNote({ id: node.id, text: node.note!.text })}
                  />
                  <IconButton
                    icon="ellipsis"
                    label="节点操作"
                    size="sm"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      openMenu({ x: rect.right, y: rect.bottom }, node.id, event.currentTarget);
                    }}
                  />
                </div>
                {NOTE_PORTS.map((side) => (
                  <span
                    key={side}
                    aria-hidden="true"
                    data-port={'note-' + side}
                    className={'cg-port cg-port--note-' + side}
                    onPointerDown={(event) => { if (!busy) start(event, { kind: 'noteLink', node, fromPort: side }); }}
                  />
                ))}
              </div>
            );
          }

          const msg = node.message;
          const expanded = Boolean(msg && effectiveExpandedIds.has(node.id));
          const collapsed = !expanded && summary(node);
          const compact = msg?.role === 'compaction';
          const isUser = msg?.role === 'user';
          const sideEligible = isSideRefEligible(msg);
          const sideRefCount = msg?.graphMeta?.sideRefs?.length ?? 0;
          const nodeSideRefCount = msg?.graphMeta?.sideRefs?.filter((ref) => ref.scope === 'node').length ?? 0;
          const sideRefIcon = sideRefCount > 0 && nodeSideRefCount === sideRefCount ? 'nodeSideLink' : 'sideLink';
          const sideRefLabel = sideRefCount > 0 && nodeSideRefCount === sideRefCount
            ? `已接入 ${sideRefCount} 条参考节点`
            : `已接入 ${sideRefCount} 条参考分支`;
          const selected = visualSelectedIds.has(node.id);
          const title = node.branch?.label || (compact ? '上下文检查点' : isUser ? '用户' : msg?.modelId || '助手');
          const preview = msg ? extractNodePreview(msg) : '';
          const images = msg?.blocks.filter((block) => block.type === 'image').length ?? 0;
          const tools = msg?.blocks.filter((block) => block.type === 'toolCall').length ?? 0;
          const thinking = msg?.blocks.some((block) => block.type === 'thinking');
          const status = msg?.stopReason === 'aborted' ? '已停止' : msg?.stopReason === 'error' ? '生成失败' : '';
          const valid = link?.target?.id === node.id
            ? link.valid
            : pickParent
              ? canConnect(pickParent, node)
              : pickSideRef
                ? sideEligible && canSideAttach(node.id, pickSideRef.sourceId)
                : undefined;
          const time = msg && new Date(msg.createdAt);
          const compactionText = compact
            ? msg.blocks.filter((b): b is Extract<Message['blocks'][number], { type: 'compaction' | 'text' }> =>
                (b.type === 'compaction' || b.type === 'text') && typeof b.text === 'string').map((b) => b.text).join('\n\n')
            : '';

          const nodeClasses = [
            'cg-node',
            activeIds.has(node.id) && 'cg-node--path',
            activeId === node.id && 'cg-node--current',
            selected && 'cg-node--selected',
            expanded && 'cg-node--expanded',
            valid !== undefined && (valid ? 'cg-node--valid' : 'cg-node--invalid'),
          ].filter(Boolean).join(' ');

          return (
            <div
              key={node.id}
              ref={expanded ? (el) => bindDynamicRef(node.id, el) : undefined}
              data-graph-node={node.id}
              data-kind={collapsed ? 'summary' : node.branch ? 'branch' : compact ? 'checkpoint' : msg?.role}
              data-selected={selected || undefined}
              data-expanded={expanded || undefined}
              className={nodeClasses}
              style={{
                left: node.x,
                top: node.y,
                width: expanded ? undefined : node.width,
                height: expanded ? undefined : node.height,
              }}
            >
              {expanded && msg ? (
                <>
                  <div
                    className="cg-node__head"
                    onPointerDown={(event) => {
                      if ((event.target as Element).closest('button')) return;
                      if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
                        start(event, { kind: 'pan' });
                        return;
                      }
                      start(event, { kind: 'move', node });
                    }}
                  >
                    <span className="cg-node__header">
                      <Icon name={compact ? 'compress' : isUser ? 'user' : 'bot'} size={14} />
                      <strong>{title}</strong>
                      {sideRefCount > 0 && (
                        <span className="cg-node__sideref-badge" aria-label={sideRefLabel}>
                          <Icon name={sideRefIcon} size={12} />{sideRefCount}
                        </span>
                      )}
                      {time && !Number.isNaN(time.getTime()) && (
                        <time dateTime={msg.createdAt}>
                          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                        </time>
                      )}
                    </span>
                    <div className="cg-node__head-actions">
                      <IconButton icon="messageSquare" label="跳转至此消息" size="sm" disabled={busy} onClick={() => onJump(node.id)} />
                      <IconButton icon="compress" label="收起信息" size="sm" onClick={() => toggleExpandNode(node.id)} />
                      <IconButton
                        icon="ellipsis"
                        label="节点操作"
                        size="sm"
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          openMenu({ x: rect.right, y: rect.bottom }, node.id, event.currentTarget);
                        }}
                      />
                    </div>
                  </div>
                  <div
                    className="cg-node__detail"
                    onPointerDown={(event) => {
                      if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
                        start(event, { kind: 'pan' });
                        return;
                      }
                      event.stopPropagation();
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {settings.graphMarkdownRender ? (
                      compact ? (
                        <MarkdownDocument content={compactionText} collapsePrefix={'cg:' + msg.id} visualHtmlRender={false} />
                      ) : (
                        <ContentRenderer
                          messageId={msg.id}
                          collapsePrefix={'cg:' + msg.id}
                          blocks={msg.blocks}
                          stopReason={msg.stopReason}
                          isUser={msg.role === 'user'}
                          visualHtmlRender={msg.role === 'assistant' ? settings.graphVisualHtmlRender : false}
                        />
                      )
                    ) : (
                      <PlainMessageDetail message={msg} />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="cg-node__body"
                    aria-current={activeId === node.id || undefined}
                    aria-selected={selected || undefined}
                    aria-disabled={busy || undefined}
                    onPointerDown={(event) => {
                      if (event.button === 1 || (event.button === 0 && spacePressedRef.current)) {
                        start(event, { kind: 'pan' });
                        return;
                      }
                      if (event.pointerType !== 'touch') event.currentTarget.focus({ preventScroll: true });
                      start(event, { kind: 'move', node });
                    }}
                    onClick={(event) => {
                      if (event.detail === 0) handleNodeSelect(node, event.ctrlKey || event.metaKey || event.shiftKey);
                    }}
                  >
                    {collapsed && msg ? (
                      <>
                        <Icon name="user" size={13} />
                        <span>{extractUserSummary(msg)}</span>
                        {sideRefCount > 0 && (
                          <span className="cg-node__sideref-badge" aria-label={sideRefLabel}>
                            <Icon name={sideRefIcon} size={11} />{sideRefCount}
                          </span>
                        )}
                      </>
                    ) : compact ? (
                      <><Icon name="compress" size={15} /><span>{title}</span></>
                    ) : (
                      <>
                        <span className="cg-node__header">
                          <Icon name={node.branch ? 'branch' : isUser ? 'user' : 'bot'} size={14} />
                          <strong>{title}</strong>
                          {time && !Number.isNaN(time.getTime()) && (
                            <time dateTime={msg!.createdAt}>
                              {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                            </time>
                          )}
                        </span>
                        <span className="cg-node__preview">
                          {node.branch ? (node.parentId ? '话题内分支' : '独立上下文') : preview || (images ? '图片' : tools ? '工具调用' : status || '—')}
                        </span>
                        {(images > 0 || tools > 0 || thinking || status || sideRefCount > 0) && (
                          <span className="cg-node__meta">
                            {sideRefCount > 0 && (
                              <span className="cg-node__sideref-badge" aria-label={sideRefLabel}>
                                <Icon name={sideRefIcon} size={12} />{sideRefCount}
                              </span>
                            )}
                            {images > 0 && <span aria-label={images + ' 张图片'}><Icon name="image" size={13} />{images}</span>}
                            {thinking && <span aria-label="思考"><Icon name="brain" size={13} /></span>}
                            {tools > 0 && <span aria-label={tools + ' 次工具调用'}><Icon name="wrench" size={13} />{tools}</span>}
                            {status && <span className="cg-node__status" title={status} aria-label={status}><Icon name={msg?.stopReason === 'error' ? 'warning' : 'stop'} size={13} /></span>}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                  <div className="cg-node__actions">
                    {collapsed && msg ? (
                      <>
                        <IconButton
                          icon="edit"
                          label="编辑摘要"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing({ id: node.id, text: msg.graphMeta?.summary ?? '' })}
                        />
                        <IconButton
                          icon="expand"
                          label="展开为完整节点"
                          size="sm"
                          disabled={busy}
                          onClick={() => void mutate({ op: 'setNodeMeta', messageId: node.id, graphMeta: { collapsed: false } })}
                        />
                      </>
                    ) : (
                      <>
                        {msg && <IconButton icon="expand" label="展开信息" size="sm" onClick={() => toggleExpandNode(node.id)} />}
                        {msg && <IconButton icon="messageSquare" label="跳转至此消息" size="sm" disabled={busy} onClick={() => onJump(node.id)} />}
                        {isLeaf(node) && <IconButton icon="arrowUp" label="在此分支继续" size="sm" disabled={busy} onClick={() => activate(node)} />}
                      </>
                    )}
                    <IconButton
                      icon="ellipsis"
                      label="节点操作"
                      size="sm"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        openMenu({ x: rect.right, y: rect.bottom }, node.id, event.currentTarget);
                      }}
                    />
                  </div>
                </>
              )}

              {msg && (['in', 'out'] as const).map((side) => (
                <span
                  key={side}
                  aria-hidden="true"
                  data-port={side}
                  className={'cg-port cg-port--' + side}
                  onPointerDown={(event) => { if (!busy) start(event, { kind: 'link', node, end: side }); }}
                />
              ))}

              {sideEligible && (
                <span
                  aria-hidden="true"
                  data-port="node-side-out"
                  title="单节点侧链"
                  className={'cg-port cg-port--node-side-out' + (link?.mode === 'sideRef' && link.origin === 'nodeOut' && link.node.id === node.id ? ' cg-port--side-hot' : '')}
                  onPointerDown={(event) => { if (!busy) start(event, { kind: 'nodeSideLink', node }); }}
                />
              )}

              {sideEligible && (['left', 'right'] as const).map((side) => {
                const isHot = link?.mode === 'sideRef' && link.target?.id === node.id && link.side === side;
                return (
                  <span
                    key={'side-' + side}
                    aria-hidden="true"
                    data-port={'side-' + side}
                    className={'cg-port cg-port--side-' + side + (isHot ? ' cg-port--side-hot' : '')}
                    onPointerDown={(event) => { if (!busy) start(event, { kind: 'sideLink', node, side }); }}
                  />
                );
              })}
            </div>
          );
        })}

        {draftNote && (
          <GraphNoteEditor
            position={{ x: draftNote.x, y: draftNote.y }}
            text={draftNote.text}
            onChange={(text) => setDraftNote((cur) => cur && { ...cur, text })}
            onCancel={() => setDraftNote(null)}
            onCommit={(text) => {
              const { x, y } = draftNote;
              setDraftNote(null);
              void mutate({ op: 'createNote', text, x, y });
            }}
          />
        )}
      </div>

      {marqueeBox && (
        <div
          className="cg-marquee"
          aria-hidden="true"
          style={{
            left: marqueeBox.left,
            top: marqueeBox.top,
            width: Math.max(0, marqueeBox.right - marqueeBox.left),
            height: Math.max(0, marqueeBox.bottom - marqueeBox.top),
          }}
        />
      )}

      <GraphFloatingBatchBar
        selectedCount={effectiveSelectedIds.size}
        hasSelectedMessages={selectedMessages.length > 0}
        hasUnexpandedSelected={hasUnexpandedSelected}
        canExpandSubtree={selectedSubtree.size > effectiveSelectedIds.size}
        hasDisconnectable={disconnectableSelectedIds.length > 0}
        busy={busy}
        onToggleExpandSelected={() => toggleExpandTargets(selectedMessages)}
        onSelectSubtree={() => setSelectedIds(selectedSubtree)}
        onDisconnectSelected={() => disconnectIds(disconnectableSelectedIds)}
        onDeleteSelected={() => setDeletingNodes(selectedNodes)}
        onClearSelection={() => setSelectedIds(new Set())}
      />

      {!nodes.length && !draftNote && <div className="cg-empty"><Icon name="mindMap" size={30} /><span>暂无节点</span></div>}

      <GraphBottomControls
        selectMode={selectMode}
        scale={view.scale}
        minZoom={minZoom}
        maxZoom={maxZoom}
        allUsersCollapsed={allUsersCollapsed}
        allAssistantsExpanded={allAssistantsExpanded}
        hasUserMessages={userMessages.length > 0}
        hasAssistantMessages={assistantMessages.length > 0}
        hasNodes={nodes.length > 0}
        busy={busy}
        onToggleSelectMode={() => setSelectMode((value) => !value)}
        onZoomOut={() => changeZoom(1 / 1.2)}
        onFit={() => fit(display)}
        onZoomIn={() => changeZoom(1.2)}
        onToggleAllUsersSummary={toggleAllUsersSummary}
        onToggleAllAssistantsExpand={toggleAllAssistantsExpand}
        onAutoLayout={() => void layout()}
        onCreateNote={() => startDraftNote(toWorld(center(), viewRef.current))}
        onCreateBranch={() => makeBranch(toWorld(center(), viewRef.current))}
        onCreateUserMessage={() => {
          const world = toWorld(center(), viewRef.current);
          openCreateMessage('user', { x: world.x - 124, y: world.y - 48 });
        }}
        onCreateAssistantMessage={() => {
          const world = toWorld(center(), viewRef.current);
          openCreateMessage('assistant', { x: world.x - 124, y: world.y - 48 });
        }}
      />

      <GraphContextMenu
        menu={menu}
        menuNode={menuNode}
        isBatchMenu={isBatchMenu}
        busy={busy}
        nodes={nodes}
        display={display}
        messagesCount={messages.length}
        userMessagesCount={userMessages.length}
        assistantMessagesCount={assistantMessages.length}
        validMessageIds={validMessageIds}
        allUsersCollapsed={allUsersCollapsed}
        allAssistantsExpanded={allAssistantsExpanded}
        allMessagesExpanded={allMessagesExpanded}
        effectiveSelectedIds={effectiveSelectedIds}
        effectiveExpandedIds={effectiveExpandedIds}
        selectedNodes={selectedNodes}
        selectedMessages={selectedMessages}
        selectedUserMessages={selectedUserMessages}
        selectedSubtree={selectedSubtree}
        hasUnexpandedSelected={hasUnexpandedSelected}
        disconnectableSelectedIds={disconnectableSelectedIds}
        noteEdges={noteEdges}
        isLeaf={isLeaf}
        onClose={() => setMenu(null)}
        onRestoreFocus={() => menuOrigin.current?.focus({ preventScroll: true })}
        onMakeBranch={makeBranch}
        onStartDraftNote={startDraftNote}
        onToggleAllUsersSummary={toggleAllUsersSummary}
        onToggleAllAssistantsExpand={toggleAllAssistantsExpand}
        onPersistExpanded={persistExpanded}
        onAutoLayout={() => void layout()}
        onFit={() => fit(display)}
        onToggleExpandTargets={toggleExpandTargets}
        onSetSelectedIds={setSelectedIds}
        onDisconnectIds={disconnectIds}
        onSetDeletingNodes={setDeletingNodes}
        onSetEditingNote={setEditingNote}
        onToggleExpandNode={toggleExpandNode}
        onSetEditingSummary={setEditing}
        onActivateNode={activate}
        onJump={onJump}
        onPickParent={setPickParent}
        onPickSideRef={setPickSideRef}
        onCreateMessage={openCreateMessage}
        onEditMessageContent={(message) => {
          setMenu(null);
          setEditingMsgContent({ message, text: message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => 'text' in block ? block.text : '')
            .join('\n')
            .trim() });
        }}
        mutate={mutate}
      />

      <Modal
        open={!!editing}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        title="编辑摘要"
        busy={submitting}
        footer={<Button type="submit" form={summaryForm} loading={submitting}>保存</Button>}
      >
        <form
          id={summaryForm}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!editing || submitting) return;
            setSubmitting(true);
            const result = await mutate({ op: 'setNodeMeta', messageId: editing.id, graphMeta: { summary: editing.text.trim() } });
            setSubmitting(false);
            if (result) setEditing(null);
          }}
        >
          <input
            className="ui-input"
            aria-label="摘要"
            autoFocus
            maxLength={160}
            value={editing?.text ?? ''}
            onChange={(event) => setEditing((value) => value && { ...value, text: event.target.value })}
          />
        </form>
      </Modal>

      <Modal
        open={!!creatingMsg}
        onOpenChange={(open) => { if (!open && !submitting) setCreatingMsg(null); }}
        title={creatingMsg?.role === 'assistant' ? '新建助手消息' : '新建用户消息'}
        busy={submitting}
        footer={
          <>
            <Button variant="ghost" disabled={submitting} onClick={() => setCreatingMsg(null)}>取消</Button>
            <Button
              type="submit"
              form={createMsgForm}
              variant="primary"
              loading={submitting}
              disabled={!creatingMsg?.text.trim()}
            >
              创建
            </Button>
          </>
        }
      >
        <form
          id={createMsgForm}
          className="cg-msg-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreatingMessage();
          }}
        >
          <SegmentedControl<'user' | 'assistant'>
            value={creatingMsg?.role ?? 'user'}
            ariaLabel="消息角色"
            disabled={submitting}
            options={[{ value: 'user', label: '用户' }, { value: 'assistant', label: '助手' }]}
            onChange={(role) => setCreatingMsg((value) => value && { ...value, role })}
          />
          <Textarea
            aria-label="消息内容"
            rows={6}
            autoFocus
            maxLength={200000}
            value={creatingMsg?.text ?? ''}
            disabled={submitting}
            onChange={(event) => setCreatingMsg((value) => value && { ...value, text: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitCreatingMessage();
              }
            }}
          />
        </form>
      </Modal>

      <Modal
        open={!!editingMsgContent}
        onOpenChange={(open) => { if (!open && !submitting) setEditingMsgContent(null); }}
        title="编辑消息内容"
        busy={submitting}
        footer={
          <>
            <Button variant="ghost" disabled={submitting} onClick={() => setEditingMsgContent(null)}>取消</Button>
            <Button
              type="submit"
              form={editMsgForm}
              variant="primary"
              loading={submitting}
              disabled={!editingMsgContent || (!editingMsgContent.text.trim() &&
                !editingMsgContent.message.blocks.some((block) => block.type !== 'text'))}
            >
              保存
            </Button>
          </>
        }
      >
        <form
          id={editMsgForm}
          className="cg-msg-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitEditedMessage();
          }}
        >
          <Textarea
            aria-label="编辑消息内容"
            rows={6}
            autoFocus
            value={editingMsgContent?.text ?? ''}
            disabled={submitting}
            onChange={(event) => setEditingMsgContent((value) => value && { ...value, text: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitEditedMessage();
              }
            }}
          />
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deletingNodes?.length}
        onOpenChange={(open) => { if (!open) setDeletingNodes(null); }}
        title={deleteSummary.title}
        message={deleteSummary.message}
        confirmLabel="删除"
        danger
        busy={submitting}
        onConfirm={async () => {
          if (!deletingNodes?.length || submitting) return;
          setSubmitting(true);
          const messageIds = deletingNodes.filter((n) => Boolean(n.message)).map((n) => n.id);
          const branchIds = deletingNodes.filter((n) => Boolean(n.branch)).map((n) => n.id);
          const noteIds = deletingNodes.filter((n) => Boolean(n.note)).map((n) => n.id);
          const deletedSet = new Set(deletingNodes.map((n) => n.id));
          const result = await mutate({ op: 'deleteNodes', messageIds, branchIds, noteIds });
          setSubmitting(false);
          if (result) {
            setDeletingNodes(null);
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of deletedSet) next.delete(id);
              return next;
            });
            setOptimisticExpanded((prev) => {
              const next = new Map(prev);
              for (const id of deletedSet) next.delete(id);
              return next;
            });
          }
        }}
      />
    </div>
  );
}
