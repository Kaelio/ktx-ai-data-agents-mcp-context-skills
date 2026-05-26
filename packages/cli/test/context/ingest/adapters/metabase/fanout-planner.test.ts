import { describe, expect, it } from 'vitest';
import { planMetabaseFanoutChildren } from '../../../../../src/context/ingest/adapters/metabase/fanout-planner.js';

describe('planMetabaseFanoutChildren', () => {
  it('builds ordered child plans for sync-enabled mapped Metabase databases', () => {
    const plans = planMetabaseFanoutChildren({
      metabaseConnectionId: 'prod-metabase',
      mappings: [
        { metabaseDatabaseId: 1, targetConnectionId: 'warehouse_a', syncEnabled: true },
        { metabaseDatabaseId: 2, targetConnectionId: null, syncEnabled: true },
        { metabaseDatabaseId: 3, targetConnectionId: 'warehouse_c', syncEnabled: false },
        { metabaseDatabaseId: 4, targetConnectionId: 'warehouse_b', syncEnabled: true },
      ],
    });

    expect(plans).toEqual([
      {
        metabaseConnectionId: 'prod-metabase',
        metabaseDatabaseId: 1,
        targetConnectionId: 'warehouse_a',
        pullConfig: { metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 1 },
      },
      {
        metabaseConnectionId: 'prod-metabase',
        metabaseDatabaseId: 4,
        targetConnectionId: 'warehouse_b',
        pullConfig: { metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 4 },
      },
    ]);
  });

  it('rejects invalid generated pull configs before any host enqueues work', () => {
    expect(() =>
      planMetabaseFanoutChildren({
        metabaseConnectionId: 'prod-metabase',
        mappings: [{ metabaseDatabaseId: 0, targetConnectionId: 'warehouse_a', syncEnabled: true }],
      }),
    ).toThrow(/metabaseDatabaseId/);
  });

  it('rejects source states with no sync-enabled target mappings', () => {
    expect(() =>
      planMetabaseFanoutChildren({
        metabaseConnectionId: 'prod-metabase',
        mappings: [
          { metabaseDatabaseId: 1, targetConnectionId: null, syncEnabled: true },
          { metabaseDatabaseId: 2, targetConnectionId: 'warehouse_b', syncEnabled: false },
        ],
      }),
    ).toThrow('no sync-enabled mappings with a target connection for Metabase connection prod-metabase');
  });
});
