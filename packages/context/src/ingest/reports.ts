import type { MemoryAction } from '../memory/index.js';
import type { TouchedSlSource } from '../tools/index.js';
import type { MemoryFlowReplayInput } from './memory-flow/types.js';
import type { IngestProvenanceInsert } from './ports.js';
import type {
  ArtifactResolutionRecord,
  ConflictResolvedRecord,
  EvictionAppliedRecord,
  StageIndex,
  UnmappedFallbackRecord,
} from './stages/stage-index.types.js';
import type { WikiSlRefRepair } from './wiki-sl-ref-repair.js';
import type { IngestDiffSummary, SourceFetchReport, UnresolvedCardInfo } from './types.js';

export interface IngestReportWorkUnit {
  unitKey: string;
  rawFiles: string[];
  status: 'success' | 'failed';
  reason?: string;
  actions: MemoryAction[];
  touchedSlSources: TouchedSlSource[];
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
}

export interface IngestReportProvenanceDetail {
  rawPath: string;
  artifactKind: 'sl' | 'wiki' | null;
  artifactKey: string | null;
  targetConnectionId?: string | null;
  actionType: IngestProvenanceInsert['actionType'];
}

export interface IngestReportToolTranscriptSummary {
  unitKey: string;
  path: string;
  toolCallCount: number;
  errorCount: number;
  toolNames: string[];
}

export interface IngestReportPostProcessorOutcome {
  sourceKey: string;
  status: 'success' | 'failed';
  result?: unknown;
  errors: string[];
  warnings: string[];
  touchedSources: TouchedSlSource[];
}

export interface IngestReportFailure {
  phase: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IngestReportBody {
  status?: 'completed' | 'failed';
  syncId: string;
  diffSummary: IngestDiffSummary;
  fetch?: SourceFetchReport;
  commitSha: string | null;
  tracePath?: string;
  failure?: IngestReportFailure;
  isolatedDiff?: {
    enabled: boolean;
    integrationWorktreePath?: string;
    ingestionBaseSha?: string;
    projectionSha?: string | null;
    acceptedPatches: number;
    textualConflicts: number;
    semanticConflicts: number;
    resolverAttempts?: number;
    resolverRepairs?: number;
    resolverFailures?: number;
    gateRepairAttempts?: number;
    gateRepairs?: number;
    gateRepairFailures?: number;
  };
  workUnits: IngestReportWorkUnit[];
  failedWorkUnits: string[];
  reconciliationSkipped: boolean;
  // Actions emitted by the reconciliation stage (wiki/sl writes from
  // cross-WU reconciliation). Counted alongside workUnit.actions in
  // savedMemoryCountsForReport so progress reports reflect all writes.
  reconciliationActions?: MemoryAction[];
  conflictsResolved: ConflictResolvedRecord[];
  evictionsApplied: EvictionAppliedRecord[];
  unmappedFallbacks: UnmappedFallbackRecord[];
  artifactResolutions?: ArtifactResolutionRecord[];
  evictionInputs: string[];
  unresolvedCards: UnresolvedCardInfo[];
  supersededBy: string | null;
  overrideOf: string | null;
  provenanceRows: IngestReportProvenanceDetail[];
  toolTranscripts: IngestReportToolTranscriptSummary[];
  postProcessor?: IngestReportPostProcessorOutcome;
  wikiSlRefRepairs?: WikiSlRefRepair[];
  wikiSlRefRepairWarnings?: string[];
  memoryFlow?: MemoryFlowReplayInput;
}

export interface IngestReportSnapshot {
  id: string;
  runId: string;
  jobId: string;
  connectionId: string;
  sourceKey: string;
  body: IngestReportBody;
  createdAt: string;
}

export interface IngestSavedMemoryCounts {
  wikiCount: number;
  slCount: number;
}

function numericResultField(result: Record<string, unknown>, field: string): number {
  const value = result[field];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function postProcessorSavedMemoryCounts(
  postProcessor: IngestReportPostProcessorOutcome | undefined,
): IngestSavedMemoryCounts {
  if (!postProcessor || postProcessor.sourceKey !== 'historic-sql') {
    return { wikiCount: 0, slCount: 0 };
  }
  const result = postProcessor.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { wikiCount: 0, slCount: 0 };
  }
  const record = result as Record<string, unknown>;
  return {
    wikiCount:
      numericResultField(record, 'patternPagesWritten') +
      numericResultField(record, 'stalePatternPagesMarked') +
      numericResultField(record, 'archivedPatternPages'),
    slCount: numericResultField(record, 'tableUsageMerged') + numericResultField(record, 'staleTablesMarked'),
  };
}

export function savedMemoryCountsForReport(report: IngestReportSnapshot): IngestSavedMemoryCounts {
  const workUnitActions = report.body.workUnits.flatMap((workUnit) => workUnit.actions);
  const reconciliationActions = report.body.reconciliationActions ?? [];
  const actions = [...workUnitActions, ...reconciliationActions];
  const directCounts = {
    wikiCount: actions.filter((action) => action.target === 'wiki').length,
    slCount: actions.filter((action) => action.target === 'sl').length,
  };
  const postProcessorCounts = postProcessorSavedMemoryCounts(report.body.postProcessor);
  return {
    wikiCount: directCounts.wikiCount + postProcessorCounts.wikiCount,
    slCount: directCounts.slCount + postProcessorCounts.slCount,
  };
}

export function buildStageIndexFromReportBody(jobId: string, connectionId: string, body: IngestReportBody): StageIndex {
  return {
    jobId,
    connectionId,
    workUnits: body.workUnits.map((wu) => ({
      unitKey: wu.unitKey,
      rawFiles: wu.rawFiles,
      status: wu.status,
      reason: wu.reason,
      actions: wu.actions,
      touchedSlSources: wu.touchedSlSources,
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
    })),
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
    artifactResolutions: body.artifactResolutions ?? [],
  };
}
