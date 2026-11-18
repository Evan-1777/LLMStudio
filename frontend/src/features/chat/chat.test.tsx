import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
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
    const usageTrigger = screen.getByText('Tokens: 30 ↑10 ↓20');
    expect(usageTrigger).toBeInTheDocument();
    expect(screen.queryByText(/缓存读|缓存写/)).not.toBeInTheDocument();
    await user.click(usageTrigger);
    expect(screen.queryByText('缓存读取')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

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
            // The gateway binds the stored credential to the envelope.
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer sk-local-secret',
            },
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

  it('closes retry confirm dialog immediately before slow onRetry settles, guards double-click and rejected promises, and keeps delete blocking', async () => {
    let resolveRetry!: (v: boolean) => void;
    const onRetry = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    let resolveDelete!: (v: boolean) => void;
    const onDelete = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    const savedMsg: Message = {
      id: 'a-retry',
      conversationId: 'c1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Original reply' }],
      stopReason: 'stop',
      createdAt: '2026-11-17T00:00:00Z',
    };

    const user = userEvent.setup();
    render(
      <AppProvider skipInitialBootstrap>
        <button type="button">background-focus-target</button>
        <MessageActions message={savedMsg} onRetry={onRetry} onDelete={onDelete} />
      </AppProvider>,
    );

    // Cancel does not call onRetry.
    await user.click(screen.getByRole('button', { name: '重试消息' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();

    // Double-click / confirm closes dialog BEFORE delayed promise resolves and only invokes onRetry once.
    await user.click(screen.getByRole('button', { name: '重试消息' }));
    const confirmBtn = screen.getByRole('button', { name: '重新生成' });
    await user.dblClick(confirmBtn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);

    const bgBtn = screen.getByRole('button', { name: 'background-focus-target' });
    bgBtn.focus();
    expect(bgBtn).toHaveFocus();

    resolveRetry(true);

    // Rejected onRetry promise is surfaced via toast without unhandled rejection.
    const rejectingRetry = vi.fn().mockRejectedValue(new Error('网络重置'));
    const { rerender } = render(
      <AppProvider skipInitialBootstrap>
        <MessageActions message={savedMsg} onRetry={rejectingRetry} onDelete={onDelete} />
      </AppProvider>,
    );
    const retryBtns = screen.getAllByRole('button', { name: '重试消息' });
    await user.click(retryBtns[1]);
    await user.click(screen.getByRole('button', { name: '重新生成' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('网络重置')).toBeInTheDocument();
    });

    // Delete confirmation still blocks until onDelete resolves.
    rerender(
      <AppProvider skipInitialBootstrap>
        <MessageActions message={savedMsg} onRetry={rejectingRetry} onDelete={onDelete} />
      </AppProvider>,
    );
    const delBtns = screen.getAllByRole('button', { name: '删除消息' });
    await user.click(delBtns[1]);
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    resolveDelete(true);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('updateConversationMeta updates matching conversation without clearing messages and ignores mismatched IDs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          conversation: makeConv('c1'),
          messages: [
            {
              id: 'm1',
              conversationId: 'c1',
              role: 'user',
              blocks: [{ type: 'text', text: 'kept' }],
              createdAt: '2026-11-17T00:00:00Z',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    function MetaHarness() {
      const { state, loadConversation, updateConversationMeta } = useChat();
      return (
        <div>
          <span data-testid="model-id">{state.conversation?.modelId ?? ''}</span>
          <span data-testid="msg-ids">{state.messages.map((m) => m.id).join(',')}</span>
          <button type="button" onClick={() => void loadConversation('c1')}>
            load
          </button>
          <button
            type="button"
            onClick={() =>
              updateConversationMeta({ ...makeConv('c1'), modelId: 'gpt-4.1-mini' })
            }
          >
            update-same
          </button>
          <button
            type="button"
            onClick={() =>
              updateConversationMeta({ ...makeConv('c-other'), modelId: 'hijack' })
            }
          >
            update-other
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock} skipInitialBootstrap>
        <ChatProvider>
          <MetaHarness />
        </ChatProvider>
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByTestId('model-id')).toHaveTextContent('gpt-4.1'));

    await user.click(screen.getByRole('button', { name: 'update-other' }));
    expect(screen.getByTestId('model-id')).toHaveTextContent('gpt-4.1');

    await user.click(screen.getByRole('button', { name: 'update-same' }));
    expect(screen.getByTestId('model-id')).toHaveTextContent('gpt-4.1-mini');
    expect(screen.getByTestId('msg-ids')).toHaveTextContent('m1');
  });

  it('tracks thinking block completion independently from block_start ev.block and preserves manual reopen across local ID reconciliation', async () => {
    // block_start with initial ev.block must NOT mark block completed.
    let s = chatReducer(initialChatState, {
      type: 'LOAD_SUCCESS',
      conversation: makeConv('c1'),
      messages: [],
    });
    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_start',
        index: 0,
        blockType: 'thinking',
        block: { type: 'thinking', thinking: 'init' },
      },
    });
    expect(s.streaming?.blocksByIndex[0].completed).toBe(false);

    s = chatReducer(s, {
      type: 'STREAM_EVENT',
      fallbackProviderId: 'openai',
      fallbackModelId: 'gpt-4.1',
      event: {
        type: 'block_end',
        index: 0,
        blockType: 'thinking',
        block: { type: 'thinking', thinking: 'init done' },
      },
    });
    expect(s.streaming?.blocksByIndex[0].completed).toBe(true);

    // Local stream: user reopens collapsed thinking after block_end; subsequent text + reconcile must keep it open.
    localStorage.clear();
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
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
                name: 'Local',
                adapter: 'generic-http',
                baseURL: 'http://127.0.0.1:11434/v1',
                authType: 'bearer',
                apiKeyMasked: '',
                apiKeySet: false,
                localRequest: true,
                models: [{ id: 'r1', name: 'R1', apiFormat: 'openai-completions' }],
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
          JSON.stringify({
            conversation: makeConv('c-loc'),
            messages: [
              { id: 'srv-u1', conversationId: 'c-loc', role: 'user', blocks: [{ type: 'text', text: 'Q' }], createdAt: '2026-11-17T10:00:00Z' },
              { id: 'srv-a1', conversationId: 'c-loc', role: 'assistant', providerId: 'local-p', modelId: 'r1', blocks: [{ type: 'thinking', thinking: 'reason step' }, { type: 'text', text: 'Answer' }], stopReason: 'stop', createdAt: '2026-11-17T10:00:01Z' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/c-loc/messages/prepare-local')) {
        return new Response(
          JSON.stringify({
            method: 'POST',
            url: 'http://127.0.0.1:11434/v1/chat/completions',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer sk-local',
            },
            body: { model: 'r1', stream: true, messages: [] },
            authType: 'bearer',
          }),
          { status: 200 },
        );
      }
      if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            streamController = c;
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.endsWith('/api/v1/conversations/c-loc/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { role: string; blocks: Message['blocks'] };
        const id = body.role === 'user' ? 'srv-u1' : 'srv-a1';
        return new Response(
          JSON.stringify({
            message: { id, conversationId: 'c-loc', role: body.role, blocks: body.blocks, createdAt: '2026-11-17T10:00:01Z' },
            conversation: makeConv('c-loc'),
          }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    function ThinkingCanvasHarness() {
      const { state, loadConversation, sendMessage } = useChat();
      return (
        <div>
          <button type="button" onClick={() => void loadConversation('c-loc')}>
            load
          </button>
          <button
            type="button"
            onClick={() =>
              void sendMessage({
                conversationId: 'c-loc',
                blocks: [{ type: 'text', text: 'Q' }],
                text: 'Q',
                providerId: 'local-p',
                modelId: 'r1',
              })
            }
          >
            send
          </button>
          <ChatCanvas
            state={state}
            assistant={{ id: 'default', name: '默认助手', params: {}, isDefault: true }}
            hasConversationId
            onUpdateMessage={vi.fn().mockResolvedValue(true)}
            onRetryMessage={vi.fn().mockResolvedValue(true)}
            onDeleteMessage={vi.fn().mockResolvedValue(true)}
            onBranchMessage={vi.fn().mockResolvedValue(null)}
            onReloadConversation={vi.fn().mockResolvedValue(undefined)}
            onResetToNewTopic={vi.fn()}
          />
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter>
          <ChatProvider>
            <ThinkingCanvasHarness />
          </ChatProvider>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.anything()));
    await user.click(screen.getByRole('button', { name: 'send' }));

    await waitFor(() => expect(streamController).toBeDefined());
    streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"reason step"}}]}\n\n'));
    await waitFor(() => expect(screen.getByText('reason step')).toBeInTheDocument());

    // Transition from thinking to text emits block_end for thinking -> collapses once.
    streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Ans"}}]}\n\n'));
    await waitFor(() => expect(screen.queryByText('reason step')).not.toBeInTheDocument());

    // User manually reopens thinking -> must remain open across more text and final server ID reconciliation!
    await user.click(screen.getByRole('button', { name: /思考过程/ }));
    expect(screen.getByText('reason step')).toBeInTheDocument();

    streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"wer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    streamController.close();

    await waitFor(() => expect(screen.getByText('Answer')).toBeInTheDocument());
    expect(screen.getByText('reason step')).toBeInTheDocument();
  });

  it('continues localRequest multi-round MCP tool execution without sending browser key to gateway and stops cleanly on abort', async () => {
    const encoder = new TextEncoder();
    const persisted: Message[] = [];
    const gatewayBodies: Array<{ url: string; body: string }> = [];
    let upstreamTurn = 0;
    let upstreamAuths: string[] = [];
    let abortToolExec = false;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (init?.body) {
        gatewayBodies.push({ url, body: String(init.body) });
      }

      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.4.0', authRequired: false }), { status: 200 });
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
        return new Response(JSON.stringify({ conversations: [makeConv('c-mcp')] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/plugins/search') || url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ engines: [], servers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/c-mcp') && method === 'GET') {
        return new Response(JSON.stringify({ conversation: makeConv('c-mcp'), messages: persisted }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/c-mcp/messages/prepare-local')) {
        return new Response(
          JSON.stringify({
            method: 'POST',
            url: 'http://127.0.0.1:11434/v1/chat/completions',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer sk-browser-only',
            },
            body: { model: 'qwen', stream: true, messages: [] },
            authType: 'bearer',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/c-mcp/tools/execute')) {
        if (abortToolExec) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const sse = [
          'event: block_start\ndata: {"type":"block_start","index":0,"blockType":"toolResult","block":{"type":"toolResult","toolCallId":"call_loc_1","toolName":"calc","content":"42"}}\n\n',
          'event: block_end\ndata: {"type":"block_end","index":0,"blockType":"toolResult","block":{"type":"toolResult","toolCallId":"call_loc_1","toolName":"calc","content":"42"}}\n\n',
        ].join('');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(sse));
              c.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
        upstreamTurn += 1;
        upstreamAuths.push(headers.Authorization ?? '');
        const sse =
          upstreamTurn % 2 === 1
            ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_loc_1","function":{"name":"calc","arguments":"{\\"n\\":6}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n'
            : 'data: {"choices":[{"delta":{"content":"Result is 42"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26}}\n\ndata: [DONE]\n\n';
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(sse));
              c.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (url.endsWith('/api/v1/conversations/c-mcp/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          role: string;
          blocks: Message['blocks'];
          usage?: Message['usage'];
          stopReason?: string;
        };
        const saved: Message = {
          id: `srv-${persisted.length + 1}`,
          conversationId: 'c-mcp',
          role: body.role,
          blocks: body.blocks,
          usage: body.usage,
          stopReason: body.stopReason,
          createdAt: '2026-11-17T10:00:05Z',
        };
        persisted.push(saved);
        return new Response(JSON.stringify({ message: saved, conversation: makeConv('c-mcp') }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });

    function LocalMCPHarness() {
      const { state, loadConversation, sendMessage, stopStreaming } = useChat();
      return (
        <div>
          <button type="button" onClick={() => void loadConversation('c-mcp')}>
            load
          </button>
          <button
            type="button"
            onClick={() =>
              void sendMessage({
                conversationId: 'c-mcp',
                blocks: [{ type: 'text', text: 'Compute 6*7' }],
                text: 'Compute 6*7',
                providerId: 'local-p',
                modelId: 'qwen',
              })
            }
          >
            send
          </button>
          <button type="button" onClick={stopStreaming}>
            stop
          </button>
          <div data-testid="run-state">{state.runState}</div>
          <div data-testid="msg-count">{state.messages.length}</div>
          <div data-testid="block-types">
            {state.messages[1]?.blocks.map((b) => b.type).join(',')}
          </div>
          <div data-testid="usage-total">
            {state.messages[1]?.usage?.totalTokens ?? 0}
          </div>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter>
          <ChatProvider>
            <LocalMCPHarness />
          </ChatProvider>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.anything()));
    await user.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('empty'));

    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('idle'));

    expect(upstreamTurn).toBe(2);
    expect(upstreamAuths).toEqual(['Bearer sk-browser-only', 'Bearer sk-browser-only']);
    expect(screen.getByTestId('msg-count')).toHaveTextContent('2');
    expect(screen.getByTestId('block-types')).toHaveTextContent('toolCall,toolResult,text');
    expect(screen.getByTestId('usage-total')).toHaveTextContent('41');
    expect(persisted).toHaveLength(2);
    expect(persisted[1].blocks).toHaveLength(3);

    // Ensure gateway NEVER saw browser API key anywhere in request bodies.
    for (const req of gatewayBodies) {
      if (!req.url.startsWith('http://127.0.0.1:11434')) {
        expect(req.body).not.toContain('sk-browser-only');
      }
    }

    // Abort during /tools/execute must NOT trigger next prepare-local or upstream fetch.
    abortToolExec = true;
    const turnBeforeAbort = upstreamTurn;
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('run-state')).toHaveTextContent('aborted'));
    expect(upstreamTurn).toBe(turnBeforeAbort + 1);
  });

  it('executes localRequest Gemini cache pre-request with the gateway credential, reuses in-memory CacheState, and follows credential rotation', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), autoCreateCache: true }),
    );
    let credentialKey = 'sk-gem-key-1';
    const encoder = new TextEncoder();
    const persisted: Message[] = [];
    const preparePayloads: Array<Record<string, unknown>> = [];
    const upstreamRequests: Array<{ url: string; body: string }> = [];
    let cacheCreateCount = 0;
    let mainGenerateCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawBody = init?.body ? String(init.body) : '';

      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.4.1', authRequired: false }), { status: 200 });
      }
      if (url.endsWith('/api/v1/formats') || url.endsWith('/api/v1/assistants') || url.endsWith('/api/v1/plugins/search') || url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ formats: [], adapters: [], assistants: [], engines: [], servers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/providers')) {
        return new Response(
          JSON.stringify({
            providers: [
              {
                id: 'local-gem',
                name: 'Local Gemini',
                adapter: 'generic-http',
                baseURL: 'http://127.0.0.1:18888/v1beta',
                authType: 'query-key',
                apiKeyMasked: 'sk-g...key-1',
                apiKeySet: true,
                localRequest: true,
                models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', apiFormat: 'google-generative-ai' }],
                enabled: true,
                builtIn: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(JSON.stringify({ conversations: [makeConv('c-gem')] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/c-gem') && method === 'GET') {
        return new Response(JSON.stringify({ conversation: makeConv('c-gem'), messages: persisted }), { status: 200 });
      }
      const withCredential = (
        status: number,
        envelope: Record<string, unknown>,
      ) =>
        new Response(
          JSON.stringify({
            ...envelope,
            // The gateway binds the stored credential to the prepared envelope.
            url: `${String(envelope.url)}&key=${credentialKey}`,
          }),
          { status },
        );
      if (url.endsWith('/api/v1/conversations/c-gem/messages/prepare-local')) {
        const payload = JSON.parse(rawBody) as Record<string, unknown>;
        preparePayloads.push(payload);
        expect(rawBody).not.toContain('sk-gem-key');
        expect(payload.credentialEnvelope).toBe(true);
        const wsBlock = {
          type: 'webSearch',
          extra: { query: 'q', engineId: 'tavily', results: [{ title: 'T', url: 'https://t.example' }] },
        };
        const resolution = payload.cacheResolution as { planKey: string; status: number; result: { name?: string } } | undefined;
        const incomingState = payload.cacheState as { resourceName?: string } | undefined;

        if (resolution) {
          if (resolution.status >= 400) {
            return withCredential(200, {
              method: 'POST',
              url: 'http://127.0.0.1:18888/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
              headers: { 'Content-Type': 'application/json' },
              body: { contents: [{ role: 'user', parts: [{ text: 'uncached' }] }] },
              authType: 'query-key',
              cacheState: { failedPrefixHash: resolution.planKey },
            });
          }
          return withCredential(200, {
            method: 'POST',
            url: 'http://127.0.0.1:18888/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
            headers: { 'Content-Type': 'application/json' },
            body: { cachedContent: resolution.result.name, contents: [{ role: 'user', parts: [{ text: 'q' }] }] },
            authType: 'query-key',
            cacheState: { resourceName: resolution.result.name, prefixCount: 0 },
          });
        }

        if (incomingState?.resourceName) {
          return withCredential(200, {
            method: 'POST',
            url: 'http://127.0.0.1:18888/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
            headers: { 'Content-Type': 'application/json' },
            body: { cachedContent: incomingState.resourceName, contents: [{ role: 'user', parts: [{ text: 'q2' }] }] },
            authType: 'query-key',
            cacheState: incomingState,
          });
        }

        return withCredential(200, {
          method: 'POST',
          url: 'http://127.0.0.1:18888/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
          headers: { 'Content-Type': 'application/json' },
          body: { contents: [{ role: 'user', parts: [{ text: 'fallback' }] }] },
          authType: 'query-key',
          ...(payload.preparedSearch ? {} : { webSearchBlock: wsBlock }),
          cacheStep: {
            planKey: 'pk-1',
            request: {
              method: 'POST',
              // The gateway also binds the credential to the cache pre-request.
              url: `http://127.0.0.1:18888/v1beta/cachedContents?key=${credentialKey}`,
              headers: { 'Content-Type': 'application/json' },
              body: { model: 'models/gemini-2.5-pro' },
              authType: 'query-key',
            },
          },
        });
      }

      if (url.startsWith('http://127.0.0.1:18888/v1beta/cachedContents')) {
        cacheCreateCount += 1;
        upstreamRequests.push({ url, body: rawBody });
        return new Response(
          JSON.stringify({ name: `cachedContents/b-${cacheCreateCount}`, expireTime: '2099-01-01T00:00:00Z' }),
          { status: 200 },
        );
      }

      if (url.startsWith('http://127.0.0.1:18888/v1beta/models/gemini-2.5-pro:streamGenerateContent')) {
        mainGenerateCount += 1;
        upstreamRequests.push({ url, body: rawBody });
        const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"gem-ok"}]},"finishReason":"STOP"}]}\n\n';
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(sse));
              c.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }

      if (url.endsWith('/api/v1/conversations/c-gem/messages') && method === 'POST') {
        const body = JSON.parse(rawBody) as { role: string; blocks: Message['blocks'] };
        const saved: Message = {
          id: `g-${persisted.length + 1}`,
          conversationId: 'c-gem',
          role: body.role,
          blocks: body.blocks,
          createdAt: '2026-11-17T10:00:00Z',
        };
        persisted.push(saved);
        return new Response(JSON.stringify({ message: saved, conversation: makeConv('c-gem') }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });

    function LocalGemCacheHarness() {
      const { state, loadConversation, sendMessage, stopStreaming } = useChat();
      return (
        <div>
          <button type="button" onClick={() => void loadConversation('c-gem')}>
            load
          </button>
          <button
            type="button"
            onClick={() =>
              void sendMessage({
                conversationId: 'c-gem',
                blocks: [{ type: 'text', text: 'hello' }],
                text: 'hello',
                providerId: 'local-gem',
                modelId: 'gemini-2.5-pro',
                webSearch: true,
              })
            }
          >
            send
          </button>
          <button type="button" onClick={stopStreaming}>
            stop
          </button>
          <div data-testid="gem-run">{state.runState}</div>
          <div data-testid="gem-count">{state.messages.length}</div>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter>
          <ChatProvider>
            <LocalGemCacheHarness />
          </ChatProvider>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.anything()));
    await user.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByTestId('gem-run')).toHaveTextContent('empty'));

    // 1. First send creates cache via browser key, passes preparedSearch + cacheResolution, saves 1 user + 1 assistant.
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('gem-run')).toHaveTextContent('idle'));
    expect(cacheCreateCount).toBe(1);
    expect(mainGenerateCount).toBe(1);
    expect(persisted).toHaveLength(2);
    expect(preparePayloads[0].credentialEnvelope).toBe(true);
    // The cache-create envelope carries the credential, the main request follows it.
    expect(upstreamRequests[0].url).toContain('key=sk-gem-key-1');
    expect(upstreamRequests[1].url).toContain('key=sk-gem-key-1');
    expect(JSON.parse(upstreamRequests[1].body)).toMatchObject({ cachedContent: 'cachedContents/b-1' });
    expect(preparePayloads[1]).toHaveProperty('preparedSearch');
    expect(preparePayloads[1]).toHaveProperty('cacheResolution');

    // 2. Second send reuses in-memory cacheState without a second cachedContents create.
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('gem-run')).toHaveTextContent('idle'));
    expect(cacheCreateCount).toBe(1);
    expect(mainGenerateCount).toBe(2);

    // 3. A gateway-side credential rotation reuses the in-memory cacheState while
    // the prepared envelope immediately carries the new credential.
    credentialKey = 'sk-gem-key-2';
    await user.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('gem-run')).toHaveTextContent('idle'));
    expect(cacheCreateCount).toBe(1);
    expect(mainGenerateCount).toBe(3);
    expect(upstreamRequests[upstreamRequests.length - 1].url).toContain(
      'key=sk-gem-key-2',
    );
    expect(preparePayloads[preparePayloads.length - 1].credentialEnvelope).toBe(
      true,
    );
  });

  it('displays real cache read/write counts on demand in MessageActions Popover without fabricating savings or zero hits', async () => {
    const user = userEvent.setup();
    const cachedMsg: Message = {
      id: 'a-cached',
      conversationId: 'c1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Cached reply' }],
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 150,
        totalTokens: 1050,
      },
      stopReason: 'stop',
      createdAt: '2026-11-17T10:00:00Z',
    };
    render(
      <AppProvider skipInitialBootstrap>
        <MemoryRouter>
          <ChatCanvas
            state={{
              ...initialChatState,
              conversation: makeConv('c1'),
              messages: [cachedMsg],
              runState: 'idle',
            }}
            assistant={{ id: 'default', name: '默认助手', params: {}, isDefault: true }}
            hasConversationId
            onUpdateMessage={vi.fn().mockResolvedValue(true)}
            onRetryMessage={vi.fn().mockResolvedValue(true)}
            onDeleteMessage={vi.fn().mockResolvedValue(true)}
            onBranchMessage={vi.fn().mockResolvedValue(null)}
            onReloadConversation={vi.fn().mockResolvedValue(undefined)}
            onResetToNewTopic={vi.fn()}
          />
        </MemoryRouter>
      </AppProvider>,
    );

    const trigger = screen.getByRole('button', { name: '查看 Token 用量详情' });
    expect(trigger).toHaveTextContent('1,000 in · 50 out · 缓存读 800 · 缓存写 150');
    await user.click(trigger);
    expect(screen.getByText('缓存读取')).toBeInTheDocument();
    expect(screen.getByText('800')).toBeInTheDocument();
    expect(screen.getByText('缓存写入')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
  });
});
