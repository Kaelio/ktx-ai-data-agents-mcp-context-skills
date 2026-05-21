import type { FusedSearchCandidate, SearchLaneName } from './types.js';

export const DEFAULT_RRF_K = 60;

export const DEFAULT_SEARCH_LANE_WEIGHTS: Record<SearchLaneName, number> = {
  semantic: 2,
  dictionary: 2,
  lexical: 1.5,
  token: 0.75,
};

export function rrfContribution(weight: number, rank: number, rrfK = DEFAULT_RRF_K): number {
  return weight / (rrfK + rank);
}

export function compareFusedSearchCandidates(left: FusedSearchCandidate, right: FusedSearchCandidate): number {
  return right.score - left.score || right.matchReasons.length - left.matchReasons.length || left.id.localeCompare(right.id);
}
