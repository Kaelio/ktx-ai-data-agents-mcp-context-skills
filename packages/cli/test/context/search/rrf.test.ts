import { describe, expect, it } from 'vitest';
import { compareFusedSearchCandidates, DEFAULT_SEARCH_LANE_WEIGHTS, rrfContribution } from '../../../src/context/search/rrf.js';
import type { FusedSearchCandidate } from '../../../src/context/search/types.js';

describe('RRF scoring', () => {
  it('uses the shared lane weights from the hybrid search spec', () => {
    expect(DEFAULT_SEARCH_LANE_WEIGHTS).toEqual({
      semantic: 2,
      dictionary: 2,
      lexical: 1.5,
      token: 0.75,
    });
  });

  it('calculates a weighted RRF contribution with k=60 by default', () => {
    expect(rrfContribution(2, 1)).toBeCloseTo(2 / 61, 12);
    expect(rrfContribution(1.5, 2)).toBeCloseTo(1.5 / 62, 12);
  });

  it('sorts fused candidates by score, lane count, and stable id', () => {
    const first: FusedSearchCandidate = {
      id: 'orders',
      score: 0.05,
      matchReasons: ['lexical'],
      ranksByLane: { lexical: 1 },
      rawScoresByLane: {},
      evidenceByLane: {},
    };
    const second: FusedSearchCandidate = {
      id: 'customers',
      score: 0.05,
      matchReasons: ['lexical', 'semantic'],
      ranksByLane: { lexical: 2, semantic: 1 },
      rawScoresByLane: {},
      evidenceByLane: {},
    };
    const third: FusedSearchCandidate = {
      id: 'accounts',
      score: 0.04,
      matchReasons: ['semantic'],
      ranksByLane: { semantic: 1 },
      rawScoresByLane: {},
      evidenceByLane: {},
    };

    expect([first, second, third].sort(compareFusedSearchCandidates).map((candidate) => candidate.id)).toEqual([
      'customers',
      'orders',
      'accounts',
    ]);
  });
});
