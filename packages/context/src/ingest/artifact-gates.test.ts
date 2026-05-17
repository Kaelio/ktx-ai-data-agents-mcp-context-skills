import { describe, expect, it, vi } from 'vitest';
import { validateFinalIngestArtifacts, validateProvenanceRawPaths } from './artifact-gates.js';

describe('artifact gates', () => {
  it('fails the final tree when wiki body references a stale semantic-layer measure', async () => {
    const wikiService = {
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'account-segments',
        frontmatter: {
          summary: 'Account segments',
          usage_mode: 'auto',
          sl_refs: ['mart_account_segments'],
        },
        content: 'ARR is `mart_account_segments.total_contract_arr_cents`.',
      }),
    };
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({
        sources: [
          {
            name: 'mart_account_segments',
            grain: ['account_id'],
            columns: [{ name: 'account_id', type: 'string' }],
            joins: [],
            measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
            table: 'analytics.mart_account_segments',
          },
        ],
        loadErrors: [],
      }),
    };

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: ['account-segments'],
        touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
        wikiService: wikiService as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources: async () => ({ invalidSources: [], validSources: ['mart_account_segments'] }),
        tableExists: async () => true,
      }),
    ).rejects.toThrow(/unknown semantic-layer entity mart_account_segments\.total_contract_arr_cents/);
  });

  it('fails before provenance insertion when a raw path cannot be tied to the current snapshot or eviction set', () => {
    expect(() =>
      validateProvenanceRawPaths({
        rows: [{ rawPath: 'cards/missing.json' }],
        currentRawPaths: new Set(['cards/present.json']),
        deletedRawPaths: new Set(['cards/deleted.json']),
      }),
    ).toThrow(/provenance row references raw path outside this snapshot: cards\/missing\.json/);
  });
});
