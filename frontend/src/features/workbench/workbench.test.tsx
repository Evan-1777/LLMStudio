import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import { defaultAppPreferences } from '../../core/settings';
import { MAX_ATTACHMENT_BYTES, MAX_GATEWAY_BODY_BYTES } from '../../core/types';
import {
  attachmentToContentBlock,
  classifyFile,
  clipboardHasPlainText,
  collectClipboardImageFiles,
  defaultAttachmentName,
  isWithinRequestLimit,
  readAttachmentFile,
  revokeAttachmentResources,
} from './attachments';
import { WorkbenchPage } from './WorkbenchPage';
import { AppearancePage } from '../settings/AppearancePage';
import * as imageCompression from './imageCompression';

function makeWorkbenchFetch(enterToSend?: boolean) {
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
    if (enterToSend !== undefined && url.endsWith('/api/v1/settings') && method === 'GET') {
      return new Response(JSON.stringify({ preferences: { ...defaultAppPreferences(), enterToSend }, initialized: true }));
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

  it('validates attachments (types, size limits, XML attribute escaping, 16 MiB body cap)', () => {
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
      onUpdate: () => {},
    });
    expect(hugeRes.status).toBe('error');
    expect(hugeRes.error).toContain('8 MiB');

    expect(classifyFile({ name: 'vector.svg', type: '' })).toBe('text');
    expect(classifyFile({ name: 'vector', type: 'image/svg+xml' })).toBe('text');
    for (const ext of ['bmp', 'avif', 'jfif', 'ico']) {
      expect(classifyFile({ name: `image.${ext}`, type: '' })).toBe('image');
    }
    expect(classifyFile({ name: 'image.tif', type: 'image/tiff' })).toBe('unsupported');
    expect(classifyFile({ name: 'archive.zip', type: 'application/zip' })).toBe('unsupported');
    const imgFile = new File(['abc'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(imgFile, 'size', { value: 25 * 1024 * 1024 + 1 });
    expect(readAttachmentFile(imgFile, { onUpdate: () => {} })).toMatchObject({
      status: 'error', error: '图片原文件超过 25 MiB 上限',
    });

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
    const boundary = readAttachmentFile(boundaryFile, { onUpdate: () => {} });
    expect(boundary.status).toBe('reading');
    revokeAttachmentResources(boundary);
  });

  it('uses compressed bytes and MIME, revokes the thumbnail, and cancels reads', async () => {
    const source = new File(['source'], 'source.avif', { type: 'image/avif' });
    const encoded = new Blob(['ok'], { type: 'image/webp' });
    const compressed = { blob: encoded, mimeType: encoded.type, originalSize: source.size, compressedSize: encoded.size, compressed: true };
    const compress = vi.spyOn(imageCompression, 'compressImageFile').mockResolvedValue(compressed);
    const create = vi.fn(() => 'blob:thumbnail');
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    });
    try {
      const ready = await new Promise<Parameters<typeof attachmentToContentBlock>[0]>((onUpdate) => {
        expect(readAttachmentFile(source, { onUpdate }).status).toBe('reading');
      });
      expect(attachmentToContentBlock(ready)).toEqual({ type: 'image', mimeType: 'image/webp', data: 'b2s=' });
      expect(ready).toMatchObject({ originalSize: 6, size: 2, previewUrl: 'blob:thumbnail' });
      expect(create).toHaveBeenCalledWith(encoded);
      revokeAttachmentResources(ready);
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:thumbnail');

      const onUpdate = vi.fn();
      const pending = readAttachmentFile(source, { onUpdate });
      revokeAttachmentResources(pending);
      expect(compress.mock.lastCall?.[1]?.signal?.aborted).toBe(true);
      await Promise.resolve();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();

      compress.mockResolvedValueOnce({ ...compressed, compressedSize: MAX_ATTACHMENT_BYTES + 1 });
      await new Promise<void>((resolve) => readAttachmentFile(source, { onUpdate: (attachment) => {
        onUpdate(attachment);
        resolve();
      } }));
      expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: '压缩后图片仍超过 8 MiB 上限' }));
    } finally {
      compress.mockRestore();
      vi.unstubAllGlobals();
    }
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

  it.each([true, false])('handles Enter and IME with gateway enterToSend=%s', async (enterToSend) => {
    localStorage.clear();
    const { fetchMock, requests } = makeWorkbenchFetch(enterToSend);
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
    await waitFor(() => expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1'));
    const box = screen.getByLabelText('消息输入框');
    const submitted = () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/conversations'));
    await user.type(box, '待发送草稿');
    expect(fireEvent.keyDown(box, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(submitted()).toHaveLength(0);

    if (!enterToSend) {
      expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true);
      expect(submitted()).toHaveLength(0);
    }
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: !enterToSend });
    await waitFor(() => expect(submitted()).toHaveLength(1));
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
    const busyPicker = screen.getByRole('button', { name: '选择模型' });
    expect(busyPicker).toHaveAttribute('aria-busy', 'true');
    expect(busyPicker).toHaveAttribute('aria-disabled', 'true');
    expect(busyPicker).toHaveClass('wb-model-btn--busy');

    // Open drawer and switch to cC (whose model is gpt-4.1); cC's picker is enabled even while cA's PATCH is pending.
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    await user.click(screen.getByRole('button', { name: /^Topic C/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择模型' })).toHaveTextContent('GPT-4.1');
    });
    expect(
      screen.getByRole('button', { name: '选择模型' }),
    ).not.toHaveAttribute('aria-disabled', 'true');

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
        groupId: 'g-other',
        pinned: false,
        sortOrder: 3,
        syncEnabled: false,
        syncState: 'local_only',
        syncVersion: 0,
        createdAt: '2026-11-17T06:00:00Z',
        updatedAt: '2026-11-17T06:00:00Z',
      },
    ];
    orgConvs.push({ ...orgConvs[0], id: 't4', title: 'Pinned note', pinned: true, groupId: 'g-work' });
    let orgGroups: OrgGroup[] = [
      { id: 'g-other', assistantId: 'default', name: 'Other', sortOrder: 2, createdAt: '2026-11-17T07:00:00Z' },
      { id: 'g-empty', assistantId: 'default', name: 'Empty', sortOrder: 3, createdAt: '2026-11-17T08:00:00Z' },
    ];
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
        orgGroups = [grp, ...orgGroups];
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

    const search = screen.getByLabelText('搜索话题');
    await user.clear(search);
    const work = screen.getByRole('checkbox', { name: '选择分区 Work' });
    const other = screen.getByRole('checkbox', { name: '选择分区 Other' });
    const pinned = screen.getByRole('checkbox', { name: '选择分区 置顶' });
    const empty = screen.getByRole('checkbox', { name: '选择分区 Empty' });
    const workTitle = screen.getByRole('button', { name: /^Work/ });
    const otherTitle = screen.getByRole('button', { name: /^Other/ });
    expect(workTitle).toHaveAttribute('aria-expanded', 'false');
    expect(otherTitle).toHaveAttribute('aria-expanded', 'false');
    expect(empty).toBeDisabled();
    await user.click(work); // Clear only this group's two selected topics.
    await user.click(otherTitle);
    await user.click(screen.getByRole('checkbox', { name: '选择 Beta Note' }));
    expect(other).toBeChecked();
    expect(work).not.toBeChecked();
    expect(work).not.toBePartiallyChecked();
    await user.click(workTitle);
    await user.click(screen.getByRole('checkbox', { name: '选择 Alpha Plan' }));
    expect(work).toBePartiallyChecked();
    work.focus();
    await user.keyboard(' ');
    expect(work).toBeChecked();
    expect(pinned).not.toBeChecked(); // A pinned member does not belong to the visible Work bucket.
    await user.click(work);
    expect(work).not.toBeChecked();
    expect(other).toBeChecked();
    await user.click(workTitle);
    expect(workTitle).toHaveAttribute('aria-expanded', 'false');
    await user.click(work);
    expect(screen.getByText('已选 3 项')).toBeInTheDocument();
    expect(workTitle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: '选择 Alpha Plan' })).not.toBeInTheDocument();

    // Selecting a filtered partition affects only matching items; hidden selections survive.
    await user.type(search, 'Alpha Plan');
    const matches = screen.getByRole('checkbox', { name: '选择分区 Work的搜索结果' });
    expect(matches).toBeChecked();
    await user.click(matches);
    await user.clear(search);
    expect(work).toBePartiallyChecked();
    expect(other).toBeChecked();
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();

    failNextBatch = true;
    await user.click(screen.getByRole('button', { name: '删除 (2)' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.getByText('批次拒绝')).toBeInTheDocument());
    expect(batchCalls.at(-1)).toMatchObject({ operation: 'delete', ids: ['t2', 't3'] });
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();
    expect(draftBox).toHaveValue('保留当前草稿');

    // Escape exits manage mode first without closing drawer.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: '批量管理' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '管理话题' })).toBeVisible();
  });

  it('supports temporary session lifecycle, footer server sync, and manual chat width toggle', async () => {
    let remoteSynced = false;
    let currentWidthMode: 'default' | 'manual' = 'default';
    const deletedIds: string[] = [];
    const createdPayloads: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const bodyStr = typeof init?.body === 'string' ? init.body : undefined;

      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.0', authRequired: false }));
      }
      if (url.endsWith('/api/v1/settings') && method === 'GET') {
        return new Response(
          JSON.stringify({
            preferences: { ...defaultAppPreferences(), chatWidthMode: currentWidthMode },
            initialized: true,
          }),
        );
      }
      if (url.endsWith('/api/v1/settings') && method === 'PATCH') {
        const patch = JSON.parse(bodyStr ?? '{}') as { chatWidthMode?: 'default' | 'manual' };
        if (patch.chatWidthMode) currentWidthMode = patch.chatWidthMode;
        return new Response(
          JSON.stringify({
            preferences: { ...defaultAppPreferences(), chatWidthMode: currentWidthMode },
            initialized: true,
          }),
        );
      }
      if (url.endsWith('/api/v1/formats')) {
        return new Response(JSON.stringify({ formats: [], adapters: [] }));
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
                apiKeyMasked: 'sk-1...2',
                apiKeySet: true,
                models: [{ id: 'gpt-4.1', name: 'GPT-4.1', apiFormat: 'openai-responses', contextWindow: 10000 }],
                enabled: true,
                builtIn: true,
              },
            ],
          }),
        );
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(
          JSON.stringify({
            assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }],
          }),
        );
      }
      if (url.endsWith('/api/v1/conversations') && method === 'GET') {
        const list = [
          {
            id: 'c1',
            assistantId: 'default',
            title: '原有话题',
            providerId: 'openai',
            modelId: 'gpt-4.1',
            params: {},
            syncEnabled: false,
            syncState: 'local_only',
            syncVersion: 0,
            createdAt: '2026-11-19T08:00:00Z',
            updatedAt: '2026-11-19T08:00:00Z',
          },
          ...(remoteSynced
            ? [
                {
                  id: 'c-remote',
                  assistantId: 'default',
                  title: '他端新增话题',
                  providerId: 'openai',
                  modelId: 'gpt-4.1',
                  params: {},
                  syncEnabled: false,
                  syncState: 'local_only',
                  syncVersion: 0,
                  createdAt: '2026-11-19T09:00:00Z',
                  updatedAt: '2026-11-19T09:00:00Z',
                },
              ]
            : []),
        ];
        return new Response(JSON.stringify({ conversations: list }));
      }
      if (url.endsWith('/api/v1/conversation-groups')) {
        return new Response(JSON.stringify({ groups: [] }));
      }
      if (url.endsWith('/api/v1/conversations') && method === 'POST') {
        const parsed = JSON.parse(bodyStr ?? '{}') as Record<string, unknown>;
        createdPayloads.push(parsed);
        return new Response(
          JSON.stringify({
            conversation: {
              id: 'temp-1',
              assistantId: 'default',
              title: 'Temp',
              providerId: 'openai',
              modelId: 'gpt-4.1',
              params: {},
              ephemeral: Boolean(parsed.ephemeral),
              syncEnabled: false,
              syncState: 'local_only',
              syncVersion: 0,
              createdAt: '2026-11-19T10:00:00Z',
              updatedAt: '2026-11-19T10:00:00Z',
            },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith('/messages/stream') && method === 'POST') {
        const sse = new TextEncoder().encode(
          'data: {"type":"message_start","messageId":"m-temp-a1"}\n\n' +
            'data: {"type":"block_start","index":0,"blockType":"text"}\n\n' +
            'data: {"type":"block_delta","index":0,"blockType":"text","deltaType":"text_delta","delta":"临时回复"}\n\n' +
            'data: {"type":"message_end","messageId":"m-temp-a1","message":{"id":"m-temp-a1","conversationId":"temp-1","role":"assistant","blocks":[{"type":"text","text":"临时回复"}],"stopReason":"stop","createdAt":"2026-11-19T10:00:01Z"}}\n\n',
        );
        return new Response(sse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/api/v1/conversations/temp-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            conversation: {
              id: 'temp-1',
              assistantId: 'default',
              title: 'Temp',
              providerId: 'openai',
              modelId: 'gpt-4.1',
              params: {},
              ephemeral: true,
              syncEnabled: false,
              syncState: 'local_only',
              syncVersion: 0,
              createdAt: '2026-11-19T10:00:00Z',
              updatedAt: '2026-11-19T10:00:00Z',
            },
            messages: [
              { id: 'm-temp-u1', conversationId: 'temp-1', role: 'user', blocks: [{ type: 'text', text: 'temp hello' }], createdAt: '2026-11-19T10:00:00Z' },
              { id: 'm-temp-a1', conversationId: 'temp-1', role: 'assistant', blocks: [{ type: 'text', text: '临时回复' }], stopReason: 'stop', createdAt: '2026-11-19T10:00:01Z' },
            ],
          }),
        );
      }
      if (url.endsWith('/api/v1/conversations/temp-1') && method === 'DELETE') {
        deletedIds.push('temp-1');
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/v1/conversations/c1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            conversation: {
              id: 'c1',
              assistantId: 'default',
              title: '原有话题',
              providerId: 'openai',
              modelId: 'gpt-4.1',
              params: {},
              syncEnabled: false,
              syncState: 'local_only',
              syncVersion: 0,
              createdAt: '2026-11-19T08:00:00Z',
              updatedAt: '2026-11-19T08:00:00Z',
            },
            messages: [],
          }),
        );
      }
      if (url.endsWith('/api/v1/plugins/search')) {
        return new Response(JSON.stringify({ engines: [] }));
      }
      if (url.endsWith('/api/v1/mcp/servers')) {
        return new Response(JSON.stringify({ servers: [] }));
      }
      return new Response('{}', { status: 200 });
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat']}>
          <Routes>
            <Route path="/chat" element={<WorkbenchPage />} />
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
            <Route path="/settings/appearance" element={<AppearancePage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(screen.getByText('原有话题')).toBeInTheDocument());

    // Enter temporary mode -> badge renders -> send creates ephemeral conversation hidden from sidebar.
    await user.click(screen.getByRole('button', { name: '临时会话' }));
    expect(screen.getByText('临时会话')).toBeInTheDocument();
    await user.type(screen.getByLabelText('消息输入框'), 'temp hello');
    await user.click(screen.getByRole('button', { name: '发送消息' }));

    await waitFor(() => expect(screen.getByText('临时回复')).toBeInTheDocument());
    expect(createdPayloads.some((p) => p.ephemeral === true)).toBe(true);
    expect(screen.queryByText('Temp')).not.toBeInTheDocument();

    // Footer sync bar fetches updated remote conversations while keeping ephemeral session intact.
    remoteSynced = true;
    await user.click(screen.getByRole('button', { name: '切换话题栏' }));
    await user.click(screen.getByRole('button', { name: '刷新服务端数据' }));
    await waitFor(() => expect(screen.getByText('他端新增话题')).toBeInTheDocument());
    expect(screen.getByText('临时回复')).toBeInTheDocument();
    expect(deletedIds).toEqual([]);

    // Exit temporary mode -> deletes ephemeral server session.
    await user.click(screen.getByRole('button', { name: '退出临时会话' }));
    await waitFor(() => expect(deletedIds).toEqual(['temp-1']));
  });

  it('toggles manual chat width and typography preferences from AppearancePage', async () => {
    let widthMode: 'default' | 'manual' = 'default';
    let fontFamily = 'system';
    let fontSize = 14;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.0', authRequired: false }));
      }
      if (url.endsWith('/api/v1/settings') && method === 'GET') {
        return new Response(
          JSON.stringify({
            preferences: { ...defaultAppPreferences(), chatWidthMode: widthMode, fontFamily, fontSize },
            initialized: true,
          }),
        );
      }
      if (url.endsWith('/api/v1/settings') && method === 'PATCH') {
        const patch = JSON.parse(String(init?.body ?? '{}')) as {
          chatWidthMode?: 'default' | 'manual';
          fontFamily?: string;
          fontSize?: number;
        };
        if (patch.chatWidthMode) widthMode = patch.chatWidthMode;
        if (patch.fontFamily) fontFamily = patch.fontFamily;
        if (typeof patch.fontSize === 'number') fontSize = patch.fontSize;
        return new Response(
          JSON.stringify({
            preferences: { ...defaultAppPreferences(), chatWidthMode: widthMode, fontFamily, fontSize },
            initialized: true,
          }),
        );
      }
      if (url.endsWith('/api/v1/formats')) return new Response(JSON.stringify({ formats: [], adapters: [] }));
      if (url.endsWith('/api/v1/providers')) return new Response(JSON.stringify({ providers: [] }));
      if (url.endsWith('/api/v1/assistants')) return new Response(JSON.stringify({ assistants: [] }));
      if (url.endsWith('/api/v1/conversations')) return new Response(JSON.stringify({ conversations: [] }));
      if (url.endsWith('/api/v1/conversation-groups')) return new Response(JSON.stringify({ groups: [] }));
      if (url.endsWith('/api/v1/plugins/search')) return new Response(JSON.stringify({ engines: [] }));
      if (url.endsWith('/api/v1/mcp/servers')) return new Response(JSON.stringify({ servers: [] }));
      return new Response('{}');
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <AppearancePage />
      </AppProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: '手动调整对话宽度' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(widthMode).toBe('manual'));
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole('radio', { name: '衬线' }));
    await waitFor(() => expect(fontFamily).toBe('serif'));
    expect(document.documentElement.dataset.fontFamily).toBe('serif');

    await user.click(screen.getByRole('button', { name: '增大字号' }));
    await waitFor(() => expect(fontSize).toBe(15));
    expect(
      document.documentElement.style.getPropertyValue('--font-size-base'),
    ).toBe('15px');
  });

  it('triggers context compaction from ContextUsageRing, expands checkpoint card, and deletes checkpoint', async () => {
    localStorage.clear();
    const conv = {
      id: 'c1',
      assistantId: 'default',
      title: '压缩测试话题',
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
    const initialMsgs = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        blocks: [{ type: 'text', text: '旧问题' }],
        createdAt: '2026-11-17T08:00:01Z',
      },
      {
        id: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        blocks: [{ type: 'text', text: '旧回答' }],
        usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000, contextTokens: 1000 },
        createdAt: '2026-11-17T08:00:02Z',
      },
      {
        id: 'm3',
        conversationId: 'c1',
        role: 'user',
        blocks: [{ type: 'text', text: '保留问题' }],
        createdAt: '2026-11-17T08:00:03Z',
      },
      {
        id: 'm4',
        conversationId: 'c1',
        role: 'assistant',
        blocks: [{ type: 'text', text: '保留回答' }],
        usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, contextTokens: 12000 },
        createdAt: '2026-11-17T08:00:04Z',
      },
    ];
    let messages = [...initialMsgs];
    let failFirstCompact = true;
    let resolveCompact!: () => void;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ status: 'ok', version: '1.0', authRequired: false }));
      }
      if (url.endsWith('/api/v1/settings')) {
        return new Response(JSON.stringify({ preferences: defaultAppPreferences(), initialized: true }));
      }
      if (url.endsWith('/api/v1/formats')) return new Response(JSON.stringify({ formats: [], adapters: [] }));
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
                enabled: true,
                models: [
                  { id: 'gpt-4.1', name: 'GPT-4.1', apiFormat: 'openai-responses', contextWindow: 128000 },
                ],
              },
            ],
          }),
        );
      }
      if (url.endsWith('/api/v1/assistants')) {
        return new Response(JSON.stringify({ assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }] }));
      }
      if (url.endsWith('/api/v1/conversations')) {
        return new Response(JSON.stringify({ conversations: [conv] }));
      }
      if (url.endsWith('/api/v1/conversation-groups')) return new Response(JSON.stringify({ groups: [] }));
      if (url.endsWith('/api/v1/plugins/search')) return new Response(JSON.stringify({ engines: [] }));
      if (url.endsWith('/api/v1/mcp/servers')) return new Response(JSON.stringify({ servers: [] }));
      if (url.endsWith('/api/v1/conversations/c1') && method === 'GET') {
        return new Response(JSON.stringify({ conversation: conv, messages }));
      }
      if (url.endsWith('/api/v1/conversations/c1/compact') && method === 'POST') {
        if (failFirstCompact) {
          failFirstCompact = false;
          return new Response(JSON.stringify({ code: 'UPSTREAM_ERROR', message: '上游暂时不可用' }), { status: 502 });
        }
        await new Promise<void>((resolve) => {
          resolveCompact = resolve;
        });
        const checkpoint = {
          id: 'cmp-1',
          conversationId: 'c1',
          role: 'compaction',
          blocks: [
            {
              type: 'compaction',
              text: '## 核心目标与约束\n保留旧约束',
              extra: {
                snapshotLastMessageId: 'm4',
                compactedCount: 2,
                beforeTokens: 12000,
                afterTokens: 400,
              },
            },
          ],
          createdAt: '2026-11-17T08:00:05Z',
        };
        messages = [initialMsgs[0], initialMsgs[1], checkpoint, initialMsgs[2], initialMsgs[3]];
        return new Response(
          JSON.stringify({
            message: checkpoint,
            conversation: conv,
            messages,
            meta: checkpoint.blocks[0].extra,
          }),
        );
      }
      if (url.endsWith('/api/v1/conversations/c1/messages/cmp-1') && method === 'DELETE') {
        messages = [...initialMsgs];
        return new Response(null, { status: 204 });
      }
      return new Response('{}');
    });

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter initialEntries={['/chat/c1']}>
          <Routes>
            <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(screen.getByText('保留回答')).toBeInTheDocument());

    const ringBtn = screen.getByRole('button', { name: /上下文占用 9%/ });
    expect(ringBtn).toHaveTextContent('9%');
    await user.click(ringBtn);

    const compactBtn = await screen.findByRole('button', { name: '压缩上下文' });
    await user.click(compactBtn);
    await waitFor(() => expect(screen.getByText('上游暂时不可用')).toBeInTheDocument());

    // Retry succeeds and exposes busy state while compacting.
    await user.click(screen.getByRole('button', { name: '压缩上下文' }));
    await waitFor(() => expect(screen.getByText('正在压缩…')).toBeInTheDocument());
    resolveCompact();

    const card = await screen.findByLabelText('压缩检查点');
    expect(within(card).getByText('已折叠 2 条')).toBeInTheDocument();
    expect(within(card).getByText('12K → 400')).toBeInTheDocument();

    // Expand summary card.
    const togglePill = screen.getByRole('button', { name: /上下文已压缩/ });
    expect(togglePill).toHaveAttribute('aria-expanded', 'false');
    await user.click(togglePill);
    expect(togglePill).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('保留旧约束')).toBeInTheDocument();

    // Delete checkpoint via ConfirmDialog.
    await user.click(screen.getByRole('button', { name: '删除压缩检查点' }));
    expect(screen.getByText('删除后将恢复此前历史消息进入上下文。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(screen.queryByLabelText('压缩检查点')).not.toBeInTheDocument());
    expect(screen.queryByRole('radio', { name: '本地话题' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '云端话题' })).toBeNull();
  });

  it('desktop mode switches local/cloud scopes, handles upload/pull conflicts with ConfirmDialog, and routes streaming through loopback', async () => {
    window.__LLMSTUDIO_DESKTOP__ = {
      apiBaseUrl: 'http://127.0.0.1:45125',
      sessionToken: 'desktop-wb-tok',
      platform: 'windows',
      dataMode: 'portable',
      version: '1.5.0',
    };

    try {
      const localConvs = [
        {
          id: 'loc-1',
          assistantId: 'default',
          title: '本地研究笔记',
          providerId: 'openai',
          modelId: 'gpt-4.1',
          params: {},
          syncEnabled: false,
          syncState: 'local_only',
          syncVersion: 0,
          createdAt: '2026-11-20T08:00:00Z',
          updatedAt: '2026-11-20T08:00:00Z',
        },
        {
          id: 'loc-2',
          assistantId: 'default',
          title: '本地草稿二',
          providerId: 'openai',
          modelId: 'gpt-4.1',
          params: {},
          syncEnabled: false,
          syncState: 'local_only',
          syncVersion: 0,
          createdAt: '2026-11-20T08:05:00Z',
          updatedAt: '2026-11-20T08:05:00Z',
        },
      ];
      let cloudConvs = [
        {
          id: 'cld-1',
          assistantId: 'default',
          title: '云端架构讨论',
          providerId: 'openai',
          modelId: 'gpt-4.1',
          params: {},
          syncEnabled: true,
          syncState: 'synced',
          syncVersion: 1,
          createdAt: '2026-11-20T07:00:00Z',
          updatedAt: '2026-11-20T07:00:00Z',
        },
      ];
      const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
      let prepareLocalCalled = false;

      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        const parsed =
          typeof init?.body === 'string' && init.body
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        calls.push({ method, url, body: parsed });

        if (url.includes('/prepare-local')) {
          prepareLocalCalled = true;
        }
        if (url.endsWith('/api/v1/desktop/status')) {
          return Response.json({
            mode: 'portable',
            dataDir: 'D:\\LLMStudio\\data',
            dbPath: 'D:\\LLMStudio\\data\\llmstudio.db',
            cloudConfigured: true,
            cloudState: 'connected',
            gatewayBaseUrl: 'https://cloud.example.com',
            tokenSet: true,
            authRequired: true,
            version: '1.5.0',
          });
        }
        if (url.endsWith('/api/v1/settings')) {
          return Response.json({ preferences: defaultAppPreferences(), initialized: true });
        }
        if (url.endsWith('/api/v1/formats')) return Response.json({ formats: [], adapters: [] });
        if (url.endsWith('/api/v1/providers')) {
          return Response.json({
            providers: [
              {
                id: 'openai',
                name: 'OpenAI',
                adapter: 'generic-http',
                baseURL: 'https://api.openai.com/v1',
                authType: 'bearer',
                apiKeyMasked: 'sk-1...89',
                apiKeySet: true,
                enabled: true,
                builtIn: true,
                localRequest: true,
                models: [{ id: 'gpt-4.1', name: 'GPT-4.1', apiFormat: 'openai-responses' }],
              },
            ],
          });
        }
        if (url.endsWith('/api/v1/assistants')) {
          return Response.json({
            assistants: [{ id: 'default', name: '默认助手', params: {}, isDefault: true }],
          });
        }
        if (url.includes('/api/v1/conversations?') || url.endsWith('/api/v1/conversations')) {
          const isCloud = url.includes('scope=cloud');
          return Response.json({ conversations: isCloud ? cloudConvs : localConvs });
        }
        if (url.includes('/api/v1/conversation-groups')) {
          return Response.json({ groups: [] });
        }
        if (url.endsWith('/api/v1/plugins/search')) return Response.json({ engines: [] });
        if (url.includes('/api/v1/mcp/servers')) return Response.json({ servers: [] });

        if (url.includes('/api/v1/desktop/conversations/loc-1/upload') && method === 'POST') {
          if (!parsed?.force) {
            return Response.json(
              { code: 'CONFLICT', message: '云端存在较新版本' },
              { status: 409 },
            );
          }
          const uploaded = {
            ...localConvs[0],
            groupId: null,
            syncEnabled: true,
            syncState: 'synced',
            syncVersion: 2,
          };
          cloudConvs = [...cloudConvs, uploaded];
          return Response.json({ conversation: uploaded, messages: [] });
        }

        if (url.endsWith('/api/v1/desktop/conversations/batch-transfer') && method === 'POST') {
          return Response.json({
            direction: 'upload',
            succeeded: (parsed?.ids as string[]) ?? [],
            failed: [],
          });
        }

        if (url.includes('/api/v1/desktop/conversations/cld-1/pull') && method === 'POST') {
          return Response.json({
            conversation: { ...cloudConvs[0], groupId: null, syncState: 'synced' },
            messages: [],
          });
        }

        if (url.includes('/api/v1/conversations/loc-1/messages/stream') && method === 'POST') {
          const sse = [
            'event: message_start\ndata: {"type":"message_start","messageId":"m-u1","conversationId":"loc-1"}\n\n',
            'event: block_start\ndata: {"type":"block_start","index":0,"blockType":"text"}\n\n',
            'event: block_delta\ndata: {"type":"block_delta","index":0,"delta":"回环响应"}\n\n',
            'event: message_end\ndata: {"type":"message_end","messageId":"m-a1","stopReason":"stop"}\n\n',
          ].join('');
          return new Response(sse, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        if (url.includes('/api/v1/conversations/loc-1') && method === 'GET') {
          return Response.json({
            conversation: localConvs[0],
            messages: [
              {
                id: 'm-u1',
                conversationId: 'loc-1',
                role: 'user',
                blocks: [{ type: 'text', text: '本地测试' }],
                createdAt: '2026-11-20T08:00:01Z',
              },
              {
                id: 'm-a1',
                conversationId: 'loc-1',
                role: 'assistant',
                blocks: [{ type: 'text', text: '回环响应' }],
                createdAt: '2026-11-20T08:00:02Z',
              },
            ],
          });
        }

        return Response.json({});
      });

      const user = userEvent.setup();
      render(
        <AppProvider fetchImpl={fetchMock}>
          <MemoryRouter initialEntries={['/chat/loc-1?scope=local']}>
            <Routes>
              <Route path="/chat" element={<WorkbenchPage />} />
              <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
              <Route path="/settings/connection" element={<div>conn-page</div>} />
            </Routes>
          </MemoryRouter>
        </AppProvider>,
      );

      await waitFor(() => expect(screen.getByText('本地研究笔记')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: '切换话题栏' }));
      expect(screen.getByRole('radio', { name: '本地话题' })).toBeChecked();
      expect(screen.queryByText('云端架构讨论')).toBeNull();

      // Send a message with provider.localRequest=true: desktop still uses loopback stream, never prepare-local.
      const composer = screen.getByLabelText('消息输入框');
      await user.type(composer, '桌面回环消息');
      await user.click(screen.getByRole('button', { name: '发送消息' }));
      await waitFor(() =>
        expect(
          calls.some((c) =>
            c.url.includes('/api/v1/conversations/loc-1/messages/stream?scope=local'),
          ),
        ).toBe(true),
      );
      await waitFor(() => expect(screen.getByText('回环响应')).toBeInTheDocument());
      expect(prepareLocalCalled).toBe(false);

      // Single upload triggers 409 conflict dialog -> confirm retries with force=true.
      const locRow = screen.getByText('本地研究笔记').closest('.wb-topic-row') as HTMLElement;
      await user.click(within(locRow).getByRole('button', { name: '上传至云端' }));
      const conflictDlg = await screen.findByRole('dialog', { name: '覆盖云端话题？' });
      expect(conflictDlg).toHaveTextContent(/分组不跨端迁移/);
      await user.click(within(conflictDlg).getByRole('button', { name: '覆盖' }));
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.url.includes('/api/v1/desktop/conversations/loc-1/upload') &&
              c.body?.force === true,
          ),
        ).toBe(true),
      );

      // Batch upload in manage mode (select both items to trigger batch-transfer endpoint).
      await user.click(screen.getByRole('button', { name: '管理话题' }));
      await user.click(screen.getByLabelText('选择 本地研究笔记'));
      await user.click(screen.getByLabelText('选择 本地草稿二'));
      await user.click(screen.getByRole('button', { name: '批量上传至云端' }));
      await waitFor(() =>
        expect(
          calls.some((c) => c.url.endsWith('/api/v1/desktop/conversations/batch-transfer')),
        ).toBe(true),
      );

      // Switch to cloud scope and pull cloud conversation to local.
      await user.click(screen.getByRole('radio', { name: '云端话题' }));
      await waitFor(() => expect(screen.getByText('云端架构讨论')).toBeInTheDocument());
      const cldRow = screen.getByText('云端架构讨论').closest('.wb-topic-row') as HTMLElement;
      await user.click(within(cldRow).getByRole('button', { name: '拉取至本地' }));
      await waitFor(() =>
        expect(
          calls.some((c) => c.url.endsWith('/api/v1/desktop/conversations/cld-1/pull')),
        ).toBe(true),
      );
    } finally {
      delete window.__LLMSTUDIO_DESKTOP__;
      delete document.documentElement.dataset.desktop;
    }
  });
});
