import type {
  MemoryFlowChip,
  MemoryFlowColumnId,
  MemoryFlowColumnView,
  MemoryFlowDisplayStatus,
  MemoryFlowEvent,
  MemoryFlowReplayInput,
  MemoryFlowTrustIssue,
  MemoryFlowViewModel,
} from './types.js';
import { sanitizeMemoryFlowError } from './live-buffer.js';
import { formatNotionAuthorizationExpiredDetail, isNotionAuthorizationExpired } from './known-errors.js';

function latest<T extends MemoryFlowEvent['type']>(
  events: MemoryFlowEvent[],
  type: T,
): Extract<MemoryFlowEvent, { type: T }> | undefined {
  return events.filter((event): event is Extract<MemoryFlowEvent, { type: T }> => event.type === type).at(-1);
}

function eventsOf<T extends MemoryFlowEvent['type']>(
  events: MemoryFlowEvent[],
  type: T,
): Array<Extract<MemoryFlowEvent, { type: T }>> {
  return events.filter((event): event is Extract<MemoryFlowEvent, { type: T }> => event.type === type);
}

function skippedStage(
  input: MemoryFlowReplayInput,
  stage: Extract<MemoryFlowEvent, { type: 'stage_skipped' }>['stage'],
): Extract<MemoryFlowEvent, { type: 'stage_skipped' }> | undefined {
  return eventsOf(input.events, 'stage_skipped').find((event) => event.stage === stage);
}

function formatDiff(diff: Extract<MemoryFlowEvent, { type: 'diff_computed' }> | undefined): string {
  if (!diff) return '+0 ~0 -0 =0';
  return `+${diff.added} ~${diff.modified} -${diff.deleted} =${diff.unchanged}`;
}

function countCandidateActions(events: MemoryFlowEvent[], target: 'wiki' | 'sl'): number {
  return eventsOf(events, 'candidate_action').filter((event) => event.target === target).length;
}

function columnStatus(input: {
  hasFailures?: boolean;
  hasWarnings?: boolean;
  hasActivity?: boolean;
  complete?: boolean;
}): MemoryFlowDisplayStatus {
  if (input.hasFailures) return 'failed';
  if (input.hasWarnings) return 'warning';
  if (input.hasActivity) return 'active';
  if (input.complete) return 'complete';
  return 'waiting';
}

function firstChips(labels: string[], status: MemoryFlowDisplayStatus): Array<{ label: string; status: MemoryFlowDisplayStatus }> {
  return labels.slice(0, 2).map((label) => ({ label, status }));
}

function safeErrors(input: MemoryFlowReplayInput): string[] {
  return input.errors.map((error) => sanitizeMemoryFlowError(error)).filter((error) => error.length > 0);
}

function latestSafeError(input: MemoryFlowReplayInput): string | null {
  return safeErrors(input)[0] ?? null;
}

function failureStage(input: MemoryFlowReplayInput): 'source' | 'planning' | 'work_unit' | 'save' | 'run' {
  const hasSource = !!latest(input.events, 'source_acquired');
  const hasChunks = !!latest(input.events, 'chunks_planned');
  const hasFailedWorkUnit = eventsOf(input.events, 'work_unit_finished').some((event) => event.status === 'failed');
  const hasSaved = !!latest(input.events, 'saved');

  if (!hasSource) return 'source';
  if (!hasChunks) return 'planning';
  if (hasFailedWorkUnit) return 'work_unit';
  if (hasSaved) return 'save';
  return 'run';
}

function activeLine(input: MemoryFlowReplayInput): string {
  if (input.status !== 'error') {
    return input.status === 'running' ? 'active: running' : 'active: complete';
  }

  const error = latestSafeError(input);
  if (!error) return 'active: error';

  const stage = failureStage(input);
  return `active: ${stage.replace('_', ' ')} failed - ${error}`;
}

function errorDetails(input: MemoryFlowReplayInput): string[] {
  const errors = safeErrors(input);
  if (errors.length === 0) return [];

  const [first, ...rest] = errors;
  const stage = failureStage(input);
  const label =
    stage === 'source'
      ? 'Source acquisition failed'
      : stage === 'planning'
        ? 'Error'
        : stage === 'save'
          ? 'Post-save error'
          : 'Error';

  return [`${label}: ${first}`, ...rest.map((error) => `Error: ${error}`)];
}

function isValidationFailure(reason: string | undefined): boolean {
  return /semantic-layer|validation/i.test(reason ?? '');
}

function failedWorkUnitDetails(failed: Array<Extract<MemoryFlowEvent, { type: 'work_unit_finished' }>>): string[] {
  const details = failed.map((event) => {
    const reason = event.reason ?? 'failed';
    const label = isValidationFailure(reason) ? 'reverted' : 'failed';
    return `${event.unitKey} ${label}: ${sanitizeMemoryFlowError(reason)}`;
  });

  if (failed.some((event) => isValidationFailure(event.reason))) {
    details.push('Invalid semantic-layer writes were not saved.');
  }

  return details;
}

function columnTitle(columnId: MemoryFlowColumnId): string {
  if (columnId === 'workUnits') return 'WORKUNITS';
  return columnId.toUpperCase();
}

function plural(value: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralLabel}`;
}

function finishedWorkUnitByKey(
  input: MemoryFlowReplayInput,
): Map<string, Extract<MemoryFlowEvent, { type: 'work_unit_finished' }>> {
  return new Map(eventsOf(input.events, 'work_unit_finished').map((event) => [event.unitKey, event]));
}

function workUnitChips(input: MemoryFlowReplayInput): MemoryFlowChip[] {
  const finishedByKey = finishedWorkUnitByKey(input);
  return input.plannedWorkUnits.slice(0, 8).map((workUnit) => {
    const finished = finishedByKey.get(workUnit.unitKey);
    if (finished?.status === 'failed') {
      return {
        label: workUnit.unitKey,
        status: 'failed',
        detail: sanitizeMemoryFlowError(finished.reason ?? 'failed'),
      };
    }
    return { label: workUnit.unitKey, status: finished ? 'complete' : 'active' };
  });
}

function actionChips(
  input: MemoryFlowReplayInput,
  events: Array<Extract<MemoryFlowEvent, { type: 'candidate_action' }>>,
): MemoryFlowChip[] {
  if (input.details.actions.length > 0) {
    return input.details.actions.slice(0, 8).map((action) => ({
      label: action.key,
      status: action.status === 'failed' ? 'failed' : 'complete',
      detail: action.status === 'failed' ? action.summary : undefined,
    }));
  }

  return events.slice(0, 8).map((action) => ({ label: action.key, status: 'complete' }));
}

function buildMemoryFlowTrustIssues(input: MemoryFlowReplayInput): MemoryFlowTrustIssue[] {
  const issues: MemoryFlowTrustIssue[] = [];
  const failed = eventsOf(input.events, 'work_unit_finished').filter((event) => event.status === 'failed');
  const reconciliation = latest(input.events, 'reconciliation_finished');
  const saved = latest(input.events, 'saved');
  const provenance = latest(input.events, 'provenance_recorded');

  for (const event of failed) {
    const reason = sanitizeMemoryFlowError(event.reason ?? 'failed');
    const knownNotionAuthFailure = isNotionAuthorizationExpired(input, event.reason);
    issues.push({
      id: `work-unit-failed:${event.unitKey}`,
      severity: 'failed',
      title: knownNotionAuthFailure ? 'Notion authorization expired' : 'WorkUnit failed',
      detail: knownNotionAuthFailure
        ? formatNotionAuthorizationExpiredDetail(event.unitKey)
        : `${event.unitKey} failed: ${reason}`,
      columnId: 'workUnits',
      targetLabel: event.unitKey,
    });

    if (isValidationFailure(event.reason)) {
      issues.push({
        id: `sl-validation-reverted:${event.unitKey}`,
        severity: 'warning',
        title: 'SL validation revert',
        detail: `${event.unitKey} reverted after semantic-layer validation failure`,
        columnId: 'gates',
        targetLabel: event.unitKey,
      });
    }
  }

  if ((reconciliation?.conflictCount ?? 0) > 0) {
    issues.push({
      id: 'reconciliation-conflicts',
      severity: 'warning',
      title: 'Reconciliation conflicts',
      detail: `${plural(reconciliation?.conflictCount ?? 0, 'conflict')} resolved during reconciliation`,
      columnId: 'gates',
    });
  }

  if ((reconciliation?.fallbackCount ?? 0) > 0) {
    issues.push({
      id: 'flagged-fallbacks',
      severity: 'warning',
      title: 'Flagged fallbacks',
      detail: `${plural(reconciliation?.fallbackCount ?? 0, 'fallback')} needs review`,
      columnId: 'gates',
    });
  }

  const savedCount = (saved?.wikiCount ?? 0) + (saved?.slCount ?? 0);
  if (savedCount > 0 && provenance && provenance.rowCount < savedCount) {
    issues.push({
      id: 'provenance-mismatch',
      severity: 'warning',
      title: 'Provenance mismatch',
      detail: `${savedCount} saved memories but ${provenance.rowCount} provenance rows recorded`,
      columnId: 'saved',
    });
  }

  for (const skipped of eventsOf(input.events, 'stage_skipped')) {
    issues.push({
      id: `degraded-mode:${skipped.stage}`,
      severity: 'warning',
      title: 'Degraded mode',
      detail: `${columnTitle(skipped.stage)} skipped: ${skipped.reason}`,
      columnId: skipped.stage,
      targetLabel: 'skipped',
    });
  }

  for (const [index, error] of safeErrors(input).entries()) {
    issues.push({
      id: `run-error:${index}`,
      severity: 'failed',
      title: 'Run error',
      detail: error,
      columnId: failureStage(input) === 'source' ? 'source' : 'gates',
    });
  }

  return issues;
}

function humanizeAdapter(adapter: string): string {
  const labels: Record<string, string> = {
    'live-database': 'Warehouse',
    'live_database': 'Warehouse',
    'dbt_descriptions': 'dbt',
    'looker': 'BI',
    'lookml': 'BI',
    'notion': 'Docs',
    'metabase': 'BI',
    'metricflow': 'dbt',
    'historic_sql': 'SQL',
  };
  return labels[adapter] ?? adapter;
}

function sourceColumn(input: MemoryFlowReplayInput): MemoryFlowColumnView {
  const sources = eventsOf(input.events, 'source_acquired');
  const source = sources.at(-1);
  const snapshot = latest(input.events, 'raw_snapshot_written');
  const scope = latest(input.events, 'scope_detected');
  const totalFiles = sources.reduce((sum, s) => sum + s.fileCount, 0);
  const adapterLabels = sources.length > 1
    ? [...new Set(sources.map((s) => humanizeAdapter(s.adapter)))]
    : [input.adapter, input.connectionId];
  return {
    id: 'source',
    title: 'SOURCE',
    status: columnStatus({ complete: !!source }),
    headline: `${totalFiles} raw files`,
    counters: sources.length > 1
      ? [adapterLabels.join(', '), `sync ${snapshot?.syncId ?? input.syncId}`]
      : [`sync ${snapshot?.syncId ?? input.syncId}`, scope?.fingerprint ? `scope ${scope.fingerprint}` : 'scope none'],
    chips: adapterLabels.map((label) => ({ label, status: 'complete' as MemoryFlowDisplayStatus })),
    details: [
      `Trigger: ${source?.trigger ?? 'unknown'}`,
      ...(sources.length > 1
        ? sources.map((s) => `${humanizeAdapter(s.adapter)}: ${s.fileCount} files`)
        : [`Adapter: ${input.adapter}`]),
      `Connection: ${input.connectionId}`,
      `Source: ${input.sourceDir ?? 'stored report'}`,
      ...errorDetails(input),
    ],
  };
}

function chunksColumn(input: MemoryFlowReplayInput): MemoryFlowColumnView {
  const chunks = latest(input.events, 'chunks_planned');
  const diff = latest(input.events, 'diff_computed');
  return {
    id: 'chunks',
    title: 'CHUNKS',
    status: columnStatus({ hasWarnings: (chunks?.evictionCount ?? 0) > 0, complete: !!chunks }),
    headline: `${chunks?.chunkCount ?? 0} chunks`,
    counters: [formatDiff(diff), `${chunks?.evictionCount ?? 0} deletions`],
    chips: firstChips(input.plannedWorkUnits.map((workUnit) => workUnit.unitKey), 'complete'),
    details: [
      `Work units planned: ${chunks?.workUnitCount ?? 0}`,
      `Eviction candidates: ${chunks?.evictionCount ?? 0}`,
      `Diff: ${formatDiff(diff)}`,
    ],
  };
}

function workUnitsColumn(input: MemoryFlowReplayInput): MemoryFlowColumnView {
  const finished = eventsOf(input.events, 'work_unit_finished');
  const failed = finished.filter((event) => event.status === 'failed');
  const succeeded = finished.filter((event) => event.status === 'success');
  const active = eventsOf(input.events, 'work_unit_started').filter(
    (started) => !finished.some((event) => event.unitKey === started.unitKey),
  );
  const total = input.plannedWorkUnits.length || latest(input.events, 'chunks_planned')?.workUnitCount || 0;
  const skipped = skippedStage(input, 'workUnits');
  if (skipped) {
    return {
      id: 'workUnits',
      title: 'WORKUNITS',
      status: 'warning',
      headline: 'skipped',
      counters: ['0 done', '0 failed', '0 active'],
      chips: [{ label: 'skipped', status: 'warning', detail: skipped.reason }],
      details: [`Skipped: ${skipped.reason}`],
    };
  }

  return {
    id: 'workUnits',
    title: 'WORKUNITS',
    status: columnStatus({ hasFailures: failed.length > 0, hasActivity: active.length > 0, complete: total > 0 }),
    headline: `${total} WUs`,
    counters: [`${succeeded.length} done`, `${failed.length} failed`, `${active.length} active`],
    chips: workUnitChips(input),
    details: input.plannedWorkUnits.map(
      (workUnit) =>
        `${workUnit.unitKey}: ${workUnit.rawFiles.length} raw, ${workUnit.peerFileCount} peers, ${workUnit.dependencyCount} deps`,
    ),
  };
}

function actionsColumn(input: MemoryFlowReplayInput): MemoryFlowColumnView {
  const actions = eventsOf(input.events, 'candidate_action');
  const wikiCount = countCandidateActions(input.events, 'wiki');
  const slCount = countCandidateActions(input.events, 'sl');
  const skipped = skippedStage(input, 'actions');
  if (skipped) {
    return {
      id: 'actions',
      title: 'ACTIONS',
      status: 'warning',
      headline: 'skipped',
      counters: ['0 wiki', '0 SL'],
      chips: [{ label: 'skipped', status: 'warning', detail: skipped.reason }],
      details: [`Skipped: ${skipped.reason}`],
    };
  }
  const details = input.details.actions.length
    ? input.details.actions.map(
        (action) => `${action.unitKey} ${action.target} ${action.action} ${action.key}: ${action.summary}`,
      )
    : actions.map((action) => `${action.target} ${action.action}: ${action.key}`);
  return {
    id: 'actions',
    title: 'ACTIONS',
    status: columnStatus({ complete: actions.length > 0 }),
    headline: `${actions.length} candidates`,
    counters: [`${wikiCount} wiki`, `${slCount} SL`],
    chips: actionChips(input, actions),
    details,
  };
}

function gatesColumn(input: MemoryFlowReplayInput): MemoryFlowColumnView {
  const reconciliation = latest(input.events, 'reconciliation_finished');
  const failed = eventsOf(input.events, 'work_unit_finished').filter((event) => event.status === 'failed');
  const headline = reconciliation
    ? `${reconciliation.conflictCount} conflict, ${reconciliation.fallbackCount} fallback`
    : 'not run';
  const skipped = skippedStage(input, 'gates');
  if (skipped) {
    return {
      id: 'gates',
      title: 'GATES',
      status: 'warning',
      headline: 'skipped',
      counters: ['0 failed', '0 flagged'],
      chips: [{ label: 'skipped', status: 'warning', detail: skipped.reason }],
      details: [`Skipped: ${skipped.reason}`],
    };
  }
  return {
    id: 'gates',
    title: 'GATES',
    status: columnStatus({
      hasFailures: failed.length > 0,
      hasWarnings: (reconciliation?.conflictCount ?? 0) > 0 || (reconciliation?.fallbackCount ?? 0) > 0,
      complete: !!reconciliation,
    }),
    headline,
    counters: [`${failed.length} failed`, `${reconciliation?.fallbackCount ?? 0} flagged`],
    chips: firstChips(failed.map((event) => event.unitKey), 'failed'),
    details: [
      `Reconciliation: ${headline}`,
      `Failed work units: ${failed.length}`,
      `Conflicts resolved: ${reconciliation?.conflictCount ?? 0}`,
      `Flagged fallbacks: ${reconciliation?.fallbackCount ?? 0}`,
      ...failedWorkUnitDetails(failed),
      ...errorDetails(input),
    ],
  };
}

function savedColumn(input: MemoryFlowReplayInput): MemoryFlowColumnView {
  const saved = latest(input.events, 'saved');
  const provenance = latest(input.events, 'provenance_recorded');
  const report = latest(input.events, 'report_created');
  const memoryCount = (saved?.wikiCount ?? 0) + (saved?.slCount ?? 0);
  const chipLabels = [saved?.commitSha ? saved.commitSha.slice(0, 8) : '', report?.reportPath ?? ''].filter(
    (label): label is string => label.length > 0,
  );
  const skipped = skippedStage(input, 'saved');
  if (skipped) {
    return {
      id: 'saved',
      title: 'SAVED',
      status: 'warning',
      headline: '0 memories',
      counters: ['0 wiki', '0 SL', '0 provenance'],
      chips: [{ label: 'skipped', status: 'warning', detail: skipped.reason }],
      details: [
        `Skipped: ${skipped.reason}`,
        `Run: ${input.runId}`,
        `Report: ${report?.reportPath ?? input.reportPath ?? 'none'}`,
      ],
    };
  }
  return {
    id: 'saved',
    title: 'SAVED',
    status: columnStatus({ complete: memoryCount > 0 }),
    headline: memoryCount > 0 ? `${memoryCount} memories` : 'not saved',
    counters: [`${saved?.wikiCount ?? 0} wiki`, `${saved?.slCount ?? 0} SL`, `${provenance?.rowCount ?? 0} provenance`],
    chips: firstChips(chipLabels, 'complete'),
    details: [
      `Commit: ${saved?.commitSha ? saved.commitSha.slice(0, 8) : 'none'}`,
      `Run: ${input.runId}`,
      `Report: ${report?.reportPath ?? input.reportPath ?? 'none'}`,
      `Provenance rows: ${provenance?.rowCount ?? 0}`,
      ...(input.status === 'error' && saved ? ['Durable memory landed before failure.'] : []),
      ...(input.status === 'error' && saved ? errorDetails(input) : []),
    ],
  };
}

function completionLine(input: MemoryFlowReplayInput): string | null {
  const sources = eventsOf(input.events, 'source_acquired');
  const saved = latest(input.events, 'saved');
  const report = latest(input.events, 'report_created');
  if (sources.length === 0 || !saved || saved.wikiCount + saved.slCount === 0) {
    return null;
  }
  const totalFiles = sources.reduce((sum, event) => sum + event.fileCount, 0);
  const commit = saved.commitSha ? saved.commitSha.slice(0, 8) : 'none';
  return `Saved ${saved.wikiCount + saved.slCount} memories from ${totalFiles} raw files: ${saved.wikiCount} wiki pages, ${saved.slCount} SL updates. Commit: ${commit}  Run: ${input.runId}  Report: ${report?.reportPath ?? input.reportPath ?? 'none'}`;
}

export function buildMemoryFlowViewModel(input: MemoryFlowReplayInput): MemoryFlowViewModel {
  const columns = [
    sourceColumn(input),
    chunksColumn(input),
    workUnitsColumn(input),
    actionsColumn(input),
    gatesColumn(input),
    savedColumn(input),
  ];
  const plannedWorkUnitsColumn = columns.find((column) => column.id === 'workUnits');
  const errorColumn =
    input.status === 'error'
      ? columns.find((column) => column.id === (failureStage(input) === 'source' ? 'source' : 'gates'))
      : undefined;
  const warningColumn = columns.find((column) => column.status === 'warning');
  const firstExpandableColumn =
    errorColumn ??
    warningColumn ??
    (input.plannedWorkUnits.length > 0 && !latest(input.events, 'saved') && plannedWorkUnitsColumn
      ? plannedWorkUnitsColumn
      : (columns.find((column) => column.details.length > 0) ?? columns[0]));
  const trustIssues = buildMemoryFlowTrustIssues(input);

  const sources = eventsOf(input.events, 'source_acquired');
  const titleSources = sources.length > 1
    ? [...new Set(sources.map((s) => humanizeAdapter(s.adapter)))].join(' + ')
    : `${input.connectionId}/${input.adapter}`;

  return {
    title: `KTX memory flow  ${titleSources}  ${input.status}`,
    subtitle: `Run ${input.runId}  Sync ${input.syncId}`,
    status: input.status,
    activeLine: activeLine(input),
    columns,
    trustIssues,
    selectedTitle: firstExpandableColumn.title,
    selectedDetails: firstExpandableColumn.details,
    completionLine: completionLine(input),
    details: input.details,
  };
}
