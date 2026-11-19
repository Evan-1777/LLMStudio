import { isReasoningEffort, type ChatWidthMode, type ReasoningEffort, type ServerPreferencesImport } from './types';

// Legacy single-blob key: pre-migration browser state, removed once the gateway
// confirms the import (or already holds server-owned preferences).
export const SETTINGS_STORAGE_KEY = 'llmstudio.settings.v2';
export const LEGACY_FLUTTER_SETTINGS_KEY = 'flutter.llmstudio.settings.v1';
export const SETTINGS_MIGRATED_KEY = 'llmstudio.settings.v2.migrated';
// Browser-owned connection info: required before the gateway can be reached.
export const CONNECTION_STORAGE_KEY = 'llmstudio.connection.v1';
// First-paint theme hint per normalized gateway; never authoritative.
export const THEME_HINT_STORAGE_PREFIX = 'llmstudio.themeHint.v1::';

export function themeHintKey(gatewayBaseUrl: string): string {
  return `${THEME_HINT_STORAGE_PREFIX}${canonicalGateway(gatewayBaseUrl)}`;
}

export function canonicalGateway(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === '' ? '/' : trimmed;
}

export interface ThemeHint {
  themeMode: ThemeMode;
  seedColorValue: number;
}

function safeStorage(explicit?: Storage | null): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Reads the stored rendering hint for a gateway, if any. */
export function readThemeHint(
  gatewayBaseUrl: string,
  explicitStorage?: Storage | null,
): ThemeHint | null {
  const storage = safeStorage(explicitStorage);
  if (!storage) return null;
  try {
    const raw = storage.getItem(themeHintKey(gatewayBaseUrl));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const themeMode: ThemeMode =
      obj.themeMode === 'light' ||
      obj.themeMode === 'dark' ||
      obj.themeMode === 'system'
        ? obj.themeMode
        : 'system';
    const seedColorValue =
      typeof obj.seedColorValue === 'number' &&
      Number.isFinite(obj.seedColorValue)
        ? Math.trunc(obj.seedColorValue) >>> 0
        : DEFAULT_APPLE_BLUE;
    return { themeMode, seedColorValue };
  } catch {
    return null;
  }
}

/** Stores a rendering hint from a value confirmed by the gateway. */
export function writeThemeHint(
  gatewayBaseUrl: string,
  hint: ThemeHint,
  explicitStorage?: Storage | null,
): void {
  const storage = safeStorage(explicitStorage);
  if (!storage) return;
  try {
    storage.setItem(themeHintKey(gatewayBaseUrl), JSON.stringify(hint));
  } catch {
    // Rendering hints are optional; a failed write only costs a brief default theme.
  }
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type ChatDisplayMode = 'bubble' | 'feed';
export type { ChatWidthMode };

export const CHAT_WIDTH_MIN = 560;
export const CHAT_WIDTH_MAX = 3840;
export const CHAT_WIDTH_DEFAULT = 780;

export const DEFAULT_APPLE_BLUE = 0x007aff;

export const PRESET_ACCENT_COLORS: readonly {
  value: number;
  label: string;
  lightHex: string;
  darkHex: string;
}[] = [
  { value: 0xff007aff, label: 'Apple Blue', lightHex: '#007AFF', darkHex: '#409CFF' },
  { value: 0xff3f5f90, label: 'Slate Blue', lightHex: '#3F5F90', darkHex: '#6B8EC4' },
  { value: 0xff2d6a4f, label: 'Forest Teal', lightHex: '#2D6A4F', darkHex: '#52B788' },
  { value: 0xff6750a4, label: 'Violet', lightHex: '#6750A4', darkHex: '#9A82DB' },
  { value: 0xff9c4221, label: 'Terracotta', lightHex: '#9C4221', darkHex: '#E07A5F' },
  { value: 0xff475569, label: 'Graphite', lightHex: '#475569', darkHex: '#94A3B8' },
];

export interface AppSettings {
  // Browser connection info: required before the gateway can be reached.
  gatewayBaseUrl: string;
  accessToken: string;
  // Application preferences: the gateway owns these values once they are initialized.
  themeMode: ThemeMode;
  seedColorValue: number;
  enterToSend: boolean;
  visualHtmlRender: boolean;
  defaultHtmlPreview: boolean;
  chatDisplayMode: ChatDisplayMode;
  autoCollapseEnabled: boolean;
  autoCollapseThinkingOnComplete: boolean;
  autoCollapseToolsOnComplete: boolean;
  autoCreateCache: boolean;
  collapseLineThreshold: number;
  collapseCharThreshold: number;
  // User avatar owned by the gateway; empty means the built-in avatar.
  userAvatarDataUrl: string;
  composerReasoningEffort: ReasoningEffort | '';
  mcpMaxToolRounds: number;
  chatWidthMode: ChatWidthMode;
  chatManualWidth: number;
}

export interface SettingsLoadResult {
  settings: AppSettings;
  persisted: boolean;
  migratedFromLegacy: boolean;
  notice: string | null;
}

export interface SettingsSaveResult {
  settings: AppSettings;
  persisted: boolean;
  notice: string | null;
}

// Preference fields hosted by the gateway, in the order of the server contract.
export const APP_PREFERENCE_KEYS = [
  'themeMode',
  'seedColorValue',
  'enterToSend',
  'visualHtmlRender',
  'defaultHtmlPreview',
  'chatDisplayMode',
  'autoCollapseEnabled',
  'autoCollapseThinkingOnComplete',
  'autoCollapseToolsOnComplete',
  'autoCreateCache',
  'collapseLineThreshold',
  'collapseCharThreshold',
  'userAvatarDataUrl',
  'composerReasoningEffort',
  'mcpMaxToolRounds',
  'chatWidthMode',
  'chatManualWidth',
] as const satisfies readonly (keyof AppSettings)[];

export type AppPreferenceKey = (typeof APP_PREFERENCE_KEYS)[number];
export type AppPreferences = Pick<AppSettings, AppPreferenceKey>;

/** Extracts the server-managed subset of a settings snapshot. */
export function pickAppPreferences(settings: AppSettings): AppPreferences {
  return {
    themeMode: settings.themeMode,
    seedColorValue: settings.seedColorValue,
    enterToSend: settings.enterToSend,
    visualHtmlRender: settings.visualHtmlRender,
    defaultHtmlPreview: settings.defaultHtmlPreview,
    chatDisplayMode: settings.chatDisplayMode,
    autoCollapseEnabled: settings.autoCollapseEnabled,
    autoCollapseThinkingOnComplete: settings.autoCollapseThinkingOnComplete,
    autoCollapseToolsOnComplete: settings.autoCollapseToolsOnComplete,
    autoCreateCache: settings.autoCreateCache,
    collapseLineThreshold: settings.collapseLineThreshold,
    collapseCharThreshold: settings.collapseCharThreshold,
    userAvatarDataUrl: settings.userAvatarDataUrl,
    composerReasoningEffort: settings.composerReasoningEffort,
    mcpMaxToolRounds: settings.mcpMaxToolRounds,
    chatWidthMode: settings.chatWidthMode,
    chatManualWidth: settings.chatManualWidth,
  };
}

/** Defaults for the server-managed subset, used before the gateway replies. */
export function defaultAppPreferences(): AppPreferences {
  return pickAppPreferences(defaultSettings());
}

export function defaultSettings(): AppSettings {
  return {
    gatewayBaseUrl: '/',
    accessToken: '',
    themeMode: 'system',
    seedColorValue: DEFAULT_APPLE_BLUE,
    enterToSend: true,
    visualHtmlRender: true,
    defaultHtmlPreview: false,
    chatDisplayMode: 'bubble',
    autoCollapseEnabled: true,
    autoCollapseThinkingOnComplete: true,
    autoCollapseToolsOnComplete: true,
    autoCreateCache: false,
    collapseLineThreshold: 24,
    collapseCharThreshold: 1200,
    userAvatarDataUrl: '',
    composerReasoningEffort: '',
    mcpMaxToolRounds: 20,
    chatWidthMode: 'default',
    chatManualWidth: CHAT_WIDTH_DEFAULT,
  };
}

export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const truncated = Math.trunc(value);
  return Math.min(max, Math.max(min, truncated));
}

export function normalizeSettings(raw: unknown): AppSettings {
  const defaults = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;

  const rawUrl =
    typeof obj.gatewayBaseUrl === 'string' ? obj.gatewayBaseUrl.trim() : '';
  const themeMode: ThemeMode =
    obj.themeMode === 'light' ||
    obj.themeMode === 'dark' ||
    obj.themeMode === 'system'
      ? obj.themeMode
      : defaults.themeMode;

  const seed =
    typeof obj.seedColorValue === 'number' && Number.isFinite(obj.seedColorValue)
      ? Math.trunc(obj.seedColorValue) >>> 0
      : defaults.seedColorValue;

  const chatDisplayMode: ChatDisplayMode =
    obj.chatDisplayMode === 'feed' || obj.chatDisplayMode === 'bubble'
      ? obj.chatDisplayMode
      : defaults.chatDisplayMode;

  const chatWidthMode: ChatWidthMode =
    obj.chatWidthMode === 'manual' ? 'manual' : 'default';

  return {
    gatewayBaseUrl: rawUrl || defaults.gatewayBaseUrl,
    accessToken:
      typeof obj.accessToken === 'string' ? obj.accessToken : defaults.accessToken,
    themeMode,
    seedColorValue: seed,
    enterToSend:
      typeof obj.enterToSend === 'boolean'
        ? obj.enterToSend
        : defaults.enterToSend,
    visualHtmlRender:
      typeof obj.visualHtmlRender === 'boolean'
        ? obj.visualHtmlRender
        : defaults.visualHtmlRender,
    defaultHtmlPreview:
      typeof obj.defaultHtmlPreview === 'boolean'
        ? obj.defaultHtmlPreview
        : defaults.defaultHtmlPreview,
    chatDisplayMode,
    autoCollapseEnabled:
      typeof obj.autoCollapseEnabled === 'boolean'
        ? obj.autoCollapseEnabled
        : defaults.autoCollapseEnabled,
    autoCollapseThinkingOnComplete:
      typeof obj.autoCollapseThinkingOnComplete === 'boolean'
        ? obj.autoCollapseThinkingOnComplete
        : defaults.autoCollapseThinkingOnComplete,
    autoCollapseToolsOnComplete:
      typeof obj.autoCollapseToolsOnComplete === 'boolean'
        ? obj.autoCollapseToolsOnComplete
        : defaults.autoCollapseToolsOnComplete,
    autoCreateCache:
      typeof obj.autoCreateCache === 'boolean'
        ? obj.autoCreateCache
        : defaults.autoCreateCache,
    collapseLineThreshold: clampInt(
      obj.collapseLineThreshold,
      4,
      200,
      defaults.collapseLineThreshold,
    ),
    collapseCharThreshold: clampInt(
      obj.collapseCharThreshold,
      120,
      20000,
      defaults.collapseCharThreshold,
    ),
    mcpMaxToolRounds: clampInt(obj.mcpMaxToolRounds, 1, 100, defaults.mcpMaxToolRounds),
    composerReasoningEffort: isReasoningEffort(obj.composerReasoningEffort) ? obj.composerReasoningEffort : '',
    userAvatarDataUrl:
      typeof obj.userAvatarDataUrl === 'string'
        ? obj.userAvatarDataUrl
        : defaults.userAvatarDataUrl,
    chatWidthMode,
    chatManualWidth: clampInt(
      obj.chatManualWidth,
      CHAT_WIDTH_MIN,
      CHAT_WIDTH_MAX,
      defaults.chatManualWidth,
    ),
  };
}

/**
 * Fills the server-managed preference subset from defaults, so a gateway that
 * predates a field reports that field empty instead of inheriting the previous
 * connection's value.
 */
export function normalizeServerPreferences(raw: unknown): AppPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultAppPreferences();
  }
  return pickAppPreferences(
    normalizeSettings({ ...defaultSettings(), ...(raw as Record<string, unknown>) }),
  );
}

function parseLegacyDoubleEncoded(raw: string): Record<string, unknown> {
  const first: unknown = JSON.parse(raw);
  const inner: unknown = typeof first === 'string' ? JSON.parse(first) : first;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
    throw new Error('legacy settings payload is not an object');
  }
  return inner as Record<string, unknown>;
}

export function loadSettings(explicitStorage?: Storage | null): SettingsLoadResult {
  const storage = safeStorage(explicitStorage);
  if (!storage) {
    return {
      settings: defaultSettings(),
      persisted: false,
      migratedFromLegacy: false,
      notice: '浏览器本地存储不可用，当前设置仅在本次会话保留',
    };
  }

  let v2Raw: string | null = null;
  try {
    v2Raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return {
      settings: defaultSettings(),
      persisted: false,
      migratedFromLegacy: false,
      notice: '无法读取本地存储，当前设置仅在本次会话保留',
    };
  }

  if (v2Raw !== null && v2Raw !== '') {
    try {
      const parsed: unknown = JSON.parse(v2Raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('corrupt settings object');
      }
      return {
        settings: normalizeSettings(parsed),
        persisted: true,
        migratedFromLegacy: false,
        notice: null,
      };
    } catch {
      return {
        settings: defaultSettings(),
        persisted: true,
        migratedFromLegacy: false,
        notice: '本地设置数据损坏，已恢复默认值',
      };
    }
  }

  let legacyRaw: string | null = null;
  try {
    legacyRaw = storage.getItem(LEGACY_FLUTTER_SETTINGS_KEY);
  } catch {
    return {
      settings: defaultSettings(),
      persisted: false,
      migratedFromLegacy: false,
      notice: '无法读取本地存储，当前设置仅在本次会话保留',
    };
  }

  if (legacyRaw !== null && legacyRaw !== '') {
    try {
      const legacyObj = parseLegacyDoubleEncoded(legacyRaw);
      const migrated = normalizeSettings(legacyObj);
      try {
        storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
        storage.setItem(SETTINGS_MIGRATED_KEY, '1');
        return {
          settings: migrated,
          persisted: true,
          migratedFromLegacy: true,
          notice: null,
        };
      } catch {
        return {
          settings: migrated,
          persisted: false,
          migratedFromLegacy: false,
          notice: '旧设置已读取但写入本地存储失败，仅在本次会话生效',
        };
      }
    } catch {
      return {
        settings: defaultSettings(),
        persisted: true,
        migratedFromLegacy: false,
        notice: '旧版设置数据损坏，已恢复默认值',
      };
    }
  }

  return {
    settings: defaultSettings(),
    persisted: true,
    migratedFromLegacy: false,
    notice: null,
  };
}

/** Persists only browser-owned connection info, leaving server preferences alone. */
export function saveConnectionSettings(
  connection: { gatewayBaseUrl: string; accessToken: string },
  explicitStorage?: Storage | null,
): void {
  const storage = safeStorage(explicitStorage);
  if (!storage) return;
  try {
    storage.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({
        gatewayBaseUrl: canonicalGateway(connection.gatewayBaseUrl),
        accessToken: connection.accessToken,
      }),
    );
  } catch {
    // Connection info stays usable for this session when storage is unavailable.
  }
}

/** Reads browser connection info, ignoring any preference fields. */
export function loadConnectionSettings(explicitStorage?: Storage | null): {
  gatewayBaseUrl: string;
  accessToken: string;
} {
  const defaults = defaultSettings();
  const storage = safeStorage(explicitStorage);
  if (!storage) {
    return { gatewayBaseUrl: defaults.gatewayBaseUrl, accessToken: defaults.accessToken };
  }
  try {
    const raw = storage.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) {
      return { gatewayBaseUrl: defaults.gatewayBaseUrl, accessToken: defaults.accessToken };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { gatewayBaseUrl: defaults.gatewayBaseUrl, accessToken: defaults.accessToken };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      gatewayBaseUrl:
        typeof obj.gatewayBaseUrl === 'string'
          ? canonicalGateway(obj.gatewayBaseUrl)
          : defaults.gatewayBaseUrl,
      accessToken:
        typeof obj.accessToken === 'string' ? obj.accessToken : defaults.accessToken,
    };
  } catch {
    return { gatewayBaseUrl: defaults.gatewayBaseUrl, accessToken: defaults.accessToken };
  }
}

/**
 * Reads preferences still held only by the browser (pre-migration blob), so they
 * can be conditionally imported into the gateway. Null means there is nothing to
 * import; the caller decides whether the gateways current values may be seeded.
 */
export function readLegacyPreferences(
  explicitStorage?: Storage | null,
): ServerPreferencesImport | null {
  const storage = safeStorage(explicitStorage);
  if (!storage) return null;
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const {
        composerReasoningEffort: _c,
        mcpMaxToolRounds: _m,
        chatWidthMode: _w,
        chatManualWidth: _mw,
        ...legacy
      } = pickAppPreferences(normalizeSettings(JSON.parse(raw)));
      return legacy;
    }
    const flutterRaw = storage.getItem(LEGACY_FLUTTER_SETTINGS_KEY);
    if (flutterRaw) {
      const {
        composerReasoningEffort: _c,
        mcpMaxToolRounds: _m,
        chatWidthMode: _w,
        chatManualWidth: _mw,
        ...legacy
      } = pickAppPreferences(
        normalizeSettings(parseLegacyDoubleEncoded(flutterRaw)),
      );
      return legacy;
    }
  } catch {
    return null;
  }
  return null;
}

/** Removes browser preference copies once the gateway is authoritative. */
export function clearLegacyPreferences(explicitStorage?: Storage | null): void {
  const storage = safeStorage(explicitStorage);
  if (!storage) return;
  try {
    storage.removeItem(SETTINGS_STORAGE_KEY);
    storage.removeItem(LEGACY_FLUTTER_SETTINGS_KEY);
    storage.removeItem(SETTINGS_MIGRATED_KEY);
  } catch {
    // Cleanup is best-effort; stale copies no longer affect behaviour.
  }
}

export function saveSettings(
  next: AppSettings,
  explicitStorage?: Storage | null,
): SettingsSaveResult {
  const normalized = normalizeSettings(next);
  const storage = safeStorage(explicitStorage);
  if (!storage) {
    return {
      settings: normalized,
      persisted: false,
      notice: '浏览器本地存储不可用，更改仅在本次会话保留',
    };
  }
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return {
      settings: normalized,
      persisted: true,
      notice: null,
    };
  } catch {
    return {
      settings: normalized,
      persisted: false,
      notice: '无法写入本地存储，更改仅在本次会话保留',
    };
  }
}

export function resolveAccentColors(seedColorValue: number): {
  light: string;
  dark: string;
} {
  const normalized = seedColorValue >>> 0;
  const preset = PRESET_ACCENT_COLORS.find((p) => p.value === normalized);
  if (preset) {
    return { light: preset.lightHex, dark: preset.darkHex };
  }
  const hex = `#${(normalized & 0xffffff).toString(16).padStart(6, '0')}`;
  return { light: hex, dark: hex };
}
