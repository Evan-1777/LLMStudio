import type {
  Conversation,
  ConversationBranchSlot,
  ConversationGraphNote,
  Message,
  MessageSideRef,
} from '../../core/types';

export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface GraphNode extends Point {
  id: string;
  parentId: string;
  width: number;
  height: number;
  message?: Message;
  branch?: ConversationBranchSlot;
  note?: ConversationGraphNote;
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

export function rectIntersectsNode(
  rect: Rect,
  node: Pick<GraphNode, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  return (
    rect.left <= node.x + node.width &&
    rect.right >= node.x &&
    rect.top <= node.y + node.height &&
    rect.bottom >= node.y
  );
}

export function collectSubtreeIds(
  nodes: readonly GraphNode[],
  rootIds: Iterable<string>,
): Set<string> {
  const byId = new Set(nodes.map((node) => node.id));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const id of rootIds) {
    if (byId.has(id) && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const childId of children.get(queue[i]) ?? []) {
      if (!visited.has(childId)) {
        visited.add(childId);
        queue.push(childId);
      }
    }
  }
  return visited;
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

export function wouldCreateDependencyCycle(
  messages: readonly Message[],
  targetId: string,
  sourceId: string,
): boolean {
  if (!targetId || !sourceId || targetId === sourceId) return true;
  const byId = indexMessages(messages);
  const target = byId.get(targetId);
  const source = byId.get(sourceId);
  if (!target || !source) return true;
  if (target.role !== 'user' && target.role !== 'assistant') return true;
  if (source.role !== 'user' && source.role !== 'assistant') return true;
  // Reject if source is already on target's direct parent chain.
  for (const { id } of ancestors(byId, targetId)) {
    if (id === sourceId) return true;
  }
  // Joint DAG cycle check across parentId + sideRefs: adding targetId -> sourceId
  // forms a cycle iff targetId is reachable from sourceId.
  const visited = new Set<string>([sourceId]);
  const queue: string[] = [sourceId];
  for (let i = 0; i < queue.length; i++) {
    const cur = byId.get(queue[i]);
    if (!cur) continue;
    const nextIds: string[] = [];
    if (cur.parentId) nextIds.push(cur.parentId);
    for (const ref of cur.graphMeta?.sideRefs ?? []) {
      if (ref.sourceMessageId) nextIds.push(ref.sourceMessageId);
    }
    for (const nextId of nextIds) {
      if (nextId === targetId) return true;
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push(nextId);
      }
    }
  }
  return false;
}

export function extractSideRefMessageText(message: Message): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    if ((block.type === 'text' || block.type === 'compaction') && typeof block.text === 'string') {
      const trimmed = block.text.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return parts.join('\n\n');
}

export function resolveSideRefBranchMessages(
  allMessages: readonly Message[],
  targetMessage: Message,
  sourceMessageId: string,
): Message[] {
  const byId = indexMessages(allMessages);
  const mainAncestors = new Set<string>();
  for (const { id } of ancestors(byId, targetMessage.id)) {
    mainAncestors.add(id);
  }
  const chain: Message[] = [];
  const walked = new Set<string>();
  for (let id = sourceMessageId; id && !walked.has(id); ) {
    if (mainAncestors.has(id)) break;
    const node = byId.get(id);
    if (!node) break;
    walked.add(id);
    chain.push(node);
    id = node.parentId ?? '';
  }
  chain.reverse();
  return chain.filter((msg) => msg.role === 'assistant');
}

export interface ResolvedSideRefBranch {
  ref: MessageSideRef;
  assistantMessages: Message[];
  preview: string;
}

export function resolveSideRefMaterials(
  allMessages: readonly Message[],
  targetMessage: Message,
): { text: string; branches: ResolvedSideRefBranch[] } {
  const refs = targetMessage.graphMeta?.sideRefs ?? [];
  if (!refs.length) return { text: '', branches: [] };
  const seenAssistant = new Set<string>();
  const mergedParts: string[] = [];
  const branches: ResolvedSideRefBranch[] = [];
  for (const ref of refs) {
    const assistantMessages = resolveSideRefBranchMessages(
      allMessages,
      targetMessage,
      ref.sourceMessageId,
    );
    const branchParts: string[] = [];
    for (const msg of assistantMessages) {
      const content = extractSideRefMessageText(msg);
      if (content) branchParts.push(content);
      if (!seenAssistant.has(msg.id)) {
        seenAssistant.add(msg.id);
        if (content) mergedParts.push(content);
      }
    }
    branches.push({
      ref,
      assistantMessages,
      preview: branchParts.join('\n\n'),
    });
  }
  const text = mergedParts.length
    ? `<reference_materials>\n${mergedParts.join('\n\n')}\n</reference_materials>`
    : '';
  return { text, branches };
}

export function extractNodePreview(message: Message): string {
  return message.blocks.flatMap((block) =>
    (block.type === 'text' || block.type === 'compaction') && typeof block.text === 'string' ? [block.text] : [],
  ).join(' ').replace(/\s+/g, ' ').trim().slice(0, 260);
}

export function extractUserSummary(message: Message): string {
  return message.graphMeta?.summary?.trim() || Array.from(extractNodePreview(message)).slice(0, 40).join('') || '用户消息';
}

export function computeAutoLayout(
  conversation: Conversation,
  messages: Message[],
  useSavedPositions = true,
  sizeOverrides?: ReadonlyMap<string, { width: number; height: number }>,
): GraphNode[] {
  const graph = conversation.graphState;
  const nodes: GraphNode[] = messages.map((message, index) => {
    const summary = message.role === 'user' && message.graphMeta?.collapsed;
    const compact = message.role === 'compaction';
    const override = sizeOverrides?.get(message.id);
    return {
      message, id: message.id, parentId: graph?.enabled ? message.parentId ?? '' : messages[index - 1]?.id ?? '',
      x: 0, y: 0,
      width: override?.width ?? (summary ? 196 : compact ? 208 : 248),
      height: override?.height ?? (summary ? 32 : compact ? 40 : message.role === 'user' ? 92 : 104),
    };
  });
  for (const branch of graph?.branches ?? []) {
    const override = sizeOverrides?.get(branch.id);
    nodes.push({
      branch, id: branch.id, parentId: branch.parentMessageId ?? '',
      x: 0, y: 0, width: override?.width ?? 212, height: override?.height ?? 68,
    });
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
  for (const note of graph?.notes ?? []) {
    const override = sizeOverrides?.get(note.id);
    nodes.push({
      note,
      id: note.id,
      parentId: '',
      x: note.x ?? 0,
      y: note.y ?? 0,
      width: override?.width ?? 148,
      height: override?.height ?? 44,
    });
  }
  return nodes;
}
