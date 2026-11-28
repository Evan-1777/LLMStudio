import type { GraphNotePort } from '../../core/types';
import type { GraphNode, Point } from './conversationGraph';

export const moveTo = ({ x, y }: Point) => 'M ' + x + ' ' + y + ' ';

export function port(node: GraphNode, end: 'in' | 'out'): Point {
  return { x: node.x + node.width / 2, y: node.y + (end === 'out' ? node.height : 0) };
}

export const NODE_SIDE_OUT_OFFSET_X = 30;

export function nodeSideOutPort(node: GraphNode): Point {
  return { x: node.x + node.width / 2 + NODE_SIDE_OUT_OFFSET_X, y: node.y + node.height };
}

export function sidePort(node: GraphNode, side: 'left' | 'right'): Point {
  return {
    x: side === 'left' ? node.x : node.x + node.width,
    y: node.y + node.height / 2,
  };
}

export function notePortPoint(node: GraphNode, side: GraphNotePort): Point {
  switch (side) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y };
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 };
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

export function nearestNotePort(
  node: GraphNode,
  target: Point,
): { port: GraphNotePort; point: Point } {
  const candidates: GraphNotePort[] = ['top', 'bottom', 'left', 'right'];
  let bestPort: GraphNotePort = 'top';
  let bestPoint = notePortPoint(node, 'top');
  let bestDist = Math.hypot(bestPoint.x - target.x, bestPoint.y - target.y);
  for (let i = 1; i < candidates.length; i++) {
    const p = candidates[i];
    const pt = notePortPoint(node, p);
    const d = Math.hypot(pt.x - target.x, pt.y - target.y);
    if (d < bestDist) {
      bestDist = d;
      bestPort = p;
      bestPoint = pt;
    }
  }
  return { port: bestPort, point: bestPoint };
}

export function curve(from: Point, to: Point): string {
  const bend = Math.max(24, Math.min(112, Math.abs(to.y - from.y) * 0.48));
  return 'C ' + from.x + ' ' + (from.y + bend) + ', ' + to.x + ' ' + (to.y - bend) + ', ' + to.x + ' ' + to.y;
}

function cubicMidpoint(p0: Point, p1: Point, p2: Point, p3: Point): Point {
  return {
    x: 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x,
    y: 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y,
  };
}

export function sideRefCurve(
  from: Point,
  to: Point,
  side: 'left' | 'right',
): { d: string; mid: Point } {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const dir = side === 'left' ? -1 : 1;
  const hBend = Math.max(42, Math.min(140, dx * 0.45 + 24));
  const vBend = Math.max(28, Math.min(96, dy * 0.35 + 18));
  const c1: Point = { x: from.x, y: from.y + vBend };
  const c2: Point = { x: to.x + dir * hBend, y: to.y };
  const d =
    moveTo(from) +
    'C ' +
    c1.x +
    ' ' +
    c1.y +
    ', ' +
    c2.x +
    ' ' +
    c2.y +
    ', ' +
    to.x +
    ' ' +
    to.y;
  return { d, mid: cubicMidpoint(from, c1, c2, to) };
}

function portNormal(p: GraphNotePort): Point {
  switch (p) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

export function noteEdgeCurve(
  from: Point,
  fromPort: GraphNotePort,
  to: Point,
  toPort: GraphNotePort,
): { d: string; mid: Point } {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const bend = Math.max(24, Math.min(96, dist * 0.35));
  const n1 = portNormal(fromPort);
  const n2 = portNormal(toPort);
  const c1: Point = { x: from.x + n1.x * bend, y: from.y + n1.y * bend };
  const c2: Point = { x: to.x + n2.x * bend, y: to.y + n2.y * bend };
  const d =
    moveTo(from) +
    'C ' +
    c1.x +
    ' ' +
    c1.y +
    ', ' +
    c2.x +
    ' ' +
    c2.y +
    ', ' +
    to.x +
    ' ' +
    to.y;
  return { d, mid: cubicMidpoint(from, c1, c2, to) };
}
