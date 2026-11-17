import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  Button,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Switch,
  Textarea,
} from '../../components/ui';
import type {
  MCPServerConfig,
  MCPServerInput,
  MCPTransport,
} from '../../core/types';
import {
  errorMessageOf,
  parseJsonStringArray,
  parseJsonStringMap,
  validateHttpUrl,
} from './jsonValidation';

const TRANSPORTS: readonly MCPTransport[] = [
  'stdio',
  'sse',
  'streamable-http',
];

interface McpFieldErrors {
  name?: string;
  command?: string;
  args?: string;
  env?: string;
  endpoint?: string;
  headers?: string;
}

export interface McpEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: MCPServerConfig | null;
}

export function McpEditor({ open, onOpenChange, existing }: McpEditorProps) {
  const { gateway, upsertLocalMcpServer, toast } = useApp();

  const [name, setName] = useState('');
  const [transport, setTransport] = useState<MCPTransport>('stdio');
  const [enabled, setEnabled] = useState(true);

  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [envOpen, setEnvOpen] = useState(false);

  const [endpoint, setEndpoint] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [headersOpen, setHeadersOpen] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<McpFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    const t = existing?.transport;
    setTransport(
      t === 'sse' || t === 'streamable-http' ? t : 'stdio',
    );
    setEnabled(existing?.enabled ?? true);

    setCommand(existing?.command ?? '');
    setArgsText(
      existing?.args && existing.args.length > 0
        ? JSON.stringify(existing.args)
        : '',
    );
    setEnvText(
      existing?.env && Object.keys(existing.env).length > 0
        ? JSON.stringify(existing.env, null, 2)
        : '',
    );
    setEnvOpen(false);

    setEndpoint(existing?.endpoint ?? '');
    setHeadersText(
      existing?.headers && Object.keys(existing.headers).length > 0
        ? JSON.stringify(existing.headers, null, 2)
        : '',
    );
    setHeadersOpen(false);

    setFieldErrors({});
    setSubmitError(null);
  }, [open, existing]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errors: McpFieldErrors = {};

    const trimmedName = name.trim();
    if (!trimmedName) {
      errors.name = '名称不能为空';
    }

    let parsedArgs: string[] = [];
    let parsedEnv: Record<string, string> = {};
    let parsedHeaders: Record<string, string> = {};

    if (transport === 'stdio') {
      if (!command.trim()) {
        errors.command = '启动命令不能为空';
      }
      const argsRes = parseJsonStringArray(argsText, '参数');
      if (!argsRes.ok) errors.args = argsRes.error;
      else parsedArgs = argsRes.value;

      const envRes = parseJsonStringMap(envText, '环境变量');
      if (!envRes.ok) errors.env = envRes.error;
      else parsedEnv = envRes.value;
    } else {
      const urlErr = validateHttpUrl(endpoint, '服务地址');
      if (urlErr) errors.endpoint = urlErr;

      const headersRes = parseJsonStringMap(headersText, '请求头');
      if (!headersRes.ok) errors.headers = headersRes.error;
      else parsedHeaders = headersRes.value;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.env) setEnvOpen(true);
      if (errors.headers) setHeadersOpen(true);
      return;
    }

    setFieldErrors({});
    setSubmitError(null);

    const payload: MCPServerInput =
      transport === 'stdio'
        ? {
            name: trimmedName,
            transport,
            command: command.trim(),
            args: parsedArgs,
            env: parsedEnv,
            enabled,
          }
        : {
            name: trimmedName,
            transport,
            endpoint: endpoint.trim(),
            headers: parsedHeaders,
            enabled,
          };

    setSaving(true);
    try {
      const saved = existing
        ? await gateway.updateMcpServer(existing.id, payload)
        : await gateway.createMcpServer(payload);
      upsertLocalMcpServer(saved);
      onOpenChange(false);
      toast(existing ? 'MCP 配置已更新' : 'MCP 配置已添加');
    } catch (err) {
      setSubmitError(errorMessageOf(err, '保存 MCP 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={existing ? '编辑 MCP 配置' : '添加 MCP 配置'}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="mcp-editor-form"
            variant="primary"
            disabled={saving}
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </>
      }
    >
      <form
        id="mcp-editor-form"
        noValidate
        onSubmit={(e) => void handleSubmit(e)}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {submitError ? <ErrorBanner message={submitError} /> : null}

        <div className="st-grid-2">
          <Field label="名称" htmlFor="mcp-name" error={fieldErrors.name}>
            <Input
              id="mcp-name"
              placeholder="本地文件"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>

          <Field label="传输方式" htmlFor="mcp-transport">
            <Select
              id="mcp-transport"
              value={transport}
              onChange={(e) => {
                setFieldErrors({});
                setTransport(e.target.value as MCPTransport);
              }}
            >
              {TRANSPORTS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {transport === 'stdio' ? (
          <>
            <Field
              label="启动命令"
              htmlFor="mcp-command"
              error={fieldErrors.command}
            >
              <Input
                id="mcp-command"
                placeholder="npx"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                required
              />
            </Field>

            <Field
              label="参数 (JSON 字符串数组)"
              htmlFor="mcp-args"
              error={fieldErrors.args}
            >
              <Textarea
                id="mcp-args"
                rows={2}
                className="st-mono"
                placeholder='["@modelcontextprotocol/server-filesystem"]'
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
              />
            </Field>

            <details
              className="st-details"
              open={envOpen}
              onToggle={(e) => setEnvOpen(e.currentTarget.open)}
            >
              <summary className="st-details__summary">环境变量 (JSON)</summary>
              <div className="st-details__body">
                <Field
                  label="环境变量 (env)"
                  htmlFor="mcp-env"
                  error={fieldErrors.env}
                >
                  <Textarea
                    id="mcp-env"
                    rows={3}
                    className="st-mono"
                    placeholder="{}"
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                  />
                </Field>
              </div>
            </details>
          </>
        ) : (
          <>
            <Field
              label="服务地址"
              htmlFor="mcp-endpoint"
              error={fieldErrors.endpoint}
            >
              <Input
                id="mcp-endpoint"
                type="url"
                placeholder="https://mcp.example.com/sse"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                required
              />
            </Field>

            <details
              className="st-details"
              open={headersOpen}
              onToggle={(e) => setHeadersOpen(e.currentTarget.open)}
            >
              <summary className="st-details__summary">请求头 (JSON)</summary>
              <div className="st-details__body">
                <Field
                  label="请求头 (headers)"
                  htmlFor="mcp-headers"
                  error={fieldErrors.headers}
                >
                  <Textarea
                    id="mcp-headers"
                    rows={3}
                    className="st-mono"
                    placeholder="{}"
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                  />
                </Field>
              </div>
            </details>
          </>
        )}

        <div className="st-row--inline" style={{ padding: '4px 0', borderBottom: 0 }}>
          <span className="st-row__label--plain">启用</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} label="启用" />
        </div>
      </form>
    </Modal>
  );
}
