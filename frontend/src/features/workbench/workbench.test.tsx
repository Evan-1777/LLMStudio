import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import { MAX_ATTACHMENT_BYTES, MAX_GATEWAY_BODY_BYTES } from '../../core/types';
import {
  attachmentToContentBlock,
  classifyFile,
  isWithinRequestLimit,
  readAttachmentFile,
} from './attachments';
import { WorkbenchPage } from './WorkbenchPage';

function makeWorkbenchFetch() {
  const conversations = [
    {
      id: 'c1',
      assistantId: 'default',
      title: '第一个话题',
      providerId: 'openai',
      modelId: 'gpt-4.1',
      systemPrompt: 'Topic prompt',
      params: { temperature: 0.5, reasoningEffort: 'high' },
      syncEnabled: false,
      syncState: 'local_only',
      syncVersion: 0,
      createdAt: '2026-11-17T08:00:00Z',
      updatedAt: '2026-11-17T08:00:00Z',
    },
    {
      id: 'c2',
      assistantId: 'coder',
      title: '代码审查话题',
      providerId: 'openai',
      modelId: 'gpt-4.1',
      systemPrompt: '',
      params: {},
      syncEnabled: false,
      syncState: 'local_only',
      syncVersion: 0,
      createdAt: '2026-11-17T07:00:00Z',
      updatedAt: '2026-11-17T07:00:00Z',
    },
  ];

  const requests: Array<{ method: string; url: string; body?: string }> = [];

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ method, url, body: bodyStr });

    if (url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ status: 'ok', version: '0.1.0', authRequired: false }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/formats')) {
      return new Response(JSON.stringify({ formats: [], adapters: [] }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/providers')) {
      return new Response(
        JSON.stringify({
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              adapter: 'generic-http',
              baseURL: 'https://api.openai.com/v1',
              authType: 'bearer',
              apiKeyMasked: 'sk-1...89',
              apiKeySet: true,
              models: [
                {
                  id: 'gpt-4.1',
                  name: 'GPT-4.1',
                  apiFormat: 'openai-responses',
                  reasoning: false,
                  inputModalities: ['text', 'image'],
                },
              ],
              enabled: true,
              builtIn: true,
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/assistants') && method === 'GET') {
      return new Response(
        JSON.stringify({
          assistants: [
            { id: 'default', name: '默认助手', params: {}, isDefault: true },
            { id: 'coder', name: '开发助手', params: {}, isDefault: false },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/assistants') && method === 'POST') {
      const parsed = JSON.parse(bodyStr ?? '{}');
      return new Response(
        JSON.stringify({
          assistant: { id: 'a-new', ...parsed, isDefault: false },
        }),
        { status: 201 },
      );
    }
    if (url.endsWith('/api/v1/conversations') && method === 'GET') {
      return new Response(JSON.stringify({ conversations }), { status: 200 });
    }
    if (url.endsWith('/api/v1/conversations') && method === 'POST') {
      return new Response(
        JSON.stringify({ code: 'UPSTREAM_ERROR', message: 'create failed' }),
        { status: 500 },
      );
    }
    if (url.endsWith('/api/v1/conversations/c1') && method === 'GET') {
      return new Response(
        JSON.stringify({ conversation: conversations[0], messages: [] }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/conversations/c2') && method === 'GET') {
      return new Response(
        JSON.stringify({ conversation: conversations[1], messages: [] }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/conversations/c1') && method === 'PATCH') {
      const patch = JSON.parse(bodyStr ?? '{}');
      return new Response(
        JSON.stringify({
          conversation: {
            ...conversations[0],
            systemPrompt: patch.systemPrompt ?? conversations[0].systemPrompt,
            params: patch.params === null ? {} : { ...conversations[0].params, ...patch.params },
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/plugins/search')) {
      return new Response(
        JSON.stringify({
          engines: [
            {
              engineId: 'tavily',
              displayName: 'Tavily',
              defaultEndpoint: 'https://api.tavily.com/search',
              requiresApiKey: true,
              enabled: true,
              endpoint: 'https://api.tavily.com/search',
              apiKeyMasked: 'tvly...1',
              apiKeySet: true,
              maxResults: 5,
              isDefault: true,
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/mcp/servers')) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });

  return { fetchMock, requests };
}

describe('Workbench flows and attachments', () => {
  it('aligns assistant from deep-linked topic URL, resets params on new topic, and clears nullable params on PATCH', async () => {
    const { fetchMock, requests } = makeWorkbenchFetch();
    const user = userEvent.setup();

    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat/c2']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('代码审查话题')).toBeInTheDocument();
    });

    // Click c1 via default assistant first -> switch assistant to default
    await user.click(screen.getByRole('button', { name: '默认助手' }));
    await waitFor(() => {
      expect(screen.getByText('第一个话题')).toBeInTheDocument();
    });

    // Open params inspector and reset inherited values (sends params: null)
    await user.click(screen.getByRole('button', { name: '话题参数' }));
    await waitFor(() => {
      expect(screen.getByLabelText('系统提示词')).toHaveValue('Topic prompt');
    });
    await user.click(screen.getByRole('button', { name: '恢复继承值' }));

    await waitFor(() => {
      const patchCall = requests.find(
        (r) => r.method === 'PATCH' && r.url.endsWith('/api/v1/conversations/c1'),
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall!.body ?? '{}')).toEqual({
        systemPrompt: '',
        params: null,
      });
    });

    // Close inspector -> open topic drawer (jsdom default width 1024 < 1200) -> start new topic -> draft params do not leak
    await user.click(screen.getByRole('button', { name: '关闭话题参数' }));
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    await user.click(screen.getByRole('button', { name: '新建话题' }));
    await user.click(screen.getByRole('button', { name: '话题参数' }));
    expect(screen.getByLabelText('系统提示词')).toHaveValue('');
  });

  it('keeps draft when conversation creation fails and guards IME composition', async () => {
    const { fetchMock, requests } = makeWorkbenchFetch();
    const user = userEvent.setup();

    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent(
        'GPT-4.1',
      );
    });

    const draftBox = screen.getByLabelText('消息输入框');
    await user.type(draftBox, '保持这段草稿');

    // IME composition Enter must not submit
    fireEvent.keyDown(draftBox, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(
      requests.filter((r) => r.method === 'POST' && r.url.endsWith('/conversations')),
    ).toHaveLength(0);

    // Real Enter submits -> POST /conversations returns 500 -> draft must stay!
    fireEvent.keyDown(draftBox, { key: 'Enter' });
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'POST' && r.url.endsWith('/conversations')),
      ).toHaveLength(1);
    });
    expect(draftBox).toHaveValue('保持这段草稿');

    // Six effort levels are always selectable even though model.reasoning is false
    await user.click(screen.getByRole('button', { name: /思考强度/ }));
    expect(screen.getByRole('radio', { name: '极高' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '极高' }));
    expect(screen.getByRole('button', { name: /思考强度 \(极高\)/ })).toBeInTheDocument();
  });

  it('validates attachments (types, 8 MiB, XML attribute escaping, 16 MiB body cap, image modality)', () => {
    expect(classifyFile({ name: 'report.pdf', type: 'application/pdf' })).toBe(
      'unsupported',
    );
    expect(classifyFile({ name: 'notes.md', type: 'text/markdown' })).toBe(
      'text',
    );
    expect(classifyFile({ name: 'photo.png', type: 'image/png' })).toBe(
      'image',
    );

    const hugeFile = new File(['x'], 'big.txt', { type: 'text/plain' });
    Object.defineProperty(hugeFile, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    const hugeRes = readAttachmentFile(hugeFile, {
      supportsImageInput: true,
      onUpdate: () => {},
    });
    expect(hugeRes.status).toBe('error');
    expect(hugeRes.error).toContain('8 MiB');

    const imgFile = new File(['abc'], 'pic.png', { type: 'image/png' });
    const imgDenied = readAttachmentFile(imgFile, {
      supportsImageInput: false,
      onUpdate: () => {},
    });
    expect(imgDenied.status).toBe('error');
    expect(imgDenied.error).toContain('不支持图片');

    const textBlock = attachmentToContentBlock({
      id: '1',
      name: '中文 "quoted" & <tag>.ts',
      mimeType: 'text/plain',
      size: 10,
      kind: 'text',
      status: 'ready',
      textContent: 'const x = 1;',
    });
    expect(textBlock).toEqual({
      type: 'text',
      text: '<file name="中文 &quot;quoted&quot; &amp; &lt;tag&gt;.ts">\nconst x = 1;\n</file>',
    });

    const imgBlock = attachmentToContentBlock({
      id: '2',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 10,
      kind: 'image',
      status: 'ready',
      base64Data: 'QUJD',
    });
    expect(imgBlock).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'QUJD',
    });

    expect(
      isWithinRequestLimit({
        blocks: [{ type: 'text', text: 'a'.repeat(MAX_GATEWAY_BODY_BYTES) }],
      }),
    ).toBe(false);
  });

  it('supports assistant CRUD, prevents deleting default assistant, and keeps topic items on failed rename/delete', async () => {
    const { fetchMock } = makeWorkbenchFetch();
    const extendedFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/v1/conversations/c1') && method === 'PATCH') {
        return new Response(
          JSON.stringify({ code: 'UPSTREAM_ERROR', message: '重命名拒绝' }),
          { status: 400 },
        );
      }
      if (url.endsWith('/api/v1/conversations/c1') && method === 'DELETE') {
        return new Response(
          JSON.stringify({ code: 'UPSTREAM_ERROR', message: '删除拒绝' }),
          { status: 500 },
        );
      }
      if (url.endsWith('/api/v1/assistants/coder') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/v1/conversations/missing') && method === 'GET') {
        return new Response(
          JSON.stringify({ code: 'NOT_FOUND', message: 'conversation not found' }),
          { status: 404 },
        );
      }
      return fetchMock(input, init);
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={extendedFetch}>
        <MemoryRouter initialEntries={['/chat/missing']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    // 404 conversation shows recovery banner and allows starting new topic
    await waitFor(() => {
      expect(screen.getByText('conversation not found')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '新建话题' }));

    // Edit default assistant -> delete button must not exist
    await user.click(screen.getByRole('button', { name: '编辑 默认助手' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除助手' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    // Create custom assistant -> empty name blocked locally
    await user.click(screen.getByRole('button', { name: '添加助手' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('助手名称不能为空')).toBeInTheDocument();
    await user.type(screen.getByLabelText('名称'), '测试专家');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '测试专家' })).toBeInTheDocument();
    });

    // Delete custom assistant '开发助手'
    await user.click(screen.getByRole('button', { name: '编辑 开发助手' }));
    await user.click(screen.getByRole('button', { name: '删除助手' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '开发助手' })).not.toBeInTheDocument();
    });

    // Switch to default assistant -> open topic drawer -> failed rename/delete keeps topic
    await user.click(screen.getByRole('button', { name: '默认助手' }));
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    await waitFor(() => {
      expect(screen.getByText('第一个话题')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '重命名 第一个话题' }));
    const renameInput = screen.getByLabelText('标题');
    await user.clear(renameInput);
    await user.type(renameInput, '新标题');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('重命名拒绝')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('第一个话题')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除 第一个话题' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(screen.getByText('第一个话题')).toBeInTheDocument();
    });
  });

  it('respects enterToSend=false requiring Ctrl/Cmd+Enter', async () => {
    localStorage.setItem(
      'llmstudio.settings.v2',
      JSON.stringify({
        gatewayBaseUrl: '/',
        accessToken: '',
        themeMode: 'light',
        seedColorValue: 0xff007aff,
        enterToSend: false,
        defaultHtmlPreview: true,
        autoCollapseEnabled: true,
        collapseLineThreshold: 24,
        collapseCharThreshold: 1200,
      }),
    );

    const { fetchMock, requests } = makeWorkbenchFetch();
    const user = userEvent.setup();

    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1');
    });

    const box = screen.getByLabelText('消息输入框');
    await user.type(box, 'Line 1');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(
      requests.filter((r) => r.method === 'POST' && r.url.endsWith('/conversations')),
    ).toHaveLength(0);

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'POST' && r.url.endsWith('/conversations')),
      ).toHaveLength(1);
    });
  });

  it('keeps focus in composer during streaming, prioritizes Escape over stop, and creates new topic on Ctrl+N', async () => {
    localStorage.clear();
    const { fetchMock } = makeWorkbenchFetch();
    let resolveStream!: (res: Response) => void;
    let streamAborted = false;

    const streamFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/messages/stream')) {
        init?.signal?.addEventListener('abort', () => {
          streamAborted = true;
        });
        return new Promise<Response>((resolve) => {
          resolveStream = resolve;
        });
      }
      return fetchMock(input, init);
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={streamFetch}>
        <MemoryRouter initialEntries={['/chat/c1']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('第一个话题')).toBeInTheDocument();
    });

    const box = screen.getByLabelText('消息输入框');
    await user.click(box);
    await user.type(box, 'streaming test');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '停止生成' })).toBeInTheDocument();
    });
    // Focus stays inside composer textarea while busy!
    expect(box).not.toBeDisabled();
    expect(box).toHaveFocus();

    // Open inspector; first Escape closes inspector without aborting stream.
    await user.click(screen.getByRole('button', { name: '话题参数' }));
    expect(screen.getByLabelText('系统提示词')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByLabelText('系统提示词')).not.toBeInTheDocument();
    });
    expect(streamAborted).toBe(false);

    // Next Escape aborts the active stream.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(streamAborted).toBe(true);
    });
    resolveStream?.(new Response('', { status: 200 }));

    // Ctrl+N switches back to new topic.
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '默认助手' })).toBeInTheDocument();
    });
  });
});
