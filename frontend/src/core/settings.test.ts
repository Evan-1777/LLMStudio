import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPLE_BLUE,
  LEGACY_FLUTTER_SETTINGS_KEY,
  SETTINGS_MIGRATED_KEY,
  SETTINGS_STORAGE_KEY,
  defaultSettings,
  loadSettings,
  saveSettings,
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
      defaultHtmlPreview: false,
      autoCollapseEnabled: false,
      collapseLineThreshold: 200,
      collapseCharThreshold: 120,
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
      }),
    );

    const res = loadSettings();
    expect(res.settings.gatewayBaseUrl).toBe('https://new.example');
    expect(res.settings.themeMode).toBe('light');
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
