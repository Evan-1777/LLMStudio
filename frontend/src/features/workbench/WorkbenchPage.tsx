import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { Icon, IconButton, Popover, SegmentedControl } from '../../components/ui';
import { CHAT_WIDTH_MAX, CHAT_WIDTH_MIN, getAgentModeVisible } from '../../core/settings';
import { isReasoningEffort, type Assistant, type ContentBlock, type GraphMutationInput, type ConversationMode, type Message, type ReasoningEffort, type TopicScope } from '../../core/types';
import { AgentTopicDirectory } from '../agent/AgentTopicDirectory';
import { ChatProvider, useChat } from '../chat/ChatProvider';
import { AssistantEditor } from './AssistantEditor';
import { AssistantSidebar } from './AssistantSidebar';
import { ChatCanvas } from './ChatCanvas';
import { Composer } from './Composer';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationGraphView } from './ConversationGraphView';
import { resolveBranchSummaries } from './conversationGraph';
import { isLocalMessageId } from '../chat/chatReducer';
import {
  getDefaultModelOption,
  resolveModelOption,
} from './ModelPicker';
import type { DraftSessionParams } from './SessionInspector';
import './workbench.css';

function useComposerViewport() {
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!shell || !viewport) return;
    const handheld = window.matchMedia('(pointer: coarse)');
    let frame = 0;
    const clear = () => {
      shell.style.removeProperty('--wb-visible-height');
      shell.style.removeProperty('--wb-visible-top');
    };
    const update = () => {
      frame = 0;
      const focused = shell.querySelector('.wb-draft') === document.activeElement;
      if (!handheld.matches || !focused || viewport.scale !== 1 || viewport.height >= window.innerHeight - 1) {
        clear();
        return;
      }
      shell.style.setProperty('--wb-visible-height', viewport.height + 'px');
      shell.style.setProperty('--wb-visible-top', viewport.offsetTop + 'px');
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    shell.addEventListener('focusin', schedule, options);
    shell.addEventListener('focusout', schedule, options);
    viewport.addEventListener('resize', schedule, options);
    viewport.addEventListener('scroll', schedule, options);
    window.addEventListener('resize', schedule, options);
    handheld.addEventListener('change', schedule, options);
    schedule();
    return () => {
      listeners.abort();
      window.cancelAnimationFrame(frame);
      clear();
    };
  }, []);
  return shellRef;
}

function useCompactViewport() {
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)').matches
      : false,
  );

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const mql = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return compact;
}

function WorkbenchInner() {
  const shellRef = useComposerViewport();
  const isCompact = useCompactViewport();
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const {
    gateway,
    isDesktop,
    topicScope,
    setTopicScope,
    connectionState,
    connectionEpoch,
    resources,
    upsertLocalConversation,
    settings,
    updatePreferences,
    syncFromServer,
    lastSyncedAt,
    syncingServer,
    toast,
  } = useApp();

  const rawUrlScope = searchParams.get('scope');
  const urlScope: TopicScope | null =
    rawUrlScope === 'local' || rawUrlScope === 'cloud' ? rawUrlScope : null;
  const activeScope: TopicScope = isDesktop ? (urlScope ?? topicScope) : 'cloud';
  const reqScope: TopicScope | undefined = isDesktop ? activeScope : undefined;
  const activeScopeRef = useRef<TopicScope | undefined>(reqScope);
  activeScopeRef.current = reqScope;
  const [mcpToolsEnabled, setMcpToolsEnabled] = useState(true);
  const prevUrlScopeRef = useRef<TopicScope | null>(null);

  useEffect(() => {
    if (!isDesktop) return;
    if (urlScope && urlScope !== prevUrlScopeRef.current) {
      prevUrlScopeRef.current = urlScope;
      if (urlScope !== topicScope) {
        setTopicScope(urlScope);
      }
    } else if (!urlScope) {
      prevUrlScopeRef.current = null;
    }
  }, [isDesktop, setTopicScope, topicScope, urlScope]);

  const {
    state: chatState,
    activeMessages,
    mutateGraph,
    sessionScope,
    isBusy,
    isGenerating,
    isCompacting,
    updateConversationMeta,
    clearSession,
    loadConversation,
    reloadCurrentConversation,
    sendMessage,
    regenerateMessage,
    compactConversation,
    updateMessage,
    deleteMessage,
    branchFromMessage,
    detachStream,
    stopStreaming,
  } = useChat();

  const [leftOpenDesktop, setLeftOpenDesktop] = useState(true);
  const [rightOpenDesktop, setRightOpenDesktop] = useState(true);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sidebarManageMode, setSidebarManageMode] = useState(false);
  const [isTemporaryMode, setIsTemporaryMode] = useState(false);
  const [draftAgent, setDraftAgent] = useState<{ key: string; mode: ConversationMode; path: string }>();
  const [savingModeKey, setSavingModeKey] = useState<string | null>(null);
  const modeSaveLock = useRef<string | null>(null);
  const [showAgentMode] = useState(getAgentModeVisible);

  const [selectedAssistantId, setSelectedAssistantId] = useState('default');
  const [draftModel, setDraftModel] = useState<{
    providerId: string;
    modelId: string;
  }>({ providerId: '', modelId: '' });
  const [draftSessionParams, setDraftSessionParams] =
    useState<DraftSessionParams>({ systemPrompt: '', params: {} });

  const [assistantModalOpen, setAssistantModalOpen] = useState(false);
  const [editingAssistant, setEditingAssistant] = useState<Assistant | null>(
    null,
  );

  const leftToggleRef = useRef<HTMLButtonElement | null>(null);
  const rightToggleRef = useRef<HTMLButtonElement | null>(null);
  const chatStageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [resizingWidth, setResizingWidth] = useState(false);
  const dragSessionRef = useRef<{
    pointerId: number;
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
    containerWidth: number;
    currentWidth: number;
  } | null>(null);
  const skipNextLoadIdRef = useRef<string | null>(null);
  const temporaryConvIdRef = useRef<string | null>(null);
  const activeConnEpochRef = useRef<number>(connectionEpoch);
  activeConnEpochRef.current = connectionEpoch;
  const prevConnEpochRef = useRef<number>(connectionEpoch);

  const discardTemporarySession = useCallback(
    (options?: { keepalive?: boolean }) => {
      const tempId = temporaryConvIdRef.current;
      if (!tempId) return;
      temporaryConvIdRef.current = null;
      const scopeForTemp = activeScopeRef.current;
      if (options?.keepalive) {
        gateway.deleteConversationKeepalive(tempId, scopeForTemp);
      } else {
        void gateway.deleteConversation(tempId, undefined, scopeForTemp).catch(() => {});
      }
    },
    [gateway],
  );
  const discardRef = useRef(discardTemporarySession);
  discardRef.current = discardTemporarySession;

  useEffect(() => {
    const onPageHide = () => {
      discardRef.current({ keepalive: true });
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      discardRef.current();
    };
  }, []);

  useEffect(() => {
    if (prevConnEpochRef.current === connectionEpoch) return;
    prevConnEpochRef.current = connectionEpoch;
    discardRef.current();
    setIsTemporaryMode(false);
  }, [connectionEpoch]);

  useEffect(() => {
    const el = chatStageRef.current;
    if (!el) return;
    const measure = () => setStageWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const [savingModelKey, setSavingModelKey] = useState<string | null>(null);
  const modelSaveLockRef = useRef<string | null>(null);
  const [effortSaveEpoch, setEffortSaveEpoch] = useState<number | null>(null);
  const effortSaveLock = useRef<number | null>(null);
  const savingEffort = effortSaveEpoch === connectionEpoch;

  const assistants = useMemo(
    () =>
      resources.assistants.length > 0
        ? resources.assistants
        : [
            {
              id: 'default',
              name: '默认助手',
              params: {},
              isDefault: true,
            },
          ],
    [resources.assistants],
  );

  // Align active assistant from URL query param (?assistant=) or loaded conversation.
  useEffect(() => {
    if (conversationId) return;
    const qAssistant = searchParams.get('assistant');
    if (qAssistant && assistants.some((a) => a.id === qAssistant)) {
      setSelectedAssistantId(qAssistant);
    } else if (!assistants.some((a) => a.id === selectedAssistantId)) {
      setSelectedAssistantId(assistants[0].id);
    }
  }, [assistants, conversationId, searchParams, selectedAssistantId]);

  useEffect(() => {
    if (!conversationId) {
      clearSession();
      setDraftSessionParams({ systemPrompt: '', params: {} });
      return;
    }
    discardRef.current();
    setIsTemporaryMode(false);
    if (connectionState !== 'connected') {
      return;
    }
    const loadKey = `${reqScope ?? 'cloud'}:${conversationId}`;
    if (skipNextLoadIdRef.current === loadKey) {
      skipNextLoadIdRef.current = null;
      return;
    }
    let alive = true;
    void loadConversation(conversationId, reqScope).then((detail) => {
      if (!alive || !detail) return;
      const aid = detail.conversation.assistantId || 'default';
      setSelectedAssistantId(aid);
    });
    return () => {
      alive = false;
    };
  }, [
    clearSession,
    connectionEpoch,
    connectionState,
    conversationId,
    loadConversation,
    reqScope,
  ]);

  const activeAssistant = useMemo(
    () =>
      assistants.find((a) => a.id === selectedAssistantId) ?? assistants[0],
    [assistants, selectedAssistantId],
  );

  const scopedConversations = useMemo(
    () =>
      resources.conversations.filter(
        (c) => (c.assistantId || 'default') === activeAssistant.id,
      ),
    [activeAssistant.id, resources.conversations],
  );

  const scopedGroups = useMemo(
    () =>
      resources.conversationGroups.filter(
        (g) => g.assistantId === activeAssistant.id,
      ),
    [activeAssistant.id, resources.conversationGroups],
  );

  const conversationBucket = activeScope === 'local' ? resources.localConversations : resources.cloudConversations;
  const sessionConversation = sessionScope === reqScope ? chatState.conversation : null;
  const currentConversation = useMemo(() => {
    if (conversationId) {
      if (sessionConversation?.id === conversationId) return sessionConversation;
      return conversationBucket.find((c) => c.id === conversationId) ?? null;
    }
    return isTemporaryMode && sessionConversation?.ephemeral ? sessionConversation : null;
  }, [conversationBucket, conversationId, isTemporaryMode, sessionConversation]);

  const activeConvIdRef = useRef<string | undefined>(
    currentConversation?.id ?? conversationId,
  );
  activeConvIdRef.current = currentConversation?.id ?? conversationId;

  const activeId = currentConversation?.id ?? conversationId;
  const draftKey = JSON.stringify([connectionEpoch, activeScope, activeAssistant.id, isTemporaryMode]);
  const modeKey = JSON.stringify([draftKey, activeId]);
  const [graphViewKey, setGraphViewKey] = useState<string | null>(null);
  const [graphFocusNodeId, setGraphFocusNodeId] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<{ messageId: string; seq: number } | null>(null);
  const [pendingSearchJump, setPendingSearchJump] = useState<{
    conversationId: string;
    messageId: string;
    scope: TopicScope;
    connectionEpoch: number;
  } | null>(null);
  const activatingSearchJumpRef = useRef<string | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const graphQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const graphBlockingCountRef = useRef(0);
  const graphToggleRef = useRef<HTMLButtonElement>(null);
  const graphConversation = !isTemporaryMode && sessionConversation?.id === conversationId ? sessionConversation : null;
  const graphOpen = graphViewKey === modeKey && Boolean(graphConversation);
  const graphReady = Boolean(graphConversation) && !isBusy && !isCompacting && !chatState.messages.some((msg) => isLocalMessageId(msg.id));
  const graphReadyRef = useRef(graphReady);
  graphReadyRef.current = graphReady;
  const branches = useMemo(() => graphConversation && resolveBranchSummaries(graphConversation, chatState.messages), [graphConversation, chatState.messages]);
  const activeBranch = branches?.find((branch) => branch.id === (graphConversation?.graphState?.activeBranchId || graphConversation?.activeLeafId));
  const showBranch = Boolean(graphConversation?.graphState?.activeBranchId || (branches && branches.length > 1));

  useEffect(() => {
    setGraphViewKey(null);
    setGraphFocusNodeId(null);
    setJumpTarget(null);
    setToolbarMenuOpen(false);
  }, [modeKey]);

  useEffect(() => {
    setPendingSearchJump(null);
    activatingSearchJumpRef.current = null;
  }, [connectionEpoch, activeScope]);

  useEffect(() => {
    if (!isCompact || leftDrawerOpen || rightDrawerOpen) {
      setToolbarMenuOpen(false);
    }
  }, [isCompact, leftDrawerOpen, rightDrawerOpen]);

  const submitGraphMutation = (input: GraphMutationInput) => {
    if (!graphReadyRef.current) return Promise.resolve(null);
    const meta = input.op === 'setNodeMeta' && 'graphMeta' in input ? input.graphMeta : undefined;
    const isExpandedOnly =
      meta !== undefined &&
      meta.expanded !== undefined &&
      meta.collapsed === undefined &&
      (!('summary' in meta) || meta.summary === undefined) &&
      (!('x' in meta) || meta.x === undefined) &&
      (!('y' in meta) || meta.y === undefined);
    const targetModeKey = modeKeyRef.current;
    const targetScope = reqScope;
    const run = async () => {
      if (!graphReadyRef.current || modeKeyRef.current !== targetModeKey) return null;
      if (!isExpandedOnly) {
        graphBlockingCountRef.current += 1;
        setGraphBusy(true);
      }
      try {
        const detail = await mutateGraph(input, targetScope);
        if (detail && input.op === 'reparent' && !input.parentId) toast('已断开上下文');
        return detail;
      } finally {
        if (!isExpandedOnly) {
          graphBlockingCountRef.current = Math.max(0, graphBlockingCountRef.current - 1);
          if (graphBlockingCountRef.current === 0) setGraphBusy(false);
        }
      }
    };
    const next = graphQueueRef.current.then(run, run);
    graphQueueRef.current = next.then(() => undefined, () => undefined);
    return next;
  };
  const closeGraph = () => {
    setGraphViewKey(null);
    setGraphFocusNodeId(null);
    graphToggleRef.current?.focus({ preventScroll: true });
  };
  const openGraphAtNode = (nodeId: string) => {
    if (!graphConversation) return;
    setGraphFocusNodeId(nodeId);
    setGraphViewKey(modeKey);
  };
  const removeSideRefFromChat = async (targetMessageId: string, sourceMessageId: string) => {
    await submitGraphMutation({ op: 'removeSideRef', messageId: targetMessageId, sourceMessageId });
  };
  const activateGraphBranch = async (target: { leafMessageId: string } | { branchId: string }) => {
    const isCurrent = 'branchId' in target ? target.branchId === graphConversation?.graphState?.activeBranchId
      : !graphConversation?.graphState?.activeBranchId && target.leafMessageId === activeMessages.at(-1)?.id;
    if (isCurrent || await submitGraphMutation({ op: 'activateBranch', ...target })) closeGraph();
  };
  const jumpToGraphMessage = async (messageId: string) => {
    if (!activeMessages.some((msg) => msg.id === messageId)) {
      const branch = branches?.find((item) => item.messageIds.includes(messageId));
      const target = branch && 'branchId' in branch && branch.branchId ? { branchId: branch.branchId } : { leafMessageId: branch?.id ?? messageId };
      if (!await submitGraphMutation({ op: 'activateBranch', ...target })) return;
    }
    setJumpTarget((prior) => ({ messageId, seq: (prior?.seq ?? 0) + 1 }));
    setGraphViewKey(null);
  };
  const draft = !activeId && draftAgent?.key === draftKey ? draftAgent : null;
  const conversationMode = currentConversation?.mode ?? draft?.mode ?? 'chat';
  // Desktop chat discovers both tool catalogs; cloud Agent execution runs on the gateway.
  const cloudAgent = reqScope === 'cloud' && conversationMode === 'agent';
  const hasMcpSource = settings.builtinTimeToolEnabled || resources.cloudMcpServers.some((server) => server.enabled)
    || (!cloudAgent && resources.mcpServers.some((server) => server.enabled));
  const toggleMcp = () => {
    if (!hasMcpSource) toast('请先在设置中启用 MCP 服务', 'error');
    else setMcpToolsEnabled((value) => !value);
  };
  const savingMode = savingModeKey === modeKey;
  const modeBusy = isBusy || isCompacting || savingMode || (Boolean(activeId) && !currentConversation);
  const modeKeyRef = useRef(modeKey);
  modeKeyRef.current = modeKey;

  const changeMode = async (mode: ConversationMode) => {
    if (modeBusy || modeSaveLock.current === modeKey || conversationMode === mode) return;
    if (!activeId) {
      setDraftAgent({ key: draftKey, mode, path: draft?.path ?? '' });
      return;
    }
    modeSaveLock.current = modeKey;
    setSavingModeKey(modeKey);
    try {
      const updated = await gateway.patchConversation(activeId, { mode }, undefined, reqScope);
      if (modeKeyRef.current !== modeKey) return;
      if (!updated.ephemeral) upsertLocalConversation(updated, reqScope);
      updateConversationMeta(updated);
    } catch {
      if (modeKeyRef.current === modeKey) toast('无法切换话题模式', 'error');
    } finally {
      if (modeSaveLock.current === modeKey) modeSaveLock.current = null;
      setSavingModeKey((key) => key === modeKey ? null : key);
    }
  };

  const previousEffort = currentConversation?.params?.reasoningEffort;
  const reasoningEffort = settings.composerReasoningEffort || (isReasoningEffort(previousEffort) ? previousEffort : 'none');

  const saveReasoningEffort = async (effort: ReasoningEffort): Promise<boolean> => {
    if (effortSaveLock.current === connectionEpoch) return false;
    if (effort === settings.composerReasoningEffort) return true;
    effortSaveLock.current = connectionEpoch;
    setEffortSaveEpoch(connectionEpoch);
    try {
      const result = await updatePreferences({ composerReasoningEffort: effort });
      if (activeConnEpochRef.current === connectionEpoch && !result.ok) {
        toast('思考强度保存失败：' + result.error, 'error');
      }
      return result.ok;
    } finally {
      if (effortSaveLock.current === connectionEpoch) {
        effortSaveLock.current = null;
        setEffortSaveEpoch(null);
      }
    }
  };

  const targetModel = useMemo(() => {
    const convProvider = currentConversation?.providerId ?? '';
    const convModel = currentConversation?.modelId ?? '';
    if (convProvider && convModel) {
      const resolved = resolveModelOption(
        resources.providers,
        convProvider,
        convModel,
      );
      if (resolved) return resolved;
    }
    if (draftModel.providerId && draftModel.modelId) {
      const resolved = resolveModelOption(
        resources.providers,
        draftModel.providerId,
        draftModel.modelId,
      );
      if (resolved) return resolved;
    }
    if (activeAssistant.defaultProviderId && activeAssistant.defaultModelId) {
      const resolved = resolveModelOption(
        resources.providers,
        activeAssistant.defaultProviderId,
        activeAssistant.defaultModelId,
      );
      if (resolved) return resolved;
    }
    return getDefaultModelOption(resources.providers);
  }, [
    activeAssistant.defaultModelId,
    activeAssistant.defaultProviderId,
    currentConversation?.modelId,
    currentConversation?.providerId,
    draftModel.modelId,
    draftModel.providerId,
    resources.providers,
  ]);

  const selectedProviderId = targetModel?.provider.id ?? '';
  const selectedModelId = targetModel?.model.id ?? '';

  const buildChatUrl = useCallback(
    (
      targetConvId?: string,
      opts?: { assistantId?: string; scope?: TopicScope },
    ) => {
      const scopeVal = opts?.scope ?? activeScope;
      if (targetConvId) {
        return isDesktop
          ? `/chat/${encodeURIComponent(targetConvId)}?scope=${scopeVal}`
          : `/chat/${encodeURIComponent(targetConvId)}`;
      }
      const aid = opts?.assistantId ?? activeAssistant.id;
      return isDesktop
        ? `/chat?assistant=${encodeURIComponent(aid)}&scope=${scopeVal}`
        : `/chat?assistant=${encodeURIComponent(aid)}`;
    },
    [activeAssistant.id, activeScope, isDesktop],
  );

  const handleChangeScope = useCallback(
    (nextScope: TopicScope) => {
      if (!isDesktop || nextScope === activeScope) return;
      detachStream();
      discardRef.current();
      setIsTemporaryMode(false);
      clearSession();
      setDraftSessionParams({ systemPrompt: '', params: {} });
      setInspectorOpen(false);
      prevUrlScopeRef.current = nextScope;
      setTopicScope(nextScope);
      if (conversationId) {
        navigate(buildChatUrl(undefined, { scope: nextScope }), { replace: true });
      } else {
        setSearchParams(
          { assistant: activeAssistant.id, scope: nextScope },
          { replace: true },
        );
      }
    },
    [
      activeAssistant.id,
      activeScope,
      buildChatUrl,
      clearSession,
      conversationId,
      detachStream,
      isDesktop,
      navigate,
      setSearchParams,
      setTopicScope,
    ],
  );

  const closeDrawers = useCallback((restoreFocusTo?: 'left' | 'right') => {
    setLeftDrawerOpen(false);
    setRightDrawerOpen(false);
    setInspectorOpen(false);
    if (restoreFocusTo === 'left') {
      leftToggleRef.current?.focus();
    } else if (restoreFocusTo === 'right') {
      rightToggleRef.current?.focus();
    }
  }, []);

  const handleStartNewTopic = useCallback(() => {
    setDraftAgent(undefined);
    detachStream();
    discardTemporarySession();
    setIsTemporaryMode(false);
    clearSession();
    setDraftSessionParams({ systemPrompt: '', params: {} });
    setInspectorOpen(false);
    closeDrawers();
    navigate(buildChatUrl());
  }, [
    buildChatUrl,
    clearSession,
    closeDrawers,
    detachStream,
    discardTemporarySession,
    navigate,
  ]);

  const handleToggleTemporaryMode = useCallback(() => {
    detachStream();
    discardTemporarySession();
    clearSession();
    setDraftSessionParams({ systemPrompt: '', params: {} });
    if (isTemporaryMode) {
      setIsTemporaryMode(false);
      return;
    }
    setIsTemporaryMode(true);
    if (conversationId) {
      navigate(buildChatUrl());
    }
  }, [
    buildChatUrl,
    clearSession,
    conversationId,
    detachStream,
    discardTemporarySession,
    isTemporaryMode,
    navigate,
  ]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const hasOpenLayer = Boolean(
        document.querySelector('[role="dialog"], [role="menu"]'),
      );
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        if (hasOpenLayer) return;
        e.preventDefault();
        handleStartNewTopic();
        return;
      }
      if (e.key === 'Escape') {
        if (hasOpenLayer) {
          return;
        }
        if (sidebarManageMode) {
          e.preventDefault();
          setSidebarManageMode(false);
          return;
        }
        if (leftDrawerOpen || rightDrawerOpen) {
          e.preventDefault();
          closeDrawers(leftDrawerOpen ? 'left' : 'right');
          return;
        }
        if (inspectorOpen) {
          e.preventDefault();
          setInspectorOpen(false);
          return;
        }
        if (graphOpen) {
          e.preventDefault();
          setGraphViewKey(null);
          graphToggleRef.current?.focus({ preventScroll: true });
          return;
        }
        if (isGenerating) {
          e.preventDefault();
          stopStreaming();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    closeDrawers,
    handleStartNewTopic,
    graphOpen,
    inspectorOpen,
    isGenerating,
    leftDrawerOpen,
    rightDrawerOpen,
    sidebarManageMode,
    stopStreaming,
  ]);

  const handleSelectAssistant = (assistantId: string) => {
    if (assistantId !== activeAssistant.id) {
      detachStream();
      discardTemporarySession();
      setIsTemporaryMode(false);
      setSelectedAssistantId(assistantId);
      setInspectorOpen(false);
      setDraftSessionParams({ systemPrompt: '', params: {} });
      const firstForAssistant = resources.conversations.find(
        (c) => (c.assistantId || 'default') === assistantId,
      );
      if (firstForAssistant) {
        navigate(buildChatUrl(firstForAssistant.id));
      } else {
        clearSession();
        navigate(buildChatUrl(undefined, { assistantId }));
      }
    }
    if (window.innerWidth < 768) {
      closeDrawers('left');
    }
  };

  const handleSelectConversation = (id: string, targetMessageId?: string) => {
    setDraftAgent(undefined);
    if (targetMessageId) {
      setPendingSearchJump({
        conversationId: id,
        messageId: targetMessageId,
        scope: activeScope,
        connectionEpoch,
      });
      setGraphViewKey(null);
    } else {
      setPendingSearchJump(null);
      activatingSearchJumpRef.current = null;
    }
    if (id !== conversationId || isTemporaryMode) {
      detachStream();
      discardTemporarySession();
      setIsTemporaryMode(false);
      navigate(buildChatUrl(id));
    }
    if (window.innerWidth < 1200) {
      closeDrawers('right');
    }
  };

  useEffect(() => {
    if (!pendingSearchJump) return;
    if (
      pendingSearchJump.connectionEpoch !== connectionEpoch ||
      pendingSearchJump.scope !== activeScope
    ) {
      setPendingSearchJump(null);
      activatingSearchJumpRef.current = null;
      return;
    }
    if (
      chatState.runState === 'loading' ||
      chatState.conversation?.id !== pendingSearchJump.conversationId
    ) {
      return;
    }
    const { conversationId: targetConvId, messageId: targetMsgId } = pendingSearchJump;
    if (activeMessages.some((msg) => msg.id === targetMsgId)) {
      setJumpTarget((prior) => ({
        messageId: targetMsgId,
        seq: (prior?.seq ?? 0) + 1,
      }));
      setGraphViewKey(null);
      setPendingSearchJump(null);
      activatingSearchJumpRef.current = null;
      return;
    }
    if (!chatState.messages.some((msg) => msg.id === targetMsgId)) {
      setPendingSearchJump(null);
      activatingSearchJumpRef.current = null;
      return;
    }
    if (!graphReady) return;
    const jumpKey = `${targetConvId}:${targetMsgId}`;
    if (activatingSearchJumpRef.current === jumpKey) return;
    activatingSearchJumpRef.current = jumpKey;
    const branch = branches?.find((item) => item.messageIds.includes(targetMsgId));
    const target =
      branch && 'branchId' in branch && branch.branchId
        ? { branchId: branch.branchId }
        : { leafMessageId: branch?.id ?? targetMsgId };
    void submitGraphMutation({ op: 'activateBranch', ...target }).then((detail) => {
      if (!detail && activatingSearchJumpRef.current === jumpKey) {
        activatingSearchJumpRef.current = null;
        setPendingSearchJump(null);
      }
    });
  }, [
    activeMessages,
    activeScope,
    branches,
    chatState.conversation?.id,
    chatState.runState,
    chatState.messages,
    connectionEpoch,
    graphReady,
    pendingSearchJump,
  ]);

  const currentModelScopeKey = currentConversation
    ? `${connectionEpoch}:${currentConversation.id}`
    : null;
  const isSavingModel =
    currentModelScopeKey !== null && savingModelKey === currentModelScopeKey;

  const handleSelectModel = async (providerId: string, modelId: string) => {
    if (!currentConversation) {
      setDraftModel({ providerId, modelId });
      return;
    }
    const targetConvId = currentConversation.id;
    const startEpoch = connectionEpoch;
    const targetScope = activeScopeRef.current;
    const scopeKey = `${startEpoch}:${targetConvId}`;
    if (isBusy || modelSaveLockRef.current === scopeKey) return;

    modelSaveLockRef.current = scopeKey;
    setSavingModelKey(scopeKey);
    try {
      const updated = await gateway.patchConversation(
        targetConvId,
        {
          providerId,
          modelId,
        },
        undefined,
        targetScope,
      );
      if (
        activeConnEpochRef.current !== startEpoch ||
        activeConvIdRef.current !== targetConvId ||
        activeScopeRef.current !== targetScope
      ) {
        return;
      }
      upsertLocalConversation(updated, targetScope);
      updateConversationMeta(updated);
    } catch {
      if (
        activeConnEpochRef.current === startEpoch &&
        activeConvIdRef.current === targetConvId
      ) {
        toast('切换模型失败', 'error');
      }
    } finally {
      if (modelSaveLockRef.current === scopeKey) {
        modelSaveLockRef.current = null;
      }
      setSavingModelKey((prev) => (prev === scopeKey ? null : prev));
    }
  };

  const handleSend = async (opts: {
    blocks: ContentBlock[];
    text: string;
    webSearch: boolean;
    searchEngineId?: string;
    onOptimisticStart: () => void;
    onPrepareRollback: () => void;
    onAccepted: () => void;
  }): Promise<boolean> => {
    if (effortSaveLock.current === connectionEpoch || isSavingModel || modeBusy || modeSaveLock.current === modeKey) return false;
    if (!selectedProviderId || !selectedModelId) {
      toast('请先配置可用模型', 'error');
      return false;
    }

    const existingConvId =
      currentConversation?.id ??
      (isTemporaryMode ? temporaryConvIdRef.current ?? '' : conversationId ?? '');
    const tempModeAtSend = isTemporaryMode;
    const scopeAtSend = activeScopeRef.current;
    return sendMessage({
      conversationId: existingConvId || undefined,
      conversationMode,
      scope: scopeAtSend,
      ensureConversation: existingConvId
        ? undefined
        : async (signal) => {
            if (tempModeAtSend && temporaryConvIdRef.current) {
              const created = await gateway.getConversationDetail(
                temporaryConvIdRef.current,
                signal,
                scopeAtSend,
              );
              return created.conversation;
            }
            const created = await gateway.createConversation(
              {
                assistantId: activeAssistant.id,
                providerId: selectedProviderId,
                modelId: selectedModelId,
                systemPrompt: draftSessionParams.systemPrompt,
                params: {
                  ...draftSessionParams.params,
                  reasoningEffort,
                },
                ...(conversationMode === 'agent' ? { mode: conversationMode } : {}),
                ...(tempModeAtSend ? { ephemeral: true } : {}),
              },
              signal,
              scopeAtSend,
            );
            if (conversationMode === 'agent' && draft?.path && !signal.aborted) {
              try {
                await gateway.setAgentTopicDirectory(created.id, draft.path, scopeAtSend, signal);
              } catch (err) {
                void gateway.deleteConversation(created.id, undefined, scopeAtSend).catch(() => {});
                throw err;
              }
            }
            if (signal.aborted) {
              if (tempModeAtSend || conversationMode === 'agent') {
                void gateway.deleteConversation(created.id, undefined, scopeAtSend).catch(() => {});
              }
              return null;
            }
            setDraftAgent(undefined);
            if (tempModeAtSend) {
              temporaryConvIdRef.current = created.id;
              return created;
            }
            upsertLocalConversation(created, scopeAtSend);
            skipNextLoadIdRef.current = `${scopeAtSend ?? 'cloud'}:${created.id}`;
            navigate(buildChatUrl(created.id, { scope: scopeAtSend }), { replace: true });
            return created;
          },
      blocks: opts.blocks,
      text: opts.text,
      providerId: selectedProviderId,
      modelId: selectedModelId,
      params: { reasoningEffort },
      mcpToolsEnabled,
      webSearch: opts.webSearch,
      searchEngineId: opts.searchEngineId,
      onOptimisticStart: opts.onOptimisticStart,
      onPrepareRollback: opts.onPrepareRollback,
      onStreamAccepted: opts.onAccepted,
    });
  };

  const handleRetryMessage = (message: Message) =>
    regenerateMessage({
      targetMessageId: message.id,
      providerId: selectedProviderId,
      modelId: selectedModelId,
      params: { reasoningEffort },
      mcpToolsEnabled,
      scope: activeScopeRef.current,
    });

  const handleDeleteMessage = (message: Message) =>
    deleteMessage(message.id, activeScopeRef.current);

  const handleCompact = useCallback(async () => {
    if (!currentConversation?.id || !selectedProviderId || !selectedModelId) {
      return;
    }
    const res = await compactConversation({
      providerId: selectedProviderId,
      modelId: selectedModelId,
      scope: activeScopeRef.current,
    });
    if (res.ok) {
      toast('上下文已压缩');
    } else if (res.error) {
      toast(res.error, 'error');
    }
  }, [
    compactConversation,
    currentConversation?.id,
    selectedModelId,
    selectedProviderId,
    toast,
  ]);

  const handleUpdateMessage = (messageId: string, blocks: ContentBlock[]) =>
    updateMessage(messageId, blocks, activeScopeRef.current);

  const handleBranchMessage = async (message: Message) => {
    const detail = await branchFromMessage(message.id, activeScopeRef.current);
    if (detail) {
      navigate(buildChatUrl(detail.conversation.id));
      toast('已复制为独立新话题');
    }
  };

  const handleToggleLeft = () => {
    if (window.innerWidth < 768) {
      setRightDrawerOpen(false);
      setLeftDrawerOpen((v) => !v);
    } else {
      setLeftOpenDesktop((v) => !v);
    }
  };

  const handleToggleRight = () => {
    if (window.innerWidth < 1200) {
      setLeftDrawerOpen(false);
      setInspectorOpen(false);
      setRightDrawerOpen((v) => !v);
    } else if (inspectorOpen) {
      setInspectorOpen(false);
      setRightOpenDesktop(true);
    } else {
      setRightOpenDesktop((v) => !v);
    }
  };

  const handleToggleParams = () => {
    if (window.innerWidth < 1200) {
      setLeftDrawerOpen(false);
      setInspectorOpen((v) => {
        const next = !v;
        setRightDrawerOpen(next);
        return next;
      });
    } else {
      setRightOpenDesktop(true);
      setInspectorOpen((v) => !v);
    }
  };

  const handleSyncServer = useCallback(async () => {
    if (isBusy || syncingServer) return;
    const startEpoch = activeConnEpochRef.current;
    const openPersistentConvId = !isTemporaryMode ? conversationId : undefined;
    const res = await syncFromServer();
    if (activeConnEpochRef.current !== startEpoch) return;
    if (!res.ok) {
      toast(res.error || '同步失败', 'error');
      return;
    }
    if (openPersistentConvId) {
      const stillExists = res.conversations?.some(
        (c) => c.id === openPersistentConvId,
      );
      if (!stillExists) {
        stopStreaming();
        clearSession();
        setDraftSessionParams({ systemPrompt: '', params: {} });
        navigate(buildChatUrl(), {
          replace: true,
        });
        toast('当前话题已在其他端删除');
        return;
      }
      await reloadCurrentConversation();
    }
  }, [
    buildChatUrl,
    clearSession,
    conversationId,
    isBusy,
    isTemporaryMode,
    navigate,
    reloadCurrentConversation,
    stopStreaming,
    syncFromServer,
    syncingServer,
    toast,
  ]);

  const shellClasses = [
    'wb-shell',
    !leftOpenDesktop ? 'wb-shell--no-left' : '',
    !rightOpenDesktop ? 'wb-shell--no-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const manualWidthActive = settings.chatWidthMode === 'manual';
  const resolvedManualWidth = useMemo(() => {
    if (!manualWidthActive) return null;
    const desired = dragWidth ?? settings.chatManualWidth;
    if (stageWidth <= 0) {
      const clamped = Math.max(CHAT_WIDTH_MIN, Math.min(CHAT_WIDTH_MAX, desired));
      return { cssMaxWidth: `${Math.round(clamped)}px`, railHalfPx: Math.round(clamped) / 2, effectivePx: clamped };
    }
    const minAllowed = Math.min(CHAT_WIDTH_MIN, stageWidth);
    const maxAllowed = Math.min(CHAT_WIDTH_MAX, stageWidth);
    const clamped = Math.max(minAllowed, Math.min(maxAllowed, desired));
    if (stageWidth - clamped <= 8 && stageWidth <= CHAT_WIDTH_MAX) {
      return { cssMaxWidth: '100%', railHalfPx: stageWidth / 2, effectivePx: stageWidth };
    }
    return { cssMaxWidth: `${Math.round(clamped)}px`, railHalfPx: Math.round(clamped) / 2, effectivePx: clamped };
  }, [dragWidth, manualWidthActive, settings.chatManualWidth, stageWidth]);

  const chatStageStyle = useMemo((): CSSProperties | undefined => {
    if (!resolvedManualWidth) return undefined;
    return {
      '--chat-max-width': resolvedManualWidth.cssMaxWidth,
      '--chat-rail-half': `${resolvedManualWidth.railHalfPx}px`,
    } as CSSProperties;
  }, [resolvedManualWidth]);

  const clampManualDragWidth = useCallback(
    (rawWidth: number, containerWidth: number): number => {
      const effMax = containerWidth > 0 ? Math.min(CHAT_WIDTH_MAX, containerWidth) : CHAT_WIDTH_MAX;
      const effMin = Math.min(CHAT_WIDTH_MIN, effMax);
      const clamped = Math.max(effMin, Math.min(effMax, rawWidth));
      if (containerWidth > 0 && containerWidth <= CHAT_WIDTH_MAX && containerWidth - clamped <= 8) {
        return containerWidth;
      }
      return Math.round(clamped);
    },
    [],
  );

  const handleWidthEdgePointerDown = (
    side: 'left' | 'right',
    e: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const containerWidth = chatStageRef.current?.clientWidth || stageWidth || settings.chatManualWidth;
    const startWidth = resolvedManualWidth?.effectivePx ?? settings.chatManualWidth;
    dragSessionRef.current = {
      pointerId: e.pointerId,
      side,
      startX: e.clientX,
      startWidth,
      containerWidth,
      currentWidth: startWidth,
    };
    setResizingWidth(true);
    setDragWidth(startWidth);
  };

  const handleWidthEdgePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    const dx = e.clientX - session.startX;
    const rawNext =
      session.side === 'right'
        ? session.startWidth + 2 * dx
        : session.startWidth - 2 * dx;
    const next = clampManualDragWidth(rawNext, session.containerWidth);
    session.currentWidth = next;
    setDragWidth(next);
  };

  const finishWidthDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== e.pointerId) return;
    dragSessionRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setResizingWidth(false);
    setDragWidth(null);
    const committed = Math.max(
      CHAT_WIDTH_MIN,
      Math.min(CHAT_WIDTH_MAX, Math.round(session.currentWidth)),
    );
    if (committed !== settings.chatManualWidth) {
      void updatePreferences({ chatManualWidth: committed });
    }
  };

  const handleWidthEdgeKeyDown = (
    side: 'left' | 'right',
    e: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const containerWidth = chatStageRef.current?.clientWidth || stageWidth || settings.chatManualWidth;
    const base = resolvedManualWidth?.effectivePx ?? settings.chatManualWidth;
    const delta =
      side === 'right'
        ? e.key === 'ArrowRight'
          ? 24
          : -24
        : e.key === 'ArrowLeft'
          ? 24
          : -24;
    const next = clampManualDragWidth(base + delta, containerWidth);
    const committed = Math.max(
      CHAT_WIDTH_MIN,
      Math.min(CHAT_WIDTH_MAX, Math.round(next)),
    );
    if (committed !== settings.chatManualWidth) {
      void updatePreferences({ chatManualWidth: committed });
    }
  };

  return (
    <div ref={shellRef} className={shellClasses}>
      <AssistantSidebar
        assistants={assistants}
        activeAssistantId={activeAssistant.id}
        drawerOpen={leftDrawerOpen}
        onSelectAssistant={handleSelectAssistant}
        onAddAssistant={() => {
          setEditingAssistant(null);
          setAssistantModalOpen(true);
        }}
        onEditAssistant={(a) => {
          setEditingAssistant(a);
          setAssistantModalOpen(true);
        }}
        onNavigateSettings={() => closeDrawers()}
      />

      <main className="wb-main">
        <header className="wb-toolbar">
          <IconButton
            ref={leftToggleRef}
            icon="sidebar"
            label="切换助手栏"
            active={leftDrawerOpen}
            onClick={handleToggleLeft}
          />

          <div className="wb-crumb">
            <button
              type="button"
              className="wb-assistant-pill"
              onClick={() => {
                setEditingAssistant(activeAssistant);
                setAssistantModalOpen(true);
              }}
              title={`编辑 ${activeAssistant.name}`}
            >
              <span className="wb-assistant-pill__name">
                {activeAssistant.name}
              </span>
            </button>
          </div>

          <div className="wb-toolbar__spacer" />

          {showAgentMode && (
            <>
              <div className="wb-mode-control">
                <SegmentedControl<ConversationMode>
                  ariaLabel="话题模式"
                  value={conversationMode}
                  disabled={modeBusy}
                  options={[
                    { value: 'chat', label: <Icon name="messageSquare" size={16} />, ariaLabel: '对话' },
                    { value: 'agent', label: <Icon name="terminal" size={16} />, ariaLabel: 'Agent' },
                  ]}
                  onChange={(mode) => void changeMode(mode)}
                />
              </div>
              {!isCompact && (
                <span className="wb-toolbar__divider" aria-hidden="true" />
              )}
            </>
          )}

          {isCompact ? (
            <>
              {graphOpen && graphConversation && (
                <IconButton
                  ref={graphToggleRef}
                  className="wb-graph-toggle"
                  icon="messageSquare"
                  label="返回对话"
                  active
                  aria-pressed
                  disabled={graphBusy || !graphReady}
                  onClick={closeGraph}
                />
              )}
              <Popover
                open={toolbarMenuOpen}
                onOpenChange={setToolbarMenuOpen}
                side="bottom"
                align="end"
                contentProps={{ 'aria-label': '更多话题操作' }}
                trigger={
                  <IconButton
                    className="wb-toolbar-more"
                    icon="ellipsis"
                    label="更多话题操作"
                    active={toolbarMenuOpen}
                    aria-expanded={toolbarMenuOpen}
                    data-has-active={
                      showBranch || isTemporaryMode || inspectorOpen
                        ? 'true'
                        : undefined
                    }
                  />
                }
              >
                <div className="wb-toolbar-menu" role="group" aria-label="话题操作">
                  {graphConversation && (
                    <button
                      type="button"
                      className={`wb-toolbar-menu__item${
                        graphOpen ? ' wb-toolbar-menu__item--active' : ''
                      }`}
                      disabled={graphBusy || !graphReady}
                      aria-pressed={graphOpen}
                      onClick={() => {
                        setToolbarMenuOpen(false);
                        if (graphOpen) closeGraph();
                        else setGraphViewKey(modeKey);
                      }}
                    >
                      <Icon name={graphOpen ? 'messageSquare' : 'mindMap'} size={15} />
                      <span className="wb-toolbar-menu__label">
                        {graphOpen ? '返回对话' : '对话缩略图'}
                      </span>
                      {showBranch && (
                        <span className="wb-toolbar-menu__badge">
                          <Icon name="branch" size={12} />
                          <span>{activeBranch?.label ?? branches?.length}</span>
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`wb-toolbar-menu__item${
                      isTemporaryMode ? ' wb-toolbar-menu__item--active' : ''
                    }`}
                    aria-pressed={isTemporaryMode}
                    onClick={() => {
                      setToolbarMenuOpen(false);
                      handleToggleTemporaryMode();
                    }}
                  >
                    <Icon name="temporaryChat" size={15} />
                    <span className="wb-toolbar-menu__label">
                      {isTemporaryMode ? '退出临时会话' : '临时会话'}
                    </span>
                    {isTemporaryMode && (
                      <Icon name="check" size={14} className="wb-toolbar-menu__check" />
                    )}
                  </button>
                  <button
                    type="button"
                    className={`wb-toolbar-menu__item${
                      inspectorOpen ? ' wb-toolbar-menu__item--active' : ''
                    }`}
                    aria-pressed={inspectorOpen}
                    onClick={() => {
                      setToolbarMenuOpen(false);
                      handleToggleParams();
                    }}
                  >
                    <Icon name="sliders" size={15} />
                    <span className="wb-toolbar-menu__label">话题参数</span>
                    {inspectorOpen && (
                      <Icon name="check" size={14} className="wb-toolbar-menu__check" />
                    )}
                  </button>
                </div>
              </Popover>
            </>
          ) : (
            <>
              {showBranch && (
                <button
                  type="button"
                  className="wb-branch-badge"
                  disabled={!graphReady || graphBusy}
                  aria-label={activeBranch?.label ?? '话题分支'}
                  aria-pressed={graphOpen}
                  onClick={() => setGraphViewKey(modeKey)}
                >
                  <Icon name="branch" size={14} />
                  <span>{activeBranch?.label ?? branches?.length}</span>
                </button>
              )}
              {graphConversation && (
                <IconButton
                  ref={graphToggleRef}
                  className="wb-graph-toggle"
                  data-branch={showBranch || undefined}
                  aria-description={
                    showBranch ? activeBranch?.label ?? '多个话题内分支' : undefined
                  }
                  icon={graphOpen ? 'messageSquare' : 'mindMap'}
                  label={graphOpen ? '返回对话' : '对话缩略图'}
                  active={graphOpen}
                  aria-pressed={graphOpen}
                  disabled={graphBusy || !graphReady}
                  onClick={() => {
                    if (graphOpen) closeGraph();
                    else setGraphViewKey(modeKey);
                  }}
                />
              )}
              <IconButton
                icon="temporaryChat"
                label={isTemporaryMode ? '退出临时会话' : '临时会话'}
                active={isTemporaryMode}
                onClick={handleToggleTemporaryMode}
              />
              <IconButton
                icon="sliders"
                label="话题参数"
                active={inspectorOpen}
                onClick={handleToggleParams}
              />
              <span className="wb-toolbar__divider" aria-hidden="true" />
            </>
          )}
          <IconButton
            ref={rightToggleRef}
            icon="history"
            label="切换话题栏"
            active={rightDrawerOpen && !inspectorOpen}
            onClick={handleToggleRight}
          />
        </header>

        {conversationMode === 'agent' && (
          <AgentTopicDirectory key={modeKey} gateway={gateway} scope={reqScope} topicId={activeId}
            draftPath={draft?.path ?? ''} disabled={modeBusy}
            onDraftPath={(path) => setDraftAgent({ key: draftKey, mode: 'agent', path })} />
        )}

        <div
          ref={chatStageRef}
          className="wb-chat-stage"
          data-width-mode={settings.chatWidthMode}
          data-resizing={resizingWidth ? 'true' : undefined}
          style={chatStageStyle}
        >
          {!graphOpen && manualWidthActive ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="拖动调整对话区域宽度"
                tabIndex={0}
                className="wb-width-edge wb-width-edge--left"
                onPointerDown={(e) => handleWidthEdgePointerDown('left', e)}
                onPointerMove={handleWidthEdgePointerMove}
                onPointerUp={finishWidthDrag}
                onPointerCancel={finishWidthDrag}
                onKeyDown={(e) => handleWidthEdgeKeyDown('left', e)}
              />
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="拖动调整对话区域宽度"
                tabIndex={0}
                className="wb-width-edge wb-width-edge--right"
                onPointerDown={(e) => handleWidthEdgePointerDown('right', e)}
                onPointerMove={handleWidthEdgePointerMove}
                onPointerUp={finishWidthDrag}
                onPointerCancel={finishWidthDrag}
                onKeyDown={(e) => handleWidthEdgeKeyDown('right', e)}
              />
            </>
          ) : null}

          {graphOpen && graphConversation && <ConversationGraphView
            key={modeKey} conversation={graphConversation} messages={chatState.messages} activeMessages={activeMessages}
            busy={graphBusy || !graphReady} mutate={submitGraphMutation} onJump={(id) => void jumpToGraphMessage(id)}
            onActivate={(target) => void activateGraphBranch(target)} onDelete={handleDeleteMessage}
            focusNodeId={graphFocusNodeId} onFocusHandled={() => setGraphFocusNodeId(null)}
          />}
          <div className="wb-chat-view" hidden={graphOpen}>
          <ChatCanvas
            activeMessages={activeMessages}
            allMessages={sessionScope === reqScope ? chatState.messages : []}
            jumpTarget={jumpTarget}
            scope={reqScope}
            state={chatState}
            assistant={activeAssistant}
            providers={resources.providers}
            hasConversationId={Boolean(conversationId)}
            isTemporary={isTemporaryMode}
            graphReady={graphReady && !graphBusy}
            onOpenGraphNode={graphConversation ? openGraphAtNode : undefined}
            onRemoveSideRef={graphConversation ? removeSideRefFromChat : undefined}
            onUpdateMessage={handleUpdateMessage}
            onRetryMessage={handleRetryMessage}
            onDeleteMessage={handleDeleteMessage}
            onBranchMessage={handleBranchMessage}
            onReloadConversation={reloadCurrentConversation}
            onResetToNewTopic={handleStartNewTopic}
          />

          <Composer
            compact={isCompact}
            selectedProviderId={selectedProviderId}
            selectedModelId={selectedModelId}
            reasoningEffort={reasoningEffort}
            mcpActive={hasMcpSource && mcpToolsEnabled}
            onToggleMcp={toggleMcp}
            savingModel={isSavingModel}
            savingEffort={savingEffort}
            isBusy={isBusy || isCompacting || savingMode}
            canStop={isGenerating}
            messages={sessionScope === reqScope ? activeMessages : []}
            allMessages={sessionScope === reqScope ? chatState.messages : []}
            streaming={chatState.streaming}
            systemPrompt={currentConversation?.systemPrompt || activeAssistant.systemPrompt || ''}
            contextWindow={targetModel?.model.contextWindow}
            onSelectModel={(pId, mId) => void handleSelectModel(pId, mId)}
            onChangeReasoningEffort={saveReasoningEffort}
            onStop={stopStreaming}
            onSend={handleSend}
            onCompact={handleCompact}
            canCompact={Boolean(
              currentConversation?.id &&
                selectedProviderId &&
                selectedModelId &&
                !isBusy &&
                !isCompacting,
            )}
            isCompacting={isCompacting}
          />
          </div>
        </div>
      </main>

      <ConversationSidebar
        assistantId={activeAssistant.id}
        conversations={scopedConversations}
        groups={scopedGroups}
        activeConversationId={currentConversation?.id ?? conversationId ?? null}
        activeConversation={currentConversation}
        draftSessionParams={draftSessionParams}
        inspectorOpen={inspectorOpen}
        drawerOpen={rightDrawerOpen}
        manageMode={sidebarManageMode}
        isBusy={isBusy}
        scope={activeScope}
        onScopeChange={handleChangeScope}
        onManageModeChange={setSidebarManageMode}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleStartNewTopic}
        onCloseInspector={() => {
          setInspectorOpen(false);
          if (window.innerWidth < 1200) {
            closeDrawers('right');
          }
        }}
        onCloseDrawer={() => closeDrawers('right')}
        onConversationPatched={(updated) => {
          if (chatState.conversation?.id === updated.id) {
            updateConversationMeta(updated);
          }
        }}
        onConversationsDeleted={(deletedIds, remaining) => {
          if (conversationId && deletedIds.includes(conversationId)) {
            stopStreaming();
            const next = remaining[0];
            if (next) {
              navigate(buildChatUrl(next.id), {
                replace: true,
              });
            } else {
              clearSession();
              navigate(buildChatUrl(), { replace: true });
            }
          }
        }}
        onSaveDraftSessionParams={setDraftSessionParams}
        lastSyncedAt={lastSyncedAt}
        syncingServer={syncingServer}
        onSyncServer={() => void handleSyncServer()}
      />

      <button
        type="button"
        aria-label="关闭侧栏"
        aria-hidden={!(leftDrawerOpen || rightDrawerOpen) || undefined}
        tabIndex={leftDrawerOpen || rightDrawerOpen ? 0 : -1}
        className={`wb-scrim ${
          leftDrawerOpen || rightDrawerOpen ? 'wb-scrim--open' : ''
        }`.trim()}
        onClick={() => closeDrawers(leftDrawerOpen ? 'left' : 'right')}
      />

      <AssistantEditor
        open={assistantModalOpen}
        onOpenChange={setAssistantModalOpen}
        assistant={editingAssistant}
        onSaved={(saved) => {
          setSelectedAssistantId(saved.id);
          if (!conversationId) {
            setSearchParams(
              isDesktop
                ? { assistant: saved.id, scope: activeScope }
                : { assistant: saved.id },
              { replace: true },
            );
          }
        }}
        onDeleted={(deletedId) => {
          if (selectedAssistantId === deletedId) {
            const fallback =
              assistants.find((a) => a.id !== deletedId)?.id ?? 'default';
            setSelectedAssistantId(fallback);
            clearSession();
            navigate(buildChatUrl(undefined, { assistantId: fallback }), {
              replace: true,
            });
          }
        }}
      />
    </div>
  );
}

export function WorkbenchPage() {
  return (
    <ChatProvider>
      <WorkbenchInner />
    </ChatProvider>
  );
}
