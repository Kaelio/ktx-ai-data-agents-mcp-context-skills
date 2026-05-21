import { type KtxLogger, noopLogger } from '../../../context/core/config.js';
import type { CandidateDedupResult, ContextCandidateForDedup, JsonValue } from '../ports.js';
import { buildContextCandidateEmbeddingText } from './embedding-text.js';
import type { ContextCandidateStorePort } from './store.js';
import type { CandidateDedupSettings, ContextCandidateEmbeddingPort } from './types.js';

interface CandidateWithVector extends ContextCandidateForDedup {
  embeddingVector: number[] | null;
}

interface CandidateCluster {
  representative: CandidateWithVector;
  members: CandidateWithVector[];
}

export interface CandidateDedupServiceDeps {
  store: ContextCandidateStorePort;
  embeddings: ContextCandidateEmbeddingPort;
  settings: CandidateDedupSettings;
  logger?: KtxLogger;
}

export class CandidateDedupService {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: CandidateDedupServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async deduplicateRun(runId: string): Promise<CandidateDedupResult> {
    const candidates = await this.deps.store.listPendingCandidatesForDedup(runId);
    const config = this.deps.settings;

    if (!config.enabled) {
      return this.rawResult(candidates, false, [], 0);
    }

    try {
      const prepared = await this.prepareEmbeddings(candidates);
      const clusters = this.clusterCandidates(prepared.candidates, config.topicSimilarityThreshold);
      const effectiveScores = await this.persistClusters(clusters, config.scoreAggregation);

      const mergedCount = clusters.reduce((sum, cluster) => sum + Math.max(cluster.members.length - 1, 0), 0);
      const largestClusterSize = clusters.reduce((max, cluster) => Math.max(max, cluster.members.length), 0);
      const representatives = clusters
        .map((cluster) => {
          const representative = this.stripVector(cluster.representative);
          return {
            ...representative,
            promotionScore: effectiveScores.get(cluster.representative.id) ?? representative.promotionScore,
          };
        })
        .sort((left, right) => {
          if (right.promotionScore !== left.promotionScore) {
            return right.promotionScore - left.promotionScore;
          }
          return left.createdAt.getTime() - right.createdAt.getTime();
        });

      this.logger.log(
        `Dedup: ${candidates.length} candidates -> ${representatives.length} clusters (largest cluster ${largestClusterSize} members)`,
      );

      return {
        enabled: true,
        candidatesIn: candidates.length,
        clustersOut: representatives.length,
        mergedCount,
        largestClusterSize,
        embeddingFailures: prepared.embeddingFailures,
        representatives,
        warnings: prepared.warnings,
      };
    } catch (error) {
      const message = `Dedup failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn(message);
      return this.rawResult(candidates, true, [message], 0);
    }
  }

  private async prepareEmbeddings(candidates: ContextCandidateForDedup[]): Promise<{
    candidates: CandidateWithVector[];
    embeddingFailures: number;
    warnings: string[];
  }> {
    const prepared = candidates.map((candidate) => ({
      ...candidate,
      embeddingVector: this.parseEmbedding(candidate.embedding),
    }));
    const missing = prepared.filter((candidate) => candidate.embeddingVector === null);
    const warnings: string[] = [];
    let embeddingFailures = 0;

    for (let i = 0; i < missing.length; i += this.deps.embeddings.maxBatchSize) {
      const batch = missing.slice(i, i + this.deps.embeddings.maxBatchSize);
      const texts = batch.map((candidate) => buildContextCandidateEmbeddingText(candidate));

      try {
        const embeddings = await this.deps.embeddings.computeEmbeddingsBulk(texts);
        if (embeddings.length !== batch.length) {
          throw new Error(`expected ${batch.length} embeddings, got ${embeddings.length}`);
        }

        for (let index = 0; index < batch.length; index++) {
          batch[index].embeddingVector = embeddings[index];
          await this.deps.store.updateCandidateEmbedding(batch[index].id, embeddings[index]);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(
          `embedding bulk failed: ${reason}; falling back to per-candidate embedding for ${batch.length} candidates`,
        );

        for (const candidate of batch) {
          try {
            const embedding = await this.deps.embeddings.computeEmbedding(
              buildContextCandidateEmbeddingText(candidate),
            );
            candidate.embeddingVector = embedding;
            await this.deps.store.updateCandidateEmbedding(candidate.id, embedding);
          } catch (singleError) {
            embeddingFailures += 1;
            warnings.push(
              `Embedding failed for candidate ${candidate.candidateKey}: ${
                singleError instanceof Error ? singleError.message : String(singleError)
              }`,
            );
          }
        }
      }
    }

    return { candidates: prepared, embeddingFailures, warnings };
  }

  private clusterCandidates(candidates: CandidateWithVector[], threshold: number): CandidateCluster[] {
    const clusters: CandidateCluster[] = [];
    const sorted = [...candidates].sort((left, right) => {
      if (right.promotionScore !== left.promotionScore) {
        return right.promotionScore - left.promotionScore;
      }
      return left.createdAt.getTime() - right.createdAt.getTime();
    });

    for (const candidate of sorted) {
      if (!candidate.embeddingVector) {
        clusters.push({ representative: candidate, members: [candidate] });
        continue;
      }

      const match = clusters.find(
        (cluster) =>
          cluster.representative.embeddingVector &&
          candidate.embeddingVector &&
          this.cosine(candidate.embeddingVector, cluster.representative.embeddingVector) >= threshold,
      );

      if (match) {
        match.members.push(candidate);
      } else {
        clusters.push({ representative: candidate, members: [candidate] });
      }
    }

    return clusters;
  }

  private async persistClusters(
    clusters: CandidateCluster[],
    scoreAggregation: 'max' | 'mean' | 'sum',
  ): Promise<Map<string, number>> {
    const effectiveScores = new Map<string, number>();

    for (const cluster of clusters) {
      if (cluster.members.length <= 1) {
        effectiveScores.set(cluster.representative.id, cluster.representative.promotionScore);
        continue;
      }

      const promotionScore = this.aggregateScore(cluster.members, scoreAggregation);
      effectiveScores.set(cluster.representative.id, promotionScore);

      await this.deps.store.markCandidatesAsMergedToCluster({
        representativeId: cluster.representative.id,
        memberIds: cluster.members.slice(1).map((member) => member.id),
        evidenceChunkIds: this.unionEvidenceChunkIds(cluster.members),
        evidenceRefs: this.unionEvidenceRefs(cluster.members),
        promotionScore,
      });
    }

    return effectiveScores;
  }

  private parseEmbedding(value: string | null): number[] | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'number')) {
        return parsed;
      }
    } catch {
      return null;
    }

    return null;
  }

  private cosine(left: number[], right: number[]): number {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    const length = Math.min(left.length, right.length);

    for (let i = 0; i < length; i++) {
      dot += left[i] * right[i];
      leftNorm += left[i] * left[i];
      rightNorm += right[i] * right[i];
    }

    if (leftNorm === 0 || rightNorm === 0) {
      return 0;
    }

    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }

  private unionEvidenceChunkIds(members: CandidateWithVector[]): string[] {
    const seen = new Set<string>();
    for (const member of members) {
      for (const chunkId of member.evidenceChunkIds) {
        seen.add(chunkId);
      }
    }
    return [...seen];
  }

  private unionEvidenceRefs(members: CandidateWithVector[]): JsonValue {
    const refs: JsonValue[] = [];
    const seen = new Set<string>();

    for (const member of members) {
      if (!Array.isArray(member.evidenceRefs)) {
        continue;
      }

      for (const ref of member.evidenceRefs) {
        const key = this.evidenceRefKey(ref);
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(ref);
        }
      }
    }

    return refs;
  }

  private evidenceRefKey(ref: JsonValue): string {
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      const record = ref as Record<string, JsonValue | undefined>;
      if (typeof record.stableCitationKey === 'string') {
        return `stable:${record.stableCitationKey}`;
      }
      if (typeof record.chunkId === 'string') {
        return `chunk:${record.chunkId}`;
      }
      if (typeof record.rawPath === 'string') {
        return `raw:${record.rawPath}`;
      }
    }

    return JSON.stringify(ref);
  }

  private aggregateScore(members: CandidateWithVector[], mode: 'max' | 'mean' | 'sum'): number {
    const scores = members.map((member) => member.promotionScore);

    if (mode === 'sum') {
      return scores.reduce((sum, score) => sum + score, 0);
    }

    if (mode === 'mean') {
      return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
    }

    return Math.max(...scores);
  }

  private rawResult(
    candidates: ContextCandidateForDedup[],
    enabled: boolean,
    warnings: string[],
    embeddingFailures: number,
  ): CandidateDedupResult {
    return {
      enabled,
      candidatesIn: candidates.length,
      clustersOut: candidates.length,
      mergedCount: 0,
      largestClusterSize: candidates.length > 0 ? 1 : 0,
      embeddingFailures,
      representatives: candidates,
      warnings,
    };
  }

  private stripVector(candidate: CandidateWithVector): ContextCandidateForDedup {
    const { embeddingVector: _embeddingVector, ...rest } = candidate;
    return rest;
  }
}
