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
import { GatewayClient, GatewayError, validateGatewayUrl } from '../core/gateway';
import {
  clearLegacyPreferences,
  defaultAppPreferences,
  loadConnectionSettings,
  loadSettings,
  normalizeServerPreferences,
  normalizeSettings,
  pickAppPreferences,
  readLegacyPreferences,
  resolveAccentColors,
  saveConnectionSettings,
  writeThemeHint,
  type AppPreferenceKey,
  type AppPreferences,
  type AppSettings,
  type SettingsSaveResult,
} from '../core/settings';
import type {
  Assistant,
  Conversation,
  ConversationGroup,
  DeletedConversation,
  FormatInfo,
  HealthResponse,
  MCPServerConfig,
  ProviderAdapterInfo,
  ProviderConfig,
  SearchEngineView,
  ServerPreferences,
} from '../core/types';
import { ConfirmDialog } from '../components/ui/Modal';

export type ConnectionState = 'checking' | 'connected' | 'auth-required' | 'error';

export interface AppResources {
  providers: ProviderConfig[];
  formats: FormatInfo[];
  adapters: ProviderAdapterInfo[];
  assistants: Assistant[];
  conversations: Conversation[];
  conversationGroups: ConversationGroup[];
  searchEngines: SearchEngineView[];
  mcpServers: MCPServerConfig[];
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
  connectionEpoch: number;
  settings: AppSettings;
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
  refreshProviders: () => Promise<void>;
  reorderProviders: (id: string, beforeId: string | null) => Promise<void>;
  refreshAssistants: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  refreshAll: () => Promise<void>;
  upsertLocalConversation: (conv: Conversation) => void;
  removeLocalConversation: (id: string) => void;
  cleanupUngroupedConversations: () => Promise<DeletedConversation[] | null>;
  applyConversationOrganizationSnapshot: (
    assistantId: string,
    snapshot: { conversations: Conversation[]; groups: ConversationGroup[] },
    expectedEpoch?: number,
  ) => void;
  upsertLocalAssistant: (assistant: Assistant) => void;
  removeLocalAssistant: (id: string) => void;
  upsertLocalProvider: (provider: ProviderConfig) => void;
  removeLocalProvider: (id: string) => void;
  upsertLocalSearchEngine: (engine: SearchEngineView) => void;
  upsertLocalMcpServer: (server: MCPServerConfig) => void;
  removeLocalMcpServer: (id: string) => void;
  toast: (message: string, tone?: 'default' | 'error') => void;
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
    searchEngines: [],
    mcpServers: [],
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
function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
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
  const initialLoad = useMemo(() => {
    const loaded = loadSettings();
    // Connection info lives in its own key so the workspace can reconnect after
    // a reload without re-entering the gateway token.
    const connection = loadConnectionSettings();
    return {
      ...loaded,
      settings: { ...loaded.settings, ...connection },
    };
  }, []);
  const [settings, setSettings] = useState<AppSettings>(initialLoad.settings);
  const settingsRef = useRef<AppSettings>(initialLoad.settings);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(
    initialLoad.notice,
  );
  const [systemDark, setSystemDark] = useState<boolean>(getSystemPrefersDark);
  // Latest values confirmed by the gateway; failed writes roll back to this
  // snapshot. Each write applies and rolls back only the fields it patched, so a
  // slow avatar save cannot revert a newer theme change.
  const serverPreferencesRef = useRef<AppPreferences>(defaultAppPreferences());

  const [connectionEpoch, setConnectionEpoch] = useState(1);
  const epochRef = useRef(1);
  const activeControllersRef = useRef<Set<AbortController>>(new Set());

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    skipInitialBootstrap ? 'connected' : 'checking',
  );
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [gatewayHealth, setGatewayHealth] = useState<HealthResponse | null>(
    null,
  );
  const [resources, setResources] = useState<AppResources>(emptyResources);

  const [toastState, setToastState] = useState<{
    message: string;
    tone: 'default' | 'error';
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const dirtyGuardRef = useRef<(() => boolean) | null>(null);
  const [discardPromptResolver, setDiscardPromptResolver] = useState<
    ((allowed: boolean) => void) | null
  >(null);

  const gatewayRef = useRef<GatewayClient | null>(null);
  if (!gatewayRef.current) {
    gatewayRef.current = new GatewayClient({
      baseUrl: initialLoad.settings.gatewayBaseUrl,
      accessToken: initialLoad.settings.accessToken,
      fetchImpl,
    });
  }
  const gateway = gatewayRef.current;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    settings.themeMode === 'dark'
      ? 'dark'
      : settings.themeMode === 'light'
        ? 'light'
        : systemDark
          ? 'dark'
          : 'light';

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    const accent = resolveAccentColors(settings.seedColorValue)[resolvedTheme];
    root.style.setProperty('--accent', accent);
  }, [resolvedTheme, settings.seedColorValue]);

  const toast = useCallback(
    (message: string, tone: 'default' | 'error' = 'default') => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      setToastState({ message, tone });
      toastTimerRef.current = window.setTimeout(() => {
        setToastState(null);
        toastTimerRef.current = null;
      }, 2800);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      for (const ctrl of activeControllersRef.current) {
        ctrl.abort();
      }
      activeControllersRef.current.clear();
    };
  }, []);

  const updateSettings = useCallback(
    (
      patchOrUpdater:
        | Partial<AppSettings>
        | ((prev: AppSettings) => AppSettings),
    ): SettingsSaveResult => {
      const nextRaw =
        typeof patchOrUpdater === 'function'
          ? patchOrUpdater(settingsRef.current)
          : { ...settingsRef.current, ...patchOrUpdater };
      const normalized = normalizeSettings(nextRaw);
      settingsRef.current = normalized;
      setSettings(normalized);
      // Only browser-owned connection info is persisted locally; preferences live
      // in the gateway and are written through updatePreferences.
      saveConnectionSettings({
        gatewayBaseUrl: normalized.gatewayBaseUrl,
        accessToken: normalized.accessToken,
      });
      return { settings: normalized, persisted: true, notice: null };
    },
    [],
  );

  // The gateway owns preference values once its row is initialized. Until then
  // the browser snapshot is the only source, so it seeds the server on first write
  // while still rendering correctly.
  const hydratePreferences = useCallback(
    async (signal: AbortSignal, epoch: number): Promise<void> => {
      // Legacy browser preferences are imported at most once; the gateway refuses
      // to overwrite values another browser already committed.
      const connectionGateway = settingsRef.current.gatewayBaseUrl;
      const legacy = readLegacyPreferences();
      const envelope = await gateway.getPreferences(signal);
      if (epoch !== epochRef.current) return;
      // A gateway switch while the request was in flight must not apply stale values.
      if (connectionGateway !== settingsRef.current.gatewayBaseUrl) return;

      const { composerReasoningEffort: _, mcpMaxToolRounds: __, ...fallback } = pickAppPreferences(settingsRef.current);
      const seed = legacy ?? fallback;
      let resolved = envelope;
      if (!envelope.initialized) {
        try {
          resolved = await gateway.importLegacyPreferences(seed, signal);
        } catch {
          // An older gateway without the import route still accepts a full PATCH.
          resolved = await gateway.updatePreferences(seed, signal);
        }
        if (epoch !== epochRef.current) return;
      }

      const next = resolved.initialized
        ? normalizeServerPreferences(resolved.preferences)
        : normalizeServerPreferences(seed);
      settingsRef.current = { ...settingsRef.current, ...next };
      serverPreferencesRef.current = next;
      setSettings(settingsRef.current);
      writeThemeHint(settingsRef.current.gatewayBaseUrl, {
        themeMode: next.themeMode,
        seedColorValue: next.seedColorValue,
      });
      if (resolved.initialized) {
        clearLegacyPreferences();
      }
    },
    [gateway],
  );

  const applyPreferenceFields = useCallback((values: Partial<AppPreferences>) => {
    settingsRef.current = { ...settingsRef.current, ...values };
    setSettings(settingsRef.current);
  }, []);

  const updatePreferences = useCallback(
    async (
      patch: Partial<AppPreferences>,
    ): Promise<{ ok: boolean; error?: string }> => {
      const epoch = epochRef.current;
      const confirmedBefore = serverPreferencesRef.current;
      const patchedKeys = Object.keys(patch) as AppPreferenceKey[];
      applyPreferenceFields(patch);
      try {
        const envelope = await gateway.updatePreferences(
          patch as Partial<ServerPreferences>,
        );
        if (epoch !== epochRef.current) return { ok: true };
        const confirmed = envelope.initialized
          ? normalizeServerPreferences(envelope.preferences)
          : { ...confirmedBefore, ...patch };
        // Responses may settle out of order: only the fields this call patched
        // move forward, so a slower request cannot revert a newer value.
        const applied = Object.fromEntries(
          patchedKeys.map((key) => [key, confirmed[key]]),
        ) as Partial<AppPreferences>;
        serverPreferencesRef.current = { ...serverPreferencesRef.current, ...applied };
        applyPreferenceFields(applied);
        writeThemeHint(settingsRef.current.gatewayBaseUrl, {
          themeMode: settingsRef.current.themeMode,
          seedColorValue: settingsRef.current.seedColorValue,
        });
        setSettingsNotice(null);
        return { ok: true };
      } catch (err) {
        if (epoch !== epochRef.current) return { ok: true };
        const rollback = Object.fromEntries(
          patchedKeys.map((key) => [key, confirmedBefore[key]]),
        ) as Partial<AppPreferences>;
        applyPreferenceFields(rollback);
        const message = errorMessageOf(err);
        setSettingsNotice(`设置保存失败：${message}`);
        return { ok: false, error: message };
      }
    },
    [applyPreferenceFields, gateway],
  );

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

  const handleAuthFailureIf401 = useCallback((err: unknown, epoch: number) => {
    if (epoch !== epochRef.current) return false;
    if (err instanceof GatewayError && err.statusCode === 401) {
      setConnectionState('auth-required');
      setConnectionError(err.message || '访问令牌无效或未授权');
      return true;
    }
    return false;
  }, []);

  const providerOrderRevision = useRef(0);
  const providerReorderEpoch = useRef<number | null>(null);
  const refreshProviders = useCallback(async () => {
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
      if (epoch !== epochRef.current) return;
      setResources((prev) => ({
        ...prev,
        formats: meta.formats,
        adapters: meta.adapters,
        providers: orderRevision === providerOrderRevision.current ? providers : prev.providers,
        loading: { ...prev.loading, providers: false },
      }));
    } catch (err) {
      if (epoch !== epochRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      handleAuthFailureIf401(err, epoch);
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, providers: false },
        error: { ...prev.error, providers: errorMessageOf(err) },
      }));
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const refreshAssistants = useCallback(async () => {
    const { epoch, signal, cleanup } = trackSignal();
    setResources((prev) => ({
      ...prev,
      loading: { ...prev.loading, assistants: true },
      error: { ...prev.error, assistants: null },
    }));
    try {
      const assistants = await gateway.listAssistants(signal);
      if (epoch !== epochRef.current) return;
      setResources((prev) => ({
        ...prev,
        assistants,
        loading: { ...prev.loading, assistants: false },
      }));
    } catch (err) {
      if (epoch !== epochRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      handleAuthFailureIf401(err, epoch);
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, assistants: false },
        error: { ...prev.error, assistants: errorMessageOf(err) },
      }));
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const conversationCleanupRevision = useRef(0);
  const refreshConversations = useCallback(async () => {
    const { epoch, signal, cleanup } = trackSignal();
    const cleanupRevision = conversationCleanupRevision.current;
    setResources((prev) => ({
      ...prev,
      loading: { ...prev.loading, conversations: true },
      error: { ...prev.error, conversations: null },
    }));
    try {
      const [conversations, conversationGroups] = await Promise.all([
        gateway.listConversations(signal),
        gateway.listConversationGroups(undefined, signal),
      ]);
      if (epoch !== epochRef.current) return;
      setResources((prev) => ({
        ...prev,
        conversations: cleanupRevision === conversationCleanupRevision.current ? conversations : prev.conversations,
        conversationGroups,
        loading: { ...prev.loading, conversations: false },
      }));
    } catch (err) {
      if (epoch !== epochRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      handleAuthFailureIf401(err, epoch);
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, conversations: false },
        error: { ...prev.error, conversations: errorMessageOf(err) },
      }));
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const refreshPlugins = useCallback(async () => {
    const { epoch, signal, cleanup } = trackSignal();
    setResources((prev) => ({
      ...prev,
      loading: { ...prev.loading, plugins: true },
      error: { ...prev.error, plugins: null },
    }));
    try {
      const [searchEngines, mcpServers] = await Promise.all([
        gateway.listSearchEngines(signal),
        gateway.listMcpServers(signal),
      ]);
      if (epoch !== epochRef.current) return;
      setResources((prev) => ({
        ...prev,
        searchEngines,
        mcpServers,
        loading: { ...prev.loading, plugins: false },
      }));
    } catch (err) {
      if (epoch !== epochRef.current) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      handleAuthFailureIf401(err, epoch);
      setResources((prev) => ({
        ...prev,
        loading: { ...prev.loading, plugins: false },
        error: { ...prev.error, plugins: errorMessageOf(err) },
      }));
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshProviders(),
      refreshAssistants(),
      refreshConversations(),
      refreshPlugins(),
    ]);
  }, [
    refreshAssistants,
    refreshConversations,
    refreshPlugins,
    refreshProviders,
  ]);

  const bootstrapConnection = useCallback(
    async (baseUrl: string, accessToken: string) => {
      for (const ctrl of activeControllersRef.current) {
        ctrl.abort();
      }
      activeControllersRef.current.clear();

      const nextEpoch = epochRef.current + 1;
      epochRef.current = nextEpoch;
      setConnectionEpoch(nextEpoch);

      gateway.baseUrl = baseUrl;
      gateway.accessToken = accessToken;

      setResources(emptyResources());
      setConnectionState('checking');
      setConnectionError(null);

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
        await Promise.all([
          refreshProviders(),
          refreshAssistants(),
          refreshConversations(),
          refreshPlugins(),
        ]);
      } catch (err) {
        if (nextEpoch !== epochRef.current) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof Error && err.name === 'AbortError') return;
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
      gateway,
      handleAuthFailureIf401,
      hydratePreferences,
      refreshAssistants,
      refreshConversations,
      refreshPlugins,
      refreshProviders,
      trackSignal,
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
    [bootstrapConnection, updateSettings],
  );

  const testGatewayConnection = useCallback(
    async (input?: { gatewayBaseUrl?: string; accessToken?: string }) => {
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
    [fetchImpl, settings.accessToken, settings.gatewayBaseUrl],
  );

  const retryConnection = useCallback(() => {
    void bootstrapConnection(settings.gatewayBaseUrl, settings.accessToken);
  }, [bootstrapConnection, settings.accessToken, settings.gatewayBaseUrl]);

  const upsertLocalConversation = useCallback((conv: Conversation) => {
    setResources((prev) => {
      const idx = prev.conversations.findIndex((c) => c.id === conv.id);
      const next =
        idx >= 0
          ? prev.conversations.map((c, i) => (i === idx ? conv : c))
          : [conv, ...prev.conversations];
      return {
        ...prev,
        conversations: sortConversationsByOrg(next, prev.conversationGroups),
      };
    });
  }, []);

  const removeLocalConversation = useCallback((id: string) => {
    setResources((prev) => ({
      ...prev,
      conversations: prev.conversations.filter((c) => c.id !== id),
    }));
  }, []);

  const cleanupUngroupedConversations = useCallback(async () => {
    const { epoch, signal, cleanup } = trackSignal();
    try {
      const deleted = await gateway.cleanupUngroupedConversations(signal);
      if (epoch !== epochRef.current) return null;
      if (deleted.length > 0) {
        conversationCleanupRevision.current++;
        const ids = new Set(deleted.map((item) => item.id));
        setResources((prev) => ({
          ...prev,
          conversations: prev.conversations.filter((c) => !ids.has(c.id)),
        }));
      }
      return deleted;
    } catch (err) {
      if (epoch !== epochRef.current) return null;
      handleAuthFailureIf401(err, epoch);
      throw err;
    } finally {
      cleanup();
    }
  }, [gateway, handleAuthFailureIf401, trackSignal]);

  const applyConversationOrganizationSnapshot = useCallback(
    (
      assistantId: string,
      snapshot: { conversations: Conversation[]; groups: ConversationGroup[] },
      expectedEpoch?: number,
    ) => {
      if (expectedEpoch !== undefined && expectedEpoch !== epochRef.current) return;
      setResources((prev) => {
        const otherConvs = prev.conversations.filter(
          (c) => (c.assistantId || 'default') !== assistantId,
        );
        const otherGroups = prev.conversationGroups.filter(
          (g) => g.assistantId !== assistantId,
        );
        const nextGroups = [...otherGroups, ...snapshot.groups];
        const nextConvs = sortConversationsByOrg(
          [...otherConvs, ...snapshot.conversations],
          nextGroups,
        );
        return {
          ...prev,
          conversations: nextConvs,
          conversationGroups: nextGroups,
        };
      });
    },
    [],
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

  const upsertLocalMcpServer = useCallback((server: MCPServerConfig) => {
    setResources((prev) => {
      const exists = prev.mcpServers.some((s) => s.id === server.id);
      return {
        ...prev,
        mcpServers: exists
          ? prev.mcpServers.map((s) => (s.id === server.id ? server : s))
          : [...prev.mcpServers, server],
      };
    });
  }, []);

  const removeLocalMcpServer = useCallback((id: string) => {
    setResources((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.filter((s) => s.id !== id),
    }));
  }, []);

  const registerDirtyGuard = useCallback((guard: (() => boolean) | null) => {
    dirtyGuardRef.current = guard;
  }, []);

  const confirmLeaveIfDirty = useCallback((): Promise<boolean> => {
    const guard = dirtyGuardRef.current;
    if (!guard || !guard()) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      setDiscardPromptResolver(() => resolve);
    });
  }, []);

  const value: AppContextValue = useMemo(
    () => ({
      gateway,
      connectionEpoch,
      settings,
      resolvedTheme,
      settingsNotice,
      dismissSettingsNotice: () => setSettingsNotice(null),
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
      refreshAll,
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
      gateway,
      connectionEpoch,
      settings,
      resolvedTheme,
      settingsNotice,
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
      refreshAll,
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
          {toastState.message}
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
