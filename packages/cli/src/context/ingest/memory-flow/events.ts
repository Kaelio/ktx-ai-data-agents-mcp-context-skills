import type { MemoryAction } from '../../../context/memory/types.js';
import type { LocalIngestRunRecord } from '../local-stage-ingest.js';
import type { IngestReportSnapshot } from '../reports.js';
import type {
  MemoryFlowActionDetail,
  MemoryFlowDetailSections,
  MemoryFlowEvent,
  MemoryFlowPlannedWorkUnit,
  MemoryFlowReplayInput,
} from './types.js';

interface ReportReplayOptions {
  provenanceRowCount?: number;
}

function plannedWorkUnitFromLocal(
  workUnit: LocalIngestRunRecord['workUnits'][number],
): MemoryFlowPlannedWorkUnit {
  return {
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: workUnit.peerFileIndex.length,
    dependencyCount: workUnit.dependencyPaths.length,
  };
}

function plannedWorkUnitFromReport(
  workUnit: IngestReportSnapshot['body']['workUnits'][number],
): MemoryFlowPlannedWorkUnit {
  return {
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: 0,
    dependencyCount: 0,
  };
}

function countActions(actions: MemoryAction[], target: MemoryAction['target']): number {
  return actions.filter((action) => action.target === target).length;
}

function allReportActions(report: IngestReportSnapshot): MemoryAction[] {
  return report.body.workUnits.flatMap((workUnit) => workUnit.actions);
}

function rawFileCount(report: IngestReportSnapshot): number {
  return new Set(report.body.workUnits.flatMap((workUnit) => workUnit.rawFiles)).size;
}

function emptyMemoryFlowDetails(): MemoryFlowDetailSections {
  return { actions: [], provenance: [], transcripts: [] };
}

function fullModeMetadata(input: {
  origin: 'captured' | 'synthetic-report';
  timing: 'captured' | 'synthetic';
  capturedAt: string | null;
  sourceReportId: string | null;
  sourceReportPath: string | null;
  fallbackReason: string | null;
}): MemoryFlowReplayInput['metadata'] {
  return {
    schemaVersion: 1,
    mode: 'full',
    origin: input.origin,
    timing: input.timing,
    capturedAt: input.capturedAt,
    sourceReportId: input.sourceReportId,
    sourceReportPath: input.sourceReportPath,
    fallbackReason: input.fallbackReason,
  };
}

function reportStatus(report: IngestReportSnapshot): MemoryFlowReplayInput['status'] {
  return report.body.failedWorkUnits.length > 0 ? 'error' : 'done';
}

function reportCreatedEvent(report: IngestReportSnapshot): MemoryFlowEvent {
  return { type: 'report_created', runId: report.runId, reportPath: report.id };
}

function capturedReportReplay(report: IngestReportSnapshot): MemoryFlowReplayInput | null {
  if (!report.body.memoryFlow) {
    return null;
  }

  const hasReportCreated = report.body.memoryFlow.events.some((event) => event.type === 'report_created');
  return {
    ...report.body.memoryFlow,
    metadata: fullModeMetadata({
      origin: 'captured',
      timing: 'captured',
      capturedAt: report.body.memoryFlow.metadata?.capturedAt ?? report.createdAt,
      sourceReportId: report.id,
      sourceReportPath: report.id,
      fallbackReason: null,
    }),
    runId: report.runId,
    connectionId: report.connectionId,
    adapter: report.sourceKey,
    status: reportStatus(report),
    syncId: report.body.syncId,
    reportId: report.id,
    reportPath: report.id,
    errors: report.body.failedWorkUnits,
    events: hasReportCreated ? report.body.memoryFlow.events : [...report.body.memoryFlow.events, reportCreatedEvent(report)],
  };
}

function actionDetailsFromReport(report: IngestReportSnapshot): MemoryFlowActionDetail[] {
  return report.body.workUnits.flatMap((workUnit) =>
    workUnit.actions.map((action) => ({
      unitKey: workUnit.unitKey,
      target: action.target,
      action: action.type,
      key: action.key,
      summary: action.detail,
      rawFiles: [...workUnit.rawFiles],
      status: workUnit.status,
    })),
  );
}

function detailSectionsFromReport(report: IngestReportSnapshot): MemoryFlowDetailSections {
  return {
    actions: actionDetailsFromReport(report),
    provenance: report.body.provenanceRows.map((row) => ({ ...row })),
    transcripts: report.body.toolTranscripts.map((summary) => ({
      ...summary,
      toolNames: [...summary.toolNames],
    })),
  };
}

/** @internal */
export function localIngestRunToMemoryFlowReplay(record: LocalIngestRunRecord): MemoryFlowReplayInput {
  const events: MemoryFlowEvent[] = [
    { type: 'source_acquired', adapter: record.adapter, trigger: 'manual_resync', fileCount: record.rawFileCount },
    { type: 'scope_detected', fingerprint: null },
    { type: 'raw_snapshot_written', syncId: record.syncId, rawFileCount: record.rawFileCount },
    { type: 'diff_computed', ...record.diffSummary },
    {
      type: 'chunks_planned',
      chunkCount: record.workUnitCount,
      workUnitCount: record.workUnitCount,
      evictionCount: record.evictionDeletedRawPaths.length,
    },
    { type: 'report_created', runId: record.runId },
  ];

  return {
    runId: record.runId,
    connectionId: record.connectionId,
    adapter: record.adapter,
    status: record.status,
    sourceDir: record.sourceDir,
    syncId: record.syncId,
    errors: record.errors,
    events,
    plannedWorkUnits: record.workUnits.map(plannedWorkUnitFromLocal),
    details: emptyMemoryFlowDetails(),
  };
}

export function ingestReportToMemoryFlowReplay(
  report: IngestReportSnapshot,
  options: ReportReplayOptions = {},
): MemoryFlowReplayInput {
  const captured = capturedReportReplay(report);
  if (captured) {
    return captured;
  }

  const actions = allReportActions(report);
  const workUnitEvents: MemoryFlowEvent[] = report.body.workUnits.flatMap((workUnit) => [
    { type: 'work_unit_started', unitKey: workUnit.unitKey, skills: [], stepBudget: 0 } satisfies MemoryFlowEvent,
    ...workUnit.actions.map(
      (action): MemoryFlowEvent => ({
        type: 'candidate_action',
        unitKey: workUnit.unitKey,
        target: action.target,
        action: action.type,
        key: action.key,
      }),
    ),
    {
      type: 'work_unit_finished',
      unitKey: workUnit.unitKey,
      status: workUnit.status,
      ...(workUnit.reason ? { reason: workUnit.reason } : {}),
    } satisfies MemoryFlowEvent,
  ]);

  const events: MemoryFlowEvent[] = [
    {
      type: 'source_acquired',
      adapter: report.sourceKey,
      trigger: 'manual_resync',
      fileCount: rawFileCount(report),
    },
    { type: 'scope_detected', fingerprint: null },
    { type: 'raw_snapshot_written', syncId: report.body.syncId, rawFileCount: rawFileCount(report) },
    { type: 'diff_computed', ...report.body.diffSummary },
    {
      type: 'chunks_planned',
      chunkCount: report.body.workUnits.length,
      workUnitCount: report.body.workUnits.length,
      evictionCount: report.body.evictionInputs.length,
    },
    ...workUnitEvents,
    {
      type: 'reconciliation_finished',
      conflictCount: report.body.conflictsResolved.length,
      fallbackCount: report.body.unmappedFallbacks.length,
    },
    {
      type: 'saved',
      commitSha: report.body.commitSha,
      wikiCount: countActions(actions, 'wiki'),
      slCount: countActions(actions, 'sl'),
    },
    { type: 'provenance_recorded', rowCount: options.provenanceRowCount ?? actions.length },
    { type: 'report_created', runId: report.runId, reportPath: report.id },
  ];

  return {
    metadata: fullModeMetadata({
      origin: 'synthetic-report',
      timing: 'synthetic',
      capturedAt: report.createdAt,
      sourceReportId: report.id,
      sourceReportPath: report.id,
      fallbackReason: 'report did not include captured memory-flow events',
    }),
    runId: report.runId,
    connectionId: report.connectionId,
    adapter: report.sourceKey,
    status: reportStatus(report),
    sourceDir: null,
    syncId: report.body.syncId,
    reportId: report.id,
    reportPath: report.id,
    errors: report.body.failedWorkUnits,
    events,
    plannedWorkUnits: report.body.workUnits.map(plannedWorkUnitFromReport),
    details: detailSectionsFromReport(report),
  };
}
