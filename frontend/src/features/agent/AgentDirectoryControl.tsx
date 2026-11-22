import { useEffect, useRef, useState } from 'react';
import { Button, Icon, IconButton, Modal } from '../../components/ui';
import { pickDesktopDirectory } from '../../core/desktop';
import type { GatewayClient } from '../../core/gateway';
import type { AgentDirectory, AgentDirectoryListing, TopicScope } from '../../core/types';
import './agent.css';

export function directoryLabel(directory: AgentDirectory): string {
  if (directory.status === 'unset') return '未选择目录';
  return directory.path === '.' ? '工作区根目录' : directory.path;
}

interface DirectoryControlProps {
  gateway: GatewayClient;
  scope?: TopicScope;
  directory: AgentDirectory;
  disabled?: boolean;
  resetLabel?: string;
  onChoose: (path: string, signal: AbortSignal) => Promise<void>;
}

export function AgentDirectoryControl({ gateway, scope, directory, disabled, resetLabel, onChoose }: DirectoryControlProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), []);

  const begin = async (getPath: () => string | null | Promise<string | null>) => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setError('');
    setBusy(true);
    try {
      const path = await getPath();
      if (path === null || controller.signal.aborted) return;
      await onChoose(path, controller.signal);
      if (!controller.signal.aborted) setOpen(false);
    } catch {
      if (!controller.signal.aborted) setError('无法更新工作目录');
    } finally {
      action.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const select = () => {
    setError('');
    if (scope === 'local') {
      void begin(async () => (await pickDesktopDirectory(directory.status === 'ready' ? directory.path : '')) || null);
    } else {
      setOpen(true);
    }
  };

  const label = directoryLabel(directory);
  return (
    <div className="agent-directory" aria-busy={busy || undefined}>
      <span className="agent-directory__path" title={label}>{label}</span>
      {directory.status === 'unavailable' && <span className="agent-directory__state" role="status">目录不可用</span>}
      <IconButton icon="folderOpen" size="sm" label="选择工作目录" onClick={select} disabled={disabled || busy} />
      {resetLabel && (
        <IconButton icon="undo" size="sm" label={resetLabel} onClick={() => void begin(() => '')} disabled={disabled || busy} />
      )}
      {!open && error && <span className="agent-directory__state" role="alert">{error}</span>}
      {scope !== 'local' && (
        <GatewayDirectoryPicker
          open={open} onOpenChange={setOpen} gateway={gateway} scope={scope}
          initialPath={directory.status === 'ready' ? directory.path : '.'}
          busy={busy} saveError={error}
          onChoose={(path) => void begin(() => path)}
        />
      )}
    </div>
  );
}

function GatewayDirectoryPicker({ open, onOpenChange, gateway, scope, initialPath, busy, saveError, onChoose }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateway: GatewayClient;
  scope?: TopicScope;
  initialPath: string;
  busy: boolean;
  saveError: string;
  onChoose: (path: string) => void;
}) {
  const [navigation, setNavigation] = useState<{ path: string; attempt: number } | null>(null);
  const [result, setResult] = useState<{ path: string; attempt: number; listing: AgentDirectoryListing | null } | null>(null);
  const path = navigation?.path ?? (initialPath || '.');
  const attempt = navigation?.attempt ?? 0;
  const current = result?.path === path && result.attempt === attempt ? result : null;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void gateway.listAgentDirectories(path, scope, controller.signal).then(
      (listing) => { if (!controller.signal.aborted) setResult({ path, attempt, listing }); },
      () => { if (!controller.signal.aborted) setResult({ path, attempt, listing: null }); },
    );
    return () => controller.abort();
  }, [attempt, gateway, open, path, scope]);

  useEffect(() => {
    if (!open) { setNavigation(null); setResult(null); }
  }, [open]);

  const segments = path === '.' ? [] : path.split('/');
  const breadcrumbs = [{ label: '工作区', path: '.' }, ...segments.map((label, index) => ({ label, path: segments.slice(0, index + 1).join('/') }))];
  const navigate = (path: string) => setNavigation({ path, attempt: attempt + 1 });
  return (
    <Modal open={open} onOpenChange={onOpenChange} busy={busy} title="选择工作目录"
      footer={<><Button onClick={() => onOpenChange(false)} disabled={busy}>取消</Button><Button variant="primary" loading={busy} disabled={!current?.listing || busy} onClick={() => onChoose(current!.listing!.path)}>选择</Button></>}>
      <nav className="agent-breadcrumb" aria-label="当前目录">
        {breadcrumbs.map((item, index) => (
          <span key={item.path}>
            {index > 0 && <Icon name="chevronRight" size={13} />}
            {index === breadcrumbs.length - 1 ? <span aria-current="page">{item.label}</span> : <button type="button" disabled={busy} onClick={() => navigate(item.path)}>{item.label}</button>}
          </span>
        ))}
      </nav>
      <div className="agent-directory-list" aria-busy={!current}>
        {!current ? <p role="status">正在读取目录…</p>
          : !current.listing ? <div className="agent-directory-list__error"><span role="alert">无法读取目录</span><IconButton icon="refresh" label="重试读取目录" onClick={() => navigate(path)} /></div>
          : !current.listing.directories.length ? <p>没有子目录</p>
          : <ul>{current.listing.directories.map((name) => (
            <li key={name}><button type="button" disabled={busy} onClick={() => navigate(path === '.' ? name : path + '/' + name)}>
              <Icon name="folder" /><span>{name}</span><Icon name="chevronRight" size={14} />
            </button></li>
          ))}</ul>}
      </div>
      {saveError && <p className="agent-directory__state" role="alert">{saveError}</p>}
    </Modal>
  );
}
