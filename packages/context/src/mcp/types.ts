import type { IngestReportSnapshot, MemoryFlowReplayInput, TableUsageOutput } from '../ingest/index.js';
import type { MemoryCaptureService } from '../memory/index.js';
import type { KtxEntityDetailsInput, KtxEntityDetailsResponse } from '../scan/entity-details.js';
import type { KtxScanMode, KtxScanReport } from '../scan/index.js';
import type {
  SemanticLayerQueryInput,
  SlDictionaryMatch,
  SlSearchLaneSummary,
  SlSearchMatchReason,
} from '../sl/index.js';
import type { WikiSearchLaneSummary, WikiSearchMatchReason } from '../wiki/index.js';

export interface KtxMcpTextContent {
  type: 'text';
  text: string;
}

export interface KtxMcpToolResult<T extends object = object> {
  content: KtxMcpTextContent[];
  structuredContent?: T;
  isError?: true;
}

export interface MemoryCapturePort {
  capture: MemoryCaptureService['capture'];
  status: MemoryCaptureService['status'];
}

export interface KtxMcpUserContext {
  userId: string;
}

export interface KtxMcpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: unknown;
    },
    handler: (input: Record<string, unknown>) => Promise<unknown>,
  ): void;
}

export interface KtxConnectionSummary {
  id: string;
  name: string;
  connectionType: string;
}

export interface KtxConnectionTestResponse {
  id: string;
  connectionType: string;
  ok: boolean;
  tableCount: number | null;
  message: string;
  warnings: string[];
}

export interface KtxConnectionsMcpPort {
  list(): Promise<KtxConnectionSummary[]>;
  test?(input: { connectionId: string }): Promise<KtxConnectionTestResponse | null>;
}

export interface KtxKnowledgeSearchResult {
  key: string;
  path: string;
  scope: 'GLOBAL' | 'USER';
  summary: string;
  score: number;
  matchReasons?: WikiSearchMatchReason[];
  lanes?: WikiSearchLaneSummary[];
}

export interface KtxKnowledgeSearchResponse {
  results: KtxKnowledgeSearchResult[];
  totalFound: number;
}

export interface KtxKnowledgePage {
  key: string;
  summary: string;
  content: string;
  scope: 'GLOBAL' | 'USER';
  tags?: string[];
  refs?: string[];
  slRefs?: string[];
}

interface KtxHistoricSqlKnowledgeUsage {
  executions: number;
  distinct_users: number;
  first_seen: string;
  last_seen: string;
  p50_runtime_ms: number | null;
  p95_runtime_ms: number | null;
  error_rate: number;
  rows_produced?: number;
}

export interface KtxKnowledgeWriteResponse {
  success: boolean;
  key: string;
  action: 'created' | 'updated';
}

export interface KtxKnowledgeMcpPort {
  search(input: { userId: string; query: string; limit: number }): Promise<KtxKnowledgeSearchResponse>;
  read(input: { userId: string; key: string }): Promise<KtxKnowledgePage | null>;
  write(input: {
    userId: string;
    key: string;
    summary: string;
    content: string;
    tags?: string[];
    refs?: string[];
    slRefs?: string[];
    source?: string;
    intent?: string;
    tables?: string[];
    representativeSql?: string;
    usage?: KtxHistoricSqlKnowledgeUsage;
    fingerprints?: string[];
  }): Promise<KtxKnowledgeWriteResponse>;
}

export interface KtxSemanticLayerSourceSummary {
  connectionId: string;
  connectionName: string;
  name: string;
  description?: string;
  columnCount: number;
  measureCount: number;
  joinCount: number;
  frequencyTier?: TableUsageOutput['frequencyTier'];
  snippet?: string;
  score?: number;
  matchReasons?: SlSearchMatchReason[];
  dictionaryMatches?: SlDictionaryMatch[];
  lanes?: SlSearchLaneSummary[];
}

export interface KtxSemanticLayerListResponse {
  sources: KtxSemanticLayerSourceSummary[];
  totalSources: number;
}

export interface KtxSemanticLayerReadResponse {
  sourceName: string;
  yaml: string;
}

export interface KtxSemanticLayerWriteResponse {
  success: boolean;
  sourceName: string;
  yaml?: string;
  errors?: string[];
  warnings?: string[];
  commitHash?: string;
}

export interface KtxSemanticLayerValidationResponse {
  success: boolean;
  errors: string[];
  warnings: string[];
}

export interface KtxSemanticLayerQueryResponse {
  sql: string;
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  plan?: Record<string, unknown>;
}

export interface KtxSemanticLayerMcpPort {
  listSources(input: { connectionId?: string; query?: string }): Promise<KtxSemanticLayerListResponse>;
  readSource(input: { connectionId: string; sourceName: string }): Promise<KtxSemanticLayerReadResponse | null>;
  writeSource(input: {
    connectionId: string;
    sourceName: string;
    yaml?: string;
    source?: Record<string, unknown>;
    delete?: boolean;
  }): Promise<KtxSemanticLayerWriteResponse>;
  validate(input: { connectionId: string; names?: string[] }): Promise<KtxSemanticLayerValidationResponse>;
  query(input: { connectionId?: string; query: SemanticLayerQueryInput }): Promise<KtxSemanticLayerQueryResponse>;
}

export type KtxIngestTriggerKind = 'upload' | 'scheduled_pull' | 'manual_resync';

interface KtxIngestTriggerFanoutChild {
  runId: string;
  jobId: string;
  reportId: string;
  targetConnectionId: string;
  metabaseDatabaseId: number;
}

export interface KtxIngestTriggerResponse {
  runId: string;
  jobId?: string;
  reportId?: string;
  fanout?: {
    status: 'all_succeeded' | 'partial_failure' | 'all_failed';
    children: KtxIngestTriggerFanoutChild[];
  };
}

export interface KtxIngestDiffSummary {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

export interface KtxIngestWorkUnitSummary {
  unitKey: string;
  rawFiles: string[];
  peerFileIndex: string[];
  dependencyPaths: string[];
}

export interface KtxIngestStatusResponse {
  runId: string;
  jobId?: string;
  reportId?: string;
  status: string;
  stage?: string;
  progress?: number;
  errors?: string[];
  done: boolean;
  adapter?: string;
  connectionId?: string;
  sourceDir?: string | null;
  syncId?: string;
  startedAt?: string;
  completedAt?: string;
  previousRunId?: string | null;
  diffSummary?: KtxIngestDiffSummary;
  workUnitCount?: number;
  rawFileCount?: number;
  workUnits?: KtxIngestWorkUnitSummary[];
  evictionDeletedRawPaths?: string[];
}

export interface KtxIngestMcpPort {
  trigger(input: {
    adapter: string;
    connectionId: string;
    config?: unknown;
    trigger: KtxIngestTriggerKind;
  }): Promise<KtxIngestTriggerResponse>;
  status(input: { runId: string }): Promise<KtxIngestStatusResponse | null>;
  report?(input: { runId: string }): Promise<IngestReportSnapshot | null>;
  replay?(input: { runId: string }): Promise<MemoryFlowReplayInput | null>;
}

interface KtxScanTriggerResponse {
  runId: string;
  status: 'done';
  done: true;
  connectionId: string;
  mode: KtxScanMode;
  dryRun: boolean;
  syncId: string;
  report: KtxScanReport;
}

interface KtxScanStatusResponse {
  runId: string;
  status: string;
  done: boolean;
  connectionId: string;
  mode: KtxScanMode;
  dryRun: boolean;
  syncId: string;
  progress: number;
  startedAt: string;
  completedAt: string;
  reportPath: string | null;
  warnings: KtxScanReport['warnings'];
}

export type KtxScanArtifactType = 'report' | 'raw_source' | 'manifest_shard' | 'enrichment_artifact';

export interface KtxScanArtifactSummary {
  path: string;
  type: KtxScanArtifactType;
  size?: number;
}

export interface KtxScanArtifactListResponse {
  runId: string;
  artifacts: KtxScanArtifactSummary[];
}

export interface KtxScanArtifactReadResponse extends KtxScanArtifactSummary {
  runId: string;
  content: string;
}

export interface KtxScanMcpPort {
  trigger(input: {
    connectionId: string;
    mode?: KtxScanMode;
    detectRelationships: boolean;
    dryRun: boolean;
  }): Promise<KtxScanTriggerResponse>;
  status(input: { runId: string }): Promise<KtxScanStatusResponse | null>;
  report(input: { runId: string }): Promise<KtxScanReport | null>;
  listArtifacts?(input: { runId: string }): Promise<KtxScanArtifactListResponse | null>;
  readArtifact?(input: { runId: string; path: string }): Promise<KtxScanArtifactReadResponse | null>;
}

export interface KtxEntityDetailsMcpPort {
  read(input: KtxEntityDetailsInput): Promise<KtxEntityDetailsResponse>;
}

export interface KtxSqlExecutionResponse {
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface KtxSqlExecutionMcpPort {
  execute(input: { connectionId: string; sql: string; maxRows: number }): Promise<KtxSqlExecutionResponse>;
}

export interface KtxMcpContextPorts {
  connections?: KtxConnectionsMcpPort;
  knowledge?: KtxKnowledgeMcpPort;
  semanticLayer?: KtxSemanticLayerMcpPort;
  entityDetails?: KtxEntityDetailsMcpPort;
  sqlExecution?: KtxSqlExecutionMcpPort;
  ingest?: KtxIngestMcpPort;
  scan?: KtxScanMcpPort;
}

export interface KtxMcpServerDeps {
  server: KtxMcpServerLike;
  memoryCapture?: MemoryCapturePort;
  userContext: KtxMcpUserContext;
  contextTools?: KtxMcpContextPorts;
}
