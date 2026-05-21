export type SearchLaneName = 'lexical' | 'semantic' | 'dictionary' | 'token' | string;

export type SearchLaneStatus = 'available' | 'skipped' | 'failed';

export interface NormalizedSearchQuery {
  raw: string;
  normalized: string;
  terms: string[];
}

export interface SearchCandidate {
  id: string;
  rank: number;
  rawScore?: number;
  matchReason?: string;
  evidence?: unknown;
}

export interface SearchCandidateGeneratorArgs {
  queryText: string;
  normalizedQuery: NormalizedSearchQuery;
  finalLimit: number;
  laneCandidatePoolLimit: number;
}

export interface SearchLaneResult {
  status?: SearchLaneStatus;
  candidates: SearchCandidate[];
  effectiveCandidatePoolLimit?: number;
  reason?: string;
}

export interface SearchCandidateGenerator {
  lane: SearchLaneName;
  weight?: number;
  generate(args: SearchCandidateGeneratorArgs): Promise<SearchLaneResult>;
}

export interface HybridSearchOptions {
  queryText: string;
  limit: number;
  candidatePoolLimit?: number;
  rrfK?: number;
  laneWeights?: Partial<Record<SearchLaneName, number>>;
  generators: SearchCandidateGenerator[];
}

export interface SearchLaneBreakdown {
  lane: SearchLaneName;
  status: SearchLaneStatus;
  requestedCandidatePoolLimit: number;
  effectiveCandidatePoolLimit: number;
  returnedCandidateCount: number;
  weight: number;
  reason?: string;
}

export interface FusedSearchCandidate {
  id: string;
  score: number;
  matchReasons: SearchLaneName[];
  ranksByLane: Record<SearchLaneName, number>;
  rawScoresByLane: Record<SearchLaneName, number>;
  evidenceByLane: Record<SearchLaneName, unknown[]>;
}

export interface SearchResultHydrator<TResult> {
  hydrate(candidates: FusedSearchCandidate[]): Promise<TResult[]>;
}

export interface HybridSearchResult {
  query: NormalizedSearchQuery;
  requestedLimit: number;
  requestedCandidatePoolLimit: number;
  results: FusedSearchCandidate[];
  lanes: SearchLaneBreakdown[];
}

export interface SearchBackendCapabilities {
  fts: boolean;
  vector: boolean;
  fuzzy: boolean;
  jsonSearch: boolean;
  arraySearch: boolean;
}
