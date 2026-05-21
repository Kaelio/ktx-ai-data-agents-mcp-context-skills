export type {
  AssertSearchBackendCapabilitiesInput,
  AssertSearchBackendConformanceCaseInput,
  ExpectedSearchBackendConformanceLane,
  SearchBackendConformanceDictionaryMatch,
  SearchBackendConformanceLane,
  SearchBackendConformanceResult,
} from './backend-conformance.js';
export {
  assertSearchBackendCapabilities,
  assertSearchBackendConformanceCase,
} from './backend-conformance.js';
export { createKtxDiscoverDataService } from './discover.js';
export type {
  KtxDiscoverDataInput,
  KtxDiscoverDataKind,
  KtxDiscoverDataMatchedOn,
  KtxDiscoverDataRef,
  KtxDiscoverDataResponse,
  KtxDiscoverDataServiceOptions,
} from './discover.js';
export { HybridSearchCore } from './hybrid-search-core.js';
export { defaultLaneCandidatePoolLimit, normalizeSearchQuery } from './query.js';
export {
  compareFusedSearchCandidates,
  DEFAULT_RRF_K,
  DEFAULT_SEARCH_LANE_WEIGHTS,
  rrfContribution,
} from './rrf.js';
export type {
  FusedSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  NormalizedSearchQuery,
  SearchBackendCapabilities,
  SearchCandidate,
  SearchCandidateGenerator,
  SearchCandidateGeneratorArgs,
  SearchLaneBreakdown,
  SearchLaneName,
  SearchLaneResult,
  SearchLaneStatus,
  SearchResultHydrator,
} from './types.js';
