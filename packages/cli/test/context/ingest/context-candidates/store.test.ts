import { describe, expect, it, vi } from 'vitest';
import type { ContextCandidateForDedup } from '../../../../src/context/ingest/ports.js';
import type { ContextCandidateStorePort } from '../../../../src/context/ingest/context-candidates/store.js';
import type { InsertContextCandidateInput } from '../../../../src/context/ingest/context-candidates/types.js';

const candidate: ContextCandidateForDedup = {
  id: 'candidate-1',
  candidateKey: 'revenue-policy',
  topic: 'Revenue policy',
  assertion: 'Booked revenue excludes refunds.',
  promotionScore: 10,
  createdAt: new Date('2026-04-30T10:00:00.000Z'),
  evidenceChunkIds: ['chunk-1'],
  evidenceRefs: [{ stableCitationKey: 'notion:page-1:revenue' }],
  embedding: '[1,0,0]',
  lane: 'full',
};

const insert: InsertContextCandidateInput = {
  runId: 'run-1',
  connectionId: 'connection-1',
  sourceKey: 'notion',
  candidateKey: 'revenue-policy',
  topic: 'Revenue policy',
  assertion: 'Booked revenue excludes refunds.',
  rationale: 'Finance handbook says this.',
  evidenceChunkIds: ['chunk-1'],
  evidenceRefs: [{ stableCitationKey: 'notion:page-1:revenue' }],
  suggestedPageKey: 'revenue-policy',
  actionHint: 'create',
  durabilityScore: 3,
  authorityScore: 3,
  reuseScore: 3,
  noveltyScore: 2,
  riskScore: 1,
  promotionScore: 10,
  status: 'pending',
  rejectionReason: null,
  lane: 'full',
  embedding: null,
};

describe('ContextCandidateStorePort', () => {
  it('describes the persistence operations required by candidate services', async () => {
    const store: ContextCandidateStorePort = {
      listPendingCandidatesForDedup: vi.fn().mockResolvedValue([candidate]),
      updateCandidateEmbedding: vi.fn().mockResolvedValue(undefined),
      markCandidatesAsMergedToCluster: vi.fn().mockResolvedValue(undefined),
      listBudgetExhaustedCandidatesForCarryForward: vi.fn().mockResolvedValue([]),
      listCurrentRunEvidenceChunksForCarryForward: vi.fn().mockResolvedValue([]),
      insertCandidate: vi.fn().mockResolvedValue({ id: 'candidate-2' }),
      listCandidatesForPromptByKeys: vi.fn().mockResolvedValue([]),
      markPendingCandidatesByReason: vi.fn().mockResolvedValue(0),
      summarizeCandidateVerdicts: vi.fn().mockResolvedValue({
        pending: 0,
        promoted: 0,
        merged: 0,
        rejected: 0,
        conflict: 0,
        rejectedByReason: {},
      }),
    };

    await expect(store.listPendingCandidatesForDedup('run-1')).resolves.toEqual([candidate]);
    await expect(store.insertCandidate(insert)).resolves.toEqual({ id: 'candidate-2' });
    await expect(
      store.markCandidatesAsMergedToCluster({
        representativeId: 'candidate-1',
        memberIds: ['candidate-3'],
        evidenceChunkIds: ['chunk-1', 'chunk-3'],
        evidenceRefs: [{ stableCitationKey: 'notion:page-1:revenue' }],
        promotionScore: 10,
      }),
    ).resolves.toBeUndefined();
  });
});
