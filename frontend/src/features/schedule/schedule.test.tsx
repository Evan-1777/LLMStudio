import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Assistant,
  Conversation,
  ConversationDetail,
  ProviderConfig,
  ScheduledTask,
  TopicScope,
} from '../../core/types';
import { ConversationSidebar } from '../workbench/ConversationSidebar';
import { WorkbenchPage } from '../workbench/WorkbenchPage';
import { ScheduleDialog } from './ScheduleDialog';
import { SchedulePanel } from './SchedulePanel';
import {
  formatAlarmTime,
  formatNextRunLabel,
  formatRunProgress,
  formatWeekdays,
  getCloudEligibleModels,
} from './scheduleFormat';

const mockAssistants: Assistant[] = [
  {
    id: 'default',
    name: '默认助手',
    defaultProviderId: 'cloud-p',
    defaultModelId: 'gpt-4.1',
    params: {},
    isDefault: true,
  },
  {
    id: 'researcher',
    name: '调研助手',
    defaultProviderId: 'cloud-p',
    defaultModelId: 'gpt-4.1',
    params: {},
    isDefault: false,
  },
];

const mockProviders: ProviderConfig[] = [
  {
    id: 'local-p',
    name: 'Browser Local',
    adapter: 'openai',
    baseURL: 'https://local.example/v1',
    authType: 'bearer',
    apiKeyMasked: 'sk-l***',
    apiKeySet: true,
    enabled: true,
    builtIn: false,
    localRequest: true,
    models: [
      { id: 'local-only', name: 'Local Model', apiFormat: 'openai-completions' },
    ],
  },
  {
    id: 'cloud-p',
    name: 'Cloud OpenAI',
    adapter: 'openai',
    baseURL: 'https://api.example/v1',
    authType: 'bearer',
    apiKeyMasked: 'sk-c***',
    apiKeySet: true,
    enabled: true,
    builtIn: false,
    localRequest: false,
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', apiFormat: 'openai-responses' },
    ],
  },
];

const cloudAgentConv: Conversation = {
  id: 'conv-agent-1',
  assistantId: 'default',
  title: '每日巡检 Agent',
  providerId: 'cloud-p',
  modelId: 'gpt-4.1',
  params: {},
  mode: 'agent',
  syncEnabled: false,
  syncState: 'local_only',
  syncVersion: 0,
  createdAt: '2026-11-26T00:00:00Z',
  updatedAt: '2026-11-26T09:00:00Z',
};

const cloudOtherAgentConv: Conversation = {
  id: 'conv-agent-2',
  assistantId: 'researcher',
  title: '市场周报',
  providerId: 'cloud-p',
  modelId: 'gpt-4.1',
  params: {},
  mode: 'agent',
  syncEnabled: false,
  syncState: 'local_only',
  syncVersion: 0,
  createdAt: '2026-11-26T00:00:00Z',
  updatedAt: '2026-11-26T08:00:00Z',
};

const cloudChatConv: Conversation = {
  id: 'conv-chat-1',
  assistantId: 'default',
  title: '普通聊天话题',
  providerId: 'cloud-p',
  modelId: 'gpt-4.1',
  params: {},
  mode: 'chat',
  syncEnabled: false,
  syncState: 'local_only',
  syncVersion: 0,
  createdAt: '2026-11-26T00:00:00Z',
  updatedAt: '2026-11-26T07:00:00Z',
};

const localAgentConv: Conversation = {
  id: 'conv-local-1',
  assistantId: 'default',
  title: '本地 Agent 话题',
  providerId: 'cloud-p',
  modelId: 'gpt-4.1',
  params: {},
  mode: 'agent',
  syncEnabled: false,
  syncState: 'local_only',
  syncVersion: 0,
  createdAt: '2026-11-26T00:00:00Z',
  updatedAt: '2026-11-26T06:00:00Z',
};

function makeSampleTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sched_1',
    name: '晨间巡检',
    prompt: '检查服务运行状态并输出摘要',
    enabled: true,
    hour: 8,
    minute: 5,
    weekdays: [1, 3, 5],
    timezone: 'Asia/Shanghai',
    maxRuns: 0,
    runCount: 2,
    bindMode: 'new',
    assistantId: 'default',
    providerId: 'cloud-p',
    modelId: 'gpt-4.1',
    nextRunAt: '2026-11-26T08:05:00Z',
    lastStatus: 'succeeded',
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
    ...overrides,
  };
}

const appState = vi.hoisted(() => ({
  isDesktop: false,
  desktopStatus: null,
  cloudConnectionState: 'connected' as 'connected' | 'disconnected',
  connectionState: 'connected' as 'connected' | 'connecting' | 'error' | 'auth-required',
  topicScope: 'cloud' as TopicScope,
  setTopicScope: vi.fn(),
  connectionEpoch: 1,
  gateway: {
    listScheduledTasks: vi.fn(),
    createScheduledTask: vi.fn(),
    updateScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    runScheduledTaskNow: vi.fn(),
    getConversationDetail: vi.fn(),
    getAgentTopicDirectory: vi.fn(),
    getAgentSettings: vi.fn(),
    listActiveAgentRuns: vi.fn(),
    listWorkspaceEntries: vi.fn(),
    searchConversations: vi.fn(),
    patchConversation: vi.fn(),
  },
  resources: {
    providers: [] as ProviderConfig[],
    formats: [],
    adapters: [],
    assistants: [] as Assistant[],
    conversations: [] as Conversation[],
    conversationGroups: [],
    localConversations: [] as Conversation[],
    localConversationGroups: [],
    cloudConversations: [] as Conversation[],
    cloudConversationGroups: [],
    searchEngines: [],
    mcpServers: [],
    localMcpServers: [],
    cloudMcpServers: [],
    loading: {
      providers: false,
      assistants: false,
      conversations: false,
      plugins: false,
    },
    error: {
      providers: null,
      assistants: null,
      conversations: null,
      plugins: null,
    },
  },
  settings: {
    composerReasoningEffort: '' as const,
    mcpMaxToolRounds: 8,
    themeMode: 'system' as const,
    seedColorValue: 0,
    enterToSend: true,
    visualHtmlRender: true,
    defaultHtmlPreview: false,
    chatDisplayMode: 'bubble' as const,
    autoCollapseEnabled: false,
    autoCollapseThinkingOnComplete: false,
    autoCollapseToolsOnComplete: false,
    autoCreateCache: true,
    collapseLineThreshold: 40,
    collapseCharThreshold: 2000,
    userAvatarDataUrl: '',
    chatWidthMode: 'default' as const,
    chatManualWidth: 780,
    fontFamily: 'system' as const,
    fontSize: 14,
    builtinTimeToolEnabled: true,
    mathRenderEnabled: true,
    gatewayBaseUrl: '',
    accessToken: '',
  },
  resolvedTheme: 'light' as const,
  runningConversationIds: new Set<string>(),
  markConversationRunning: vi.fn(),
  refreshConversations: vi.fn(),
  refreshAll: vi.fn(),
  updatePreferences: vi.fn(),
  upsertLocalConversation: vi.fn(),
  removeLocalConversation: vi.fn(),
  applyConversationOrganizationSnapshot: vi.fn(),
  uploadConversations: vi.fn(),
  pullConversations: vi.fn(),
  toast: vi.fn(),
  syncFromServer: vi.fn(),
  lastSyncedAt: null as string | null,
  syncingServer: false,
  registerDirtyGuard: vi.fn(),
}));

vi.mock('../../app/AppProvider', () => ({
  useApp: () => appState,
}));

beforeEach(() => {
  appState.isDesktop = false;
  appState.topicScope = 'cloud';
  appState.cloudConnectionState = 'connected';
  appState.connectionState = 'connected';
  appState.connectionEpoch = 1;
  appState.resources.providers = mockProviders;
  appState.resources.assistants = mockAssistants;
  appState.resources.conversations = [
    cloudAgentConv,
    cloudOtherAgentConv,
    cloudChatConv,
  ];
  appState.resources.cloudConversations = [
    cloudAgentConv,
    cloudOtherAgentConv,
    cloudChatConv,
  ];
  appState.resources.localConversations = [localAgentConv];
  appState.gateway.listScheduledTasks.mockResolvedValue([]);
  appState.gateway.listActiveAgentRuns.mockResolvedValue([]);
  appState.gateway.listWorkspaceEntries.mockResolvedValue({
    path: '.',
    entries: [],
    truncated: false,
  });
  appState.gateway.getAgentTopicDirectory.mockResolvedValue({
    path: '/workspace',
    isDefault: true,
  });
  appState.gateway.getAgentSettings.mockResolvedValue({
    rootPath: '/workspace',
    allowedTools: [],
    availableTools: [],
  });
  appState.refreshConversations.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('scheduleFormat', () => {
  it('formats alarm times, weekday summaries, quota progress, next run dates, and filters cloud models', () => {
    expect(formatAlarmTime(8, 5)).toBe('08:05');
    expect(formatAlarmTime(23, 59)).toBe('23:59');

    expect(formatWeekdays([])).toBe('每日');
    expect(formatWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe('每日');
    expect(formatWeekdays([1, 2, 3, 4, 5])).toBe('工作日');
    expect(formatWeekdays([0, 6])).toBe('周末');
    expect(formatWeekdays([2])).toBe('周二');
    expect(formatWeekdays([5, 1, 3])).toBe('周一、三、五');

    expect(formatRunProgress(0, 0)).toBe('∞');
    expect(formatRunProgress(2, 5)).toBe('2/5');

    const base = new Date(2026, 10, 26, 7, 0, 0);
    const sameDay = new Date(2026, 10, 26, 9, 30, 0).toISOString();
    const tomorrow = new Date(2026, 10, 27, 8, 5, 0).toISOString();
    const later = new Date(2026, 11, 2, 14, 20, 0).toISOString();
    expect(formatNextRunLabel(sameDay, base)).toBe('今天 09:30');
    expect(formatNextRunLabel(tomorrow, base)).toBe('明天 08:05');
    expect(formatNextRunLabel(later, base)).toBe('12/02 14:20');

    const cloudModels = getCloudEligibleModels(mockProviders);
    expect(cloudModels).toHaveLength(1);
    expect(cloudModels[0].provider.id).toBe('cloud-p');
    expect(cloudModels[0].model.id).toBe('gpt-4.1');
  });
});

describe('ScheduleDialog', () => {
  it('validates required inputs, toggles weekdays, excludes localRequest models, and creates task', async () => {
    const user = userEvent.setup();
    const created = makeSampleTask({ id: 'sched_new', name: '每日构建检查' });
    appState.gateway.createScheduledTask.mockResolvedValue(created);
    const onSaved = vi.fn();

    render(
      <ScheduleDialog
        open
        onOpenChange={vi.fn()}
        defaultAssistantId="default"
        defaultProviderId="local-p"
        defaultModelId="local-only"
        scope="cloud"
        onSaved={onSaved}
      />,
    );

    expect(screen.queryByText(/Local Model/)).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /GPT-4.1/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByText('请输入任务名称')).toBeInTheDocument();
    expect(screen.getByText('请输入提示词')).toBeInTheDocument();

    await user.type(screen.getByLabelText('任务名称'), '每日构建检查');
    await user.click(screen.getByRole('button', { name: '周一' }));
    await user.click(screen.getByRole('button', { name: '周三' }));
    expect(screen.getByText('周一、三')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: '定次' }));
    const quotaInput = screen.getByLabelText('最大执行次数');
    await user.clear(quotaInput);
    await user.type(quotaInput, '3');
    await user.type(screen.getByLabelText('提示词'), '运行健康检查');

    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(appState.gateway.createScheduledTask).toHaveBeenCalledTimes(1);
    });
    expect(appState.gateway.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '每日构建检查',
        prompt: '运行健康检查',
        weekdays: [1, 3],
        maxRuns: 3,
        bindMode: 'new',
        assistantId: 'default',
        providerId: 'cloud-p',
        modelId: 'gpt-4.1',
      }),
      undefined,
      'cloud',
    );
    expect(onSaved).toHaveBeenCalledWith(created);
  });

  it('shows cross-assistant cloud Agent topics when bindMode switches to conversation and resets exhausted count on re-enable', async () => {
    const user = userEvent.setup();
    const exhausted = makeSampleTask({
      id: 'sched_exhausted',
      enabled: false,
      maxRuns: 2,
      runCount: 2,
      bindMode: 'new',
    });
    appState.gateway.updateScheduledTask.mockResolvedValue({
      ...exhausted,
      enabled: true,
      runCount: 0,
      bindMode: 'conversation',
      conversationId: 'conv-agent-2',
    });

    render(
      <ScheduleDialog
        open
        onOpenChange={vi.fn()}
        editingTask={exhausted}
        scope="cloud"
      />,
    );

    await user.click(screen.getByRole('switch', { name: '启用定时任务' }));
    await user.click(screen.getByRole('radio', { name: '绑定话题' }));

    const topicSelect = screen.getByLabelText('目标 Agent 话题');
    expect(
      within(topicSelect).getByRole('option', { name: '市场周报 · 调研助手' }),
    ).toBeInTheDocument();
    await user.selectOptions(topicSelect, 'conv-agent-2');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(appState.gateway.updateScheduledTask).toHaveBeenCalledWith(
        'sched_exhausted',
        expect.objectContaining({
          enabled: true,
          resetRunCount: true,
          bindMode: 'conversation',
          conversationId: 'conv-agent-2',
        }),
        undefined,
        'cloud',
      );
    });
  });
});

describe('SchedulePanel', () => {
  it('handles loading, error retry, empty state, filtering, runNow, dead-link filtering, and delete confirmation', async () => {
    const user = userEvent.setup();
    const onOpenConversation = vi.fn();
    const onReloadActiveConversation = vi.fn().mockResolvedValue(undefined);
    const onSchedulesChanged = vi.fn();

    appState.gateway.listScheduledTasks.mockRejectedValueOnce(new Error('网关超时'));

    const { rerender } = render(
      <SchedulePanel
        scope="cloud"
        cloudOffline={false}
        activeConversationId="conv-agent-1"
        refreshTrigger={0}
        createTrigger={0}
        onOpenConversation={onOpenConversation}
        onReloadActiveConversation={onReloadActiveConversation}
        onSchedulesChanged={onSchedulesChanged}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('网关超时')).toBeInTheDocument();
    });

    const boundActiveTask = makeSampleTask({
      id: 's-bound',
      name: '巡检现行话题',
      bindMode: 'conversation',
      conversationId: 'conv-agent-1',
      conversationTitle: '每日巡检 Agent',
      lastConversationId: 'conv-deleted-id',
      lastStatus: 'succeeded',
    });
    const disabledNewTask = makeSampleTask({
      id: 's-new-disabled',
      name: '周报汇总',
      enabled: false,
      bindMode: 'new',
      hour: 18,
      minute: 0,
      weekdays: [5],
      lastConversationId: 'conv-agent-2',
      lastStatus: 'failed',
      lastError: '模型配额不足',
    });

    appState.gateway.listScheduledTasks.mockResolvedValue([
      boundActiveTask,
      disabledNewTask,
    ]);
    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => {
      expect(screen.getByText('巡检现行话题')).toBeInTheDocument();
    });
    expect(screen.getByText('周报汇总')).toBeInTheDocument();
    expect(screen.getByText('模型配额不足')).toBeInTheDocument();

    // Dead-link check: s-bound has deleted lastConversationId -> 1 button only (from s-new-disabled).
    expect(
      screen.getAllByRole('button', { name: '打开最近执行话题' }),
    ).toHaveLength(1);

    await user.click(screen.getByRole('radio', { name: '停用' }));
    expect(screen.queryByText('巡检现行话题')).not.toBeInTheDocument();
    expect(screen.getByText('周报汇总')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: '全部' }));
    await user.click(screen.getByRole('button', { name: /每日巡检 Agent/ }));
    expect(onOpenConversation).toHaveBeenCalledWith('conv-agent-1');

    appState.gateway.runScheduledTaskNow.mockResolvedValue({
      schedule: { ...boundActiveTask, lastStatus: 'running' },
      conversationId: 'conv-agent-1',
    });
    await user.click(screen.getByRole('button', { name: '立即执行 巡检现行话题' }));
    await waitFor(() => {
      expect(appState.gateway.runScheduledTaskNow).toHaveBeenCalledWith(
        's-bound',
        undefined,
        'cloud',
      );
      expect(appState.markConversationRunning).toHaveBeenCalledWith(
        'conv-agent-1',
        true,
        'cloud',
      );
      expect(onReloadActiveConversation).toHaveBeenCalled();
    });

    appState.gateway.deleteScheduledTask.mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: '删除 周报汇总' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(appState.gateway.deleteScheduledTask).toHaveBeenCalledWith(
        's-new-disabled',
        undefined,
        'cloud',
      );
      expect(screen.queryByText('周报汇总')).not.toBeInTheDocument();
    });

    appState.gateway.listScheduledTasks.mockResolvedValue([]);
    rerender(
      <SchedulePanel
        scope="cloud"
        cloudOffline={false}
        activeConversationId="conv-agent-1"
        refreshTrigger={1}
        createTrigger={0}
        onOpenConversation={onOpenConversation}
        onReloadActiveConversation={onReloadActiveConversation}
        onSchedulesChanged={onSchedulesChanged}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('暂无定时任务')).toBeInTheDocument();
    });
  });
});

describe('ConversationSidebar & WorkbenchPage schedule visibility boundaries', () => {
  it('shows schedule tab on cloud scope and hides it on desktop local scope', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ConversationSidebar
          assistantId="default"
          conversations={[cloudAgentConv]}
          groups={[]}
          activeConversationId={cloudAgentConv.id}
          activeConversation={cloudAgentConv}
          draftSessionParams={{ systemPrompt: '', params: {} }}
          inspectorOpen={false}
          drawerOpen={true}
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

    expect(screen.getByRole('radio', { name: '定时任务' })).toBeInTheDocument();

    appState.isDesktop = true;
    rerender(
      <MemoryRouter>
        <ConversationSidebar
          assistantId="default"
          conversations={[localAgentConv]}
          groups={[]}
          activeConversationId={localAgentConv.id}
          activeConversation={localAgentConv}
          draftSessionParams={{ systemPrompt: '', params: {} }}
          inspectorOpen={false}
          drawerOpen={true}
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

    expect(screen.queryByRole('radio', { name: '定时任务' })).not.toBeInTheDocument();
  });

  it('shows toolbar alarm button for cloud Agent topic and hides it for chat topic and desktop local scope', async () => {
    const user = userEvent.setup();
    const agentDetail: ConversationDetail = {
      conversation: cloudAgentConv,
      messages: [],
    };
    const chatDetail: ConversationDetail = {
      conversation: cloudChatConv,
      messages: [],
    };
    const localDetail: ConversationDetail = {
      conversation: localAgentConv,
      messages: [],
    };

    appState.gateway.getConversationDetail.mockImplementation(async (id: string) => {
      if (id === cloudAgentConv.id) return agentDetail;
      if (id === cloudChatConv.id) return chatDetail;
      return localDetail;
    });
    appState.gateway.listScheduledTasks.mockImplementation(async (convId?: string) => {
      if (convId === cloudAgentConv.id) {
        return [
          makeSampleTask({
            id: 'topic-sched-1',
            name: '话题唤醒',
            bindMode: 'conversation',
            conversationId: cloudAgentConv.id,
          }),
        ];
      }
      return [];
    });

    const firstView = render(
      <MemoryRouter initialEntries={[`/chat/${cloudAgentConv.id}`]}>
        <Routes>
          <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
          <Route path="/chat" element={<WorkbenchPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const alarmBtn = await screen.findByRole('button', { name: '话题定时任务' });
    expect(alarmBtn).toHaveAttribute('data-has-active', 'true');

    await user.click(alarmBtn);
    expect(await screen.findByText('话题唤醒')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '新建绑定任务' }),
    ).toBeInTheDocument();
    firstView.unmount();

    const chatView = render(
      <MemoryRouter initialEntries={[`/chat/${cloudChatConv.id}`]}>
        <Routes>
          <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(appState.gateway.getConversationDetail).toHaveBeenCalledWith(
        cloudChatConv.id,
        expect.anything(),
        undefined,
      );
    });
    expect(
      screen.queryByRole('button', { name: '话题定时任务' }),
    ).not.toBeInTheDocument();
    chatView.unmount();

    appState.isDesktop = true;
    appState.topicScope = 'local';
    render(
      <MemoryRouter initialEntries={[`/chat/${localAgentConv.id}?scope=local`]}>
        <Routes>
          <Route path="/chat/:conversationId" element={<WorkbenchPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(appState.gateway.getConversationDetail).toHaveBeenCalledWith(
        localAgentConv.id,
        expect.anything(),
        'local',
      );
    });
    expect(
      screen.queryByRole('button', { name: '话题定时任务' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '定时任务' })).not.toBeInTheDocument();
  });
});
