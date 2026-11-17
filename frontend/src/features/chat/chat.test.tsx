import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '../../app/AppProvider';
import { ChatProvider, useChat } from './ChatProvider';
import { chatReducer, initialChatState } from './chatReducer';
import { MessageActions } from './MessageActions';
import type { Conversation, Message } from '../../core/types';

function makeConv(id = 'c1'): Conversation {
  return {
    id,
    assistantId: 'default',
    title: 'Demo',
    providerId: 'openai',
    modelId: 'gpt-4.1',
    params: {},
    syncEnabled: false,
    syncState: 'local_only',
    syncVersion: 0,
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
  };
}

describe('chatReducer and ChatProvider', () => {
  it('handles index=0, interleaved blocks, signature deltas, toolCall JSON args, and message_end override', () => {
    let s = chatReducer(initialChatState, {
      type: 'LOAD_SUCCESS',
      conversation: makeConv(),
      messages: [],
    });

    s = chatReducer(s, {
      type: 'SEND_PREPARE_START',
      optimisticUser: {
        id: 'local-u1',
        conversationId: 'c1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        createdAt: '2026-11-17T00:00:00Z',
      },
    });

    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: { type: 'message_start', messageId: 'm-asst' },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: { type: 'block_start', index: 0, blockType: 'thinking' },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_delta',
        index: 0,
        blockType: 'thinking',
        deltaType: 'thinking_delta',
        delta: 'step1',
      },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_delta',
        index: 0,
        blockType: 'thinking',
        deltaType: 'signature_delta',
        delta: 'sig-abc',
      },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_start',
        index: 1,
        blockType: 'toolCall',
        block: { type: 'toolCall', id: 'tc1', name: 'lookup' },
      },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_delta',
        index: 1,
        blockType: 'toolCall',
        deltaType: 'toolcall_delta',
        delta: '{"q":"go"}',
      },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: { type: 'block_start', index: 2, blockType: 'text' },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_delta',
        index: 2,
        blockType: 'text',
        deltaType: 'text_delta',
        delta: 'Answer',
      },
    });

    expect(s.streaming?.blockOrder).toEqual([0, 1, 2]);
    expect(s.streaming?.blocksByIndex[0].signature).toBe('sig-abc');

    const finalAssistant: Message = {
      id: 'm-asst',
      conversationId: 'c1',
      role: 'assistant',
      blocks: [
        { type: 'thinking', thinking: 'step1', signature: 'sig-abc' },
        { type: 'toolCall', id: 'tc1', name: 'lookup', arguments: { q: 'go' } },
        { type: 'text', text: 'Answer final' },
      ],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      stopReason: 'stop',
      createdAt: '2026-11-17T00:00:01Z',
    };

    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: { type: 'message_end', message: finalAssistant },
    });

    expect(s.runState).toBe('idle');
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].usage?.totalTokens).toBe(30);
    expect(s.messages[1].blocks[1]).toEqual({
      type: 'toolCall',
      id: 'tc1',
      name: 'lookup',
      arguments: { q: 'go' },
    });
  });

  it('treats missing message_end EOF as error and keeps history intact when regenerate Prepare fails', async () => {
    const encoder = new TextEncoder();
    let streamCalls = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/conversations/c1') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            conversation: makeConv(),
            messages: [
              {
                id: 'u1',
                conversationId: 'c1',
                role: 'user',
                blocks: [{ type: 'text', text: 'Q1' }],
                createdAt: '2026-11-17T00:00:00Z',
              },
              {
                id: 'a1',
                conversationId: 'c1',
                role: 'assistant',
                blocks: [{ type: 'text', text: 'A1' }],
                stopReason: 'stop',
                createdAt: '2026-11-17T00:00:01Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/messages/stream')) {
        streamCalls++;
        if (streamCalls === 1) {
          // Prepare error: must NOT truncate history!
          return new Response(
            JSON.stringify({ code: 'UPSTREAM_ERROR', message: '502 bad gateway' }),
            { status: 502 },
          );
        }
        // EOF without message_end
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              encoder.encode(
                'data: {"type":"message_start","messageId":"a2"}\n\n' +
                  'data: {"type":"block_delta","index":0,"blockType":"text","deltaType":"text_delta","delta":"partial"}\n\n',
              ),
            );
            c.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('{}', { status: 200 });
    });

    function Harness() {
      const { state, loadConversation, regenerateMessage, sendMessage } = useChat();
      return (
        <div>
          <span data-testid="run-state">{state.runState}</span>
          <span data-testid="msg-ids">{state.messages.map((m) => m.id).join(',')}</span>
          <span data-testid="err-msg">{state.errorMessage ?? ''}</span>
          <button type="button" onClick={() => void loadConversation('c1')}>
            load
          </button>
          <button
            type="button"
            onClick={() =>
              void regenerateMessage({
                targetMessageId: 'u1',
                providerId: 'openai',
                modelId: 'gpt-4.1',
              })
            }
          >
            regen
          </button>
          <button
            type="button"
            onClick={() =>
              void sendMessage({
                conversationId: 'c1',
                blocks: [{ type: 'text', text: 'Q2' }],
                text: 'Q2',
                providerId: 'openai',
                modelId: 'gpt-4.1',
              })
            }
          >
            send-eof
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock} skipInitialBootstrap>
        <ChatProvider>
          <Harness />
        </ChatProvider>
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => {
      expect(screen.getByTestId('msg-ids')).toHaveTextContent('u1,a1');
    });

    await user.click(screen.getByRole('button', { name: 'regen' }));
    await waitFor(() => {
      expect(screen.getByTestId('run-state')).toHaveTextContent('error');
    });
    expect(screen.getByTestId('msg-ids')).toHaveTextContent('u1,a1');
    expect(screen.getByTestId('err-msg')).toHaveTextContent('502 bad gateway');

    await user.click(screen.getByRole('button', { name: 'send-eof' }));
    await waitFor(() => {
      expect(screen.getByTestId('run-state')).toHaveTextContent('error');
    });
    expect(screen.getByTestId('err-msg')).toHaveTextContent('未收到结束标记');
  });

  it('disables server-ID actions on local messages and confirms retry/delete', async () => {
    const onRetry = vi.fn();
    const onDelete = vi.fn();
    const localMsg: Message = {
      id: 'local-user-1',
      conversationId: 'c1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-11-17T00:00:00Z',
    };
    const savedMsg: Message = {
      ...localMsg,
      id: 'u1',
      role: 'assistant',
    };

    const user = userEvent.setup();
    const { rerender } = render(
      <AppProvider skipInitialBootstrap>
        <MessageActions
          message={localMsg}
          onRetry={onRetry}
          onDelete={onDelete}
        />
      </AppProvider>,
    );

    expect(screen.getByRole('button', { name: '重试消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除消息' })).toBeDisabled();

    rerender(
      <AppProvider skipInitialBootstrap>
        <MessageActions
          message={savedMsg}
          onRetry={onRetry}
          onDelete={onDelete}
        />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: '删除消息' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(onDelete).toHaveBeenCalledWith(savedMsg);
  });

  it('branches preserving original conversation and deletes only the target single message', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/v1/conversations/c1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            conversation: makeConv('c1'),
            messages: [
              { id: 'm1', conversationId: 'c1', role: 'user', blocks: [{ type: 'text', text: 'u1' }], createdAt: '2026-11-17T00:00:00Z' },
              { id: 'm2', conversationId: 'c1', role: 'assistant', blocks: [{ type: 'text', text: 'a1' }], stopReason: 'stop', createdAt: '2026-11-17T00:00:01Z' },
              { id: 'm3', conversationId: 'c1', role: 'user', blocks: [{ type: 'text', text: 'u2' }], createdAt: '2026-11-17T00:00:02Z' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/c1/messages/m1') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/v1/conversations/c1/messages/m2/branch') && method === 'POST') {
        return new Response(
          JSON.stringify({
            conversation: { ...makeConv('c-branch'), title: 'Demo (分支)' },
            messages: [
              { id: 'bm1', conversationId: 'c-branch', role: 'user', blocks: [{ type: 'text', text: 'u1' }], createdAt: '2026-11-17T00:00:00Z' },
              { id: 'bm2', conversationId: 'c-branch', role: 'assistant', blocks: [{ type: 'text', text: 'a1' }], stopReason: 'stop', createdAt: '2026-11-17T00:00:01Z' },
            ],
          }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    function BranchDeleteHarness() {
      const { state, loadConversation, deleteMessage, branchFromMessage } = useChat();
      return (
        <div>
          <span data-testid="conv-id">{state.conversation?.id ?? ''}</span>
          <span data-testid="msg-ids">{state.messages.map((m) => m.id).join(',')}</span>
          <button type="button" onClick={() => void loadConversation('c1')}>
            load
          </button>
          <button type="button" onClick={() => void deleteMessage('m1')}>
            del-m1
          </button>
          <button type="button" onClick={() => void branchFromMessage('m2')}>
            branch-m2
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock} skipInitialBootstrap>
        <ChatProvider>
          <BranchDeleteHarness />
        </ChatProvider>
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByTestId('msg-ids')).toHaveTextContent('m1,m2,m3'));

    await user.click(screen.getByRole('button', { name: 'del-m1' }));
    await waitFor(() => expect(screen.getByTestId('msg-ids')).toHaveTextContent('m2,m3'));

    await user.click(screen.getByRole('button', { name: 'branch-m2' }));
    await waitFor(() => {
      expect(screen.getByTestId('conv-id')).toHaveTextContent('c-branch');
      expect(screen.getByTestId('msg-ids')).toHaveTextContent('bm1,bm2');
    });
  });
});
