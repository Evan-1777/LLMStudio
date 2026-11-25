import { GatewayClient, GatewayError } from '../../core/gateway';
import { decodeUpstreamSseStream } from '../../core/localStreamDecoders';
import type {
  CompactionMeta,
  ContentBlock,
  Conversation,
  Message,
  ProviderConfig,
  TokenUsage,
  TopicScope,
} from '../../core/types';
import { estimateCompactionAfterTokens } from '../workbench/contextUsage';
import {
  formatError,
  isAbortError,
  type ChatDispatch,
  type CompactConversationResult,
} from './chatErrors';
import { bufferToBlock, type StreamingBlockBuffer } from './chatReducer';
import { sendLocalHttpFetch } from './localChatExecutor';

export interface CompactExecutorDeps {
  gateway: GatewayClient;
  isDesktop: boolean;
  providers: ProviderConfig[];
  conversation: Conversation;
  getMessages: () => Message[];
  reqScope?: TopicScope;
  epoch: number;
  getCurrentEpoch: () => number;
  signal: AbortSignal;
  dispatch: ChatDispatch;
  upsertLocalConversation: (conv: Conversation, scope?: TopicScope) => void;
}

export async function runCompactConversation(
  deps: CompactExecutorDeps,
  opts: { providerId: string; modelId: string },
): Promise<CompactConversationResult> {
  const {
    gateway,
    isDesktop,
    providers,
    conversation: conv,
    getMessages,
    reqScope,
    epoch,
    getCurrentEpoch,
    signal,
    dispatch,
    upsertLocalConversation,
  } = deps;
  const provider = providers.find((p) => p.id === opts.providerId);

  try {
    if (isDesktop || conv.mode === 'agent' || !provider?.localRequest) {
      const res = await gateway.compactConversation(
        conv.id,
        {
          providerId: opts.providerId,
          modelId: opts.modelId,
        },
        signal,
        reqScope,
      );
      if (epoch !== getCurrentEpoch() || signal.aborted) {
        return { ok: false, error: '压缩已取消' };
      }
      dispatch({
        type: 'LOAD_SUCCESS',
        conversation: res.conversation,
        messages: res.messages,
      });
      upsertLocalConversation(res.conversation, reqScope);
      return {
        ok: true,
        beforeTokens: res.meta.beforeTokens,
        afterTokens: res.meta.afterTokens,
      };
    }

    const prepared = await gateway.prepareLocalCompact(
      conv.id,
      {
        providerId: opts.providerId,
        modelId: opts.modelId,
        credentialEnvelope: true,
      },
      signal,
    );
    if (epoch !== getCurrentEpoch() || signal.aborted) {
      return { ok: false, error: '压缩已取消' };
    }

    const upstreamRes = await sendLocalHttpFetch(
      gateway,
      prepared.request,
      provider,
      opts.providerId,
      signal,
    );
    if (!upstreamRes.ok) {
      const snippet = await upstreamRes.text().catch(() => '');
      throw new GatewayError(
        `HTTP_${upstreamRes.status}`,
        snippet.trim()
          ? `上游返回 HTTP ${upstreamRes.status}: ${snippet.trim().slice(0, 300)}`
          : `上游返回 HTTP ${upstreamRes.status}`,
        upstreamRes.status,
      );
    }
    if (!upstreamRes.body) {
      throw new GatewayError('STREAM_EMPTY', '上游未返回事件流');
    }

    const accBlocks: Record<number, StreamingBlockBuffer> = {};
    const accOrder: number[] = [];
    let accUsage: TokenUsage | undefined;
    let streamErrorMsg = '';

    await decodeUpstreamSseStream(
      prepared.apiFormat,
      upstreamRes.body,
      {
        conversationId: conv.id,
        providerId: prepared.providerId,
        modelId: prepared.modelId,
      },
      (ev) => {
        if (epoch !== getCurrentEpoch() || signal.aborted) return;
        if (ev.type === 'block_start' && ev.index !== undefined) {
          if (!accBlocks[ev.index]) {
            accOrder.push(ev.index);
            accBlocks[ev.index] = {
              blockType: ev.blockType || ev.block?.type || 'text',
              id: '',
              name: '',
              text: '',
              signature: '',
              finalized: ev.block,
            };
          }
        } else if (ev.type === 'block_delta' && ev.index !== undefined) {
          let buf = accBlocks[ev.index];
          if (!buf) {
            accOrder.push(ev.index);
            buf = {
              blockType: ev.blockType || 'text',
              id: '',
              name: '',
              text: '',
              signature: '',
            };
            accBlocks[ev.index] = buf;
          }
          buf.finalized = undefined;
          if (ev.deltaType !== 'signature_delta') {
            buf.text += ev.delta ?? '';
          }
        } else if (
          ev.type === 'block_end' &&
          ev.index !== undefined &&
          ev.block
        ) {
          if (!accBlocks[ev.index]) {
            accOrder.push(ev.index);
            accBlocks[ev.index] = {
              blockType: ev.block.type,
              id: '',
              name: '',
              text: '',
              signature: '',
              finalized: ev.block,
            };
          } else {
            accBlocks[ev.index].finalized = ev.block;
          }
        } else if (ev.type === 'message_delta' && ev.usage) {
          accUsage = ev.usage;
        } else if (ev.type === 'error' && ev.error?.message) {
          streamErrorMsg = ev.error.message;
        }
      },
    );

    if (epoch !== getCurrentEpoch() || signal.aborted) {
      return { ok: false, error: '压缩已取消' };
    }
    if (streamErrorMsg) {
      throw new GatewayError('UPSTREAM_ERROR', streamErrorMsg);
    }

    const summary = accOrder
      .map((idx) => bufferToBlock(accBlocks[idx]))
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!summary) {
      throw new GatewayError('UPSTREAM_ERROR', '压缩摘要返回为空');
    }

    const curMessages = getMessages();
    let keptMessages: Message[] = [];
    if (prepared.plan.insertAfterMessageId) {
      const afterIdx = curMessages.findIndex(
        (m) => m.id === prepared.plan.insertAfterMessageId,
      );
      if (afterIdx >= 0) {
        keptMessages = curMessages.slice(afterIdx + 1);
      } else if (prepared.plan.keptCount > 0) {
        keptMessages = curMessages.slice(-prepared.plan.keptCount);
      }
    }
    const afterTokens = estimateCompactionAfterTokens(
      prepared.systemPrompt,
      summary,
      keptMessages,
    );
    const meta: CompactionMeta = {
      snapshotLastMessageId: prepared.plan.snapshotLastMessageId,
      compactedCount: prepared.plan.compactedCount,
      beforeTokens: prepared.plan.beforeTokens,
      afterTokens,
    };

    await gateway.createMessage(
      conv.id,
      {
        role: 'compaction',
        blocks: [{ type: 'compaction', text: summary, extra: meta }],
        providerId: prepared.providerId,
        modelId: prepared.modelId,
        ...(accUsage ? { usage: accUsage } : {}),
        stopReason: 'stop',
        ...(prepared.plan.insertAfterMessageId
          ? { afterMessageId: prepared.plan.insertAfterMessageId }
          : conv.graphState?.enabled
            ? {
                parentId: prepared.plan.snapshotLastMessageId,
                consumeBranchId: conv.graphState.activeBranchId,
              }
            : {}),
      },
      signal,
    );
    if (epoch !== getCurrentEpoch() || signal.aborted) {
      return { ok: false, error: '压缩已取消' };
    }

    const detail = await gateway.getConversationDetail(conv.id, signal);
    if (epoch !== getCurrentEpoch()) {
      return { ok: false, error: '压缩已取消' };
    }
    dispatch({
      type: 'LOAD_SUCCESS',
      conversation: detail.conversation,
      messages: detail.messages,
    });
    upsertLocalConversation(detail.conversation);
    return {
      ok: true,
      beforeTokens: prepared.plan.beforeTokens,
      afterTokens,
    };
  } catch (err) {
    if (isAbortError(err) || epoch !== getCurrentEpoch()) {
      return { ok: false, error: '压缩已取消' };
    }
    return { ok: false, error: formatError(err).message };
  }
}
