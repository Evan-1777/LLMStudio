import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, ErrorBanner, Icon, IconButton, LoadingSpinner } from '../../components/ui';
import { GatewayError, type GatewayClient } from '../../core/gateway';
import type {
  CloudConnectionState,
  TopicScope,
  WorkspaceEntriesResponse,
  WorkspaceEntry,
} from '../../core/types';
import './workspace.css';

interface DirState {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

interface VisibleNode {
  entry: WorkspaceEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  emptyDir: boolean;
  truncated: boolean;
}

function fileIconName(entry: WorkspaceEntry): 'fileText' | 'fileCode' | 'image' | 'file' {
  if (entry.previewKind === 'markdown') return 'fileText';
  if (entry.previewKind === 'text') return 'fileCode';
  if (entry.unsupportedReason === 'image') return 'image';
  return 'file';
}

function isWorkspaceUnsetError(err: unknown): boolean {
  if (!(err instanceof GatewayError)) return false;
  return err.code === 'INVALID_ARGUMENT' || err.message.includes('工作目录不可用');
}

export function WorkspaceFileTree({
  gateway,
  scope,
  isDesktop,
  cloudConnectionState,
  connectionEpoch,
  selectedPath,
  refreshToken,
  onSelectEntry,
}: {
  gateway: GatewayClient;
  scope?: TopicScope;
  isDesktop: boolean;
  cloudConnectionState: CloudConnectionState;
  connectionEpoch: number;
  selectedPath: string | null;
  refreshToken: number;
  onSelectEntry: (entry: WorkspaceEntry) => void;
}) {
  const cloudOffline = isDesktop && scope === 'cloud' && cloudConnectionState !== 'connected';

  const [dirMap, setDirMap] = useState<Record<string, DirState>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [rootUnconfigured, setRootUnconfigured] = useState(false);

  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const expandedRef = useRef(expandedDirs);
  expandedRef.current = expandedDirs;

  const abortAll = useCallback(() => {
    for (const ctrl of controllersRef.current.values()) {
      ctrl.abort();
    }
    controllersRef.current.clear();
  }, []);

  const loadDir = useCallback(
    async (relPath: string) => {
      const key = relPath || '.';
      controllersRef.current.get(key)?.abort();
      const ctrl = new AbortController();
      controllersRef.current.set(key, ctrl);

      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setDirErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (key === '.') {
        setRootUnconfigured(false);
      }

      try {
        const res: WorkspaceEntriesResponse = await gateway.listWorkspaceEntries(
          key === '.' ? '' : key,
          scope,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setDirMap((prev) => ({
          ...prev,
          [key]: { entries: res.entries ?? [], truncated: Boolean(res.truncated) },
        }));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (key === '.' && isWorkspaceUnsetError(err)) {
          setRootUnconfigured(true);
        } else {
          const msg = err instanceof GatewayError ? err.message : '无法读取目录';
          setDirErrors((prev) => ({ ...prev, [key]: msg }));
        }
      } finally {
        if (controllersRef.current.get(key) === ctrl) {
          controllersRef.current.delete(key);
        }
        if (!ctrl.signal.aborted) {
          setLoadingDirs((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [gateway, scope],
  );

  // Reset tree and abort in-flight work when gateway connection or cloud status resets.
  useEffect(() => {
    abortAll();
    setDirMap({});
    setExpandedDirs(new Set());
    setLoadingDirs(new Set());
    setDirErrors({});
    setRootUnconfigured(false);
    if (!cloudOffline) {
      void loadDir('.');
    }
    return abortAll;
  }, [abortAll, cloudOffline, connectionEpoch, loadDir, scope]);

  // Explicit refresh reloads root and all currently expanded directories.
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (initialMountRef.current) {
      initialMountRef.current = false;
      return;
    }
    if (cloudOffline || refreshToken === 0) return;
    void loadDir('.');
    for (const dirPath of expandedRef.current) {
      void loadDir(dirPath);
    }
  }, [cloudOffline, loadDir, refreshToken]);

  const toggleDir = (entry: WorkspaceEntry) => {
    const dirPath = entry.path;
    const isExpanded = expandedDirs.has(dirPath);
    if (isExpanded) {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
      return;
    }
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });
    if (!(dirPath in dirMap) && !loadingDirs.has(dirPath)) {
      void loadDir(dirPath);
    }
  };

  const visibleRows = useMemo(() => {
    const rows: Array<
      | { kind: 'entry'; node: VisibleNode }
      | { kind: 'meta'; key: string; depth: number; dirPath: string; variant: 'loading' | 'empty' | 'error' | 'truncated'; message?: string }
    > = [];

    const walk = (dirPath: string, depth: number) => {
      const state = dirMap[dirPath];
      if (!state) return;
      for (const entry of state.entries) {
        const isDir = entry.kind === 'dir';
        const expanded = isDir && expandedDirs.has(entry.path);
        const childState = isDir ? dirMap[entry.path] : undefined;
        rows.push({
          kind: 'entry',
          node: {
            entry,
            depth,
            expanded,
            loading: isDir && loadingDirs.has(entry.path),
            error: isDir ? (dirErrors[entry.path] ?? null) : null,
            emptyDir: Boolean(expanded && childState && childState.entries.length === 0),
            truncated: Boolean(expanded && childState?.truncated),
          },
        });
        if (expanded) {
          if (loadingDirs.has(entry.path) && !childState) {
            rows.push({ kind: 'meta', key: `loading:${entry.path}`, depth: depth + 1, dirPath: entry.path, variant: 'loading' });
          } else if (dirErrors[entry.path]) {
            rows.push({ kind: 'meta', key: `error:${entry.path}`, depth: depth + 1, dirPath: entry.path, variant: 'error', message: dirErrors[entry.path] });
          } else if (childState && childState.entries.length === 0) {
            rows.push({ kind: 'meta', key: `empty:${entry.path}`, depth: depth + 1, dirPath: entry.path, variant: 'empty' });
          } else {
            walk(entry.path, depth + 1);
            if (childState?.truncated) {
              rows.push({ kind: 'meta', key: `trunc:${entry.path}`, depth: depth + 1, dirPath: entry.path, variant: 'truncated' });
            }
          }
        }
      }
    };

    walk('.', 0);
    return rows;
  }, [dirErrors, dirMap, expandedDirs, loadingDirs]);

  if (cloudOffline) {
    return (
      <div className="ws-tree-state">
        <EmptyState icon="cloud" title="云端未连接" />
      </div>
    );
  }

  const rootState = dirMap['.'];
  const rootLoading = loadingDirs.has('.');
  const rootError = dirErrors['.'];

  if (rootLoading && !rootState) {
    return (
      <div className="ws-tree-state">
        <LoadingSpinner label="加载工作区文件" />
      </div>
    );
  }

  if (rootUnconfigured) {
    return (
      <div className="ws-tree-state">
        <EmptyState
          icon="folder"
          title="未配置工作区目录"
          action={
            <IconButton
              size="sm"
              icon="refresh"
              label="重新检测工作区"
              onClick={() => void loadDir('.')}
            />
          }
        />
      </div>
    );
  }

  if (rootError && !rootState) {
    return (
      <div className="ws-tree-state">
        <ErrorBanner message={rootError} onRetry={() => void loadDir('.')} />
      </div>
    );
  }

  if (rootState && rootState.entries.length === 0) {
    return (
      <div className="ws-tree-state">
        <EmptyState icon="folder" title="工作区为空" />
      </div>
    );
  }

  return (
    <div className="ws-tree" role="tree" aria-label="工作区文件">
      {rootError ? <ErrorBanner message={rootError} onRetry={() => void loadDir('.')} /> : null}
      {visibleRows.map((item) => {
        if (item.kind === 'meta') {
          const padLeft = 10 + item.depth * 14 + 16;
          if (item.variant === 'loading') {
            return (
              <div key={item.key} className="ws-tree-meta" style={{ paddingLeft: padLeft }}>
                <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
                <span>加载中…</span>
              </div>
            );
          }
          if (item.variant === 'error') {
            return (
              <div key={item.key} className="ws-tree-meta ws-tree-meta--error" style={{ paddingLeft: padLeft }}>
                <span className="ws-tree-meta__text" title={item.message}>{item.message}</span>
                <IconButton
                  size="sm"
                  icon="refresh"
                  label="重试加载目录"
                  onClick={() => void loadDir(item.dirPath)}
                />
              </div>
            );
          }
          return (
            <div key={item.key} className="ws-tree-meta" style={{ paddingLeft: padLeft }}>
              <span>{item.variant === 'empty' ? '空目录' : '仅显示前 500 项'}</span>
            </div>
          );
        }

        const { entry, depth, expanded, loading } = item.node;
        const isDir = entry.kind === 'dir';
        const isDot = entry.name.startsWith('.');
        const isUnsupported = !isDir && entry.previewKind === 'unsupported';
        const isActive = !isDir && selectedPath === entry.path;

        return (
          <button
            key={entry.path}
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={isDir ? expanded : undefined}
            aria-selected={isDir ? undefined : isActive}
            title={entry.path}
            style={{ paddingLeft: 10 + depth * 14 }}
            className={[
              'ws-tree-row',
              isActive ? 'ws-tree-row--active' : '',
              isDot ? 'ws-tree-row--dot' : '',
              isUnsupported ? 'ws-tree-row--muted' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              if (isDir) toggleDir(entry);
              else onSelectEntry(entry);
            }}
          >
            {isDir ? (
              loading ? (
                <span className="ws-tree-chevron"><span className="ui-spinner ui-spinner--sm" aria-hidden="true" /></span>
              ) : (
                <Icon
                  name="chevronRight"
                  size={12}
                  className={`ws-tree-chevron ${expanded ? 'ws-tree-chevron--open' : ''}`.trim()}
                />
              )
            ) : (
              <span className="ws-tree-chevron-spacer" aria-hidden="true" />
            )}
            <Icon
              name={isDir ? (expanded ? 'folderOpen' : 'folder') : fileIconName(entry)}
              size={15}
              className={`ws-tree-icon ${isDir ? 'ws-tree-icon--dir' : ''}`.trim()}
            />
            <span className="ws-tree-label">{entry.name}</span>
          </button>
        );
      })}
      {rootState?.truncated ? (
        <div className="ws-tree-meta" style={{ paddingLeft: 14 }}>
          <span>仅显示前 500 项</span>
        </div>
      ) : null}
    </div>
  );
}
