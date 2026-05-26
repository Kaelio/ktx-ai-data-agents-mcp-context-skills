import { describe, expect, it } from 'vitest';
import { createStageListTool } from '../../../../src/context/ingest/tools/stage-list.tool.js';

describe('stage_list tool', () => {
  it('returns a compact summary of the stage index', async () => {
    const tool = createStageListTool({
      stageIndex: {
        jobId: 'j1',
        connectionId: 'c1',
        workUnits: [
          {
            unitKey: 'u1',
            rawFiles: ['a.yml'],
            status: 'success',
            actions: [{ target: 'sl', type: 'created', key: 'src_a', detail: '' }],
            touchedSlSources: [{ connectionId: 'c1', sourceName: 'src_a' }],
          },
          {
            unitKey: 'u2',
            rawFiles: ['b.yml'],
            status: 'success',
            actions: [
              {
                target: 'wiki',
                type: 'created',
                key: 'page_b',
                detail: 'tables: orbit_analytics.customer',
              },
            ],
            touchedSlSources: [],
          },
        ],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
    });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      {},
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toContain('u1');
    expect(out).toContain('src_a');
    expect(out).toContain('u2');
    expect(out).toContain('page_b');
    expect(out).toContain('tables: orbit_analytics.customer');
  });

  it('says empty when no writes', async () => {
    const tool = createStageListTool({
      stageIndex: {
        jobId: 'j',
        connectionId: 'c1',
        workUnits: [],
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
      },
    });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      {},
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toMatch(/empty/i);
  });
});
