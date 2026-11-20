import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  Switch,
} from '../../components/ui';
import { validateGatewayUrl } from '../../core/gateway';

export function ConnectionPage() {
  const {
    gateway,
    isDesktop,
    desktopStatus,
    cloudConnectionState,
    connectionEpoch,
    settings,
    settingsNotice,
    dismissSettingsNotice,
    updatePreferences,
    connectionState,
    connectionError,
    saveConnection,
    testGatewayConnection,
    disconnectDesktopCloud,
    registerDirtyGuard,
    toast,
  } = useApp();

  const [savedDesktopUrl, setSavedDesktopUrl] = useState(
    desktopStatus?.gatewayBaseUrl ?? '',
  );
  const [tokenSet, setTokenSet] = useState(
    Boolean(desktopStatus?.tokenSet),
  );
  const [gatewayUrl, setGatewayUrl] = useState(
    isDesktop ? (desktopStatus?.gatewayBaseUrl ?? '') : settings.gatewayBaseUrl,
  );
  const [accessToken, setAccessToken] = useState(
    isDesktop ? '' : settings.accessToken,
  );
  const [showToken, setShowToken] = useState(false);

  const [urlError, setUrlError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Reset the draft only when the persisted connection actually changes, so the
  // mount-time effect cannot overwrite edits typed before React flushes effects.
  const syncedConnectionRef = useRef({
    gatewayBaseUrl: isDesktop
      ? (desktopStatus?.gatewayBaseUrl ?? '')
      : settings.gatewayBaseUrl,
    accessToken: isDesktop ? '' : settings.accessToken,
  });

  useEffect(() => {
    if (isDesktop) {
      let alive = true;
      void gateway
        .getDesktopConnection()
        .then((conn) => {
          if (!alive) return;
          setSavedDesktopUrl(conn.gatewayBaseUrl);
          setTokenSet(Boolean(conn.tokenSet));
          syncedConnectionRef.current = {
            gatewayBaseUrl: conn.gatewayBaseUrl,
            accessToken: '',
          };
          setGatewayUrl(conn.gatewayBaseUrl);
          setAccessToken('');
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }
    const { gatewayBaseUrl, accessToken } = settings;
    const synced = syncedConnectionRef.current;
    if (
      synced.gatewayBaseUrl === gatewayBaseUrl &&
      synced.accessToken === accessToken
    ) {
      return;
    }
    syncedConnectionRef.current = { gatewayBaseUrl, accessToken };
    setGatewayUrl(gatewayBaseUrl);
    setAccessToken(accessToken);
  }, [
    connectionEpoch,
    gateway,
    isDesktop,
    settings.accessToken,
    settings.gatewayBaseUrl,
  ]);

  const normalizedUrl = isDesktop ? gatewayUrl.trim() : gatewayUrl.trim() || '/';
  const isDirty = isDesktop
    ? normalizedUrl !== savedDesktopUrl || accessToken.trim() !== ''
    : normalizedUrl !== settings.gatewayBaseUrl ||
      accessToken.trim() !== settings.accessToken;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    registerDirtyGuard(() => isDirtyRef.current);
    return () => registerDirtyGuard(null);
  }, [registerDirtyGuard]);

  const validateDraftUrl = (raw: string): string | null => {
    if (isDesktop && (!raw || raw === '/')) {
      return '请输入完整的云端网关地址（如 https://example.com）';
    }
    return validateGatewayUrl(raw);
  };

  const handleTest = async () => {
    const err = validateDraftUrl(normalizedUrl);
    setUrlError(err);
    if (err) return;

    setTesting(true);
    setTestResult(null);
    try {
      const res = await testGatewayConnection({
        gatewayBaseUrl: normalizedUrl,
        accessToken,
      });
      if (res.ok) {
        const versionTag = res.health?.version
          ? ` · v${res.health.version}`
          : '';
        setTestResult({
          ok: true,
          text: `连接成功 · ${res.latencyMs ?? 0} ms${versionTag}`,
        });
      } else {
        setTestResult({
          ok: false,
          text: res.error ?? '连接失败',
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateDraftUrl(normalizedUrl);
    setUrlError(err);
    if (err) return;

    setSaving(true);
    setTestResult(null);
    try {
      const res = await saveConnection({
        gatewayBaseUrl: normalizedUrl,
        accessToken,
      });
      if (!res.ok) {
        setUrlError(res.error ?? '网关地址无效');
        return;
      }
      if (isDesktop) {
        setSavedDesktopUrl(normalizedUrl);
        if (accessToken.trim()) {
          setTokenSet(true);
          setAccessToken('');
        }
      }
      toast('连接已保存');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!isDesktop || disconnecting) return;
    setDisconnecting(true);
    setTestResult(null);
    setUrlError(null);
    try {
      await disconnectDesktopCloud();
      setSavedDesktopUrl('');
      setTokenSet(false);
      setGatewayUrl('');
      setAccessToken('');
      toast('已断开云端连接');
    } catch (err) {
      toast(err instanceof Error ? err.message : '断开连接失败', 'error');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="st-scroll">
      <div className="st-container">
        <h2 className="st-section-title">网关连接</h2>

        {settingsNotice ? (
          <ErrorBanner
            message={settingsNotice}
            action={
              <IconButton
                icon="close"
                size="sm"
                label="关闭"
                onClick={dismissSettingsNotice}
              />
            }
          />
        ) : null}

        {isDesktop ? (
          cloudConnectionState === 'auth-required' ? (
            <ErrorBanner message="云端需要有效访问令牌" />
          ) : cloudConnectionState === 'error' ? (
            <ErrorBanner message="云端网关连接失败" />
          ) : null
        ) : connectionError || connectionState === 'auth-required' ? (
          <ErrorBanner
            message={
              connectionError || '需要有效访问令牌'
            }
          />
        ) : null}

        <form
          noValidate
          onSubmit={(e) => void handleSave(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div className="st-group">
            <div className="st-row">
              <label className="st-row__label" htmlFor="conn-gateway-url">
                网关地址
              </label>
              <div className="st-row__control">
                <Field label="" htmlFor="conn-gateway-url" error={urlError}>
                  <Input
                    id="conn-gateway-url"
                    value={gatewayUrl}
                    onChange={(e) => {
                      setGatewayUrl(e.target.value);
                      if (urlError) setUrlError(null);
                    }}
                    placeholder={isDesktop ? 'https://example.com' : '/'}
                    required
                  />
                </Field>
              </div>
            </div>

            <div className="st-row">
              <label className="st-row__label" htmlFor="conn-access-token">
                访问令牌
              </label>
              <div className="st-row__control">
                <div className="ui-input-group">
                  <Input
                    id="conn-access-token"
                    type={showToken ? 'text' : 'password'}
                    value={accessToken}
                    placeholder={
                      isDesktop && tokenSet
                        ? '已保存访问令牌（留空保持不变）'
                        : undefined
                    }
                    onChange={(e) => setAccessToken(e.target.value)}
                    autoComplete="off"
                  />
                  <IconButton
                    size="sm"
                    icon={showToken ? 'eyeOff' : 'eye'}
                    label={showToken ? '隐藏令牌' : '显示令牌'}
                    onClick={() => setShowToken((v) => !v)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="st-actions-bar">
            <Button
              variant="secondary"
              disabled={testing || saving || disconnecting}
              onClick={() => void handleTest()}
            >
              {testing ? '测试中...' : '测试连接'}
            </Button>
            {testResult ? (
              <span
                role="status"
                className={`st-status-text ${
                  testResult.ok
                    ? 'st-status-text--ok'
                    : 'st-status-text--error'
                }`}
              >
                {testResult.text}
              </span>
            ) : null}
            <span className="st-actions-bar__spacer" />
            {isDesktop && (tokenSet || Boolean(savedDesktopUrl)) ? (
              <Button
                variant="danger-ghost"
                loading={disconnecting}
                disabled={saving || testing}
                onClick={() => void handleDisconnect()}
              >
                断开云端
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              disabled={saving || disconnecting}
            >
              {saving ? '保存中...' : '保存连接'}
            </Button>
          </div>
        </form>

        <section>
          <h3 className="st-subhead">请求缓存</h3>
          <div className="st-group">
            <div className="st-row--inline">
              <span className="st-row__label--plain">自动创建缓存</span>
              <Switch
                checked={settings.autoCreateCache}
                label="自动创建缓存"
                onCheckedChange={(autoCreateCache) =>
                  void updatePreferences({ autoCreateCache })
                }
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
