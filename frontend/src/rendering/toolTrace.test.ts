import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/types';
import {
  buildPairedToolEntries,
  buildProcessTrace,
  firstNonEmptyLine,
  summarizeToolArgs,
  toolIconName,
} from './toolTrace';

describe('toolTrace helpers', () => {
  it('maps native, builtin, and generic MCP tool names to semantic SVG icons', () => {
    expect(toolIconName('read')).toBe('fileText');
    expect(toolIconName('write')).toBe('edit');
    expect(toolIconName('edit')).toBe('edit');
    expect(toolIconName('ls')).toBe('folder');
    expect(toolIconName('find')).toBe('search');
    expect(toolIconName('grep')).toBe('search');
    expect(toolIconName('bash')).toBe('terminal');
    expect(toolIconName('skill')).toBe('plugin');
    expect(toolIconName('get_current_time')).toBe('clock');
    expect(toolIconName('mcp_custom_query')).toBe('wrench');
  });

  it('extracts compact single-line argument summaries across native, builtin, and MCP tools', () => {
    expect(summarizeToolArgs('read', { path: 'src/app.ts' })).toBe('src/app.ts');
    expect(summarizeToolArgs('read', { path: 'src/app.ts', offset: 42, limit: 100 })).toBe(
      'src/app.ts:L42',
    );
    expect(summarizeToolArgs('write', { path: 'docs/plan.md', content: 'hello' })).toBe(
      'docs/plan.md',
    );
    expect(summarizeToolArgs('edit', { path: 'main.go', oldText: 'a', newText: 'b' })).toBe(
      'main.go',
    );
    expect(summarizeToolArgs('ls', { path: 'backend/internal' })).toBe('backend/internal');
    expect(summarizeToolArgs('find', { pattern: '*.test.ts', path: 'frontend/src' })).toBe(
      '*.test.ts in frontend/src',
    );
    expect(summarizeToolArgs('grep', { pattern: 'TODO', path: '.' })).toBe('TODO');
    expect(summarizeToolArgs('bash', { command: '\n  go test -race ./...\n  echo done' })).toBe(
      'go test -race ./...',
    );
    expect(summarizeToolArgs('skill', { name: 'demo-skill' })).toBe('demo-skill');
    expect(summarizeToolArgs('get_current_time', { timezone: 'Asia/Shanghai' })).toBe(
      'Asia/Shanghai',
    );
    expect(summarizeToolArgs('lookup', { q: 'alpha beta' })).toBe('alpha beta');
    expect(summarizeToolArgs('summarize', { depth: 2 })).toBe('2');
    expect(summarizeToolArgs('noop', {})).toBe('');
    expect(summarizeToolArgs('noop', null)).toBe('');

    const longCmd = `echo ${'x'.repeat(120)}`;
    const summarized = summarizeToolArgs('bash', { command: longCmd }, 40);
    expect(summarized.length).toBeLessThanOrEqual(40);
    expect(summarized.endsWith('…')).toBe(true);
  });

  it('extracts first non-empty line for interleaved thinking preview', () => {
    expect(firstNonEmptyLine('\n\n  First real line  \nSecond line')).toBe('First real line');
    expect(firstNonEmptyLine('   \n  ')).toBe('');
  });

  it('pairs parallel calls, repeated IDs, and orphan results without grouping into rounds', () => {
    const blocks: ContentBlock[] = [
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
      { type: 'toolCall', id: 'c2', name: 'grep', arguments: { pattern: 'foo' } },
      { type: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'A' },
      { type: 'toolResult', toolCallId: 'c2', toolName: 'grep', content: 'B' },
      { type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'a.txt' } },
      { type: 'toolResult', toolCallId: 'c1', toolName: 'edit', content: 'ok' },
      { type: 'toolResult', toolCallId: 'orphan', toolName: 'orphan', content: 'unmatched' },
    ];

    const paired = buildPairedToolEntries(blocks);
    expect(paired.entries.size).toBe(4);
    expect(paired.entries.get(0)?.resultIndex).toBe(2);
    expect(paired.entries.get(1)?.resultIndex).toBe(3);
    expect(paired.entries.get(4)?.resultIndex).toBe(5);
    expect(paired.entries.get(6)?.result?.content).toBe('unmatched');
    expect(Array.from(paired.pairedResultIndexes).sort((a, b) => a - b)).toEqual([2, 3, 5]);

    const trace = buildProcessTrace(blocks, paired);
    expect(trace).toEqual({
      start: 0,
      end: 6,
      toolCount: 4,
      thinkingCount: 0,
      stepCount: 4,
    });
  });

  it('omits outer process trace for a single standalone tool call', () => {
    const blocks: ContentBlock[] = [
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
      { type: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'A' },
      { type: 'text', text: 'Final answer' },
    ];
    const paired = buildPairedToolEntries(blocks);
    expect(buildProcessTrace(blocks, paired)).toBeUndefined();
  });
});
