import { describe, expect, it, vi } from 'vitest';
import { createKtxEmbeddingProvider } from './embedding-provider.js';
import type { KtxEmbeddingConfig } from './types.js';

describe('createKtxEmbeddingProvider', () => {
  it('rejects deterministic embeddings', () => {
    const config = JSON.parse(
      JSON.stringify({
        backend: 'deterministic',
        model: 'sha256',
        dimensions: 6,
      }),
    ) as KtxEmbeddingConfig;

    expect(() => createKtxEmbeddingProvider(config)).toThrow('Unsupported KTX embedding backend: deterministic');
  });

  it('rejects gateway embeddings', () => {
    const config = JSON.parse(
      JSON.stringify({
        backend: 'gateway',
        model: 'provider/text-embedding',
        dimensions: 2,
        gateway: { apiKey: 'gateway-key' }, // pragma: allowlist secret
      }),
    ) as KtxEmbeddingConfig;

    expect(() => createKtxEmbeddingProvider(config)).toThrow('Unsupported KTX embedding backend: gateway');
  });

  it('uses OpenAI embeddings with configured dimensions', async () => {
    const createOpenAIClient = vi.fn(() => ({
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          usage: { total_tokens: 7 },
        }),
      },
    }));

    const provider = createKtxEmbeddingProvider(
      {
        backend: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        openai: { apiKey: 'openai-key', baseURL: 'https://openai.test/v1' }, // pragma: allowlist secret
      },
      { createOpenAIClient },
    );

    await expect(provider.embed('hello')).resolves.toEqual([0.1, 0.2]);
    expect(createOpenAIClient).toHaveBeenCalledWith({
      apiKey: 'openai-key', // pragma: allowlist secret
      baseURL: 'https://openai.test/v1',
    });
  });

  it('supports sentence-transformers pathPrefix defaults and explicit empty prefix', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [0.3, 0.4] }), { status: 200 }));

    const provider = createKtxEmbeddingProvider(
      {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 2,
        sentenceTransformers: { baseURL: 'https://python.test/' },
      },
      { fetch },
    );

    await expect(provider.embed('hello')).resolves.toEqual([0.3, 0.4]);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://python.test/api/embeddings/compute',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://python.test/api/embeddings/compute',
      expect.objectContaining({ method: 'POST' }),
    );

    const daemonFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embeddings: [[0.5, 0.6]] }), { status: 200 }));

    const daemonProvider = createKtxEmbeddingProvider(
      {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 2,
        sentenceTransformers: { baseURL: 'https://daemon.test/base/', pathPrefix: '' },
      },
      { fetch: daemonFetch },
    );

    await expect(daemonProvider.embedMany(['hello'])).resolves.toEqual([[0.5, 0.6]]);
    expect(daemonFetch).toHaveBeenNthCalledWith(
      1,
      'https://daemon.test/base/embeddings/compute',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(daemonFetch).toHaveBeenNthCalledWith(
      2,
      'https://daemon.test/base/embeddings/compute-bulk',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports local HTTP daemon failures without a ktx-daemon spawn fallback cascade', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('Embedding compute failed: httpx.InvalidURL: Invalid port', { status: 500 }),
      );

    const provider = createKtxEmbeddingProvider(
      {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 2,
        sentenceTransformers: { baseURL: 'http://127.0.0.1:8765', pathPrefix: '' },
      },
      { fetch },
    );

    await expect(provider.embed('hello')).rejects.toThrow(
      'Embedding provider sentence-transformers request failed with HTTP 500: Embedding compute failed: httpx.InvalidURL: Invalid port',
    );
    await expect(provider.embed('hello')).rejects.not.toThrow('ktx-daemon fallback failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
