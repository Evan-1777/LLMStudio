import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import { MAX_ATTACHMENT_BYTES, MAX_GATEWAY_BODY_BYTES } from '../../core/types';
import {
  attachmentToContentBlock,
  classifyFile,
  clipboardHasPlainText,
  collectClipboardImageFiles,
  defaultAttachmentName,
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
    if (url.endsWith('/api/v1/conversation-groups') && method === 'GET') {
      return new Response(JSON.stringify({ groups: [] }), { status: 200 });
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
    expect(screen.queryByRole('button', { name: '切换消息显示模式' })).not.toBeInTheDocument();

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

    // Clipboard collection prefers items, falls back to files, and never stacks
    // the same file twice within one paste.
    const itemImage = new File(['a'], '', { type: 'image/png' });
    const fileImage = new File(['b'], 'second.webp', { type: 'image/webp' });
    const clipboard = {
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => itemImage },
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        new File(['t'], 'notes.txt', { type: 'text/plain' }),
      ],
      files: [itemImage, fileImage],
      types: ['Files'],
      getData: () => '',
    } as unknown as DataTransfer;
    expect(collectClipboardImageFiles(clipboard)).toEqual([itemImage, fileImage]);
    expect(
      collectClipboardImageFiles({ ...clipboard, items: [] } as unknown as DataTransfer),
    ).toEqual([itemImage, fileImage]);
    expect(collectClipboardImageFiles(null)).toEqual([]);
    expect(clipboardHasPlainText(clipboard)).toBe(false);
    expect(
      clipboardHasPlainText({
        ...clipboard,
        types: ['Files', 'text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'hello' : ''),
      } as unknown as DataTransfer),
    ).toBe(true);

    // Clipboard images without a filename get a stable generic name; a file at
    // the exact 8 MiB boundary is still accepted.
    expect(defaultAttachmentName({ name: '', type: 'image/png' })).toBe('pasted-image.png');
    expect(defaultAttachmentName({ name: '  ', type: 'image/webp' })).toBe('pasted-image.webp');
    expect(defaultAttachmentName({ name: 'keep.png', type: 'image/png' })).toBe('keep.png');
    const boundaryFile = new File(['x'], 'limit.png', { type: 'image/png' });
    Object.defineProperty(boundaryFile, 'size', { value: MAX_ATTACHMENT_BYTES });
    expect(
      readAttachmentFile(boundaryFile, { supportsImageInput: true, onUpdate: () => {} }).status,
    ).toBe('reading');
  });

  it('adds pasted clipboard images to the attachment pipeline without disturbing the draft', async () => {
    const { fetchMock } = makeWorkbenchFetch();
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

    const fakeClipboard = (files: File[], text = ''): DataTransfer =>
      ({
        items: files.map((file) => ({
          kind: 'file',
          type: file.type,
          getAsFile: () => file,
        })),
        files,
        types: [...(text ? ['text/plain'] : []), ...(files.length ? ['Files'] : [])],
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      }) as unknown as DataTransfer;

    // 1. No image: the native paste path stays untouched and nothing is attached.
    expect(fireEvent.paste(box, { clipboardData: fakeClipboard([], 'plain') })).toBe(true);
    expect(screen.queryByRole('button', { name: /^移除 / })).not.toBeInTheDocument();

    // 2. One image without a filename: default is consumed, a stable chip appears.
    const pasted = new File(['abc'], '', { type: 'image/png' });
    expect(fireEvent.paste(box, { clipboardData: fakeClipboard([pasted]) })).toBe(false);
    await waitFor(() => expect(screen.getByText('pasted-image.png')).toBeInTheDocument());
    expect(box).toHaveValue('');

    // 3. Multiple images append in order.
    const second = new File(['def'], 'second.gif', { type: 'image/gif' });
    fireEvent.paste(box, { clipboardData: fakeClipboard([second]) });
    await waitFor(() => expect(screen.getByText('second.gif')).toBeInTheDocument());

    // 4. Mixed image and text is not consumed, so the browser still inserts text.
    const mixedImage = new File(['ghi'], 'mixed.png', { type: 'image/png' });
    expect(
      fireEvent.paste(box, { clipboardData: fakeClipboard([mixedImage], 'typed') }),
    ).toBe(true);
    await waitFor(() => expect(screen.getByText('mixed.png')).toBeInTheDocument());

    // 5. Removing a chip drops it from the composer.
    await user.click(screen.getByRole('button', { name: '移除 second.gif' }));
    expect(screen.queryByText('second.gif')).not.toBeInTheDocument();
    expect(screen.getByText('pasted-image.png')).toBeInTheDocument();
    expect(screen.getByText('mixed.png')).toBeInTheDocument();
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
      if (
        (url.endsWith('/api/v1/conversations/c1') && method === 'DELETE') ||
        (url.endsWith('/api/v1/conversations/batch') && method === 'POST')
      ) {
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

    await user.click(screen.getByRole('button', { name: '更多操作 第一个话题' }));
    await user.click(screen.getByRole('menuitem', { name: '重命名' }));
    const renameInput = screen.getByLabelText('标题');
    await user.clear(renameInput);
    await user.type(renameInput, '新标题');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('重命名拒绝')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('第一个话题')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '更多操作 第一个话题' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
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

  it('switches model via PATCH without GET detail reload, preserves topic order/DOM/draft, and isolates slow PATCH across topic switches', async () => {
    localStorage.clear();
    const convA = {
      id: 'cA',
      assistantId: 'default',
      title: 'Topic A',
      providerId: 'openai',
      modelId: 'gpt-4.1',
      systemPrompt: '',
      params: {},
      syncEnabled: false,
      syncState: 'local_only' as const,
      syncVersion: 0,
      createdAt: '2026-11-17T08:00:00Z',
      updatedAt: '2026-11-17T08:00:00Z',
    };
    const convB = { ...convA, id: 'cB', title: 'Topic B', updatedAt: '2026-11-17T07:00:00Z' };
    const convC = { ...convA, id: 'cC', title: 'Topic C', updatedAt: '2026-11-17T06:00:00Z' };
    const convStore: Record<string, typeof convA> = { cA: { ...convA }, cB: { ...convB }, cC: { ...convC } };

    let getDetailCountA = 0;
    const streamBodies: Array<{ modelId?: string }> = [];
    let holdPatch = false;
    let releasePatch!: (res: Response) => void;
    let failPatch = false;

    const customFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const bodyStr = typeof init?.body === 'string' ? init.body : undefined;

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
                id: 'openai',
                name: 'OpenAI',
                adapter: 'generic-http',
                baseURL: 'https://api.openai.com/v1',
                authType: 'bearer',
                apiKeyMasked: 'sk-1...89',
                apiKeySet: true,
                models: [
                  { id: 'gpt-4.1', name: 'GPT-4.1', apiFormat: 'openai-responses' },
                  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', apiFormat: 'openai-responses' },
                ],
                enabled: true,
                builtIn: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(
          JSON.stringify({ assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations') && method === 'GET') {
        return new Response(JSON.stringify({ conversations: [convStore.cA, convStore.cB, convStore.cC] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(JSON.stringify({ engines: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/cA') && method === 'GET') {
        getDetailCountA++;
        return new Response(
          JSON.stringify({
            conversation: convStore.cA,
            messages: [
              { id: 'ma1', conversationId: 'cA', role: 'assistant', providerId: 'openai', modelId: 'gpt-4.1', blocks: [{ type: 'text', text: 'History reply' }], stopReason: 'stop', createdAt: '2026-11-17T08:00:00Z' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/cC') && method === 'GET') {
        return new Response(JSON.stringify({ conversation: convStore.cC, messages: [] }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/cA') && method === 'PATCH') {
        const patch = JSON.parse(bodyStr ?? '{}') as Partial<typeof convA>;
        if (holdPatch) {
          holdPatch = false;
          return new Promise<Response>((resolve) => {
            releasePatch = resolve;
          });
        }
        if (failPatch) {
          return new Response(JSON.stringify({ code: 'UPSTREAM_ERROR', message: 'fail patch' }), { status: 500 });
        }
        convStore.cA = { ...convStore.cA, ...patch };
        return new Response(JSON.stringify({ conversation: convStore.cA }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversations/cA/messages/stream') && method === 'POST') {
        streamBodies.push(JSON.parse(bodyStr ?? '{}'));
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode('data: {"type":"message_start","messageId":"ma2"}\n\n'));
            c.enqueue(encoder.encode('data: {"type":"message_end","message":{"id":"ma2","conversationId":"cA","role":"assistant","blocks":[{"type":"text","text":"ok"}],"stopReason":"stop","createdAt":"2026-11-17T08:01:00Z"}}\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 200 });
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={customFetch}>
        <MemoryRouter initialEntries={['/chat/cC']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Topic C')).toBeInTheDocument();
    });

    // Open topic drawer (jsdom default width 1024 < 1200) and enter cA.
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    await user.click(screen.getByRole('button', { name: /^Topic A/ }));
    await waitFor(() => {
      expect(screen.getByText('History reply')).toBeInTheDocument();
    });
    expect(getDetailCountA).toBe(1);

    const historyElBefore = screen.getByText('History reply');
    const draftBox = screen.getByLabelText('消息输入框');
    await user.type(draftBox, '保持草稿不丢');

    // Switch model to GPT-4.1 Mini -> only PATCH, zero extra GET detail, DOM node and draft preserved.
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    await user.click(screen.getByRole('option', { name: /GPT-4\.1 Mini/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1 Mini');
    });
    expect(getDetailCountA).toBe(1);
    expect(screen.getByText('History reply')).toBe(historyElBefore);
    expect(draftBox).toHaveValue('保持草稿不丢');
    // Historical assistant message retains original modelId tag.
    expect(screen.getByText('gpt-4.1')).toBeInTheDocument();

    // Order in sidebar remains Topic A, Topic B, Topic C.
    const titles = Array.from(document.querySelectorAll('.wb-topic-row__title')).map((el) => el.textContent);
    expect(titles).toEqual(['Topic A', 'Topic B', 'Topic C']);

    // Next send uses newly saved modelId.
    fireEvent.keyDown(draftBox, { key: 'Enter' });
    await waitFor(() => expect(streamBodies).toHaveLength(1));
    expect(streamBodies[0].modelId).toBe('gpt-4.1-mini');

    // Failed PATCH keeps old selection and draft.
    failPatch = true;
    await user.type(draftBox, '失败保留');
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    await user.click(screen.getAllByRole('option')[0]);
    await waitFor(() => {
      expect(screen.getByText('切换模型失败')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1 Mini');
    expect(draftBox).toHaveValue('失败保留');

    // Slow PATCH on cA disables picker locally, and switching to cC isolates cC when slow PATCH settles.
    failPatch = false;
    holdPatch = true;
    await user.click(screen.getByRole('button', { name: '选择模型' }));
    await user.click(screen.getAllByRole('option')[0]);
    expect(screen.getByRole('button', { name: '选择模型' })).toBeDisabled();

    // Open drawer and switch to cC (whose model is gpt-4.1); cC's picker is enabled even while cA's PATCH is pending.
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    await user.click(screen.getByRole('button', { name: /^Topic C/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1');
    });
    expect(screen.getByRole('button', { name: '选择模型' })).not.toBeDisabled();

    // Resolve cA's slow PATCH returning gpt-4.1-mini -> must NOT pollute cC!
    releasePatch(
      new Response(
        JSON.stringify({ conversation: { ...convStore.cA, modelId: 'gpt-4.1-mini' } }),
        { status: 200 },
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1');
    });
  });

  it('supports topic groups, pin, manage mode filtered select-all, batch delete/move, and Escape priority', async () => {
    localStorage.clear();
    type OrgConv = {
      id: string;
      assistantId: string;
      title: string;
      providerId: string;
      modelId: string;
      systemPrompt: string;
      params: Record<string, unknown>;
      groupId: string | null;
      pinned: boolean;
      sortOrder: number;
      syncEnabled: boolean;
      syncState: string;
      syncVersion: number;
      createdAt: string;
      updatedAt: string;
    };
    type OrgGroup = {
      id: string;
      assistantId: string;
      name: string;
      sortOrder: number;
      createdAt: string;
    };

    let orgConvs: OrgConv[] = [
      {
        id: 't1',
        assistantId: 'default',
        title: 'Alpha Plan',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        systemPrompt: '',
        params: {},
        groupId: null,
        pinned: false,
        sortOrder: 1,
        syncEnabled: false,
        syncState: 'local_only',
        syncVersion: 0,
        createdAt: '2026-11-17T08:00:00Z',
        updatedAt: '2026-11-17T08:00:00Z',
      },
      {
        id: 't2',
        assistantId: 'default',
        title: 'Alpha Review',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        systemPrompt: '',
        params: {},
        groupId: null,
        pinned: false,
        sortOrder: 2,
        syncEnabled: false,
        syncState: 'local_only',
        syncVersion: 0,
        createdAt: '2026-11-17T07:00:00Z',
        updatedAt: '2026-11-17T07:00:00Z',
      },
      {
        id: 't3',
        assistantId: 'default',
        title: 'Beta Note',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        systemPrompt: '',
        params: {},
        groupId: null,
        pinned: false,
        sortOrder: 3,
        syncEnabled: false,
        syncState: 'local_only',
        syncVersion: 0,
        createdAt: '2026-11-17T06:00:00Z',
        updatedAt: '2026-11-17T06:00:00Z',
      },
    ];
    let orgGroups: OrgGroup[] = [];
    const batchCalls: Array<Record<string, unknown>> = [];
    let failNextBatch = false;

    const { fetchMock } = makeWorkbenchFetch();
    const orgFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const bodyStr = typeof init?.body === 'string' ? init.body : undefined;

      if (url.endsWith('/api/v1/conversations') && method === 'GET') {
        return new Response(JSON.stringify({ conversations: orgConvs }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversation-groups') && method === 'GET') {
        return new Response(JSON.stringify({ groups: orgGroups }), { status: 200 });
      }
      if (url.endsWith('/api/v1/conversation-groups') && method === 'POST') {
        const body = JSON.parse(bodyStr ?? '{}') as { assistantId: string; name: string };
        const grp: OrgGroup = {
          id: 'g-work',
          assistantId: body.assistantId,
          name: body.name,
          sortOrder: 1,
          createdAt: '2026-11-17T09:00:00Z',
        };
        orgGroups = [grp];
        return new Response(
          JSON.stringify({ group: grp, assistantId: 'default', conversations: orgConvs, groups: orgGroups }),
          { status: 201 },
        );
      }
      if (url.endsWith('/api/v1/conversations/batch') && method === 'POST') {
        const body = JSON.parse(bodyStr ?? '{}') as {
          assistantId: string;
          ids: string[];
          operation: 'delete' | 'move' | 'pin';
          groupId?: string | null;
          pinned?: boolean;
        };
        batchCalls.push(body);
        if (failNextBatch) {
          failNextBatch = false;
          return new Response(JSON.stringify({ code: 'UPSTREAM_ERROR', message: '批次拒绝' }), { status: 500 });
        }
        if (body.operation === 'move') {
          orgConvs = orgConvs.map((c) =>
            body.ids.includes(c.id) ? { ...c, groupId: body.groupId ?? null } : c,
          );
        } else if (body.operation === 'pin') {
          orgConvs = orgConvs.map((c) =>
            body.ids.includes(c.id) ? { ...c, pinned: Boolean(body.pinned) } : c,
          );
        } else if (body.operation === 'delete') {
          orgConvs = orgConvs.filter((c) => !body.ids.includes(c.id));
        }
        return new Response(
          JSON.stringify({
            assistantId: 'default',
            conversations: orgConvs,
            groups: orgGroups,
            deletedIds: body.operation === 'delete' ? body.ids : undefined,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/conversations/t1') && method === 'GET') {
        return new Response(JSON.stringify({ conversation: orgConvs[0], messages: [] }), { status: 200 });
      }
      return fetchMock(input, init);
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={orgFetch}>
        <MemoryRouter initialEntries={['/chat/t1']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(screen.getByText('Alpha Plan')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));

    // Create group 'Work'
    await user.click(screen.getByRole('button', { name: '新建分组' }));
    await user.type(screen.getByLabelText('分组名称'), 'Work');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Work/ })).toBeInTheDocument());

    // Enter manage mode, filter by 'Alpha', select all filtered (t1, t2 only, NOT t3).
    const draftBox = screen.getByLabelText('消息输入框');
    await user.type(draftBox, '保留当前草稿');

    await user.click(screen.getByRole('button', { name: '管理话题' }));
    await user.type(screen.getByLabelText('搜索话题'), 'Alpha');
    await user.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();

    // Move selected to 'Work'
    await user.click(screen.getByRole('button', { name: '移至分组' }));
    await user.click(screen.getByRole('radio', { name: 'Work' }));
    await user.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(batchCalls.some((c) => c.operation === 'move' && c.groupId === 'g-work')).toBe(true);
    });

    // Clear search, select only t2 & t3, fail delete keeps selection & current topic t1 & draft!
    await user.clear(screen.getByLabelText('搜索话题'));
    await user.click(screen.getByRole('checkbox', { name: '选择 Alpha Plan' })); // uncheck t1
    await user.click(screen.getByRole('checkbox', { name: '选择 Beta Note' })); // check t3 (now t2 + t3)
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();

    failNextBatch = true;
    await user.click(screen.getByRole('button', { name: '删除 (2)' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.getByText('批次拒绝')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();
    expect(draftBox).toHaveValue('保留当前草稿');

    // Escape exits manage mode first without closing drawer.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: '批量管理' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '管理话题' })).toBeVisible();
  });
});
