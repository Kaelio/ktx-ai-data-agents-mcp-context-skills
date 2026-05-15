import { describe, expect, it, vi } from 'vitest';
import {
  buildDefaultKtxProjectConfig,
  type KtxProjectEmbeddingConfig,
  type KtxProjectLlmConfig,
} from '../project/config.js';
import {
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV,
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmProviderFromConfig,
  resolveLocalKtxEmbeddingConfig,
  resolveLocalKtxLlmConfig,
} from './local-config.js';

describe('local KTX LLM config', () => {
  it('resolves env and file references into a KtxLlmConfig', () => {
    const config: KtxProjectLlmConfig = {
      provider: {
        backend: 'gateway',
        gateway: { api_key: 'env:AI_GATEWAY_API_KEY', base_url: 'https://gateway.example/v1' }, // pragma: allowlist secret
      },
      models: { default: 'env:KTX_MODEL', triage: 'anthropic/claude-haiku-4-5' },
      promptCaching: { enabled: false },
      agentRunner: { backend: 'ai-sdk' },
    };

    expect(
      resolveLocalKtxLlmConfig(config, {
        AI_GATEWAY_API_KEY: 'gateway-key', // pragma: allowlist secret
        KTX_MODEL: 'anthropic/claude-sonnet-4-6',
      }),
    ).toEqual({
      backend: 'gateway',
      gateway: { apiKey: 'gateway-key', baseURL: 'https://gateway.example/v1' }, // pragma: allowlist secret
      modelSlots: { default: 'anthropic/claude-sonnet-4-6', triage: 'anthropic/claude-haiku-4-5' },
      promptCaching: { enabled: false },
    });
  });

  it('resolves Vertex AI env references into a KtxLlmConfig', () => {
    const config: KtxProjectLlmConfig = {
      provider: {
        backend: 'vertex',
        vertex: { project: 'env:GOOGLE_VERTEX_PROJECT', location: 'env:GOOGLE_VERTEX_LOCATION' },
      },
      models: { default: 'env:KTX_MODEL' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
      agentRunner: { backend: 'ai-sdk' },
    };

    expect(
      resolveLocalKtxLlmConfig(config, {
        GOOGLE_VERTEX_PROJECT: 'local-gcp-project',
        GOOGLE_VERTEX_LOCATION: 'us-east5',
        KTX_MODEL: 'claude-sonnet-4-6',
      }),
    ).toEqual({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
  });

  it('ignores inactive Vertex AI references for non-Vertex backends', () => {
    const config: KtxProjectLlmConfig = {
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
        vertex: { location: 'env:MISSING_VERTEX_LOCATION' },
      },
      models: { default: 'claude-sonnet-4-6' },
      agentRunner: { backend: 'ai-sdk' },
    };

    expect(
      resolveLocalKtxLlmConfig(config, {
        ANTHROPIC_API_KEY: 'sk-ant-test', // pragma: allowlist secret
      }),
    ).toEqual({
      backend: 'anthropic',
      anthropic: { apiKey: 'sk-ant-test' }, // pragma: allowlist secret
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: undefined,
    });
  });

  it('returns null when the local LLM backend is disabled', () => {
    expect(
      createLocalKtxLlmProviderFromConfig({
        provider: { backend: 'none' },
        models: {},
        agentRunner: { backend: 'ai-sdk' },
      }),
    ).toBeNull();
  });

  it('constructs providers through @ktx/llm', () => {
    const createKtxLlmProvider = vi.fn(() => ({ getModel: vi.fn() }) as never);
    const result = createLocalKtxLlmProviderFromConfig(
      {
        provider: {
          backend: 'anthropic',
          anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
        },
        models: { default: 'claude-sonnet-4-6' },
        agentRunner: { backend: 'ai-sdk' },
      },
      { env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, createKtxLlmProvider }, // pragma: allowlist secret
    );

    expect(result).not.toBeNull();
    expect(createKtxLlmProvider).toHaveBeenCalledWith({
      backend: 'anthropic',
      anthropic: { apiKey: 'sk-ant-test' }, // pragma: allowlist secret
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: undefined,
    });
  });

  it('inherits enabled prompt caching from @ktx/llm when local config omits promptCaching', () => {
    const provider = createLocalKtxLlmProviderFromConfig({
      provider: {
        backend: 'gateway',
        gateway: { base_url: 'https://gateway.example/v1' },
      },
      models: { default: 'anthropic/claude-sonnet-4-6' },
      agentRunner: { backend: 'ai-sdk' },
    });

    expect(provider?.promptCachingConfig()).toMatchObject({
      enabled: true,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      vertexFallbackTo5m: false,
    });
  });
});

describe('local KTX embedding config', () => {
  it('resolves sentence-transformers config', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { base_url: 'http://localhost:18081', pathPrefix: '' },
      batchSize: 16,
    };

    expect(resolveLocalKtxEmbeddingConfig(config, {})).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://localhost:18081', pathPrefix: '' },
      batchSize: 16,
    });
  });

  it('resolves managed sentence-transformers config from the CLI-provided daemon URL', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: {
        base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
        pathPrefix: '',
      },
      batchSize: 32,
    };

    expect(
      resolveLocalKtxEmbeddingConfig(config, {
        [MANAGED_SENTENCE_TRANSFORMERS_BASE_URL_ENV]: 'http://127.0.0.1:61234',
      }),
    ).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
      batchSize: 32,
    });
  });

  it('returns null for managed sentence-transformers when no daemon URL is available', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: {
        base_url: MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
        pathPrefix: '',
      },
    };

    expect(resolveLocalKtxEmbeddingConfig(config, {})).toBeNull();
  });

  it('constructs deterministic embeddings from the default project config', () => {
    const createKtxEmbeddingProvider = vi.fn(() => ({}) as never);
    const provider = createLocalKtxEmbeddingProviderFromConfig(
      buildDefaultKtxProjectConfig().ingest.embeddings,
      { createKtxEmbeddingProvider },
    );

    expect(provider).not.toBeNull();
    expect(createKtxEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'deterministic',
        model: 'deterministic',
        dimensions: 8,
      }),
    );
  });

  it('returns null when embeddings are disabled', () => {
    expect(createLocalKtxEmbeddingProviderFromConfig({ backend: 'none', dimensions: 8 })).toBeNull();
  });
});
