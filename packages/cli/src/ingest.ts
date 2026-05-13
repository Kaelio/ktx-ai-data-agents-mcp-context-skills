import {
  buildMemoryFlowViewModel,
  createMemoryFlowLiveBuffer,
  formatMemoryFlowFinalSummary,
  getLatestLocalIngestStatus,
  getLocalIngestStatus,
  type IngestReportSnapshot,
  ingestReportToMemoryFlowReplay,
  type LocalMetabaseFanoutResult,
  type LocalMetabaseFanoutProgress,
  type MemoryFlowEvent,
  type MemoryFlowReplayInput,
  type RunLocalIngestOptions,
  renderMemoryFlowReplay,
  runLocalIngest,
  runLocalMetabaseIngest,
  savedMemoryCountsForReport,
} from '@ktx/context/ingest';
import type { KtxSqlQueryExecutorPort } from '@ktx/context/connections';
import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';
import { readIngestReportSnapshotFile } from './ingest-report-file.js';
import { createCliOperationalLogger } from './io/logger.js';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import { type KtxMemoryFlowStdin, renderMemoryFlowInteractively } from './memory-flow-interactive.js';
import {
  type KtxMemoryFlowTuiIo,
  type MemoryFlowTuiLiveSession,
  renderMemoryFlowTui,
  startLiveMemoryFlowTui,
} from './memory-flow-tui.js';
import { resolveVizFallback, warnVizFallbackOnce } from './viz-fallback.js';
import { profileMark } from './startup-profile.js';

profileMark('module:ingest');

export type KtxIngestOutputMode = 'plain' | 'json' | 'viz';
type KtxIngestInputMode = 'auto' | 'disabled';

export type KtxIngestArgs =
  | {
      command: 'run';
      projectDir: string;
      connectionId: string;
      adapter: string;
      sourceDir?: string;
      databaseIntrospectionUrl?: string;
      cliVersion?: string;
      runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
      debugLlmRequestFile?: string;
      outputMode: KtxIngestOutputMode;
      inputMode?: KtxIngestInputMode;
    }
  | {
      command: 'status' | 'replay' | 'watch';
      projectDir: string;
      runId?: string;
      reportFile?: string;
      outputMode: KtxIngestOutputMode;
      inputMode?: KtxIngestInputMode;
    };

interface KtxIngestIo {
  stdin?: KtxMemoryFlowStdin;
  stdout: { isTTY?: boolean; columns?: number; write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

interface KtxIngestDeps {
  jobIdFactory?: () => string;
  now?: () => Date;
  createAdapters?: typeof createKtxCliLocalIngestAdapters;
  createQueryExecutor?: (project: KtxLocalProject) => KtxSqlQueryExecutorPort;
  runLocalIngest?: typeof runLocalIngest;
  runLocalMetabaseIngest?: typeof runLocalMetabaseIngest;
  readReportFile?: typeof readIngestReportSnapshotFile;
  renderStoredMemoryFlow?: typeof renderMemoryFlowTui;
  startLiveMemoryFlow?: typeof startLiveMemoryFlowTui;
  env?: NodeJS.ProcessEnv;
  localIngestOptions?: Pick<
    RunLocalIngestOptions,
    | 'agentRunner'
    | 'llmProvider'
    | 'memoryModel'
    | 'semanticLayerCompute'
    | 'queryExecutor'
    | 'logger'
    | 'pullConfigOptions'
  >;
}

function reportStatus(report: IngestReportSnapshot): 'done' | 'error' {
  return report.body.failedWorkUnits.length > 0 ? 'error' : 'done';
}

function writeReportStatus(report: IngestReportSnapshot, io: KtxIngestIo): void {
  const counts = savedMemoryCountsForReport(report);
  io.stdout.write(`Report: ${report.id}\n`);
  io.stdout.write(`Run: ${report.runId}\n`);
  io.stdout.write(`Job: ${report.jobId}\n`);
  io.stdout.write(`Status: ${reportStatus(report)}\n`);
  io.stdout.write(`Adapter: ${report.sourceKey}\n`);
  io.stdout.write(`Connection: ${report.connectionId}\n`);
  io.stdout.write(`Sync: ${report.body.syncId}\n`);
  io.stdout.write(
    `Diff: +${report.body.diffSummary.added}/~${report.body.diffSummary.modified}/-${report.body.diffSummary.deleted}/=${report.body.diffSummary.unchanged}\n`,
  );
  io.stdout.write(`Work units: ${report.body.workUnits.length}\n`);
  io.stdout.write(`Saved memory: ${counts.wikiCount} wiki, ${counts.slCount} SL\n`);
  io.stdout.write(`Provenance rows: ${report.body.provenanceRows.length}\n`);
}

function writeMetabaseFanoutStatus(result: LocalMetabaseFanoutResult, io: KtxIngestIo): void {
  const counts = result.children.reduce(
    (acc, child) => {
      const childCounts = savedMemoryCountsForReport(child.report);
      return {
        wikiCount: acc.wikiCount + childCounts.wikiCount,
        slCount: acc.slCount + childCounts.slCount,
      };
    },
    { wikiCount: 0, slCount: 0 },
  );
  io.stdout.write(`Metabase fan-out: ${result.status}\n`);
  io.stdout.write(`Source: ${result.metabaseConnectionId}\n`);
  io.stdout.write(`Children: ${result.children.length}\n`);
  if (result.totals) {
    io.stdout.write(`Work units: ${result.totals.workUnits}\n`);
    io.stdout.write(`Failed work units: ${result.totals.failedWorkUnits}\n`);
  }
  io.stdout.write(`Saved memory: ${counts.wikiCount} wiki, ${counts.slCount} SL\n`);
  for (const child of result.children) {
    const status = reportStatus(child.report);
    io.stdout.write(
      `- target=${child.targetConnectionId} database=${child.metabaseDatabaseId} status=${status} job=${child.jobId} report=${child.report.id}\n`,
    );
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function createMetabaseFanoutProgress(
  connectionId: string,
  io: KtxIngestIo,
): LocalMetabaseFanoutProgress {
  io.stderr.write(`Metabase ingest: ${connectionId}\n`);
  io.stderr.write('Checking mappings and scheduled-pull targets...\n');
  return {
    onMetabaseFanoutPlanned(event) {
      io.stderr.write(`Targets: ${pluralize(event.children.length, 'mapped database')}\n`);
      for (const child of event.children) {
        io.stderr.write(`- database=${child.metabaseDatabaseId} target=${child.targetConnectionId} status=queued\n`);
      }
    },
    onMetabaseChildStarted(event) {
      io.stderr.write(
        `- database=${event.metabaseDatabaseId} target=${event.targetConnectionId} status=running job=${event.jobId}\n`,
      );
    },
    onMetabaseChildCompleted(event) {
      io.stderr.write(
        `- database=${event.metabaseDatabaseId} target=${event.targetConnectionId} status=${event.status} job=${event.jobId}\n`,
      );
    },
  };
}

function formatDiffProgress(event: Extract<MemoryFlowEvent, { type: 'diff_computed' }>): string {
  return `+${event.added}/~${event.modified}/-${event.deleted}/=${event.unchanged}`;
}

function workUnitEventsThrough(snapshot: MemoryFlowReplayInput, eventIndex: number): MemoryFlowEvent[] {
  return snapshot.events.slice(0, eventIndex + 1);
}

function completedWorkUnitCountThrough(snapshot: MemoryFlowReplayInput, eventIndex: number): number {
  return workUnitEventsThrough(snapshot, eventIndex).filter((event) => event.type === 'work_unit_finished').length;
}

function activeWorkUnitCountThrough(snapshot: MemoryFlowReplayInput, eventIndex: number): number {
  const active = new Set<string>();
  for (const event of workUnitEventsThrough(snapshot, eventIndex)) {
    if (event.type === 'work_unit_started') {
      active.add(event.unitKey);
    }
    if (event.type === 'work_unit_finished') {
      active.delete(event.unitKey);
    }
  }
  return active.size;
}

function plannedWorkUnitCountThrough(snapshot: MemoryFlowReplayInput, eventIndex: number): number {
  if (snapshot.plannedWorkUnits.length > 0) {
    return snapshot.plannedWorkUnits.length;
  }
  const planEvent = workUnitEventsThrough(snapshot, eventIndex)
    .filter((event) => event.type === 'chunks_planned')
    .at(-1);
  return planEvent?.workUnitCount ?? completedWorkUnitCountThrough(snapshot, eventIndex);
}

function workUnitOrdinalThrough(snapshot: MemoryFlowReplayInput, eventIndex: number, unitKey: string): number {
  const events = workUnitEventsThrough(snapshot, eventIndex);
  const startedIndex = events.findIndex((event) => event.type === 'work_unit_started' && event.unitKey === unitKey);
  if (startedIndex === -1) {
    return completedWorkUnitCountThrough(snapshot, eventIndex) + 1;
  }
  return events.slice(0, startedIndex + 1).filter((event) => event.type === 'work_unit_started').length;
}

function plainIngestEventProgress(
  event: MemoryFlowEvent,
  snapshot: MemoryFlowReplayInput,
  eventIndex: number,
): { percent: number; message: string; transient?: boolean } | null {
  switch (event.type) {
    case 'source_acquired':
      return {
        percent: 15,
        message: `Fetched ${pluralize(event.fileCount, 'source file')} from ${event.adapter}`,
      };
    case 'raw_snapshot_written':
      return {
        percent: 25,
        message: `Wrote raw snapshot ${event.syncId} with ${pluralize(event.rawFileCount, 'file')}`,
      };
    case 'diff_computed':
      return { percent: 35, message: `Computed source diff ${formatDiffProgress(event)}` };
    case 'chunks_planned':
      return {
        percent: 45,
        message: `Planned ${pluralize(event.workUnitCount, 'work unit')}`,
      };
    case 'stage_skipped':
      return { percent: 45, message: `Skipped ${event.stage}: ${event.reason}` };
    case 'work_unit_started': {
      const total = plannedWorkUnitCountThrough(snapshot, eventIndex);
      const ordinal = workUnitOrdinalThrough(snapshot, eventIndex, event.unitKey);
      const progress = total > 0 ? `${ordinal}/${total} work units: ` : '';
      return { percent: 55, message: `Processing ${progress}${event.unitKey}` };
    }
    case 'work_unit_step': {
      const total = plannedWorkUnitCountThrough(snapshot, eventIndex);
      const completed = completedWorkUnitCountThrough(snapshot, eventIndex);
      const active = activeWorkUnitCountThrough(snapshot, eventIndex);
      const stepFraction = event.stepBudget > 0 ? Math.min(1, event.stepIndex / event.stepBudget) : 0;
      const percent = total > 0 ? 55 + Math.ceil(((completed + stepFraction) / total) * 25) : 55;
      const latest = `${event.unitKey} step ${event.stepIndex}/${event.stepBudget}`;
      return {
        percent,
        message: `Processing work units: ${completed}/${total} complete, ${active} active; latest ${latest}`,
        transient: true,
      };
    }
    case 'work_unit_finished': {
      const total = plannedWorkUnitCountThrough(snapshot, eventIndex);
      const completed = completedWorkUnitCountThrough(snapshot, eventIndex);
      const percent = total > 0 ? 55 + Math.round((completed / total) * 25) : 80;
      return {
        percent,
        message: `Processed ${completed}/${total} work units`,
      };
    }
    case 'reconciliation_finished':
      return {
        percent: 85,
        message: `Reconciled results with ${pluralize(event.conflictCount, 'conflict')} and ${pluralize(
          event.fallbackCount,
          'fallback',
        )}`,
      };
    case 'saved':
      return {
        percent: 90,
        message: `Saved memory updates (${event.wikiCount} wiki, ${event.slCount} SL)`,
      };
    case 'provenance_recorded':
      return { percent: 95, message: `Recorded ${pluralize(event.rowCount, 'provenance row')}` };
    case 'report_created':
      return { percent: 98, message: `Created ingest report ${event.reportPath ?? event.runId}` };
    case 'scope_detected':
    case 'candidate_action':
      return null;
  }
}

function shouldWritePlainIngestProgress(
  outputMode: KtxIngestOutputMode,
  io: KtxIngestIo,
  env: NodeJS.ProcessEnv,
): boolean {
  return outputMode === 'plain' && io.stdout.isTTY === true && env.CI !== 'true';
}

function createPlainIngestProgressRenderer(
  args: Extract<KtxIngestArgs, { command: 'run' }>,
  io: KtxIngestIo,
): { start(): void; update(snapshot: MemoryFlowReplayInput): void; flush(): void } {
  let printedEvents = 0;
  let lastPercent = 0;
  let printedCompletion = false;
  let hasPendingTransient = false;

  const flush = () => {
    if (!hasPendingTransient) {
      return;
    }
    io.stderr.write('\n');
    hasPendingTransient = false;
  };

  const write = (percent: number, message: string, options?: { transient?: boolean }) => {
    const nextPercent = Math.max(lastPercent, Math.max(0, Math.min(100, percent)));
    lastPercent = nextPercent;
    const line = `[${nextPercent}%] ${message}`;
    if (options?.transient === true) {
      io.stderr.write(`\r${line}\u001b[K`);
      hasPendingTransient = true;
      return;
    }
    flush();
    io.stderr.write(`${line}\n`);
  };

  return {
    start() {
      write(5, `Fetching source files for ${args.connectionId}/${args.adapter}`);
    },
    update(snapshot) {
      while (printedEvents < snapshot.events.length) {
        const eventIndex = printedEvents;
        const event = snapshot.events[printedEvents++];
        if (!event) {
          continue;
        }
        const progress = plainIngestEventProgress(event, snapshot, eventIndex);
        if (progress) {
          write(progress.percent, progress.message, progress.transient === true ? { transient: true } : undefined);
        }
      }
      if (!printedCompletion && snapshot.status !== 'running') {
        printedCompletion = true;
        write(100, snapshot.status === 'done' ? 'Ingest completed' : 'Ingest failed');
      }
    },
    flush,
  };
}

function writeReportJson(report: IngestReportSnapshot, io: KtxIngestIo): void {
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function assertReportMatchesReplayId(report: IngestReportSnapshot, requestedId: string, reportFile: string): void {
  const validIds = [report.id, report.runId, report.jobId];
  if (!validIds.includes(requestedId)) {
    throw new Error(
      `Report file ${reportFile} does not match ingest replay id "${requestedId}"; expected one of ${validIds.join(
        ', ',
      )}`,
    );
  }
}

async function readStoredIngestReport(
  project: Awaited<ReturnType<typeof loadKtxProject>>,
  runId: string | undefined,
): Promise<IngestReportSnapshot | null> {
  return runId ? await getLocalIngestStatus(project, runId) : await getLatestLocalIngestStatus(project);
}

function isInteractiveTerminal(io: KtxIngestIo): boolean {
  return io.stdout.isTTY === true;
}

function terminalWidth(io: KtxIngestIo): number | undefined {
  return io.stdout.columns ?? process.stdout.columns;
}

function isTuiCapableIo(io: KtxIngestIo): io is KtxIngestIo & KtxMemoryFlowTuiIo {
  return (
    io.stdin?.isTTY === true &&
    io.stdout.isTTY === true &&
    typeof io.stdin.on === 'function' &&
    typeof io.stdin.setRawMode === 'function' &&
    typeof io.stdout.write === 'function'
  );
}

interface EffectiveIngestOutputModeOptions {
  requireInput?: boolean;
}

function effectiveIngestOutputMode(
  outputMode: KtxIngestOutputMode,
  io: KtxIngestIo,
  env: NodeJS.ProcessEnv,
  options: EffectiveIngestOutputModeOptions = {},
): KtxIngestOutputMode {
  if (outputMode !== 'viz') {
    return outputMode;
  }

  const fallback = resolveVizFallback(io, env, { requireInput: options.requireInput ?? false });
  if (!fallback.shouldDegrade) {
    return outputMode;
  }

  warnVizFallbackOnce(io, fallback);
  return 'plain';
}

function writeMemoryFlowInput(input: MemoryFlowReplayInput, io: KtxIngestIo, options: { clear?: boolean } = {}): void {
  if (options.clear) {
    io.stdout.write('\u001b[2J\u001b[H');
  }
  const view = buildMemoryFlowViewModel(input);
  io.stdout.write(renderMemoryFlowReplay(view, { terminalWidth: terminalWidth(io) }));
}

function initialRunMemoryFlowInput(
  args: Extract<KtxIngestArgs, { command: 'run' }>,
  runId: string,
): MemoryFlowReplayInput {
  return {
    runId,
    connectionId: args.connectionId,
    adapter: args.adapter,
    status: 'running',
    sourceDir: args.sourceDir ?? null,
    syncId: 'pending',
    errors: [],
    events: [],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
  };
}

function finalRunMemoryFlowInput(snapshot: MemoryFlowReplayInput, report: IngestReportSnapshot): MemoryFlowReplayInput {
  const status = reportStatus(report);
  return {
    ...snapshot,
    runId: report.runId,
    connectionId: report.connectionId,
    adapter: report.sourceKey,
    status,
    syncId: report.body.syncId,
    reportId: report.id,
    reportPath: report.id,
    errors: status === 'error' ? report.body.failedWorkUnits : snapshot.errors,
  };
}

function managedDaemonOptionsForIngestRun(
  args: Extract<KtxIngestArgs, { command: 'run' }>,
  io: KtxIngestIo,
) {
  if (args.databaseIntrospectionUrl || !args.cliVersion || !args.runtimeInstallPolicy) {
    return undefined;
  }
  return {
    cliVersion: args.cliVersion,
    installPolicy: args.runtimeInstallPolicy,
    io,
  };
}

async function writeReportRecord(
  report: IngestReportSnapshot,
  outputMode: KtxIngestOutputMode,
  io: KtxIngestIo,
  options: {
    interactive?: boolean;
    renderStoredMemoryFlow?: typeof renderMemoryFlowTui;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  if (outputMode === 'json') {
    writeReportJson(report, io);
    return;
  }

  const resolvedOutputMode = effectiveIngestOutputMode(outputMode, io, options.env ?? process.env, {
    requireInput: options.interactive === true,
  });

  if (resolvedOutputMode === 'viz') {
    const input = ingestReportToMemoryFlowReplay(report, { provenanceRowCount: report.body.provenanceRows.length });
    if (options.interactive === true) {
      if (io.stdin?.isTTY === true) {
        const renderStoredMemoryFlow = options.renderStoredMemoryFlow ?? renderMemoryFlowTui;
        if (isTuiCapableIo(io) && (await renderStoredMemoryFlow(input, io))) {
          return;
        }

        await renderMemoryFlowInteractively(input, io);
        return;
      }

      writeMemoryFlowInput(input, io);
      return;
    }

    writeMemoryFlowInput(input, io);
    return;
  }

  writeReportStatus(report, io);
}

export async function runKtxIngest(
  args: KtxIngestArgs,
  io: KtxIngestIo = process,
  deps: KtxIngestDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    const env = deps.env ?? process.env;
    if (args.command === 'run') {
      const createAdapters =
        deps.createAdapters ??
        (deps.runLocalIngest || deps.runLocalMetabaseIngest ? () => [] : createKtxCliLocalIngestAdapters);
      const executeLocalIngest = deps.runLocalIngest ?? runLocalIngest;
      const localIngestOptions = deps.localIngestOptions ?? {};
      const managedDaemon = managedDaemonOptionsForIngestRun(args, io);
      const operationalLogger = createCliOperationalLogger(io, args.outputMode);
      const adapterOptions = {
        ...(localIngestOptions.pullConfigOptions ?? {}),
        ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
        ...(managedDaemon ? { managedDaemon } : {}),
        ...(args.adapter === 'historic-sql' ? { historicSqlConnectionId: args.connectionId } : {}),
        logger: operationalLogger,
      };
      const queryExecutor =
        localIngestOptions.queryExecutor ??
        (deps.createQueryExecutor ?? createKtxCliIngestQueryExecutor)(project);
      if (args.adapter === 'metabase' && args.sourceDir) {
        throw new Error('source-dir uploads are not supported for the Metabase fan-out adapter');
      }
      if (args.adapter === 'metabase') {
        const executeMetabaseFanout = deps.runLocalMetabaseIngest ?? runLocalMetabaseIngest;
        const progress =
          args.outputMode === 'json' ? undefined : createMetabaseFanoutProgress(args.connectionId, io);
        const result = await executeMetabaseFanout({
          project,
          adapters: createAdapters(project, adapterOptions),
          metabaseConnectionId: args.connectionId,
          ...localIngestOptions,
          queryExecutor,
          trigger: 'manual_resync',
          jobIdFactory: deps.jobIdFactory,
          ...(progress ? { progress } : {}),
        });
        if (args.outputMode === 'json') {
          io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          writeMetabaseFanoutStatus(result, io);
        }
        return result.status === 'all_succeeded' ? 0 : 1;
      }

      const jobId = deps.jobIdFactory?.();
      let liveTui: MemoryFlowTuiLiveSession | null = null;
      const runOutputMode = effectiveIngestOutputMode(args.outputMode, io, env, {
        requireInput: (args.inputMode ?? 'auto') === 'auto',
      });
      const shouldUseLiveViz =
        runOutputMode === 'viz' && (args.inputMode ?? 'auto') === 'auto' && isInteractiveTerminal(io);
      const plainProgress = shouldWritePlainIngestProgress(runOutputMode, io, env)
        ? createPlainIngestProgressRenderer(args, io)
        : null;
      const initialMemoryFlow =
        shouldUseLiveViz || plainProgress ? initialRunMemoryFlowInput(args, jobId ?? 'pending') : undefined;
      let latestMemoryFlowSnapshot: MemoryFlowReplayInput | null = initialMemoryFlow ?? null;

      if (shouldUseLiveViz && initialMemoryFlow && isTuiCapableIo(io)) {
        const startLiveMemoryFlow = deps.startLiveMemoryFlow ?? startLiveMemoryFlowTui;
        liveTui = await startLiveMemoryFlow(initialMemoryFlow, io);
      }

      const memoryFlow = initialMemoryFlow
        ? createMemoryFlowLiveBuffer(initialMemoryFlow, {
            onChange: (snapshot) => {
              latestMemoryFlowSnapshot = snapshot;
              if (liveTui && !liveTui.isClosed()) {
                liveTui.update(snapshot);
                return;
              }
              if (shouldUseLiveViz && !liveTui) {
                writeMemoryFlowInput(snapshot, io, { clear: true });
                return;
              }
              plainProgress?.update(snapshot);
            },
          })
        : undefined;

      plainProgress?.start();

      try {
        const result = await executeLocalIngest({
          project,
          adapters: createAdapters(project, adapterOptions),
          adapter: args.adapter,
          connectionId: args.connectionId,
          sourceDir: args.sourceDir,
          trigger: 'manual_resync',
          jobId,
          ...localIngestOptions,
          queryExecutor,
          pullConfigOptions: adapterOptions,
          ...(args.debugLlmRequestFile ? { llmDebugRequestFile: args.debugLlmRequestFile } : {}),
          ...(memoryFlow ? { memoryFlow } : {}),
        });
        if (shouldUseLiveViz && memoryFlow) {
          latestMemoryFlowSnapshot = finalRunMemoryFlowInput(memoryFlow.snapshot(), result.report);
          liveTui?.close();
          liveTui = null;
          io.stdout.write(formatMemoryFlowFinalSummary(latestMemoryFlowSnapshot));
          return reportStatus(result.report) === 'done' ? 0 : 1;
        }
        plainProgress?.flush();
        await writeReportRecord(result.report, runOutputMode, io, {
          interactive: (args.inputMode ?? 'auto') === 'auto',
          renderStoredMemoryFlow: deps.renderStoredMemoryFlow,
          env,
        });
        return reportStatus(result.report) === 'done' ? 0 : 1;
      } finally {
        plainProgress?.flush();
        liveTui?.close();
      }
    }

    if (args.reportFile) {
      const readReportFile = deps.readReportFile ?? readIngestReportSnapshotFile;
      const report = await readReportFile(args.reportFile);
      if (args.runId) {
        assertReportMatchesReplayId(report, args.runId, args.reportFile);
      }
      await writeReportRecord(report, args.outputMode, io, {
        interactive: (args.inputMode ?? 'auto') === 'auto',
        renderStoredMemoryFlow: deps.renderStoredMemoryFlow,
        env,
      });
      return 0;
    }

    const report = await readStoredIngestReport(project, args.runId);
    if (!report) {
      throw new Error(
        args.runId
          ? `Local ingest run or report "${args.runId}" was not found`
          : 'No local ingest reports were found. Run `ktx ingest run --connection-id <id> --adapter <adapter>` first.',
      );
    }
    await writeReportRecord(report, args.outputMode, io, {
      interactive: (args.inputMode ?? 'auto') === 'auto',
      renderStoredMemoryFlow: deps.renderStoredMemoryFlow,
      env,
    });
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
