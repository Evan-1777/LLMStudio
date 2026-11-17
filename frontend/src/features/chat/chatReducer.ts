import type {
  ContentBlock,
  Conversation,
  Message,
  ReasoningEffort,
  StreamEvent,
  TokenUsage,
} from '../../core/types';
import { REASONING_EFFORT_LEVELS } from '../../core/types';

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
  finalized?: ContentBlock;
}

export interface StreamingDraft {
  messageId: string;
  providerId: string;
  modelId: string;
  blockOrder: number[];
  blocksByIndex: Record<number, StreamingBlockBuffer>;
  usage?: TokenUsage;
  stopReason?: string;
}

export interface ChatState {
  conversation: Conversation | null;
  messages: Message[];
  runState: ChatRunState;
  reasoningEffort: ReasoningEffort;
  errorCode: string | null;
  errorMessage: string | null;
  needsReloadAfterAbort: boolean;
  streaming: StreamingDraft | null;
}

export const initialChatState: ChatState = {
  conversation: null,
  messages: [],
  runState: 'empty',
  reasoningEffort: 'none',
  errorCode: null,
  errorMessage: null,
  needsReloadAfterAbort: false,
  streaming: null,
};

export function isLocalMessageId(id: string): boolean {
  return id.startsWith('local-');
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

function bufferToBlock(buf: StreamingBlockBuffer): ContentBlock {
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
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; conversation: Conversation; messages: Message[] }
  | { type: 'LOAD_ERROR'; code: string; message: string }
  | { type: 'SET_EFFORT'; effort: ReasoningEffort }
  | { type: 'UPDATE_CONVERSATION_META'; conversation: Conversation }
  | { type: 'SEND_PREPARE_START'; optimisticUser: Message }
  | { type: 'SEND_PREPARE_FAILED'; optimisticUserId: string; code: string; message: string }
  | { type: 'REGEN_PREPARE_START' }
  | { type: 'REGEN_PREPARE_CONFIRMED'; targetMessageId: string }
  | { type: 'REGEN_PREPARE_FAILED'; code: string; message: string }
  | { type: 'STREAM_EVENT'; event: StreamEvent; fallbackProviderId: string; fallbackModelId: string }
  | { type: 'STREAM_EOF_INCOMPLETE' }
  | { type: 'STREAM_NETWORK_ERROR'; code: string; message: string }
  | { type: 'ABORT_LOCAL' }
  | { type: 'RECONCILE_DETAIL'; conversation: Conversation; messages: Message[]; markReloadNeeded?: boolean }
  | { type: 'MARK_NEEDS_RELOAD' }
  | { type: 'REMOVE_MESSAGE'; messageId: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'CLEAR_SESSION':
      return {
        ...initialChatState,
      };

    case 'LOAD_START':
      return {
        ...state,
        messages: [],
        runState: 'loading',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        streaming: null,
      };

    case 'LOAD_SUCCESS': {
      const convEffort = action.conversation.params?.reasoningEffort;
      const reasoningEffort = REASONING_EFFORT_LEVELS.includes(
        convEffort as ReasoningEffort,
      )
        ? (convEffort as ReasoningEffort)
        : 'none';
      const rest = deriveRestState(action.messages);
      return {
        ...state,
        conversation: action.conversation,
        messages: action.messages,
        reasoningEffort,
        runState: rest.runState,
        errorCode: rest.errorCode,
        errorMessage: rest.errorMessage,
        needsReloadAfterAbort: false,
        streaming: null,
      };
    }

    case 'LOAD_ERROR':
      return {
        ...state,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
        streaming: null,
      };

    case 'SET_EFFORT':
      return { ...state, reasoningEffort: action.effort };

    case 'UPDATE_CONVERSATION_META':
      return { ...state, conversation: action.conversation };

    case 'SEND_PREPARE_START':
      return {
        ...state,
        messages: [...state.messages, action.optimisticUser],
        runState: 'loading',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        streaming: null,
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
        streaming: null,
      };
    }

    case 'REGEN_PREPARE_START':
      return {
        ...state,
        runState: 'loading',
        errorCode: null,
        errorMessage: null,
        needsReloadAfterAbort: false,
        streaming: null,
      };

    case 'REGEN_PREPARE_CONFIRMED': {
      const idx = state.messages.findIndex(
        (m) => m.id === action.targetMessageId,
      );
      if (idx < 0) return state;
      const target = state.messages[idx];
      const truncated =
        target.role === 'user'
          ? state.messages.slice(0, idx + 1)
          : state.messages.slice(0, idx);
      return {
        ...state,
        messages: truncated,
      };
    }

    case 'REGEN_PREPARE_FAILED':
      return {
        ...state,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
        streaming: null,
      };

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
          blockOrder: [],
          blocksByIndex: {},
        };

      if (ev.type === 'message_start') {
        const draft = ensureDraft();
        return {
          ...state,
          runState: 'streaming',
          streaming: {
            ...draft,
            messageId: ev.messageId || draft.messageId,
            providerId: ev.providerId || draft.providerId,
            modelId: ev.modelId || draft.modelId,
          },
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
        if (ev.index === undefined || ev.index === null || !ev.block) {
          return { ...state, runState: 'streaming', streaming: draft };
        }
        const idx = ev.index;
        const existing = draft.blocksByIndex[idx];
        const nextOrder = existing
          ? draft.blockOrder
          : [...draft.blockOrder, idx];
        const updated: StreamingBlockBuffer = existing
          ? { ...existing, finalized: ev.block }
          : {
              blockType: ev.block.type,
              id: '',
              name: '',
              text: '',
              signature: '',
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
        const nextMessages = finalMsg
          ? [...state.messages, finalMsg]
          : state.messages;
        const rest = deriveRestState(nextMessages);
        return {
          ...state,
          messages: nextMessages,
          streaming: null,
          runState: rest.runState,
          errorCode: rest.errorCode,
          errorMessage: rest.errorMessage,
          needsReloadAfterAbort: false,
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
          messages: finalized
            ? [...state.messages, finalized]
            : state.messages,
          streaming: null,
          runState: 'error',
          errorCode: errCode,
          errorMessage: errMsg,
        };
      }

      return state;
    }

    case 'ABORT_LOCAL': {
      const convId = state.conversation?.id ?? '';
      const partial = state.streaming
        ? materializeStreamingMessage(convId, state.streaming, {
            stopReason: 'aborted',
          })
        : null;
      return {
        ...state,
        messages: partial ? [...state.messages, partial] : state.messages,
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
        messages: partial ? [...state.messages, partial] : state.messages,
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
        messages: partial ? [...state.messages, partial] : state.messages,
        streaming: null,
        runState: 'error',
        errorCode: action.code,
        errorMessage: action.message,
      };
    }

    case 'RECONCILE_DETAIL': {
      const rest = deriveRestState(action.messages);
      return {
        ...state,
        conversation: action.conversation,
        messages: action.messages,
        runState: rest.runState,
        errorCode: rest.errorCode,
        errorMessage: rest.errorMessage,
        needsReloadAfterAbort: action.markReloadNeeded ?? false,
        streaming: null,
      };
    }

    case 'MARK_NEEDS_RELOAD':
      return {
        ...state,
        needsReloadAfterAbort: true,
      };

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
