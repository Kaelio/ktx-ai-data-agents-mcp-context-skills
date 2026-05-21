import type { KtxEmbeddingPort } from '../core/index.js';

export interface ReindexOptions {
  force: boolean;
  embeddingService: KtxEmbeddingPort | null;
}

export interface ReindexWorkResult {
  scanned: number;
  updated: number;
  deleted: number;
  embeddingsRecomputed: number;
  embeddingsFailed: number;
}

export interface ReindexScopeResult extends ReindexWorkResult {
  kind: 'wiki' | 'sl';
  label: string;
  scope?: 'global' | 'user';
  scopeId?: string | null;
  connectionId?: string;
  durationMs: number;
  error?: string;
}

export interface ReindexSummary {
  scopes: ReindexScopeResult[];
  totals: ReindexWorkResult;
  dbPath: string;
  force: boolean;
  embeddingsAvailable: boolean;
  durationMs: number;
}
