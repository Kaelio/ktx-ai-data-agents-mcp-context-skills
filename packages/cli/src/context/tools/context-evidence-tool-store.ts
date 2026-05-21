import type { InsertContextCandidateInput } from '../../context/ingest/context-candidates/types.js';
import type { JsonValue } from '../ingest/ports.js';

export interface ContextEvidenceSearchArgs {
  connectionId: string;
  sourceKey?: string;
  queryEmbedding: number[] | null;
  queryText: string;
  limit: number;
  includeDeleted: boolean;
  currentRunId?: string;
}

export type ContextEvidenceSearchMatchReason = 'lexical' | 'semantic' | 'token' | (string & {});

interface ContextEvidenceSearchLaneSummary {
  lane: string;
  status: 'available' | 'skipped' | 'failed';
  requestedCandidatePoolLimit: number;
  effectiveCandidatePoolLimit: number;
  returnedCandidateCount: number;
  weight: number;
  reason?: string;
}

export interface ContextEvidenceSearchResult {
  chunkId: string;
  documentId: string;
  externalId: string;
  title: string;
  path: string;
  url: string | null;
  snippet: string;
  score: number;
  citation: JsonValue;
  stableCitationKey: string;
  syncId: string;
  lastEditedAt: Date | null;
  matchReasons?: ContextEvidenceSearchMatchReason[];
  lanes?: ContextEvidenceSearchLaneSummary[];
}

interface ContextEvidenceDocumentForRead {
  id: string;
  title: string;
  path: string;
  external_id: string;
  url: string | null;
}

interface ContextEvidenceChunkForRead {
  id: string;
  content: string;
  citation?: JsonValue;
}

export interface ContextEvidenceReadResult {
  document: ContextEvidenceDocumentForRead;
  chunks: ContextEvidenceChunkForRead[];
}

export interface ContextEvidenceChunkReadResult {
  document: ContextEvidenceDocumentForRead;
  chunk: ContextEvidenceChunkForRead;
}

export interface ContextEvidenceNeighborResult {
  documentId: string;
  externalId: string;
  title: string;
  path: string;
  relation: 'parent' | 'children' | 'linked' | 'backlinked' | 'same_path';
  url: string | null;
  lastEditedAt: Date | null;
}

export interface ContextEvidenceChunkForCandidate {
  chunkId: string;
  documentId: string;
  externalId: string;
  title: string;
  path: string;
  url: string | null;
  rawPath: string;
  content: string;
  citation: JsonValue;
  stableCitationKey: string;
  syncId: string;
  lastEditedAt: Date | null;
}

interface ContextCandidateInsertResult {
  id: string;
  candidate_key: string;
  promotion_score: number;
  status: string;
}

export interface ContextCandidateStatusResult {
  candidate_key: string;
  status: string;
}

export interface ContextEvidenceToolStorePort {
  searchRRF(args: ContextEvidenceSearchArgs): Promise<ContextEvidenceSearchResult[]>;
  readChunkById(
    chunkId: string,
    connectionId: string,
    sourceKey: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceChunkReadResult | null>;
  readDocumentById(
    documentId: string,
    connectionId: string,
    sourceKey: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceReadResult | null>;
  readDocumentByExternalId(
    connectionId: string,
    sourceKey: string,
    externalId: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceReadResult | null>;
  findNeighborDocuments(args: {
    connectionId: string;
    sourceKey: string;
    documentId: string;
    relation: 'parent' | 'children' | 'linked' | 'backlinked' | 'same_path';
    limit: number;
    currentRunId?: string;
  }): Promise<ContextEvidenceNeighborResult[]>;
  readChunksByIds(
    chunkIds: string[],
    connectionId: string,
    sourceKey: string,
    currentRunId?: string,
  ): Promise<ContextEvidenceChunkForCandidate[]>;
  insertCandidate(input: InsertContextCandidateInput): Promise<ContextCandidateInsertResult>;
  updateCandidateStatus(args: {
    runId: string;
    candidateKey: string;
    status: 'pending' | 'promoted' | 'merged' | 'rejected' | 'conflict';
    rejectionReason: string | null;
  }): Promise<ContextCandidateStatusResult | null>;
}
