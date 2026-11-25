import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CUSTOM_FONT_FAMILY,
  decodeCustomFontBuffer,
  deleteCachedCloudFont,
  deleteCustomFont as deleteStoredCustomFont,
  downloadVerifiedCloudFont,
  importCustomFont,
  loadStoredCustomFontFace,
  normalizeFontGatewayKey,
  readCachedCloudFont,
  readCustomFont,
  setStoredCustomFontEnabled,
  syncCloudCustomFont,
  validateAndDecodeCustomFontFile,
  writeCachedCloudFont,
} from '../core/customFont';
import { GatewayClient, GatewayError } from '../core/gateway';
import type { CloudConnectionState } from '../core/types';

export interface CustomFontInfo {
  name: string;
  enabled: boolean;
  sha256?: string;
  source?: 'cloud' | 'local';
}

function errorMessageOf(err: unknown): string {
  if (err instanceof GatewayError) return err.message;
  if (err instanceof Error) return err.message;
  return '操作失败';
}

export function useCustomFontManager({
  gateway,
  skipInitialBootstrap,
}: {
  gateway: GatewayClient;
  skipInitialBootstrap: boolean;
}) {
  const [customFont, setCustomFont] = useState<CustomFontInfo | null>(null);
  const [legacyCustomFont, setLegacyCustomFont] = useState<{ name: string } | null>(null);
  const [customFontBusy, setCustomFontBusy] = useState(false);
  const customFontFaceRef = useRef<FontFace | null>(null);
  const customFontRevisionRef = useRef(0);
  const customFontAbortRef = useRef<AbortController | null>(null);
  const cloudFontGatewayKeyRef = useRef<string | null>(null);

  const detachCustomFontFace = useCallback(() => {
    const face = customFontFaceRef.current;
    if (face) {
      document.fonts.delete(face);
      customFontFaceRef.current = null;
    }
    document.documentElement.style.removeProperty('--font-custom');
  }, []);

  const attachCustomFontFace = useCallback(
    (face: FontFace) => {
      detachCustomFontFace();
      document.fonts.add(face);
      customFontFaceRef.current = face;
      document.documentElement.style.setProperty(
        '--font-custom',
        `"${CUSTOM_FONT_FAMILY}", `,
      );
    },
    [detachCustomFontFace],
  );

  const resetCustomFontRuntime = useCallback(() => {
    customFontAbortRef.current?.abort();
    customFontAbortRef.current = null;
    customFontRevisionRef.current += 1;
    cloudFontGatewayKeyRef.current = null;
    detachCustomFontFace();
    setCustomFont(null);
    setLegacyCustomFont(null);
  }, [detachCustomFontFace]);

  const loadDeviceLegacyFont = useCallback(
    async (revision: number) => {
      const stored = await readCustomFont();
      if (revision !== customFontRevisionRef.current) return;
      if (!stored) {
        detachCustomFontFace();
        setCustomFont(null);
        return;
      }
      if (stored.enabled) {
        try {
          const face = await loadStoredCustomFontFace(stored);
          if (revision !== customFontRevisionRef.current) return;
          attachCustomFontFace(face);
        } catch {
          detachCustomFontFace();
        }
      } else {
        detachCustomFontFace();
      }
      if (revision === customFontRevisionRef.current) {
        setCustomFont({
          name: stored.name,
          enabled: stored.enabled,
          source: 'local',
        });
      }
    },
    [attachCustomFontFace, detachCustomFontFace],
  );

  const syncCustomFontForTarget = useCallback(
    async (
      targetGatewayUrl: string | null,
      cloudState: CloudConnectionState | 'connected',
    ): Promise<void> => {
      customFontAbortRef.current?.abort();
      const ctrl = new AbortController();
      customFontAbortRef.current = ctrl;
      const revision = ++customFontRevisionRef.current;

      const nextKey = targetGatewayUrl
        ? normalizeFontGatewayKey(targetGatewayUrl)
        : null;
      if (nextKey !== cloudFontGatewayKeyRef.current) {
        cloudFontGatewayKeyRef.current = nextKey;
        detachCustomFontFace();
        setCustomFont(null);
        setLegacyCustomFont(null);
      }

      if (!nextKey) {
        await loadDeviceLegacyFont(revision);
        return;
      }

      if (cloudState === 'auth-required') {
        detachCustomFontFace();
        setCustomFont(null);
        setLegacyCustomFont(null);
        return;
      }

      const result = await syncCloudCustomFont({
        gateway,
        gatewayKey: nextKey,
        signal: ctrl.signal,
        isCurrent: () => revision === customFontRevisionRef.current,
      });
      if (revision !== customFontRevisionRef.current) return;

      switch (result.kind) {
        case 'stale':
          return;
        case 'ready':
          if (result.face) {
            attachCustomFontFace(result.face);
          } else {
            detachCustomFontFace();
          }
          setCustomFont({
            name: result.font.name,
            enabled: result.font.enabled,
            sha256: result.font.sha256,
            source: 'cloud',
          });
          setLegacyCustomFont(null);
          return;
        case 'empty':
          detachCustomFontFace();
          setCustomFont(null);
          setLegacyCustomFont(result.legacyFont);
          return;
        case 'offline-cached':
          if (result.face) {
            attachCustomFontFace(result.face);
          } else {
            detachCustomFontFace();
          }
          setCustomFont({
            name: result.font.name,
            enabled: result.font.enabled,
            sha256: result.font.sha256,
            source: 'cloud',
          });
          setLegacyCustomFont(null);
          return;
        case 'auth-error':
          detachCustomFontFace();
          setCustomFont(null);
          setLegacyCustomFont(null);
          return;
        case 'disconnected':
          cloudFontGatewayKeyRef.current = null;
          detachCustomFontFace();
          setCustomFont(null);
          setLegacyCustomFont(null);
          await loadDeviceLegacyFont(revision);
          return;
        case 'error':
          return;
      }
    },
    [attachCustomFontFace, detachCustomFontFace, gateway, loadDeviceLegacyFont],
  );

  useEffect(() => {
    if (skipInitialBootstrap) {
      const revision = ++customFontRevisionRef.current;
      void loadDeviceLegacyFont(revision);
    }
    return () => {
      customFontAbortRef.current?.abort();
      customFontAbortRef.current = null;
      customFontRevisionRef.current += 1;
      detachCustomFontFace();
    };
  }, [detachCustomFontFace, loadDeviceLegacyFont, skipInitialBootstrap]);

  const uploadCustomFont = useCallback(
    async (file: File): Promise<{ ok: boolean; error?: string }> => {
      customFontAbortRef.current?.abort();
      customFontAbortRef.current = null;
      const revision = ++customFontRevisionRef.current;
      const gatewayKey = cloudFontGatewayKeyRef.current;
      setCustomFontBusy(true);
      try {
        if (!gatewayKey) {
          const { font, face } = await importCustomFont(file);
          if (revision !== customFontRevisionRef.current) return { ok: true };
          attachCustomFontFace(face);
          setCustomFont({ name: font.name, enabled: true, source: 'local' });
          setLegacyCustomFont(null);
          return { ok: true };
        }
        const decoded = await validateAndDecodeCustomFontFile(file);
        const meta = await gateway.uploadCustomFont(decoded.name, decoded.buffer);
        if (revision !== customFontRevisionRef.current) return { ok: true };
        attachCustomFontFace(decoded.face);
        setCustomFont({
          name: meta.name,
          enabled: meta.enabled,
          sha256: meta.sha256,
          source: 'cloud',
        });
        setLegacyCustomFont(null);
        await writeCachedCloudFont({
          gatewayKey,
          ...meta,
          blob: new Blob([decoded.buffer], { type: 'font/ttf' }),
        }).catch(() => {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessageOf(err) };
      } finally {
        if (revision === customFontRevisionRef.current) setCustomFontBusy(false);
      }
    },
    [attachCustomFontFace, gateway],
  );

  const toggleCustomFont = useCallback(
    async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      customFontAbortRef.current?.abort();
      customFontAbortRef.current = null;
      const revision = ++customFontRevisionRef.current;
      const gatewayKey = cloudFontGatewayKeyRef.current;
      setCustomFontBusy(true);
      try {
        if (!gatewayKey) {
          if (enabled) {
            const stored = await readCustomFont();
            if (!stored) throw new Error('没有可用的自定义字体');
            const face = await loadStoredCustomFontFace(stored);
            const saved = await setStoredCustomFontEnabled(true);
            if (revision !== customFontRevisionRef.current) return { ok: true };
            attachCustomFontFace(face);
            setCustomFont({ name: saved.name, enabled: true, source: 'local' });
          } else {
            const saved = await setStoredCustomFontEnabled(false);
            if (revision !== customFontRevisionRef.current) return { ok: true };
            detachCustomFontFace();
            setCustomFont({ name: saved.name, enabled: false, source: 'local' });
          }
          return { ok: true };
        }

        const meta = await gateway.setCustomFontEnabled(enabled);
        if (revision !== customFontRevisionRef.current) return { ok: true };
        if (meta.enabled) {
          const cached = await readCachedCloudFont(gatewayKey);
          if (revision !== customFontRevisionRef.current) return { ok: true };
          let face: FontFace;
          if (cached && cached.sha256 === meta.sha256) {
            face = await loadStoredCustomFontFace(cached);
            await writeCachedCloudFont({
              ...cached,
              name: meta.name,
              enabled: true,
              updatedAt: meta.updatedAt,
            }).catch(() => {});
          } else {
            const downloaded = await downloadVerifiedCloudFont(gateway, meta);
            if (!downloaded) throw new Error('云端字体已被移除');
            face = downloaded.face;
            await writeCachedCloudFont({
              gatewayKey,
              ...downloaded.meta,
              blob: new Blob([downloaded.buffer], { type: 'font/ttf' }),
            }).catch(() => {});
          }
          if (revision !== customFontRevisionRef.current) return { ok: true };
          attachCustomFontFace(face);
        } else {
          detachCustomFontFace();
          const cached = await readCachedCloudFont(gatewayKey);
          if (cached && cached.sha256 === meta.sha256) {
            await writeCachedCloudFont({
              ...cached,
              name: meta.name,
              enabled: false,
              updatedAt: meta.updatedAt,
            }).catch(() => {});
          }
        }
        setCustomFont({
          name: meta.name,
          enabled: meta.enabled,
          sha256: meta.sha256,
          source: 'cloud',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessageOf(err) };
      } finally {
        if (revision === customFontRevisionRef.current) setCustomFontBusy(false);
      }
    },
    [attachCustomFontFace, detachCustomFontFace, gateway],
  );

  const removeCustomFont = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
  }> => {
    customFontAbortRef.current?.abort();
    customFontAbortRef.current = null;
    const revision = ++customFontRevisionRef.current;
    const gatewayKey = cloudFontGatewayKeyRef.current;
    setCustomFontBusy(true);
    try {
      if (!gatewayKey) {
        await deleteStoredCustomFont();
        if (revision !== customFontRevisionRef.current) return { ok: true };
        detachCustomFontFace();
        setCustomFont(null);
        return { ok: true };
      }
      await gateway.deleteCustomFont();
      if (revision !== customFontRevisionRef.current) return { ok: true };
      detachCustomFontFace();
      setCustomFont(null);
      await deleteCachedCloudFont(gatewayKey).catch(() => {});
      const legacy = await readCustomFont();
      if (revision === customFontRevisionRef.current) {
        setLegacyCustomFont(legacy ? { name: legacy.name } : null);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessageOf(err) };
    } finally {
      if (revision === customFontRevisionRef.current) setCustomFontBusy(false);
    }
  }, [detachCustomFontFace, gateway]);

  const importLegacyCustomFont = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
  }> => {
    const gatewayKey = cloudFontGatewayKeyRef.current;
    if (!gatewayKey) {
      return { ok: false, error: '当前未连接云端网关' };
    }
    customFontAbortRef.current?.abort();
    customFontAbortRef.current = null;
    const revision = ++customFontRevisionRef.current;
    setCustomFontBusy(true);
    try {
      const legacy = await readCustomFont();
      if (!legacy) {
        throw new Error('没有可导入的旧字体');
      }
      const buffer = await legacy.blob.arrayBuffer();
      const face = await decodeCustomFontBuffer(buffer);
      const meta = await gateway.uploadCustomFont(legacy.name, buffer);
      if (revision !== customFontRevisionRef.current) return { ok: true };
      attachCustomFontFace(face);
      setCustomFont({
        name: meta.name,
        enabled: meta.enabled,
        sha256: meta.sha256,
        source: 'cloud',
      });
      setLegacyCustomFont(null);
      await writeCachedCloudFont({
        gatewayKey,
        ...meta,
        blob: new Blob([buffer], { type: 'font/ttf' }),
      }).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessageOf(err) };
    } finally {
      if (revision === customFontRevisionRef.current) setCustomFontBusy(false);
    }
  }, [attachCustomFontFace, gateway]);

  return {
    customFont,
    legacyCustomFont,
    customFontBusy,
    resetCustomFontRuntime,
    syncCustomFontForTarget,
    uploadCustomFont,
    toggleCustomFont,
    removeCustomFont,
    importLegacyCustomFont,
  };
}
