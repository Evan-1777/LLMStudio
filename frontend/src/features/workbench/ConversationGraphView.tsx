import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
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
import { Button, ConfirmDialog, DropdownItem, DropdownSeparator, Icon, IconButton, Modal } from '../../components/ui';
import type { Conversation, ConversationDetail, GraphMutationInput, Message } from '../../core/types';
import { ContentRenderer, MarkdownDocument, imageBlockSource } from '../../rendering/ContentRenderer';
import {
  collectSubtreeIds,
  computeAutoLayout,
  extractNodePreview,
  extractUserSummary,
  normalizeRect,
  rectIntersectsNode,
  wouldCreateCycle,
  type GraphNode,
  type Point,
} from './conversationGraph';
import './conversation-graph.css';

type View = Point & { scale: number };
type NodeSize = { width: number; height: number };
type DragOrigin = { node: GraphNode; x: number; y: number };
type Gesture =
  | { kind: 'pan'; id: number; start: Point; view: View; moved: boolean; button: number; modifiers: boolean }
  | { kind: 'marquee'; id: number; start: Point; additive: boolean; baseIds: Set<string>; moved: boolean }
  | { kind: 'move'; id: number; start: Point; node: GraphNode; origins: DragOrigin[]; modifiers: boolean; moved: boolean }
  | { kind: 'link'; id: number; start: Point; node: GraphNode; end: 'in' | 'out'; moved: boolean }
  | { kind: 'pinch'; start: Point; distance: number; view: View };
type MarqueeState = { start: Point; current: Point; additive: boolean; baseIds: Set<string> };
type LinkDrag = { node: GraphNode; end: 'in' | 'out'; pointer: Point; target?: GraphNode; valid: boolean; overNode: boolean };

const initialView: View = { x: 0, y: 0, scale: 1 };
const minZoom = 0.35;
const maxZoom = 1.8;
const defaultExpandedSize: NodeSize = { width: 420, height: 220 };
const clampZoom = (scale: number) => Math.min(maxZoom, Math.max(minZoom, scale));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const port = (node: GraphNode, end: 'in' | 'out') => ({ x: node.x + node.width / 2, y: node.y + (end === 'out' ? node.height : 0) });
const summary = (node: GraphNode) => node.message?.role === 'user' && node.message.graphMeta?.collapsed;
const zoomAt = (view: View, from: Point, to: Point, scale: number): View => ({
  scale, x: to.x - (from.x - view.x) * scale / view.scale, y: to.y - (from.y - view.y) * scale / view.scale,
});
const toWorld = (point: Point, view: View): Point => ({ x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale });
function curve(from: Point, to: Point) {
  const bend = Math.max(24, Math.min(112, Math.abs(to.y - from.y) * 0.48));
  return 'C ' + from.x + ' ' + (from.y + bend) + ', ' + to.x + ' ' + (to.y - bend) + ', ' + to.x + ' ' + to.y;
}
const moveTo = ({ x, y }: Point) => 'M ' + x + ' ' + y + ' ';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function PlainMessageDetail({ message }: { message: Message }) {
  const texts = message.blocks
    .filter((b): b is Extract<Message['blocks'][number], { type: 'text' | 'compaction' }> =>
      (b.type === 'text' || b.type === 'compaction') && typeof b.text === 'string' && b.text.length > 0)
    .map((b) => b.text);
  const images = message.blocks.filter(
    (b): b is Extract<Message['blocks'][number], { type: 'image' }> => b.type === 'image',
  );
  const thinkingCount = message.blocks.filter((b) => b.type === 'thinking').length;
  const toolCount = message.blocks.filter((b) => b.type === 'toolCall').length;
  const searchCount = message.blocks.filter((b) => b.type === 'webSearch').length;
  const hasTags = thinkingCount > 0 || toolCount > 0 || searchCount > 0 || Boolean(message.errorMessage);

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
            return src ? <img key={i} src={src} alt="" className="cg-node__plain-img" loading="lazy" /> : null;
          })}
        </div>
      )}
      {hasTags && (
        <div className="cg-node__plain-tags">
          {thinkingCount > 0 && <span><Icon name="brain" size={12} />思考 ×{thinkingCount}</span>}
          {toolCount > 0 && <span><Icon name="wrench" size={12} />工具 ×{toolCount}</span>}
          {searchCount > 0 && <span><Icon name="globe" size={12} />检索 ×{searchCount}</span>}
          {message.errorMessage && <span className="cg-node__plain-tag--error"><Icon name="warning" size={12} />{message.errorMessage}</span>}
        </div>
      )}
    </div>
  );
}

export function ConversationGraphView({ conversation, messages, activeMessages, busy, mutate, onJump, onActivate }: {
  conversation: Conversation;
  messages: Message[];
  activeMessages: Message[];
  busy: boolean;
  mutate: (input: GraphMutationInput) => Promise<ConversationDetail | null>;
  onJump: (messageId: string) => void;
  onActivate: (branch: { leafMessageId: string } | { branchId: string }) => void;
  onDelete?: (message: Message) => Promise<boolean>;
}) {
  const { settings } = useApp();
  const stage = useRef<HTMLDivElement>(null);
  const marker = useId();
  const summaryForm = useId();
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Point>());
  const viewRef = useRef(initialView);
  const spacePressedRef = useRef(false);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  const expandedElements = useRef(new Map<string, HTMLDivElement>());
  const resizeObserver = useRef<ResizeObserver | null>(null);

  const [view, setView] = useState(initialView);
  const [panning, setPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [moving, setMoving] = useState<ReadonlyMap<string, Point> | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [measuredSizes, setMeasuredSizes] = useState<ReadonlyMap<string, NodeSize>>(() => new Map());
  const [link, setLink] = useState<LinkDrag | null>(null);
  const [pickParent, setPickParent] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id?: string; client: Point; world: Point } | null>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deletingNodes, setDeletingNodes] = useState<GraphNode[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nodes = useMemo(() => computeAutoLayout(conversation, messages), [conversation, messages]);
  const validNodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const validMessageIds = useMemo(
    () => new Set(nodes.filter((node) => Boolean(node.message)).map((node) => node.id)),
    [nodes],
  );
  const effectiveSelectedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedIds) if (validNodeIds.has(id)) next.add(id);
    return next;
  }, [selectedIds, validNodeIds]);
  const effectiveExpandedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of expandedIds) if (validMessageIds.has(id)) next.add(id);
    return next;
  }, [expandedIds, validMessageIds]);

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
    }
    const offset = moving?.get(node.id);
    return offset ? { ...next, x: offset.x, y: offset.y } : next;
  }), [nodes, effectiveExpandedIds, measuredSizes, moving]);

  const byId = useMemo(() => new Map(display.map((node) => [node.id, node])), [display]);
  const children = useMemo(() => {
    const result = new Map<string, GraphNode[]>();
    for (const node of display) {
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
  const allMessagesExpanded = useMemo(
    () => validMessageIds.size > 0 && Array.from(validMessageIds).every((id) => effectiveExpandedIds.has(id)),
    [validMessageIds, effectiveExpandedIds],
  );

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

  useLayoutEffect(() => { fit(nodes, true); }, []); // A topic change remounts the viewport; graph edits preserve the camera.

  // Observe expanded card unscaled world dimensions so SVG edges & ports stay aligned.
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
    for (const el of expandedElements.current.values()) {
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
        if (!effectiveExpandedIds.has(id)) { changed = true; break; }
      }
      if (!changed) return prev;
      const next = new Map<string, NodeSize>();
      for (const [id, size] of prev) {
        if (effectiveExpandedIds.has(id)) next.set(id, size);
      }
      return next;
    });
  }, [effectiveExpandedIds]);

  const bindExpandedRef = useCallback((id: string, el: HTMLDivElement | null) => {
    const prev = expandedElements.current.get(id);
    if (prev && prev !== el) {
      resizeObserver.current?.unobserve(prev);
      expandedElements.current.delete(id);
    }
    if (el) {
      expandedElements.current.set(id, el);
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
      if (menu || editing || deletingNodes) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (isEditableElement(event.target) || isEditableElement(document.activeElement)) return;

      if (event.key === 'Escape') {
        if (pickParent) {
          event.preventDefault();
          event.stopPropagation();
          setPickParent(null);
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
  }, [busy, deletingNodes, display, editing, effectiveSelectedIds, menu, nodes, pickParent, selectMode]);

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

  const layout = async () => {
    const sizeOverrides = new Map<string, NodeSize>();
    for (const id of effectiveExpandedIds) {
      sizeOverrides.set(id, measuredSizes.get(id) ?? defaultExpandedSize);
    }
    const arranged = computeAutoLayout(conversation, messages, false, sizeOverrides.size ? sizeOverrides : undefined);
    if (!arranged.length) return;
    const result = await mutate({
      op: 'setNodeMeta',
      positions: arranged.map(({ id, branch, x, y }) => ({ ...(branch ? { branchId: id } : { messageId: id }), x, y })),
    });
    if (result) fit(arranged);
  };

  const isLeaf = (node: GraphNode) => !children.has(node.id);
  const activate = (node: GraphNode) => onActivate(node.branch ? { branchId: node.id } : { leafMessageId: node.id });
  const canConnect = (child: string, parent: GraphNode) => Boolean(parent.message) && !wouldCreateCycle(byId, child, parent.id);

  const toggleExpandNode = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpandTargets = (targets: GraphNode[]) => {
    const msgIds = targets.filter((n) => Boolean(n.message)).map((n) => n.id);
    if (!msgIds.length) return;
    const shouldExpand = msgIds.some((id) => !effectiveExpandedIds.has(id));
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const id of msgIds) {
        if (shouldExpand) next.add(id);
        else next.delete(id);
      }
      return next;
    });
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
      | { kind: 'pan' }
      | { kind: 'marquee'; additive: boolean },
  ) {
    if (menu || editing || deletingNodes) return;
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
    } else {
      gesture.current = { kind: 'link', id: event.pointerId, start: point, node: spec.node, end: spec.end, moved: false };
    }
  }

  function linkAt(event: PointerEvent, drag: Extract<Gesture, { kind: 'link' }>): LinkDrag {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-graph-node]');
    const target = el?.dataset.graphNode ? byId.get(el.dataset.graphNode) : undefined;
    const valid = !!target && (drag.end === 'in'
      ? canConnect(drag.node.id, target)
      : !!target.message && canConnect(target.id, drag.node));
    return {
      node: drag.node, end: drag.end, target, valid, overNode: !!target,
      pointer: toWorld(origin(event.clientX, event.clientY), viewRef.current),
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
    } else if (!busy && !pickParent) {
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
        const isDouble = !drag.modifiers && !pickParent && lastClickRef.current?.id === drag.node.id && now - lastClickRef.current.time < 360;
        if (isDouble) {
          lastClickRef.current = null;
          if (drag.node.branch) activate(drag.node);
          else if (drag.node.message) toggleExpandNode(drag.node.id);
        } else {
          lastClickRef.current = drag.modifiers || pickParent ? null : { id: drag.node.id, time: now };
          handleNodeSelect(drag.node, drag.modifiers);
        }
      } else if (!pickParent) {
        lastClickRef.current = null;
        const wdx = (point.x - drag.start.x) / viewRef.current.scale;
        const wdy = (point.y - drag.start.y) / viewRef.current.scale;
        const next = new Map<string, Point>();
        const positions = drag.origins.map((item) => {
          const x = Math.round(item.x + wdx);
          const y = Math.round(item.y + wdy);
          next.set(item.node.id, { x, y });
          return { ...(item.node.branch ? { branchId: item.node.id } : { messageId: item.node.id }), x, y };
        });
        setMoving(next);
        void mutate({ op: 'setNodeMeta', positions }).finally(() => setMoving(null));
      }
    } else if (drag.kind === 'link' && moved) {
      const drop = linkAt(event, drag);
      if (drop.valid && drop.target) {
        const [child, parent] = drag.end === 'in' ? [drag.node, drop.target] : [drop.target, drag.node];
        if (child.parentId !== parent.id) void mutate({ op: 'reparent', messageId: child.id, parentId: parent.id });
      } else if (!drop.overNode && drag.end === 'in' && drag.node.parentId && distance(point, drag.start) > 32) {
        void mutate({ op: 'reparent', messageId: drag.node.id, parentId: '' });
      }
    }
  }

  function openMenu(client: Point, id?: string, trigger?: HTMLElement) {
    menuOrigin.current = trigger ?? stage.current;
    setMenu({ client, world: toWorld(origin(client.x, client.y), viewRef.current), id });
  }

  const renderEdge = (node: GraphNode) => {
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

  const marqueeBox = marquee ? normalizeRect(marquee.start, marquee.current) : null;

  const deleteSummary = useMemo(() => {
    if (!deletingNodes?.length) return { title: '', message: '' };
    if (deletingNodes.length === 1) {
      const single = deletingNodes[0];
      return {
        title: single.branch ? '删除分支' : '删除消息',
        message: single.branch ? '将删除该空白分支。' : '将删除该消息并重接后续上下文。',
      };
    }
    const msgCount = deletingNodes.filter((n) => Boolean(n.message)).length;
    const branchCount = deletingNodes.length - msgCount;
    const parts: string[] = [];
    if (msgCount > 0) parts.push(`${msgCount} 条消息`);
    if (branchCount > 0) parts.push(`${branchCount} 个空白分支`);
    return {
      title: `删除选中的 ${deletingNodes.length} 个节点`,
      message: `将删除 ${parts.join('与 ')}，存活节点的后续上下文将自动重接。`,
    };
  }, [deletingNodes]);

  const stageClasses = [
    'cg-stage',
    panning && 'cg-stage--panning',
    spacePressed && !panning && 'cg-stage--space-pan',
    selectMode && !spacePressed && !panning && 'cg-stage--selecting',
    (link || pickParent) && 'cg-stage--linking',
  ].filter(Boolean).join(' ');

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
            {['', '-active'].map((suffix) => (
              <marker key={suffix} id={marker + suffix} viewBox="0 0 7 8" refX="6.5" refY="4" markerWidth="7" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse">
                <path d="m0 0 7 4-7 4 1.4-4Z" className={suffix ? 'cg-marker cg-marker--active' : 'cg-marker'} />
              </marker>
            ))}
          </defs>
          {display.map(renderEdge)}
          {link && (
            <path
              className="cg-edge-draft"
              d={link.end === 'in'
                ? moveTo(link.pointer) + curve(link.pointer, port(link.node, 'in'))
                : moveTo(port(link.node, 'out')) + curve(port(link.node, 'out'), link.pointer)}
            />
          )}
        </svg>

        {display.map((node) => {
          const msg = node.message;
          const expanded = Boolean(msg && effectiveExpandedIds.has(node.id));
          const collapsed = !expanded && summary(node);
          const compact = msg?.role === 'compaction';
          const isUser = msg?.role === 'user';
          const selected = visualSelectedIds.has(node.id);
          const title = node.branch?.label || (compact ? '上下文检查点' : isUser ? '用户' : msg?.modelId || '助手');
          const preview = msg ? extractNodePreview(msg) : '';
          const images = msg?.blocks.filter((block) => block.type === 'image').length ?? 0;
          const tools = msg?.blocks.filter((block) => block.type === 'toolCall').length ?? 0;
          const thinking = msg?.blocks.some((block) => block.type === 'thinking');
          const status = msg?.stopReason === 'aborted' ? '已停止' : msg?.stopReason === 'error' ? '生成失败' : '';
          const valid = link?.target?.id === node.id ? link.valid : pickParent ? canConnect(pickParent, node) : undefined;
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
              ref={expanded ? (el) => bindExpandedRef(node.id, el) : undefined}
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
                          isUser={false}
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
                      <><Icon name="user" size={13} /><span>{extractUserSummary(msg)}</span></>
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
                        {(images > 0 || tools > 0 || thinking || status) && (
                          <span className="cg-node__meta">
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
                    {msg && <IconButton icon="expand" label="展开信息" size="sm" onClick={() => toggleExpandNode(node.id)} />}
                    {msg && <IconButton icon="messageSquare" label="跳转至此消息" size="sm" disabled={busy} onClick={() => onJump(node.id)} />}
                    {isLeaf(node) && <IconButton icon="arrowUp" label="在此分支继续" size="sm" disabled={busy} onClick={() => activate(node)} />}
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
            </div>
          );
        })}
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

      {effectiveSelectedIds.size > 0 && (
        <div
          className="cg-selection-bar"
          role="toolbar"
          aria-label="批量操作"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="cg-selection-bar__count">已选 {effectiveSelectedIds.size} 项</span>
          <span className="cg-controls__divider" aria-hidden="true" />
          {selectedMessages.length > 0 && (
            <IconButton
              icon={hasUnexpandedSelected ? 'expand' : 'compress'}
              label={hasUnexpandedSelected ? '展开信息' : '收起信息'}
              size="sm"
              onClick={() => toggleExpandTargets(selectedMessages)}
            />
          )}
          {selectedSubtree.size > effectiveSelectedIds.size && (
            <IconButton
              icon="mindMap"
              label="选中子树"
              size="sm"
              onClick={() => setSelectedIds(selectedSubtree)}
            />
          )}
          {disconnectableSelectedIds.length > 0 && (
            <IconButton
              icon="unlink"
              label="断开上下文"
              size="sm"
              disabled={busy}
              onClick={() => disconnectIds(disconnectableSelectedIds)}
            />
          )}
          <IconButton
            icon="trash"
            tone="danger"
            label="删除所选"
            size="sm"
            disabled={busy}
            onClick={() => setDeletingNodes(selectedNodes)}
          />
          <span className="cg-controls__divider" aria-hidden="true" />
          <IconButton
            icon="close"
            label="取消选择"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          />
        </div>
      )}

      {!nodes.length && <div className="cg-empty"><Icon name="mindMap" size={30} /><span>暂无节点</span></div>}

      <div className="cg-controls" role="group" aria-label="图谱控制">
        <IconButton
          icon="boxSelect"
          label="框选模式"
          size="sm"
          active={selectMode}
          aria-pressed={selectMode}
          onClick={() => setSelectMode((value) => !value)}
        />
        <span className="cg-controls__divider" aria-hidden="true" />
        <IconButton icon="zoomOut" label="缩小" size="sm" disabled={view.scale <= minZoom} onClick={() => changeZoom(1 / 1.2)} />
        <button type="button" className="cg-controls__fit" title="适配画布" aria-label="适配画布" onClick={() => fit(display)}>
          <Icon name="fitView" size={15} /><span>{Math.round(view.scale * 100)}%</span>
        </button>
        <IconButton icon="zoomIn" label="放大" size="sm" disabled={view.scale >= maxZoom} onClick={() => changeZoom(1.2)} />
        <span className="cg-controls__divider" aria-hidden="true" />
        <IconButton icon="autoLayout" label="自动整理布局" size="sm" disabled={busy || !nodes.length} onClick={() => void layout()} />
        <IconButton icon="plus" label="新建空白分支" size="sm" disabled={busy} onClick={() => makeBranch(toWorld(center(), viewRef.current))} />
      </div>

      <DropdownMenu.Root modal={false} open={!!menu} onOpenChange={(open) => { if (!open) setMenu(null); }}>
        <DropdownMenu.Trigger asChild>
          <span className="cg-menu-anchor" style={{ left: menu?.client.x, top: menu?.client.y }} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="ui-menu-content cg-menu"
            align="start"
            collisionPadding={12}
            sideOffset={3}
            onCloseAutoFocus={(event) => { event.preventDefault(); menuOrigin.current?.focus({ preventScroll: true }); }}
          >
            {!menuNode ? (
              <>
                <DropdownItem disabled={busy} onSelect={() => menu && makeBranch(menu.world)}>
                  <Icon name="plus" size={15} />新建空白分支
                </DropdownItem>
                {validMessageIds.size > 0 && (
                  <DropdownItem onSelect={() => {
                    setExpandedIds(allMessagesExpanded ? new Set() : new Set(validMessageIds));
                  }}>
                    <Icon name={allMessagesExpanded ? 'compress' : 'expand'} size={15} />
                    {allMessagesExpanded ? '全部收起信息' : '全部展开信息'}
                  </DropdownItem>
                )}
                <DropdownItem disabled={busy || !nodes.length} onSelect={() => void layout()}>
                  <Icon name="autoLayout" size={15} />自动整理布局
                </DropdownItem>
                <DropdownItem onSelect={() => fit(display)}>
                  <Icon name="fitView" size={15} />适配画布
                </DropdownItem>
              </>
            ) : isBatchMenu ? (
              <>
                {selectedMessages.length > 0 && (
                  <DropdownItem onSelect={() => toggleExpandTargets(selectedMessages)}>
                    <Icon name={hasUnexpandedSelected ? 'expand' : 'compress'} size={15} />
                    {hasUnexpandedSelected ? '展开所选信息' : '收起所选信息'}
                  </DropdownItem>
                )}
                {selectedSubtree.size > effectiveSelectedIds.size && (
                  <DropdownItem onSelect={() => setSelectedIds(selectedSubtree)}>
                    <Icon name="mindMap" size={15} />选中子树
                  </DropdownItem>
                )}
                {selectedUserMessages.length > 0 && (() => {
                  const hasUncollapsed = selectedUserMessages.some((n) => !summary(n));
                  return (
                    <DropdownItem
                      disabled={busy}
                      onSelect={() => void mutate({
                        op: 'setNodeMeta',
                        messageIds: selectedUserMessages.map((n) => n.id),
                        graphMeta: { collapsed: hasUncollapsed },
                      })}
                    >
                      <Icon name={hasUncollapsed ? 'compress' : 'expand'} size={15} />
                      {hasUncollapsed ? '缩略所选用户节点' : '恢复所选完整节点'}
                    </DropdownItem>
                  );
                })()}
                {disconnectableSelectedIds.length > 0 && (
                  <DropdownItem disabled={busy} onSelect={() => disconnectIds(disconnectableSelectedIds)}>
                    <Icon name="unlink" size={15} />断开所选上下文
                  </DropdownItem>
                )}
                <DropdownSeparator />
                <DropdownItem danger disabled={busy} onSelect={() => requestAnimationFrame(() => setDeletingNodes(selectedNodes))}>
                  <Icon name="trash" size={15} />删除所选 {selectedNodes.length} 个节点
                </DropdownItem>
              </>
            ) : (
              <>
                {menuNode.message && (
                  <DropdownItem onSelect={() => toggleExpandNode(menuNode.id)}>
                    <Icon name={effectiveExpandedIds.has(menuNode.id) ? 'compress' : 'expand'} size={15} />
                    {effectiveExpandedIds.has(menuNode.id) ? '收起信息' : '展开信息'}
                  </DropdownItem>
                )}
                {collectSubtreeIds(display, [menuNode.id]).size > 1 && (
                  <DropdownItem onSelect={() => setSelectedIds(collectSubtreeIds(display, [menuNode.id]))}>
                    <Icon name="mindMap" size={15} />选中子树
                  </DropdownItem>
                )}
                {menuNode.message?.role === 'user' && (
                  <DropdownItem
                    disabled={busy}
                    onSelect={() => void mutate({ op: 'setNodeMeta', messageId: menuNode.id, graphMeta: { collapsed: !summary(menuNode) } })}
                  >
                    <Icon name={summary(menuNode) ? 'expand' : 'compress'} size={15} />
                    {summary(menuNode) ? '展开为完整节点' : '缩略为箭头摘要'}
                  </DropdownItem>
                )}
                {summary(menuNode) && (
                  <DropdownItem
                    disabled={busy}
                    onSelect={() => requestAnimationFrame(() => setEditing({ id: menuNode.id, text: menuNode.message?.graphMeta?.summary ?? '' }))}
                  >
                    <Icon name="edit" size={15} />编辑摘要
                  </DropdownItem>
                )}
                {isLeaf(menuNode) && (
                  <DropdownItem disabled={busy} onSelect={() => activate(menuNode)}>
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
                      onSelect={() => makeBranch({ x: menuNode.x + menuNode.width / 2, y: menuNode.y + menuNode.height + 86 }, menuNode.id)}
                    >
                      <Icon name="branch" size={15} />从此处新建分支
                    </DropdownItem>
                    <DropdownItem disabled={busy || messages.length < 2} onSelect={() => setPickParent(menuNode.id)}>
                      <Icon name="link" size={15} />更改上游节点
                    </DropdownItem>
                    {menuNode.parentId && (
                      <DropdownItem disabled={busy} onSelect={() => void mutate({ op: 'reparent', messageId: menuNode.id, parentId: '' })}>
                        <Icon name="unlink" size={15} />断开上下文
                      </DropdownItem>
                    )}
                  </>
                )}
                <DropdownSeparator />
                <DropdownItem danger disabled={busy} onSelect={() => requestAnimationFrame(() => setDeletingNodes([menuNode]))}>
                  <Icon name="trash" size={15} />{menuNode.branch ? '删除分支' : '删除消息'}
                </DropdownItem>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

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
          const deletedSet = new Set(deletingNodes.map((n) => n.id));
          const result = await mutate({ op: 'deleteNodes', messageIds, branchIds });
          setSubmitting(false);
          if (result) {
            setDeletingNodes(null);
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of deletedSet) next.delete(id);
              return next;
            });
            setExpandedIds((prev) => {
              const next = new Set(prev);
              for (const id of deletedSet) next.delete(id);
              return next;
            });
          }
        }}
      />
    </div>
  );
}
