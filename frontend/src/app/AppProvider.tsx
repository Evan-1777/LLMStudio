import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getDesktopBootstrap } from '../core/desktop';
import { GatewayClient, GatewayError, validateGatewayUrl } from '../core/gateway';
import {
  loadConnectionSettings,
  loadSettings,
  normalizeServerPreferences,
  type AppPreferences,
  type AppSettings,
  type SettingsSaveResult,
} from '../core/settings';
import type {
  Assistant,
  BatchTransferResult,
  CloudConnectionState,
  Conversation,
  ConversationGroup,
  ConversationTransferResult,
  DeletedConversation,
  DesktopStatus,
  FormatInfo,
  HealthResponse,
  MCPServerConfig,
  ProviderAdapterInfo,
  ProviderConfig,
  SearchEngineView,
  TopicScope,
} from '../core/types';
import { ConfirmDialog } from '../components/ui/Modal';
import {
  useCustomFontManager,
  type CustomFontInfo,
} from './useCustomFontManager';
import { usePreferencesManager } from './usePreferencesManager';
import {
  useToastAndDirtyGuard,
  type ToastOptions,
} from './useToastAndDirtyGuard';

export type { CustomFontInfo } from './useCustomFontManager';

export type ConnectionState = 'checking' | 'connected' | 'auth-required' | 'error';

export interface AppResources {
  providers: ProviderConfig[];
  formats: FormatInfo[];
  adapters: ProviderAdapterInfo[];
  assistants: Assistant[];
  conversations: Conversation[];
  conversationGroups: ConversationGroup[];
  localConversations: Conversation[];
  localConversationGroups: ConversationGroup[];
  cloudConversations: Conversation[];
  cloudConversationGroups: ConversationGroup[];
  searchEngines: SearchEngineView[];
  mcpServers: MCPServerConfig[];
  localMcpServers: MCPServerConfig[];
  cloudMcpServers: MCPServerConfig[];
  loading: {
    providers: boolean;
    assistants: boolean;
    conversations: boolean;
    plugins: boolean;
  };
  error: {
    providers: string | null;
    assistants: string | null;
    conversations: string | null;
    plugins: string | null;
  };
}

export interface AppContextValue {
  gateway: GatewayClient;
  isDesktop: boolean;
  desktopStatus: DesktopStatus | null;
  cloudConnectionState: CloudConnectionState;
  topicScope: TopicScope;
  setTopicScope: (scope: TopicScope) => void;
  refreshDesktopStatus: () => Promise<DesktopStatus | null>;
  disconnectDesktopCloud: () => Promise<DesktopStatus | null>;
  uploadConversations: (
    ids: string[],
    force?: boolean,
  ) => Promise<ConversationTransferResult | BatchTransferResult>;
  pullConversations: (
    ids: string[],
    force?: boolean,
  ) => Promise<ConversationTransferResult | BatchTransferResult>;
  cleanupLocalUngrouped: () => Promise<DeletedConversation[] | null>;
  connectionEpoch: number;
  settings: AppSettings;
  customFont: CustomFontInfo | null;
  legacyCustomFont: { name: string } | null;
  customFontBusy: boolean;
  uploadCustomFont: (file: File) => Promise<{ ok: boolean; error?: string }>;
  toggleCustomFont: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  removeCustomFont: () => Promise<{ ok: boolean; error?: string }>;
  importLegacyCustomFont: () => Promise<{ ok: boolean; error?: string }>;
  resolvedTheme: 'light' | 'dark';
  settingsNotice: string | null;
  dismissSettingsNotice: () => void;
  updateSettings: (
    patchOrUpdater:
      | Partial<AppSettings>
      | ((prev: AppSettings) => AppSettings),
  ) => SettingsSaveResult;
  updatePreferences: (
    patch: Partial<AppPreferences>,
  ) => Promise<{ ok: boolean; error?: string }>;
  connectionState: ConnectionState;
  connectionError: string | null;
  gatewayHealth: HealthResponse | null;
  saveConnection: (input: {
    gatewayBaseUrl: string;
    accessToken: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  testGatewayConnection: (input?: {
    gatewayBaseUrl?: string;
    accessToken?: string;
  }) => Promise<{
    ok: boolean;
    health?: HealthResponse;
    latencyMs?: number;
    error?: string;
  }>;
  retryConnection: () => void;
  resources: AppResources;
  refreshProviders: () => Promise<boolean>;
  reorderProviders: (id: string, beforeId: string | null) => Promise<void>;
  refreshAssistants: () => Promise<boolean>;
  refreshConversations: (scope?: TopicScope) => Promise<Conversation[] | null>;
  refreshPlugins: (scope?: TopicScope) => Promise<boolean>;
  refreshPreferences: () => Promise<boolean>;
  refreshAll: () => Promise<void>;
  syncFromServer: () => Promise<{
    ok: boolean;
    conversations?: Conversation[];
    error?: string;
  }>;
  lastSyncedAt: string | null;
  syncingServer: boolean;
  runningConversationIds: ReadonlySet<string>;
  markConversationRunning: (
    conversationId: string,
    running: boolean,
    scope?: TopicScope,
  ) => void;
  upsertLocalConversation: (conv: Conversation, scope?: TopicScope) => void;
  removeLocalConversation: (id: string, scope?: TopicScope) => void;
  cleanupUngroupedConversations: (
    scope?: TopicScope,
  ) => Promise<DeletedConversation[] | null>;
  applyConversationOrganizationSnapshot: (
    assistantId: string,
    snapshot: { conversations: Conversation[]; groups: ConversationGroup[] },
    expectedEpoch?: number,
    scope?: TopicScope,
  ) => void;
  upsertLocalAssistant: (assistant: Assistant) => void;
  removeLocalAssistant: (id: string) => void;
  upsertLocalProvider: (provider: ProviderConfig) => void;
  removeLocalProvider: (id: string) => void;
  upsertLocalSearchEngine: (engine: SearchEngineView) => void;
  upsertLocalMcpServer: (server: MCPServerConfig, scope?: TopicScope) => void;
  removeLocalMcpServer: (id: string, scope?: TopicScope) => void;
  toast: (message: string, toneOrOptions?: ToastOptions) => void;
  registerDirtyGuard: (guard: (() => boolean) | null) => void;
  confirmLeaveIfDirty: () => Promise<boolean>;
}

const AppContext = createContext<AppContextValue | null>(null);

function emptyResources(): AppResources {
  return {
    providers: [],
    formats: [],
    adapters: [],
    assistants: [],
    conversations: [],
    conversationGroups: [],
    localConversations: [],
    localConversationGroups: [],
    cloudConversations: [],
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
  };
}

function normalizeCloudState(raw: string | undefined): CloudConnectionState {
  switch (raw) {
    case 'connected':
    case 'checking':
    case 'auth-required':
    case 'error':
    case 'disconnected':
      return raw;
    default:
      return 'disconnected';
  }
}

export function sortConversationsByOrg(
  conversations: readonly Conversation[],
  groups: readonly ConversationGroup[],
): Conversation[] {
  const groupById = new Map<string, ConversationGroup>();
  for (const g of groups) {
    groupById.set(g.id, g);
  }
  return [...conversations].sort((a, b) => {
    const aPinned = Boolean(a.pinned);
    const bPinned = Boolean(b.pinned);
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    if (!aPinned) {
      const gA = a.groupId ? groupById.get(a.groupId) : undefined;
      const gB = b.groupId ? groupById.get(b.groupId) : undefined;
      if (Boolean(gA) !== Boolean(gB)) {
        return gA ? -1 : 1;
      }
      if (gA && gB && gA.id !== gB.id) {
        if (gA.sortOrder !== gB.sortOrder) {
          return gA.sortOrder - gB.sortOrder;
        }
        const createdCmp = gA.createdAt.localeCompare(gB.createdAt);
        if (createdCmp !== 0) return createdCmp;
        return gA.id.localeCompare(gB.id);
      }
    }
    if (a.sortOrder !== undefined || b.sortOrder !== undefined) {
      const diff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    }
    return 0;
  });
}
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function errorMessageOf(err: unknown): string {
  if (err instanceof GatewayError) return err.message;
  if (err instanceof Error) return err.message;
  return '操作失败';
}

export function AppProvider({
  children,
  fetchImpl,
  skipInitialBootstrap = false,
}: {
  children: ReactNode;
  fetchImpl?: typeof fetch;
  skipInitialBootstrap?: boolean;
}) {
  const desktopBootstrap = useMemo(() => getDesktopBootstrap(), []);
  const isDesktop = desktopBootstrap !== null;

  const initialLoad = useMemo(() => {
    const loaded = loadSettings();
    if (desktopBootstrap) {
      return {
        ...loaded,
        settings: {
          ...loaded.settings,
          gatewayBaseUrl: desktopBootstrap.apiBaseUrl,
          accessToken: desktopBootstrap.sessionToken,
        },
      };
    }
    // Connection info lives in its own key so the workspace can reconnect after
    // a reload without re-entering the gateway token.
    const connection = loadConnectionSettings();
    return {
      ...loaded,
      settings: { ...loaded.settings, ...connection },
    };
  }, [desktopBootstrap]);

  const [connectionEpoch, setConnectionEpoch] = useState(1);
  const epochRef = useRef(1);
  const activeControllersRef = useRef<Set<AbortController>>(new Set());

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    isDesktop || skipInitialBootstrap ? 'connected' : 'checking',
  );
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null);
  const [cloudConnectionState, setCloudConnectionState] =
    useState<CloudConnectionState>(isDesktop ? 'checking' : 'disconnected');
  const cloudStateRef = useRef<CloudConnectionState>(
    isDesktop ? 'checking' : 'disconnected',
  );
  cloudStateRef.current = cloudConnectionState;

  const updateCloudConnectionState = useCallback((next: CloudConnectionState) => {
    cloudStateRef.current = next;
    setCloudConnectionState(next);
  }, []);

  const [topicScope, setTopicScopeState] = useState<TopicScope>(
    isDesktop ? 'local' : 'cloud',
  );
  const topicScopeRef = useRef<TopicScope>(isDesktop ? 'local' : 'cloud');
  topicScopeRef.current = topicScope;

  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [gatewayHealth, setGatewayHealth] = useState<HealthResponse | null>(
    null,
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncingServer, setSyncingServer] = useState(false);
  const syncInFlightRef = useRef(false);
  const lastRefreshErrorRef = useRef<string | null>(null);
  const [resources, setResources] = useState<AppResources>(emptyResources);

  const gatewayRef = useRef<GatewayClient | null>(null);
  if (!gatewayRef.current) {
    gatewayRef.current = new GatewayClient({
      baseUrl: desktopBootstrap?.apiBaseUrl ?? initialLoad.settings.gatewayBaseUrl,
      accessToken: desktopBootstrap?.sessionToken ?? initialLoad.settings.accessToken,
      fetchImpl,
    });
  }
  const gateway = gatewayRef.current;

  const {
    settings,
    settingsRef,
    settingsNotice,
    dismissSettingsNotice,
    resolvedTheme,
    updateSettings,
    applyConfirmedPreferences,
    hydratePreferences,
    updatePreferences,
  } = usePreferencesManager({
    initialSettings: initialLoad.settings,
    initialNotice: initialLoad.notice,
    isDesktop,
    gateway,
    epochRef,
  });

  const {
    customFont,
    legacyCustomFont,
    customFontBusy,
    resetCustomFontRuntime,
    syncCustomFontForTarget,
    uploadCustomFont,
    toggleCustomFont,
    removeCustomFont,
    importLegacyCustomFont,
  } = useCustomFontManager({
    gateway,
    skipInitialBootstrap,
  });

  const {
    toastState,
    toast,
    dismissToast,
    discardPromptResolver,
    setDiscardPromptResolver,
    registerDirtyGuard,
    confirmLeaveIfDirty,
  } = useToastAndDirtyGuard();

  useEffect(() => {
    if (desktopBootstrap) {
      document.documentElement.dataset.desktop = 'true';
      return () => {
        delete document.documentElement.dataset.desktop;
      };
    }
    delete document.documentElement.dataset.desktop;
    return undefined;
  }, [desktopBootstrap]);

  useEffect(() => {
    return () => {
      for (const ctrl of activeControllersRef.current) {
        ctrl.abort();
      }
      activeControllersRef.current.clear();
    };
  }, []);

  const trackSignal = useCallback((): {
    epoch: number;
    signal: AbortSignal;
    cleanup: () => void;
  } => {
    const ctrl = new AbortController();
    activeControllersRef.current.add(ctrl);
    return {
      epoch: epochRef.current,
      signal: ctrl.signal,
      cleanup: () => activeControllersRef.current.delete(ctrl),
    };
  }, []);

  const handleAuthFailureIf401 = useCallback(
    (err: unknown, epoch: number) => {
      if (epoch !== epochRef.current) return false;
      if (err instanceof GatewayError && err.statusCode === 401) {
        if (isDesktop) {
          updateCloudConnectionState('auth-required');
          return true;
        }
        setConnectionState('auth-required');
        setConnectionError(err.message || '访问令牌无效或未授权');
        return true;
      }
      return false;
    },
    [isDesktop, updateCloudConnectionState],
  );

  const providerOrderRevision = useRef(0);
  const providerReorderEpoch = useRef<number | null>(null);
  const refreshProviders = useCallback(async (): Promise<boolean> => {
    const { epoch, signal, cleanup } = trackSignal();
    const orderRevision = providerOrderRevision.current;
    setResources((prev) => ({
      ...prev,
      loading: { ...prev.loading, providers: true },
      error: { ...prev.error, providers: null },
    }));
    try {
      const [meta, providers] = await Promise.all([
        gateway.listFormatsAndAdapters(signal),
        gateway.listProviders(signal),
      ]);
      if (epoch !== epochRef.current) return false;
      setResources((prev) => ({
        ...prev,
        formats: meta.formats,
        adapters: meta.adapters,
        providers: orderRevision === providerOrderRevision.current ? providers : prev.providers,
        loading: { ...prev.loading, providers: false },
      }));
      return true;
    } catch (err) {
      if (epoch !== epochRef.current) return false;
      if (isAbortError(err)) return false;
      handleAuthFailureIf401(err, epoch);
      const message = errorMessageOf(err);
      lastRefreshErrorRef.current = message;
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, providers: false },
        error: { ...prev.error, providers: message },
      }));
      return false;
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const refreshAssistants = useCallback(async (): Promise<boolean> => {
    const { epoch, signal, cleanup } = trackSignal();
    setResources((prev) => ({
      ...prev,
      loading: { ...prev.loading, assistants: true },
      error: { ...prev.error, assistants: null },
    }));
    try {
      const assistants = await gateway.listAssistants(signal);
      if (epoch !== epochRef.current) return false;
      setResources((prev) => ({
        ...prev,
        assistants,
        loading: { ...prev.loading, assistants: false },
      }));
      return true;
    } catch (err) {
      if (epoch !== epochRef.current) return false;
      if (isAbortError(err)) return false;
      handleAuthFailureIf401(err, epoch);
      const message = errorMessageOf(err);
      lastRefreshErrorRef.current = message;
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, assistants: false },
        error: { ...prev.error, assistants: message },
      }));
      return false;
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const [runningByScope, setRunningByScope] = useState<{
    local: ReadonlySet<string>;
    cloud: ReadonlySet<string>;
  }>(() => ({
    local: new Set(),
    cloud: new Set(),
  }));

  const runningConversationIds = useMemo<ReadonlySet<string>>(
    () => (isDesktop && topicScope === 'local' ? runningByScope.local : runningByScope.cloud),
    [isDesktop, runningByScope, topicScope],
  );

  const replaceRunningScope = useCallback(
    (bucket: TopicScope, ids: Iterable<string>) => {
      const next = new Set(ids);
      setRunningByScope((prev) => {
        const cur = prev[bucket];
        if (cur.size === next.size && Array.from(next).every((id) => cur.has(id))) {
          return prev;
        }
        return { ...prev, [bucket]: next };
      });
    },
    [],
  );

  const markConversationRunning = useCallback(
    (conversationId: string, running: boolean, explicitScope?: TopicScope) => {
      if (!conversationId) return;
      const bucket: TopicScope = isDesktop
        ? (explicitScope ?? topicScopeRef.current)
        : 'cloud';
      setRunningByScope((prev) => {
        const cur = prev[bucket];
        const has = cur.has(conversationId);
        if (has === running) return prev;
        const next = new Set(cur);
        if (running) {
          next.add(conversationId);
        } else {
          next.delete(conversationId);
        }
        return { ...prev, [bucket]: next };
      });
    },
    [isDesktop],
  );

  const conversationCleanupRevision = useRef(0);
  const refreshConversations = useCallback(
    async (explicitScope?: TopicScope): Promise<Conversation[] | null> => {
      const effectiveScope: TopicScope | undefined = isDesktop
        ? (explicitScope ?? topicScopeRef.current)
        : undefined;
      const targetBucket: TopicScope = effectiveScope ?? 'cloud';
      const { epoch, signal, cleanup } = trackSignal();
      const cleanupRevision = conversationCleanupRevision.current;
      const affectsActive = !isDesktop || targetBucket === topicScopeRef.current;
      if (affectsActive) {
        setResources((prev) => ({
          ...prev,
          loading: { ...prev.loading, conversations: true },
          error: { ...prev.error, conversations: null },
        }));
      }
      try {
        const [conversations, conversationGroups] = await Promise.all([
          gateway.listConversations(signal, effectiveScope),
          gateway.listConversationGroups(undefined, signal, effectiveScope),
        ]);
        if (epoch !== epochRef.current) return null;
        const preserveList = cleanupRevision !== conversationCleanupRevision.current;
        setResources((prev) => {
          const prevBucketList =
            targetBucket === 'local' ? prev.localConversations : prev.cloudConversations;
          const nextBucketList = preserveList ? prevBucketList : conversations;
          const nextLocalConvs =
            targetBucket === 'local' ? nextBucketList : prev.localConversations;
          const nextLocalGroups =
            targetBucket === 'local' ? conversationGroups : prev.localConversationGroups;
          const nextCloudConvs =
            targetBucket === 'cloud' ? nextBucketList : prev.cloudConversations;
          const nextCloudGroups =
            targetBucket === 'cloud' ? conversationGroups : prev.cloudConversationGroups;
          const activeScopeNow = isDesktop ? topicScopeRef.current : 'cloud';
          return {
            ...prev,
            localConversations: nextLocalConvs,
            localConversationGroups: nextLocalGroups,
            cloudConversations: nextCloudConvs,
            cloudConversationGroups: nextCloudGroups,
            conversations:
              activeScopeNow === 'local' ? nextLocalConvs : nextCloudConvs,
            conversationGroups:
              activeScopeNow === 'local' ? nextLocalGroups : nextCloudGroups,
            loading: affectsActive
              ? { ...prev.loading, conversations: false }
              : prev.loading,
          };
        });
        if (!preserveList) {
          replaceRunningScope(
            targetBucket,
            conversations.filter((c) => Boolean(c.running)).map((c) => c.id),
          );
        }
        return conversations;
      } catch (err) {
        if (epoch !== epochRef.current) return null;
        if (isAbortError(err)) return null;
        handleAuthFailureIf401(err, epoch);
        const message = errorMessageOf(err);
        lastRefreshErrorRef.current = message;
        if (affectsActive) {
          setResources((prev) => ({
            ...prev,
            loading: { ...prev.loading, conversations: false },
            error: { ...prev.error, conversations: message },
          }));
        }
        return null;
      } finally {
        cleanup();
      }
    },
    [gateway, handleAuthFailureIf401, isDesktop, trackSignal],
  );

  const refreshPlugins = useCallback(
    async (explicitScope?: TopicScope): Promise<boolean> => {
      const { epoch, signal, cleanup } = trackSignal();
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, plugins: true },
        error: { ...prev.error, plugins: null },
      }));
      try {
        if (!isDesktop) {
          const [searchEngines, mcpServers] = await Promise.all([
            gateway.listSearchEngines(signal),
            gateway.listMcpServers(signal),
          ]);
          if (epoch !== epochRef.current) return false;
          setResources((prev) => ({
            ...prev,
            searchEngines,
            mcpServers,
            cloudMcpServers: mcpServers,
            loading: { ...prev.loading, plugins: false },
          }));
          return true;
        }

        const shouldFetchCloud =
          explicitScope === 'cloud' || cloudStateRef.current === 'connected';
        const [searchEngines, localMcpServers, cloudMcpServers] = await Promise.all([
          gateway.listSearchEngines(signal),
          gateway.listMcpServers(signal, 'local'),
          shouldFetchCloud
            ? gateway.listMcpServers(signal, 'cloud').catch((err) => {
                if (err instanceof GatewayError && err.statusCode === 401) {
                  updateCloudConnectionState('auth-required');
                }
                return null;
              })
            : Promise.resolve(null),
        ]);
        if (epoch !== epochRef.current) return false;
        setResources((prev) => ({
          ...prev,
          searchEngines,
          localMcpServers,
          mcpServers: localMcpServers,
          cloudMcpServers: cloudMcpServers ?? prev.cloudMcpServers,
          loading: { ...prev.loading, plugins: false },
        }));
        return true;
      } catch (err) {
        if (epoch !== epochRef.current) return false;
        if (err instanceof DOMException && err.name === 'AbortError') return false;
        if (err instanceof Error && err.name === 'AbortError') return false;
        handleAuthFailureIf401(err, epoch);
        const message = errorMessageOf(err);
        lastRefreshErrorRef.current = message;
        setResources((prev) => ({
          ...prev,
          loading: { ...prev.loading, plugins: false },
          error: { ...prev.error, plugins: message },
        }));
        return false;
      } finally {
        cleanup();
      }
    },
    [gateway, handleAuthFailureIf401, isDesktop, trackSignal, updateCloudConnectionState],
  );

  const refreshPreferences = useCallback(async (): Promise<boolean> => {
    const connectionGateway = settingsRef.current.gatewayBaseUrl;
    const { epoch, signal, cleanup } = trackSignal();
    try {
      const envelope = await gateway.getPreferences(signal);
      if (epoch !== epochRef.current) return false;
      if (connectionGateway !== settingsRef.current.gatewayBaseUrl) return false;
      if (envelope.initialized) {
        applyConfirmedPreferences(normalizeServerPreferences(envelope.preferences));
      }
      return true;
    } catch (err) {
      if (epoch !== epochRef.current) return false;
      if (isAbortError(err)) return false;
      handleAuthFailureIf401(err, epoch);
      lastRefreshErrorRef.current = errorMessageOf(err);
      return false;
    } finally {
      cleanup();
    }
  }, [applyConfirmedPreferences, gateway, handleAuthFailureIf401, trackSignal]);

  const refreshDesktopStatus = useCallback(async (): Promise<DesktopStatus | null> => {
    if (!isDesktop) return null;
    const { epoch, signal, cleanup } = trackSignal();
    try {
      const status = await gateway.getDesktopStatus(signal);
      if (epoch !== epochRef.current) return null;
      setDesktopStatus(status);
      updateCloudConnectionState(normalizeCloudState(status.cloudState));
      setGatewayHealth({
        status: 'ok',
        version: status.version || desktopBootstrap?.version || '1.5.0',
        authRequired: false,
      });
      return status;
    } catch {
      if (epoch !== epochRef.current) return null;
      updateCloudConnectionState('error');
      return null;
    } finally {
      cleanup();
    }
  }, [desktopBootstrap?.version, gateway, isDesktop, trackSignal, updateCloudConnectionState]);

  const refreshAll = useCallback(async () => {
    if (!isDesktop) {
      await Promise.all([
        refreshProviders(),
        refreshAssistants(),
        refreshConversations(),
        refreshPlugins(),
      ]);
      return;
    }
    const status = await refreshDesktopStatus();
    const tasks: Promise<unknown>[] = [
      refreshProviders(),
      refreshAssistants(),
      refreshConversations('local'),
      refreshPlugins(),
    ];
    if (status?.cloudState === 'connected') {
      tasks.push(refreshConversations('cloud'));
    }
    await Promise.all(tasks);
  }, [
    isDesktop,
    refreshAssistants,
    refreshConversations,
    refreshDesktopStatus,
    refreshPlugins,
    refreshProviders,
  ]);

  const syncFromServer = useCallback(async (): Promise<{
    ok: boolean;
    conversations?: Conversation[];
    error?: string;
  }> => {
    if (syncInFlightRef.current) {
      return { ok: false, error: '正在同步中' };
    }
    syncInFlightRef.current = true;
    setSyncingServer(true);
    lastRefreshErrorRef.current = null;
    const startEpoch = epochRef.current;
    try {
      if (isDesktop) {
        const status = await refreshDesktopStatus();
        const activeScopeNow = topicScopeRef.current;
        const [provOk, asstOk, localConvs, cloudConvs, pluginsOk, prefsOk] =
          await Promise.all([
            refreshProviders(),
            refreshAssistants(),
            refreshConversations('local'),
            status?.cloudState === 'connected'
              ? refreshConversations('cloud')
              : Promise.resolve(null),
            refreshPlugins(),
            refreshPreferences(),
            syncCustomFontForTarget(
              status?.gatewayBaseUrl || null,
              normalizeCloudState(status?.cloudState),
            ),
          ]);
        if (startEpoch !== epochRef.current) {
          return { ok: false, error: '连接已切换' };
        }
        const activeConvs = activeScopeNow === 'local' ? localConvs : cloudConvs;
        if (!provOk || !asstOk || localConvs === null || !pluginsOk || !prefsOk) {
          return {
            ok: false,
            error: lastRefreshErrorRef.current || '同步数据失败',
          };
        }
        setLastSyncedAt(new Date().toISOString());
        return { ok: true, conversations: activeConvs ?? localConvs };
      }

      const [provOk, asstOk, convs, pluginsOk, prefsOk] = await Promise.all([
        refreshProviders(),
        refreshAssistants(),
        refreshConversations(),
        refreshPlugins(),
        refreshPreferences(),
        syncCustomFontForTarget(settingsRef.current.gatewayBaseUrl, 'connected'),
      ]);
      if (startEpoch !== epochRef.current) {
        return { ok: false, error: '连接已切换' };
      }
      if (!provOk || !asstOk || convs === null || !pluginsOk || !prefsOk) {
        return {
          ok: false,
          error: lastRefreshErrorRef.current || '同步服务端数据失败',
        };
      }
      setLastSyncedAt(new Date().toISOString());
      return { ok: true, conversations: convs };
    } finally {
      syncInFlightRef.current = false;
      setSyncingServer(false);
    }
  }, [
    isDesktop,
    refreshAssistants,
    refreshConversations,
    refreshDesktopStatus,
    refreshPlugins,
    refreshPreferences,
    refreshProviders,
    syncCustomFontForTarget,
  ]);

  const bootstrapConnection = useCallback(
    async (baseUrl: string, accessToken: string) => {
      for (const ctrl of activeControllersRef.current) {
        ctrl.abort();
      }
      activeControllersRef.current.clear();
      resetCustomFontRuntime();

      const nextEpoch = epochRef.current + 1;
      epochRef.current = nextEpoch;
      setConnectionEpoch(nextEpoch);

      if (desktopBootstrap) {
        gateway.baseUrl = desktopBootstrap.apiBaseUrl;
        gateway.accessToken = desktopBootstrap.sessionToken;

        setResources(emptyResources());
        setConnectionState('connected');
        setConnectionError(null);
        updateCloudConnectionState('checking');
        setLastSyncedAt(null);

        const { signal, cleanup } = trackSignal();
        try {
          let status: DesktopStatus | null = null;
          let statusFailed = false;
          try {
            status = await gateway.getDesktopStatus(signal);
          } catch (err) {
            if (nextEpoch !== epochRef.current) return;
            if (isAbortError(err)) return;
            statusFailed = true;
          }
          if (nextEpoch !== epochRef.current) return;
          if (status) {
            setDesktopStatus(status);
            updateCloudConnectionState(normalizeCloudState(status.cloudState));
            setGatewayHealth({
              status: 'ok',
              version: status.version || desktopBootstrap.version,
              authRequired: false,
            });
          } else {
            updateCloudConnectionState(statusFailed ? 'error' : 'disconnected');
            setGatewayHealth({
              status: 'ok',
              version: desktopBootstrap.version,
              authRequired: false,
            });
          }

          const cloudReady = status?.cloudState === 'connected';
          const fontTargetUrl = status?.gatewayBaseUrl || null;
          const fontCloudState = status
            ? normalizeCloudState(status.cloudState)
            : statusFailed
              ? 'error'
              : 'disconnected';
          const [, provOk, asstOk, localConvs, , pluginsOk] = await Promise.all([
            hydratePreferences(signal, nextEpoch).catch(() => {}),
            refreshProviders(),
            refreshAssistants(),
            refreshConversations('local'),
            cloudReady ? refreshConversations('cloud') : Promise.resolve(null),
            refreshPlugins(cloudReady ? 'cloud' : 'local'),
            syncCustomFontForTarget(fontTargetUrl, fontCloudState),
          ]);
          if (
            nextEpoch === epochRef.current &&
            provOk &&
            asstOk &&
            localConvs !== null &&
            pluginsOk
          ) {
            setLastSyncedAt(new Date().toISOString());
          }
        } finally {
          cleanup();
        }
        return;
      }

      gateway.baseUrl = baseUrl;
      gateway.accessToken = accessToken;

      setResources(emptyResources());
      setConnectionState('checking');
      setConnectionError(null);
      setLastSyncedAt(null);

      const { signal, cleanup } = trackSignal();
      try {
        const health = await gateway.healthCheck(signal);
        if (nextEpoch !== epochRef.current) return;
        setGatewayHealth(health);

        if (health.authRequired && !accessToken.trim()) {
          setConnectionState('auth-required');
          setConnectionError(null);
          return;
        }

        // Preferences are part of the authenticated handshake: the workspace stays
        // gated until the authoritative values are applied.
        await hydratePreferences(signal, nextEpoch);
        if (nextEpoch !== epochRef.current) return;

        setConnectionState('connected');
        const [provOk, asstOk, convs, pluginsOk] = await Promise.all([
          refreshProviders(),
          refreshAssistants(),
          refreshConversations(),
          refreshPlugins(),
          syncCustomFontForTarget(baseUrl, 'connected'),
        ]);
        if (
          nextEpoch === epochRef.current &&
          provOk &&
          asstOk &&
          convs !== null &&
          pluginsOk
        ) {
          setLastSyncedAt(new Date().toISOString());
        }
      } catch (err) {
        if (nextEpoch !== epochRef.current) return;
        if (isAbortError(err)) return;
        // Any 401 during the handshake (preferences included) means the token is rejected.
        if (handleAuthFailureIf401(err, nextEpoch)) return;
        setGatewayHealth(null);
        setConnectionState('error');
        setConnectionError(errorMessageOf(err));
      } finally {
        cleanup();
      }
    },
    [
      desktopBootstrap,
      gateway,
      handleAuthFailureIf401,
      hydratePreferences,
      refreshAssistants,
      refreshConversations,
      refreshPlugins,
      refreshProviders,
      resetCustomFontRuntime,
      syncCustomFontForTarget,
      trackSignal,
      updateCloudConnectionState,
    ],
  );

  useEffect(() => {
    if (skipInitialBootstrap) return;
    void bootstrapConnection(settings.gatewayBaseUrl, settings.accessToken);
    // Run only once on mount; explicit gateway switches call saveConnection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveConnection = useCallback(
    async (input: { gatewayBaseUrl: string; accessToken: string }) => {
      if (isDesktop) {
        const trimmedUrl = input.gatewayBaseUrl.trim();
        if (!trimmedUrl || trimmedUrl === '/') {
          return { ok: false, error: '请输入完整的云端网关地址（如 https://example.com）' };
        }
        const urlErr = validateGatewayUrl(trimmedUrl);
        if (urlErr) {
          return { ok: false, error: urlErr };
        }
        try {
          const saved = await gateway.saveDesktopConnection({
            gatewayBaseUrl: trimmedUrl,
            accessToken: input.accessToken.trim(),
          });
          setDesktopStatus(saved.status);
          const nextCloudState = normalizeCloudState(saved.status.cloudState);
          updateCloudConnectionState(nextCloudState);
          const epoch = epochRef.current;
          void refreshAll();
          void syncCustomFontForTarget(
            saved.status.gatewayBaseUrl || null,
            nextCloudState,
          );
          if (nextCloudState === 'connected') {
            const { signal, cleanup } = trackSignal();
            void hydratePreferences(signal, epoch)
              .catch(() => {})
              .finally(cleanup);
          }
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorMessageOf(err) };
        }
      }

      const normalizedUrl = input.gatewayBaseUrl.trim() || '/';
      const urlErr = validateGatewayUrl(normalizedUrl);
      if (urlErr) {
        return { ok: false, error: urlErr };
      }
      const nextToken = input.accessToken.trim();
      updateSettings({
        gatewayBaseUrl: normalizedUrl,
        accessToken: nextToken,
      });
      await bootstrapConnection(normalizedUrl, nextToken);
      return { ok: true };
    },
    [
      bootstrapConnection,
      gateway,
      hydratePreferences,
      isDesktop,
      refreshAll,
      syncCustomFontForTarget,
      trackSignal,
      updateCloudConnectionState,
      updateSettings,
    ],
  );

  const testGatewayConnection = useCallback(
    async (input?: { gatewayBaseUrl?: string; accessToken?: string }) => {
      if (isDesktop) {
        const rawUrl = (input?.gatewayBaseUrl ?? desktopStatus?.gatewayBaseUrl ?? '').trim();
        if (!rawUrl || rawUrl === '/') {
          return { ok: false, error: '请输入完整的云端网关地址（如 https://example.com）' };
        }
        const urlErr = validateGatewayUrl(rawUrl);
        if (urlErr) {
          return { ok: false, error: urlErr };
        }
        try {
          const res = await gateway.testDesktopConnection({
            gatewayBaseUrl: rawUrl,
            accessToken: (input?.accessToken ?? '').trim(),
          });
          if (!res.ok) {
            return {
              ok: false,
              error: res.message || (res.authRequired ? '网关需要访问令牌' : '连接失败'),
            };
          }
          return { ok: true, latencyMs: res.latencyMs };
        } catch (err) {
          return { ok: false, error: errorMessageOf(err) };
        }
      }

      const url = (input?.gatewayBaseUrl ?? settings.gatewayBaseUrl).trim() || '/';
      const urlErr = validateGatewayUrl(url);
      if (urlErr) {
        return { ok: false, error: urlErr };
      }
      const token = (input?.accessToken ?? settings.accessToken).trim();
      const probeClient = new GatewayClient({
        baseUrl: url,
        accessToken: token,
        fetchImpl,
      });
      const started = performance.now();
      try {
        const health = await probeClient.healthCheck();
        if (health.authRequired && !token) {
          return {
            ok: false,
            health,
            error: '网关需要访问令牌',
          };
        }
        if (health.authRequired || token) {
          await probeClient.listFormatsAndAdapters();
        }
        const latencyMs = Math.max(1, Math.round(performance.now() - started));
        return { ok: true, health, latencyMs };
      } catch (err) {
        return { ok: false, error: errorMessageOf(err) };
      }
    },
    [
      desktopStatus?.gatewayBaseUrl,
      fetchImpl,
      gateway,
      isDesktop,
      settings.accessToken,
      settings.gatewayBaseUrl,
    ],
  );

  const disconnectDesktopCloud = useCallback(async (): Promise<DesktopStatus | null> => {
    if (!isDesktop) return null;
    const status = await gateway.disconnectDesktopCloud();
    setDesktopStatus(status);
    updateCloudConnectionState(normalizeCloudState(status.cloudState));
    void syncCustomFontForTarget(null, 'disconnected');
    setResources((prev) => {
      const nextActiveConvs =
        topicScopeRef.current === 'local' ? prev.localConversations : [];
      const nextActiveGroups =
        topicScopeRef.current === 'local' ? prev.localConversationGroups : [];
      return {
        ...prev,
        cloudConversations: [],
        cloudConversationGroups: [],
        cloudMcpServers: [],
        conversations: nextActiveConvs,
        conversationGroups: nextActiveGroups,
      };
    });
    return status;
  }, [gateway, isDesktop, syncCustomFontForTarget, updateCloudConnectionState]);

  const retryConnection = useCallback(() => {
    void bootstrapConnection(settings.gatewayBaseUrl, settings.accessToken);
  }, [bootstrapConnection, settings.accessToken, settings.gatewayBaseUrl]);

  const setTopicScope = useCallback(
    (nextScope: TopicScope) => {
      if (!isDesktop) return;
      topicScopeRef.current = nextScope;
      setTopicScopeState(nextScope);
      setResources((prev) => ({
        ...prev,
        conversations:
          nextScope === 'local'
            ? prev.localConversations
            : prev.cloudConversations,
        conversationGroups:
          nextScope === 'local'
            ? prev.localConversationGroups
            : prev.cloudConversationGroups,
      }));
      if (nextScope === 'cloud' && cloudStateRef.current === 'connected') {
        void refreshConversations('cloud');
      }
    },
    [isDesktop, refreshConversations],
  );

  const upsertLocalConversation = useCallback(
    (conv: Conversation, explicitScope?: TopicScope) => {
      if (conv.ephemeral) return;
      const targetBucket: TopicScope = isDesktop
        ? (explicitScope ?? conv.scope ?? topicScopeRef.current)
        : 'cloud';
      setResources((prev) => {
        const currentList =
          targetBucket === 'local'
            ? prev.localConversations
            : prev.cloudConversations;
        const currentGroups =
          targetBucket === 'local'
            ? prev.localConversationGroups
            : prev.cloudConversationGroups;
        const idx = currentList.findIndex((c) => c.id === conv.id);
        const nextList = sortConversationsByOrg(
          idx >= 0
            ? currentList.map((c, i) => (i === idx ? conv : c))
            : [conv, ...currentList],
          currentGroups,
        );
        const nextLocalConvs =
          targetBucket === 'local' ? nextList : prev.localConversations;
        const nextCloudConvs =
          targetBucket === 'cloud' ? nextList : prev.cloudConversations;
        const activeScopeNow = isDesktop ? topicScopeRef.current : 'cloud';
        return {
          ...prev,
          localConversations: nextLocalConvs,
          cloudConversations: nextCloudConvs,
          conversations:
            activeScopeNow === 'local' ? nextLocalConvs : nextCloudConvs,
        };
      });
    },
    [isDesktop, markConversationRunning],
  );

  const removeLocalConversation = useCallback(
    (id: string, explicitScope?: TopicScope) => {
      const targetBucket: TopicScope = isDesktop
        ? (explicitScope ?? topicScopeRef.current)
        : 'cloud';
      markConversationRunning(id, false, targetBucket);
      setResources((prev) => {
        const nextLocalConvs =
          targetBucket === 'local'
            ? prev.localConversations.filter((c) => c.id !== id)
            : prev.localConversations;
        const nextCloudConvs =
          targetBucket === 'cloud'
            ? prev.cloudConversations.filter((c) => c.id !== id)
            : prev.cloudConversations;
        const activeScopeNow = isDesktop ? topicScopeRef.current : 'cloud';
        return {
          ...prev,
          localConversations: nextLocalConvs,
          cloudConversations: nextCloudConvs,
          conversations:
            activeScopeNow === 'local' ? nextLocalConvs : nextCloudConvs,
        };
      });
    },
    [isDesktop, markConversationRunning],
  );

  const cleanupUngroupedConversations = useCallback(
    async (explicitScope?: TopicScope) => {
      const effectiveScope = isDesktop ? (explicitScope ?? 'cloud') : undefined;
      const targetBucket: TopicScope = effectiveScope ?? 'cloud';
      const { epoch, signal, cleanup } = trackSignal();
      try {
        const deleted = await gateway.cleanupUngroupedConversations(
          signal,
          effectiveScope,
        );
        if (epoch !== epochRef.current) return null;
        if (deleted.length > 0) {
          conversationCleanupRevision.current++;
          const ids = new Set(deleted.map((item) => item.id));
          setResources((prev) => {
            const nextLocalConvs =
              targetBucket === 'local'
                ? prev.localConversations.filter((c) => !ids.has(c.id))
                : prev.localConversations;
            const nextCloudConvs =
              targetBucket === 'cloud'
                ? prev.cloudConversations.filter((c) => !ids.has(c.id))
                : prev.cloudConversations;
            const activeScopeNow = isDesktop ? topicScopeRef.current : 'cloud';
            return {
              ...prev,
              localConversations: nextLocalConvs,
              cloudConversations: nextCloudConvs,
              conversations:
                activeScopeNow === 'local' ? nextLocalConvs : nextCloudConvs,
            };
          });
        }
        return deleted;
      } catch (err) {
        if (epoch !== epochRef.current) return null;
        handleAuthFailureIf401(err, epoch);
        throw err;
      } finally {
        cleanup();
      }
    },
    [gateway, handleAuthFailureIf401, isDesktop, trackSignal],
  );

  const cleanupLocalUngrouped = useCallback(async () => {
    const { epoch, signal, cleanup } = trackSignal();
    try {
      const deleted = await gateway.cleanupLocalUngrouped(signal);
      if (epoch !== epochRef.current) return null;
      if (deleted.length > 0) {
        conversationCleanupRevision.current++;
        const ids = new Set(deleted.map((item) => item.id));
        setResources((prev) => {
          const nextLocalConvs = prev.localConversations.filter(
            (c) => !ids.has(c.id),
          );
          const activeScopeNow = isDesktop ? topicScopeRef.current : 'cloud';
          return {
            ...prev,
            localConversations: nextLocalConvs,
            conversations:
              activeScopeNow === 'local' ? nextLocalConvs : prev.cloudConversations,
          };
        });
      }
      return deleted;
    } finally {
      cleanup();
    }
  }, [gateway, isDesktop, trackSignal]);

  useEffect(() => {
    if (skipInitialBootstrap) return;
    if (connectionState !== 'connected') return;
    if (isDesktop && desktopStatus === null) return;
    const effectiveScope: TopicScope | undefined = isDesktop ? topicScope : undefined;
    const bucket: TopicScope = effectiveScope ?? 'cloud';
    if (isDesktop && bucket === 'cloud' && cloudConnectionState !== 'connected') {
      replaceRunningScope('cloud', []);
      return;
    }

    let cancelled = false;
    let inFlight: AbortController | null = null;

    const syncOnce = () => {
      if (cancelled) return;
      inFlight?.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      void gateway
        .listActiveAgentRuns(ctrl.signal, effectiveScope)
        .then((ids) => {
          if (cancelled || ctrl.signal.aborted) return;
          replaceRunningScope(bucket, ids);
        })
        .catch(() => {});
    };

    // Unconditional initial sync on mount / scope / connection change to discover runs from other clients.
    syncOnce();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncOnce();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    cloudConnectionState,
    connectionEpoch,
    connectionState,
    desktopStatus,
    gateway,
    isDesktop,
    replaceRunningScope,
    skipInitialBootstrap,
    topicScope,
  ]);

  useEffect(() => {
    if (skipInitialBootstrap) return;
    if (runningConversationIds.size === 0) return;
    if (connectionState !== 'connected') return;
    if (isDesktop && desktopStatus === null) return;
    const effectiveScope: TopicScope | undefined = isDesktop ? topicScope : undefined;
    const bucket: TopicScope = effectiveScope ?? 'cloud';
    if (isDesktop && bucket === 'cloud' && cloudConnectionState !== 'connected') return;

    let cancelled = false;
    let inFlight: AbortController | null = null;
    const timer = window.setInterval(() => {
      if (cancelled || document.visibilityState !== 'visible') return;
      inFlight?.abort();
      const ctrl = new AbortController();
      inFlight = ctrl;
      void gateway
        .listActiveAgentRuns(ctrl.signal, effectiveScope)
        .then((ids) => {
          if (cancelled || ctrl.signal.aborted) return;
          replaceRunningScope(bucket, ids);
        })
        .catch(() => {});
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      inFlight?.abort();
    };
  }, [
    cloudConnectionState,
    connectionEpoch,
    connectionState,
    desktopStatus,
    gateway,
    isDesktop,
    replaceRunningScope,
    runningConversationIds.size,
    skipInitialBootstrap,
    topicScope,
  ]);

  const applyConversationOrganizationSnapshot = useCallback(
    (
      assistantId: string,
      snapshot: { conversations: Conversation[]; groups: ConversationGroup[] },
      expectedEpoch?: number,
      explicitScope?: TopicScope,
    ) => {
      if (expectedEpoch !== undefined && expectedEpoch !== epochRef.current) return;
      const targetBucket: TopicScope = isDesktop
        ? (explicitScope ?? topicScopeRef.current)
        : 'cloud';
      setResources((prev) => {
        const curConvs =
          targetBucket === 'local'
            ? prev.localConversations
            : prev.cloudConversations;
        const curGroups =
          targetBucket === 'local'
            ? prev.localConversationGroups
            : prev.cloudConversationGroups;
        const otherConvs = curConvs.filter(
          (c) => (c.assistantId || 'default') !== assistantId,
        );
        const otherGroups = curGroups.filter(
          (g) => g.assistantId !== assistantId,
        );
        const nextGroups = [...otherGroups, ...snapshot.groups];
        const nextConvs = sortConversationsByOrg(
          [...otherConvs, ...snapshot.conversations],
          nextGroups,
        );
        const nextLocalConvs =
          targetBucket === 'local' ? nextConvs : prev.localConversations;
        const nextLocalGroups =
          targetBucket === 'local' ? nextGroups : prev.localConversationGroups;
        const nextCloudConvs =
          targetBucket === 'cloud' ? nextConvs : prev.cloudConversations;
        const nextCloudGroups =
          targetBucket === 'cloud' ? nextGroups : prev.cloudConversationGroups;
        const activeScopeNow = isDesktop ? topicScopeRef.current : 'cloud';
        return {
          ...prev,
          localConversations: nextLocalConvs,
          localConversationGroups: nextLocalGroups,
          cloudConversations: nextCloudConvs,
          cloudConversationGroups: nextCloudGroups,
          conversations:
            activeScopeNow === 'local' ? nextLocalConvs : nextCloudConvs,
          conversationGroups:
            activeScopeNow === 'local' ? nextLocalGroups : nextCloudGroups,
        };
      });
    },
    [isDesktop, markConversationRunning],
  );

  const uploadConversations = useCallback(
    async (
      ids: string[],
      force = false,
    ): Promise<ConversationTransferResult | BatchTransferResult> => {
      if (ids.length === 1) {
        const targetId = ids[0];
        const res = await gateway.uploadConversation(targetId, { force });
        upsertLocalConversation(res.conversation, 'cloud');
        setResources((prev) => {
          const syncedAt =
            res.conversation.lastSyncedAt ?? new Date().toISOString();
          const nextLocalConvs = prev.localConversations.map((c) =>
            c.id === targetId
              ? {
                  ...c,
                  syncState: 'synced',
                  syncVersion: res.conversation.syncVersion,
                  lastSyncedAt: syncedAt,
                }
              : c,
          );
          return {
            ...prev,
            localConversations: nextLocalConvs,
            conversations:
              topicScopeRef.current === 'local'
                ? nextLocalConvs
                : prev.cloudConversations,
          };
        });
        return res;
      }
      const res = await gateway.batchTransferConversations('upload', ids, {
        force,
      });
      if (res.succeeded.length > 0) {
        await Promise.all([
          refreshConversations('local'),
          refreshConversations('cloud'),
        ]);
      }
      return res;
    },
    [gateway, refreshConversations, upsertLocalConversation],
  );

  const pullConversations = useCallback(
    async (
      ids: string[],
      force = false,
    ): Promise<ConversationTransferResult | BatchTransferResult> => {
      if (ids.length === 1) {
        const res = await gateway.pullConversation(ids[0], { force });
        upsertLocalConversation(res.conversation, 'local');
        return res;
      }
      const res = await gateway.batchTransferConversations('pull', ids, {
        force,
      });
      if (res.succeeded.length > 0) {
        await refreshConversations('local');
      }
      return res;
    },
    [gateway, refreshConversations, upsertLocalConversation],
  );

  const upsertLocalAssistant = useCallback((assistant: Assistant) => {
    setResources((prev) => {
      const exists = prev.assistants.some((a) => a.id === assistant.id);
      return {
        ...prev,
        assistants: exists
          ? prev.assistants.map((a) =>
              a.id === assistant.id ? assistant : a,
            )
          : [...prev.assistants, assistant],
      };
    });
  }, []);

  const removeLocalAssistant = useCallback((id: string) => {
    setResources((prev) => ({
      ...prev,
      assistants: prev.assistants.filter((a) => a.id !== id),
    }));
  }, []);

  const reorderProviders = useCallback(async (id: string, beforeId: string | null) => {
    if (providerReorderEpoch.current === epochRef.current) return;
    const { epoch, signal, cleanup } = trackSignal();
    providerReorderEpoch.current = epoch;
    try {
      const ordered = await gateway.reorderProviders(id, beforeId, signal);
      if (epoch !== epochRef.current) return;
      providerOrderRevision.current++;
      const positions = new Map(ordered.map((p, index) => [p.id, index]));
      setResources((prev) => ({
        ...prev,
        // Apply only order; a simultaneous save or delete owns the current records.
        providers: [...prev.providers].sort((a, b) =>
          (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity),
        ),
      }));
    } catch (err) {
      if (epoch === epochRef.current && !handleAuthFailureIf401(err, epoch)) {
        toast(err instanceof Error ? err.message : '供应商排序失败', 'error');
      }
    } finally {
      cleanup();
      if (providerReorderEpoch.current === epoch) providerReorderEpoch.current = null;
    }
  }, [gateway, handleAuthFailureIf401, toast, trackSignal]);

  const upsertLocalProvider = useCallback((provider: ProviderConfig) => {
    setResources((prev) => {
      const exists = prev.providers.some((p) => p.id === provider.id);
      return {
        ...prev,
        providers: exists
          ? prev.providers.map((p) => (p.id === provider.id ? provider : p))
          : [...prev.providers, provider],
      };
    });
  }, []);

  const removeLocalProvider = useCallback((id: string) => {
    setResources((prev) => ({
      ...prev,
      providers: prev.providers.filter((p) => p.id !== id),
    }));
  }, []);

  const upsertLocalSearchEngine = useCallback((engine: SearchEngineView) => {
    setResources((prev) => {
      const exists = prev.searchEngines.some(
        (e) => e.engineId === engine.engineId,
      );
      return {
        ...prev,
        searchEngines: exists
          ? prev.searchEngines.map((e) =>
              e.engineId === engine.engineId ? engine : e,
            )
          : [...prev.searchEngines, engine],
      };
    });
  }, []);

  const upsertLocalMcpServer = useCallback(
    (server: MCPServerConfig, explicitScope?: TopicScope) => {
      const targetBucket: TopicScope = isDesktop
        ? (explicitScope ?? 'local')
        : 'cloud';
      setResources((prev) => {
        const upsertList = (list: MCPServerConfig[]) => {
          const exists = list.some((s) => s.id === server.id);
          return exists
            ? list.map((s) => (s.id === server.id ? server : s))
            : [...list, server];
        };
        if (targetBucket === 'local') {
          const nextLocal = upsertList(prev.localMcpServers);
          return {
            ...prev,
            localMcpServers: nextLocal,
            mcpServers: isDesktop ? nextLocal : prev.mcpServers,
          };
        }
        const nextCloud = upsertList(prev.cloudMcpServers);
        return {
          ...prev,
          cloudMcpServers: nextCloud,
          mcpServers: !isDesktop ? nextCloud : prev.mcpServers,
        };
      });
    },
    [isDesktop, markConversationRunning],
  );

  const removeLocalMcpServer = useCallback(
    (id: string, explicitScope?: TopicScope) => {
      const targetBucket: TopicScope = isDesktop
        ? (explicitScope ?? 'local')
        : 'cloud';
      setResources((prev) => {
        if (targetBucket === 'local') {
          const nextLocal = prev.localMcpServers.filter((s) => s.id !== id);
          return {
            ...prev,
            localMcpServers: nextLocal,
            mcpServers: isDesktop ? nextLocal : prev.mcpServers,
          };
        }
        const nextCloud = prev.cloudMcpServers.filter((s) => s.id !== id);
        return {
          ...prev,
          cloudMcpServers: nextCloud,
          mcpServers: !isDesktop ? nextCloud : prev.mcpServers,
        };
      });
    },
    [isDesktop, markConversationRunning],
  );

  const value: AppContextValue = useMemo(
    () => ({
      gateway,
      isDesktop,
      desktopStatus,
      cloudConnectionState,
      topicScope,
      setTopicScope,
      refreshDesktopStatus,
      disconnectDesktopCloud,
      uploadConversations,
      pullConversations,
      cleanupLocalUngrouped,
      connectionEpoch,
      settings,
      customFont,
      legacyCustomFont,
      customFontBusy,
      uploadCustomFont,
      toggleCustomFont,
      removeCustomFont,
      importLegacyCustomFont,
      resolvedTheme,
      settingsNotice,
      dismissSettingsNotice,
      updateSettings,
      updatePreferences,
      connectionState,
      connectionError,
      gatewayHealth,
      saveConnection,
      testGatewayConnection,
      retryConnection,
      resources,
      refreshProviders,
      reorderProviders,
      refreshAssistants,
      refreshConversations,
      refreshPlugins,
      refreshPreferences,
      refreshAll,
      syncFromServer,
      lastSyncedAt,
      syncingServer,
      runningConversationIds,
      markConversationRunning,
      upsertLocalConversation,
      removeLocalConversation,
      cleanupUngroupedConversations,
      applyConversationOrganizationSnapshot,
      upsertLocalAssistant,
      removeLocalAssistant,
      upsertLocalProvider,
      removeLocalProvider,
      upsertLocalSearchEngine,
      upsertLocalMcpServer,
      removeLocalMcpServer,
      toast,
      registerDirtyGuard,
      confirmLeaveIfDirty,
    }),
    [
      gateway, isDesktop, desktopStatus, cloudConnectionState, topicScope, setTopicScope,
      refreshDesktopStatus, disconnectDesktopCloud, uploadConversations, pullConversations,
      cleanupLocalUngrouped, connectionEpoch, settings, customFont, legacyCustomFont,
      customFontBusy, uploadCustomFont, toggleCustomFont, removeCustomFont, importLegacyCustomFont,
      resolvedTheme, settingsNotice, dismissSettingsNotice, updateSettings, updatePreferences,
      connectionState, connectionError, gatewayHealth, saveConnection, testGatewayConnection,
      retryConnection, resources, refreshProviders, reorderProviders, refreshAssistants,
      refreshConversations, refreshPlugins, refreshPreferences, refreshAll, syncFromServer,
      lastSyncedAt, syncingServer, runningConversationIds, markConversationRunning,
      upsertLocalConversation, removeLocalConversation, cleanupUngroupedConversations,
      applyConversationOrganizationSnapshot, upsertLocalAssistant, removeLocalAssistant,
      upsertLocalProvider, removeLocalProvider, upsertLocalSearchEngine, upsertLocalMcpServer,
      removeLocalMcpServer, toast, registerDirtyGuard, confirmLeaveIfDirty,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      {toastState ? (
        <div
          className={`ui-toast ${toastState.tone === 'error' ? 'ui-toast--error' : ''}`.trim()}
          role="status"
          aria-live="polite"
        >
          <span>{toastState.message}</span>
          {toastState.action ? (
            <button
              type="button"
              className="ui-toast__action"
              onClick={() => {
                const action = toastState.action;
                dismissToast();
                action?.onClick();
              }}
            >
              {toastState.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={discardPromptResolver !== null}
        onOpenChange={(open) => {
          if (!open && discardPromptResolver) {
            discardPromptResolver(false);
            setDiscardPromptResolver(null);
          }
        }}
        title="放弃未保存的更改？"
        message="当前表单存在未保存修改，离开后更改将丢失。"
        confirmLabel="放弃"
        onConfirm={() => {
          if (discardPromptResolver) {
            discardPromptResolver(true);
            setDiscardPromptResolver(null);
          }
        }}
      />
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
