import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../../core/gateway';
import type {
  AgentSettings,
  TopicScope,
  WorkspaceEntriesResponse,
  WorkspaceFileDocument,
} from '../../core/types';
import { ConversationSidebar } from '../workbench/ConversationSidebar';

const appState = vi.hoisted(() => ({
  isDesktop: false,
  cloudConnectionState: 'connected' as 'connected' | 'disconnected',
  connectionEpoch: 1,
  gateway: {
    listWorkspaceEntries: vi.fn(),
    readWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn(),
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
});
