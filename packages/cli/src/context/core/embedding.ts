export interface KtxEmbeddingPort {
  maxBatchSize: number;
  computeEmbedding(text: string): Promise<number[]>;
  computeEmbeddingsBulk(texts: string[]): Promise<number[][]>;
}
