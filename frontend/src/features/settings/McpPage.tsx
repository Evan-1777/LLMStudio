import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  Input,
  LoadingSpinner,
  Switch,
} from '../../components/ui';
import type { MCPServerConfig, MCPServerTestResult } from '../../core/types';
import { McpEditor } from './McpEditor';
import { errorMessageOf } from './jsonValidation';

interface ServerProbeState {
  key: string;
  probing?: boolean;
  result?: MCPServerTestResult;
  error?: string;
}

function catalogKey(epoch: number, s: MCPServerConfig) {
  const pairs = (values?: Record<string, string>) => Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([epoch, s.id, s.transport, s.endpoint, s.command, s.args, pairs(s.env), pairs(s.headers)]);
}

function formatSchema(schema: unknown): string {
  if (schema === undefined || schema === null) return '{}';
  if (typeof schema === 'string') return schema;
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
}

function summarizeTarget(server: MCPServerConfig): string {
  if (server.transport === 'stdio') {
    const args = server.args?.join(' ') ?? '';
    return [server.command, args].filter(Boolean).join(' ').trim();
  }
  return server.endpoint ?? '';
}

export function McpPage() {
  const {
    gateway,
    connectionEpoch,
    resources,
    settings: { mcpMaxToolRounds },
    updatePreferences,
    refreshPlugins,
    upsertLocalMcpServer,
    removeLocalMcpServer,
    toast,
  } = useApp();
  const { mcpServers } = resources;
  const [roundsInput, setRoundsInput] = useState(String(mcpMaxToolRounds));
  const [roundsError, setRoundsError] = useState<string | null>(null);
  const [savingRounds, setSavingRounds] = useState(false);

  useEffect(() => setRoundsInput(String(mcpMaxToolRounds)), [mcpMaxToolRounds]);

  const saveRounds = async () => {
    const rounds = Number(roundsInput);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
      setRoundsError('须为 1–100 的整数');
      return;
    }
    if (rounds === mcpMaxToolRounds || savingRounds) return;
    setSavingRounds(true);
    const result = await updatePreferences({ mcpMaxToolRounds: rounds });
    setSavingRounds(false);
    if (!result.ok) setRoundsError(result.error ?? '保存失败');
  };

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MCPServerConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MCPServerConfig | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [probeById, setProbeById] = useState<Record<string, ServerProbeState>>({});

  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const keys = new Map(mcpServers.map((s) => [s.id, catalogKey(connectionEpoch, s)]));
  const currentKeys = useRef(keys);
  useLayoutEffect(() => {
    currentKeys.current = keys;
    return () => { currentKeys.current = new Map(); };
  });

  const handleProbe = async (server: MCPServerConfig) => {
    const key = keys.get(server.id)!;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const update = (state: Partial<ServerProbeState>) => {
      if (currentKeys.current.get(server.id) !== key) return;
      setProbeById((prev) => ({
        ...prev,
        [server.id]: { ...(prev[server.id]?.key === key ? prev[server.id] : {}), key, ...state },
      }));
    };
    update({ probing: true, error: undefined });
    try {
      update({ probing: false, result: await gateway.testMcpServer(server.id) });
    } catch (err) {
      update({ probing: false, error: errorMessageOf(err, '拉取工具失败') });
    } finally {
      pending.current.delete(key);
    }
  };

  const handleSave = async (server: MCPServerConfig, patch: { enabled: boolean } | { disabledTools: string[] }) => {
    const key = keys.get(server.id)!;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setSavingIds((prev) => new Set(prev).add(key));
    setActionError(null);
    try {
      const updated = await gateway.updateMcpServer(server.id, patch);
      if (currentKeys.current.get(server.id) === key) upsertLocalMcpServer(updated);
    } catch (err) {
      if (currentKeys.current.get(server.id) === key) setActionError(errorMessageOf(err, '更新 MCP 配置失败'));
    } finally {
      pending.current.delete(key);
      setSavingIds((prev) => new Set([...prev].filter((id) => id !== key)));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setActionError(null);
    try {
      await gateway.deleteMcpServer(deleteTarget.id);
      removeLocalMcpServer(deleteTarget.id);
      setDeleteTarget(null);
      toast('MCP 配置已删除');
    } catch (err) {
      setDeleteTarget(null);
      setActionError(errorMessageOf(err, '删除 MCP 配置失败'));
    } finally {
      setDeleting(false);
    }
  };

  if (resources.loading.plugins && mcpServers.length === 0) {
    return (
      <div className="st-scroll">
        <LoadingSpinner label="正在加载 MCP 配置" />
      </div>
    );
  }

  return (
    <div className="st-scroll">
      <div className="st-container">
        <div className="st-section-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 className="st-section-title">MCP 配置</h2>
            <span className="st-badge">{mcpServers.length}</span>
          </div>
          {mcpServers.length > 0 ? (
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              <Icon name="plus" size={15} />
              <span>添加配置</span>
            </Button>
          ) : null}
        </div>

        {resources.error.plugins ? (
          <ErrorBanner
            message={resources.error.plugins}
            onRetry={() => void refreshPlugins()}
          />
        ) : null}

        {actionError ? <ErrorBanner message={actionError} /> : null}

        <section>
          <h3 className="st-subhead">调用设置</h3>
          <div className="st-group">
            <div className="st-row">
              <label className="st-row__label" htmlFor="mcp-max-tool-rounds">最大工具调用轮次</label>
              <div className="st-row__control">
                <Input
                  id="mcp-max-tool-rounds"
                  type="number" min={1} max={100} step={1}
                  value={roundsInput}
                  readOnly={savingRounds}
                  aria-describedby={roundsError ? 'mcp-rounds-error' : undefined}
                  onChange={(event) => { setRoundsInput(event.target.value); setRoundsError(null); }}
                  onBlur={() => void saveRounds()}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                  style={{ width: 100 }}
                />
                {roundsError ? <span id="mcp-rounds-error" className="ui-field__error" role="alert">{roundsError}</span> : null}
              </div>
            </div>
          </div>
        </section>

        {mcpServers.length === 0 ? (
          <div className="st-group">
            <EmptyState
              icon="wrench"
              title="暂无 MCP 配置"
              action={
                <Button
                  variant="primary"
                  onClick={() => {
                    setEditing(null);
                    setEditorOpen(true);
                  }}
                >
                  添加配置
                </Button>
              }
            />
          </div>
        ) : (
          <div className="st-group">
            {mcpServers.map((server) => {
              const target = summarizeTarget(server);
              const key = keys.get(server.id)!;
              const probe = probeById[server.id]?.key === key ? probeById[server.id] : undefined;
              const saving = savingIds.has(key);
              const busy = saving || probe?.probing;
              const disabledTools = server.disabledTools ?? [];
              return (
                <div key={server.id} className="st-mcp-item">
                  <div className="st-model-row">
                    <div className="st-model-main">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          minWidth: 0,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span className="st-model-name">{server.name}</span>
                        <span className="st-badge">{server.transport}</span>
                        {probe?.error ? (
                          <span className="st-mcp-status st-mcp-status--err">拉取失败</span>
                        ) : probe?.result ? (
                          <span className="st-mcp-status st-mcp-status--ok">
                            已连通 · {probe.result.toolCount} 个工具 · {probe.result.latencyMs}ms
                          </span>
                        ) : null}
                      </div>
                      {target ? (
                        <span className="st-model-id">{target}</span>
                      ) : null}
                    </div>
                    <div className="st-model-meta">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={Boolean(probe?.probing)}
                        disabled={saving}
                        aria-label={`拉取工具 ${server.name}`}
                        onClick={() => void handleProbe(server)}
                      >
                        拉取工具
                      </Button>
                      <Switch
                        checked={server.enabled}
                        disabled={busy}
                        label={`启用 ${server.name}`}
                        onCheckedChange={(checked) =>
                          void handleSave(server, { enabled: checked })
                        }
                      />
                      <IconButton
                        size="sm"
                        icon="edit"
                        disabled={busy}
                        label={`编辑 ${server.name}`}
                        onClick={() => {
                          setEditing(server);
                          setEditorOpen(true);
                        }}
                      />
                      <IconButton
                        size="sm"
                        icon="trash"
                        disabled={busy}
                        tone="danger"
                        label={`删除 ${server.name}`}
                        onClick={() => setDeleteTarget(server)}
                      />
                    </div>
                  </div>
                  {probe && (probe.error || probe.result) ? (
                    <div className="st-mcp-probe" aria-label={`${server.name} 工具目录`}>
                      {probe.error ? (
                        <div className="st-mcp-probe__err" role="alert">
                          {probe.error}
                        </div>
                      ) : null}
                      {probe.result && probe.result.tools.length === 0 ? (
                        <div className="st-mcp-probe__empty">
                          {probe.result.message}（服务器未声明工具）
                        </div>
                      ) : probe.result ? (
                        <details key={key} className="st-mcp-catalog" open>
                          <summary>工具目录 · {probe.result.toolCount} 项</summary>
                          <div className="st-mcp-tool-list">
                            {probe.result.tools.map((tool) => (
                              <div key={tool.name} className="st-mcp-tool-card">
                                <details className="st-mcp-tool-card__details">
                                  <summary className="st-mcp-tool-card__name">{tool.name}</summary>
                                  {tool.title && tool.title !== tool.name && <div className="st-mcp-tool-card__desc">{tool.title}</div>}
                                  {tool.description && <div className="st-mcp-tool-card__desc">{tool.description}</div>}
                                  {tool.annotations?.readOnlyHint && <span className="st-badge">只读</span>}
                                  {tool.annotations?.destructiveHint && <span className="st-badge">破坏性</span>}
                                  {tool.inputSchema != null && <div className="st-mcp-tool-card__desc">参数 Schema<pre className="st-mcp-schema-pre"><code>{formatSchema(tool.inputSchema)}</code></pre></div>}
                                  {tool.outputSchema != null && <div className="st-mcp-tool-card__desc">输出 Schema<pre className="st-mcp-schema-pre"><code>{formatSchema(tool.outputSchema)}</code></pre></div>}
                                </details>
                                <Switch checked={!disabledTools.includes(tool.name)}
                                  disabled={!server.enabled || busy}
                                  label={'启用 ' + tool.name + '（' + server.name + '）'}
                                  onCheckedChange={(checked) => void handleSave(server, { disabledTools: checked
                                    ? disabledTools.filter((name) => name !== tool.name)
                                    : [...disabledTools, tool.name] })} />
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <McpEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        existing={editing}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除 MCP 配置？"
        message={`确认删除「${deleteTarget?.name ?? ''}」？`}
        confirmLabel="删除"
        busy={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
