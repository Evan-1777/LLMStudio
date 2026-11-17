import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { Icon, IconButton } from '../../components/ui';
import type { Assistant, ContentBlock, Message } from '../../core/types';
import { ChatProvider, useChat } from '../chat/ChatProvider';
import { AssistantEditor } from './AssistantEditor';
import { AssistantSidebar } from './AssistantSidebar';
import { ChatCanvas } from './ChatCanvas';
import { Composer } from './Composer';
import { ConversationSidebar } from './ConversationSidebar';
import {
  ModelPicker,
  getDefaultModelOption,
  resolveModelOption,
} from './ModelPicker';
import type { DraftSessionParams } from './SessionInspector';
import './workbench.css';

function WorkbenchInner() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const {
    gateway,
    connectionState,
    connectionEpoch,
    resources,
    upsertLocalConversation,
    toast,
  } = useApp();

  const {
    state: chatState,
    isBusy,
    setReasoningEffort,
    updateConversationMeta,
    clearSession,
    loadConversation,
    reloadCurrentConversation,
    sendMessage,
    regenerateMessage,
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
  const skipNextLoadIdRef = useRef<string | null>(null);
  const activeConvIdRef = useRef<string | undefined>(conversationId);
  activeConvIdRef.current = conversationId;
  const activeConnEpochRef = useRef<number>(connectionEpoch);
  activeConnEpochRef.current = connectionEpoch;
  const [savingModelKey, setSavingModelKey] = useState<string | null>(null);
  const modelSaveLockRef = useRef<string | null>(null);

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
    if (connectionState !== 'connected') {
      return;
    }
    if (skipNextLoadIdRef.current === conversationId) {
      skipNextLoadIdRef.current = null;
      return;
    }
    let alive = true;
    void loadConversation(conversationId).then((detail) => {
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
    if (!conversationId) return null;
    if (chatState.conversation?.id === conversationId) {
      return chatState.conversation;
    }
    return (
      resources.conversations.find((c) => c.id === conversationId) ?? null
    );
  }, [chatState.conversation, conversationId, resources.conversations]);

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
    clearSession();
    setDraftSessionParams({ systemPrompt: '', params: {} });
    setInspectorOpen(false);
    closeDrawers();
    navigate(`/chat?assistant=${encodeURIComponent(activeAssistant.id)}`);
  }, [activeAssistant.id, clearSession, closeDrawers, navigate, stopStreaming]);

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
        if (isBusy) {
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
    isBusy,
    leftDrawerOpen,
    rightDrawerOpen,
    sidebarManageMode,
    stopStreaming,
  ]);

  const handleSelectAssistant = (assistantId: string) => {
    if (assistantId !== activeAssistant.id) {
      stopStreaming();
      setSelectedAssistantId(assistantId);
      setInspectorOpen(false);
      setDraftSessionParams({ systemPrompt: '', params: {} });
      const firstForAssistant = resources.conversations.find(
        (c) => (c.assistantId || 'default') === assistantId,
      );
      if (firstForAssistant) {
        navigate(`/chat/${encodeURIComponent(firstForAssistant.id)}`);
      } else {
        clearSession();
        navigate(`/chat?assistant=${encodeURIComponent(assistantId)}`);
      }
    }
    if (window.innerWidth < 768) {
      closeDrawers('left');
    }
  };

  const handleSelectConversation = (id: string) => {
    if (id !== conversationId) {
      stopStreaming();
      navigate(`/chat/${encodeURIComponent(id)}`);
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
    const scopeKey = `${startEpoch}:${targetConvId}`;
    if (isBusy || modelSaveLockRef.current === scopeKey) return;

    modelSaveLockRef.current = scopeKey;
    setSavingModelKey(scopeKey);
    try {
      const updated = await gateway.patchConversation(targetConvId, {
        providerId,
        modelId,
      });
      if (
        activeConnEpochRef.current !== startEpoch ||
        activeConvIdRef.current !== targetConvId
      ) {
        return;
      }
      upsertLocalConversation(updated);
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
    onAccepted: () => void;
  }): Promise<boolean> => {
    if (!selectedProviderId || !selectedModelId) {
      toast('请先配置可用模型', 'error');
      return false;
    }

    let targetConvId = currentConversation?.id ?? conversationId ?? '';
    let createdConv = undefined;
    if (!targetConvId) {
      try {
        const created = await gateway.createConversation({
          assistantId: activeAssistant.id,
          providerId: selectedProviderId,
          modelId: selectedModelId,
          systemPrompt: draftSessionParams.systemPrompt,
          params: {
            ...draftSessionParams.params,
            reasoningEffort: chatState.reasoningEffort,
          },
        });
        upsertLocalConversation(created);
        targetConvId = created.id;
        createdConv = created;
        skipNextLoadIdRef.current = created.id;
        navigate(`/chat/${encodeURIComponent(created.id)}`, { replace: true });
      } catch {
        toast('创建话题失败，草稿已保留', 'error');
        return false;
      }
    }

    return sendMessage({
      conversationId: targetConvId,
      conversation: createdConv,
      blocks: opts.blocks,
      text: opts.text,
      providerId: selectedProviderId,
      modelId: selectedModelId,
      params: { reasoningEffort: chatState.reasoningEffort },
      webSearch: opts.webSearch,
      searchEngineId: opts.searchEngineId,
      onStreamAccepted: opts.onAccepted,
    });
  };

  const handleRetryMessage = (message: Message) =>
    regenerateMessage({
      targetMessageId: message.id,
      providerId: selectedProviderId,
      modelId: selectedModelId,
      params: { reasoningEffort: chatState.reasoningEffort },
    });

  const handleDeleteMessage = (message: Message) => deleteMessage(message.id);

  const handleUpdateMessage = (messageId: string, blocks: ContentBlock[]) =>
    updateMessage(messageId, blocks);

  const handleBranchMessage = async (message: Message) => {
    const detail = await branchFromMessage(message.id);
    if (detail) {
      navigate(`/chat/${encodeURIComponent(detail.conversation.id)}`);
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

  const shellClasses = [
    'wb-shell',
    !leftOpenDesktop ? 'wb-shell--no-left' : '',
    !rightOpenDesktop ? 'wb-shell--no-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClasses}>
      <AssistantSidebar
        assistants={assistants}
        activeAssistantId={activeAssistant.id}
        connected={connectionState === 'connected'}
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
            onClick={handleToggleLeft}
          />

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

          <Icon name="chevronRight" size={14} className="wb-crumb-sep" />

          <ModelPicker
            providers={resources.providers}
            selectedProviderId={selectedProviderId}
            selectedModelId={selectedModelId}
            disabled={isBusy}
            busy={isSavingModel}
            onSelect={(pId, mId) => void handleSelectModel(pId, mId)}
          />

          <div className="wb-toolbar__spacer" />

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
            onClick={handleToggleRight}
          />
        </header>

        <ChatCanvas
          state={chatState}
          assistant={activeAssistant}
          providers={resources.providers}
          hasConversationId={Boolean(conversationId)}
          onUpdateMessage={handleUpdateMessage}
          onRetryMessage={handleRetryMessage}
          onDeleteMessage={handleDeleteMessage}
          onBranchMessage={handleBranchMessage}
          onReloadConversation={reloadCurrentConversation}
          onResetToNewTopic={handleStartNewTopic}
        />

        <Composer
          selectedModel={targetModel?.model ?? null}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          reasoningEffort={chatState.reasoningEffort}
          isBusy={isBusy}
          onChangeReasoningEffort={setReasoningEffort}
          onStop={stopStreaming}
          onSend={handleSend}
        />
      </main>

      <ConversationSidebar
        assistantId={activeAssistant.id}
        conversations={scopedConversations}
        groups={scopedGroups}
        activeConversationId={conversationId ?? null}
        activeConversation={currentConversation}
        draftSessionParams={draftSessionParams}
        inspectorOpen={inspectorOpen}
        drawerOpen={rightDrawerOpen}
        manageMode={sidebarManageMode}
        isBusy={isBusy}
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
              navigate(`/chat/${encodeURIComponent(next.id)}`, {
                replace: true,
              });
            } else {
              clearSession();
              navigate(
                `/chat?assistant=${encodeURIComponent(activeAssistant.id)}`,
                { replace: true },
              );
            }
          }
        }}
        onSaveDraftSessionParams={setDraftSessionParams}
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
            setSearchParams({ assistant: saved.id }, { replace: true });
          }
        }}
        onDeleted={(deletedId) => {
          if (selectedAssistantId === deletedId) {
            const fallback =
              assistants.find((a) => a.id !== deletedId)?.id ?? 'default';
            setSelectedAssistantId(fallback);
            clearSession();
            navigate(`/chat?assistant=${encodeURIComponent(fallback)}`, {
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
