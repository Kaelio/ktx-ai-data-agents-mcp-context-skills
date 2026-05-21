import { describe, expect, it, vi } from 'vitest';
import type { ContextCandidateForDedup } from '../ports.js';
import { type CuratorPaginationInput, CuratorPaginationService } from './curator-pagination.service.js';
import type { ContextCandidateStorePort } from './store.js';

const candidate = (key: string, score: number): ContextCandidateForDedup => ({
  id: `id-${key}`,
  candidateKey: key,
  topic: `Topic ${key}`,
  assertion: `Assertion ${key}`,
  promotionScore: score,
  createdAt: new Date(`2026-04-30T10:0${score % 10}:00.000Z`),
  evidenceChunkIds: [`chunk-${key}`],
  evidenceRefs: [{ stableCitationKey: `ref-${key}` }],
  embedding: null,
  lane: 'full',
});

const promptCandidate = (key: string, score: number) => ({
  candidateKey: key,
  topic: `Topic ${key}`,
  assertion: `Assertion ${key}`,
  rationale: `Rationale ${key}`,
  actionHint: 'create',
  status: 'pending',
  promotionScore: score,
  suggestedPageKey: `page-${key}`,
  evidenceRefs: [{ stableCitationKey: `ref-${key}` }],
});

function makeHarness(overrides: Partial<{ batchSize: number; maxPasses: number; stepBudgetPerPass: number }> = {}) {
  const store = {
    listPendingCandidatesForDedup: vi.fn().mockResolvedValue([]),
    updateCandidateEmbedding: vi.fn().mockResolvedValue(undefined),
    markCandidatesAsMergedToCluster: vi.fn().mockResolvedValue(undefined),
    listBudgetExhaustedCandidatesForCarryForward: vi.fn().mockResolvedValue([]),
    listCurrentRunEvidenceChunksForCarryForward: vi.fn().mockResolvedValue([]),
    insertCandidate: vi.fn().mockResolvedValue({ id: 'candidate-1' }),
    listCandidatesForPromptByKeys: vi
      .fn()
      .mockImplementation((_runId: string, keys: string[]) =>
        Promise.resolve(keys.map((key) => promptCandidate(key, Number(key.replace('c', '')) || 1))),
      ),
    markPendingCandidatesByReason: vi.fn().mockResolvedValue(0),
    summarizeCandidateVerdicts: vi.fn().mockResolvedValue({
      pending: 0,
      promoted: 1,
      merged: 1,
      rejected: 1,
      conflict: 0,
      rejectedByReason: { exceeded_curator_passes: 1 },
    }),
  } satisfies ContextCandidateStorePort;
  const agentRunner = {
    runLoop: vi.fn().mockResolvedValue({ stopReason: 'natural' }),
  };
  const actions: Array<{ target: 'wiki'; type: 'created' | 'updated'; key: string; detail: string }> = [];
  const prompts: string[] = [];
  const service = new CuratorPaginationService({
    store,
    agentRunner: agentRunner as never,
    settings: {
      batchSize: overrides.batchSize ?? 2,
      maxPasses: overrides.maxPasses ?? 2,
      stepBudgetPerPass: overrides.stepBudgetPerPass ?? 7,
    },
  });

  const input = (
    representatives = [candidate('c1', 10), candidate('c2', 9), candidate('c3', 8)],
  ): CuratorPaginationInput => ({
    runId: 'run-1',
    sourceKey: 'notion',
    jobId: 'job-1',
    stageIndex: {
      jobId: 'job-1',
      connectionId: 'c1',
      workUnits: [],
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
    },
    evictionUnit: undefined,
    representatives,
    initialBudget: { creates: 2, updates: 1 },
    modelRole: 'curator',
    buildSystemPrompt: () => 'system prompt',
    buildUserPrompt: ({ runState, items }) => {
      const prompt = `pass=${runState.passNumber}; budget=${runState.budgetRemaining.creates}/${
        runState.budgetRemaining.updates
      }; items=${items.map((item) => item.candidateKey).join(',')}; previous=${runState.previouslyPromotedInRun
        .map((page) => page.pageKey)
        .join(',')}`;
      prompts.push(prompt);
      return prompt;
    },
    buildToolSet: () => ({}),
    getReconciliationActions: () => actions,
  });

  return { store, agentRunner, actions, prompts, service, input };
}

describe('CuratorPaginationService', () => {
  it('paginates representatives and carries budget plus previous wiki writes into later passes', async () => {
    const harness = makeHarness({ batchSize: 2, maxPasses: 2, stepBudgetPerPass: 7 });
    harness.agentRunner.runLoop.mockImplementation(() => {
      if (harness.actions.length === 0) {
        harness.actions.push({ target: 'wiki', type: 'created', key: 'page-c1', detail: 'Created C1' });
      }
      return { stopReason: 'natural' };
    });

    const result = await harness.service.reconcile(harness.input());

    expect(harness.agentRunner.runLoop).toHaveBeenCalledTimes(2);
    expect(harness.agentRunner.runLoop).toHaveBeenCalledWith(expect.objectContaining({ modelRole: 'curator' }));
    expect(harness.prompts[0]).toContain('pass=1');
    expect(harness.prompts[0]).toContain('budget=2/1');
    expect(harness.prompts[0]).toContain('items=c1,c2');
    expect(harness.prompts[1]).toContain('pass=2');
    expect(harness.prompts[1]).toContain('budget=1/1');
    expect(harness.prompts[1]).toContain('previous=page-c1');
    expect(result.report).toMatchObject({
      passesRun: 2,
      topicsExamined: 3,
      topicsByVerdict: { promoted: 1, merged: 1, rejected: 1, conflict: 0 },
      topicsRejectedByReason: { exceeded_curator_passes: 1 },
      budgetExhausted: false,
    });
  });

  it('marks unprocessed representatives when maxPasses is exhausted', async () => {
    const harness = makeHarness({ batchSize: 1, maxPasses: 1 });

    await harness.service.reconcile(harness.input([candidate('c1', 10), candidate('c2', 9)]));

    expect(harness.store.markPendingCandidatesByReason).toHaveBeenCalledWith({
      runId: 'run-1',
      candidateKeys: ['c2'],
      rejectionReason: 'exceeded_curator_passes',
    });
    expect(harness.store.markPendingCandidatesByReason).toHaveBeenCalledWith({
      runId: 'run-1',
      candidateKeys: ['c1', 'c2'],
      rejectionReason: 'exceeded_curator_passes',
    });
  });

  it('marks remaining pending representatives when run budget is exhausted', async () => {
    const harness = makeHarness({ batchSize: 1, maxPasses: 5 });
    const input = harness.input([candidate('c1', 10), candidate('c2', 9), candidate('c3', 8)]);
    input.initialBudget = { creates: 1, updates: 0 };
    harness.agentRunner.runLoop.mockImplementation(() => {
      harness.actions.push({ target: 'wiki', type: 'created', key: 'page-c1', detail: 'Created C1' });
      return { stopReason: 'natural' };
    });

    const result = await harness.service.reconcile(input);

    expect(harness.agentRunner.runLoop).toHaveBeenCalledTimes(1);
    expect(harness.store.markPendingCandidatesByReason).toHaveBeenCalledWith({
      runId: 'run-1',
      candidateKeys: ['c1', 'c2', 'c3'],
      rejectionReason: 'exceeded_run_budget',
    });
    expect(result.report.budgetExhausted).toBe(true);
  });

  it('marks a failed pass with curator_pass_error and continues to later batches', async () => {
    const harness = makeHarness({ batchSize: 1, maxPasses: 3 });
    harness.agentRunner.runLoop
      .mockResolvedValueOnce({ stopReason: 'error', error: new Error('provider timeout') })
      .mockResolvedValue({ stopReason: 'natural' });

    const result = await harness.service.reconcile(harness.input([candidate('c1', 10), candidate('c2', 9)]));

    expect(harness.agentRunner.runLoop).toHaveBeenCalledTimes(2);
    expect(harness.store.markPendingCandidatesByReason).toHaveBeenCalledWith({
      runId: 'run-1',
      candidateKeys: ['c1'],
      rejectionReason: 'curator_pass_error',
    });
    expect(result.warnings).toContain('Curator pass 1 failed: provider timeout');
  });

  it('skips when there are no representatives and no reconciliation work', async () => {
    const harness = makeHarness();

    const result = await harness.service.reconcile(harness.input([]));

    expect(result.skipped).toBe(true);
    expect(harness.agentRunner.runLoop).not.toHaveBeenCalled();
    expect(result.report.topicsExamined).toBe(0);
  });
});
