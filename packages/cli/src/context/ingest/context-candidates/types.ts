import type { JsonValue } from '../ports.js';

export type ContextCandidateActionHint = 'create' | 'update' | 'merge' | 'conflict' | 'skip';
export type ContextCandidateStatus = 'pending' | 'promoted' | 'merged' | 'rejected' | 'conflict';
export type ContextCandidateRejectionReason =
  | 'low_score'
  | 'duplicates_existing_wiki'
  | 'not_durable'
  | 'conflict_unresolved'
  | 'exceeded_run_budget'
  | 'exceeded_curator_passes'
  | 'curator_pass_error';
export type ContextCandidateLane = 'light' | 'full' | null;
export type ContextCandidateScoreAggregation = 'max' | 'mean' | 'sum';

export interface ContextCandidateForPrompt {
  candidateKey: string;
  topic: string;
  assertion: string;
  rationale: string;
  actionHint: string;
  status: string;
  promotionScore: number;
  suggestedPageKey: string | null;
  evidenceRefs: JsonValue;
}

export interface ContextCandidateVerdictSummary {
  pending: number;
  promoted: number;
  merged: number;
  rejected: number;
  conflict: number;
  rejectedByReason: Record<string, number>;
}

export interface CuratorPaginationSettings {
  batchSize: number;
  maxPasses: number;
  stepBudgetPerPass: number;
}

export interface InsertContextCandidateInput {
  runId: string;
  connectionId: string;
  sourceKey: string;
  candidateKey: string;
  topic: string;
  assertion: string;
  rationale: string;
  evidenceChunkIds: string[];
  evidenceRefs: JsonValue;
  suggestedPageKey: string | null;
  actionHint: ContextCandidateActionHint;
  durabilityScore: number;
  authorityScore: number;
  reuseScore: number;
  noveltyScore: number;
  riskScore: number;
  promotionScore: number;
  status: ContextCandidateStatus;
  rejectionReason: string | null;
  lane?: ContextCandidateLane;
  embedding?: number[] | null;
}

export interface MarkContextCandidateClusterInput {
  representativeId: string;
  memberIds: string[];
  evidenceChunkIds: string[];
  evidenceRefs: JsonValue;
  promotionScore: number;
}

export interface BudgetExhaustedCandidateForCarryForward {
  sourceRunId: string;
  candidateKey: string;
  topic: string;
  assertion: string;
  rationale: string;
  evidenceChunkIds: string[];
  evidenceRefs: JsonValue;
  suggestedPageKey: string | null;
  actionHint: ContextCandidateActionHint;
  durabilityScore: number;
  authorityScore: number;
  reuseScore: number;
  noveltyScore: number;
  riskScore: number;
  promotionScore: number;
  lane: ContextCandidateLane;
}

export interface CurrentRunEvidenceChunkForCarryForward {
  chunkId: string;
  stableCitationKey: string;
  syncId: string;
  rawPath: string;
  title: string;
  path: string;
  url: string | null;
  lastEditedAt: Date | null;
  citation: JsonValue;
  content: string;
}

export interface ContextCandidateEmbeddingPort {
  maxBatchSize: number;
  computeEmbedding(text: string): Promise<number[]>;
  computeEmbeddingsBulk(texts: string[]): Promise<number[][]>;
}

export interface CandidateDedupSettings {
  enabled: boolean;
  topicSimilarityThreshold: number;
  scoreAggregation: ContextCandidateScoreAggregation;
}

export interface ContextCandidateCarryforwardSettings {
  reExamineBudgetExhaustedOnRerun: boolean;
}
