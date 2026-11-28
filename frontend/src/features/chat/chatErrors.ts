import type { Dispatch } from 'react';
import { GatewayError } from '../../core/gateway';
import type { LocalCacheResultData, StreamEvent, TopicScope } from '../../core/types';
import type { chatReducer } from './chatReducer';

export type ChatAction = Parameters<typeof chatReducer>[1];
export type ChatDispatch = Dispatch<ChatAction>;

export interface CompactConversationResult {
  ok: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  error?: string;
}

export interface GenerationRun {
  id: number;
  epoch: number;
  connectionEpoch: number;
  conversationId: string;
  scope: TopicScope | undefined;
  ctrl: AbortController;
  detachedAgent: boolean;
  detached: boolean;
  aborted: boolean;
  released: boolean;
  streamOpened?: boolean;
}

function blockText(block: StreamEvent['block']): string {
  if (!block || !('text' in block) || typeof block.text !== 'string') return '';
  return block.text;
}

function blockThinking(block: StreamEvent['block']): boolean {
  if (!block) return false;
  const thinking = 'thinking' in block && typeof block.thinking === 'string' ? block.thinking : '';
  const signature = 'signature' in block && typeof block.signature === 'string' ? block.signature : '';
  return Boolean(thinking || signature);
}

function blockName(block: StreamEvent['block']): string {
  if (!block || !('name' in block) || typeof block.name !== 'string') return '';
  return block.name.trim();
}

export function isSubstantiveAssistantEvent(ev: StreamEvent): boolean {
  if (ev.type === 'message_end') {
    if (ev.rolledBack || !ev.message) return false;
    return ev.message.blocks.some((block) => {
      if (block.type === 'text') return Boolean(blockText(block));
      if (block.type === 'thinking') return blockThinking(block);
      if (block.type === 'toolCall') return Boolean(blockName(block));
      return block.type === 'toolResult' || block.type === 'image';
    });
  }
  if (ev.blockType === 'webSearch') return false;
  if (ev.type !== 'block_start' && ev.type !== 'block_delta' && ev.type !== 'block_end') {
    return false;
  }
  const blockType = ev.blockType || ev.block?.type || '';
  if (blockType === 'text') return Boolean(ev.delta || blockText(ev.block));
  if (blockType === 'thinking') return Boolean(ev.delta) || blockThinking(ev.block);
  if (blockType === 'toolCall') return Boolean(blockName(ev.block));
  return blockType === 'toolResult' || blockType === 'image';
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

export function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof GatewayError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'NETWORK_ERROR', message: err.message };
  }
  return { code: 'NETWORK_ERROR', message: '请求失败' };
}

export function extractSafeCacheResult(
  status: number,
  rawText: string,
): LocalCacheResultData {
  const out: LocalCacheResultData = {};
  try {
    const parsed = JSON.parse(rawText) as {
      name?: unknown;
      expireTime?: unknown;
      error?: { code?: unknown; status?: unknown; message?: unknown };
      message?: unknown;
    };
    if (status >= 200 && status < 300) {
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        out.name = parsed.name.trim();
      }
      if (typeof parsed.expireTime === 'string' && parsed.expireTime.trim()) {
        out.expireTime = parsed.expireTime.trim();
      }
      return out;
    }
    const errObj = parsed.error;
    if (errObj && typeof errObj === 'object') {
      if (typeof errObj.status === 'string' && errObj.status) {
        out.errorCode = errObj.status;
      } else if (
        typeof errObj.code === 'number' ||
        typeof errObj.code === 'string'
      ) {
        out.errorCode = String(errObj.code);
      }
      if (typeof errObj.message === 'string' && errObj.message) {
        out.errorMessage = errObj.message.slice(0, 500);
      }
    } else if (typeof parsed.message === 'string' && parsed.message) {
      out.errorMessage = parsed.message.slice(0, 500);
    }
  } catch {
    if (status >= 400 && rawText.trim()) {
      out.errorMessage = rawText.trim().slice(0, 500);
    }
  }
  return out;
}
