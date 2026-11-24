import type {
  ActiveRunInfo,
  ContentBlock,
  Conversation,
  Message,
  StreamEvent,
  TokenUsage,
} from '../../core/types';
import { resolveActiveBranchMessages } from '../workbench/conversationGraph';

export type ChatRunState =
  | 'empty'
  | 'idle'
  | 'loading'
  | 'streaming'
  | 'aborted'
  | 'error';

export interface StreamingBlockBuffer {
  blockType: string;
  id: string;
  name: string;
  text: string;
  signature: string;
  completed?: boolean;
  finalized?: ContentBlock;
}

export interface StreamingDraft {
  messageId: string;
  providerId: string;
  modelId: string;
  insertIndex?: number;
  graphTarget?: { afterId: string; replaceId?: string };
  blockOrder: number[];
  blocksByIndex: Record<number, StreamingBlockBuffer>;
  usage?: TokenUsage;
  stopReason?: string;
}

export interface ChatState {
  conversation: Conversation | null;
  messages: Message[];
  runState: ChatRunState;
  errorCode: string | null;
  errorMessage: string | null;
  needsReloadAfterAbort: boolean;
  pendingInsertIndex: number | null;
  pendingRollback: { message: Message; index: number } | null;
  streaming: StreamingDraft | null;
  uiKeyByMsgId: Record<string, string>;
}

export const initialChatState: ChatState = {
  conversation: null,
  messages: [],
  runState: 'empty',
  errorCode: null,
  errorMessage: null,
  needsReloadAfterAbort: false,
  pendingInsertIndex: null,
  pendingRollback: null,
  streaming: null,
  uiKeyByMsgId: {},
};

export function insertMessageAt(
  messages: Message[],
  msg: Message,
  insertIndex?: number | null,
): Message[] {
  if (
    insertIndex === undefined ||
    insertIndex === null ||
    insertIndex < 0 ||
    insertIndex >= messages.length
  ) {
    return [...messages, msg];
  }
  return [
    ...messages.slice(0, insertIndex),
    msg,
    ...messages.slice(insertIndex),
  ];
}

export function isLocalMessageId(id: string): boolean {
  return id.startsWith('local-');
}

export function activeChatMessages(state: ChatState): Message[] {
  const path = resolveActiveBranchMessages(state.conversation, state.messages);
  if (path === state.messages) return path;
  const last = state.messages.at(-1);
  return state.streaming && !state.streaming.graphTarget && last?.id.startsWith('local-user-')
    ? [...path, last]
    : path;
}

export function streamingChatMessages(state: ChatState, active: Message[]): Message[] {
  const stream = state.streaming;
  if (!stream) return active;
  const draft = materializeStreamingMessage(state.conversation?.id ?? '', stream);
  if (!state.conversation?.graphState?.enabled) return insertMessageAt(active, draft, stream.insertIndex);
  const target = stream.graphTarget;
  if (target?.replaceId) return active.map((message) => message.id === target.replaceId ? draft : message);
  const index = target ? active.findIndex((message) => message.id === target.afterId) : -1;
  return insertMessageAt(active, draft, index >= 0 ? index + 1 : undefined);
}

function applyStreamMessage(state: ChatState, message: Message | null): Pick<ChatState, 'conversation' | 'messages'> {
  const { conversation, messages, streaming } = state;
  if (!message) return { conversation, messages };
  const graph = conversation?.graphState;
  if (!conversation || !graph?.enabled) {
    return { conversation, messages: insertMessageAt(messages, message, streaming?.insertIndex ?? state.pendingInsertIndex) };
  }
  const path = activeChatMessages(state);
  const target = streaming?.graphTarget;
  const afterId = target?.afterId ?? path.at(-1)?.id ?? '';
  const replaceId = target?.replaceId;
  if (replaceId) {
    const old = messages.find((item) => item.id === replaceId);
    const next = { ...message, parentId: old?.parentId, graphMeta: old?.graphMeta };
    return {
      conversation: { ...conversation, activeLeafId: conversation.activeLeafId === replaceId ? next.id : conversation.activeLeafId,
        graphState: { ...graph, branches: graph.branches?.map((slot) => slot.parentMessageId === replaceId ? { ...slot, parentMessageId: next.id } : slot) } },
      messages: messages.map((item) => item.id === replaceId ? next : item.parentId === replaceId ? { ...item, parentId: next.id } : item),
    };
  }
  const successor = target ? path[path.findIndex((item) => item.id === afterId) + 1]?.id : undefined;
  const next = { ...message, parentId: afterId };
  const branches = target
    ? graph.branches?.map((slot) => slot.id === graph.activeBranchId ? { ...slot, parentMessageId: next.id } : slot)
    : graph.branches?.filter((slot) => slot.id !== graph.activeBranchId);
  return {
    conversation: successor ? conversation : { ...conversation, activeLeafId: next.id,
      graphState: { ...graph, activeBranchId: target ? graph.activeBranchId : undefined, branches } },
    messages: [...(successor ? messages.map((item) => item.id === successor ? { ...item, parentId: next.id } : item) : messages), next],
  };
}

export function deriveRestState(messages: Message[]): {
  runState: ChatRunState;
  errorCode: string | null;
  errorMessage: string | null;
} {
  if (messages.length === 0) {
    return { runState: 'empty', errorCode: null, errorMessage: null };
  }
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' && last.stopReason === 'aborted') {
    return { runState: 'aborted', errorCode: null, errorMessage: null };
  }
  if (last.role === 'assistant' && last.stopReason === 'error') {
    return {
      runState: 'error',
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: last.errorMessage || '生成失败',
    };
  }
  return { runState: 'idle', errorCode: null, errorMessage: null };
}

export function bufferToBlock(buf: StreamingBlockBuffer): ContentBlock {
  if (buf.finalized) return buf.finalized;
  if (buf.blockType === 'thinking') {
    return {
      type: 'thinking',
      thinking: buf.text,
      ...(buf.signature ? { signature: buf.signature } : {}),
    };
  }
  if (buf.blockType === 'toolCall') {
    let args: unknown = buf.text;
    const trimmed = buf.text.trim();
    if (trimmed) {
      try {
        args = JSON.parse(trimmed);
      } catch {
        args = buf.text;
      }
    } else {
      args = undefined;
    }
    return {
      type: 'toolCall',
      id: buf.id,
      name: buf.name,
      ...(args !== undefined ? { arguments: args } : {}),
    };
  }
  return { type: 'text', text: buf.text };
}

export function materializeStreamingMessage(
  conversationId: string,
  draft: StreamingDraft,
  overrides?: { stopReason?: string; errorMessage?: string },
): Message {
  return {
    id: draft.messageId,
    conversationId,
    role: 'assistant',
    blocks: draft.blockOrder.map((idx) =>
      bufferToBlock(draft.blocksByIndex[idx]),
    ),
    providerId: draft.providerId,
    modelId: draft.modelId,
    usage: draft.usage,
    stopReason: overrides?.stopReason ?? draft.stopReason,
    errorMessage: overrides?.errorMessage,
    createdAt: new Date().toISOString(),
  };
}

export type ChatAction =
  | { type: 'CLEAR_SESSION' }
  | { type: 'LOAD_START'; conversationId?: string }
  | { type: 'LOAD_SUCCESS'; conversation: Conversation; messages: Message[] }
  | { type: 'LOAD_ERROR'; code: string; message: string }
  | { type: 'UPDATE_CONVERSATION_META'; conversation: Conversation }
  | {
      type: 'SEND_PREPARE_START';
      optimisticUser: Message;
      providerId: string;
      modelId: string;
      placeholderAssistantId: string;
    }
  | { type: 'SEND_PREPARE_FAILED'; optimisticUserId: string; code: string; message: string }
  | { type: 'SEND_PREPARE_ABORTED'; optimisticUserId: string }
  | {
      type: 'REGEN_PREPARE_START';
      targetMessageId: string;
      providerId: string;
      modelId: string;
      placeholderAssistantId: string;
    }
  | { type: 'REGEN_PREPARE_CONFIRMED'; targetMessageId: string }
  | { type: 'REGEN_PREPARE_FAILED'; code: string; message: string }
  | { type: 'ATTACH_RUN_START'; run: ActiveRunInfo }
  | { type: 'STREAM_EVENT'; event: StreamEvent; fallbackProviderId: string; fallbackModelId: string }
  | { type: 'STREAM_EOF_INCOMPLETE' }
  | { type: 'STREAM_NETWORK_ERROR'; code: string; message: string }
  | { type: 'ABORT_LOCAL' }
  | { type: 'RECONCILE_DETAIL'; conversation: Conversation; messages: Message[]; markReloadNeeded?: boolean }
  | { type: 'MARK_NEEDS_RELOAD' }
  | { type: 'UPDATE_MESSAGE'; message: Message }
  | { type: 'REPLACE_MESSAGE_BY_ID'; targetId: string; message: Message }
  | { type: 'REMOVE_MESSAGE'; messageId: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'CLEAR_SESSION':
      return {
        ...initialChatState,
      };

    case 'LOAD_START': {
      const sameConversation =
        Boolean(action.conversationId) &&
        state.conversation?.id === action.conversationId &&
        state.messages.length > 0;
      return {
        ...state,
        messages: sameConversation ? state.messages : [],
        runState: 'loading',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
        uiKeyByMsgId: sameConversation ? state.uiKeyByMsgId : {},
      };
    }

    case 'LOAD_SUCCESS': {
      const rest = deriveRestState(resolveActiveBranchMessages(action.conversation, action.messages));
      return {
        ...state,
        conversation: action.conversation,
        messages: action.messages,
        runState: rest.runState,
        errorCode: rest.errorCode,
        errorMessage: rest.errorMessage,
        needsReloadAfterAbort: false,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
        uiKeyByMsgId: {},
      };
    }

    case 'LOAD_ERROR':
      return {
        ...state,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
      };

    case 'UPDATE_CONVERSATION_META':
      return { ...state, conversation: action.conversation };

    case 'SEND_PREPARE_START':
      return {
        ...state,
        messages: [...state.messages, action.optimisticUser],
        runState: 'streaming',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: {
          messageId: action.placeholderAssistantId,
          providerId: action.providerId,
          modelId: action.modelId,
          blockOrder: [],
          blocksByIndex: {},
        },
      };

    case 'SEND_PREPARE_FAILED': {
      const nextMsgs = state.messages.filter(
        (m) => m.id !== action.optimisticUserId,
      );
      return {
        ...state,
        messages: nextMsgs,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
      };
    }

    case 'SEND_PREPARE_ABORTED': {
      const nextMsgs = state.messages.filter(
        (m) => m.id !== action.optimisticUserId,
      );
      const rest = deriveRestState(nextMsgs);
      return {
        ...state,
        messages: nextMsgs,
        runState: rest.runState,
        errorCode: rest.errorCode,
        errorMessage: rest.errorMessage,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
      };
    }

    case 'REGEN_PREPARE_START': {
      const idx = state.messages.findIndex(
        (m) => m.id === action.targetMessageId,
      );
      if (idx < 0) return state;

      const target = state.messages[idx];
      if (state.conversation?.graphState?.enabled) {
        const path = activeChatMessages(state);
        const successor = path[path.findIndex((message) => message.id === target.id) + 1];
        return {
          ...state, runState: 'streaming', errorCode: null, errorMessage: null,
          needsReloadAfterAbort: false, pendingInsertIndex: null, pendingRollback: null,
          streaming: {
            messageId: action.placeholderAssistantId, providerId: action.providerId, modelId: action.modelId,
            graphTarget: { afterId: target.id, replaceId: target.role !== 'user' ? target.id : successor?.role === 'assistant' ? successor.id : undefined },
            blockOrder: [], blocksByIndex: {},
          },
        };
      }
      let nextMessages = state.messages;
      let insertIndex = idx;
      let rollback: { message: Message; index: number } | null = null;
      let nextKeys = state.uiKeyByMsgId;

      if (target.role === 'user') {
        insertIndex = idx + 1;
        const nextMsg = state.messages[idx + 1];
        if (nextMsg && nextMsg.role === 'assistant') {
          rollback = { message: nextMsg, index: idx + 1 };
          nextMessages = [
            ...state.messages.slice(0, idx + 1),
            ...state.messages.slice(idx + 2),
          ];
          if (nextMsg.id in nextKeys) {
            nextKeys = { ...nextKeys };
            delete nextKeys[nextMsg.id];
          }
        }
      } else {
        rollback = { message: target, index: idx };
        nextMessages = [
          ...state.messages.slice(0, idx),
          ...state.messages.slice(idx + 1),
        ];
        if (target.id in nextKeys) {
          nextKeys = { ...nextKeys };
          delete nextKeys[target.id];
        }
      }

      return {
        ...state,
        messages: nextMessages,
        runState: 'streaming',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        pendingInsertIndex: insertIndex,
        pendingRollback: rollback,
        streaming: {
          messageId: action.placeholderAssistantId,
          providerId: action.providerId,
          modelId: action.modelId,
          insertIndex,
          blockOrder: [],
          blocksByIndex: {},
        },
        uiKeyByMsgId: nextKeys,
      };
    }

    case 'REGEN_PREPARE_CONFIRMED':
      return state.pendingRollback === null
        ? state
        : { ...state, pendingRollback: null };

    case 'REGEN_PREPARE_FAILED':
      return {
        ...state,
        messages: state.pendingRollback
          ? insertMessageAt(
              state.messages,
              state.pendingRollback.message,
              state.pendingRollback.index,
            )
          : state.messages,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
      };

    case 'ATTACH_RUN_START': {
      const { run } = action;
      let nextMessages = state.messages;
      let insertIndex: number | undefined;
      let graphTarget: { afterId: string; replaceId?: string } | undefined;

      if (state.conversation?.graphState?.enabled) {
        if (run.replaceMessageId || run.insertAfterMessageId) {
          graphTarget = {
            afterId: run.insertAfterMessageId || run.replaceMessageId || '',
            replaceId: run.replaceMessageId,
          };
        }
      } else if (run.replaceMessageId) {
        const idx = state.messages.findIndex((m) => m.id === run.replaceMessageId);
        if (idx >= 0) {
          insertIndex = idx;
          nextMessages = [
            ...state.messages.slice(0, idx),
            ...state.messages.slice(idx + 1),
          ];
        }
      } else if (run.insertAfterMessageId) {
        const idx = state.messages.findIndex((m) => m.id === run.insertAfterMessageId);
        if (idx >= 0) {
          insertIndex = idx + 1;
        }
      }

      return {
        ...state,
        messages: nextMessages,
        runState: 'streaming',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        pendingInsertIndex: insertIndex ?? null,
        pendingRollback: null,
        streaming: {
          messageId: run.messageId,
          providerId: run.providerId,
          modelId: run.modelId,
          insertIndex,
          graphTarget,
          blockOrder: [],
          blocksByIndex: {},
        },
      };
    }

    case 'STREAM_EVENT': {
      const ev = action.event;
      const convId = state.conversation?.id ?? ev.conversationId ?? '';

      const ensureDraft = (): StreamingDraft =>
        state.streaming ?? {
          messageId:
            ev.messageId ||
            `local-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          providerId: ev.providerId || action.fallbackProviderId,
          modelId: ev.modelId || action.fallbackModelId,
          insertIndex: state.pendingInsertIndex ?? undefined,
          blockOrder: [],
          blocksByIndex: {},
        };

      if (ev.type === 'message_start') {
        const draft = ensureDraft();
        const nextId = ev.messageId || draft.messageId;
        let nextKeys = state.uiKeyByMsgId;
        if (state.streaming && nextId !== draft.messageId) {
          const uiKey =
            state.uiKeyByMsgId[draft.messageId] ?? draft.messageId;
          nextKeys = { ...state.uiKeyByMsgId, [nextId]: uiKey };
        }
        return {
          ...state,
          runState: 'streaming',
          streaming: {
            ...draft,
            messageId: nextId,
            providerId: ev.providerId || draft.providerId,
            modelId: ev.modelId || draft.modelId,
          },
          uiKeyByMsgId: nextKeys,
        };
      }

      if (ev.type === 'block_start') {
        const draft = ensureDraft();
        const idx =
          ev.index !== undefined && ev.index !== null
            ? ev.index
            : draft.blockOrder.length;
        if (draft.blocksByIndex[idx]) {
          return { ...state, runState: 'streaming', streaming: draft };
        }
        const initialTool =
          ev.block && ev.block.type === 'toolCall' ? ev.block : undefined;
        const buf: StreamingBlockBuffer = {
          blockType: ev.blockType || ev.block?.type || 'text',
          id: initialTool ? String(initialTool.id ?? '') : '',
          name: initialTool ? String(initialTool.name ?? '') : '',
          text: '',
          signature: '',
          completed: false,
          finalized: ev.block,
        };
        return {
          ...state,
          runState: 'streaming',
          streaming: {
            ...draft,
            blockOrder: [...draft.blockOrder, idx],
            blocksByIndex: { ...draft.blocksByIndex, [idx]: buf },
          },
        };
      }

      if (ev.type === 'block_delta') {
        const draft = ensureDraft();
        const idx = ev.index !== undefined && ev.index !== null ? ev.index : 0;
        const existing = draft.blocksByIndex[idx];
        const nextOrder = existing
          ? draft.blockOrder
          : [...draft.blockOrder, idx];
        const base: StreamingBlockBuffer = existing ?? {
          blockType: ev.blockType || 'text',
          id: '',
          name: '',
          text: '',
          signature: '',
        };
        const delta = ev.delta ?? '';
        const updated: StreamingBlockBuffer =
          ev.deltaType === 'signature_delta'
            ? { ...base, finalized: undefined, signature: base.signature + delta }
            : { ...base, finalized: undefined, text: base.text + delta };

        return {
          ...state,
          runState: 'streaming',
          streaming: {
            ...draft,
            blockOrder: nextOrder,
            blocksByIndex: { ...draft.blocksByIndex, [idx]: updated },
          },
        };
      }

      if (ev.type === 'block_end') {
        const draft = ensureDraft();
        if (ev.index === undefined || ev.index === null) {
          return { ...state, runState: 'streaming', streaming: draft };
        }
        const idx = ev.index;
        const existing = draft.blocksByIndex[idx];
        if (!ev.block) {
          if (!existing) {
            return { ...state, runState: 'streaming', streaming: draft };
          }
          return {
            ...state,
            runState: 'streaming',
            streaming: {
              ...draft,
              blocksByIndex: {
                ...draft.blocksByIndex,
                [idx]: { ...existing, completed: true },
              },
            },
          };
        }
        const nextOrder = existing
          ? draft.blockOrder
          : [...draft.blockOrder, idx];
        const updated: StreamingBlockBuffer = existing
          ? { ...existing, finalized: ev.block, completed: true }
          : {
              blockType: ev.block.type,
              id: '',
              name: '',
              text: '',
              signature: '',
              completed: true,
              finalized: ev.block,
            };
        return {
          ...state,
          runState: 'streaming',
          streaming: {
            ...draft,
            blockOrder: nextOrder,
            blocksByIndex: { ...draft.blocksByIndex, [idx]: updated },
          },
        };
      }

      if (ev.type === 'message_delta') {
        const draft = ensureDraft();
        return {
          ...state,
          streaming: {
            ...draft,
            usage: ev.usage ?? draft.usage,
            stopReason: ev.stopReason || draft.stopReason,
          },
        };
      }

      if (ev.type === 'message_end') {
        const finalMsg =
          ev.message ??
          (state.streaming
            ? materializeStreamingMessage(convId, state.streaming, {
                stopReason: state.streaming.stopReason || 'stop',
              })
            : null);
        const updated = applyStreamMessage(state, finalMsg);
        const rest = deriveRestState(resolveActiveBranchMessages(updated.conversation, updated.messages));
        let nextKeys = state.uiKeyByMsgId;
        if (
          state.streaming &&
          finalMsg &&
          finalMsg.id !== state.streaming.messageId
        ) {
          const uiKey =
            state.uiKeyByMsgId[state.streaming.messageId] ??
            state.streaming.messageId;
          nextKeys = { ...state.uiKeyByMsgId, [finalMsg.id]: uiKey };
        }
        return {
          ...state,
          ...updated,
          pendingInsertIndex: null,
          streaming: null,
          runState: rest.runState,
          errorCode: rest.errorCode,
          errorMessage: rest.errorMessage,
          needsReloadAfterAbort: false,
          uiKeyByMsgId: nextKeys,
        };
      }

      if (ev.type === 'error') {
        const errMsg = ev.error?.message || '流式生成失败';
        const errCode = ev.error?.code || 'UPSTREAM_ERROR';
        const finalized = state.streaming
          ? materializeStreamingMessage(convId, state.streaming, {
              stopReason: 'error',
              errorMessage: errMsg,
            })
          : null;
        return {
          ...state,
          ...applyStreamMessage(state, finalized),
          pendingInsertIndex: null,
          streaming: null,
          runState: 'error',
          errorCode: errCode,
          errorMessage: errMsg,
        };
      }

      return state;
    }

    case 'ABORT_LOCAL': {
      if (state.pendingRollback) {
        const restored = insertMessageAt(
          state.messages,
          state.pendingRollback.message,
          state.pendingRollback.index,
        );
        const rest = deriveRestState(restored);
        return {
          ...state,
          messages: restored,
          pendingInsertIndex: null,
          pendingRollback: null,
          streaming: null,
          runState: rest.runState,
          errorCode: rest.errorCode,
          errorMessage: rest.errorMessage,
        };
      }
      const convId = state.conversation?.id ?? '';
      const partial =
        state.streaming && state.streaming.blockOrder.length > 0
          ? materializeStreamingMessage(convId, state.streaming, {
              stopReason: 'aborted',
            })
          : null;
      return {
        ...state,
        ...applyStreamMessage(state, partial),
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
        runState: 'aborted',
        errorCode: null,
        errorMessage: null,
      };
    }

    case 'STREAM_EOF_INCOMPLETE': {
      const convId = state.conversation?.id ?? '';
      const partial = state.streaming
        ? materializeStreamingMessage(convId, state.streaming, {
            stopReason: 'error',
            errorMessage: '响应流意外中断，未收到结束标记',
          })
        : null;
      return {
        ...state,
        ...applyStreamMessage(state, partial),
        pendingInsertIndex: null,
        streaming: null,
        runState: 'error',
        errorCode: 'STREAM_INCOMPLETE',
        errorMessage: '响应流意外中断，未收到结束标记',
      };
    }

    case 'STREAM_NETWORK_ERROR': {
      const convId = state.conversation?.id ?? '';
      const partial = state.streaming
        ? materializeStreamingMessage(convId, state.streaming, {
            stopReason: 'error',
            errorMessage: action.message,
          })
        : null;
      return {
        ...state,
        ...applyStreamMessage(state, partial),
        pendingInsertIndex: null,
        streaming: null,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
      };
    }

    case 'RECONCILE_DETAIL': {
      const rest = deriveRestState(resolveActiveBranchMessages(action.conversation, action.messages));
      let nextKeys = state.uiKeyByMsgId;
      if (state.messages.length === action.messages.length) {
        for (let i = 0; i < state.messages.length; i++) {
          const prevMsg = state.messages[i];
          const nextMsg = action.messages[i];
          if (
            prevMsg.id !== nextMsg.id &&
            prevMsg.role === 'assistant' &&
            nextMsg.role === 'assistant' &&
            isLocalMessageId(prevMsg.id)
          ) {
            const uiKey = state.uiKeyByMsgId[prevMsg.id] ?? prevMsg.id;
            nextKeys = { ...nextKeys, [nextMsg.id]: uiKey };
          }
        }
      }
      return {
        ...state,
        conversation: action.conversation,
        messages: action.messages,
        runState: rest.runState,
        errorCode: rest.errorCode,
        errorMessage: rest.errorMessage,
        needsReloadAfterAbort: action.markReloadNeeded ?? false,
        pendingInsertIndex: null,
        pendingRollback: null,
        streaming: null,
        uiKeyByMsgId: nextKeys,
      };
    }

    case 'MARK_NEEDS_RELOAD':
      return {
        ...state,
        needsReloadAfterAbort: true,
      };

    case 'UPDATE_MESSAGE':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.message.id ? action.message : m,
        ),
      };

    case 'REPLACE_MESSAGE_BY_ID': {
      let nextKeys = state.uiKeyByMsgId;
      if (action.targetId !== action.message.id) {
        const uiKey = state.uiKeyByMsgId[action.targetId] ?? action.targetId;
        nextKeys = { ...state.uiKeyByMsgId, [action.message.id]: uiKey };
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.targetId ? action.message : state.conversation?.graphState?.enabled && m.parentId === action.targetId ? { ...m, parentId: action.message.id } : m,
        ),
        uiKeyByMsgId: nextKeys,
      };
    }

    case 'REMOVE_MESSAGE': {
      const next = state.messages.filter((m) => m.id !== action.messageId);
      const rest = deriveRestState(next);
      return {
        ...state,
        messages: next,
        runState: rest.runState,
        errorCode: rest.errorCode,
        errorMessage: rest.errorMessage,
      };
    }

    default:
      return state;
  }
}
