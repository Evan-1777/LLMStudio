import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Button,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  LoadingSpinner,
} from '../components/ui';
import { useApp } from './AppProvider';

export function ConnectionGate({ children }: { children: ReactNode }) {
  const {
    connectionState,
    connectionError,
    settings,
    settingsNotice,
    dismissSettingsNotice,
    saveConnection,
    testGatewayConnection,
  } = useApp();

  const [gatewayUrl, setGatewayUrl] = useState(settings.gatewayBaseUrl);
  const [accessToken, setAccessToken] = useState(settings.accessToken);
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (connectionState === 'connected') {
    return <>{children}</>;
  }

  if (connectionState === 'checking') {
    return (
      <main className="gate-shell">
        <LoadingSpinner label="正在连接网关" />
      </main>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await saveConnection({
        gatewayBaseUrl: gatewayUrl,
        accessToken,
      });
      if (!res.ok) {
        setFormError(res.error ?? '网关地址无效');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async () => {
    setFormError(null);
    setTestResult(null);
    const res = await testGatewayConnection({
      gatewayBaseUrl: gatewayUrl,
      accessToken,
    });
    if (res.ok) {
      setTestResult({
        ok: true,
        text: `连接成功 · ${res.latencyMs ?? 0} ms`,
      });
    } else {
      setTestResult({
        ok: false,
        text: res.error ?? '连接失败',
      });
    }
  };

  return (
    <main className="gate-shell">
      <form className="gate-card" onSubmit={handleSubmit}>
        <div className="gate-head">
          <img src="/favicon.png" alt="" className="gate-logo" aria-hidden="true" />
          <div>
            <h1 className="gate-title">LLMStudio</h1>
            <p className="gate-sub">
              {connectionState === 'auth-required'
                ? '需要访问令牌'
                : '网关未连接'}
            </p>
          </div>
        </div>

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

        {connectionError ? <ErrorBanner message={connectionError} /> : null}

        <Field label="网关地址" htmlFor="gate-gateway-url" error={formError}>
          <Input
            id="gate-gateway-url"
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
            placeholder="/"
            required
          />
        </Field>

        <Field label="访问令牌" htmlFor="gate-access-token">
          <div className="ui-input-group">
            <Input
              id="gate-access-token"
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              autoComplete="current-password"
              autoFocus={connectionState === 'auth-required'}
            />
            <IconButton
              icon={showToken ? 'eyeOff' : 'eye'}
              label={showToken ? '隐藏令牌' : '显示令牌'}
              onClick={() => setShowToken((v) => !v)}
            />
          </div>
        </Field>

        {testResult ? (
          <div
            role="status"
            style={{
              fontSize: 12,
              color: testResult.ok ? 'var(--success)' : 'var(--danger)',
            }}
          >
            {testResult.text}
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 4,
          }}
        >
          <Button variant="secondary" onClick={handleTest} disabled={submitting}>
            测试连接
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? '连接中...' : '连接'}
          </Button>
        </div>
      </form>
    </main>
  );
}
