import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Field,
  IconButton,
  Input,
} from '../../components/ui';
import { validateGatewayUrl } from '../../core/gateway';

export function ConnectionPage() {
  const {
    settings,
    settingsNotice,
    dismissSettingsNotice,
    connectionState,
    connectionError,
    saveConnection,
    testGatewayConnection,
    registerDirtyGuard,
    toast,
  } = useApp();

  const [gatewayUrl, setGatewayUrl] = useState(settings.gatewayBaseUrl);
  const [accessToken, setAccessToken] = useState(settings.accessToken);
  const [showToken, setShowToken] = useState(false);

  const [urlError, setUrlError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setGatewayUrl(settings.gatewayBaseUrl);
    setAccessToken(settings.accessToken);
  }, [settings.accessToken, settings.gatewayBaseUrl]);

  const normalizedUrl = gatewayUrl.trim() || '/';
  const isDirty =
    normalizedUrl !== settings.gatewayBaseUrl ||
    accessToken.trim() !== settings.accessToken;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    registerDirtyGuard(() => isDirtyRef.current);
    return () => registerDirtyGuard(null);
  }, [registerDirtyGuard]);

  const handleTest = async () => {
    const err = validateGatewayUrl(normalizedUrl);
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
    const err = validateGatewayUrl(normalizedUrl);
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
      toast('连接已保存');
    } finally {
      setSaving(false);
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
              <Button size="sm" variant="ghost" onClick={dismissSettingsNotice}>
                关闭
              </Button>
            }
          />
        ) : null}

        {connectionError || connectionState === 'auth-required' ? (
          <ErrorBanner
            message={
              connectionError || '网关需要有效访问令牌，请更新令牌后保存连接'
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
                    placeholder="/"
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
              disabled={testing || saving}
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
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? '保存中...' : '保存连接'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
