import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import type { MCPServerConfig } from '../../core/types';
import { McpPage } from './McpPage';

interface McpMockState {
  servers: MCPServerConfig[];
  createBodies: Array<Record<string, unknown>>;
  updateBodies: Array<{ id: string; body: Record<string, unknown> }>;
  requestedUrls: string[];
}

function makeFetchMock(state: McpMockState) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    state.requestedUrls.push(`${method} ${url}`);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsedBody = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    if (url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ status: 'ok', version: '1.2.0', authRequired: false }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/v1/formats')) {
      return new Response(JSON.stringify({ formats: [], adapters: [] }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/providers')) {
      return new Response(JSON.stringify({ providers: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/assistants')) {
      return new Response(JSON.stringify({ assistants: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/conversations')) {
      return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
    }
    if (url.endsWith('/api/v1/plugins/search')) {
      return new Response(JSON.stringify({ engines: [] }), { status: 200 });
    }

    if (url.endsWith('/api/v1/mcp/servers') && method === 'GET') {
      return new Response(JSON.stringify({ servers: state.servers }), {
        status: 200,
      });
    }

    if (url.endsWith('/api/v1/mcp/servers') && method === 'POST') {
      state.createBodies.push(parsedBody);
      const created: MCPServerConfig = {
        id: `mcp-${state.servers.length + 1}`,
        name: String(parsedBody.name ?? ''),
        transport: String(parsedBody.transport ?? 'stdio'),
        command: String(parsedBody.command ?? ''),
        args: (parsedBody.args as string[]) ?? [],
        endpoint: String(parsedBody.endpoint ?? ''),
        env: (parsedBody.env as Record<string, string>) ?? {},
        headers: (parsedBody.headers as Record<string, string>) ?? {},
        enabled: parsedBody.enabled !== false,
      };
      state.servers = [...state.servers, created];
      return new Response(JSON.stringify({ server: created }), { status: 201 });
    }

    const itemMatch = url.match(/\/api\/v1\/mcp\/servers\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      if (method === 'PUT') {
        state.updateBodies.push({ id, body: parsedBody });
        state.servers = state.servers.map((s) =>
          s.id === id
            ? {
                ...s,
                name: String(parsedBody.name ?? s.name),
                transport: String(parsedBody.transport ?? s.transport),
                command:
                  typeof parsedBody.command === 'string'
                    ? parsedBody.command
                    : s.command,
                args: Array.isArray(parsedBody.args)
                  ? (parsedBody.args as string[])
                  : s.args,
                endpoint:
                  typeof parsedBody.endpoint === 'string'
                    ? parsedBody.endpoint
                    : s.endpoint,
                env:
                  parsedBody.env && typeof parsedBody.env === 'object'
                    ? (parsedBody.env as Record<string, string>)
                    : s.env,
                headers:
                  parsedBody.headers && typeof parsedBody.headers === 'object'
                    ? (parsedBody.headers as Record<string, string>)
                    : s.headers,
                disabledTools: (parsedBody.disabledTools as string[] | undefined) ?? s.disabledTools,
                updatedAt: String(state.updateBodies.length),
                enabled:
                  typeof parsedBody.enabled === 'boolean'
                    ? parsedBody.enabled
                    : s.enabled,
              }
            : s,
        );
        const updated = state.servers.find((s) => s.id === id)!;
        return new Response(JSON.stringify({ server: updated }), { status: 200 });
      }
      if (method === 'DELETE') {
        state.servers = state.servers.filter((s) => s.id !== id);
        return new Response(null, { status: 204 });
      }
    }

    return new Response('{}', { status: 200 });
  });
}

describe('McpPage and McpEditor', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('supports stdio/sse/streamable-http CRUD, field-level validation, transport switching without corruption, and omits runtime execution UI', async () => {
    const state: McpMockState = {
      servers: [],
      createBodies: [],
      updateBodies: [],
      requestedUrls: [],
    };

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={makeFetchMock(state)}>
        <MemoryRouter>
          <McpPage />
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('暂无 MCP 配置')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'MCP 配置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /测试/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/工具列表/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已连接/)).not.toBeInTheDocument();

    // Open Add modal; validate args must be JSON string array and env must be JSON object.
    await user.click(screen.getByRole('button', { name: '添加配置' }));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), 'filesystem');
    await user.type(within(dialog).getByLabelText('启动命令'), 'npx');

    // Preserve stdio fields across transport switches in dialog.
    const argsInput = within(dialog).getByLabelText('参数 (JSON 字符串数组)');
    await user.click(argsInput);
    await user.paste('[123]');

    await user.click(within(dialog).getByText('环境变量 (JSON)'));
    const envInput = within(dialog).getByLabelText('环境变量 (env)');
    await user.click(envInput);
    await user.paste('{"SECRET_TOKEN": 99}');

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(
      within(dialog).getByText('参数须为 JSON 字符串数组'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('环境变量的值须为字符串'),
    ).toBeInTheDocument();
    expect(state.createBodies).toHaveLength(0);

    // Fix stdio fields, switch to sse and back to stdio to verify state preservation.
    await user.clear(argsInput);
    await user.click(argsInput);
    await user.paste('["@modelcontextprotocol/server-filesystem","/tmp"]');
    await user.clear(envInput);
    await user.click(envInput);
    await user.paste('{"MCP_SECRET":"super-secret-value"}');

    await user.selectOptions(within(dialog).getByLabelText('传输方式'), 'sse');
    expect(within(dialog).getByLabelText('服务地址')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('传输方式'), 'stdio');
    expect(within(dialog).getByLabelText('启动命令')).toHaveValue('npx');
    expect(
      within(dialog).getByLabelText('参数 (JSON 字符串数组)'),
    ).toHaveValue('["@modelcontextprotocol/server-filesystem","/tmp"]');

    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });
    expect(state.createBodies[0]).toEqual({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { MCP_SECRET: 'super-secret-value' },
      enabled: true,
    });
    // Sensitive env values are never rendered in the list.
    expect(screen.queryByText(/super-secret-value/)).not.toBeInTheDocument();

    // Add streamable-http server.
    await user.click(screen.getByRole('button', { name: '添加配置' }));
    dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), 'remote-http');
    await user.selectOptions(
      within(dialog).getByLabelText('传输方式'),
      'streamable-http',
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByText('服务地址不能为空')).toBeInTheDocument();

    await user.type(
      within(dialog).getByLabelText('服务地址'),
      'https://mcp.example.com/http',
    );
    await user.click(within(dialog).getByText('请求头 (JSON)'));
    const headersInput = within(dialog).getByLabelText('请求头 (headers)');
    await user.click(headersInput);
    await user.paste('{"Authorization":"Bearer secret-hdr"}');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('remote-http')).toBeInTheDocument();
    });
    expect(state.createBodies[1]).toEqual({
      name: 'remote-http',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/http',
      headers: { Authorization: 'Bearer secret-hdr' },
      enabled: true,
    });
    expect(screen.queryByText(/secret-hdr/)).not.toBeInTheDocument();

    // Toggle enable & cancel/confirm delete.
    await user.click(screen.getByRole('switch', { name: '启用 remote-http' }));
    await waitFor(() => {
      expect(state.updateBodies).toHaveLength(1);
    });
    expect(state.updateBodies[0].body.enabled).toBe(false);

    await user.click(screen.getByRole('button', { name: '删除 remote-http' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(state.servers).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: '删除 remote-http' }));
    const confirmDialog = screen.getByRole('dialog');
    await user.click(
      within(confirmDialog).getByRole('button', { name: '删除' }),
    );
    await waitFor(() => {
      expect(state.servers).toHaveLength(1);
    });

    // Edit existing stdio server roundtrip and verify env details stays collapsed by default.
    await user.click(screen.getByRole('button', { name: '编辑 filesystem' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('环境变量 (env)')).not.toBeVisible();
    const editArgs = within(dialog).getByLabelText('参数 (JSON 字符串数组)');
    await user.clear(editArgs);
    await user.click(editArgs);
    await user.paste('["--readonly"]');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(state.updateBodies).toHaveLength(2);
    });
    expect(state.updateBodies[1].body.args).toEqual(['--readonly']);

    // Verify no runtime execution or tool endpoints were called during CRUD test.
    expect(
      state.requestedUrls.every((u) => !u.includes('/tools') && !u.includes('/test')),
    ).toBe(true);
  });

  it('pulls the catalog once, persists tool switches, and preserves the last successful catalog on failure', async () => {
    const user = userEvent.setup();
    let probeMode: 'ok' | 'empty' | 'error' = 'ok';
    const state: McpMockState = {
      servers: [
        {
          id: 'srv-probe',
          name: 'docs-server',
          transport: 'streamable-http',
          endpoint: 'https://mcp.example.com/rpc',
          args: [],
          enabled: true,
        },
      ],
      createBodies: [],
      updateBodies: [],
      requestedUrls: [],
    };
    let pulls = 0;
    const baseMock = makeFetchMock(state);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/mcp/servers/srv-probe/test')) {
        pulls++;
        if (probeMode === 'error') {
          return new Response(
            JSON.stringify({ code: 'UPSTREAM_ERROR', message: 'HTTP 401 unauthorized' }),
            { status: 502 },
          );
        }
        const tools =
          probeMode === 'empty'
            ? []
            : [
                {
                  name: 'read_doc',
                  description: 'Read documentation page',
                  inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
                  outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                  annotations: { readOnlyHint: true },
                },
              ];
        return new Response(
          JSON.stringify({
            ok: true,
            serverId: 'srv-probe',
            toolCount: tools.length,
            latencyMs: 12,
            message: `连接正常（${tools.length} 个工具）`,
            tools,
          }),
          { status: 200 },
        );
      }
      return baseMock(input, init);
    });

    render(
      <AppProvider fetchImpl={fetchMock}>
        <MemoryRouter>
          <McpPage />
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => expect(screen.getByText('docs-server')).toBeInTheDocument());

    const pull = screen.getByRole('button', { name: '拉取工具 docs-server' });
    await user.click(pull);
    const detail = await screen.findByText('read_doc');
    expect(pulls).toBe(1);
    expect(detail.closest('details')).not.toHaveAttribute('open');
    await user.click(detail);
    expect(screen.getByText('参数 Schema')).toBeVisible();
    const tool = screen.getByRole('switch', { name: '启用 read_doc（docs-server）' });
    await user.click(tool);
    await waitFor(() => expect(tool).not.toBeChecked());
    expect(state.updateBodies[0].body).toEqual({ disabledTools: ['read_doc'] });
    expect(detail).toBeVisible();
    expect(pulls).toBe(1);

    await user.click(screen.getByRole('switch', { name: '启用 docs-server' }));
    await waitFor(() => expect(tool).toBeDisabled());
    expect(tool).not.toBeChecked();

    probeMode = 'error';
    await user.click(pull);
    expect(await screen.findByText(/HTTP 401 unauthorized/)).toBeInTheDocument();
    expect(tool).toBeVisible();
    probeMode = 'ok';
    await user.click(pull);
    await waitFor(() => expect(pull).toBeEnabled());
    expect(tool).not.toBeChecked();

    probeMode = 'empty';
    await user.click(pull);
    expect(await screen.findByText(/服务器未声明工具/)).toBeVisible();
    expect(screen.queryByText('read_doc')).not.toBeInTheDocument();
  });
});
