export { buildKnowledgeSearchText } from './knowledge-search-text.js';
export {
  assertFlatWikiKey,
  invalidFlatWikiKeyMessage,
  isFlatWikiKey,
  suggestFlatWikiKey,
  validateFlatWikiKey,
} from './keys.js';
export { KnowledgeWikiService } from './knowledge-wiki.service.js';
export * from './local-knowledge.js';
export type {
  KnowledgeEventPort,
  KnowledgeGitDiffPort,
  KnowledgeIndexPort,
  UpsertPageParams,
  WikiFileStorePort,
} from './ports.js';
export type {
  ExistingKnowledgeIndexPage,
  SqliteKnowledgeIndexOptions,
  SqliteKnowledgeIndexPage,
  SqliteKnowledgeIndexSearchResult,
  WikiSqliteLaneCandidate,
} from './sqlite-knowledge-index.js';
export { SqliteKnowledgeIndex } from './sqlite-knowledge-index.js';
export * from './tools/index.js';
export type {
  HistoricSqlWikiUsageFrontmatter,
  WikiFrontmatter,
  WikiPage,
  WikiPageWithScope,
  WikiScope,
  WikiSearchLaneSummary,
  WikiSearchMatchReason,
  WikiSearchMetadata,
} from './types.js';
