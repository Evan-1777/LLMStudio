import type { Dispatch } from 'react';
import { GatewayError } from '../../core/gateway';
import type { LocalCacheResultData, TopicScope } from '../../core/types';
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
