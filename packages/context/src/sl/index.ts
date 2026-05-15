export type { SlValidationResult, SlValidatorPort } from './sl-validator.port.js';
export type {
  SemanticLayerQueryExecutionResult,
  SemanticLayerQueryInput,
  SemanticLayerSource,
  SlDictionaryMatch,
  SlSearchLaneSummary,
  SlSearchMatchReason,
  SlSearchMetadata,
} from './types.js';
export type {
  KtxConnectionInfo,
  KtxQueryResult,
  SlConnectionCatalogPort,
  SlPythonPort,
  SlSourcesIndexPort,
} from './ports.js';
export { DEFAULT_PRIORITY, resolveDescription } from './descriptions.js';
export { isOverlaySource, sourceDefinitionSchema, sourceOverlaySchema } from './schemas.js';
export {
  composeOverlay,
  enrichColumnsFromManifest,
  findDanglingSegmentRefs,
  SemanticLayerService,
} from './semantic-layer.service.js';
export { loadLatestSlDictionaryEntries } from './sl-dictionary-profile.js';
export type { SlDictionaryEntry } from './sl-dictionary-profile.js';
export { createKtxDictionarySearchService } from './dictionary-search.js';
export type {
  KtxDictionarySearchCoverage,
  KtxDictionarySearchInput,
  KtxDictionarySearchMatch,
  KtxDictionarySearchMiss,
  KtxDictionarySearchMissReason,
  KtxDictionarySearchResponse,
  KtxDictionarySearchSearchedConnection,
  KtxDictionarySearchStatus,
  KtxDictionarySearchValueResult,
} from './dictionary-search.js';
export { buildSemanticLayerSourceSearchText, SlSearchService } from './sl-search.service.js';
export { SqliteSlSourcesIndex, type SqliteSlSourcesIndexOptions } from './sqlite-sl-sources-index.js';
export * from './local-sl.js';
export * from './local-query.js';
export * from './tools/index.js';
