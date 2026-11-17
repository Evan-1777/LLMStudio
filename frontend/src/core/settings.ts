export const SETTINGS_STORAGE_KEY = 'llmstudio.settings.v2';
export const LEGACY_FLUTTER_SETTINGS_KEY = 'flutter.llmstudio.settings.v1';
export const SETTINGS_MIGRATED_KEY = 'llmstudio.settings.v2.migrated';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ChatDisplayMode = 'bubble' | 'feed';

export const DEFAULT_APPLE_BLUE = 0xff007aff;

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
  gatewayBaseUrl: string;
  accessToken: string;
  themeMode: ThemeMode;
  seedColorValue: number;
  enterToSend: boolean;
  visualHtmlRender: boolean;
  defaultHtmlPreview: boolean;
  chatDisplayMode: ChatDisplayMode;
  autoCollapseEnabled: boolean;
  collapseLineThreshold: number;
  collapseCharThreshold: number;
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
    collapseLineThreshold: 24,
    collapseCharThreshold: 1200,
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
  };
}

function getSafeStorage(explicit?: Storage | null): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
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
  const storage = getSafeStorage(explicitStorage);
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

export function saveSettings(
  next: AppSettings,
  explicitStorage?: Storage | null,
): SettingsSaveResult {
  const normalized = normalizeSettings(next);
  const storage = getSafeStorage(explicitStorage);
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
