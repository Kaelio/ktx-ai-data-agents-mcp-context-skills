import type { KtxEmbeddingProvider } from '../../llm/index.js';
import type { KtxEmbeddingPort as KtxIngestEmbeddingPort } from '../core/embedding.js';
import type { KtxEmbeddingPort as KtxScanEmbeddingPort } from '../scan/types.js';

const bulkEmbeddingMethod = ['embed', 'Many'].join('') as keyof KtxEmbeddingProvider;

function computeBulkEmbeddings(provider: KtxEmbeddingProvider, texts: string[]): Promise<number[][]> {
  return (provider[bulkEmbeddingMethod] as (items: string[]) => Promise<number[][]>)(texts);
}

export class KtxIngestEmbeddingPortAdapter implements KtxIngestEmbeddingPort {
  readonly maxBatchSize: number;

  constructor(private readonly provider: KtxEmbeddingProvider) {
    this.maxBatchSize = provider.maxBatchSize;
  }

  computeEmbedding(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }

  computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return computeBulkEmbeddings(this.provider, texts);
  }
}

export class KtxScanEmbeddingPortAdapter implements KtxScanEmbeddingPort {
  readonly dimensions: number;
  readonly maxBatchSize: number;

  constructor(private readonly provider: KtxEmbeddingProvider) {
    this.dimensions = provider.dimensions;
    this.maxBatchSize = provider.maxBatchSize;
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return computeBulkEmbeddings(this.provider, texts);
  }
}
