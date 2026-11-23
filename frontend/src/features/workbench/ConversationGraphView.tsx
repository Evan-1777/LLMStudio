import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Button, ConfirmDialog, DropdownItem, DropdownSeparator, Icon, IconButton, Modal } from '../../components/ui';
import type { Conversation, ConversationDetail, GraphMutationInput, Message } from '../../core/types';
import { computeAutoLayout, extractNodePreview, extractUserSummary, wouldCreateCycle, type GraphNode, type Point } from './conversationGraph';
import './conversation-graph.css';

type View = Point & { scale: number };
type Gesture =
  | { kind: 'pan'; id: number; start: Point; view: View; moved: boolean }
  | { kind: 'move'; id: number; start: Point; node: GraphNode; moved: boolean }
  | { kind: 'link'; id: number; start: Point; node: GraphNode; end: 'in' | 'out'; moved: boolean }
  | { kind: 'pinch'; start: Point; distance: number; view: View };
type LinkDrag = { node: GraphNode; end: 'in' | 'out'; pointer: Point; target?: GraphNode; valid: boolean; overNode: boolean };
const initialView: View = { x: 0, y: 0, scale: 1 };
const minZoom = 0.35;
const maxZoom = 1.8;
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

export function ConversationGraphView({ conversation, messages, activeMessages, busy, mutate, onJump, onActivate, onDelete }: {
  conversation: Conversation;
  messages: Message[];
  activeMessages: Message[];
  busy: boolean;
  mutate: (input: GraphMutationInput) => Promise<ConversationDetail | null>;
  onJump: (messageId: string) => void;
  onActivate: (branch: { leafMessageId: string } | { branchId: string }) => void;
  onDelete: (message: Message) => Promise<boolean>;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const marker = useId();
  const summaryForm = useId();
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Point>());
  const viewRef = useRef(initialView);
  const [view, setView] = useState(initialView);
  const [panning, setPanning] = useState(false);
  const [moving, setMoving] = useState<{ id: string; point: Point } | null>(null);
  const [link, setLink] = useState<LinkDrag | null>(null);
  const [pickParent, setPickParent] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id?: string; client: Point; world: Point } | null>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<GraphNode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nodes = useMemo(() => computeAutoLayout(conversation, messages), [conversation, messages]);
  const activeIds = useMemo(() => new Set([
    ...activeMessages.map((m) => m.id), conversation.graphState?.activeBranchId,
  ]), [activeMessages, conversation.graphState?.activeBranchId]);
  const display = useMemo(() => nodes.map((node) => moving?.id === node.id ? { ...node, ...moving.point } : node), [nodes, moving]);
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
  const activeId = conversation.graphState?.activeBranchId || conversation.activeLeafId || activeMessages.at(-1)?.id;
  const menuNode = menu?.id ? byId.get(menu.id) : undefined;
  const setCamera = (next: View) => { viewRef.current = next; setView(next); };
  const origin = (clientX: number, clientY: number): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const center = (): Point => ({ x: (stage.current?.clientWidth ?? 0) / 2, y: (stage.current?.clientHeight ?? 0) / 2 });

  function fit(entries: GraphNode[], preferReadable = false) {
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
    const fitted = clampZoom(Math.min(1, (rect.width - 48) / (right - left), usableHeight / (bottom - top)));
    const scale = preferReadable && rect.width < 500 ? Math.max(fitted, 0.68) : fitted;
    const focus = entries.find((node) => node.id === activeId);
    const focusX = focus && (right - left) * scale > rect.width - 48 ? focus.x + focus.width / 2 : (left + right) / 2;
    const focusY = focus && (bottom - top) * scale > usableHeight ? focus.y + focus.height / 2 : (top + bottom) / 2;
    setCamera({ scale, x: rect.width / 2 - focusX * scale, y: usableHeight / 2 + 16 - focusY * scale });
  }

  useLayoutEffect(() => { fit(nodes, true); }, []); // A topic change remounts the viewport; graph edits preserve the camera.
  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = origin(event.clientX, event.clientY);
      const current = viewRef.current;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      setCamera(zoomAt(current, point, point, clampZoom(current.scale * Math.exp(-delta * 0.0018))));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const changeZoom = (factor: number) => {
    const point = center();
    const current = viewRef.current;
    setCamera(zoomAt(current, point, point, clampZoom(current.scale * factor)));
  };
  const makeBranch = (point: Point, parentMessageId = '') => {
    const x = Math.round(point.x - 106);
    const y = Math.round(point.y - 34);
    const vacant = (offset: number) => nodes.every((node) =>
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
    const arranged = computeAutoLayout(conversation, messages, false);
    if (!arranged.length) return;
    const result = await mutate({ op: 'setNodeMeta', positions: arranged.map(({ id, branch, x, y }) => ({ ...(branch ? { branchId: id } : { messageId: id }), x, y })) });
    if (result) fit(arranged);
  };
  const isLeaf = (node: GraphNode) => !children.has(node.id);
  const activate = (node: GraphNode) => onActivate(node.branch ? { branchId: node.id } : { leafMessageId: node.id });
  const canConnect = (child: string, parent: GraphNode) => Boolean(parent.message) && !wouldCreateCycle(byId, child, parent.id);
  const pick = (node: GraphNode) => {
    if (busy) return;
    if (pickParent) {
      if (canConnect(pickParent, node)) {
        void mutate({ op: 'reparent', messageId: pickParent, parentId: node.id });
        setPickParent(null);
      }
      return;
    }
    if (node.branch) activate(node);
    else onJump(node.id);
  };

  function start(event: PointerEvent, spec: { kind: 'move'; node: GraphNode } | { kind: 'link'; node: GraphNode; end: 'in' | 'out' } | { kind: 'pan' }) {
    if (event.button !== 0 || menu || editing || deleting) return;
    if (spec.kind !== 'pan') event.stopPropagation();
    const point = origin(event.clientX, event.clientY);
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, point);
      if (touches.current.size >= 2) {
        const [a, b] = touches.current.values();
        gesture.current = { kind: 'pinch', start: midpoint(a, b), distance: Math.max(distance(a, b), 1), view: viewRef.current };
        setMoving(null);
        setLink(null);
        setPanning(true);
        stage.current!.setPointerCapture(event.pointerId);
        return;
      }
    }
    if (gesture.current) return;
    stage.current!.setPointerCapture(event.pointerId);
    const base = { id: event.pointerId, start: point, moved: false };
    gesture.current = spec.kind === 'pan' ? { ...base, kind: 'pan', view: viewRef.current } : { ...base, ...spec };
  }

  function linkAt(event: PointerEvent, drag: Extract<Gesture, {kind: 'link'}>): LinkDrag {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-graph-node]');
    const target = el?.dataset.graphNode ? byId.get(el.dataset.graphNode) : undefined;
    const valid = !!target && (drag.end === 'in'
      ? canConnect(drag.node.id, target)
      : !!target.message && canConnect(target.id, drag.node));
    return { node: drag.node, end: drag.end, target, valid, overNode: !!target,
      pointer: toWorld(origin(event.clientX, event.clientY), viewRef.current) };
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
    } else if (!busy && !pickParent) {
      if (drag.kind === 'move') setMoving({ id: drag.node.id, point: { x: drag.node.x + dx / viewRef.current.scale, y: drag.node.y + dy / viewRef.current.scale } });
      else setLink(linkAt(event, drag));
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
    const point = origin(event.clientX, event.clientY);
    const moved = drag.kind !== 'pinch' && (drag.moved || distance(point, drag.start) > 5);
    if (cancelled || drag.kind === 'pinch' || busy || !moved || drag.kind !== 'move') setMoving(null);
    if (cancelled || drag.kind === 'pinch' || busy) return;
    if (drag.kind === 'move') {
      if (!moved) pick(drag.node);
      else if (!pickParent) {
        const x = Math.round(drag.node.x + (point.x - drag.start.x) / viewRef.current.scale);
        const y = Math.round(drag.node.y + (point.y - drag.start.y) / viewRef.current.scale);
        setMoving({ id: drag.node.id, point: { x, y } });
        void mutate({ op: 'setNodeMeta', positions: [{ ...(drag.node.branch ? { branchId: drag.node.id } : { messageId: drag.node.id }), x, y }] }).finally(() => setMoving(null));
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
    const end = port(node, 'in');
    const parentEnd = parent && port(parent, 'out');
    if (!parentEnd && !summary(node)) return null;
    const start = parentEnd ?? { x: end.x, y: end.y - 28 };
    const intoSummary = summary(node) && children.has(node.id);
    return <g key={node.id} className={active ? 'cg-edge cg-edge--active' : 'cg-edge'}>
      {!parentEnd && <circle cx={start.x} cy={start.y} r={3} />}
      <path d={moveTo(start) + curve(start, end)} markerEnd={intoSummary ? undefined : 'url(#' + marker + (active ? '-active' : '') + ')'} />
    </g>;
  };

  return (
    <div ref={stage} className={'cg-stage' + (panning ? ' cg-stage--panning' : '') + (link || pickParent ? ' cg-stage--linking' : '')}
      role="region" aria-label="对话图谱" aria-busy={busy || undefined} tabIndex={0}
      style={{ backgroundPosition: view.x + 'px ' + view.y + 'px' }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) start(event, { kind: 'pan' }); }}
      onPointerMove={move} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={(event) => end(event, true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && pickParent) { event.stopPropagation(); setPickParent(null); }
        if (event.target !== event.currentTarget) return;
        const delta = ({ ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] } as Record<string, number[]>)[event.key];
        if (delta) { event.preventDefault(); setCamera({ ...view, x: view.x + delta[0], y: view.y + delta[1] }); }
        if (event.key === '+' || event.key === '=') changeZoom(1.2);
        if (event.key === '-') changeZoom(1 / 1.2);
        if (event.key === '0') fit(nodes);
      }}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('.cg-controls, [role="dialog"], [role="menu"]')) return;
        event.preventDefault();
        const target = (event.target as Element).closest<HTMLElement>('[data-graph-node]');
        const rect = target?.getBoundingClientRect();
        openMenu(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : rect ? { x: rect.left + 16, y: rect.top + 16 } : { x: stage.current!.getBoundingClientRect().left + center().x, y: stage.current!.getBoundingClientRect().top + center().y }, target?.dataset.graphNode, target?.querySelector('button') ?? undefined);
      }}
    >
      <div className="cg-world" style={{ transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')' }}>
        <svg className="cg-edges" aria-hidden="true" width="1" height="1">
          <defs>{['', '-active'].map((suffix) => <marker key={suffix} id={marker + suffix} viewBox="0 0 7 8" refX="6.5" refY="4" markerWidth="7" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="m0 0 7 4-7 4 1.4-4Z" className={suffix ? 'cg-marker cg-marker--active' : 'cg-marker'} /></marker>)}</defs>
          {display.map(renderEdge)}
          {link && <path className="cg-edge-draft" d={link.end === 'in' ? moveTo(link.pointer) + curve(link.pointer, port(link.node, 'in')) : moveTo(port(link.node, 'out')) + curve(port(link.node, 'out'), link.pointer)} />}
        </svg>
        {display.map((node) => {
          const msg = node.message;
          const collapsed = summary(node);
          const compact = msg?.role === 'compaction';
          const isUser = msg?.role === 'user';
          const title = node.branch?.label || (compact ? '上下文检查点' : isUser ? '用户' : msg?.modelId || '助手');
          const preview = msg ? extractNodePreview(msg) : '';
          const images = msg?.blocks.filter((block) => block.type === 'image').length ?? 0;
          const tools = msg?.blocks.filter((block) => block.type === 'toolCall').length ?? 0;
          const thinking = msg?.blocks.some((block) => block.type === 'thinking');
          const status = msg?.stopReason === 'aborted' ? '已停止' : msg?.stopReason === 'error' ? '生成失败' : '';
          const valid = link?.target?.id === node.id ? link.valid : pickParent ? canConnect(pickParent, node) : undefined;
          const time = msg && new Date(msg.createdAt);
          return <div key={node.id} data-graph-node={node.id} data-kind={collapsed ? 'summary' : node.branch ? 'branch' : compact ? 'checkpoint' : msg?.role}
            className={['cg-node', activeIds.has(node.id) && 'cg-node--path', activeId === node.id && 'cg-node--current', valid !== undefined && (valid ? 'cg-node--valid' : 'cg-node--invalid')].filter(Boolean).join(' ')}
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}>
            <button type="button" className="cg-node__body" aria-current={activeId === node.id || undefined}
              aria-disabled={busy || undefined} onPointerDown={(event) => {
                if (event.pointerType !== 'touch') event.currentTarget.focus({ preventScroll: true });
                start(event, { kind: 'move', node });
              }} onClick={(event) => { if (event.detail === 0) pick(node); }}>
              {collapsed && msg ? <><Icon name="user" size={13} /><span>{extractUserSummary(msg)}</span></> : compact ? <><Icon name="compress" size={15} /><span>{title}</span></> : <>
                <span className="cg-node__header"><Icon name={node.branch ? 'branch' : isUser ? 'user' : 'bot'} size={14} /><strong>{title}</strong>
                  {time && !Number.isNaN(time.getTime()) && <time dateTime={msg!.createdAt}>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>}
                </span>
                <span className="cg-node__preview">{node.branch ? node.parentId ? '话题内分支' : '独立上下文' : preview || (images ? '图片' : tools ? '工具调用' : status || '—')}</span>
                {(images > 0 || tools > 0 || thinking || status) && <span className="cg-node__meta">
                  {images > 0 && <span aria-label={images + ' 张图片'}><Icon name="image" size={13} />{images}</span>}
                  {thinking && <span aria-label="思考"><Icon name="brain" size={13} /></span>}
                  {tools > 0 && <span aria-label={tools + ' 次工具调用'}><Icon name="wrench" size={13} />{tools}</span>}
                  {status && <span className="cg-node__status" title={status} aria-label={status}><Icon name={msg?.stopReason === 'error' ? 'warning' : 'stop'} size={13} /></span>}
                </span>}
              </>}
            </button>
            <div className="cg-node__actions">
              {isLeaf(node) && <IconButton icon="arrowUp" label="在此分支继续" size="sm" disabled={busy} onClick={() => activate(node)} />}
              <IconButton icon="ellipsis" label="节点操作" size="sm" onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu({ x: rect.right, y: rect.bottom }, node.id, event.currentTarget);
              }} />
            </div>
            {msg && (['in', 'out'] as const).map((side) => <span key={side} aria-hidden="true" data-port={side} className={'cg-port cg-port--' + side}
              onPointerDown={(event) => { if (!busy) start(event, { kind: 'link', node, end: side }); }} />)}
          </div>;
        })}
      </div>
      {!nodes.length && <div className="cg-empty"><Icon name="mindMap" size={30} /><span>暂无节点</span></div>}
      <div className="cg-controls" role="group" aria-label="图谱控制">
        <IconButton icon="zoomOut" label="缩小" size="sm" disabled={view.scale <= minZoom} onClick={() => changeZoom(1 / 1.2)} />
        <button type="button" className="cg-controls__fit" title="适配画布" aria-label="适配画布" onClick={() => fit(nodes)}><Icon name="fitView" size={15} /><span>{Math.round(view.scale * 100)}%</span></button>
        <IconButton icon="zoomIn" label="放大" size="sm" disabled={view.scale >= maxZoom} onClick={() => changeZoom(1.2)} />
        <span className="cg-controls__divider" aria-hidden="true" />
        <IconButton icon="autoLayout" label="自动整理布局" size="sm" disabled={busy || !nodes.length} onClick={() => void layout()} />
        <IconButton icon="plus" label="新建空白分支" size="sm" disabled={busy} onClick={() => makeBranch(toWorld(center(), viewRef.current))} />
      </div>
      <DropdownMenu.Root modal={false} open={!!menu} onOpenChange={(open) => { if (!open) setMenu(null); }}>
        <DropdownMenu.Trigger asChild><span className="cg-menu-anchor" style={{ left: menu?.client.x, top: menu?.client.y }} /></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="ui-menu-content cg-menu" align="start" collisionPadding={12} sideOffset={3}
          onCloseAutoFocus={(event) => { event.preventDefault(); menuOrigin.current?.focus({ preventScroll: true }); }}>
          {!menuNode ? <>
            <DropdownItem disabled={busy} onSelect={() => menu && makeBranch(menu.world)}><Icon name="plus" size={15} />新建空白分支</DropdownItem>
            <DropdownItem disabled={busy || !nodes.length} onSelect={() => void layout()}><Icon name="autoLayout" size={15} />自动整理布局</DropdownItem>
            <DropdownItem onSelect={() => fit(nodes)}><Icon name="fitView" size={15} />适配画布</DropdownItem>
          </> : <>
            {menuNode.message?.role === 'user' && <DropdownItem disabled={busy} onSelect={() => void mutate({ op: 'setNodeMeta', messageId: menuNode.id, graphMeta: { collapsed: !summary(menuNode) } })}><Icon name={summary(menuNode) ? 'expand' : 'compress'} size={15} />{summary(menuNode) ? '展开为完整节点' : '缩略为箭头摘要'}</DropdownItem>}
            {summary(menuNode) && <DropdownItem disabled={busy} onSelect={() => requestAnimationFrame(() => setEditing({ id: menuNode.id, text: menuNode.message?.graphMeta?.summary ?? '' }))}><Icon name="edit" size={15} />编辑摘要</DropdownItem>}
            {isLeaf(menuNode) && <DropdownItem disabled={busy} onSelect={() => activate(menuNode)}><Icon name="arrowUp" size={15} />在此分支继续</DropdownItem>}
            {menuNode.message && <>
              <DropdownItem disabled={busy} onSelect={() => onJump(menuNode.id)}><Icon name="messageSquare" size={15} />跳转至此消息</DropdownItem>
              <DropdownItem disabled={busy} onSelect={() => makeBranch({ x: menuNode.x + menuNode.width / 2, y: menuNode.y + menuNode.height + 86 }, menuNode.id)}><Icon name="branch" size={15} />从此处新建分支</DropdownItem>
              <DropdownItem disabled={busy || messages.length < 2} onSelect={() => setPickParent(menuNode.id)}><Icon name="link" size={15} />更改上游节点</DropdownItem>
              {menuNode.parentId && <DropdownItem disabled={busy} onSelect={() => void mutate({ op: 'reparent', messageId: menuNode.id, parentId: '' })}><Icon name="unlink" size={15} />断开上下文</DropdownItem>}
            </>}
            <DropdownSeparator />
            <DropdownItem danger disabled={busy} onSelect={() => requestAnimationFrame(() => setDeleting(menuNode))}><Icon name="trash" size={15} />{menuNode.branch ? '删除分支' : '删除消息'}</DropdownItem>
          </>}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Modal open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }} title="编辑摘要" busy={submitting}
        footer={<Button type="submit" form={summaryForm} loading={submitting}>保存</Button>}>
        <form id={summaryForm} onSubmit={async (event) => {
          event.preventDefault();
          if (!editing || submitting) return;
          setSubmitting(true);
          const result = await mutate({ op: 'setNodeMeta', messageId: editing.id, graphMeta: { summary: editing.text.trim() } });
          setSubmitting(false);
          if (result) setEditing(null);
        }}>
          <input className="ui-input" aria-label="摘要" autoFocus maxLength={160} value={editing?.text ?? ''} onChange={(event) => setEditing((value) => value && { ...value, text: event.target.value })} />
        </form>
      </Modal>
      <ConfirmDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={deleting?.branch ? '删除分支' : '删除消息'} message={deleting?.branch ? '将删除该空白分支。' : '将删除该消息并重接后续上下文。'}
        confirmLabel="删除" danger busy={submitting} onConfirm={async () => {
          if (!deleting || submitting) return;
          setSubmitting(true);
          const result = deleting.message ? await onDelete(deleting.message) : await mutate({ op: 'deleteBranch', branchId: deleting.id });
          setSubmitting(false);
          if (result) setDeleting(null);
        }} />
    </div>
  );
}
