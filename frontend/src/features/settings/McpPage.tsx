import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  LoadingSpinner,
  Switch,
} from '../../components/ui';
import type { MCPServerConfig, MCPServerTestResult } from '../../core/types';
import { McpEditor } from './McpEditor';
import { errorMessageOf } from './jsonValidation';

interface ServerProbeState {
  probing: boolean;
  expanded: boolean;
  result?: MCPServerTestResult;
  error?: string;
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
    resources,
    refreshPlugins,
    upsertLocalMcpServer,
    removeLocalMcpServer,
    toast,
  } = useApp();
  const { mcpServers } = resources;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MCPServerConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MCPServerConfig | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [probeById, setProbeById] = useState<Record<string, ServerProbeState>>({});

  // Clear cached probe results when a server is edited, toggled, or deleted.
  const serverSignature = mcpServers
    .map((s) => `${s.id}:${s.enabled}:${s.updatedAt ?? ''}:${s.endpoint ?? ''}:${s.command ?? ''}`)
    .join('|');
  useEffect(() => {
    setProbeById((prev) => {
      const validIds = new Set(mcpServers.map((s) => s.id));
      const next: Record<string, ServerProbeState> = {};
      for (const [id, st] of Object.entries(prev)) {
        if (validIds.has(id) && st.probing) {
          next[id] = st;
        }
      }
      return Object.keys(next).length === 0 && Object.keys(prev).length === 0 ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSignature]);

  const handleProbe = async (server: MCPServerConfig) => {
    setProbeById((prev) => ({
      ...prev,
      [server.id]: {
        ...prev[server.id],
        probing: true,
        expanded: true,
      },
    }));
    try {
      const result = await gateway.testMcpServer(server.id);
      setProbeById((prev) => ({
        ...prev,
        [server.id]: { probing: false, expanded: true, result },
      }));
    } catch (err) {
      setProbeById((prev) => ({
        ...prev,
        [server.id]: {
          probing: false,
          expanded: true,
          error: errorMessageOf(err, '探测 MCP 工具目录失败'),
        },
      }));
    }
  };

  const handleToggle = async (server: MCPServerConfig, nextEnabled: boolean) => {
    setActionError(null);
    try {
      const updated = await gateway.updateMcpServer(server.id, {
        name: server.name,
        transport: server.transport,
        ...(server.transport === 'stdio'
          ? {
              command: server.command,
              args: server.args,
              env: server.env,
            }
          : {
              endpoint: server.endpoint,
              headers: server.headers,
            }),
        enabled: nextEnabled,
      });
      upsertLocalMcpServer(updated);
      toast(nextEnabled ? '配置已启用' : '配置已停用');
    } catch (err) {
      setActionError(errorMessageOf(err, '更新 MCP 配置失败'));
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
              const probe = probeById[server.id];
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
                        {probe?.result ? (
                          <span className="st-mcp-status st-mcp-status--ok">
                            已连通 · {probe.result.toolCount} 个工具 · {probe.result.latencyMs}ms
                          </span>
                        ) : probe?.error ? (
                          <span className="st-mcp-status st-mcp-status--err">
                            探测失败
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
                        aria-label={`探测 ${server.name}`}
                        onClick={() => void handleProbe(server)}
                      >
                        {probe?.probing ? '探测中…' : '探测'}
                      </Button>
                      <Switch
                        checked={server.enabled}
                        label={`启用 ${server.name}`}
                        onCheckedChange={(checked) =>
                          void handleToggle(server, checked)
                        }
                      />
                      <IconButton
                        size="sm"
                        icon="edit"
                        label={`编辑 ${server.name}`}
                        onClick={() => {
                          setEditing(server);
                          setEditorOpen(true);
                        }}
                      />
                      <IconButton
                        size="sm"
                        icon="trash"
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
                      ) : probe.result && probe.result.tools.length === 0 ? (
                        <div className="st-mcp-probe__empty">
                          {probe.result.message}（服务器未声明工具）
                        </div>
                      ) : probe.result ? (
                        <div className="st-mcp-tool-list">
                          {probe.result.tools.map((tool) => (
                            <div key={tool.name} className="st-mcp-tool-card">
                              <div className="st-mcp-tool-card__head">
                                <span className="st-mcp-tool-card__name">{tool.name}</span>
                                {tool.title && tool.title !== tool.name ? (
                                  <span className="st-badge">{tool.title}</span>
                                ) : null}
                                {tool.annotations?.readOnlyHint ? (
                                  <span className="st-badge">只读</span>
                                ) : null}
                                {tool.annotations?.destructiveHint ? (
                                  <span className="st-badge">破坏性</span>
                                ) : null}
                              </div>
                              {tool.description ? (
                                <div className="st-mcp-tool-card__desc">{tool.description}</div>
                              ) : null}
                              {tool.inputSchema ? (
                                <details className="st-mcp-tool-card__schema">
                                  <summary>参数 Schema</summary>
                                  <pre className="st-mcp-schema-pre">
                                    <code>{formatSchema(tool.inputSchema)}</code>
                                  </pre>
                                </details>
                              ) : null}
                              {tool.outputSchema ? (
                                <details className="st-mcp-tool-card__schema">
                                  <summary>输出 Schema</summary>
                                  <pre className="st-mcp-schema-pre">
                                    <code>{formatSchema(tool.outputSchema)}</code>
                                  </pre>
                                </details>
                              ) : null}
                            </div>
                          ))}
                        </div>
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
