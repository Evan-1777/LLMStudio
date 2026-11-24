import { describe, expect, it } from 'vitest';
import type { Message } from '../../core/types';
import {
  computeContextUsage,
  estimateCompactionAfterTokens,
  estimateTextTokens,
  formatCompactTokens,
} from './contextUsage';

function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  usage?: Message['usage'],
): Message {
  return {
    id,
    conversationId: 'c1',
    role,
    blocks: [{ type: 'text', text }],
    usage,
    createdAt: '2026-11-19T10:00:00Z',
  };
}

describe('contextUsage', () => {
  it('formats compact token counts across boundaries', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(950)).toBe('950');
    expect(formatCompactTokens(1000)).toBe('1K');
    expect(formatCompactTokens(1200)).toBe('1.2K');
    expect(formatCompactTokens(128000)).toBe('128K');
    expect(formatCompactTokens(1500000)).toBe('1.5M');
  });

  it('anchors on latest reported assistant usage and adds hybrid trailing + draft estimates', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'hello'),
      msg('a1', 'assistant', 'world', {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 600,
        totalTokens: 1200,
      }),
    ];

    const exact = computeContextUsage({
      messages,
      systemPrompt: 'sys',
      draft: '',
      attachments: [],
      contextWindow: 4000,
    });
    expect(exact.source).toBe('reported');
    expect(exact.usedTokens).toBe(1200);
    expect(exact.percent).toBe(30);
    expect(exact.ratio).toBeCloseTo(0.3);
    expect(exact.remainingTokens).toBe(2800);
    expect(exact.sessionTotalTokens).toBe(1200);
    expect(exact.sessionCacheReadTokens).toBe(600);

    const hybrid = computeContextUsage({
      messages: [...messages, msg('u2', 'user', 'next question')],
      systemPrompt: 'sys',
      draft: 'typing reply',
      attachments: [
        {
          id: 'att1',
          name: 'img.png',
          mimeType: 'image/png',
          size: 512,
          kind: 'image',
          status: 'ready',
        },
      ],
      contextWindow: 4000,
    });
    expect(hybrid.source).toBe('hybrid');
    expect(hybrid.draftTokens).toBeGreaterThan(1024);
    expect(hybrid.usedTokens).toBeGreaterThan(1200 + hybrid.draftTokens);
  });

  it('falls back to character estimation when no usage is reported and handles missing contextWindow & clamping', () => {
    const estimated = computeContextUsage({
      messages: [msg('u1', 'user', '你好世界'), msg('a1', 'assistant', 'hello world')],
      systemPrompt: 'Be helpful.',
      draft: 'more text',
      attachments: [],
      contextWindow: undefined,
    });
    expect(estimated.source).toBe('estimated');
    expect(estimated.usedTokens).toBeGreaterThan(10);
    expect(estimated.contextWindow).toBeNull();
    expect(estimated.ratio).toBeNull();
    expect(estimated.percent).toBeNull();
    expect(estimated.remainingTokens).toBeNull();

    const overflow = computeContextUsage({
      messages: [
        msg('u1', 'user', 'q'),
        msg('a1', 'assistant', 'a', {
          inputTokens: 9000,
          outputTokens: 3000,
          totalTokens: 12000,
        }),
      ],
      draft: '',
      attachments: [],
      contextWindow: 10000,
    });
    expect(overflow.ratio).toBe(1);
    expect(overflow.percent).toBe(120);
    expect(overflow.remainingTokens).toBe(0);
  });

  it('prefers contextTokens, skips legacy multi-round tool messages, and counts structuredContent', () => {
    expect(estimateTextTokens('hello 世界')).toBe(4);

    const multiRoundCurrent: Message = {
      id: 'a-multi',
      conversationId: 'c1',
      role: 'assistant',
      blocks: [
        { type: 'toolCall', id: 'tc1', name: 'search', arguments: { q: 'hi' } },
        {
          type: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'search',
          content: 'summary',
          extra: { structuredContent: { hits: 10, body: 'long structured content payload' } },
        },
        { type: 'text', text: 'done' },
      ],
      usage: {
        inputTokens: 48000,
        outputTokens: 1500,
        totalTokens: 49500,
        contextTokens: 22500,
      },
      createdAt: '2026-11-19T10:01:00Z',
    };

    const reportedSnap = computeContextUsage({
      messages: [msg('u1', 'user', 'find'), multiRoundCurrent],
      draft: '',
      attachments: [],
      contextWindow: 128000,
    });
    expect(reportedSnap.source).toBe('reported');
    expect(reportedSnap.usedTokens).toBe(22500);
    expect(reportedSnap.sessionTotalTokens).toBe(49500);

    // Legacy multi-round message (has toolResult, no contextTokens) is skipped as anchor.
    const legacyToolMsg: Message = {
      ...multiRoundCurrent,
      id: 'a-legacy',
      usage: {
        inputTokens: 48000,
        outputTokens: 1500,
        totalTokens: 49500,
      },
    };
    const anchorA1 = msg('a1', 'assistant', 'first reply', {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
    });
    const hybridLegacy = computeContextUsage({
      messages: [msg('u1', 'user', 'q1'), anchorA1, msg('u2', 'user', 'q2'), legacyToolMsg],
      draft: '',
      attachments: [],
    });
    expect(hybridLegacy.source).toBe('hybrid');
    expect(hybridLegacy.usedTokens).toBeLessThan(2000);

    const estimatedLegacyWithStruct = computeContextUsage({
      messages: [msg('u2', 'user', 'q2'), legacyToolMsg],
      draft: '',
      attachments: [],
    });
    const legacyWithoutStruct: Message = {
      ...legacyToolMsg,
      blocks: [
        { type: 'toolCall', id: 'tc1', name: 'search', arguments: { q: 'hi' } },
        { type: 'toolResult', toolCallId: 'tc1', toolName: 'search', content: 'summary' },
        { type: 'text', text: 'done' },
      ],
    };
    const estimatedLegacyPlain = computeContextUsage({
      messages: [msg('u2', 'user', 'q2'), legacyWithoutStruct],
      draft: '',
      attachments: [],
    });
    expect(estimatedLegacyWithStruct.source).toBe('estimated');
    expect(estimatedLegacyWithStruct.usedTokens).toBeGreaterThan(
      estimatedLegacyPlain.usedTokens,
    );
  });

  it('slices compaction history, ignores retained snapshot usage, counts checkpoint usage, and restores on delete', () => {
    const u1 = msg('u1', 'user', 'old user turn');
    const a1 = msg('a1', 'assistant', 'old assistant turn', {
      inputTokens: 4000,
      outputTokens: 1000,
      totalTokens: 5000,
      contextTokens: 5000,
    });
    const u2 = msg('u2', 'user', 'retained question');
    const a2 = msg('a2', 'assistant', 'retained answer', {
      inputTokens: 10000,
      outputTokens: 2000,
      totalTokens: 12000,
      contextTokens: 12000,
    });
    const summaryText = '## 核心目标与约束\n保留约束';
    const expectedAfter = estimateCompactionAfterTokens('sys', summaryText, [u2, a2]);
    const checkpoint: Message = {
      id: 'c1',
      conversationId: 'c1',
      role: 'compaction',
      blocks: [
        {
          type: 'compaction',
          text: summaryText,
          extra: {
            snapshotLastMessageId: 'a2',
            compactedCount: 2,
            beforeTokens: 12000,
            afterTokens: expectedAfter,
          },
        },
      ],
      usage: {
        inputTokens: 500,
        outputTokens: 80,
        cacheReadInputTokens: 200,
        totalTokens: 580,
      },
      createdAt: '2026-11-19T10:02:00Z',
    };

    const compactedSnap = computeContextUsage({
      messages: [u1, a1, checkpoint, u2, a2],
      systemPrompt: 'sys',
      draft: '',
      attachments: [],
      contextWindow: 128000,
    });
    expect(compactedSnap.source).toBe('estimated');
    expect(compactedSnap.usedTokens).toBe(expectedAfter);
    expect(compactedSnap.compactedCount).toBe(2);
    expect(compactedSnap.activeMessageCount).toBe(2);
    expect(compactedSnap.canCompact).toBe(true);
    expect(compactedSnap.sessionTotalTokens).toBe(5000 + 12000 + 580);
    expect(compactedSnap.sessionCacheReadTokens).toBe(200);

    // Extra metadata must not affect estimateTextTokens on compaction block.
    const bloatedExtraCheckpoint: Message = {
      ...checkpoint,
      blocks: [
        {
          type: 'compaction',
          text: summaryText,
          extra: {
            snapshotLastMessageId: 'a2',
            compactedCount: 2,
            beforeTokens: 12000,
            afterTokens: expectedAfter,
            hugeNoise: 'x'.repeat(2000),
          },
        },
      ],
    };
    expect(
      computeContextUsage({
        messages: [u1, a1, bloatedExtraCheckpoint, u2, a2],
        systemPrompt: 'sys',
        draft: '',
        attachments: [],
      }).usedTokens,
    ).toBe(expectedAfter);

    // New reply after compaction switches back to reported.
    const afterReply = computeContextUsage({
      messages: [
        u1,
        a1,
        checkpoint,
        u2,
        a2,
        msg('u3', 'user', 'next'),
        msg('a3', 'assistant', 'ok', {
          inputTokens: 2000,
          outputTokens: 400,
          totalTokens: 2400,
          contextTokens: 2400,
        }),
      ],
      systemPrompt: 'sys',
      draft: '',
      attachments: [],
    });
    expect(afterReply.source).toBe('reported');
    expect(afterReply.usedTokens).toBe(2400);

    // Deleting checkpoint restores original pre-compaction context.
    const restored = computeContextUsage({
      messages: [u1, a1, u2, a2],
      systemPrompt: 'sys',
      draft: '',
      attachments: [],
    });
    expect(restored.source).toBe('reported');
    expect(restored.usedTokens).toBe(12000);
    expect(restored.compactedCount).toBe(0);
    expect(restored.activeMessageCount).toBe(4);
  });

  it('includes side-ref materials on anchor and trailing messages in hybrid mode and full active path in estimated mode', () => {
    const u1 = msg('u1', 'user', 'main question');
    const a1Base = msg('a1', 'assistant', 'main answer', {
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
      contextTokens: 1000,
    });
    const uSide: Message = { ...msg('uSide', 'user', 'side prompt'), parentId: '' };
    const aSide: Message = {
      ...msg('aSide', 'assistant', '这是一段非常详细的侧边分支助手参考资料，用于验证上下文用量统计增量。'),
      parentId: 'uSide',
    };

    const a1WithSideRef: Message = {
      ...a1Base,
      graphMeta: { sideRefs: [{ sourceMessageId: 'aSide', side: 'right' }] },
    };

    const withAnchorSideRef = computeContextUsage({
      messages: [u1, a1WithSideRef],
      allMessages: [u1, a1WithSideRef, uSide, aSide],
      draft: '',
      attachments: [],
      contextWindow: 10000,
    });
    expect(withAnchorSideRef.source).toBe('hybrid');
    expect(withAnchorSideRef.usedTokens).toBeGreaterThan(1000);

    // Removing sideRef drops usage right back to reported anchor.
    const withoutSideRef = computeContextUsage({
      messages: [u1, a1Base],
      allMessages: [u1, a1Base, uSide, aSide],
      draft: '',
      attachments: [],
      contextWindow: 10000,
    });
    expect(withoutSideRef.source).toBe('reported');
    expect(withoutSideRef.usedTokens).toBe(1000);

    // Estimated mode (no reported usage) includes sideRef tokens on active path.
    const uEst = {
      ...msg('uEst', 'user', 'question'),
      graphMeta: { sideRefs: [{ sourceMessageId: 'aSide', side: 'left' as const }] },
    };
    const estWith = computeContextUsage({
      messages: [uEst],
      allMessages: [uEst, uSide, aSide],
      draft: '',
      attachments: [],
    });
    const estWithout = computeContextUsage({
      messages: [msg('uEst', 'user', 'question')],
      allMessages: [msg('uEst', 'user', 'question'), uSide, aSide],
      draft: '',
      attachments: [],
    });
    expect(estWith.source).toBe('estimated');
    expect(estWith.usedTokens).toBeGreaterThan(estWithout.usedTokens);
  });
});
