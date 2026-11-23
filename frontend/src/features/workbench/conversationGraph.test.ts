import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../../core/types';
import { computeAutoLayout, extractUserSummary, resolveActiveBranchMessages, resolveBranchSummaries, wouldCreateCycle } from './conversationGraph';
import { activeChatMessages, chatReducer, initialChatState, streamingChatMessages } from '../chat/chatReducer';

function message(id: string, parentId = '', role = 'user'): Message {
  return { id, parentId, conversationId: 'topic', role, createdAt: '2026-11-23T01:00:00Z', blocks: [{ type: 'text', text: '  Context\n  ' + id }] };
}
const messages = [message('a'), message('b', 'a', 'assistant'), message('c', 'b'), message('d', 'a', 'assistant'), message('e')];
const conversation = { id: 'topic', activeLeafId: 'c', graphState: { enabled: true, branches: [
  { id: 'fork', label: '分支 4', parentMessageId: 'a', createdAt: '' }, { id: 'blank', label: '分支 5', createdAt: '' },
] } } as Conversation;
const ids = (items: Message[]) => items.map((item) => item.id);

describe('conversation graph', () => {
  it('projects the root-to-leaf path, anchored drafts, and an independent empty branch', () => {
    expect(resolveActiveBranchMessages(null, messages)).toBe(messages);
    expect(ids(resolveActiveBranchMessages(conversation, messages))).toEqual(['a', 'b', 'c']);
    const at = (activeBranchId: string) => ({ ...conversation, graphState: { ...conversation.graphState!, activeBranchId } });
    expect(ids(resolveActiveBranchMessages(at('fork'), messages))).toEqual(['a']);
    expect(resolveActiveBranchMessages(at('blank'), messages)).toEqual([]);
    expect(resolveBranchSummaries(conversation, messages).map((branch) => [branch.id, branch.messageIds])).toEqual([
      ['c', ['a', 'b', 'c']], ['d', ['a', 'd']], ['e', ['e']], ['fork', ['a']], ['blank', []],
    ]);
    const byId = new Map(messages.map((msg) => [msg.id, msg]));
    expect(wouldCreateCycle(byId, 'a', 'c')).toBe(true);
    expect(wouldCreateCycle(byId, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(byId, 'c', 'd')).toBe(false);
  });

  it('lays out the forest deterministically without overlaps and honors saved positions', () => {
    const rows = messages.map((msg) => msg.id === 'a' ? { ...msg, graphMeta: { collapsed: true, x: -300, y: 21 } } : msg);
    const layout = computeAutoLayout(conversation, rows, false);
    expect(layout).toEqual(computeAutoLayout(conversation, rows, false));
    expect(layout.find((node) => node.id === 'a')?.height).toBe(32);
    expect(extractUserSummary(rows[0])).toBe('Context a');
    for (const a of layout) for (const b of layout) {
      if (a === b) continue;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(computeAutoLayout(conversation, rows)[0]).toMatchObject({ x: -300, y: 21 });
  });

  it('retries only the active successor and keeps alternate branches intact while streaming', () => {
    const state = { ...initialChatState, messages: [messages[0], messages[3], messages[1], messages[2]], conversation };
    const retry = chatReducer(state, { type: 'REGEN_PREPARE_START', targetMessageId: 'a', providerId: 'p', modelId: 'm', placeholderAssistantId: 'draft' });
    expect(ids(streamingChatMessages(retry, activeChatMessages(retry)))).toEqual(['a', 'draft', 'c']);
    const final = chatReducer(retry, { type: 'STREAM_EVENT', event: { type: 'message_end', message: message('b', 'a', 'assistant') }, fallbackProviderId: 'p', fallbackModelId: 'm' });
    expect(ids(activeChatMessages(final))).toEqual(['a', 'b', 'c']);
    expect(final.messages.find(({ id }) => id === 'd')).toEqual(messages[3]);
  });
});
