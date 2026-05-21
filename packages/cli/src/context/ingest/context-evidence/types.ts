import type { JsonValue } from '../ports.js';

export type EvidencePublishState = 'pending' | 'published' | 'superseded';

export interface ContextEvidenceDocumentRef {
  id: string;
}

export interface UpsertContextEvidenceDocument {
  runId: string;
  connectionId: string;
  sourceKey: string;
  externalId: string;
  externalParentId: string | null;
  databaseId: string | null;
  dataSourceId: string | null;
  title: string;
  path: string;
  url: string | null;
  objectType: string;
  lastEditedAt: Date | null;
  lastEditedBy: string | null;
  rawPath: string;
  syncId: string;
  contentHash: string;
  publishState?: EvidencePublishState;
  metadata: JsonValue;
}

export interface ReplaceContextEvidenceChunk {
  chunkKey: string;
  headingPath: string[];
  ordinal: number;
  content: string;
  searchText: string;
  embedding: number[] | null;
  tokenCount: number;
  citation: JsonValue;
  stableCitationKey: string;
  syncId: string;
  contentHash: string;
}

export interface ContextEvidenceEmbeddingPort {
  maxBatchSize?: number;
  computeEmbeddingsBulk(texts: string[]): Promise<number[][]>;
}

export interface ContextEvidenceIndexSummary {
  documentsIndexed: number;
  chunksIndexed: number;
  documentsDeleted: number;
  embeddingFailures: number;
  warnings: string[];
}
