import { loadKtxProject } from '@ktx/context/project';
import {
  type KtxProgressPort,
  type KtxScanMode,
  type KtxScanReport,
  type KtxScanWarning,
  runLocalScan,
} from '@ktx/context/scan';
import type { KtxCliIo } from './index.js';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import { profileMark } from './startup-profile.js';

profileMark('module:scan');

export interface KtxScanArgs {
  command: 'run';
  projectDir: string;
  connectionId: string;
  mode: KtxScanMode;
  detectRelationships: boolean;
  dryRun: boolean;
  databaseIntrospectionUrl?: string;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
}

export interface KtxScanDeps {
  runLocalScan?: typeof runLocalScan;
  createLocalIngestAdapters?: typeof createKtxCliLocalIngestAdapters;
  progress?: KtxProgressPort;
}

function shouldUseStyledOutput(io: KtxCliIo): boolean {
  return io.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb' && !process.env.CI;
}

function green(text: string): string {
  return `\u001b[32m${text}\u001b[39m`;
}

function dim(text: string): string {
  return `\u001b[2m${text}\u001b[22m`;
}

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return count === 1 ? singular : pluralValue;
}

function tableChangeCount(report: KtxScanReport): number {
  return report.diffSummary.tablesAdded + report.diffSummary.tablesModified + report.diffSummary.tablesDeleted;
}

function totalTableCount(report: KtxScanReport): number {
  return tableChangeCount(report) + report.diffSummary.tablesUnchanged;
}

function writeScanIdentity(report: KtxScanReport, io: KtxCliIo): void {
  io.stdout.write(`Run: ${report.runId}\n`);
  io.stdout.write(`Connection: ${report.connectionId}\n`);
  io.stdout.write(`Mode: ${report.mode}\n`);
  io.stdout.write(`Sync: ${report.syncId}\n`);
  io.stdout.write(`Dry run: ${report.dryRun ? 'yes' : 'no'}\n`);
}

function writeWhatChanged(report: KtxScanReport, io: KtxCliIo): void {
  const changedTables = tableChangeCount(report);
  const totalTables = totalTableCount(report);
  io.stdout.write('\nWhat changed\n');
  const tableNoun = plural(totalTables, 'table');
  const changeNoun = plural(changedTables, 'change');
  io.stdout.write(
    `  Semantic layer comparison found ${changedTables} ${changeNoun} across ${totalTables} ${tableNoun}\n`,
  );
  io.stdout.write(`  New tables: ${report.diffSummary.tablesAdded}\n`);
  io.stdout.write(`  Changed tables: ${report.diffSummary.tablesModified}\n`);
  io.stdout.write(`  Removed tables: ${report.diffSummary.tablesDeleted}\n`);
  io.stdout.write(`  Unchanged tables: ${report.diffSummary.tablesUnchanged}\n`);
  if (
    report.diffSummary.columnsAdded > 0 ||
    report.diffSummary.columnsModified > 0 ||
    report.diffSummary.columnsDeleted > 0
  ) {
    io.stdout.write(`  New columns: ${report.diffSummary.columnsAdded}\n`);
    io.stdout.write(`  Changed columns: ${report.diffSummary.columnsModified}\n`);
    io.stdout.write(`  Removed columns: ${report.diffSummary.columnsDeleted}\n`);
  }
}

function hasRelationshipResults(report: KtxScanReport): boolean {
  return (
    report.relationships.accepted > 0 ||
    report.relationships.review > 0 ||
    report.relationships.rejected > 0 ||
    report.relationships.skipped > 0
  );
}

function writeRelationships(report: KtxScanReport, io: KtxCliIo): void {
  if (!hasRelationshipResults(report)) {
    return;
  }
  io.stdout.write('\nRelationships\n');
  io.stdout.write(`  Accepted: ${report.relationships.accepted}\n`);
  io.stdout.write(`  Review: ${report.relationships.review}\n`);
  io.stdout.write(`  Rejected: ${report.relationships.rejected}\n`);
  io.stdout.write(`  Skipped: ${report.relationships.skipped}\n`);
}

function capabilityGapMessage(gap: string): string {
  if (gap === 'columnStats') {
    return 'columnStats is unavailable; relationship confidence may be lower.';
  }
  if (gap === 'tableSampling' || gap === 'columnSampling') {
    return `${gap} is unavailable; descriptions may be less specific.`;
  }
  if (gap === 'readOnlySql') {
    return 'readOnlySql is unavailable; relationship and validation checks may be limited.';
  }
  return `${gap} is unavailable; scan results may be less complete.`;
}

function warningLine(warning: KtxScanWarning): string {
  const location = warning.table ? `${warning.table}${warning.column ? `.${warning.column}` : ''}: ` : '';
  return `${warning.code}: ${location}${warning.message}`;
}

function managedDaemonOptionsForScanRun(args: Extract<KtxScanArgs, { command: 'run' }>, io: KtxCliIo) {
  if (args.databaseIntrospectionUrl || !args.cliVersion || !args.runtimeInstallPolicy) {
    return undefined;
  }
  return {
    cliVersion: args.cliVersion,
    projectDir: args.projectDir,
    installPolicy: args.runtimeInstallPolicy,
    io,
  };
}

function writeNeedsAttention(report: KtxScanReport, io: KtxCliIo): void {
  io.stdout.write('\nNeeds attention\n');
  if (report.warnings.length === 0 && report.capabilityGaps.length === 0) {
    io.stdout.write('  None\n');
    return;
  }
  if (report.warnings.length > 0) {
    io.stdout.write(`  ${report.warnings.length} ${plural(report.warnings.length, 'warning')}\n`);
    for (const warning of report.warnings.slice(0, 5)) {
      io.stdout.write(`    - ${warningLine(warning)}\n`);
    }
    if (report.warnings.length > 5) {
      io.stdout.write(`    - ${report.warnings.length - 5} more warnings in the JSON report\n`);
    }
  }
  if (report.capabilityGaps.length > 0) {
    io.stdout.write(`  ${report.capabilityGaps.length} capability ${plural(report.capabilityGaps.length, 'gap')}\n`);
    for (const gap of report.capabilityGaps) {
      io.stdout.write(`    - ${capabilityGapMessage(gap)}\n`);
    }
  }
}

function writeArtifacts(report: KtxScanReport, io: KtxCliIo): void {
  io.stdout.write('\nArtifacts\n');
  io.stdout.write(`  Report: ${report.artifactPaths.reportPath ?? 'none'}\n`);
  io.stdout.write(`  Raw sources: ${report.artifactPaths.rawSourcesDir ?? 'none'}\n`);
  if (report.artifactPaths.manifestShards.length > 0) {
    io.stdout.write(`  Schema shards: ${report.artifactPaths.manifestShards.length}\n`);
  }
  if (report.artifactPaths.enrichmentArtifacts.length > 0) {
    io.stdout.write(`  Enrichment artifacts: ${report.artifactPaths.enrichmentArtifacts.length}\n`);
  }
}

function writeHumanReportBody(report: KtxScanReport, io: KtxCliIo): void {
  writeScanIdentity(report, io);
  writeWhatChanged(report, io);
  writeRelationships(report, io);
  writeNeedsAttention(report, io);
  writeArtifacts(report, io);
}

function writeRunSummary(report: KtxScanReport, projectDir: string, io: KtxCliIo): void {
  const styled = shouldUseStyledOutput(io);
  io.stdout.write(`${styled ? green('✓') : ''}${styled ? ' ' : ''}KTX scan completed\n`);
  io.stdout.write('Status: done\n');
  writeHumanReportBody(report, io);
  const projectDirArg = quoteCliArg(projectDir);
  io.stdout.write('\nNext:\n');
  const statusCommand = styled ? dim('ktx status') : 'ktx status';
  io.stdout.write(`  ${statusCommand} --project-dir ${projectDirArg}\n`);
}

interface KtxCliScanProgressState {
  progress: number;
  hasPendingTransient: boolean;
}

interface KtxCliScanProgressUpdateOptions {
  transient?: boolean;
}

interface KtxCliScanProgress extends Omit<KtxProgressPort, 'update'> {
  update(progress: number, message?: string, options?: KtxCliScanProgressUpdateOptions): Promise<void>;
  flush(): void;
}

export function createCliScanProgress(
  io: KtxCliIo,
  state: KtxCliScanProgressState = { progress: 0, hasPendingTransient: false },
  start = 0,
  weight = 1,
): KtxCliScanProgress {
  const shouldWrite = io.stdout.isTTY === true && !process.env.CI;
  const progress: KtxCliScanProgress = {
    async update(value: number, message?: string, options?: KtxCliScanProgressUpdateOptions) {
      const absoluteValue = start + Math.max(0, Math.min(1, value)) * weight;
      state.progress = Math.max(state.progress, Math.min(1, absoluteValue));
      if (!shouldWrite || !message) {
        return;
      }
      const percent = Math.max(0, Math.min(100, Math.round(absoluteValue * 100)));
      const line = `[${percent}%] ${message}`;
      if (options?.transient === true) {
        io.stdout.write(`\r${line}\u001b[K`);
        state.hasPendingTransient = true;
        return;
      }
      progress.flush();
      io.stdout.write(`${line}\n`);
    },
    startPhase(phaseWeight: number) {
      return createCliScanProgress(io, state, state.progress, weight * phaseWeight);
    },
    flush() {
      if (!shouldWrite || !state.hasPendingTransient) {
        return;
      }
      io.stdout.write('\n');
      state.hasPendingTransient = false;
    },
  };
  return progress;
}

export async function runKtxScan(args: KtxScanArgs, io: KtxCliIo = process, deps: KtxScanDeps = {}): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    const managedDaemon = managedDaemonOptionsForScanRun(args, io);
    const connector =
      args.mode !== 'structural' || args.detectRelationships
        ? await createKtxCliScanConnector(project, args.connectionId)
        : undefined;
    const cliProgress = deps.progress ? null : createCliScanProgress(io);
    const progress = deps.progress ?? cliProgress;
    try {
      const result = await (deps.runLocalScan ?? runLocalScan)({
        project,
        connectionId: args.connectionId,
        mode: args.mode,
        detectRelationships: args.detectRelationships,
        dryRun: args.dryRun,
        trigger: 'cli',
        databaseIntrospectionUrl: args.databaseIntrospectionUrl,
        connector,
        adapters: (deps.createLocalIngestAdapters ?? createKtxCliLocalIngestAdapters)(project, {
          ...(args.databaseIntrospectionUrl ? { databaseIntrospectionUrl: args.databaseIntrospectionUrl } : {}),
          ...(managedDaemon ? { managedDaemon } : {}),
        }),
        ...(progress ? { progress } : {}),
      });
      cliProgress?.flush();
      writeRunSummary(result.report, args.projectDir, io);
    } finally {
      cliProgress?.flush();
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
