export type { GitAuthor, GitAuthorResolverPort } from './authors.js';
export { SYSTEM_GIT_AUTHOR } from './authors.js';
export type {
  MethodologyEntry,
  ToolContext,
  ToolOutput,
  ToolProgressRelayPort,
  ToolTimingTrackerPort,
} from './base-tool.js';
export { BaseTool } from './base-tool.js';
export { ContextCandidateMarkTool } from './context-candidate-mark.tool.js';
export { ContextCandidateWriteTool } from './context-candidate-write.tool.js';
export { ContextEvidenceNeighborsTool } from './context-evidence-neighbors.tool.js';
export { ContextEvidenceReadTool } from './context-evidence-read.tool.js';
export { ContextEvidenceSearchTool } from './context-evidence-search.tool.js';
export type {
  ContextCandidateInsertResult,
  ContextCandidateStatusResult,
  ContextEvidenceChunkForCandidate,
  ContextEvidenceChunkForRead,
  ContextEvidenceChunkReadResult,
  ContextEvidenceDocumentForRead,
  ContextEvidenceNeighborResult,
  ContextEvidenceReadResult,
  ContextEvidenceSearchArgs,
  ContextEvidenceSearchResult,
  ContextEvidenceToolStorePort,
} from './context-evidence-tool-store.js';
export type { ToolFailure } from './context-ingest-metadata.js';
export { ingestMetadataRequired, resolveIngestMetadata } from './context-ingest-metadata.js';
export type { SqlEdit } from './sql-edit-replacer.js';
export { applySqlEdits } from './sql-edit-replacer.js';
export type { IngestToolMetadata, MemoryAction, ToolSession } from './tool-session.js';
export { validateActionRawPaths } from './action-raw-paths.js';
export { validateActionTargetConnection } from './action-target-connection.js';
export type { TouchedSlSource, TouchedSlSourceSet } from './touched-sl-sources.js';
export {
  addTouchedSlSource,
  createTouchedSlSources,
  deleteTouchedSlSource,
  hasTouchedSlSource,
  listTouchedSlSources,
  touchedSlSourceCount,
  touchedSlSourceNamesForConnection,
} from './touched-sl-sources.js';
