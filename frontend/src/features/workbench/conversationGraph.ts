import type { Conversation, ConversationBranchSlot, Message } from '../../core/types';

export interface Point { x: number; y: number }
export interface GraphNode extends Point {
  id: string;
  parentId: string;
  width: number;
  height: number;
  message?: Message;
  branch?: ConversationBranchSlot;
}

function *ancestors<T extends { parentId?: string }>(byId: ReadonlyMap<string, T>, leaf: string) {
  const seen = new Set<string>();
  for (let id = leaf; id && !seen.has(id); ) {
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    yield { id, node };
    id = node.parentId ?? '';
  }
}

const indexMessages = (messages: readonly Message[]) => new Map(messages.map((message) => [message.id, message]));
const pathTo = (byId: ReadonlyMap<string, Message>, leaf: string) => Array.from(ancestors(byId, leaf), ({ node }) => node).reverse();

export function resolveActiveBranchMessages(conversation: Conversation | null, messages: Message[]): Message[] {
  const graph = conversation?.graphState;
  if (!graph?.enabled) return messages;
  const slot = graph.branches?.find((branch) => branch.id === graph.activeBranchId);
  return pathTo(indexMessages(messages), (slot ? slot.parentMessageId : conversation?.activeLeafId) ?? '');
}

export function resolveBranchSummaries(conversation: Conversation, messages: Message[]) {
  if (!conversation.graphState?.enabled) return [];
  const slots = conversation.graphState.branches ?? [];
  const byId = indexMessages(messages);
  const parents = new Set(messages.map((m) => m.parentId).concat(slots.map((s) => s.parentMessageId)));
  return [
    ...messages.filter((m) => !parents.has(m.id)).map((m, index) => ({
      id: m.id, label: '分支 ' + (index + 1), leafMessageId: m.id,
      messageIds: pathTo(byId, m.id).map((entry) => entry.id),
    })),
    ...slots.map((s) => ({
      id: s.id, label: s.label, branchId: s.id,
      messageIds: pathTo(byId, s.parentMessageId ?? '').map((entry) => entry.id),
    })),
  ];
}

export function wouldCreateCycle(byId: ReadonlyMap<string, { parentId?: string }>, childId: string, newParentId: string): boolean {
  for (const { id } of ancestors(byId, newParentId)) if (id === childId) return true;
  return childId === newParentId;
}

export function extractNodePreview(message: Message): string {
  return message.blocks.flatMap((block) =>
    (block.type === 'text' || block.type === 'compaction') && typeof block.text === 'string' ? [block.text] : [],
  ).join(' ').replace(/\s+/g, ' ').trim().slice(0, 260);
}

export function extractUserSummary(message: Message): string {
  return message.graphMeta?.summary?.trim() || Array.from(extractNodePreview(message)).slice(0, 40).join('') || '用户消息';
}

export function computeAutoLayout(conversation: Conversation, messages: Message[], useSavedPositions = true): GraphNode[] {
  const graph = conversation.graphState;
  const nodes: GraphNode[] = messages.map((message, index) => {
    const summary = message.role === 'user' && message.graphMeta?.collapsed;
    const compact = message.role === 'compaction';
    return {
      message, id: message.id, parentId: graph?.enabled ? message.parentId ?? '' : messages[index - 1]?.id ?? '',
      x: 0, y: 0, width: summary ? 196 : compact ? 208 : 248, height: summary ? 32 : compact ? 40 : message.role === 'user' ? 92 : 104,
    };
  });
  for (const branch of graph?.branches ?? []) {
    nodes.push({ branch, id: branch.id, parentId: branch.parentMessageId ?? '', x: 0, y: 0, width: 212, height: 68 });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, GraphNode[]>();
  const roots: GraphNode[] = [];
  for (const node of nodes) {
    if (!byId.has(node.parentId)) roots.push(node);
    else {
      const row = children.get(node.parentId) ?? [];
      row.push(node);
      children.set(node.parentId, row);
    }
  }
  // Measure the forest bottom-up, then allocate each subtree a disjoint lane.
  const queue = roots.map((node) => ({ node, depth: 0 }));
  const rowHeights: number[] = [];
  for (let i = 0; i < queue.length; i++) {
    const { node, depth } = queue[i];
    rowHeights[depth] = Math.max(rowHeights[depth] ?? 0, node.height);
    for (const child of children.get(node.id) ?? []) queue.push({ node: child, depth: depth + 1 });
  }
  const gap = 36;
  const rowY = [0];
  for (const height of rowHeights) rowY.push(rowY[rowY.length - 1] + height + 52);
  const spans = new Map<string, number>();
  const childSpan = (row: GraphNode[]) => row.reduce((sum, child) => sum + spans.get(child.id)! + gap, -gap);
  for (let i = queue.length - 1; i >= 0; i--) {
    const { node } = queue[i];
    spans.set(node.id, Math.max(node.width, childSpan(children.get(node.id) ?? [])));
  }
  const lanes = new Map<string, number>();
  const assign = (row: GraphNode[], x: number) => {
    for (const child of row) {
      lanes.set(child.id, x);
      x += spans.get(child.id)! + gap;
    }
  };
  assign(roots, 0);
  for (const { node, depth } of queue) {
    const center = lanes.get(node.id)! + spans.get(node.id)! / 2;
    node.x = center - node.width / 2;
    node.y = rowY[depth] + (rowHeights[depth] - node.height) / 2;
    const row = children.get(node.id) ?? [];
    assign(row, center - childSpan(row) / 2);
  }
  if (useSavedPositions) {
    for (const node of nodes) {
      const saved = node.branch ?? node.message?.graphMeta;
      node.x = saved?.x ?? node.x;
      node.y = saved?.y ?? node.y;
    }
  }
  return nodes;
}
