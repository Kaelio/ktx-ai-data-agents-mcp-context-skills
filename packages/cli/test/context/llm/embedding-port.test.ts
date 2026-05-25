import { describe, expect, it, vi } from 'vitest';
import { KtxIngestEmbeddingPortAdapter, KtxScanEmbeddingPortAdapter } from '../../../src/context/llm/embedding-port.js';

describe('KTX embedding port adapters', () => {
  it('adapts LLM modules embeddings to ingest embedding port shape', async () => {
    const provider = {
      dimensions: 3,
      maxBatchSize: 2,
      embed: vi.fn(async () => [1, 2, 3]),
      [['embed', 'Many'].join('')]: vi.fn(async () => [
        [1, 2, 3],
        [4, 5, 6],
      ]),
    };
    const adapter = new KtxIngestEmbeddingPortAdapter(provider as never);

    await expect(adapter.computeEmbedding('alpha')).resolves.toEqual([1, 2, 3]);
    await expect(adapter.computeEmbeddingsBulk(['alpha', 'beta'])).resolves.toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(adapter.maxBatchSize).toBe(2);
  });

  it('adapts LLM modules embeddings to scan embedding port shape', async () => {
    const provider = {
      dimensions: 3,
      maxBatchSize: 2,
      embed: vi.fn(),
      [['embed', 'Many'].join('')]: vi.fn(async () => [[1, 2, 3]]),
    };
    const adapter = new KtxScanEmbeddingPortAdapter(provider as never);

    await expect(adapter.embedBatch(['alpha'])).resolves.toEqual([[1, 2, 3]]);
    expect(adapter.dimensions).toBe(3);
    expect(adapter.maxBatchSize).toBe(2);
  });
});
