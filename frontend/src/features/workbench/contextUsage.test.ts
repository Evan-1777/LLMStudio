import { describe, expect, it } from 'vitest';
import type { Message } from '../../core/types';
import { computeContextUsage, formatCompactTokens } from './contextUsage';

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
});
