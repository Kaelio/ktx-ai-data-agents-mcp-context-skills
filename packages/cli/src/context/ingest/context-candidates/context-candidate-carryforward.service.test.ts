import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContextCandidateCarryforwardService } from './context-candidate-carryforward.service.js';
import type { ContextCandidateStorePort } from './store.js';
import type { BudgetExhaustedCandidateForCarryForward, CurrentRunEvidenceChunkForCarryForward } from './types.js';

function candidate(
  overrides: Partial<BudgetExhaustedCandidateForCarryForward> = {},
): BudgetExhaustedCandidateForCarryForward {
  return {
    sourceRunId: 'prior-run-1',
    candidateKey: 'budget-revenue-policy',
    topic: 'Revenue policy',
    assertion: 'Booked revenue excludes refunds.',
    rationale: 'The finance handbook states this reusable rule.',
    evidenceChunkIds: ['prior-chunk-1'],
    evidenceRefs: [
      {
        chunkId: 'prior-chunk-1',
        stableCitationKey: 'notion:page-1:revenue-policy',
        syncId: 'sync-prior',
        rawPath: 'pages/page-1/page.md',
      },
    ],
    suggestedPageKey: 'revenue-policy',
    actionHint: 'create',
    durabilityScore: 3,
    authorityScore: 3,
    reuseScore: 3,
    noveltyScore: 2,
    riskScore: 1,
    promotionScore: 10,
    lane: 'full',
    ...overrides,
  };
}

function chunk(
  overrides: Partial<CurrentRunEvidenceChunkForCarryForward> = {},
): CurrentRunEvidenceChunkForCarryForward {
  return {
    chunkId: 'current-chunk-1',
    stableCitationKey: 'notion:page-1:revenue-policy',
    syncId: 'sync-current',
    rawPath: 'pages/page-1/page.md',
    title: 'Revenue Policy',
    path: 'Company / Revenue Policy',
    url: 'https://notion.example/page-1',
    lastEditedAt: new Date('2026-04-30T12:00:00.000Z'),
    citation: {
      source: 'notion',
      pageId: 'page-1',
      syncId: 'sync-current',
      rawPath: 'pages/page-1/page.md',
    },
    content: 'Booked revenue excludes refunds and test accounts.',
    ...overrides,
  };
}

function buildHarness(reExamineBudgetExhaustedOnRerun: boolean) {
  const store = {
    listPendingCandidatesForDedup: vi.fn(),
    updateCandidateEmbedding: vi.fn(),
    markCandidatesAsMergedToCluster: vi.fn(),
    listBudgetExhaustedCandidatesForCarryForward: vi.fn(),
    listCurrentRunEvidenceChunksForCarryForward: vi.fn(),
    insertCandidate: vi.fn().mockResolvedValue({ id: 'new-candidate-1' }),
  };
  const service = new ContextCandidateCarryforwardService({
    store: store as unknown as ContextCandidateStorePort,
    settings: { reExamineBudgetExhaustedOnRerun },
  });
  return { service, store };
}

describe('ContextCandidateCarryforwardService', () => {
  it('carries a prior budget-exhausted candidate with remapped current evidence', async () => {
    const { service, store } = buildHarness(true);
    store.listBudgetExhaustedCandidatesForCarryForward.mockResolvedValueOnce([candidate()]);
    store.listCurrentRunEvidenceChunksForCarryForward.mockResolvedValueOnce([chunk()]);

    const result = await service.carryForward({
      runId: 'current-run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
    });

    expect(result).toMatchObject({
      considered: 1,
      carriedForward: 1,
      skippedNotReemitted: 0,
      remappedEvidenceRefs: 1,
      staleEvidenceRefs: 0,
    });
    expect(store.insertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'current-run-1',
        connectionId: 'connection-1',
        sourceKey: 'notion',
        candidateKey: 'budget-revenue-policy',
        evidenceChunkIds: ['current-chunk-1'],
        evidenceRefs: [
          expect.objectContaining({
            chunkId: 'current-chunk-1',
            stableCitationKey: 'notion:page-1:revenue-policy',
            syncId: 'sync-current',
            snippetHash: createHash('sha256')
              .update('Booked revenue excludes refunds and test accounts.')
              .digest('hex'),
          }),
        ],
        status: 'pending',
        rejectionReason: null,
        lane: 'full',
        embedding: null,
      }),
    );
    expect(result.warnings).toEqual(['Re-examined 1 prior budget-exhausted context candidate.']);
  });

  it('skips stale prior candidates when config requires current evidence re-emission', async () => {
    const { service, store } = buildHarness(false);
    store.listBudgetExhaustedCandidatesForCarryForward.mockResolvedValueOnce([candidate()]);
    store.listCurrentRunEvidenceChunksForCarryForward.mockResolvedValueOnce([]);

    const result = await service.carryForward({
      runId: 'current-run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
    });

    expect(result).toMatchObject({
      considered: 1,
      carriedForward: 0,
      skippedNotReemitted: 1,
      remappedEvidenceRefs: 0,
      staleEvidenceRefs: 0,
    });
    expect(store.insertCandidate).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      'Skipped 1 budget-exhausted context candidate because its evidence was not re-emitted in this run.',
    ]);
  });

  it('carries stale prior evidence when reExamineBudgetExhaustedOnRerun is enabled', async () => {
    const { service, store } = buildHarness(true);
    store.listBudgetExhaustedCandidatesForCarryForward.mockResolvedValueOnce([candidate()]);
    store.listCurrentRunEvidenceChunksForCarryForward.mockResolvedValueOnce([]);

    const result = await service.carryForward({
      runId: 'current-run-1',
      connectionId: 'connection-1',
      sourceKey: 'notion',
    });

    expect(result).toMatchObject({
      considered: 1,
      carriedForward: 1,
      skippedNotReemitted: 0,
      remappedEvidenceRefs: 0,
      staleEvidenceRefs: 1,
    });
    expect(store.insertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'current-run-1',
        evidenceChunkIds: ['prior-chunk-1'],
        evidenceRefs: [
          {
            chunkId: 'prior-chunk-1',
            stableCitationKey: 'notion:page-1:revenue-policy',
            syncId: 'sync-prior',
            rawPath: 'pages/page-1/page.md',
          },
        ],
      }),
    );
    expect(result.warnings).toEqual([
      'Re-examined 1 prior budget-exhausted context candidate.',
      'Carried 1 budget-exhausted evidence ref without a current-run chunk remap.',
    ]);
  });
});
