import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import { Button, ConfirmDialog, ErrorBanner, LoadingSpinner } from '../../components/ui';
import { formatBytes } from '../../core/formatBytes';
import type { StorageUsage } from '../../core/types';

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : '操作失败';
}

type Operation = 'compact' | 'cleanup';

export function StoragePage() {
  const { gateway, connectionEpoch, cleanupUngroupedConversations } = useApp();
  const location = useLocation();
  const navigate = useNavigate();

  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<Operation | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [error, setError] = useState<{ action: 'load' | Operation; message: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const epochRef = useRef(connectionEpoch);
  epochRef.current = connectionEpoch;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = connectionEpoch;
    setLoading(true);
    setError((previous) => previous?.action === 'load' ? null : previous);
    gateway
      .getStorage(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setUsage(next);
      })
      .catch((err) => {
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setError({ action: 'load', message: errorMessage(err) });
      })
      .finally(() => {
        if (!controller.signal.aborted && epoch === epochRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [gateway, connectionEpoch, reloadToken]);

  const perform = async (action: Operation) => {
    if (operationRef.current || (action === 'compact' && (loading || !usage?.compactable))) return;
    const epoch = connectionEpoch;
    const isCurrent = () => mounted.current && epoch === epochRef.current;
    operationRef.current = action;
    setOperation(action);
    setError(null);
    setStatus(null);
    try {
      if (action === 'compact') {
        const result = await gateway.compactStorage();
        if (!isCurrent()) return;
        setUsage(result.usage);
        setStatus(result.freedBytes > 0 ? `已释放 ${formatBytes(result.freedBytes)}` : '未释放空间');
      } else {
        const deleted = await cleanupUngroupedConversations();
        if (!deleted || !isCurrent()) return;
        setStatus(deleted.length > 0 ? `已删除 ${deleted.length} 个话题` : '没有未分组话题');
        const state = location.state as { from?: string } | null;
        const fromPath = typeof state?.from === 'string' ? state.from.split(/[?#]/, 1)[0] : undefined;
        const source = deleted.find(({ id }) => fromPath === `/chat/${encodeURIComponent(id)}`);
        if (source) {
          navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
            replace: true,
            state: { ...state, from: `/chat?assistant=${encodeURIComponent(source.assistantId)}` },
          });
        }
        setReloadToken((v) => v + 1);
      }
    } catch (err) {
      if (isCurrent()) setError({ action, message: errorMessage(err) });
    } finally {
      operationRef.current = null;
      if (mounted.current) {
        setOperation(null);
        if (action === 'cleanup') setCleanupOpen(false);
      }
    }
  };

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
            loading={operation === 'compact'}
            disabled={operation !== null || loading || !usage?.compactable}
            onClick={() => void perform('compact')}
          >
            压缩数据库
          </Button>
          <Button variant="danger-ghost" disabled={operation !== null} onClick={() => setCleanupOpen(true)}>
            删除未分组话题
          </Button>
          <div className="st-actions-bar__spacer" />
          {status ? (
            <span className="st-status-text st-status-text--ok" role="status">{status}</span>
          ) : null}
        </div>

        {usage && !usage.compactable ? (
          <p className="st-subtitle">内存数据库不占用文件空间，无需压缩。</p>
        ) : null}

        {error ? (
          <ErrorBanner
            message={error.message}
            onRetry={operation ? undefined : () => {
              if (error.action === 'cleanup') setCleanupOpen(true);
              else if (error.action === 'compact') void perform('compact');
              else setReloadToken((v) => v + 1);
            }}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        title="删除未分组话题"
        message="删除所有助手的未分组话题及其消息，保留置顶和已分组话题。此操作无法撤销。"
        confirmLabel="删除"
        busy={operation === 'cleanup'}
        onConfirm={() => perform('cleanup')}
      />
    </div>
  );
}
