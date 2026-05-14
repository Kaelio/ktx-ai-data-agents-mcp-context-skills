import { devToolsMiddleware as defaultDevToolsMiddleware } from '@ai-sdk/devtools';
import { wrapLanguageModel as defaultWrapLanguageModel, type LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createKtxLlmProvider, type KtxLlmProviderFactoryDeps } from './model-provider.js';

const languageModel = (modelId: string, provider = 'test'): LanguageModel => ({ modelId, provider }) as LanguageModel;
const devtoolsMiddleware = (): ReturnType<typeof defaultDevToolsMiddleware> => ({ specificationVersion: 'v3' });
const wrapWith = (model: LanguageModel) =>
  vi.fn((_options: Parameters<typeof defaultWrapLanguageModel>[0]) => model as ReturnType<typeof defaultWrapLanguageModel>);

describe('createKtxLlmProvider', () => {
  it('wraps language models with DevTools middleware when explicitly enabled', () => {
    const anthropicModel = languageModel('claude-sonnet-4-6', 'anthropic');
    const wrappedModel = languageModel('claude-sonnet-4-6', 'anthropic-devtools');
    const middleware = devtoolsMiddleware();
    const wrapLanguageModel = wrapWith(wrappedModel);
    const devToolsMiddleware = vi.fn(devtoolsMiddleware);

    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      {
        createAnthropic: vi.fn(() => vi.fn(() => anthropicModel)),
        devtoolsEnabled: true,
        wrapLanguageModel,
        devToolsMiddleware,
      } satisfies KtxLlmProviderFactoryDeps,
    );

    expect(provider.getModel('default')).toBe(wrappedModel);
    expect(devToolsMiddleware).toHaveBeenCalledTimes(1);
    expect(wrapLanguageModel).toHaveBeenCalledWith({
      model: anthropicModel,
      middleware,
      modelId: 'claude-sonnet-4-6',
      providerId: 'anthropic',
    });
  });

  it('does not wrap language models by default', () => {
    const anthropicModel = languageModel('claude-sonnet-4-6', 'anthropic');
    const wrapLanguageModel = vi.fn(defaultWrapLanguageModel);
    const devToolsMiddleware = vi.fn(defaultDevToolsMiddleware);

    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      {
        createAnthropic: vi.fn(() => vi.fn(() => anthropicModel)),
        devtoolsEnabled: false,
        wrapLanguageModel,
        devToolsMiddleware,
      } satisfies KtxLlmProviderFactoryDeps,
    );

    expect(provider.getModel('default')).toBe(anthropicModel);
    expect(wrapLanguageModel).not.toHaveBeenCalled();
    expect(devToolsMiddleware).not.toHaveBeenCalled();
  });

  it('wraps language models when KTX_AI_DEVTOOLS_ENABLED is true', () => {
    const originalEnv = process.env.KTX_AI_DEVTOOLS_ENABLED;
    process.env.KTX_AI_DEVTOOLS_ENABLED = 'true';
    try {
      const gatewayModel = languageModel('anthropic/claude-sonnet-4-6', 'gateway');
      const wrappedModel = languageModel('anthropic/claude-sonnet-4-6', 'gateway-devtools');
      const wrapLanguageModel = wrapWith(wrappedModel);

      const provider = createKtxLlmProvider(
        {
          backend: 'gateway',
          gateway: { baseURL: 'https://gateway.test/v1' },
          modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
          promptCaching: { enabled: false },
        },
        {
          createGateway: vi.fn(() => vi.fn(() => gatewayModel)),
          wrapLanguageModel,
          devToolsMiddleware: vi.fn(devtoolsMiddleware),
        } satisfies KtxLlmProviderFactoryDeps,
      );

      expect(provider.getModel('default')).toBe(wrappedModel);
      expect(wrapLanguageModel).toHaveBeenCalledTimes(1);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KTX_AI_DEVTOOLS_ENABLED;
      } else {
        process.env.KTX_AI_DEVTOOLS_ENABLED = originalEnv;
      }
    }
  });

  it('does not wrap language models in production even when enabled', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const anthropicModel = languageModel('claude-sonnet-4-6', 'anthropic');
      const wrapLanguageModel = vi.fn(defaultWrapLanguageModel);
      const devToolsMiddleware = vi.fn(defaultDevToolsMiddleware);

      const provider = createKtxLlmProvider(
        {
          backend: 'anthropic',
          anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
          modelSlots: { default: 'claude-sonnet-4-6' },
          promptCaching: { enabled: false },
        },
        {
          createAnthropic: vi.fn(() => vi.fn(() => anthropicModel)),
          devtoolsEnabled: true,
          wrapLanguageModel,
          devToolsMiddleware,
        } satisfies KtxLlmProviderFactoryDeps,
      );

      expect(provider.getModel('default')).toBe(anthropicModel);
      expect(wrapLanguageModel).not.toHaveBeenCalled();
      expect(devToolsMiddleware).not.toHaveBeenCalled();
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('uses direct Anthropic with both beta headers', () => {
    const anthropicModel = languageModel('claude-sonnet-4-6', 'anthropic');
    const anthropic = vi.fn(() => anthropicModel);
    const createAnthropic = vi.fn(() => anthropic);

    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key', baseURL: 'https://anthropic.test' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createAnthropic, devtoolsEnabled: false },
    );

    expect(provider.getModel('default')).toBe(anthropicModel);
    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-anthropic-key', // pragma: allowlist secret
      baseURL: 'https://anthropic.test',
      headers: {
        'anthropic-beta': 'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
      },
    });
    expect(anthropic).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('uses Vertex Anthropic without the direct-Anthropic beta header', () => {
    const vertexModel = languageModel('claude-sonnet-4-6', 'vertex');
    const vertex = vi.fn(() => vertexModel);
    const createVertexAnthropic = vi.fn(() => vertex);

    const provider = createKtxLlmProvider(
      {
        backend: 'vertex',
        vertex: { project: 'ktx-test', location: 'us-east5' },
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createVertexAnthropic, devtoolsEnabled: false },
    );

    expect(provider.getModel('default')).toBe(vertexModel);
    expect(createVertexAnthropic).toHaveBeenCalledWith({ project: 'ktx-test', location: 'us-east5' });
    expect(vertex).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('uses Gateway and supports role fallback to default', () => {
    const gatewayModel = languageModel('anthropic/claude-sonnet-4-6', 'gateway');
    const gateway = vi.fn(() => gatewayModel);
    const createGateway = vi.fn(() => gateway);

    const provider = createKtxLlmProvider(
      {
        backend: 'gateway',
        gateway: { apiKey: 'gateway-key', baseURL: 'https://gateway.test/v1' }, // pragma: allowlist secret
        modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createGateway, devtoolsEnabled: false },
    );

    expect(provider.getModel('curator')).toBe(gatewayModel);
    expect(createGateway).toHaveBeenCalledWith({
      apiKey: 'gateway-key', // pragma: allowlist secret
      baseURL: 'https://gateway.test/v1',
      headers: {
        'anthropic-beta': 'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
      },
    });
    expect(gateway).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
  });

  it('uses explicit role overrides before default', () => {
    const anthropic = vi.fn((modelId: string) => languageModel(modelId, 'anthropic'));

    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: {
          default: 'claude-sonnet-4-6',
          triage: 'claude-haiku-4-5',
          repair: 'claude-opus-4-7',
        },
        promptCaching: { enabled: false },
      },
      { createAnthropic: vi.fn(() => anthropic) },
    );

    expect((provider.getModel('triage') as { modelId: string }).modelId).toBe('claude-haiku-4-5');
    expect((provider.getModel('repair') as { modelId: string }).modelId).toBe('claude-opus-4-7');
    expect((provider.getModel('reconcile') as { modelId: string }).modelId).toBe('claude-sonnet-4-6');
  });

  it('emits cache markers only when enabled and the model speaks Anthropic protocol', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'gateway',
        gateway: { baseURL: 'https://gateway.test/v1' },
        modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
        promptCaching: { enabled: true },
      },
      { createGateway: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'gateway'))) },
    );

    expect(provider.cacheMarker('1h', 'anthropic/claude-sonnet-4-6')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
    expect(provider.cacheMarker('1h', 'gpt-5')).toBeUndefined();
  });

  it('returns Anthropic thinking provider options', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createAnthropic: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'anthropic'))) },
    );

    expect(provider.thinkingProviderOptions('default', 12000)).toEqual({
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 12000 },
      },
    });
  });

  it('defaults prompt caching to enabled with canonical TTLs', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'gateway',
        gateway: { baseURL: 'https://gateway.test/v1' },
        modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
      },
      { createGateway: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'gateway'))) },
    );

    expect(provider.promptCachingConfig()).toEqual({
      enabled: true,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      cacheSystem: true,
      cacheTools: true,
      cacheHistory: true,
      vertexFallbackTo5m: false,
    });
    expect(provider.cacheMarker('1h', 'anthropic/claude-sonnet-4-6')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
  });

  it('preserves explicit prompt caching opt-out', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createAnthropic: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'anthropic'))) },
    );

    expect(provider.promptCachingConfig().enabled).toBe(false);
    expect(provider.cacheMarker('1h', 'claude-sonnet-4-6')).toBeUndefined();
  });
});
