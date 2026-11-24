import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../app/AppProvider';
import {
  ConfirmDialog,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  LoadingSpinner,
} from '../../components/ui';
import { GatewayError, type GatewayClient } from '../../core/gateway';
import type {
  CloudConnectionState,
  TopicScope,
  WorkspaceEntriesResponse,
  WorkspaceEntry,
  WorkspaceSearchResponse,
} from '../../core/types';
import {
  WorkspaceMoveDialog,
  WorkspaceNameDialog,
  nextCopyName,
  parentDirOf,
  triggerBlobDownload,
  useWorkspaceMenuDialog,
  type WorkspaceNameDialogMode,
} from './WorkspaceDialogs';
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

export type WorkspaceCreateTrigger = 'file' | 'dir';

export interface WorkspaceDirsRefreshTrigger {
  dirs: string[];
  seq: number;
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

function isConflictError(err: unknown): boolean {
  return err instanceof GatewayError && (err.statusCode === 409 || err.code === 'CONFLICT');
}

function hasFileDragPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes('Files');
}

function ancestorDirsOf(dirPath: string): string[] {
  const parts = dirPath.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

export function WorkspaceFileTree({
  gateway,
  scope,
  isDesktop,
  cloudConnectionState,
  connectionEpoch,
  selectedPath,
  manageMode,
  createTrigger,
  onCreateTriggerConsumed,
  dirsRefreshTrigger,
  onManageModeChange,
  onAvailabilityChange,
  onSelectEntry,
  onEntryMoved,
  onEntriesDeleted,
}: {
  gateway: GatewayClient;
  scope?: TopicScope;
  isDesktop: boolean;
  cloudConnectionState: CloudConnectionState;
  connectionEpoch: number;
  selectedPath: string | null;
  manageMode: boolean;
  createTrigger?: WorkspaceCreateTrigger | null;
  onCreateTriggerConsumed?: () => void;
  dirsRefreshTrigger?: WorkspaceDirsRefreshTrigger | null;
  onManageModeChange: (next: boolean) => void;
  onAvailabilityChange?: (canMutate: boolean) => void;
  onSelectEntry: (entry: WorkspaceEntry, initialMode?: 'preview' | 'edit') => void;
  onEntryMoved?: (oldPath: string, nextEntry: WorkspaceEntry) => void;
  onEntriesDeleted?: (deletedPaths: string[]) => void;
}) {
  const { toast } = useApp();
  const { openAfterMenu, onCloseAutoFocus } = useWorkspaceMenuDialog();
  const cloudOffline = isDesktop && scope === 'cloud' && cloudConnectionState !== 'connected';

  const [dirMap, setDirMap] = useState<Record<string, DirState>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [rootUnconfigured, setRootUnconfigured] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<WorkspaceSearchResponse | null>(null);

  // Selection & row menu state
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);
  const [rootMenuPoint, setRootMenuPoint] = useState<{ x: number; y: number } | null>(null);

  // Dialogs state
  const [nameDialog, setNameDialog] = useState<{
    mode: WorkspaceNameDialogMode;
    parentDir: string;
    initialName: string;
    entryKind: 'file' | 'dir';
    targetPath?: string;
  } | null>(null);
  const [nameDialogBusy, setNameDialogBusy] = useState(false);
  const [nameDialogError, setNameDialogError] = useState<string | null>(null);

  const [moveDialog, setMoveDialog] = useState<{
    paths: string[];
    label: string;
    batch: boolean;
  } | null>(null);
  const [moveDialogBusy, setMoveDialogBusy] = useState(false);
  const [moveDialogError, setMoveDialogError] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    paths: string[];
    label: string;
    isDir: boolean;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Upload state & conflict prompt
  const [uploading, setUploading] = useState(false);
  const [uploadConflict, setUploadConflict] = useState<{
    path: string;
    resolve: (overwrite: boolean) => void;
  } | null>(null);
  const uploadTargetDirRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // External file drag-and-drop state
  const [rootDragOver, setRootDragOver] = useState(false);
  const [dragHoverDir, setDragHoverDir] = useState<string | null>(null);
  const dragDepthRef = useRef(0);

  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const searchAbortRef = useRef<AbortController | null>(null);
  const expandedRef = useRef(expandedDirs);
  expandedRef.current = expandedDirs;
  const dirMapRef = useRef(dirMap);
  dirMapRef.current = dirMap;

  const rootState = dirMap['.'];
  const rootLoading = loadingDirs.has('.');
  const rootError = dirErrors['.'];
  const canMutate = Boolean(!cloudOffline && rootState && !rootLoading && !rootUnconfigured && !rootError);

  useEffect(() => {
    onAvailabilityChange?.(canMutate);
    return () => onAvailabilityChange?.(false);
  }, [canMutate, onAvailabilityChange]);

  const trimmedSearch = searchQuery.trim();
  const isSearching = trimmedSearch.length > 0;

  const abortAll = useCallback(() => {
    for (const ctrl of controllersRef.current.values()) {
      ctrl.abort();
    }
    controllersRef.current.clear();
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
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
        return res.entries ?? [];
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

  const runSearch = useCallback(
    async (query: string) => {
      searchAbortRef.current?.abort();
      const ctrl = new AbortController();
      searchAbortRef.current = ctrl;
      setSearchLoading(true);
      setSearchError(null);
      try {
        const res = await gateway.searchWorkspaceEntries(query, scope, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setSearchResult(res);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setSearchError(err instanceof GatewayError ? err.message : '搜索失败');
      } finally {
        if (searchAbortRef.current === ctrl) searchAbortRef.current = null;
        if (!ctrl.signal.aborted) setSearchLoading(false);
      }
    },
    [gateway, scope],
  );

  const refreshDirs = useCallback(
    async (dirs: string[]) => {
      const unique = Array.from(new Set(dirs.map((d) => d || '.')));
      const entries = await Promise.all(unique.map((d) => loadDir(d)));
      if (trimmedSearch) {
        void runSearch(trimmedSearch);
      }
      return new Map(unique.map((dir, index) => [dir, entries[index]]));
    },
    [loadDir, runSearch, trimmedSearch],
  );

  const handleRefreshAll = useCallback(() => {
    if (cloudOffline) return;
    if (trimmedSearch) {
      void runSearch(trimmedSearch);
      return;
    }
    void loadDir('.');
    for (const dirPath of expandedRef.current) {
      void loadDir(dirPath);
    }
  }, [cloudOffline, loadDir, runSearch, trimmedSearch]);

  // Reset tree and abort in-flight work when gateway connection or cloud status resets.
  useEffect(() => {
    abortAll();
    setDirMap({});
    setExpandedDirs(new Set());
    setLoadingDirs(new Set());
    setDirErrors({});
    setRootUnconfigured(false);
    setSearchQuery('');
    setSearchResult(null);
    setSearchError(null);
    setSelectedPaths(new Set());
    setOpenMenuPath(null);
    setNameDialog(null);
    setMoveDialog(null);
    setDeleteConfirm(null);
    if (!cloudOffline) {
      void loadDir('.');
    }
    return abortAll;
  }, [abortAll, cloudOffline, connectionEpoch, loadDir, scope]);

  // Clear selection when exiting manage mode.
  useEffect(() => {
    if (manageMode) {
      setOpenMenuPath(null);
    } else {
      setSelectedPaths(new Set());
    }
  }, [manageMode]);

  // Header create trigger from ConversationSidebar.
  useEffect(() => {
    if (!createTrigger) return;
    onCreateTriggerConsumed?.();
    if (!canMutate) return;
    setNameDialogError(null);
    setNameDialog({
      mode: createTrigger === 'file' ? 'create-file' : 'create-dir',
      parentDir: '',
      initialName: '',
      entryKind: createTrigger,
    });
  }, [canMutate, createTrigger, onCreateTriggerConsumed]);

  // External targeted directory refresh (e.g. from WorkspaceFileViewer save/rename/delete).
  const lastDirsRefreshSeqRef = useRef(0);
  useEffect(() => {
    if (!dirsRefreshTrigger || dirsRefreshTrigger.seq === lastDirsRefreshSeqRef.current) return;
    lastDirsRefreshSeqRef.current = dirsRefreshTrigger.seq;
    if (cloudOffline) return;
    void refreshDirs(dirsRefreshTrigger.dirs);
  }, [cloudOffline, dirsRefreshTrigger, refreshDirs]);

  // Debounced workspace search (200ms).
  useEffect(() => {
    if (cloudOffline) return;
    if (!trimmedSearch) {
      searchAbortRef.current?.abort();
      setSearchResult(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void runSearch(trimmedSearch);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [cloudOffline, runSearch, trimmedSearch]);

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

  const revealDirFromSearch = (dirPath: string) => {
    setSearchQuery('');
    const ancestors = ancestorDirsOf(dirPath);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      return next;
    });
    void refreshDirs(['.', ...ancestors]);
  };

  const visibleRows = useMemo(() => {
    const rows: Array<
      | { kind: 'entry'; node: VisibleNode }
      | {
          kind: 'meta';
          key: string;
          depth: number;
          dirPath: string;
          variant: 'loading' | 'empty' | 'error' | 'truncated';
          message?: string;
        }
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

  const visibleSelectablePaths = useMemo(() => {
    if (isSearching) {
      return (searchResult?.entries ?? []).map((e) => e.path);
    }
    return visibleRows
      .filter((r): r is { kind: 'entry'; node: VisibleNode } => r.kind === 'entry')
      .map((r) => r.node.entry.path);
  }, [isSearching, searchResult, visibleRows]);

  const allVisibleSelected =
    visibleSelectablePaths.length > 0 &&
    visibleSelectablePaths.every((p) => selectedPaths.has(p));

  const toggleSelectPath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(visibleSelectablePaths));
    }
  };

  const migrateDirCachesOnRename = (oldPath: string, newPath: string) => {
    const oldPrefix = `${oldPath}/`;
    const isMigrated = (p: string) => p === oldPath || p.startsWith(oldPrefix);
    const remap = (p: string) => newPath + p.slice(oldPath.length);
    const refreshPaths = [...expandedRef.current].filter(isMigrated).map(remap);
    setExpandedDirs((prev) => new Set([...prev].map((p) => isMigrated(p) ? remap(p) : p)));
    setDirMap((prev) => {
      const next: Record<string, DirState> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (isMigrated(k)) continue;
        next[k] = v;
      }
      return next;
    });
    for (const [key, ctrl] of controllersRef.current) {
      if (!isMigrated(key)) continue;
      ctrl.abort();
      controllersRef.current.delete(key);
    }
    setLoadingDirs((prev) => new Set([...prev].filter((p) => !isMigrated(p))));
    setDirErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => !isMigrated(p))));
    return refreshPaths;
  };

  const pruneDirCachesOnDelete = (deletedPaths: string[]) => {
    const isAffected = (p: string) =>
      deletedPaths.some((d) => p === d || p.startsWith(`${d}/`));
    setExpandedDirs((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (!isAffected(p)) next.add(p);
      }
      return next;
    });
    setDirMap((prev) => {
      const next: Record<string, DirState> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!isAffected(k)) next[k] = v;
      }
      return next;
    });
    setSelectedPaths((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (!isAffected(p)) next.add(p);
      }
      return next;
    });
  };

  // --- CRUD Handlers ---
  const openCreateDialog = (kind: 'file' | 'dir', parentDir = '') => {
    setNameDialogError(null);
    setNameDialog({
      mode: kind === 'file' ? 'create-file' : 'create-dir',
      parentDir,
      initialName: '',
      entryKind: kind,
    });
  };

  const openRenameDialog = (entry: WorkspaceEntry) => {
    setNameDialogError(null);
    setNameDialog({
      mode: 'rename',
      parentDir: parentDirOf(entry.path),
      initialName: entry.name,
      entryKind: entry.kind,
      targetPath: entry.path,
    });
  };

  const revealCreatedEntry = async (entry: WorkspaceEntry) => {
    setSearchQuery('');
    const parent = parentDirOf(entry.path);
    const ancestors = parent ? ancestorDirsOf(parent) : [];
    setExpandedDirs((prev) => new Set([...prev, ...ancestors]));
    await Promise.all(['.', ...ancestors].map(loadDir));
  };

  const handleNameDialogSubmit = async (resolvedPath: string) => {
    if (!nameDialog) return;
    setNameDialogBusy(true);
    setNameDialogError(null);
    try {
      if (nameDialog.mode === 'create-file') {
        const created = await gateway.createWorkspaceFile({ path: resolvedPath, content: '' }, scope);
        await revealCreatedEntry(created);
        setNameDialog(null);
        toast('已创建文件');
        if (created.editable) {
          onSelectEntry(created, 'edit');
        }
      } else if (nameDialog.mode === 'create-dir') {
        const created = await gateway.createWorkspaceDir(resolvedPath, scope);
        await revealCreatedEntry(created);
        setNameDialog(null);
        toast('已创建文件夹');
      } else if (nameDialog.targetPath) {
        const moved = await gateway.moveWorkspaceEntry(
          { fromPath: nameDialog.targetPath, toPath: resolvedPath },
          scope,
        );
        const expanded = moved.kind === 'dir' ? migrateDirCachesOnRename(nameDialog.targetPath, moved.path) : [];
        await refreshDirs([parentDirOf(nameDialog.targetPath), parentDirOf(moved.path), ...expanded]);
        onEntryMoved?.(nameDialog.targetPath, moved);
        setNameDialog(null);
        toast('已重命名');
      }
    } catch (err) {
      setNameDialogError(err instanceof GatewayError ? err.message : '操作失败');
    } finally {
      setNameDialogBusy(false);
    }
  };

  const handleCopyEntry = async (entry: WorkspaceEntry) => {
    const parent = parentDirOf(entry.path);
    const parentKey = parent || '.';
    let siblings = dirMapRef.current[parentKey]?.entries;
    if (!siblings) {
      try {
        const res = await gateway.listWorkspaceEntries(parent, scope);
        siblings = res.entries ?? [];
      } catch {
        siblings = [];
      }
    }
    const existingNames = new Set(siblings.map((e) => e.name));
    const copyBase = nextCopyName(entry, existingNames);
    const toPath = parent ? `${parent}/${copyBase}` : copyBase;
    try {
      await gateway.copyWorkspaceEntry({ fromPath: entry.path, toPath }, scope);
      await refreshDirs([parent]);
      toast('已创建副本');
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '创建副本失败', 'error');
    }
  };

  const handleCopyPath = async (entry: WorkspaceEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
      toast('已复制路径');
    } catch {
      toast('无法写入剪贴板', 'error');
    }
  };

  const handleDownloadEntry = async (entry: WorkspaceEntry) => {
    try {
      const { blob, filename } = await gateway.downloadWorkspaceFile(entry.path, scope);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '下载失败', 'error');
    }
  };

  const handleMoveConfirm = async (targetDir: string) => {
    if (!moveDialog) return;
    setMoveDialogBusy(true);
    setMoveDialogError(null);
    try {
      if (!moveDialog.batch && moveDialog.paths.length === 1) {
        const fromPath = moveDialog.paths[0];
        const base = fromPath.split('/').pop() || fromPath;
        const toPath = targetDir ? `${targetDir}/${base}` : base;
        const moved = await gateway.moveWorkspaceEntry({ fromPath, toPath }, scope);
        const expanded = moved.kind === 'dir' ? migrateDirCachesOnRename(fromPath, moved.path) : [];
        const ancestors = expanded.length > 0 && targetDir ? ancestorDirsOf(targetDir) : [];
        if (ancestors.length > 0) setExpandedDirs((prev) => new Set([...prev, ...ancestors]));
        await refreshDirs([parentDirOf(fromPath), targetDir, ...ancestors, ...expanded]);
        onEntryMoved?.(fromPath, moved);
        setMoveDialog(null);
        toast('已移动');
      } else {
        const res = await gateway.batchWorkspaceEntries(
          { operation: 'move', paths: moveDialog.paths, targetDir },
          scope,
        );
        const affectedParents = new Set<string>([targetDir || '.']);
        const movedPaths = res.succeeded.map((oldPath) => {
          affectedParents.add(parentDirOf(oldPath) || '.');
          const base = oldPath.split('/').pop() || oldPath;
          const nextPath = targetDir ? `${targetDir}/${base}` : base;
          for (const path of migrateDirCachesOnRename(oldPath, nextPath)) affectedParents.add(path);
          return { oldPath, nextPath };
        });
        const refreshed = await refreshDirs([...affectedParents]);
        const destination = refreshed.get(targetDir || '.');
        for (const { oldPath, nextPath } of movedPaths) {
          if (selectedPath !== oldPath && !selectedPath?.startsWith(`${oldPath}/`)) continue;
          const entry = destination?.find((item) => item.path === nextPath);
          if (entry) onEntryMoved?.(oldPath, entry);
        }
        setSelectedPaths(new Set());
        setMoveDialog(null);
        if (res.failed.length > 0) {
          toast(`已移动 ${res.succeeded.length} 项，${res.failed.length} 项失败`, 'error');
        } else {
          toast(`已移动 ${res.succeeded.length} 项`);
        }
      }
    } catch (err) {
      setMoveDialogError(err instanceof GatewayError ? err.message : '移动失败');
    } finally {
      setMoveDialogBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;
    setDeleteBusy(true);
    try {
      const parents = new Set<string>();
      for (const p of deleteConfirm.paths) {
        parents.add(parentDirOf(p) || '.');
      }
      if (deleteConfirm.paths.length === 1) {
        const target = deleteConfirm.paths[0];
        await gateway.deleteWorkspaceEntry(target, scope);
        pruneDirCachesOnDelete([target]);
        onEntriesDeleted?.([target]);
        await refreshDirs(Array.from(parents));
        toast('已删除');
      } else {
        const res = await gateway.batchWorkspaceEntries(
          { operation: 'delete', paths: deleteConfirm.paths },
          scope,
        );
        if (res.succeeded.length > 0) {
          pruneDirCachesOnDelete(res.succeeded);
          onEntriesDeleted?.(res.succeeded);
        }
        await refreshDirs(Array.from(parents));
        if (res.failed.length > 0) {
          toast(`已删除 ${res.succeeded.length} 项，${res.failed.length} 项失败`, 'error');
        } else {
          toast(`已删除 ${res.succeeded.length} 项`);
        }
      }
      setDeleteConfirm(null);
    } catch (err) {
      toast(err instanceof GatewayError ? err.message : '删除失败', 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  // --- Upload flow (picker + external drag-and-drop) ---
  const askOverwrite = (path: string): Promise<boolean> =>
    new Promise((resolve) => {
      setUploadConflict({ path, resolve });
    });

  const uploadFilesToDir = async (files: File[], targetDir: string) => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    let uploadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    try {
      for (const file of files) {
        const relPath = targetDir ? `${targetDir}/${file.name}` : file.name;
        try {
          await gateway.uploadWorkspaceFile(relPath, file, { overwrite: false, scope });
          uploadedCount++;
        } catch (err) {
          if (isConflictError(err)) {
            const shouldOverwrite = await askOverwrite(relPath);
            if (!shouldOverwrite) {
              skippedCount++;
              continue;
            }
            try {
              await gateway.uploadWorkspaceFile(relPath, file, { overwrite: true, scope });
              uploadedCount++;
            } catch (retryErr) {
              failedCount++;
              toast(
                retryErr instanceof GatewayError ? retryErr.message : `上传 ${file.name} 失败`,
                'error',
              );
            }
          } else {
            failedCount++;
            toast(err instanceof GatewayError ? err.message : `上传 ${file.name} 失败`, 'error');
          }
        }
      }
      if (uploadedCount > 0) {
        if (targetDir) {
          setExpandedDirs((prev) => {
            const next = new Set(prev);
            for (const a of ancestorDirsOf(targetDir)) next.add(a);
            return next;
          });
        }
        await refreshDirs([targetDir || '.']);
        if (failedCount === 0) {
          toast(
            skippedCount > 0
              ? `已上传 ${uploadedCount} 个文件，跳过 ${skippedCount} 个`
              : `已上传 ${uploadedCount} 个文件`,
          );
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const triggerFilePicker = (targetDir = '') => {
    uploadTargetDirRef.current = targetDir;
    const input = fileInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) {
      void uploadFilesToDir(files, uploadTargetDirRef.current);
    }
  };

  const handleWrapDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (cloudOffline || rootUnconfigured || !hasFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setRootDragOver(true);
  };

  const handleWrapDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (cloudOffline || rootUnconfigured || !hasFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleWrapDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(e.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setRootDragOver(false);
      setDragHoverDir(null);
    }
  };

  const handleWrapDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    const targetDir = dragHoverDir ?? '';
    dragDepthRef.current = 0;
    setRootDragOver(false);
    setDragHoverDir(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) {
      void uploadFilesToDir(files, targetDir);
    }
  };

  const renderEntryMenu = (entry: WorkspaceEntry) => {
    const isDir = entry.kind === 'dir';
    const isOpen = openMenuPath === entry.path;
    return (
      <div
        className={`ws-tree-row__actions ${isOpen ? 'ws-tree-row__actions--open' : ''}`.trim()}
      >
        <Dropdown
          align="end"
          modal={false}
          onCloseAutoFocus={onCloseAutoFocus}
          open={isOpen}
          onOpenChange={(next) => setOpenMenuPath(next ? entry.path : null)}
          trigger={
            <IconButton
              size="sm"
              icon="ellipsis"
              label={`操作 ${entry.name}`}
            />
          }
        >
          {isDir ? (
            <>
              <DropdownItem onSelect={() => openAfterMenu(() => openCreateDialog('file', entry.path))}>
                <Icon name="filePlus" size={14} />
                <span>新建文件</span>
              </DropdownItem>
              <DropdownItem onSelect={() => openAfterMenu(() => openCreateDialog('dir', entry.path))}>
                <Icon name="folderPlus" size={14} />
                <span>新建文件夹</span>
              </DropdownItem>
              <DropdownItem onSelect={() => triggerFilePicker(entry.path)}>
                <Icon name="upload" size={14} />
                <span>上传至此</span>
              </DropdownItem>
              <DropdownSeparator />
            </>
          ) : (
            <DropdownItem onSelect={() => void handleDownloadEntry(entry)}>
              <Icon name="download" size={14} />
              <span>下载</span>
            </DropdownItem>
          )}
          <DropdownItem onSelect={() => openAfterMenu(() => openRenameDialog(entry))}>
            <Icon name="edit" size={14} />
            <span>重命名</span>
          </DropdownItem>
          <DropdownItem
            onSelect={() => openAfterMenu(() => {
              setMoveDialogError(null);
              setMoveDialog({ paths: [entry.path], label: entry.name, batch: false });
            })}
          >
            <Icon name="folderInput" size={14} />
            <span>移动</span>
          </DropdownItem>
          <DropdownItem onSelect={() => void handleCopyEntry(entry)}>
            <Icon name="copy" size={14} />
            <span>创建副本</span>
          </DropdownItem>
          <DropdownItem onSelect={() => void handleCopyPath(entry)}>
            <Icon name="link" size={14} />
            <span>复制路径</span>
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem
            danger
            onSelect={() => openAfterMenu(() => setDeleteConfirm({
              paths: [entry.path],
              label: entry.name,
              isDir,
            }))}
          >
            <Icon name="trash" size={14} />
            <span>删除</span>
          </DropdownItem>
        </Dropdown>
      </div>
    );
  };

  if (cloudOffline) {
    return (
      <div className="ws-tree-state">
        <EmptyState icon="cloud" title="云端未连接" />
      </div>
    );
  }

  return (
    <div
      className={`ws-panel ${rootDragOver && !dragHoverDir ? 'ws-panel--drop' : ''}`.trim()}
      onDragEnter={handleWrapDragEnter}
      onDragOver={handleWrapDragOver}
      onDragLeave={handleWrapDragLeave}
      onDrop={handleWrapDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleFileInputChange}
      />

      {!rootUnconfigured ? (
        <div className="ws-toolbar">
          <div className="ws-search-field">
            <Icon name="search" size={13} className="ws-search-field__icon" />
            <input
              type="search"
              className="ws-search-field__input"
              aria-label="搜索文件"
              placeholder="搜索文件"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery ? (
              <button
                type="button"
                className="ws-search-field__clear"
                aria-label="清空搜索"
                onClick={() => setSearchQuery('')}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
          <div className="ws-toolbar__actions">
            <IconButton
              size="sm"
              icon="upload"
              label="上传文件"
              loading={uploading}
              disabled={uploading}
              onClick={() => triggerFilePicker('')}
            />
            <IconButton
              size="sm"
              icon="collapseAll"
              label="全部折叠"
              disabled={expandedDirs.size === 0 || isSearching}
              onClick={() => setExpandedDirs(new Set())}
            />
            <IconButton
              size="sm"
              icon="refresh"
              label="刷新工作区文件"
              loading={rootLoading && !isSearching}
              onClick={handleRefreshAll}
            />
          </div>
        </div>
      ) : null}

      {manageMode && !rootUnconfigured ? (
        <div className="wb-manage-bar ws-manage-bar" role="region" aria-label="批量管理文件">
          <span className="wb-manage-bar__count">
            <span aria-hidden="true">{selectedPaths.size}</span>
            <span className="sr-only">已选 {selectedPaths.size} 项</span>
          </span>
          <div className="wb-manage-bar__actions">
            <IconButton
              size="sm"
              icon="checkSquare"
              active={allVisibleSelected}
              label={allVisibleSelected ? '取消全选' : '全选'}
              disabled={visibleSelectablePaths.length === 0}
              onClick={toggleSelectAllVisible}
            />
            <IconButton
              size="sm"
              icon="folderInput"
              label="批量移动"
              disabled={selectedPaths.size === 0}
              onClick={() => {
                setMoveDialogError(null);
                setMoveDialog({
                  paths: Array.from(selectedPaths),
                  label: `${selectedPaths.size} 项`,
                  batch: true,
                });
              }}
            />
            <button
              type="button"
              className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--danger wb-manage-bar__delete"
              aria-label={`删除 (${selectedPaths.size})`}
              title={`删除 (${selectedPaths.size})`}
              disabled={selectedPaths.size === 0}
              onClick={() =>
                setDeleteConfirm({
                  paths: Array.from(selectedPaths),
                  label: `${selectedPaths.size} 项`,
                  isDir: false,
                })
              }
            >
              <Icon name="trash" size={14} />
              <span className="wb-badge-count" aria-hidden="true">
                {selectedPaths.size}
              </span>
            </button>
            <IconButton
              size="sm"
              icon="close"
              label="退出管理"
              onClick={() => onManageModeChange(false)}
            />
          </div>
        </div>
      ) : null}

      <div
        className="ws-tree-scroll"
        onContextMenu={(event) => {
          if (event.defaultPrevented || !canMutate || manageMode) return;
          if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
          if (event.target.closest('button, input, a, .ws-tree-item')) return;
          event.preventDefault();
          setRootMenuPoint({ x: event.clientX, y: event.clientY });
          setOpenMenuPath('');
        }}
      >
        {rootMenuPoint && createPortal(
          <Dropdown
            modal={false}
            onCloseAutoFocus={onCloseAutoFocus}
            open={openMenuPath === ''}
            onOpenChange={(open) => setOpenMenuPath(open ? '' : null)}
            trigger={<span className="ws-root-menu-anchor" style={{ left: rootMenuPoint.x, top: rootMenuPoint.y }} />}
          >
            <DropdownItem onSelect={() => openAfterMenu(() => openCreateDialog('file'))}>
              <Icon name="filePlus" size={14} />
              <span>新建文件</span>
            </DropdownItem>
            <DropdownItem onSelect={() => openAfterMenu(() => openCreateDialog('dir'))}>
              <Icon name="folderPlus" size={14} />
              <span>新建文件夹</span>
            </DropdownItem>
            <DropdownItem disabled={uploading} onSelect={() => triggerFilePicker()}>
              <Icon name="upload" size={14} />
              <span>上传文件</span>
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={handleRefreshAll}>
              <Icon name="refresh" size={14} />
              <span>刷新</span>
            </DropdownItem>
          </Dropdown>, document.body,
        )}
        {rootLoading && !rootState && !isSearching ? (
          <div className="ws-tree-state">
            <LoadingSpinner label="加载工作区文件" />
          </div>
        ) : rootUnconfigured ? (
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
        ) : rootError && !rootState && !isSearching ? (
          <div className="ws-tree-state">
            <ErrorBanner message={rootError} onRetry={() => void loadDir('.')} />
          </div>
        ) : isSearching ? (
          <div className="ws-search-results" role="list" aria-label="文件搜索结果">
            {searchLoading && !searchResult ? (
              <div className="ws-tree-state">
                <LoadingSpinner label="搜索工作区文件" />
              </div>
            ) : searchError ? (
              <div className="ws-tree-state">
                <ErrorBanner message={searchError} onRetry={() => void runSearch(trimmedSearch)} />
              </div>
            ) : !searchResult || searchResult.entries.length === 0 ? (
              <div className="ws-tree-state">
                <EmptyState icon="search" title="无匹配文件" />
              </div>
            ) : (
              <>
                {searchResult.entries.map((entry) => {
                  const isDir = entry.kind === 'dir';
                  const isActive = !isDir && selectedPath === entry.path;
                  const parent = parentDirOf(entry.path);
                  const checked = selectedPaths.has(entry.path);
                  return (
                    <div
                      key={entry.path}
                      role="listitem"
                      className={`ws-tree-item ${isActive ? 'ws-tree-item--active' : ''}`.trim()}
                      onContextMenu={(e) => {
                        if (manageMode) return;
                        e.preventDefault();
                        setOpenMenuPath(entry.path);
                      }}
                    >
                      {manageMode ? (
                        <label className="ws-tree-check">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${entry.name}`}
                            checked={checked}
                            onChange={() => toggleSelectPath(entry.path)}
                          />
                        </label>
                      ) : null}
                      <button
                        type="button"
                        className="ws-search-row"
                        title={entry.path}
                        onClick={() => {
                          if (manageMode) {
                            toggleSelectPath(entry.path);
                          } else if (isDir) {
                            revealDirFromSearch(entry.path);
                          } else {
                            onSelectEntry(entry);
                          }
                        }}
                      >
                        <Icon
                          name={isDir ? 'folder' : fileIconName(entry)}
                          size={15}
                          className={`ws-tree-icon ${isDir ? 'ws-tree-icon--dir' : ''}`.trim()}
                        />
                        <span className="ws-search-row__body">
                          <span className="ws-tree-label">{entry.name}</span>
                          {parent ? (
                            <span className="ws-search-row__path">{parent}</span>
                          ) : null}
                        </span>
                      </button>
                      {!manageMode ? renderEntryMenu(entry) : null}
                    </div>
                  );
                })}
                {searchResult.truncated ? (
                  <div className="ws-tree-meta" style={{ paddingLeft: 12 }}>
                    <span>仅显示前 100 项</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : rootState && rootState.entries.length === 0 ? (
          <div className="ws-tree-state">
            <EmptyState
              icon="folder"
              title="工作区为空"
              action={
                <div className="ws-empty-actions">
                  <IconButton
                    size="sm"
                    icon="filePlus"
                    label="新建文件"
                    onClick={() => openCreateDialog('file', '')}
                  />
                  <IconButton
                    size="sm"
                    icon="folderPlus"
                    label="新建文件夹"
                    onClick={() => openCreateDialog('dir', '')}
                  />
                  <IconButton
                    size="sm"
                    icon="upload"
                    label="上传文件"
                    onClick={() => triggerFilePicker('')}
                  />
                </div>
              }
            />
          </div>
        ) : (
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
              const checked = selectedPaths.has(entry.path);
              const isDropTarget = isDir && dragHoverDir === entry.path;

              return (
                <div
                  key={entry.path}
                  className={[
                    'ws-tree-item',
                    isActive ? 'ws-tree-item--active' : '',
                    isDropTarget ? 'ws-tree-item--drop' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onContextMenu={(e) => {
                    if (manageMode) return;
                    e.preventDefault();
                    setOpenMenuPath(entry.path);
                  }}
                  onDragEnter={
                    isDir
                      ? (e) => {
                          if (!hasFileDragPayload(e.dataTransfer)) return;
                          e.preventDefault();
                          setDragHoverDir(entry.path);
                        }
                      : undefined
                  }
                  onDragOver={
                    isDir
                      ? (e) => {
                          if (!hasFileDragPayload(e.dataTransfer)) return;
                          e.preventDefault();
                          setDragHoverDir(entry.path);
                        }
                      : undefined
                  }
                  onDragLeave={
                    isDir
                      ? (e) => {
                          if (!hasFileDragPayload(e.dataTransfer)) return;
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            setDragHoverDir((cur) => (cur === entry.path ? null : cur));
                          }
                        }
                      : undefined
                  }
                >
                  {manageMode ? (
                    <label
                      className="ws-tree-check"
                      style={{ marginLeft: 4 + depth * 12 }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`选择 ${entry.name}`}
                        checked={checked}
                        onChange={() => toggleSelectPath(entry.path)}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={isDir ? expanded : undefined}
                    aria-selected={isDir ? undefined : isActive}
                    title={entry.path}
                    style={{ paddingLeft: manageMode ? 4 : 10 + depth * 14 }}
                    className={[
                      'ws-tree-row',
                      isActive ? 'ws-tree-row--active' : '',
                      isDot ? 'ws-tree-row--dot' : '',
                      isUnsupported ? 'ws-tree-row--muted' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (manageMode) {
                        if (isDir) toggleDir(entry);
                        else toggleSelectPath(entry.path);
                      } else if (isDir) {
                        toggleDir(entry);
                      } else {
                        onSelectEntry(entry);
                      }
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
                  {!manageMode ? renderEntryMenu(entry) : null}
                </div>
              );
            })}
            {rootState?.truncated ? (
              <div className="ws-tree-meta" style={{ paddingLeft: 14 }}>
                <span>仅显示前 500 项</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <WorkspaceNameDialog
        open={nameDialog !== null}
        mode={nameDialog?.mode ?? 'create-file'}
        parentDir={nameDialog?.parentDir ?? ''}
        initialName={nameDialog?.initialName ?? ''}
        entryKind={nameDialog?.entryKind ?? 'file'}
        busy={nameDialogBusy}
        error={nameDialogError}
        onOpenChange={(next) => {
          if (!next && !nameDialogBusy) {
            setNameDialog(null);
            setNameDialogError(null);
          }
        }}
        onSubmit={handleNameDialogSubmit}
      />

      <WorkspaceMoveDialog
        open={moveDialog !== null}
        gateway={gateway}
        scope={scope}
        sourcePaths={moveDialog?.paths ?? []}
        sourceLabel={moveDialog?.label ?? ''}
        busy={moveDialogBusy}
        error={moveDialogError}
        onOpenChange={(next) => {
          if (!next && !moveDialogBusy) {
            setMoveDialog(null);
            setMoveDialogError(null);
          }
        }}
        onConfirm={handleMoveConfirm}
      />

      <ConfirmDialog
        open={deleteConfirm !== null}
        onOpenChange={(next) => {
          if (!next && !deleteBusy) setDeleteConfirm(null);
        }}
        title={
          deleteConfirm && deleteConfirm.paths.length > 1
            ? `删除 ${deleteConfirm.paths.length} 项？`
            : deleteConfirm?.isDir
              ? '删除文件夹？'
              : '删除文件？'
        }
        message={
          deleteConfirm && deleteConfirm.paths.length > 1
            ? `确认永久删除选中的 ${deleteConfirm.paths.length} 项？此操作无法撤销。`
            : deleteConfirm?.isDir
              ? `确认永久删除文件夹「${deleteConfirm.label}」及其全部内容？此操作无法撤销。`
              : `确认永久删除「${deleteConfirm?.label ?? ''}」？此操作无法撤销。`
        }
        confirmLabel="删除"
        danger
        busy={deleteBusy}
        onConfirm={handleDeleteConfirm}
      />

      <ConfirmDialog
        open={uploadConflict !== null}
        onOpenChange={(next) => {
          if (!next && uploadConflict) {
            const { resolve } = uploadConflict;
            setUploadConflict(null);
            resolve(false);
          }
        }}
        title="覆盖已有文件？"
        message={`「${uploadConflict?.path ?? ''}」已存在，确认覆盖？`}
        confirmLabel="覆盖"
        cancelLabel="跳过"
        danger={false}
        onConfirm={() => {
          if (!uploadConflict) return;
          const { resolve } = uploadConflict;
          setUploadConflict(null);
          resolve(true);
        }}
      />
    </div>
  );
}
