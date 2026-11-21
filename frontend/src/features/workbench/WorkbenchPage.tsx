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
import { IconButton } from '../../components/ui';
import { CHAT_WIDTH_MAX, CHAT_WIDTH_MIN } from '../../core/settings';
import { isReasoningEffort, type Assistant, type ContentBlock, type Message, type ReasoningEffort, type TopicScope } from '../../core/types';
import { ChatProvider, useChat } from '../chat/ChatProvider';
import { AssistantEditor } from './AssistantEditor';
import { AssistantSidebar } from './AssistantSidebar';
import { ChatCanvas } from './ChatCanvas';
import { Composer } from './Composer';
import { ConversationSidebar } from './ConversationSidebar';
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

function WorkbenchInner() {
  const shellRef = useComposerViewport();
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
    stopStreaming,
  } = useChat();

  const [leftOpenDesktop, setLeftOpenDesktop] = useState(true);
  const [rightOpenDesktop, setRightOpenDesktop] = useState(true);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sidebarManageMode, setSidebarManageMode] = useState(false);
  const [isTemporaryMode, setIsTemporaryMode] = useState(false);

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

  const currentConversation = useMemo(() => {
    if (conversationId) {
      if (chatState.conversation?.id === conversationId) {
        return chatState.conversation;
      }
      return (
        resources.conversations.find((c) => c.id === conversationId) ?? null
      );
    }
    if (isTemporaryMode && chatState.conversation?.ephemeral) {
      return chatState.conversation;
    }
    return null;
  }, [chatState.conversation, conversationId, isTemporaryMode, resources.conversations]);

  const activeConvIdRef = useRef<string | undefined>(
    currentConversation?.id ?? conversationId,
  );
  activeConvIdRef.current = currentConversation?.id ?? conversationId;

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
      stopStreaming();
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
      isDesktop,
      navigate,
      setSearchParams,
      setTopicScope,
      stopStreaming,
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
    stopStreaming();
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
    discardTemporarySession,
    navigate,
    stopStreaming,
  ]);

  const handleToggleTemporaryMode = useCallback(() => {
    stopStreaming();
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
    discardTemporarySession,
    isTemporaryMode,
    navigate,
    stopStreaming,
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
    inspectorOpen,
    isGenerating,
    leftDrawerOpen,
    rightDrawerOpen,
    sidebarManageMode,
    stopStreaming,
  ]);

  const handleSelectAssistant = (assistantId: string) => {
    if (assistantId !== activeAssistant.id) {
      stopStreaming();
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

  const handleSelectConversation = (id: string) => {
    if (id !== conversationId || isTemporaryMode) {
      stopStreaming();
      discardTemporarySession();
      setIsTemporaryMode(false);
      navigate(buildChatUrl(id));
    }
    if (window.innerWidth < 1200) {
      closeDrawers('right');
    }
  };

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
    if (effortSaveLock.current === connectionEpoch || isSavingModel) return false;
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
                ...(tempModeAtSend ? { ephemeral: true } : {}),
              },
              signal,
              scopeAtSend,
            );
            if (signal.aborted) {
              if (tempModeAtSend) {
                void gateway.deleteConversation(created.id, undefined, scopeAtSend).catch(() => {});
              }
              return null;
            }
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
      toast('已创建分支话题');
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
          <IconButton
            ref={rightToggleRef}
            icon="history"
            label="切换话题栏"
            active={rightDrawerOpen && !inspectorOpen}
            onClick={handleToggleRight}
          />
        </header>

        <div
          ref={chatStageRef}
          className="wb-chat-stage"
          data-width-mode={settings.chatWidthMode}
          data-resizing={resizingWidth ? 'true' : undefined}
          style={chatStageStyle}
        >
          {manualWidthActive ? (
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

          <ChatCanvas
            scope={reqScope}
            state={chatState}
            assistant={activeAssistant}
            providers={resources.providers}
            hasConversationId={Boolean(conversationId)}
            isTemporary={isTemporaryMode}
            onUpdateMessage={handleUpdateMessage}
            onRetryMessage={handleRetryMessage}
            onDeleteMessage={handleDeleteMessage}
            onBranchMessage={handleBranchMessage}
            onReloadConversation={reloadCurrentConversation}
            onResetToNewTopic={handleStartNewTopic}
          />

          <Composer
            selectedProviderId={selectedProviderId}
            selectedModelId={selectedModelId}
            reasoningEffort={reasoningEffort}
            savingModel={isSavingModel}
            savingEffort={savingEffort}
            isBusy={isBusy || isCompacting}
            canStop={isGenerating}
            messages={chatState.messages}
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
