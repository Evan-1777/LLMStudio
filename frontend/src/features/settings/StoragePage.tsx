import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  IconButton,
  LoadingSpinner,
} from '../../components/ui';
import { openDesktopDataDir } from '../../core/desktop';
import { formatBytes } from '../../core/formatBytes';
import type { DesktopStorageUsage, StorageUsage } from '../../core/types';

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : '操作失败';
}

type CloudOperation = 'compact' | 'cleanup';
type LocalOperation = 'compact' | 'clearCache' | 'cleanup';

function UsageRows({ usage, loading }: { usage: StorageUsage | null; loading: boolean }) {
  if (!usage) {
    return (
      <div className="st-row st-row--inline">
        <span className="st-row__label--plain">磁盘占用</span>
        {loading ? (
          <LoadingSpinner size="sm" />
        ) : (
          <span className="st-row__value st-mono">—</span>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="st-row st-row--inline">
        <span className="st-row__label--plain">数据库文件</span>
        <span className="st-row__value st-mono">{formatBytes(usage.mainBytes)}</span>
      </div>
      <div className="st-row st-row--inline">
        <span className="st-row__label--plain">预写日志</span>
        <span className="st-row__value st-mono">{formatBytes(usage.walBytes)}</span>
      </div>
      <div className="st-row st-row--inline">
        <span className="st-row__label--plain">合计占用</span>
        <span className="st-row__value st-mono">{formatBytes(usage.totalBytes)}</span>
      </div>
    </>
  );
}

export function StoragePage() {
  const {
    gateway,
    isDesktop,
    desktopStatus,
    cloudConnectionState,
    connectionEpoch,
    cleanupUngroupedConversations,
    cleanupLocalUngrouped,
    toast,
  } = useApp();
  const location = useLocation();
  const navigate = useNavigate();

  // Cloud storage state
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(!isDesktop || cloudConnectionState === 'connected');
  const [operation, setOperation] = useState<CloudOperation | null>(null);
  const operationRef = useRef<CloudOperation | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [error, setError] = useState<{ action: 'load' | CloudOperation; message: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Desktop local storage state
  const [localUsage, setLocalUsage] = useState<DesktopStorageUsage | null>(null);
  const [localLoading, setLocalLoading] = useState(isDesktop);
  const [localOp, setLocalOp] = useState<LocalOperation | null>(null);
  const localOpRef = useRef<LocalOperation | null>(null);
  const [localCleanupOpen, setLocalCleanupOpen] = useState(false);
  const [localError, setLocalError] = useState<{ action: 'load' | LocalOperation; message: string } | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [localReloadToken, setLocalReloadToken] = useState(0);

  const epochRef = useRef(connectionEpoch);
  epochRef.current = connectionEpoch;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const redirectRemovedFromRoute = (
    deleted: Array<{ id: string; assistantId: string }>,
    scope?: 'local' | 'cloud',
  ) => {
    const state = location.state as { from?: string } | null;
    const fromPath =
      typeof state?.from === 'string' ? state.from.split(/[?#]/, 1)[0] : undefined;
    const source = deleted.find(({ id }) => fromPath === `/chat/${encodeURIComponent(id)}`);
    if (source) {
      const nextFrom = scope
        ? `/chat?assistant=${encodeURIComponent(source.assistantId)}&scope=${scope}`
        : `/chat?assistant=${encodeURIComponent(source.assistantId)}`;
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        {
          replace: true,
          state: { ...state, from: nextFrom },
        },
      );
    }
  };

  useEffect(() => {
    if (!isDesktop) return;
    const controller = new AbortController();
    const epoch = connectionEpoch;
    setLocalLoading(true);
    setLocalError((prev) => (prev?.action === 'load' ? null : prev));
    gateway
      .getDesktopStorage(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setLocalUsage(next);
      })
      .catch((err) => {
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setLocalError({ action: 'load', message: errorMessage(err) });
      })
      .finally(() => {
        if (!controller.signal.aborted && epoch === epochRef.current) {
          setLocalLoading(false);
        }
      });
    return () => controller.abort();
  }, [connectionEpoch, gateway, isDesktop, localReloadToken]);

  useEffect(() => {
    if (isDesktop && cloudConnectionState !== 'connected') {
      setUsage(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const epoch = connectionEpoch;
    setLoading(true);
    setError((previous) => (previous?.action === 'load' ? null : previous));
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
        if (!controller.signal.aborted && epoch === epochRef.current) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [cloudConnectionState, connectionEpoch, gateway, isDesktop, reloadToken]);

  const performLocal = async (action: LocalOperation) => {
    if (
      localOpRef.current ||
      (action === 'compact' && (localLoading || !localUsage?.compactable))
    ) {
      return;
    }
    const epoch = connectionEpoch;
    const isCurrent = () => mounted.current && epoch === epochRef.current;
    localOpRef.current = action;
    setLocalOp(action);
    setLocalError(null);
    setLocalStatus(null);
    try {
      if (action === 'compact') {
        const result = await gateway.compactLocalStorage();
        if (!isCurrent()) return;
        setLocalUsage((prev) =>
          prev
            ? { ...prev, ...result.usage }
            : prev,
        );
        setLocalStatus(
          result.freedBytes > 0
            ? `已释放 ${formatBytes(result.freedBytes)}`
            : '未释放空间',
        );
        setLocalReloadToken((v) => v + 1);
      } else if (action === 'clearCache') {
        await gateway.clearDesktopCache();
        if (!isCurrent()) return;
        setLocalStatus('缓存已清空');
      } else {
        const deleted = await cleanupLocalUngrouped();
        if (!deleted || !isCurrent()) return;
        setLocalStatus(
          deleted.length > 0 ? `已删除 ${deleted.length} 个话题` : '没有未分组话题',
        );
        redirectRemovedFromRoute(deleted, 'local');
        setLocalReloadToken((v) => v + 1);
      }
    } catch (err) {
      if (isCurrent()) setLocalError({ action, message: errorMessage(err) });
    } finally {
      localOpRef.current = null;
      if (mounted.current) {
        setLocalOp(null);
        if (action === 'cleanup') setLocalCleanupOpen(false);
      }
    }
  };

  const perform = async (action: CloudOperation) => {
    if (
      operationRef.current ||
      (action === 'compact' && (loading || !usage?.compactable))
    ) {
      return;
    }
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
        setStatus(
          result.freedBytes > 0
            ? `已释放 ${formatBytes(result.freedBytes)}`
            : '未释放空间',
        );
      } else {
        const deleted = await cleanupUngroupedConversations(
          isDesktop ? 'cloud' : undefined,
        );
        if (!deleted || !isCurrent()) return;
        setStatus(
          deleted.length > 0 ? `已删除 ${deleted.length} 个话题` : '没有未分组话题',
        );
        redirectRemovedFromRoute(deleted, isDesktop ? 'cloud' : undefined);
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

  const handleOpenDataDir = async () => {
    try {
      await openDesktopDataDir();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const activeDataDir = localUsage?.dataDir ?? desktopStatus?.dataDir ?? '';
  const activeMode = localUsage?.mode ?? desktopStatus?.mode;

  return (
    <div className="st-scroll">
      <div className="st-container">
        {isDesktop ? (
          <>
            <div className="st-section-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2 className="st-section-title">本地存储</h2>
                {activeMode ? (
                  <span className="st-badge st-badge--muted">
                    {activeMode === 'portable' ? '便携模式' : '安装模式'}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="st-group">
              <div className="st-row st-row--inline">
                <span className="st-row__label--plain">数据目录</span>
                <div className="st-path-row">
                  <span className="st-mono st-path-code" title={activeDataDir}>
                    {activeDataDir || '—'}
                  </span>
                  <IconButton
                    size="sm"
                    icon="folderOpen"
                    label="打开数据目录"
                    onClick={() => void handleOpenDataDir()}
                  />
                </div>
              </div>
              {localUsage ? (
                <div className="st-row st-row--inline">
                  <span className="st-row__label--plain">本地话题</span>
                  <span className="st-row__value st-mono">
                    {localUsage.conversationCount} 话题 · {localUsage.messageCount} 消息
                  </span>
                </div>
              ) : null}
              <UsageRows usage={localUsage} loading={localLoading} />
            </div>

            <div className="st-actions-bar">
              <Button
                variant="secondary"
                loading={localOp === 'compact'}
                disabled={localOp !== null || localLoading || !localUsage?.compactable}
                onClick={() => void performLocal('compact')}
              >
                压缩本地库
              </Button>
              <Button
                variant="secondary"
                loading={localOp === 'clearCache'}
                disabled={localOp !== null}
                onClick={() => void performLocal('clearCache')}
              >
                清空缓存
              </Button>
              <Button
                variant="danger-ghost"
                disabled={localOp !== null}
                onClick={() => setLocalCleanupOpen(true)}
              >
                删除本地未分组话题
              </Button>
              <div className="st-actions-bar__spacer" />
              {localStatus ? (
                <span className="st-status-text st-status-text--ok" role="status">
                  {localStatus}
                </span>
              ) : null}
            </div>

            {localError ? (
              <ErrorBanner
                message={localError.message}
                onRetry={
                  localOp
                    ? undefined
                    : () => {
                        if (localError.action === 'cleanup') setLocalCleanupOpen(true);
                        else if (localError.action === 'compact') void performLocal('compact');
                        else if (localError.action === 'clearCache') void performLocal('clearCache');
                        else setLocalReloadToken((v) => v + 1);
                      }
                }
              />
            ) : null}
          </>
        ) : null}

        <div className="st-section-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 className="st-section-title">{isDesktop ? '云端存储' : '存储'}</h2>
            {usage && !usage.compactable ? (
              <span className="st-badge st-badge--muted">内存数据库</span>
            ) : null}
          </div>
        </div>

        {isDesktop && cloudConnectionState !== 'connected' ? (
          <div className="st-group">
            <div className="st-row st-row--inline">
              <span className="st-row__label--plain">
                {cloudConnectionState === 'auth-required'
                  ? '云端需要有效访问令牌'
                  : cloudConnectionState === 'error'
                    ? '云端连接失败'
                    : '云端未连接'}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/settings/connection')}
              >
                前往连接
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="st-group">
              <UsageRows usage={usage} loading={loading} />
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
              <Button
                variant="danger-ghost"
                disabled={operation !== null}
                onClick={() => setCleanupOpen(true)}
              >
                删除未分组话题
              </Button>
              <div className="st-actions-bar__spacer" />
              {status ? (
                <span className="st-status-text st-status-text--ok" role="status">
                  {status}
                </span>
              ) : null}
            </div>

            {error ? (
              <ErrorBanner
                message={error.message}
                onRetry={
                  operation
                    ? undefined
                    : () => {
                        if (error.action === 'cleanup') setCleanupOpen(true);
                        else if (error.action === 'compact') void perform('compact');
                        else setReloadToken((v) => v + 1);
                      }
                }
              />
            ) : null}
          </>
        )}
      </div>

      <ConfirmDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        title={isDesktop ? '删除云端未分组话题' : '删除未分组话题'}
        message="删除所有助手的未分组话题及其消息，保留置顶和已分组话题。此操作无法撤销。"
        confirmLabel="删除"
        busy={operation === 'cleanup'}
        onConfirm={() => perform('cleanup')}
      />

      {isDesktop ? (
        <ConfirmDialog
          open={localCleanupOpen}
          onOpenChange={setLocalCleanupOpen}
          title="删除本地未分组话题"
          message="删除所有助手在本地数据库中的未分组话题及其消息，保留置顶和已分组话题。此操作无法撤销。"
          confirmLabel="删除"
          busy={localOp === 'cleanup'}
          onConfirm={() => performLocal('cleanup')}
        />
      ) : null}
    </div>
  );
}
