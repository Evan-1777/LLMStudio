import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPLE_BLUE,
  LEGACY_FLUTTER_SETTINGS_KEY,
  SETTINGS_MIGRATED_KEY,
  SETTINGS_STORAGE_KEY,
  clearLegacyPreferences,
  defaultSettings,
  normalizeServerPreferences,
  normalizeSettings,
  loadConnectionSettings,
  loadSettings,
  readLegacyPreferences,
  readThemeHint,
  saveConnectionSettings,
  saveSettings,
  writeThemeHint,
} from './settings';

describe('settings storage and migration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('migrates double-encoded flutter.llmstudio.settings.v1 without mutating legacy key', () => {
    const legacyInner = JSON.stringify({
      gatewayBaseUrl: 'https://studio.example.com',
      accessToken: 'tok-123',
      themeMode: 'dark',
      seedColorValue: 0xff2d6a4f,
      enterToSend: false,
      defaultHtmlPreview: false,
      autoCollapseEnabled: false,
      collapseLineThreshold: 500,
      collapseCharThreshold: 50,
    });
    const doubleEncoded = JSON.stringify(legacyInner);
    localStorage.setItem(LEGACY_FLUTTER_SETTINGS_KEY, doubleEncoded);

    const first = loadSettings();
    expect(first.persisted).toBe(true);
    expect(first.migratedFromLegacy).toBe(true);
    expect(first.notice).toBeNull();
    expect(first.settings).toEqual({
      gatewayBaseUrl: 'https://studio.example.com',
      accessToken: 'tok-123',
      themeMode: 'dark',
      seedColorValue: 0xff2d6a4f,
      enterToSend: false,
      visualHtmlRender: true,
      defaultHtmlPreview: false,
      chatDisplayMode: 'bubble',
      autoCollapseEnabled: false,
      autoCollapseThinkingOnComplete: true,
      autoCollapseToolsOnComplete: true,
      autoCreateCache: false,
      collapseLineThreshold: 200,
      collapseCharThreshold: 120,
      userAvatarDataUrl: '',
      composerReasoningEffort: '',
      mcpMaxToolRounds: 20,
      chatWidthMode: 'default',
      chatManualWidth: 780,
      fontFamily: 'system',
      fontSize: 14,
      builtinTimeToolEnabled: false,
      mathRenderEnabled: true,
      graphMarkdownRender: true,
      graphVisualHtmlRender: true,
      defaultTopicMode: 'chat',
      lastProviderId: '',
      lastModelId: '',
    });

    expect(defaultSettings()).toMatchObject({
      visualHtmlRender: true,
      defaultHtmlPreview: false,
      chatDisplayMode: 'bubble',
      autoCollapseThinkingOnComplete: true,
      autoCollapseToolsOnComplete: true,
      autoCreateCache: false,
    });

    expect(localStorage.getItem(LEGACY_FLUTTER_SETTINGS_KEY)).toBe(doubleEncoded);
    expect(localStorage.getItem(SETTINGS_MIGRATED_KEY)).toBe('1');
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();

    const second = loadSettings();
    expect(second.migratedFromLegacy).toBe(false);
    expect(second.settings).toEqual(first.settings);
  });

  it.each([[undefined, 20], [0, 1], [101, 100], [12, 12]])('normalizes the tool round limit %s to %d', (value, expected) => {
    expect(normalizeSettings({ mcpMaxToolRounds: value }).mcpMaxToolRounds).toBe(expected);
  });

  it('normalizes default topic mode and trimmed recent model ids', () => {
    expect(normalizeSettings({ defaultTopicMode: 'agent' })).toMatchObject({
      defaultTopicMode: 'agent',
      lastProviderId: '',
      lastModelId: '',
    });
    expect(normalizeSettings({ defaultTopicMode: 'invalid', lastProviderId: ' p1 ', lastModelId: ' m1 ' })).toMatchObject({
      defaultTopicMode: 'chat',
      lastProviderId: 'p1',
      lastModelId: 'm1',
    });
    expect(normalizeServerPreferences({ lastProviderId: 42, lastModelId: null })).toMatchObject({
      defaultTopicMode: 'chat',
      lastProviderId: '',
      lastModelId: '',
    });
  });

  it('prefers v2 over legacy key', () => {
    localStorage.setItem(
      LEGACY_FLUTTER_SETTINGS_KEY,
      JSON.stringify(JSON.stringify({ gatewayBaseUrl: 'https://old.example' })),
    );
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...defaultSettings(),
        gatewayBaseUrl: 'https://new.example',
        themeMode: 'light',
        visualHtmlRender: false,
        defaultHtmlPreview: true,
        chatDisplayMode: 'feed',
        autoCollapseThinkingOnComplete: false,
      }),
    );

    const res = loadSettings();
    expect(res.settings.gatewayBaseUrl).toBe('https://new.example');
    expect(res.settings.themeMode).toBe('light');
    expect(res.settings.visualHtmlRender).toBe(false);
    expect(res.settings.defaultHtmlPreview).toBe(true);
    expect(res.settings.chatDisplayMode).toBe('feed');
    expect(res.settings.autoCollapseThinkingOnComplete).toBe(false);
    expect(res.settings.autoCollapseToolsOnComplete).toBe(true);
    expect(res.migratedFromLegacy).toBe(false);
  });

  it('handles corrupted legacy/v2 values with functional notice and defaults', () => {
    localStorage.setItem(LEGACY_FLUTTER_SETTINGS_KEY, '{broken');
    const legacyCorrupt = loadSettings();
    expect(legacyCorrupt.settings.seedColorValue).toBe(DEFAULT_APPLE_BLUE);
    expect(legacyCorrupt.notice).toBeTruthy();

    localStorage.setItem(SETTINGS_STORAGE_KEY, 'not-json');
    const v2Corrupt = loadSettings();
    expect(v2Corrupt.settings).toEqual(defaultSettings());
    expect(v2Corrupt.notice).toBeTruthy();
  });

  it('keeps connection info separate from gateway-owned preferences', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), themeMode: 'dark' }),
    );

    saveConnectionSettings({
      gatewayBaseUrl: ' https://gw.example ',
      accessToken: 'tok',
    });

    const connection = loadConnectionSettings();
    expect(connection).toEqual({
      gatewayBaseUrl: 'https://gw.example',
      accessToken: 'tok',
    });
    // The legacy blob no longer drives the connection, only the preferences import.
    expect(readLegacyPreferences()).toMatchObject({ themeMode: 'dark' });
  });

  it('imports legacy preferences once and clears browser copies afterwards', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultSettings(), themeMode: 'light', enterToSend: false, composerReasoningEffort: 'high', mcpMaxToolRounds: 91 }),
    );

    expect(readLegacyPreferences()).toMatchObject({
      themeMode: 'light',
      enterToSend: false,
    });

    expect(readLegacyPreferences()).not.toHaveProperty('composerReasoningEffort');
    expect(readLegacyPreferences()).not.toHaveProperty('mcpMaxToolRounds');
    expect(readLegacyPreferences()).not.toHaveProperty('chatWidthMode');
    expect(readLegacyPreferences()).not.toHaveProperty('chatManualWidth');
    expect(readLegacyPreferences()).not.toHaveProperty('fontFamily');
    expect(readLegacyPreferences()).not.toHaveProperty('fontSize');

    clearLegacyPreferences();
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(readLegacyPreferences()).toBeNull();
    expect(loadConnectionSettings()).toEqual({
      gatewayBaseUrl: '/',
      accessToken: '',
    });
  });

  it('scopes the first-paint theme hint to its gateway', () => {
    writeThemeHint('/', { themeMode: 'dark', seedColorValue: 0x2d6a4f });
    writeThemeHint('https://other.example', {
      themeMode: 'light',
      seedColorValue: 0x007aff,
    });

    expect(readThemeHint('/')).toEqual({
      themeMode: 'dark',
      seedColorValue: 0x2d6a4f,
      fontFamily: 'system',
      fontSize: 14,
    });
    expect(readThemeHint('https://other.example')).toEqual({
      themeMode: 'light',
      seedColorValue: 0x007aff,
      fontFamily: 'system',
      fontSize: 14,
    });
    expect(readThemeHint('https://unknown.example')).toBeNull();
  });

  it('handles disabled storage and write failures gracefully without claiming persistence', () => {
    const disabled = loadSettings(null);
    expect(disabled.persisted).toBe(false);
    expect(disabled.notice).toBeTruthy();

    const throwingWriteStorage: Storage = {
      length: 1,
      clear: () => {},
      key: () => null,
      removeItem: () => {},
      getItem: (k) =>
        k === LEGACY_FLUTTER_SETTINGS_KEY
          ? JSON.stringify(JSON.stringify({ accessToken: 'keep-me' }))
          : null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };

    const failMigrate = loadSettings(throwingWriteStorage);
    expect(failMigrate.persisted).toBe(false);
    expect(failMigrate.migratedFromLegacy).toBe(false);
    expect(failMigrate.settings.accessToken).toBe('keep-me');
    expect(failMigrate.notice).toBeTruthy();

    const failSave = saveSettings(defaultSettings(), throwingWriteStorage);
    expect(failSave.persisted).toBe(false);
    expect(failSave.notice).toBeTruthy();
  });

  it('normalizes chatWidthMode and clamps chatManualWidth within bounds', () => {
    expect(defaultSettings().chatWidthMode).toBe('default');
    expect(defaultSettings().chatManualWidth).toBe(780);

    const low = normalizeSettings({ chatWidthMode: 'manual', chatManualWidth: 200 });
    expect(low.chatWidthMode).toBe('manual');
    expect(low.chatManualWidth).toBe(560);

    const high = normalizeSettings({ chatWidthMode: 'wide', chatManualWidth: 9999 });
    expect(high.chatWidthMode).toBe('default');
    expect(high.chatManualWidth).toBe(3840);
  });

  it('normalizes fontFamily and clamps fontSize within 12-22px', () => {
    expect(defaultSettings().fontFamily).toBe('system');
    expect(defaultSettings().fontSize).toBe(14);
    expect(normalizeSettings({ fontFamily: 'invalid-font', fontSize: 5 })).toMatchObject({
      fontFamily: 'system',
      fontSize: 12,
    });
    expect(normalizeSettings({ fontFamily: 'kai', fontSize: 99 })).toMatchObject({
      fontFamily: 'kai',
      fontSize: 22,
    });
    expect(normalizeServerPreferences({ fontFamily: 'serif', fontSize: 18 })).toMatchObject({
      fontFamily: 'serif',
      fontSize: 18,
    });
  });

  it('defaults builtinTimeToolEnabled to false, normalizes booleans, and excludes it from legacy import', () => {
    expect(defaultSettings().builtinTimeToolEnabled).toBe(false);
    expect(normalizeSettings({ builtinTimeToolEnabled: true }).builtinTimeToolEnabled).toBe(true);
    expect(normalizeSettings({ builtinTimeToolEnabled: 'yes' }).builtinTimeToolEnabled).toBe(false);
    expect(normalizeServerPreferences({ builtinTimeToolEnabled: true }).builtinTimeToolEnabled).toBe(true);

    const storeMap = new Map<string, string>([
      ['llmstudio.settings.v2', JSON.stringify({ themeMode: 'dark', builtinTimeToolEnabled: true })],
    ]);
    const storage: Storage = {
      length: 1,
      clear: () => storeMap.clear(),
      key: () => null,
      removeItem: (k) => { storeMap.delete(k); },
      getItem: (k) => storeMap.get(k) ?? null,
      setItem: (k, v) => { storeMap.set(k, v); },
    };
    const legacy = readLegacyPreferences(storage);
    expect(legacy).not.toBeNull();
    expect('builtinTimeToolEnabled' in (legacy as Record<string, unknown>)).toBe(false);
  });

  it('defaults mathRenderEnabled to true even when omitted by an older gateway, normalizes booleans, and excludes it from legacy import', () => {
    expect(defaultSettings().mathRenderEnabled).toBe(true);
    expect(normalizeSettings({ mathRenderEnabled: false }).mathRenderEnabled).toBe(false);
    expect(normalizeSettings({ mathRenderEnabled: 'no' }).mathRenderEnabled).toBe(true);
    expect(normalizeServerPreferences({}).mathRenderEnabled).toBe(true);
    expect(normalizeServerPreferences({ mathRenderEnabled: false }).mathRenderEnabled).toBe(false);

    const storeMap = new Map<string, string>([
      ['llmstudio.settings.v2', JSON.stringify({ themeMode: 'dark', mathRenderEnabled: false })],
    ]);
    const storage: Storage = {
      length: 1,
      clear: () => storeMap.clear(),
      key: () => null,
      removeItem: (k) => { storeMap.delete(k); },
      getItem: (k) => storeMap.get(k) ?? null,
      setItem: (k, v) => { storeMap.set(k, v); },
    };
    const legacy = readLegacyPreferences(storage);
    expect(legacy).not.toBeNull();
    expect('mathRenderEnabled' in (legacy as Record<string, unknown>)).toBe(false);
  });

  it('defaults graphMarkdownRender and graphVisualHtmlRender to true, preserves explicit false, and excludes them from legacy import', () => {
    expect(defaultSettings().graphMarkdownRender).toBe(true);
    expect(defaultSettings().graphVisualHtmlRender).toBe(true);
    expect(normalizeSettings({ graphMarkdownRender: false, graphVisualHtmlRender: false })).toMatchObject({
      graphMarkdownRender: false,
      graphVisualHtmlRender: false,
    });
    expect(normalizeSettings({ graphMarkdownRender: 'no', graphVisualHtmlRender: 0 })).toMatchObject({
      graphMarkdownRender: true,
      graphVisualHtmlRender: true,
    });
    expect(normalizeServerPreferences({})).toMatchObject({
      graphMarkdownRender: true,
      graphVisualHtmlRender: true,
    });
    expect(normalizeServerPreferences({ graphMarkdownRender: false, graphVisualHtmlRender: false })).toMatchObject({
      graphMarkdownRender: false,
      graphVisualHtmlRender: false,
    });

    const storeMap = new Map<string, string>([
      ['llmstudio.settings.v2', JSON.stringify({ themeMode: 'dark', graphMarkdownRender: false, graphVisualHtmlRender: false })],
    ]);
    const storage: Storage = {
      length: 1,
      clear: () => storeMap.clear(),
      key: () => null,
      removeItem: (k) => { storeMap.delete(k); },
      getItem: (k) => storeMap.get(k) ?? null,
      setItem: (k, v) => { storeMap.set(k, v); },
    };
    const legacy = readLegacyPreferences(storage);
    expect(legacy).not.toBeNull();
    expect('graphMarkdownRender' in (legacy as Record<string, unknown>)).toBe(false);
    expect('graphVisualHtmlRender' in (legacy as Record<string, unknown>)).toBe(false);
  });
});
