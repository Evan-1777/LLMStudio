import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, type GatewayClient } from '../../core/gateway';
import type {
  AgentSettings,
  TopicScope,
  WorkspaceEntriesResponse,
  WorkspaceEntry,
  WorkspaceFileDocument,
} from '../../core/types';
import { ConversationSidebar } from '../workbench/ConversationSidebar';
import { WorkspaceFileTree } from './WorkspaceFileTree';

const appState = vi.hoisted(() => ({
  isDesktop: false,
  cloudConnectionState: 'connected' as 'connected' | 'disconnected',
  connectionEpoch: 1,
  gateway: {
    listWorkspaceEntries: vi.fn(),
    readWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn(),
    createWorkspaceFile: vi.fn(),
    createWorkspaceDir: vi.fn(),
    moveWorkspaceEntry: vi.fn(),
    copyWorkspaceEntry: vi.fn(),
    deleteWorkspaceEntry: vi.fn(),
    batchWorkspaceEntries: vi.fn(),
    uploadWorkspaceFile: vi.fn(),
    downloadWorkspaceFile: vi.fn(),
    searchWorkspaceEntries: vi.fn(),
    getAgentSettings: vi.fn(),
  },
  resources: {
    localConversations: [],
    cloudConversations: [],
  },
  upsertLocalConversation: vi.fn(),
  applyConversationOrganizationSnapshot: vi.fn(),
  uploadConversations: vi.fn(),
  pullConversations: vi.fn(),
  toast: vi.fn(),
  settings: {
    mathRenderEnabled: true,
    visualHtmlRender: true,
    defaultHtmlPreview: false,
    autoCollapseEnabled: false,
    collapseLineThreshold: 40,
    collapseCharThreshold: 2000,
  },
  resolvedTheme: 'light' as const,
}));

vi.mock('../../app/AppProvider', () => ({
  useApp: () => appState,
}));

afterEach(() => {
  vi.clearAllMocks();
  appState.isDesktop = false;
  appState.cloudConnectionState = 'connected';
  appState.connectionEpoch = 1;
});

function renderSidebar(scope: TopicScope = 'cloud', onScopeChange = vi.fn()) {
  return render(
    <MemoryRouter>
      <ConversationSidebar
        assistantId="default"
        conversations={[]}
        groups={[]}
        activeConversationId={null}
        activeConversation={null}
        draftSessionParams={{ systemPrompt: '', params: {} }}
        inspectorOpen={false}
        drawerOpen={false}
        manageMode={false}
        isBusy={false}
        scope={scope}
        onScopeChange={onScopeChange}
        onManageModeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onNewConversation={vi.fn()}
        onCloseInspector={vi.fn()}
        onCloseDrawer={vi.fn()}
        onConversationPatched={vi.fn()}
        onConversationsDeleted={vi.fn()}
        onSaveDraftSessionParams={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('WorkspaceFileBrowser', () => {
  it('disables header mutations when the root is not configured or returns an error', async () => {
    const user = userEvent.setup();
    appState.gateway.listWorkspaceEntries
      .mockRejectedValueOnce(new GatewayError('INVALID_ARGUMENT', '工作目录不可用', 400))
      .mockRejectedValueOnce(new GatewayError('INTERNAL_ERROR', '无法读取目录', 500));
    renderSidebar();
    await user.click(screen.getByRole('radio', { name: '工作区文件' }));
    await screen.findByText('未配置工作区目录');
    for (const name of ['新建文件', '新建文件夹', '管理文件']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    await user.click(screen.getByRole('button', { name: '重新检测工作区' }));
    await screen.findByText('无法读取目录');
    expect(screen.getByRole('button', { name: '管理文件' })).toBeDisabled();
  });

  it('passes the refreshed editable entry to the viewer after a batch move', async () => {
    const user = userEvent.setup();
    const metadata = { size: 12, modTime: '2026-11-22T00:00:00Z' };
    const dir: WorkspaceEntry = { ...metadata, name: 'docs', path: 'docs', kind: 'dir', editable: false };
    const file: WorkspaceEntry = { ...metadata, name: 'notes.md', path: 'notes.md', kind: 'file', previewKind: 'markdown', editable: true };
    const moved = { ...file, path: 'docs/notes.md' };
    let didMove = false;
    appState.gateway.listWorkspaceEntries.mockImplementation(async (p: string) => ({
      path: p || '.',
      entries: p === 'docs' ? (didMove ? [moved] : []) : (didMove ? [dir] : [dir, file]),
      truncated: false,
    }));
    appState.gateway.batchWorkspaceEntries.mockImplementation(async () => {
      didMove = true;
      return { operation: 'move', succeeded: [file.path], failed: [] };
    });
    const onEntryMoved = vi.fn();
    render(<WorkspaceFileTree
      gateway={appState.gateway as unknown as GatewayClient}
      isDesktop={false}
      cloudConnectionState="connected"
      connectionEpoch={1}
      selectedPath={file.path}
      manageMode
      onManageModeChange={vi.fn()}
      onSelectEntry={vi.fn()}
      onEntryMoved={onEntryMoved}
    />);
    await user.click(await screen.findByRole('checkbox', { name: '选择 notes.md' }));
    await user.click(screen.getByRole('button', { name: '批量移动' }));
    const dialog = await screen.findByRole('dialog', { name: '移动「1 项」' });
    await user.click(await within(dialog).findByRole('listitem', { name: 'docs' }));
    await user.click(within(dialog).getByRole('button', { name: '移至此处' }));
    await waitFor(() => expect(onEntryMoved).toHaveBeenCalledExactlyOnceWith(file.path, moved));
  });

  it('lazily expands directories, respects image/binary blocks, gates Markdown visual HTML on agent settings, saves with Cmd/Ctrl+S, handles 409 conflicts, and confirms dirty close', async () => {
    const user = userEvent.setup();
    const rootEntries: WorkspaceEntriesResponse = {
      path: '.',
      truncated: false,
      entries: [
        { name: '.agent', path: '.agent', kind: 'dir', size: 0, modTime: '2026-11-22T00:00:00Z', editable: false },
        { name: 'notes.md', path: 'notes.md', kind: 'file', size: 120, modTime: '2026-11-22T00:00:00Z', previewKind: 'markdown', editable: true },
        { name: 'logo.png', path: 'logo.png', kind: 'file', size: 2048, modTime: '2026-11-22T00:00:00Z', previewKind: 'unsupported', editable: false, unsupportedReason: 'image' },
        { name: 'data.bin', path: 'data.bin', kind: 'file', size: 512, modTime: '2026-11-22T00:00:00Z', previewKind: 'unsupported', editable: false, unsupportedReason: 'binary' },
      ],
    };
    const agentEntries: WorkspaceEntriesResponse = {
      path: '.agent',
      truncated: false,
      entries: [
        { name: 'skills', path: '.agent/skills', kind: 'dir', size: 0, modTime: '2026-11-22T00:00:00Z', editable: false },
      ],
    };
    const skillEntries: WorkspaceEntriesResponse = {
      path: '.agent/skills',
      truncated: false,
      entries: [
        { name: 'SKILL.md', path: '.agent/skills/SKILL.md', kind: 'file', size: 42, modTime: '2026-11-22T00:00:00Z', previewKind: 'markdown', editable: true },
      ],
    };

    appState.gateway.listWorkspaceEntries.mockImplementation(async (p: string) => {
      if (!p) return rootEntries;
      if (p === '.agent') return agentEntries;
      if (p === '.agent/skills') return skillEntries;
      return { path: p, entries: [], truncated: false };
    });

    const mdContent = [
      '# Title',
      '',
      '<div>visual-block</div>',
      '',
      '<details><summary>Details</summary><p>Hidden</p></details>',
      '',
      '```html',
      '<p>fenced-html</p>',
      '```',
    ].join('\n');

    const mdDoc: WorkspaceFileDocument = {
      path: 'notes.md',
      name: 'notes.md',
      size: 120,
      modTime: '2026-11-22T00:00:00Z',
      previewKind: 'markdown',
      editable: true,
      etag: 'etag-1',
      content: mdContent,
    };
    const baseAgentSettings: AgentSettings = {
      directory: { path: '.', status: 'ready' },
      allowedTools: [],
      availableTools: ['read', 'skill'],
      injectAgentMd: true,
      markdownVisualRender: false,
      skills: [],
    };
    appState.gateway.readWorkspaceFile.mockResolvedValue(mdDoc);
    appState.gateway.getAgentSettings.mockResolvedValue(baseAgentSettings);

    renderSidebar();

    // Switch right sidebar from topics to workspace files.
    await user.click(screen.getByRole('radio', { name: '工作区文件' }));
    await screen.findByRole('treeitem', { name: 'notes.md' });

    // Lazy expand .agent -> .agent/skills
    await user.click(screen.getByRole('treeitem', { name: '.agent' }));
    await user.click(await screen.findByRole('treeitem', { name: 'skills' }));
    await screen.findByRole('treeitem', { name: 'SKILL.md' });

    // Unsupported image & binary do not fetch file content.
    await user.click(screen.getByRole('treeitem', { name: 'logo.png' }));
    expect(await screen.findByText('图片暂不支持预览')).toBeInTheDocument();
    expect(appState.gateway.readWorkspaceFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '关闭' }));

    await user.click(screen.getByRole('treeitem', { name: 'data.bin' }));
    expect(await screen.findByText('暂不支持预览此文件类型')).toBeInTheDocument();
    expect(appState.gateway.readWorkspaceFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '关闭' }));

    // Open notes.md with markdownVisualRender=false -> no sandbox iframe mounted.
    await user.click(screen.getByRole('treeitem', { name: 'notes.md' }));
    await screen.findByRole('heading', { name: 'Title' });
    expect(screen.queryByTitle('HTML 预览')).not.toBeInTheDocument();

    // Re-open with markdownVisualRender=true -> sandboxed iframes mount.
    await user.click(screen.getByRole('button', { name: '关闭' }));
    appState.gateway.getAgentSettings.mockResolvedValue({
      ...baseAgentSettings,
      markdownVisualRender: true,
    });
    await user.click(screen.getByRole('treeitem', { name: 'notes.md' }));
    await screen.findByRole('heading', { name: 'Title' });
    expect(screen.getAllByTitle('HTML 预览')).toHaveLength(3);

    // Switch to edit mode, modify, trigger dirty close confirm, cancel, then save with Ctrl+S -> 409 conflict -> force overwrite.
    await user.click(screen.getByRole('radio', { name: '编辑' }));
    const editor = screen.getByLabelText('文件内容编辑');
    await user.clear(editor);
    await user.type(editor, '# Edited');
    expect(screen.getByLabelText('未保存')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '关闭' }));
    const confirm = await screen.findByRole('dialog', { name: '放弃未保存的更改？' });
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(screen.getByLabelText('文件内容编辑')).toHaveValue('# Edited');

    appState.gateway.writeWorkspaceFile
      .mockRejectedValueOnce(new GatewayError('CONFLICT', '文件已被外部修改', 409))
      .mockResolvedValueOnce({
        path: 'notes.md',
        name: 'notes.md',
        size: 8,
        modTime: '2026-11-22T00:01:00Z',
        previewKind: 'markdown',
        editable: true,
        etag: 'etag-2',
      });

    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(appState.gateway.writeWorkspaceFile).toHaveBeenCalledWith(
        { path: 'notes.md', content: '# Edited', expectedEtag: 'etag-1' },
        undefined,
        expect.any(AbortSignal),
      );
    });
    expect(await screen.findByText('文件已被外部修改')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '重新加载' }).length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole('button', { name: '覆盖保存' }));
    await waitFor(() => {
      expect(appState.gateway.writeWorkspaceFile).toHaveBeenLastCalledWith(
        { path: 'notes.md', content: '# Edited', expectedEtag: undefined },
        undefined,
        expect.any(AbortSignal),
      );
    });
    expect(screen.queryByLabelText('未保存')).not.toBeInTheDocument();
  });

  it('hides workspace file browser on desktop local scope and resets when switching from cloud to local', () => {
    appState.isDesktop = true;
    const { rerender } = render(
      <MemoryRouter>
        <ConversationSidebar
          assistantId="default"
          conversations={[]}
          groups={[]}
          activeConversationId={null}
          activeConversation={null}
          draftSessionParams={{ systemPrompt: '', params: {} }}
          inspectorOpen={false}
          drawerOpen={false}
          manageMode={false}
          isBusy={false}
          scope="local"
          onScopeChange={vi.fn()}
          onManageModeChange={vi.fn()}
          onSelectConversation={vi.fn()}
          onNewConversation={vi.fn()}
          onCloseInspector={vi.fn()}
          onCloseDrawer={vi.fn()}
          onConversationPatched={vi.fn()}
          onConversationsDeleted={vi.fn()}
          onSaveDraftSessionParams={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('radio', { name: '工作区文件' })).not.toBeInTheDocument();

    appState.gateway.listWorkspaceEntries.mockResolvedValue({ path: '.', entries: [], truncated: false });
    rerender(
      <MemoryRouter>
        <ConversationSidebar
          assistantId="default"
          conversations={[]}
          groups={[]}
          activeConversationId={null}
          activeConversation={null}
          draftSessionParams={{ systemPrompt: '', params: {} }}
          inspectorOpen={false}
          drawerOpen={false}
          manageMode={false}
          isBusy={false}
          scope="cloud"
          onScopeChange={vi.fn()}
          onManageModeChange={vi.fn()}
          onSelectConversation={vi.fn()}
          onNewConversation={vi.fn()}
          onCloseInspector={vi.fn()}
          onCloseDrawer={vi.fn()}
          onConversationPatched={vi.fn()}
          onConversationsDeleted={vi.fn()}
          onSaveDraftSessionParams={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('radio', { name: '工作区文件' })).toBeInTheDocument();
  });

  it('creates nested file and opens viewer in edit mode, creates dir, renames, moves, copies, searches, collapses, uploads with 409 overwrite, downloads unsupported file, and batch deletes', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    let rootItems = [
      { name: 'docs', path: 'docs', kind: 'dir' as const, size: 0, modTime: '2026-11-22T00:00:00Z', editable: false },
      { name: 'notes.md', path: 'notes.md', kind: 'file' as const, size: 10, modTime: '2026-11-22T00:00:00Z', previewKind: 'markdown' as const, editable: true },
      { name: 'pic.png', path: 'pic.png', kind: 'file' as const, size: 20, modTime: '2026-11-22T00:00:00Z', previewKind: 'unsupported' as const, editable: false, unsupportedReason: 'image' },
    ];
    let docsItems: WorkspaceEntriesResponse['entries'] = [];

    appState.gateway.listWorkspaceEntries.mockImplementation(async (p: string) => {
      if (!p) return { path: '.', entries: rootItems, truncated: false };
      if (p === 'docs') return { path: 'docs', entries: docsItems, truncated: false };
      return { path: p, entries: [], truncated: false };
    });
    appState.gateway.getAgentSettings.mockResolvedValue({
      directory: { path: '.', status: 'ready' },
      allowedTools: [],
      availableTools: ['read'],
      injectAgentMd: true,
      markdownVisualRender: false,
      skills: [],
    });

    renderSidebar();
    await user.click(screen.getByRole('radio', { name: '工作区文件' }));
    await screen.findByRole('treeitem', { name: 'notes.md' });

    // 1. Create nested Markdown file -> opens viewer directly in edit mode -> type & Ctrl+S save.
    const createdEntry = {
      name: 'guide.md',
      path: 'docs/guide.md',
      kind: 'file' as const,
      size: 0,
      modTime: '2026-11-22T00:00:00Z',
      previewKind: 'markdown' as const,
      editable: true,
    };
    appState.gateway.createWorkspaceFile.mockImplementation(async () => {
      docsItems = [createdEntry];
      return createdEntry;
    });
    appState.gateway.readWorkspaceFile.mockResolvedValue({
      path: 'docs/guide.md',
      name: 'guide.md',
      size: 0,
      modTime: '2026-11-22T00:00:00Z',
      previewKind: 'markdown',
      editable: true,
      etag: 'e-new',
      content: '',
    });
    appState.gateway.writeWorkspaceFile.mockResolvedValue({
      path: 'docs/guide.md',
      name: 'guide.md',
      size: 7,
      modTime: '2026-11-22T00:01:00Z',
      previewKind: 'markdown',
      editable: true,
      etag: 'e-saved',
    });

    await user.click(screen.getByRole('button', { name: '新建文件' }));
    const createDialog = await screen.findByRole('dialog', { name: '新建文件' });
    await user.type(within(createDialog).getByLabelText('名称'), 'docs/guide.md');
    await user.click(within(createDialog).getByRole('button', { name: '创建' }));

    const editor = await screen.findByLabelText('文件内容编辑');
    await user.type(editor, '# Guide');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(appState.gateway.writeWorkspaceFile).toHaveBeenCalledWith(
        { path: 'docs/guide.md', content: '# Guide', expectedEtag: 'e-new' },
        undefined,
        expect.any(AbortSignal),
      );
    });

    // Rename inside viewer updates title & tree.
    const renamedEntry = { ...createdEntry, name: 'handbook.md', path: 'docs/handbook.md' };
    appState.gateway.moveWorkspaceEntry.mockImplementation(async () => {
      docsItems = [renamedEntry];
      return renamedEntry;
    });
    appState.gateway.readWorkspaceFile.mockResolvedValue({
      path: 'docs/handbook.md',
      name: 'handbook.md',
      size: 7,
      modTime: '2026-11-22T00:01:00Z',
      previewKind: 'markdown',
      editable: true,
      etag: 'e-saved',
      content: '# Guide',
    });
    await user.click(screen.getByRole('button', { name: '文件操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
    const renameModal = await screen.findByRole('dialog', { name: '重命名' });
    const renameInput = within(renameModal).getByLabelText('名称');
    await user.clear(renameInput);
    await user.type(renameInput, 'handbook.md');
    await user.click(within(renameModal).getByRole('button', { name: '重命名' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'docs/handbook.md' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '关闭' }));

    // 2. Collapse all collapses expanded docs directory.
    expect(screen.getByRole('treeitem', { name: 'handbook.md' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '全部折叠' }));
    expect(screen.queryByRole('treeitem', { name: 'handbook.md' })).not.toBeInTheDocument();

    // 3. Create folder, create copy & copy path.
    appState.gateway.createWorkspaceDir.mockResolvedValue({
      name: 'assets',
      path: 'assets',
      kind: 'dir',
      size: 0,
      modTime: '2026-11-22T00:00:00Z',
      editable: false,
    });
    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    const dirDialog = await screen.findByRole('dialog', { name: '新建文件夹' });
    await user.type(within(dirDialog).getByLabelText('文件夹名称'), 'assets');
    await user.click(within(dirDialog).getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(appState.gateway.createWorkspaceDir).toHaveBeenCalledWith('assets', undefined);
    });

    appState.gateway.copyWorkspaceEntry.mockResolvedValue({
      name: 'notes copy.md',
      path: 'notes copy.md',
      kind: 'file',
      size: 10,
      modTime: '2026-11-22T00:00:00Z',
      previewKind: 'markdown',
      editable: true,
    });
    await user.click(screen.getByRole('button', { name: '操作 notes.md' }));
    await user.click(await screen.findByRole('menuitem', { name: '创建副本' }));
    await waitFor(() => {
      expect(appState.gateway.copyWorkspaceEntry).toHaveBeenCalledWith(
        { fromPath: 'notes.md', toPath: 'notes copy.md' },
        undefined,
      );
    });

    await user.click(screen.getByRole('button', { name: '操作 notes.md' }));
    await user.click(await screen.findByRole('menuitem', { name: '复制路径' }));
    expect(writeText).toHaveBeenCalledWith('notes.md');

    // 4. Search cross-directory & clear restores tree.
    appState.gateway.searchWorkspaceEntries.mockResolvedValue({
      query: 'handbook',
      entries: [renamedEntry],
      truncated: false,
    });
    const searchInput = screen.getByLabelText('搜索文件');
    await user.type(searchInput, 'handbook');
    await waitFor(() => {
      expect(appState.gateway.searchWorkspaceEntries).toHaveBeenCalledWith(
        'handbook',
        undefined,
        expect.any(AbortSignal),
      );
    });
    expect(await screen.findByText('handbook.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清空搜索' }));
    await screen.findByRole('treeitem', { name: 'notes.md' });

    // 5. Unsupported image downloads directly from viewer.
    appState.gateway.downloadWorkspaceFile.mockResolvedValue({
      blob: new Blob(['png']),
      filename: 'pic.png',
    });
    await user.click(screen.getByRole('treeitem', { name: 'pic.png' }));
    await screen.findByText('图片暂不支持预览');
    await user.click(screen.getByRole('button', { name: '下载文件' }));
    await waitFor(() => {
      expect(appState.gateway.downloadWorkspaceFile).toHaveBeenCalledWith('pic.png', undefined);
    });
    expect(createObjectURL).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '关闭' }));

    // 6. Upload with 409 conflict confirmation.
    appState.gateway.uploadWorkspaceFile
      .mockRejectedValueOnce(new GatewayError('CONFLICT', '目标文件已存在', 409))
      .mockResolvedValueOnce({
        name: 'notes.md',
        path: 'notes.md',
        kind: 'file',
        size: 5,
        modTime: '2026-11-22T00:02:00Z',
        previewKind: 'markdown',
        editable: true,
      });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const uploadFile = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    await user.upload(fileInput, uploadFile);
    const overwriteDialog = await screen.findByRole('dialog', { name: '覆盖已有文件？' });
    await user.click(within(overwriteDialog).getByRole('button', { name: '覆盖' }));
    await waitFor(() => {
      expect(appState.gateway.uploadWorkspaceFile).toHaveBeenLastCalledWith(
        'notes.md',
        uploadFile,
        { overwrite: true, scope: undefined },
      );
    });

    // 7. Batch manage mode multi-select delete.
    appState.gateway.batchWorkspaceEntries.mockImplementation(async () => {
      rootItems = rootItems.filter((i) => i.path !== 'notes.md' && i.path !== 'pic.png');
      return { operation: 'delete', succeeded: ['notes.md', 'pic.png'], failed: [] };
    });
    await user.click(screen.getByRole('button', { name: '管理文件' }));
    await user.click(screen.getByLabelText('选择 notes.md'));
    await user.click(screen.getByLabelText('选择 pic.png'));
    await user.click(screen.getByRole('button', { name: '删除 (2)' }));
    const delDialog = await screen.findByRole('dialog', { name: '删除 2 项？' });
    await user.click(within(delDialog).getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(appState.gateway.batchWorkspaceEntries).toHaveBeenCalledWith(
        { operation: 'delete', paths: ['notes.md', 'pic.png'] },
        undefined,
      );
    });

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
