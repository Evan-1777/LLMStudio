import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { GatewayClient, GatewayError } from '../core/gateway';
import {
  clearLegacyPreferences,
  defaultAppPreferences,
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
import type { ServerPreferences } from '../core/types';

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

export function usePreferencesManager({
  initialSettings,
  initialNotice,
  isDesktop,
  gateway,
  epochRef,
}: {
  initialSettings: AppSettings;
  initialNotice: string | null;
  isDesktop: boolean;
  gateway: GatewayClient;
  epochRef: MutableRefObject<number>;
}) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const settingsRef = useRef<AppSettings>(initialSettings);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(initialNotice);
  const [systemDark, setSystemDark] = useState<boolean>(getSystemPrefersDark);
  // Latest values confirmed by the gateway; failed writes roll back to this
  // snapshot. Each write applies and rolls back only the fields it patched, so a
  // slow avatar save cannot revert a newer theme change.
  const serverPreferencesRef = useRef<AppPreferences>(defaultAppPreferences());

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
    root.dataset.fontFamily = settings.fontFamily;
    root.style.setProperty('--font-size-base', `${settings.fontSize}px`);
  }, [
    resolvedTheme,
    settings.fontFamily,
    settings.fontSize,
    settings.seedColorValue,
  ]);

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
      if (!isDesktop) {
        saveConnectionSettings({
          gatewayBaseUrl: normalized.gatewayBaseUrl,
          accessToken: normalized.accessToken,
        });
      }
      return { settings: normalized, persisted: true, notice: null };
    },
    [isDesktop],
  );

  const applyConfirmedPreferences = useCallback((next: AppPreferences) => {
    settingsRef.current = { ...settingsRef.current, ...next };
    serverPreferencesRef.current = next;
    setSettings(settingsRef.current);
    writeThemeHint(settingsRef.current.gatewayBaseUrl, {
      themeMode: next.themeMode,
      seedColorValue: next.seedColorValue,
      fontFamily: next.fontFamily,
      fontSize: next.fontSize,
    });
  }, []);

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

      const {
        composerReasoningEffort: _c,
        mcpMaxToolRounds: _m,
        chatWidthMode: _w,
        chatManualWidth: _mw,
        fontFamily: _ff,
        fontSize: _fs,
        builtinTimeToolEnabled: _bt,
        mathRenderEnabled: _mr,
        defaultTopicMode: _dt,
        lastProviderId: _lp,
        lastModelId: _lm,
        ...fallback
      } = pickAppPreferences(settingsRef.current);
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
      applyConfirmedPreferences(next);
      if (resolved.initialized) {
        clearLegacyPreferences();
      }
    },
    [applyConfirmedPreferences, epochRef, gateway],
  );

  const applyPreferenceFields = useCallback((values: Partial<AppPreferences>) => {
    settingsRef.current = { ...settingsRef.current, ...values };
    setSettings(settingsRef.current);
  }, []);

  const updatePreferences = useCallback(
    async (
      patch: Partial<AppPreferences>,
      opts?: { silent?: boolean },
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
          fontFamily: settingsRef.current.fontFamily,
          fontSize: settingsRef.current.fontSize,
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
        if (!opts?.silent) {
          setSettingsNotice(`设置保存失败：${message}`);
        }
        return { ok: false, error: message };
      }
    },
    [applyPreferenceFields, epochRef, gateway],
  );

  const dismissSettingsNotice = useCallback(() => {
    setSettingsNotice(null);
  }, []);

  return {
    settings,
    settingsRef,
    settingsNotice,
    dismissSettingsNotice,
    resolvedTheme,
    updateSettings,
    applyConfirmedPreferences,
    hydratePreferences,
    updatePreferences,
  };
}
