import { describe, expect, it, vi } from 'vitest';
import { createEvictionListTool } from '../../../../src/context/ingest/tools/eviction-list.tool.js';

describe('eviction_list tool', () => {
  it('returns artifacts produced for each deleted raw path', async () => {
    const provenance = {
      findLatestArtifactsForRawPaths: vi.fn().mockResolvedValue(
        new Map([
          [
            'views/old.lkml',
            [{ artifact_kind: 'sl', artifact_key: 'old_metric', action_type: 'source_created' } as any],
          ],
          ['views/gone.lkml', []],
        ]),
      ),
    };
    const tool = createEvictionListTool({
      provenance: provenance as any,
      connectionId: 'c1',
      sourceKey: 'lookml',
      deletedRawPaths: ['views/old.lkml', 'views/gone.lkml'],
    });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      {},
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toContain('views/old.lkml');
    expect(out).toContain('old_metric');
    expect(out).toContain('views/gone.lkml');
  });

  it('returns empty string when no deletions', async () => {
    const tool = createEvictionListTool({
      provenance: {} as any,
      connectionId: 'c1',
      sourceKey: 'lookml',
      deletedRawPaths: [],
    });
    const out = (await (tool.execute as (...args: unknown[]) => unknown)(
      {},
      { toolCallId: 't', messages: [] },
    )) as string;
    expect(out).toMatch(/empty/i);
  });

  it('tells curators to record decisions', () => {
    const tool = createEvictionListTool({
      provenance: {} as any,
      connectionId: 'c1',
      sourceKey: 'lookml',
      deletedRawPaths: [],
    });

    expect(tool.description).toContain('emit_eviction_decision');
  });
});
