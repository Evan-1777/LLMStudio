import { useState } from 'react';
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
import type { MCPServerConfig } from '../../core/types';
import { McpEditor } from './McpEditor';
import { errorMessageOf } from './jsonValidation';

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
              return (
                <div key={server.id} className="st-model-row">
                  <div className="st-model-main">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <span className="st-model-name">{server.name}</span>
                      <span className="st-badge">{server.transport}</span>
                    </div>
                    {target ? (
                      <span className="st-model-id">{target}</span>
                    ) : null}
                  </div>
                  <div className="st-model-meta">
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
