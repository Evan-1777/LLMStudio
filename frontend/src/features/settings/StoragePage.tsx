import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { Button, ErrorBanner, LoadingSpinner } from '../../components/ui';
import { formatBytes } from '../../core/formatBytes';
import type { StorageCompactResult, StorageUsage } from '../../core/types';

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : '操作失败';
}

export function StoragePage() {
  const { gateway, connectionEpoch } = useApp();

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<'load' | 'compact'>('load');
  const [status, setStatus] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const epochRef = useRef(connectionEpoch);
  epochRef.current = connectionEpoch;

  useEffect(() => {
    const controller = new AbortController();
    const epoch = connectionEpoch;
    setLoading(true);
    setError(null);
    setStatus(null);
    gateway
      .getStorage(controller.signal)
      .then((next) => {
        if (epoch !== epochRef.current) return;
        setUsage(next);
      })
      .catch((err) => {
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setError(errorMessage(err));
        setErrorAction('load');
      })
      .finally(() => {
        if (epoch === epochRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [gateway, connectionEpoch, reloadToken]);

  const runCompact = useCallback(async () => {
    if (compacting) return;
    const epoch = epochRef.current;
    setCompacting(true);
    setError(null);
    setStatus(null);
    try {
      const result: StorageCompactResult = await gateway.compactStorage();
      if (epoch !== epochRef.current) return;
      setUsage(result.usage);
      setStatus(
        result.freedBytes > 0
          ? `已释放 ${formatBytes(result.freedBytes)}`
          : '未释放空间',
      );
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setError(errorMessage(err));
      setErrorAction('compact');
    } finally {
      if (epoch === epochRef.current) setCompacting(false);
    }
  }, [compacting, gateway]);

  return (
    <div className="st-scroll">
      <div className="st-container">
        <div className="st-section-head">
          <h2 className="st-section-title">存储</h2>
          <p className="st-subtitle">本地数据库的磁盘占用与空间回收。</p>
        </div>

        <div className="st-group">
          {usage ? (
            <>
              <div className="st-row st-row--inline">
                <span className="st-row__label--plain">数据库文件</span>
                <span className="st-row__value st-mono">
                  {formatBytes(usage.mainBytes)}
                </span>
              </div>
              <div className="st-row st-row--inline">
                <span className="st-row__label--plain">预写日志</span>
                <span className="st-row__value st-mono">
                  {formatBytes(usage.walBytes)}
                </span>
              </div>
              <div className="st-row st-row--inline">
                <span className="st-row__label--plain">合计占用</span>
                <span className="st-row__value st-mono">
                  {formatBytes(usage.totalBytes)}
                </span>
              </div>
            </>
          ) : (
            <div className="st-row st-row--inline">
              <span className="st-row__label--plain">磁盘占用</span>
              {loading ? (
                <LoadingSpinner size="sm" />
              ) : (
                <span className="st-row__value st-mono">—</span>
              )}
            </div>
          )}
        </div>

        <div className="st-actions-bar">
          <Button
            variant="secondary"
            loading={compacting}
            disabled={compacting || loading || !usage?.compactable}
            onClick={() => void runCompact()}
          >
            压缩数据库
          </Button>
          <div className="st-actions-bar__spacer" />
          {status ? (
            <span className="st-status-text st-status-text--ok">{status}</span>
          ) : null}
        </div>

        {usage && !usage.compactable ? (
          <p className="st-subtitle">内存数据库不占用文件空间，无需压缩。</p>
        ) : null}

        {error ? (
          <ErrorBanner
            message={error}
            onRetry={() => {
              if (errorAction === 'compact') {
                void runCompact();
              } else {
                setReloadToken((v) => v + 1);
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
