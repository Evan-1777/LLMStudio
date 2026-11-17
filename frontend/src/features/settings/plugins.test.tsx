import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../app/AppProvider';
import type { SearchEngineView } from '../../core/types';
import { PluginsPage } from './PluginsPage';

interface PluginMockState {
  engines: SearchEngineView[];
  testShouldFail?: boolean;
  updatePayloads: Array<{ id: string; body: Record<string, unknown> }>;
  testPayloads: Array<{ id: string; body: Record<string, unknown> }>;
}

function makeFetchMock(state: PluginMockState) {
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
        JSON.stringify({
          formats: [
            {
              id: 'openai-completions',
              displayName: 'OpenAI Chat Completions',
              defaultPath: '/v1/chat/completions',
              defaultCompat: { thinkingFormat: 'openai' },
            },
          ],
          adapters: [{ id: 'generic-http', displayName: 'Generic HTTP' }],
        }),
        { status: 200 },
      );
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
    if (url.endsWith('/api/v1/mcp/servers')) {
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    }

    if (url.endsWith('/api/v1/plugins/search') && method === 'GET') {
      return new Response(JSON.stringify({ engines: state.engines }), {
        status: 200,
      });
    }

    const testMatch = url.match(/\/api\/v1\/plugins\/search\/([^/]+)\/test$/);
    if (testMatch && method === 'POST') {
      const id = decodeURIComponent(testMatch[1]);
      state.testPayloads.push({ id, body: parsedBody });
      if (state.testShouldFail) {
        return new Response(
          JSON.stringify({
            code: 'UPSTREAM_ERROR',
            message: 'search API rejected key',
          }),
          { status: 502 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          engineId: id,
          resultCount: 5,
          latencyMs: 42,
          message: '搜索测试正常',
        }),
        { status: 200 },
      );
    }

    const putMatch = url.match(/\/api\/v1\/plugins\/search\/([^/]+)$/);
    if (putMatch && method === 'PUT') {
      const id = decodeURIComponent(putMatch[1]);
      state.updatePayloads.push({ id, body: parsedBody });
      const clearKey = parsedBody.clearApiKey === true;
      state.engines = state.engines.map((e) => {
        if (e.engineId !== id) {
          return parsedBody.isDefault === true ? { ...e, isDefault: false } : e;
        }
        return {
          ...e,
          enabled:
            typeof parsedBody.enabled === 'boolean'
              ? parsedBody.enabled
              : e.enabled,
          endpoint:
            typeof parsedBody.endpoint === 'string'
              ? parsedBody.endpoint
              : e.endpoint,
          maxResults:
            typeof parsedBody.maxResults === 'number'
              ? parsedBody.maxResults
              : e.maxResults,
          isDefault:
            typeof parsedBody.isDefault === 'boolean'
              ? parsedBody.isDefault
              : e.isDefault,
          apiKeySet: clearKey
            ? false
            : parsedBody.apiKey
              ? true
              : e.apiKeySet,
          apiKeyMasked: clearKey
            ? ''
            : parsedBody.apiKey
              ? 'tvly...9999'
              : e.apiKeyMasked,
        };
      });
      const updated = state.engines.find((e) => e.engineId === id)!;
      return new Response(JSON.stringify({ engine: updated }), { status: 200 });
    }

    return new Response('{}', { status: 200 });
  });
}

describe('PluginsPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('handles search engine updates, 3-state API keys, default switching, test success/failure, and removes reserved slots', async () => {
    const state: PluginMockState = {
      engines: [
        {
          engineId: 'tavily',
          displayName: 'Tavily Search',
          defaultEndpoint: 'https://api.tavily.com/search',
          requiresApiKey: true,
          enabled: true,
          endpoint: 'https://api.tavily.com/search',
          apiKeyMasked: 'tvly...1234',
          apiKeySet: true,
          maxResults: 5,
          isDefault: true,
        },
        {
          engineId: 'searxng',
          displayName: 'SearXNG',
          defaultEndpoint: 'https://searx.example.com/search',
          requiresApiKey: false,
          enabled: false,
          endpoint: 'https://searx.example.com/search',
          apiKeyMasked: '',
          apiKeySet: false,
          maxResults: 10,
          isDefault: false,
        },
      ],
      updatePayloads: [],
      testPayloads: [],
    };

    const user = userEvent.setup();
    render(
      <AppProvider fetchImpl={makeFetchMock(state)}>
        <MemoryRouter>
          <PluginsPage />
        </MemoryRouter>
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Tavily Search')).toBeInTheDocument();
    });

    // No reserved ecosystem slots and no duplicate rendering toggles; only appearance link + read-only format/adapter metadata.
    expect(screen.queryByText(/图像生成插件/)).not.toBeInTheDocument();
    expect(screen.queryByText(/选择性会话同步/)).not.toBeInTheDocument();
    expect(screen.queryByText(/MCP 工具运行时/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /外观与显示/ })).toHaveAttribute(
      'href',
      '/settings/appearance',
    );
    expect(screen.getByText('OpenAI Chat Completions')).toBeInTheDocument();
    expect(screen.getByText('Generic HTTP')).toBeInTheDocument();

    const tavilyForm = screen.getByRole('form', { name: 'Tavily Search' });
    const searxForm = screen.getByRole('form', { name: 'SearXNG' });

    // Search test success and failure.
    await user.click(
      within(tavilyForm).getByRole('button', { name: '测试搜索' }),
    );
    await waitFor(() => {
      expect(within(tavilyForm).getByText(/5 条结果 · 42 ms/)).toBeInTheDocument();
    });

    state.testShouldFail = true;
    await user.click(
      within(tavilyForm).getByRole('button', { name: '测试搜索' }),
    );
    await waitFor(() => {
      expect(
        within(tavilyForm).getByText('search API rejected key'),
      ).toBeInTheDocument();
    });

    // Validation blocks maxResults > 20.
    const maxResInput = within(tavilyForm).getByLabelText('结果数量');
    await user.clear(maxResInput);
    await user.type(maxResInput, '25');
    await user.click(within(tavilyForm).getByRole('button', { name: '保存' }));
    expect(
      within(tavilyForm).getByText('结果数量须为 1–20 的整数'),
    ).toBeInTheDocument();
    expect(state.updatePayloads).toHaveLength(0);

    // Fix maxResults and clear API key.
    await user.clear(maxResInput);
    await user.type(maxResInput, '8');
    await user.click(
      within(tavilyForm).getByRole('button', { name: '清空密钥' }),
    );
    await user.click(within(tavilyForm).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(state.updatePayloads).toHaveLength(1);
    });
    expect(state.updatePayloads[0]).toEqual({
      id: 'tavily',
      body: {
        endpoint: 'https://api.tavily.com/search',
        maxResults: 8,
        clearApiKey: true,
      },
    });

    // Enable SearXNG and set as default; verify refreshed default state updates both cards.
    await user.click(within(searxForm).getByRole('switch', { name: '启用 SearXNG' }));
    await waitFor(() => {
      expect(state.updatePayloads).toHaveLength(2);
    });
    await user.click(within(searxForm).getByRole('button', { name: '设为默认' }));
    await waitFor(() => {
      expect(within(searxForm).getByText('默认')).toBeInTheDocument();
    });
    expect(within(tavilyForm).queryByText('默认')).not.toBeInTheDocument();
  });
});
