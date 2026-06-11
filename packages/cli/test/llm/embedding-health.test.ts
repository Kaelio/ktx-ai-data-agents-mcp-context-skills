import { describe, expect, it, vi } from 'vitest';
import { runKtxEmbeddingHealthCheck } from '../../src/llm/embedding-health.js';

describe('ktx embedding health check', () => {
  it('runs a one-shot OpenAI embedding check through the configured provider', async () => {
    const createOpenAIClient = vi.fn(() => ({
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
      },
    }));

    await expect(
      runKtxEmbeddingHealthCheck(
        {
          backend: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 3,
          openai: { apiKey: 'sk-openai-test' }, // pragma: allowlist secret
        },
        { deps: { createOpenAIClient } },
      ),
    ).resolves.toEqual({ ok: true });

    expect(createOpenAIClient).toHaveBeenCalledWith({ apiKey: 'sk-openai-test', baseURL: undefined }); // pragma: allowlist secret
  });

  it('returns failed when the provider returns the wrong dimensions', async () => {
    const createOpenAIClient = vi.fn(() => ({
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
      },
    }));

    await expect(
      runKtxEmbeddingHealthCheck(
        {
          backend: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 3,
          openai: { apiKey: 'sk-openai-test' }, // pragma: allowlist secret
        },
        { deps: { createOpenAIClient } },
      ),
    ).resolves.toEqual({
      ok: false,
      message: 'Embedding provider openai returned vector with 2 dimensions; expected 3',
    });
  });

  it('redacts credential values from health-check failures', async () => {
    const createOpenAIClient = vi.fn(() => ({
      embeddings: {
        create: vi.fn(async () => {
          throw new Error('401 invalid api key sk-openai-secret');
        }),
      },
    }));

    await expect(
      runKtxEmbeddingHealthCheck(
        {
          backend: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 3,
          openai: { apiKey: 'sk-openai-secret' }, // pragma: allowlist secret
        },
        { deps: { createOpenAIClient } },
      ),
    ).resolves.toEqual({
      ok: false,
      message: '401 invalid api key [redacted]',
    });
  });

  it('returns failed when the health check times out', async () => {
    const createOpenAIClient = vi.fn(() => ({
      embeddings: {
        create: vi.fn(
          () =>
            new Promise<{ data: Array<{ index?: number; embedding: number[] }>; usage?: { total_tokens?: number } }>(
              () => undefined,
            ),
        ),
      },
    }));

    await expect(
      runKtxEmbeddingHealthCheck(
        {
          backend: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 3,
          openai: { apiKey: 'sk-openai-test' }, // pragma: allowlist secret
        },
        { timeoutMs: 1, deps: { createOpenAIClient } },
      ),
    ).resolves.toEqual({
      ok: false,
      message: 'Embedding health check timed out after 1ms',
    });
  });
});
