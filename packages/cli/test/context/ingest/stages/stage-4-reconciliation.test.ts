import { describe, expect, it, vi } from 'vitest';
import { runReconciliationStage4 } from '../../../../src/context/ingest/stages/stage-4-reconciliation.js';

describe('Stage 4 — runReconciliationStage4', () => {
  it('short-circuits when stage index is empty and eviction is empty', async () => {
    const runLoop = vi.fn();
    const result = await runReconciliationStage4({
      stageIndex: {
        jobId: 'j1',
        connectionId: 'c1',
        workUnits: [],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
      evictionUnit: undefined,
      agentRunner: { runLoop } as any,
      buildSystemPrompt: () => 's',
      buildUserPrompt: () => 'u',
      buildToolSet: () => ({}),
      modelRole: 'reconcile',
      stepBudget: 60,
      sourceKey: 'fake',
      jobId: 'j1',
    });
    expect(result.skipped).toBe(true);
    expect(runLoop).not.toHaveBeenCalled();
  });

  it('invokes the agent when any WU wrote actions', async () => {
    const runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' });
    const result = await runReconciliationStage4({
      stageIndex: {
        jobId: 'j1',
        connectionId: 'c1',
        workUnits: [
          {
            unitKey: 'u1',
            rawFiles: ['a.yml'],
            status: 'success',
            actions: [{ target: 'sl', type: 'created', key: 'src_a', detail: 'x' }],
            touchedSlSources: [{ connectionId: 'c1', sourceName: 'src_a' }],
          },
        ],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
      evictionUnit: undefined,
      agentRunner: { runLoop } as any,
      buildSystemPrompt: () => 's',
      buildUserPrompt: () => 'u',
      buildToolSet: () => ({}),
      modelRole: 'reconcile',
      stepBudget: 60,
      sourceKey: 'fake',
      jobId: 'j1',
    });
    expect(result.skipped).toBe(false);
    expect(runLoop).toHaveBeenCalledOnce();
    expect(runLoop).toHaveBeenCalledWith(expect.objectContaining({ modelRole: 'reconcile' }));
  });

  it('invokes the agent when eviction set is non-empty even with no writes', async () => {
    const runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' });
    const result = await runReconciliationStage4({
      stageIndex: {
        jobId: 'j1',
        connectionId: 'c1',
        workUnits: [],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
      evictionUnit: { deletedRawPaths: ['views/old.lkml'] },
      agentRunner: { runLoop } as any,
      buildSystemPrompt: () => 's',
      buildUserPrompt: () => 'u',
      buildToolSet: () => ({}),
      modelRole: 'reconcile',
      stepBudget: 60,
      sourceKey: 'fake',
      jobId: 'j1',
    });
    expect(result.skipped).toBe(false);
    expect(runLoop).toHaveBeenCalledOnce();
  });

  it('invokes the agent when forced for candidate reconciliation', async () => {
    const runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' });
    const result = await runReconciliationStage4({
      stageIndex: {
        jobId: 'j1',
        connectionId: 'c1',
        workUnits: [],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
      evictionUnit: undefined,
      agentRunner: { runLoop } as any,
      buildSystemPrompt: () => 's',
      buildUserPrompt: () => 'u',
      buildToolSet: () => ({}),
      modelRole: 'reconcile',
      stepBudget: 60,
      sourceKey: 'fake',
      jobId: 'j1',
      forceRun: true,
    });
    expect(result.skipped).toBe(false);
    expect(runLoop).toHaveBeenCalledOnce();
  });

  it('returns stopReason on runner error', async () => {
    const err = new Error('LLM timeout');
    const runLoop = vi.fn().mockResolvedValue({ stopReason: 'error', error: err });
    const result = await runReconciliationStage4({
      stageIndex: {
        jobId: 'j1',
        connectionId: 'c1',
        workUnits: [
          {
            unitKey: 'u1',
            rawFiles: [],
            status: 'success',
            actions: [{ target: 'sl', type: 'created', key: 'k', detail: 'd' }],
            touchedSlSources: [],
          },
        ],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
      evictionUnit: undefined,
      agentRunner: { runLoop } as any,
      buildSystemPrompt: () => 's',
      buildUserPrompt: () => 'u',
      buildToolSet: () => ({}),
      modelRole: 'reconcile',
      stepBudget: 60,
      sourceKey: 'fake',
      jobId: 'j1',
    });
    expect(result.skipped).toBe(false);
    expect(result.stopReason).toBe('error');
    expect(result.error).toBe(err);
  });
});
