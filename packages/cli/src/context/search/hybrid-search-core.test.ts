import { describe, expect, it } from 'vitest';
import { HybridSearchCore } from './hybrid-search-core.js';
import type { SearchCandidateGenerator } from './types.js';

function generator(
  lane: string,
  candidates: Array<{ id: string; rank: number; rawScore?: number; matchReason?: string; evidence?: unknown }>,
  weight?: number,
): SearchCandidateGenerator {
  return {
    lane,
    weight,
    async generate() {
      return { candidates };
    },
  };
}

describe('HybridSearchCore', () => {
  it('runs lane generators with the shared pool size and applies final limit after RRF fusion', async () => {
    const calls: Array<{ lane: string; laneCandidatePoolLimit: number; finalLimit: number }> = [];
    const core = new HybridSearchCore();
    const result = await core.search({
      queryText: 'gross revenue',
      limit: 1,
      generators: [
        {
          lane: 'lexical',
          async generate(args) {
            calls.push({ lane: 'lexical', ...args });
            return {
              candidates: [
                { id: 'orders', rank: 1, rawScore: 0.8 },
                { id: 'customers', rank: 2, rawScore: 0.7 },
              ],
            };
          },
        },
        {
          lane: 'semantic',
          async generate(args) {
            calls.push({ lane: 'semantic', ...args });
            return { candidates: [{ id: 'customers', rank: 1, rawScore: 0.91 }] };
          },
        },
      ],
    });

    expect(calls).toEqual([
      expect.objectContaining({ lane: 'lexical', laneCandidatePoolLimit: 25, finalLimit: 1 }),
      expect.objectContaining({ lane: 'semantic', laneCandidatePoolLimit: 25, finalLimit: 1 }),
    ]);
    expect(result.results.map((candidate) => candidate.id)).toEqual(['customers']);
    expect(result.results[0]).toMatchObject({
      matchReasons: ['lexical', 'semantic'],
      ranksByLane: { lexical: 2, semantic: 1 },
      rawScoresByLane: { lexical: 0.7, semantic: 0.91 },
    });
    expect(result.lanes).toEqual([
      expect.objectContaining({ lane: 'lexical', status: 'available', returnedCandidateCount: 2, weight: 1.5 }),
      expect.objectContaining({ lane: 'semantic', status: 'available', returnedCandidateCount: 1, weight: 2 }),
    ]);
  });

  it('keeps available lane results when another lane is skipped or fails', async () => {
    const core = new HybridSearchCore();
    const result = await core.search({
      queryText: 'paid',
      limit: 5,
      generators: [
        generator('lexical', [{ id: 'orders', rank: 1 }]),
        {
          lane: 'semantic',
          async generate() {
            return { status: 'skipped', candidates: [], reason: 'embedding_unconfigured' };
          },
        },
        {
          lane: 'dictionary',
          async generate() {
            throw new Error('dictionary index unavailable');
          },
        },
      ],
    });

    expect(result.results.map((candidate) => candidate.id)).toEqual(['orders']);
    expect(result.lanes).toEqual([
      expect.objectContaining({ lane: 'lexical', status: 'available', reason: undefined }),
      expect.objectContaining({ lane: 'semantic', status: 'skipped', reason: 'embedding_unconfigured' }),
      expect.objectContaining({ lane: 'dictionary', status: 'failed', reason: 'dictionary index unavailable' }),
    ]);
  });

  it('deduplicates one lane by best rank before fusion', async () => {
    const core = new HybridSearchCore();
    const result = await core.search({
      queryText: 'paid status',
      limit: 10,
      generators: [
        generator('dictionary', [
          { id: 'orders', rank: 4, rawScore: 0.4, evidence: { column: 'state', values: ['paid'] } },
          { id: 'orders', rank: 1, rawScore: 0.9, evidence: { column: 'status', values: ['paid'] } },
        ]),
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      id: 'orders',
      ranksByLane: { dictionary: 1 },
      rawScoresByLane: { dictionary: 0.9 },
      evidenceByLane: { dictionary: [{ column: 'status', values: ['paid'] }] },
    });
  });

  it('uses deterministic id ordering when scores and lane counts tie', async () => {
    const core = new HybridSearchCore();
    const result = await core.search({
      queryText: 'revenue',
      limit: 10,
      generators: [generator('lexical', [{ id: 'zebra', rank: 1 }, { id: 'alpha', rank: 1 }])],
    });

    expect(result.results.map((candidate) => candidate.id)).toEqual(['alpha', 'zebra']);
  });
});
