import { useApp, type ConnectionState } from '../../app/AppProvider';
import { ErrorBanner } from '../../components/ui';

function formatConnectionState(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return '已连接';
    case 'checking':
      return '正在连接';
    case 'auth-required':
      return '需要访问令牌';
    case 'error':
      return '连接失败';
  }
}

export function AboutPage() {
  const {
    gatewayHealth,
    connectionState,
    connectionError,
    settings,
    resources,
    retryConnection,
  } = useApp();

  const authStatusText = gatewayHealth
    ? gatewayHealth.authRequired
      ? '已启用'
      : '未启用'
    : '未知';

  return (
    <div className="st-scroll">
      <div className="st-container">
        <div className="st-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img
              src="/favicon.png"
              alt="LLMStudio"
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                objectFit: 'cover',
                display: 'block',
                flex: 'none',
              }}
            />
            <div>
              <h2 className="st-section-title">LLMStudio</h2>
              <div className="st-subtitle">
                {gatewayHealth?.version
                  ? `网关 ${gatewayHealth.version}`
                  : formatConnectionState(connectionState)}
              </div>
            </div>
          </div>
        </div>

        {connectionError ? (
          <ErrorBanner message={connectionError} onRetry={retryConnection} />
        ) : null}

        <div className="st-group">
          <div className="st-row--inline">
            <span className="st-row__label--plain">网关版本</span>
            <span className="st-row__value st-mono">
              {gatewayHealth?.version || '未知'}
            </span>
          </div>
          <div className="st-row--inline">
            <span className="st-row__label--plain">连接状态</span>
            <span className="st-row__value">
              {formatConnectionState(connectionState)}
            </span>
          </div>
          <div className="st-row--inline">
            <span className="st-row__label--plain">网关地址</span>
            <span className="st-row__value st-mono">
              {settings.gatewayBaseUrl}
            </span>
          </div>
          <div className="st-row--inline">
            <span className="st-row__label--plain">网关鉴权</span>
            <span className="st-row__value">{authStatusText}</span>
          </div>
          <div className="st-row--inline">
            <span className="st-row__label--plain">模型服务</span>
            <span className="st-row__value">{resources.providers.length}</span>
          </div>
          <div className="st-row--inline">
            <span className="st-row__label--plain">协议格式</span>
            <span className="st-row__value">{resources.formats.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
