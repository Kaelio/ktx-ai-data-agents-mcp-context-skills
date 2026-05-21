import { createHash } from 'node:crypto';
import { type KtxLogger, noopLogger } from '../../../context/core/config.js';
import type { JsonValue } from '../ports.js';
import type { ContextCandidateStorePort } from './store.js';
import type {
  BudgetExhaustedCandidateForCarryForward,
  ContextCandidateCarryforwardSettings,
  CurrentRunEvidenceChunkForCarryForward,
} from './types.js';

export interface ContextCandidateCarryforwardArgs {
  runId: string;
  connectionId: string;
  sourceKey: string;
}

export interface ContextCandidateCarryforwardResult {
  considered: number;
  carriedForward: number;
  skippedNotReemitted: number;
  remappedEvidenceRefs: number;
  staleEvidenceRefs: number;
  warnings: string[];
}

export interface ContextCandidateCarryforwardServiceDeps {
  store: ContextCandidateStorePort;
  settings: ContextCandidateCarryforwardSettings;
  logger?: KtxLogger;
}

export class ContextCandidateCarryforwardService {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: ContextCandidateCarryforwardServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async carryForward(args: ContextCandidateCarryforwardArgs): Promise<ContextCandidateCarryforwardResult> {
    const candidates = await this.deps.store.listBudgetExhaustedCandidatesForCarryForward({
      connectionId: args.connectionId,
      sourceKey: args.sourceKey,
      currentRunId: args.runId,
    });
    const chunks = await this.deps.store.listCurrentRunEvidenceChunksForCarryForward(args.runId);
    const chunksByStableKey = new Map(chunks.map((chunk) => [chunk.stableCitationKey, chunk]));
    const allowStaleEvidence = this.deps.settings.reExamineBudgetExhaustedOnRerun;

    let carriedForward = 0;
    let skippedNotReemitted = 0;
    let remappedEvidenceRefs = 0;
    let staleEvidenceRefs = 0;

    for (const candidate of candidates) {
      const remap = this.remapEvidence(candidate, chunksByStableKey);
      if (remap.remappedCount === 0 && !allowStaleEvidence) {
        skippedNotReemitted += 1;
        continue;
      }

      await this.deps.store.insertCandidate({
        runId: args.runId,
        connectionId: args.connectionId,
        sourceKey: args.sourceKey,
        candidateKey: candidate.candidateKey,
        topic: candidate.topic,
        assertion: candidate.assertion,
        rationale: candidate.rationale,
        evidenceChunkIds: remap.evidenceChunkIds,
        evidenceRefs: remap.evidenceRefs,
        suggestedPageKey: candidate.suggestedPageKey,
        actionHint: candidate.actionHint,
        durabilityScore: candidate.durabilityScore,
        authorityScore: candidate.authorityScore,
        reuseScore: candidate.reuseScore,
        noveltyScore: candidate.noveltyScore,
        riskScore: candidate.riskScore,
        promotionScore: candidate.promotionScore,
        status: 'pending',
        rejectionReason: null,
        lane: candidate.lane,
        embedding: null,
      });

      carriedForward += 1;
      remappedEvidenceRefs += remap.remappedCount;
      staleEvidenceRefs += remap.staleCount;
    }

    const warnings = this.buildWarnings({ carriedForward, skippedNotReemitted, staleEvidenceRefs });
    if (carriedForward > 0 || skippedNotReemitted > 0) {
      this.logger.log(
        `Budget carryforward: considered ${candidates.length}, carried ${carriedForward}, skipped ${skippedNotReemitted}`,
      );
    }

    return {
      considered: candidates.length,
      carriedForward,
      skippedNotReemitted,
      remappedEvidenceRefs,
      staleEvidenceRefs,
      warnings,
    };
  }

  private remapEvidence(
    candidate: BudgetExhaustedCandidateForCarryForward,
    chunksByStableKey: Map<string, CurrentRunEvidenceChunkForCarryForward>,
  ): { evidenceChunkIds: string[]; evidenceRefs: JsonValue; remappedCount: number; staleCount: number } {
    const refs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [];
    const remappedRefs: JsonValue[] = [];
    const remappedChunkIds: string[] = [];

    for (const ref of refs) {
      const stableKey = this.stableCitationKey(ref);
      const currentChunk = stableKey ? chunksByStableKey.get(stableKey) : undefined;
      if (!currentChunk) {
        continue;
      }

      remappedChunkIds.push(currentChunk.chunkId);
      remappedRefs.push(this.currentEvidenceRef(currentChunk));
    }

    if (remappedRefs.length > 0) {
      return {
        evidenceChunkIds: [...new Set(remappedChunkIds)],
        evidenceRefs: remappedRefs,
        remappedCount: remappedRefs.length,
        staleCount: 0,
      };
    }

    return {
      evidenceChunkIds: candidate.evidenceChunkIds,
      evidenceRefs: candidate.evidenceRefs,
      remappedCount: 0,
      staleCount: refs.length,
    };
  }

  private stableCitationKey(ref: JsonValue): string | null {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      return null;
    }
    const value = (ref as Record<string, JsonValue>).stableCitationKey;
    return typeof value === 'string' ? value : null;
  }

  private currentEvidenceRef(chunk: CurrentRunEvidenceChunkForCarryForward): JsonValue {
    return {
      chunkId: chunk.chunkId,
      stableCitationKey: chunk.stableCitationKey,
      syncId: chunk.syncId,
      rawPath: chunk.rawPath,
      title: chunk.title,
      path: chunk.path,
      url: chunk.url,
      lastEditedAt: chunk.lastEditedAt?.toISOString() ?? null,
      snippetHash: createHash('sha256').update(chunk.content).digest('hex'),
      citation: chunk.citation,
    };
  }

  private buildWarnings(params: {
    carriedForward: number;
    skippedNotReemitted: number;
    staleEvidenceRefs: number;
  }): string[] {
    const warnings: string[] = [];
    if (params.carriedForward > 0) {
      warnings.push(
        `Re-examined ${params.carriedForward} prior budget-exhausted context candidate${
          params.carriedForward === 1 ? '' : 's'
        }.`,
      );
    }
    if (params.skippedNotReemitted > 0) {
      warnings.push(
        `Skipped ${params.skippedNotReemitted} budget-exhausted context candidate${
          params.skippedNotReemitted === 1 ? '' : 's'
        } because its evidence was not re-emitted in this run.`,
      );
    }
    if (params.staleEvidenceRefs > 0) {
      warnings.push(
        `Carried ${params.staleEvidenceRefs} budget-exhausted evidence ref${
          params.staleEvidenceRefs === 1 ? '' : 's'
        } without a current-run chunk remap.`,
      );
    }
    return warnings;
  }
}
