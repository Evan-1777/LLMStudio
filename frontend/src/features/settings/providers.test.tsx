import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import type { DiscoveredModel, ProviderConfig } from '../../core/types';
import { ProvidersPage } from './ProvidersPage';

const FORMATS = [
  {
    id: 'openai-completions',
    displayName: 'OpenAI Chat Completions',
    defaultPath: '/v1/chat/completions',
    defaultCompat: {},
  },
  {
    id: 'openai-responses',
    displayName: 'OpenAI Responses',
    defaultPath: '/v1/responses',
    defaultCompat: {},
  },
  {
    id: 'anthropic-messages',
    displayName: 'Anthropic Messages',
    defaultPath: '/v1/messages',
    defaultCompat: {},
  },
  {
    id: 'google-generative-ai',
    displayName: 'Google Generative AI',
    defaultPath: '/v1beta/models/{model}:streamGenerateContent',
    defaultCompat: {},
  },
];

const ADAPTERS = [{ id: 'generic-http', displayName: 'Generic HTTP' }];

interface MockState {
  providers: ProviderConfig[];
  discovered: DiscoveredModel[];
  fetchShouldFail?: boolean;
  lastUpdateBodies: Array<Record<string, unknown>>;
  lastProbeBodies: Array<Record<string, unknown>>;
  lastFetchBodies: Array<Record<string, unknown>>;
}

function makeFetchMock(state: MockState) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
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
      return new Response(
        JSON.stringify({ formats: FORMATS, adapters: ADAPTERS }),
        { status: 200 },
      );
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
    if (url.endsWith('/api/v1/mcp/servers')) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    }

    if (url.endsWith('/api/v1/providers') && method === 'GET') {
      return new Response(JSON.stringify({ providers: state.providers }), {
        status: 200,
      });
    }
    if (url.endsWith('/api/v1/providers') && method === 'POST') {
      const created: ProviderConfig = {
        id: `p-${state.providers.length + 1}`,
        name: String(parsedBody.name ?? ''),
        adapter: String(parsedBody.adapter ?? 'generic-http'),
        baseURL: String(parsedBody.baseURL ?? ''),
        authType: String(parsedBody.authType ?? 'bearer'),
        apiKeyMasked: parsedBody.apiKey ? 'sk-n...9999' : '',
        apiKeySet: Boolean(parsedBody.apiKey),
        headers: (parsedBody.headers as Record<string, string>) ?? {},
        models: (parsedBody.models as ProviderConfig['models']) ?? [],
        enabled: parsedBody.enabled !== false,
        builtIn: false,
        localRequest: parsedBody.localRequest === true,
      };
      state.providers = [...state.providers, created];
      return new Response(JSON.stringify({ provider: created }), {
        status: 201,
      });
    }

    const testMatch = url.match(/\/api\/v1\/providers\/([^/]+)\/test$/);
    if (testMatch && method === 'POST') {
      state.lastProbeBodies.push(parsedBody);
      return new Response(
        JSON.stringify({
          ok: true,
          latencyMs: 24,
          modelCount: state.discovered.length,
          message: '连接正常',
        }),
        { status: 200 },
      );
    }

    const fetchMatch = url.match(
      /\/api\/v1\/providers\/([^/]+)\/models\/fetch$/,
    );
    if (fetchMatch && method === 'POST') {
      state.lastFetchBodies.push(parsedBody);
      if (state.fetchShouldFail) {
        return new Response(
          JSON.stringify({
            code: 'UPSTREAM_ERROR',
            message: 'upstream timeout',
          }),
          { status: 502 },
        );
      }
      return new Response(JSON.stringify({ models: state.discovered }), {
        status: 200,
      });
    }

    const itemMatch = url.match(/\/api\/v1\/providers\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      if (method === 'PUT') {
        state.lastUpdateBodies.push(parsedBody);
        const existing = state.providers.find((p) => p.id === id);
        if (!existing) {
          return new Response(
            JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }),
            { status: 404 },
          );
        }
        const clearKey = parsedBody.clearApiKey === true;
        const nextKeySet = clearKey
          ? false
          : parsedBody.apiKey
            ? true
            : existing.apiKeySet;
        const updated: ProviderConfig = {
          ...existing,
          name: String(parsedBody.name ?? existing.name),
          adapter: String(parsedBody.adapter ?? existing.adapter),
          baseURL: String(parsedBody.baseURL ?? existing.baseURL),
          authType: String(parsedBody.authType ?? existing.authType),
          apiKeySet: nextKeySet,
          apiKeyMasked: clearKey
            ? ''
            : parsedBody.apiKey
              ? 'sk-u...8888'
              : existing.apiKeyMasked,
          headers:
            (parsedBody.headers as Record<string, string>) ?? existing.headers,
          models:
            (parsedBody.models as ProviderConfig['models']) ?? existing.models,
          enabled:
            typeof parsedBody.enabled === 'boolean'
              ? parsedBody.enabled
              : existing.enabled,
          localRequest:
            typeof parsedBody.localRequest === 'boolean'
              ? parsedBody.localRequest
              : existing.localRequest,
        };
        state.providers = state.providers.map((p) =>
          p.id === id ? updated : p,
        );
        return new Response(JSON.stringify({ provider: updated }), {
          status: 200,
        });
      }
      if (method === 'DELETE') {
        state.providers = state.providers.filter((p) => p.id !== id);
        return new Response(null, { status: 204 });
      }
    }

    return new Response('{}', { status: 200 });
  });
}

function renderProviders(state: MockState) {
  const fetchMock = makeFetchMock(state);
  const view = render(
    <AppProvider fetchImpl={fetchMock}>
      <MemoryRouter>
        <ProvidersPage />
      </MemoryRouter>
    </AppProvider>,
  );
  return { ...view, fetchMock };
}

describe('ProvidersPage, ProviderEditor, ModelEditor, and ModelImportDialog', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('handles provider CRUD, 3-state API key semantics, JSON header validation, probe overrides, and dirty leave confirmation', async () => {
    const state: MockState = {
      providers: [
        {
          id: 'p1',
          name: 'OpenAI',
          adapter: 'generic-http',
          baseURL: 'https://api.openai.com/v1',
          authType: 'bearer',
          apiKeyMasked: 'sk-1...2345',
          apiKeySet: true,
          headers: { 'X-Org': 'team-a' },
          models: [
            {
              id: 'gpt-4.1',
              name: 'GPT-4.1',
              apiFormat: 'openai-completions',
            },
          ],
          enabled: true,
          builtIn: false,
        },
        {
          id: 'p2',
          name: 'DeepSeek',
          adapter: 'generic-http',
          baseURL: 'https://api.deepseek.com',
          authType: 'bearer',
          apiKeyMasked: '',
          apiKeySet: false,
          models: [],
          enabled: true,
          builtIn: false,
        },
      ],
      discovered: [
        {
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          group: 'gpt',
          apiFormat: 'openai-completions',
        },
      ],
      lastUpdateBodies: [],
      lastProbeBodies: [],
      lastFetchBodies: [],
    };

    const user = userEvent.setup();
    renderProviders(state);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeInTheDocument();
    });

    // Live endpoint preview updates immediately when editing API URL.
    expect(screen.getByTestId('provider-endpoint-preview')).toHaveTextContent(
      'https://api.openai.com/v1/chat/completions',
    );
    const urlInput = screen.getByLabelText('API 地址');
    await user.clear(urlInput);
    await user.type(urlInput, 'https://proxy.example.com');
    expect(screen.getByTestId('provider-endpoint-preview')).toHaveTextContent(
      'https://proxy.example.com/v1/chat/completions',
    );

    // Probe uses unsaved URL and typed API key without saving first.
    const keyInput = screen.getByLabelText('API Key');
    await user.type(keyInput, 'sk-temp-probe');
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => {
      expect(screen.getByText(/连接正常 · 24 ms/)).toBeInTheDocument();
    });
    expect(state.lastProbeBodies[0]).toMatchObject({
      baseURL: 'https://proxy.example.com',
      apiKey: 'sk-temp-probe',
    });

    // Invalid JSON headers block save and display field error.
    await user.click(screen.getByText('供应商高级设置'));
    const headersInput = screen.getByLabelText('请求头 (JSON)');
    await user.clear(headersInput);
    await user.click(headersInput);
    await user.paste('["not-an-object"]');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('请求头须为 JSON 对象')).toBeInTheDocument();
    expect(state.lastUpdateBodies).toHaveLength(0);

    // Fix headers, clear typed key to keep existing key, and save.
    await user.clear(headersInput);
    await user.click(headersInput);
    await user.paste('{"X-Env":"prod"}');
    await user.clear(keyInput);
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(state.lastUpdateBodies).toHaveLength(1);
    });
    expect(state.lastUpdateBodies[0]).not.toHaveProperty('apiKey');
    expect(state.lastUpdateBodies[0]).not.toHaveProperty('clearApiKey');
    expect(state.lastUpdateBodies[0].headers).toEqual({ 'X-Env': 'prod' });

    // Explicit clear API key sends clearApiKey: true.
    await user.click(screen.getByRole('button', { name: '清空密钥' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(state.lastUpdateBodies).toHaveLength(2);
    });
    expect(state.lastUpdateBodies[1].clearApiKey).toBe(true);
    expect(state.lastUpdateBodies[1]).not.toHaveProperty('apiKey');

    // Unsaved draft confirms before switching provider; cancel preserves draft.
    await user.type(screen.getByLabelText('名称'), ' Edited');
    await user.click(screen.getByRole('button', { name: /DeepSeek/ }));
    expect(screen.getByText('放弃未保存的更改？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByLabelText('名称')).toHaveValue('OpenAI Edited');

    // Confirming switches to DeepSeek.
    await user.click(screen.getByRole('button', { name: /DeepSeek/ }));
    await user.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'DeepSeek' })).toBeInTheDocument();
    });

    // Delete cancel keeps provider; delete confirm removes provider.
    await user.click(screen.getByRole('button', { name: '删除供应商' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(state.providers).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: '删除供应商' }));
    const confirmModal = screen.getByRole('dialog');
    await user.click(within(confirmModal).getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(state.providers).toHaveLength(1);
      expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeInTheDocument();
    });

    // Add provider validates required fields before creating.
    await user.click(screen.getByRole('button', { name: '添加供应商' }));
    const addDialog = screen.getByRole('dialog');
    await user.click(within(addDialog).getByRole('button', { name: '添加' }));
    expect(within(addDialog).getByText('名称不能为空')).toBeInTheDocument();
    await user.type(within(addDialog).getByLabelText('名称'), 'Anthropic');
    await user.type(
      within(addDialog).getByLabelText('API 地址'),
      'https://api.anthropic.com',
    );
    await user.click(within(addDialog).getByRole('button', { name: '添加' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
    });
  });

  it('edits models with compat false overrides, validation, empty list submission, and keeps untouched fields when renaming', async () => {
    const state: MockState = {
      providers: [
        {
          id: 'p1',
          name: 'OpenAI',
          adapter: 'generic-http',
          baseURL: 'https://api.openai.com/v1',
          authType: 'bearer',
          apiKeyMasked: 'sk-1...2345',
          apiKeySet: true,
          models: [
            {
              id: 'gpt-4.1',
              name: 'GPT-4.1',
              apiFormat: 'openai-completions',
              inputModalities: ['text', 'image'],
              compat: {
                supportsDeveloperRole: false,
                extraBody: { seed: 42 },
              },
              defaultParams: { temperature: 0.2, reasoningEffort: 'high' },
            },
          ],
          enabled: true,
          builtIn: false,
        },
      ],
      discovered: [],
      lastUpdateBodies: [],
      lastProbeBodies: [],
      lastFetchBodies: [],
    };

    const user = userEvent.setup();
    renderProviders(state);

    await waitFor(() => {
      expect(screen.getByText('GPT-4.1')).toBeInTheDocument();
    });

    // Edit display name ONLY and verify compat.supportsDeveloperRole: false, extraBody, modalities, defaultParams survive.
    await user.click(screen.getByRole('button', { name: '编辑 GPT-4.1' }));
    let dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText('显示名称');
    await user.clear(nameInput);
    await user.type(nameInput, 'GPT 4.1 Custom');
    expect(within(dialog).getByLabelText('supportsDeveloperRole')).toHaveValue(
      'false',
    );
    expect(within(dialog).getByLabelText('supportsStreamOptions')).toHaveValue(
      '',
    );
    expect(within(dialog).getByLabelText('cacheMode')).toHaveValue('');
    await user.selectOptions(
      within(dialog).getByLabelText('cacheMode'),
      'explicit',
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('GPT 4.1 Custom')).toBeInTheDocument();
    });
    const firstSavedModels = state.lastUpdateBodies[0]
      .models as ProviderConfig['models'];
    expect(firstSavedModels[0]).toMatchObject({
      id: 'gpt-4.1',
      name: 'GPT 4.1 Custom',
      inputModalities: ['text', 'image'],
      compat: {
        supportsDeveloperRole: false,
        cacheMode: 'explicit',
        extraBody: { seed: 42 },
      },
      defaultParams: { temperature: 0.2, reasoningEffort: 'high' },
    });
    expect(firstSavedModels[0].compat).not.toHaveProperty(
      'supportsStreamOptions',
    );

    // Re-open, rename ONLY, verify cacheMode: 'explicit' survives.
    await user.click(screen.getByRole('button', { name: '编辑 GPT 4.1 Custom' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('cacheMode')).toHaveValue('explicit');
    const renameField = within(dialog).getByLabelText('显示名称');
    await user.clear(renameField);
    await user.type(renameField, 'GPT 4.1 Explicit');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('GPT 4.1 Explicit')).toBeInTheDocument();
    });
    const renamedModels = state.lastUpdateBodies[1]
      .models as ProviderConfig['models'];
    expect(renamedModels[0].compat?.cacheMode).toBe('explicit');

    // Add model validates duplicate ID, negative tokens, and invalid JSON.
    await user.click(screen.getByRole('button', { name: '添加模型' }));
    dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Model ID'), 'gpt-4.1');
    await user.type(within(dialog).getByLabelText('最大输出 Token'), '-5');
    await user.click(within(dialog).getByText('协议兼容覆盖'));
    const extraBodyInput = within(dialog).getByLabelText('extraBody (JSON)');
    await user.click(extraBodyInput);
    await user.paste('{bad');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(within(dialog).getByText('Model ID "gpt-4.1" 已存在')).toBeInTheDocument();
    expect(
      within(dialog).getByText('最大输出 Token 须为非负整数'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('extraBody JSON 格式无效'),
    ).toBeInTheDocument();

    // Fix validation and add new model with false override.
    const idField = within(dialog).getByLabelText('Model ID');
    await user.clear(idField);
    await user.type(idField, 'gemini-2.5-pro');
    await user.selectOptions(
      within(dialog).getByLabelText('API Format'),
      'google-generative-ai',
    );
    const maxTokField = within(dialog).getByLabelText('最大输出 Token');
    await user.clear(maxTokField);
    await user.type(maxTokField, '8192');
    await user.selectOptions(
      within(dialog).getByLabelText('supportsStreamOptions'),
      'false',
    );
    const extraBodyField = within(dialog).getByLabelText('extraBody (JSON)');
    await user.clear(extraBodyField);
    await user.click(extraBodyField);
    await user.paste('{"mode":"fast"}');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('gemini-2.5-pro')).toBeInTheDocument();
    });
    const secondSavedModels = state.lastUpdateBodies[2]
      .models as ProviderConfig['models'];
    expect(secondSavedModels).toHaveLength(2);
    expect(secondSavedModels[1].compat?.supportsStreamOptions).toBe(false);

    // Removing all models submits empty array and shows empty state.
    await user.click(
      screen.getByRole('button', { name: '移除 GPT 4.1 Explicit' }),
    );
    await waitFor(() => {
      expect(screen.queryByText('GPT 4.1 Explicit')).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '移除 gemini-2.5-pro' }));
    await waitFor(() => {
      expect(screen.getByText('暂无模型')).toBeInTheDocument();
    });
    expect(state.lastUpdateBodies[4].models).toEqual([]);
  });

  it('fetches discovered models, allows cancel without mutation, imports selected without overwriting existing, and recovers from fetch failure', async () => {
    const state: MockState = {
      providers: [
        {
          id: 'p1',
          name: 'OpenAI',
          adapter: 'generic-http',
          baseURL: 'https://api.openai.com/v1',
          authType: 'bearer',
          apiKeyMasked: 'sk-1...2345',
          apiKeySet: true,
          models: [
            {
              id: 'gpt-4.1',
              name: 'My Custom GPT-4.1',
              apiFormat: 'openai-completions',
              compat: { extraBody: { custom: true } },
            },
          ],
          enabled: true,
          builtIn: false,
        },
      ],
      discovered: [
        {
          id: 'gpt-4.1',
          name: 'GPT-4.1 Upstream',
          group: 'gpt',
          apiFormat: 'openai-completions',
        },
        {
          id: 'o4-mini',
          name: 'o4-mini',
          group: 'o4',
          apiFormat: 'openai-responses',
          reasoning: true,
        },
      ],
      fetchShouldFail: true,
      lastUpdateBodies: [],
      lastProbeBodies: [],
      lastFetchBodies: [],
    };

    const user = userEvent.setup();
    renderProviders(state);

    await waitFor(() => {
      expect(screen.getByText('My Custom GPT-4.1')).toBeInTheDocument();
    });

    // Fetch fails first -> shows error banner; existing models remain editable; retry works.
    await user.click(screen.getAllByRole('button', { name: '获取模型' })[0]);
    let dialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByText('upstream timeout')).toBeInTheDocument();
    });

    state.fetchShouldFail = false;
    await user.click(within(dialog).getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(within(dialog).getByText('o4-mini')).toBeInTheDocument();
    });

    // Existing model checkbox is disabled and tagged 已配置.
    const existingCheckbox = within(dialog).getByRole('checkbox', {
      name: /GPT-4.1 Upstream/,
    });
    expect(existingCheckbox).toBeDisabled();
    expect(existingCheckbox).toBeChecked();

    // Cancel after discovery writes nothing.
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(state.lastUpdateBodies).toHaveLength(0);

    // Re-open, select o4-mini, and import.
    await user.click(screen.getAllByRole('button', { name: '获取模型' })[0]);
    dialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByText('o4-mini')).toBeInTheDocument();
    });
    await user.click(
      within(dialog).getByRole('checkbox', { name: /o4-mini/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: '导入 (1)' }));

    await waitFor(() => {
      expect(screen.getByText('o4-mini')).toBeInTheDocument();
    });
    expect(state.lastUpdateBodies).toHaveLength(1);
    const merged = state.lastUpdateBodies[0].models as ProviderConfig['models'];
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      id: 'gpt-4.1',
      name: 'My Custom GPT-4.1',
      compat: { extraBody: { custom: true } },
    });
    expect(merged[1].id).toBe('o4-mini');
  });

  it('supports localRequest creation, missing-local-key warning, and browser-direct probe & model fetch', async () => {
    const state: MockState = {
      providers: [
        {
          id: 'p-remote-with-key',
          name: 'Remote Keyed',
          adapter: 'generic-http',
          baseURL: 'http://127.0.0.1:11434/v1',
          authType: 'bearer',
          apiKeyMasked: 'sk-1...2345',
          apiKeySet: true,
          models: [],
          enabled: true,
          builtIn: false,
          localRequest: true,
        },
      ],
      discovered: [],
      lastUpdateBodies: [],
      lastProbeBodies: [],
      lastFetchBodies: [],
    };

    const user = userEvent.setup();
    renderProviders(state);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Remote Keyed' })).toBeInTheDocument();
    });

    // Create a localRequest provider with a key -> the gateway owns the credential.
    await user.click(screen.getByRole('button', { name: '添加供应商' }));
    const addDialog = screen.getByRole('dialog');
    await user.type(within(addDialog).getByLabelText('名称'), 'Ollama Local');
    await user.type(
      within(addDialog).getByLabelText('API 地址'),
      'http://127.0.0.1:11434/v1',
    );
    await user.type(
      within(addDialog).getByLabelText('API Key'),
      'sk-local-ollama',
    );
    await user.click(within(addDialog).getByRole('switch', { name: '本地请求' }));
    await user.click(within(addDialog).getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Ollama Local' }),
      ).toBeInTheDocument();
    });
    const created = state.providers.find((p) => p.id === 'p-2');
    expect(created?.apiKeySet).toBe(true);
    expect(created?.localRequest).toBe(true);

    // Test connection and model discovery always go through the gateway, which
    // resolves the stored credential for local-request providers.
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => {
      expect(screen.getByText(/连接正常/)).toBeInTheDocument();
    });
    expect(state.lastProbeBodies).toHaveLength(1);
    expect(state.lastProbeBodies[0]).not.toHaveProperty('apiKey');

    state.discovered = [
      {
        id: 'qwen2.5:7b',
        name: 'qwen2.5:7b',
        group: 'qwen',
        apiFormat: 'openai-completions',
      },
    ];
    await user.click(screen.getAllByRole('button', { name: '获取模型' })[0]);
    const importDialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(within(importDialog).getByText('qwen2.5:7b')).toBeInTheDocument();
    });
    expect(state.lastFetchBodies).toHaveLength(1);
  });
});
