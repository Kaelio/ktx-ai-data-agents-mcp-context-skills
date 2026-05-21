import type { ContextCandidateForDedup } from '../ports.js';
import type { ReconcileCandidateForPrompt } from '../stages/build-reconcile-context.js';
import type {
  BudgetExhaustedCandidateForCarryForward,
  ContextCandidateRejectionReason,
  ContextCandidateVerdictSummary,
  CurrentRunEvidenceChunkForCarryForward,
  InsertContextCandidateInput,
  MarkContextCandidateClusterInput,
} from './types.js';

export interface ContextCandidateStorePort {
  listPendingCandidatesForDedup(runId: string): Promise<ContextCandidateForDedup[]>;
  updateCandidateEmbedding(candidateId: string, embedding: number[]): Promise<void>;
  markCandidatesAsMergedToCluster(params: MarkContextCandidateClusterInput): Promise<void>;
  listBudgetExhaustedCandidatesForCarryForward(params: {
    connectionId: string;
    sourceKey: string;
    currentRunId: string;
  }): Promise<BudgetExhaustedCandidateForCarryForward[]>;
  listCurrentRunEvidenceChunksForCarryForward(runId: string): Promise<CurrentRunEvidenceChunkForCarryForward[]>;
  insertCandidate(params: InsertContextCandidateInput): Promise<{ id: string }>;
  listCandidatesForPromptByKeys(runId: string, candidateKeys: string[]): Promise<ReconcileCandidateForPrompt[]>;
  markPendingCandidatesByReason(params: {
    runId: string;
    candidateKeys: string[];
    rejectionReason: ContextCandidateRejectionReason;
  }): Promise<number>;
  summarizeCandidateVerdicts(runId: string, candidateKeys: string[]): Promise<ContextCandidateVerdictSummary>;
}
