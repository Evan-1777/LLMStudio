import { describe, expect, it } from 'vitest';
import type { FormatInfo } from '../../core/types';
import { buildEndpointPreview, deriveModelGroup } from './endpoint';

const SAMPLE_FORMATS: FormatInfo[] = [
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

describe('buildEndpointPreview', () => {
  it('returns empty string for empty baseURL', () => {
    expect(
      buildEndpointPreview({
        baseURL: '   ',
        model: { id: 'gpt-4.1', apiFormat: 'openai-completions' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('');
  });

  it('builds URLs for all four protocols with and without version prefixes and trailing slashes', () => {
    expect(
      buildEndpointPreview({
        baseURL: 'https://api.openai.com/v1/',
        model: { id: 'gpt-4.1', apiFormat: 'openai-completions' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://api.openai.com/v1/chat/completions');

    expect(
      buildEndpointPreview({
        baseURL: 'https://api.deepseek.com',
        model: { id: 'deepseek-chat', apiFormat: 'openai-completions' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://api.deepseek.com/v1/chat/completions');

    expect(
      buildEndpointPreview({
        baseURL: 'https://api.evan-ai.xyz/v1',
        model: { id: 'gpt-4.1', apiFormat: 'openai-responses' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://api.evan-ai.xyz/v1/responses');

    expect(
      buildEndpointPreview({
        baseURL: 'https://api.anthropic.com',
        model: { id: 'claude-sonnet-4', apiFormat: 'anthropic-messages' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://api.anthropic.com/v1/messages');

    expect(
      buildEndpointPreview({
        baseURL: 'https://api.anthropic.com/v1',
        model: { id: 'claude-sonnet-4', apiFormat: 'anthropic-messages' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://api.anthropic.com/v1/messages');
  });

  it('substitutes {model} for Google Generative AI with and without /v1beta', () => {
    expect(
      buildEndpointPreview({
        baseURL: 'https://generativelanguage.googleapis.com',
        model: { id: 'gemini-2.5-pro', apiFormat: 'google-generative-ai' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    );

    expect(
      buildEndpointPreview({
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/',
        model: { id: 'gemini-2.5-pro', apiFormat: 'google-generative-ai' },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    );
  });

  it('respects pathOverride including {model} and query parameters', () => {
    expect(
      buildEndpointPreview({
        baseURL: 'https://proxy.example.com/v1/',
        model: {
          id: 'my-model',
          apiFormat: 'openai-completions',
          compat: { pathOverride: '/v1/custom/{model}/chat?alt=sse' },
        },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://proxy.example.com/v1/custom/my-model/chat?alt=sse');

    expect(
      buildEndpointPreview({
        baseURL: 'https://proxy.example.com/v1',
        model: {
          id: 'my-model',
          apiFormat: 'openai-completions',
          compat: { pathOverride: 'custom/chat' },
        },
        formats: SAMPLE_FORMATS,
      }),
    ).toBe('https://proxy.example.com/v1/custom/chat');
  });

  it('derives model groups cleanly', () => {
    expect(deriveModelGroup('openai/gpt-4.1')).toBe('openai');
    expect(deriveModelGroup('claude-sonnet-4')).toBe('claude');
    expect(deriveModelGroup('custom')).toBe('other');
  });
});
