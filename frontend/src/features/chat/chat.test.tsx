import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import { setLocalProviderKey } from '../../core/localProviderKeys';
import { SETTINGS_STORAGE_KEY, defaultSettings } from '../../core/settings';
import { ChatCanvas } from '../workbench/ChatCanvas';
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

  it('supports non-truncating intermediate retry in chatReducer and inline edit + feed display in ChatCanvas', async () => {
    const msgs: Message[] = [
      { id: 'u1', conversationId: 'c1', role: 'user', blocks: [{ type: 'text', text: 'Q1' }], createdAt: '2026-11-17T10:00:00Z' },
      { id: 'a1', conversationId: 'c1', role: 'assistant', providerId: 'p1', modelId: 'm1', blocks: [{ type: 'thinking', thinking: 't1' }, { type: 'text', text: 'A1' }], usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, stopReason: 'stop', createdAt: '2026-11-17T10:01:00Z' },
      { id: 'u2', conversationId: 'c1', role: 'user', blocks: [{ type: 'text', text: 'Q2' }], createdAt: '2026-11-17T10:02:00Z' },
      { id: 'a2', conversationId: 'c1', role: 'assistant', providerId: 'p1', modelId: 'm1', blocks: [{ type: 'text', text: 'A2' }], stopReason: 'stop', createdAt: '2026-11-17T10:03:00Z' },
    ];

    let s = chatReducer(initialChatState, {
      type: 'LOAD_SUCCESS',
      conversation: makeConv('c1'),
      messages: msgs,
    });
    s = chatReducer(s, { type: 'REGEN_PREPARE_START' });
    s = chatReducer(s, { type: 'REGEN_PREPARE_CONFIRMED', targetMessageId: 'u1' });
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'u2', 'a2']);
    expect(s.pendingInsertIndex).toBe(1);

    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'p1',
      fallbackModelId: 'm1',
      event: { type: 'message_start', messageId: 'a1-new' },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'p1',
      fallbackModelId: 'm1',
      event: { type: 'block_delta', index: 0, blockType: 'text', deltaType: 'text_delta', delta: 'A1-new' },
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'p1',
      fallbackModelId: 'm1',
      event: { type: 'message_end', messageId: 'a1-new' },
    });
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a1-new', 'u2', 'a2']);
    expect(s.runState).toBe('idle');

    // Feed mode + inline editing in ChatCanvas
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), chatDisplayMode: 'feed' }),
    );
    const onUpdate = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <AppProvider skipInitialBootstrap>
        <MemoryRouter>
          <ChatCanvas
            state={{ ...initialChatState, conversation: makeConv('c1'), messages: msgs, runState: 'idle' }}
            assistant={{ id: 'default', name: '默认助手', params: {}, isDefault: true }}
            providers={[
              {
                id: 'p1',
                name: 'MyProvider',
                adapter: 'generic-http',
                baseURL: 'https://example.com',
                authType: 'none',
                apiKeyMasked: '',
                apiKeySet: false,
                models: [{ id: 'm1', name: 'Friendly Model', apiFormat: 'openai-completions' }],
                enabled: true,
                builtIn: false,
              },
            ]}
            hasConversationId
            onUpdateMessage={onUpdate}
            onRetryMessage={vi.fn().mockResolvedValue(true)}
            onDeleteMessage={vi.fn().mockResolvedValue(true)}
            onBranchMessage={vi.fn().mockResolvedValue(null)}
            onReloadConversation={vi.fn().mockResolvedValue(undefined)}
            onResetToNewTopic={vi.fn()}
          />
        </MemoryRouter>
      </AppProvider>,
    );

    expect(screen.getAllByText('用户').length).toBe(2);
    expect(screen.getAllByText('Friendly Model | MyProvider').length).toBeGreaterThan(0);
    expect(screen.getByText('Tokens: 30 ↑10 ↓20')).toBeInTheDocument();

    const editBtns = screen.getAllByRole('button', { name: '修改消息' });
    await user.click(editBtns[1]); // Edit A1 which has [thinking, text]
    const editor = screen.getByLabelText('编辑消息内容');
    await user.clear(editor);
    await user.type(editor, 'A1-updated');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onUpdate).toHaveBeenCalledWith('a1', [
      { type: 'thinking', thinking: 't1' },
      { type: 'text', text: 'A1-updated' },
    ]);
  });

  it('routes localRequest providers via prepare-local -> direct upstream -> createMessage and preserves reply on persist failure', async () => {
    localStorage.clear();
    setLocalProviderKey('local-p', 'sk-local-secret');

    const encoder = new TextEncoder();
    let failAssistantPersist = false;
    let persistedMessages: Message[] = [];
    let directAuthHeader = '';

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.3.0', authRequired: false }), { status: 200 });
      }
      if (url.endsWith('/api/v1/formats')) {
        return new Response(JSON.stringify({ formats: [], adapters: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/providers')) {
        return new Response(
          JSON.stringify({
            providers: [
              {
                id: 'local-p',
                name: 'Local Ollama',
                adapter: 'generic-http',
                baseURL: 'http://127.0.0.1:11434/v1',
                authType: 'bearer',
                apiKeyMasked: '',
                apiKeySet: false,
                localRequest: true,
                models: [{ id: 'qwen', name: 'Qwen', apiFormat: 'openai-completions' }],
                enabled: true,
                builtIn: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(JSON.stringify({ assistants: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(JSON.stringify({ conversations: [makeConv('c-loc')] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(JSON.stringify({ engines: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/c-loc') && method === 'GET') {
        return new Response(
          JSON.stringify({ conversation: makeConv('c-loc'), messages: persistedMessages }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/c-loc/messages/prepare-local')) {
        return new Response(
          JSON.stringify({
            method: 'POST',
            url: 'http://127.0.0.1:11434/v1/chat/completions',
            headers: { 'Content-Type': 'application/json' },
            body: { model: 'qwen', stream: true, messages: [] },
            authType: 'bearer',
          }),
          { status: 200 },
        );
      }
      if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
        directAuthHeader = headers.Authorization ?? '';
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"Local hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              ),
            );
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.endsWith('/api/v1/conversations/c-loc/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { role: string; blocks: Message['blocks'] };
        if (body.role === 'assistant' && failAssistantPersist) {
          return new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'db locked' }), { status: 500 });
        }
        const saved: Message = {
          id: `srv-${persistedMessages.length + 1}`,
          conversationId: 'c-loc',
          role: body.role,
          blocks: body.blocks,
          providerId: 'local-p',
          modelId: 'qwen',
          createdAt: '2026-11-17T10:00:00Z',
        };
        persistedMessages = [...persistedMessages, saved];
        return new Response(
          JSON.stringify({ message: saved, conversation: makeConv('c-loc') }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    function LocalHarness() {
      const { state, loadConversation, sendMessage } = useChat();
      return (
        <div>
          <span data-testid="loc-msgs">
            {state.messages
              .map((m) => `${m.id}:${m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')}`)
              .join('|')}
          </span>
          <span data-testid="needs-reload">{String(state.needsReloadAfterAbort)}</span>
          <button type="button" onClick={() => void loadConversation('c-loc')}>
            load
          </button>
          <button
            type="button"
            onClick={() =>
              void sendMessage({
                conversationId: 'c-loc',
                blocks: [{ type: 'text', text: 'Ping local' }],
                text: 'Ping local',
                providerId: 'local-p',
                modelId: 'qwen',
              })
            }
          >
            send-local
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <ChatProvider>
          <LocalHarness />
        </ChatProvider>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/providers'),
        expect.anything(),
      );
    });
    await user.click(screen.getByRole('button', { name: 'load' }));
    await user.click(screen.getByRole('button', { name: 'send-local' }));

    await waitFor(() => {
      expect(screen.getByTestId('loc-msgs')).toHaveTextContent('srv-1:Ping local|srv-2:Local hello');
    });
    expect(directAuthHeader).toBe('Bearer sk-local-secret');

    // When assistant persistence fails, generated local reply must stay visible with local-assistant-* ID and needsReload flag.
    failAssistantPersist = true;
    await user.click(screen.getByRole('button', { name: 'send-local' }));
    await waitFor(() => {
      expect(screen.getByTestId('needs-reload')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('loc-msgs').textContent).toContain('local-assistant-');
    expect(screen.getByTestId('loc-msgs').textContent).toContain('Local hello');
  });
});
