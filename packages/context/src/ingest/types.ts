import type { KtxEmbeddingPort } from '../core/embedding.js';
import type { MemoryFlowEventSink } from './memory-flow/types.js';

export type IngestTrigger = 'upload' | 'scheduled_pull' | 'manual_resync' | 'manual_override';

export interface DiffSet {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface WorkUnit {
  unitKey: string;
  displayLabel?: string;
  rawFiles: string[];
  peerFileIndex: string[];
  dependencyPaths: string[];
  notes?: string;
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
}

export interface EvictionUnit {
  deletedRawPaths: string[];
}

export interface UnresolvedCardInfo {
  cardId: number;
  name?: string;
  reason: 'cycle' | 'missing_native' | 'api_500' | 'unknown';
  errorMessage?: string;
}

export interface ChunkResult {
  workUnits: WorkUnit[];
  eviction?: EvictionUnit;
  unresolvedCards?: UnresolvedCardInfo[];
  reconcileNotes?: string[];
  contextReport?: {
    capped?: boolean;
    warnings?: string[];
  };
  parseArtifacts?: unknown;
}

export interface FetchContext {
  connectionId: string;
  sourceKey: string;
  memoryFlow?: MemoryFlowEventSink;
}

type SourceFetchIssueKind =
  | 'unmapped_looker_connection'
  | 'unparseable_sql_table_name'
  | 'looker_template_unresolved'
  | 'derived_table_not_supported'
  | 'lookml_connection_mismatch';

export interface SourceFetchIssue {
  rawPath: string;
  entityType: string;
  entityId: string | null;
  severity: 'warning' | 'error';
  statusCode: number | null;
  message: string;
  retryRecommended: boolean;
  kind?: SourceFetchIssueKind;
  details?: Record<string, unknown>;
}

export interface SourceFetchReport {
  status: 'success' | 'partial';
  retryRecommended: boolean;
  skipped: SourceFetchIssue[];
  warnings: SourceFetchIssue[];
}

export interface ScopeDescriptor {
  fingerprint: string;
  isPathInScope(rawPath: string): boolean;
}

export type TriageLane = 'skip' | 'light' | 'full';

export interface TriageSignals {
  parentType?: string;
  objectType?: string;
  isDateTitled?: boolean;
  lastEditedAt?: string;
  propertyHints?: Record<string, string>;
}

export interface ClusterWorkUnitsContext {
  workUnits: WorkUnit[];
  stagedDir: string;
  embedding: KtxEmbeddingPort;
}

export interface DeterministicProjectionContext {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  jobId: string;
  runId: string;
  stagedDir: string;
  workdir: string;
  parseArtifacts?: unknown;
}

export interface ProjectionResult {
  warnings: string[];
  errors: string[];
  touchedSources: Array<{ connectionId: string; sourceName: string }>;
  changedWikiPageKeys: string[];
  result?: unknown;
}

export interface SourceAdapter {
  readonly source: string;
  readonly skillNames: string[];
  readonly reconcileSkillNames?: string[];
  readonly evidenceIndexing?: 'documents';
  readonly triageSupported?: boolean;
  getTriageSignals?(stagedDir: string, externalId: string): Promise<TriageSignals>;
  detect(stagedDir: string): Promise<boolean>;
  fetch?(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void>;
  readFetchReport?(stagedDir: string): Promise<SourceFetchReport | null>;
  listTargetConnectionIds?(stagedDir: string): Promise<string[]>;
  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult>;
  clusterWorkUnits?(ctx: ClusterWorkUnitsContext): Promise<WorkUnit[]>;
  project?(ctx: DeterministicProjectionContext): Promise<ProjectionResult>;
  describeScope?(stagedDir: string): Promise<ScopeDescriptor>;
  onPullSucceeded?(ctx: {
    connectionId: string;
    sourceKey: string;
    syncId: string;
    trigger: IngestTrigger;
    completedAt: Date;
    stagedDir: string;
  }): Promise<void>;
}

export type IngestBundleRef =
  | { kind: 'upload'; uploadId: string }
  | { kind: 'scheduled_pull'; config: unknown }
  | { kind: 'override'; priorJobId: string };

export interface IngestBundleJob {
  jobId: string;
  connectionId: string;
  sourceKey: string;
  trigger: IngestTrigger;
  bundleRef: IngestBundleRef;
}

export interface IngestDiffSummary {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

export interface IngestBundleResult {
  jobId: string;
  runId: string;
  syncId: string;
  diffSummary: IngestDiffSummary;
  workUnitCount: number;
  failedWorkUnits: string[];
  artifactsWritten: number;
  commitSha: string | null;
}

export interface IngestJobPhase {
  updateProgress(progress: number, message?: string): Promise<void>;
  startPhase(weight: number): IngestJobPhase;
}

export interface IngestJobContext {
  jobId: string;
  memoryFlow?: MemoryFlowEventSink;
  startPhase(weight: number): IngestJobPhase;
}
