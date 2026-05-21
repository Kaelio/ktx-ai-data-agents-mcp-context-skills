import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextCandidateForDedup } from '../ports.js';
import { CandidateDedupService } from './candidate-dedup.service.js';
import type { ContextCandidateStorePort } from './store.js';
import type { ContextCandidateEmbeddingPort } from './types.js';

const vector = (...values: number[]): string => JSON.stringify(values);

const candidate = (
  overrides: Partial<ContextCandidateForDedup> & { candidateKey: string },
): ContextCandidateForDedup => ({
  id: `${overrides.candidateKey}-id`,
  candidateKey: overrides.candidateKey,
  topic: overrides.topic ?? overrides.candidateKey,
  assertion: overrides.assertion ?? `Assertion for ${overrides.candidateKey}`,
  promotionScore: overrides.promotionScore ?? 1,
  createdAt: overrides.createdAt ?? new Date('2026-04-29T10:00:00.000Z'),
  evidenceChunkIds: overrides.evidenceChunkIds ?? [],
  evidenceRefs: overrides.evidenceRefs ?? [],
  embedding: 'embedding' in overrides ? (overrides.embedding ?? null) : vector(1, 0, 0),
  lane: overrides.lane ?? null,
});

function buildHarness(
  overrides: {
    enabled?: boolean;
    threshold?: number;
    scoreAggregation?: 'max' | 'mean' | 'sum';
    candidates?: ContextCandidateForDedup[];
  } = {},
) {
  const store = {
    listPendingCandidatesForDedup: vi.fn().mockResolvedValue(overrides.candidates ?? []),
    updateCandidateEmbedding: vi.fn().mockResolvedValue(undefined),
    markCandidatesAsMergedToCluster: vi.fn().mockResolvedValue(undefined),
    listBudgetExhaustedCandidatesForCarryForward: vi.fn(),
    listCurrentRunEvidenceChunksForCarryForward: vi.fn(),
    insertCandidate: vi.fn(),
  };
  const embeddings = {
    maxBatchSize: 100,
    computeEmbedding: vi.fn(),
    computeEmbeddingsBulk: vi.fn(),
  };
  const service = new CandidateDedupService({
    store: store as unknown as ContextCandidateStorePort,
    embeddings: embeddings as unknown as ContextCandidateEmbeddingPort,
    settings: {
      enabled: overrides.enabled ?? true,
      topicSimilarityThreshold: overrides.threshold ?? 0.85,
      scoreAggregation: overrides.scoreAggregation ?? 'max',
    },
  });

  return { service, store, embeddings };
}

describe('CandidateDedupService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns raw representatives without writes when dedup is disabled', async () => {
    const first = candidate({ candidateKey: 'first', embedding: vector(1, 0, 0) });
    const duplicate = candidate({ candidateKey: 'duplicate', embedding: vector(0.99, 0.01, 0) });
    const { service, store, embeddings } = buildHarness({
      enabled: false,
      candidates: [first, duplicate],
    });

    const result = await service.deduplicateRun('run-1');

    expect(result).toMatchObject({
      enabled: false,
      candidatesIn: 2,
      clustersOut: 2,
      mergedCount: 0,
      largestClusterSize: 1,
      embeddingFailures: 0,
    });
    expect(result.representatives.map((item) => item.candidateKey)).toEqual(['first', 'duplicate']);
    expect(store.markCandidatesAsMergedToCluster).not.toHaveBeenCalled();
    expect(embeddings.computeEmbeddingsBulk).not.toHaveBeenCalled();
  });

  it('clusters near duplicates and persists representative evidence unions', async () => {
    const rep = candidate({
      candidateKey: 'icp-primary',
      topic: 'ICP',
      assertion: 'Finance operators are the ICP.',
      promotionScore: 11,
      evidenceChunkIds: ['00000000-0000-0000-0000-000000000001'],
      evidenceRefs: [{ stableCitationKey: 'icp-a', rawPath: 'pages/a/page.md' }],
      embedding: vector(1, 0, 0),
    });
    const duplicate = candidate({
      candidateKey: 'icp-duplicate',
      topic: 'Ideal customer profile',
      assertion: 'The ICP is finance teams.',
      promotionScore: 7,
      evidenceChunkIds: ['00000000-0000-0000-0000-000000000002'],
      evidenceRefs: [{ stableCitationKey: 'icp-b', rawPath: 'pages/b/page.md' }],
      embedding: vector(0.99, 0.02, 0),
    });
    const unique = candidate({
      candidateKey: 'pricing-policy',
      promotionScore: 6,
      evidenceChunkIds: ['00000000-0000-0000-0000-000000000003'],
      evidenceRefs: [{ stableCitationKey: 'price-a', rawPath: 'pages/pricing/page.md' }],
      embedding: vector(0, 1, 0),
    });
    const { service, store } = buildHarness({ candidates: [rep, duplicate, unique] });

    const result = await service.deduplicateRun('run-1');

    expect(result).toMatchObject({
      enabled: true,
      candidatesIn: 3,
      clustersOut: 2,
      mergedCount: 1,
      largestClusterSize: 2,
      embeddingFailures: 0,
    });
    expect(result.representatives.map((item) => item.candidateKey)).toEqual(['icp-primary', 'pricing-policy']);
    expect(store.markCandidatesAsMergedToCluster).toHaveBeenCalledWith({
      representativeId: rep.id,
      memberIds: [duplicate.id],
      evidenceChunkIds: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'],
      evidenceRefs: [
        { stableCitationKey: 'icp-a', rawPath: 'pages/a/page.md' },
        { stableCitationKey: 'icp-b', rawPath: 'pages/b/page.md' },
      ],
      promotionScore: 11,
    });
  });

  it('uses the configured similarity threshold', async () => {
    const base = candidate({ candidateKey: 'base', embedding: vector(1, 0, 0), promotionScore: 5 });
    const borderline = candidate({ candidateKey: 'borderline', embedding: vector(0.8, 0.6, 0), promotionScore: 4 });

    const strict = buildHarness({ candidates: [base, borderline], threshold: 0.95 });
    const strictResult = await strict.service.deduplicateRun('run-1');
    expect(strictResult.clustersOut).toBe(2);
    expect(strict.store.markCandidatesAsMergedToCluster).not.toHaveBeenCalled();

    const loose = buildHarness({ candidates: [base, borderline], threshold: 0.75 });
    const looseResult = await loose.service.deduplicateRun('run-1');
    expect(looseResult.clustersOut).toBe(1);
    expect(loose.store.markCandidatesAsMergedToCluster).toHaveBeenCalledTimes(1);
  });

  it('fills missing embeddings in batches and persists them before clustering', async () => {
    const first = candidate({ candidateKey: 'missing-a', embedding: null });
    const second = candidate({ candidateKey: 'missing-b', embedding: null });
    const { service, store, embeddings } = buildHarness({ candidates: [first, second] });
    embeddings.computeEmbeddingsBulk.mockResolvedValueOnce([
      [1, 0, 0],
      [0, 1, 0],
    ]);

    const result = await service.deduplicateRun('run-1');

    expect(result.embeddingFailures).toBe(0);
    expect(embeddings.computeEmbeddingsBulk).toHaveBeenCalledWith([
      'missing-a - Assertion for missing-a',
      'missing-b - Assertion for missing-b',
    ]);
    expect(store.updateCandidateEmbedding).toHaveBeenCalledWith(first.id, [1, 0, 0]);
    expect(store.updateCandidateEmbedding).toHaveBeenCalledWith(second.id, [0, 1, 0]);
  });

  it('isolates a single embedding failure and keeps that candidate as a singleton', async () => {
    const first = candidate({ candidateKey: 'embed-ok', embedding: null });
    const second = candidate({ candidateKey: 'embed-fail', embedding: null });
    const { service, store, embeddings } = buildHarness({ candidates: [first, second] });
    embeddings.computeEmbeddingsBulk.mockRejectedValueOnce(new Error('bulk provider unavailable'));
    embeddings.computeEmbedding
      .mockResolvedValueOnce([1, 0, 0])
      .mockRejectedValueOnce(new Error('single candidate failed'));

    const result = await service.deduplicateRun('run-1');

    expect(result.embeddingFailures).toBe(1);
    expect(result.clustersOut).toBe(2);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'embedding bulk failed: bulk provider unavailable; falling back to per-candidate embedding for 2 candidates',
        ),
        expect.stringContaining('Embedding failed for candidate embed-fail'),
      ]),
    );
    expect(store.updateCandidateEmbedding).toHaveBeenCalledTimes(1);
    expect(store.updateCandidateEmbedding).toHaveBeenCalledWith(first.id, [1, 0, 0]);
  });

  it('applies mean and sum score aggregation modes', async () => {
    const rep = candidate({ candidateKey: 'score-rep', promotionScore: 9, embedding: vector(1, 0, 0) });
    const duplicate = candidate({
      candidateKey: 'score-duplicate',
      promotionScore: 3,
      embedding: vector(0.99, 0.02, 0),
    });

    const mean = buildHarness({ candidates: [rep, duplicate], scoreAggregation: 'mean' });
    await mean.service.deduplicateRun('run-1');
    expect(mean.store.markCandidatesAsMergedToCluster).toHaveBeenCalledWith(
      expect.objectContaining({ promotionScore: 6 }),
    );

    const sum = buildHarness({ candidates: [rep, duplicate], scoreAggregation: 'sum' });
    await sum.service.deduplicateRun('run-1');
    expect(sum.store.markCandidatesAsMergedToCluster).toHaveBeenCalledWith(
      expect.objectContaining({ promotionScore: 12 }),
    );
  });

  it('rounds mean score aggregation for the integer promotion score column', async () => {
    const rep = candidate({ candidateKey: 'rounded-rep', promotionScore: 10, embedding: vector(1, 0, 0) });
    const duplicate = candidate({
      candidateKey: 'rounded-duplicate',
      promotionScore: 7,
      embedding: vector(0.99, 0.02, 0),
    });
    const { service, store } = buildHarness({ candidates: [rep, duplicate], scoreAggregation: 'mean' });

    await service.deduplicateRun('run-1');

    expect(store.markCandidatesAsMergedToCluster).toHaveBeenCalledWith(expect.objectContaining({ promotionScore: 9 }));
  });

  it('is a no-op on a rerun after non-representatives are already merged', async () => {
    const rep = candidate({ candidateKey: 'rerun-rep', promotionScore: 9, embedding: vector(1, 0, 0) });
    const duplicate = candidate({
      candidateKey: 'rerun-duplicate',
      promotionScore: 3,
      embedding: vector(0.99, 0.02, 0),
    });
    const { service, store } = buildHarness();
    store.listPendingCandidatesForDedup.mockResolvedValueOnce([rep, duplicate]).mockResolvedValueOnce([rep]);

    const first = await service.deduplicateRun('run-1');
    const second = await service.deduplicateRun('run-1');

    expect(first.mergedCount).toBe(1);
    expect(second.mergedCount).toBe(0);
    expect(second.clustersOut).toBe(1);
    expect(store.markCandidatesAsMergedToCluster).toHaveBeenCalledTimes(1);
  });

  it('returns raw candidates with a warning when cluster persistence throws', async () => {
    const rep = candidate({ candidateKey: 'persist-rep', promotionScore: 9, embedding: vector(1, 0, 0) });
    const duplicate = candidate({
      candidateKey: 'persist-duplicate',
      promotionScore: 3,
      embedding: vector(0.99, 0.02, 0),
    });
    const { service, store } = buildHarness({ candidates: [rep, duplicate] });
    store.markCandidatesAsMergedToCluster.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await service.deduplicateRun('run-1');

    expect(result.clustersOut).toBe(2);
    expect(result.mergedCount).toBe(0);
    expect(result.representatives.map((item) => item.candidateKey)).toEqual(['persist-rep', 'persist-duplicate']);
    expect(result.warnings).toEqual([expect.stringContaining('Dedup failed for run run-1')]);
  });
});
