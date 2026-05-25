import { describe, expect, it } from 'vitest';
import { createStageDiffTool } from '../../../../src/context/ingest/tools/stage-diff.tool.js';

describe('stage_diff tool', () => {
  const stageIndex = {
    jobId: 'j',
    connectionId: 'c1',
    workUnits: [
      {
        unitKey: 'u1',
        rawFiles: [],
        status: 'success' as const,
        actions: [{ target: 'sl' as const, type: 'created' as const, key: 'churn_risk_score', detail: 'customers' }],
        touchedSlSources: [{ connectionId: 'c1', sourceName: 'customers' }],
      },
      {
        unitKey: 'u2',
        rawFiles: [],
        status: 'success' as const,
        actions: [{ target: 'sl' as const, type: 'created' as const, key: 'churn_risk_score', detail: 'billing' }],
        touchedSlSources: [{ connectionId: 'c1', sourceName: 'billing' }],
      },
    ],
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
  };

  it('finds overlapping artifact keys between two WUs', async () => {
    const tool = createStageDiffTool({ stageIndex });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      { unitKeyA: 'u1', unitKeyB: 'u2' },
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toContain('churn_risk_score');
    expect(out).toMatch(/overlap/i);
  });

  it('says no overlap when keys are disjoint', async () => {
    const tool = createStageDiffTool({
      stageIndex: {
        jobId: 'j',
        connectionId: 'c1',
        workUnits: [
          {
            unitKey: 'u1',
            rawFiles: [],
            status: 'success',
            actions: [{ target: 'sl', type: 'created', key: 'a', detail: '' }],
            touchedSlSources: [{ connectionId: 'c1', sourceName: 'a' }],
          },
          {
            unitKey: 'u2',
            rawFiles: [],
            status: 'success',
            actions: [{ target: 'sl', type: 'created', key: 'b', detail: '' }],
            touchedSlSources: [{ connectionId: 'c1', sourceName: 'b' }],
          },
        ],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
    });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      { unitKeyA: 'u1', unitKeyB: 'u2' },
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toMatch(/no overlap/i);
  });

  it('does not overlap same-named SL actions on different target connections', async () => {
    const tool = createStageDiffTool({
      stageIndex: {
        jobId: 'j',
        connectionId: 'looker-run',
        workUnits: [
          {
            unitKey: 'u1',
            rawFiles: [],
            status: 'success',
            actions: [
              {
                target: 'sl',
                type: 'created',
                key: 'looker__b2b__sales_pipeline',
                detail: 'W1',
                targetConnectionId: 'W1',
              },
            ],
            touchedSlSources: [{ connectionId: 'W1', sourceName: 'looker__b2b__sales_pipeline' }],
          },
          {
            unitKey: 'u2',
            rawFiles: [],
            status: 'success',
            actions: [
              {
                target: 'sl',
                type: 'created',
                key: 'looker__b2b__sales_pipeline',
                detail: 'W2',
                targetConnectionId: 'W2',
              },
            ],
            touchedSlSources: [{ connectionId: 'W2', sourceName: 'looker__b2b__sales_pipeline' }],
          },
        ],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
    });

    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      { unitKeyA: 'u1', unitKeyB: 'u2' },
      { toolCallId: 't', messages: [] },
    )) as string;

    expect(out).toMatch(/no overlap/i);
  });

  it('returns an error when a unitKey is unknown', async () => {
    const tool = createStageDiffTool({ stageIndex });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      { unitKeyA: 'u1', unitKeyB: 'nope' },
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toMatch(/unknown/i);
  });
});
