import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPLE_BLUE,
  LEGACY_FLUTTER_SETTINGS_KEY,
  SETTINGS_MIGRATED_KEY,
  SETTINGS_STORAGE_KEY,
  clearLegacyPreferences,
  defaultSettings,
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
      JSON.stringify({ ...defaultSettings(), themeMode: 'light', enterToSend: false }),
    );

    expect(readLegacyPreferences()).toMatchObject({
      themeMode: 'light',
      enterToSend: false,
    });

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
    });
    expect(readThemeHint('https://other.example')).toEqual({
      themeMode: 'light',
      seedColorValue: 0x007aff,
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
});
