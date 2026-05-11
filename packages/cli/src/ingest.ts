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
  type MemoryFlowReplayInput,
  type RunLocalIngestOptions,
  renderMemoryFlowReplay,
  runLocalIngest,
  runLocalMetabaseIngest,
} from '@ktx/context/ingest';
import { loadKtxProject } from '@ktx/context/project';
import { readIngestReportSnapshotFile } from './ingest-report-file.js';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';
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

function reportActionCounts(report: IngestReportSnapshot): { wikiCount: number; slCount: number } {
  const actions = report.body.workUnits.flatMap((workUnit) => workUnit.actions);
  return {
    wikiCount: actions.filter((action) => action.target === 'wiki').length,
    slCount: actions.filter((action) => action.target === 'sl').length,
  };
}

function writeReportStatus(report: IngestReportSnapshot, io: KtxIngestIo): void {
  const counts = reportActionCounts(report);
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
      const childCounts = reportActionCounts(child.report);
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
  io.stdout.write(`Metabase ingest: ${connectionId}\n`);
  io.stdout.write('Checking mappings and scheduled-pull targets...\n');
  return {
    onMetabaseFanoutPlanned(event) {
      io.stdout.write(`Targets: ${pluralize(event.children.length, 'mapped database')}\n`);
      for (const child of event.children) {
        io.stdout.write(`- database=${child.metabaseDatabaseId} target=${child.targetConnectionId} status=queued\n`);
      }
    },
    onMetabaseChildStarted(event) {
      io.stdout.write(
        `- database=${event.metabaseDatabaseId} target=${event.targetConnectionId} status=running job=${event.jobId}\n`,
      );
    },
    onMetabaseChildCompleted(event) {
      io.stdout.write(
        `- database=${event.metabaseDatabaseId} target=${event.targetConnectionId} status=${event.status} job=${event.jobId}\n`,
      );
    },
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
      const createAdapters = deps.createAdapters ?? createKtxCliLocalIngestAdapters;
      const executeLocalIngest = deps.runLocalIngest ?? runLocalIngest;
      const localIngestOptions = deps.localIngestOptions ?? {};
      const adapterOptions = {
        ...(localIngestOptions.pullConfigOptions ?? {}),
        ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
        ...(args.adapter === 'historic-sql' ? { historicSqlConnectionId: args.connectionId } : {}),
      };
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
      const initialMemoryFlow = shouldUseLiveViz ? initialRunMemoryFlowInput(args, jobId ?? 'pending') : undefined;
      let latestMemoryFlowSnapshot: MemoryFlowReplayInput | null = initialMemoryFlow ?? null;

      if (initialMemoryFlow && isTuiCapableIo(io)) {
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
              if (!liveTui) {
                writeMemoryFlowInput(snapshot, io, { clear: true });
              }
            },
          })
        : undefined;

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
          ...(args.debugLlmRequestFile ? { llmDebugRequestFile: args.debugLlmRequestFile } : {}),
          ...(memoryFlow ? { memoryFlow } : {}),
        });
        if (memoryFlow) {
          latestMemoryFlowSnapshot = memoryFlow.snapshot();
          liveTui?.close();
          liveTui = null;
          io.stdout.write(formatMemoryFlowFinalSummary(latestMemoryFlowSnapshot));
          return reportStatus(result.report) === 'done' ? 0 : 1;
        }
        await writeReportRecord(result.report, runOutputMode, io, {
          interactive: (args.inputMode ?? 'auto') === 'auto',
          renderStoredMemoryFlow: deps.renderStoredMemoryFlow,
          env,
        });
        return reportStatus(result.report) === 'done' ? 0 : 1;
      } finally {
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
          : 'No local ingest reports were found. Run `ktx ingest --all` first.',
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
