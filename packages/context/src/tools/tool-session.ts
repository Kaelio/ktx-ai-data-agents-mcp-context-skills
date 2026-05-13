import type { GitService, KtxFileStorePort } from '../core/index.js';
import type { SemanticLayerService } from '../sl/index.js';
import type { KnowledgeWikiService } from '../wiki/index.js';
import type { TouchedSlSourceSet } from './touched-sl-sources.js';

export interface IngestToolMetadata {
  runId: string;
  jobId: string;
  syncId: string;
  sourceKey: string;
}

export interface MemoryAction {
  target: 'wiki' | 'sl';
  type: 'created' | 'updated' | 'removed';
  key: string;
  detail: string;
  targetConnectionId?: string | null;
  rawPaths?: string[];
}

interface EvictionDecisionRecord {
  rawPath: string;
  artifactKind: 'wiki' | 'sl';
  artifactKey: string;
  action: 'removed' | 'retained_deprecated' | 'retained_supported';
  reason: string;
}

/**
 * Per-WU (or per-memory-agent) state threaded through ToolContext. When present,
 * SL/wiki tools read session-scoped services and emit touched-set entries / actions
 * instead of hitting shared services. When absent, tools behave as they do for
 * interactive research/workshop callers.
 */
export interface ToolSession {
  /**
   * Warehouse connection targeted by SL tools. `null` when the session has no
   * warehouse connection (wiki-only memory-agent turns) — SL tools must guard
   * for this and return a structured error rather than execute against a
   * blank connection.
   */
  connectionId: string | null;
  /** When true, worktree-scoped service writes bypass DB index updates. */
  isWorktreeScoped: boolean;
  preHead: string | null;
  touchedSlSources: TouchedSlSourceSet;
  actions: MemoryAction[];
  allowedRawPaths?: ReadonlySet<string>;
  allowedConnectionNames?: ReadonlySet<string>;
  semanticLayerService: SemanticLayerService;
  wikiService: KnowledgeWikiService;
  configService: KtxFileStorePort;
  gitService: GitService;
  ingest?: IngestToolMetadata;
  evictionDecisions?: EvictionDecisionRecord[];
}
