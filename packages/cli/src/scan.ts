import { loadKtxProject } from '@ktx/context/project';
import {
  type ApplyLocalScanRelationshipReviewDecisionsResult,
  adviseLocalRelationshipFeedbackThresholds,
  applyLocalScanRelationshipReviewDecisions,
  calibrateLocalRelationshipFeedbackLabels,
  type ExportLocalRelationshipFeedbackLabelsResult,
  exportLocalRelationshipFeedbackLabels,
  formatKtxRelationshipFeedbackCalibrationMarkdown,
  formatKtxRelationshipFeedbackLabelsJsonl,
  formatKtxRelationshipThresholdAdviceMarkdown,
  getLocalScanReport,
  getLocalScanStatus,
  type KtxProgressPort,
  type KtxRelationshipArtifact,
  type KtxRelationshipArtifactEdge,
  type KtxRelationshipArtifactStatus,
  type KtxRelationshipDiagnosticsArtifact,
  type KtxRelationshipFeedbackCalibrationReport,
  type KtxRelationshipFeedbackDecisionFilter,
  type KtxRelationshipFeedbackLabel,
  type KtxRelationshipReviewDecisionValue,
  type KtxRelationshipThresholdAdviceReport,
  type KtxScanMode,
  type KtxScanReport,
  type KtxScanWarning,
  type LocalScanStatusResponse,
  readLocalScanRelationshipArtifacts,
  runLocalScan,
  type WriteLocalScanRelationshipReviewDecisionResult,
  writeLocalScanRelationshipReviewDecision,
} from '@ktx/context/scan';
import type { KtxCliIo } from './index.js';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import { profileMark } from './startup-profile.js';

profileMark('module:scan');

export type KtxScanArgs =
  | {
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
  | { command: 'status'; projectDir: string; runId: string }
  | { command: 'report'; projectDir: string; runId: string; json: boolean }
  | {
      command: 'relationships';
      projectDir: string;
      runId: string;
      status: KtxRelationshipArtifactStatus;
      json: boolean;
      limit: number;
    }
  | {
      command: 'relationshipDecision';
      projectDir: string;
      runId: string;
      candidateId: string;
      decision: KtxRelationshipReviewDecisionValue;
      reviewer: string;
      note: string | null;
      json: boolean;
    }
  | {
      command: 'relationshipApply';
      projectDir: string;
      runId: string;
      applyAllAccepted: boolean;
      candidateIds: string[];
      dryRun: boolean;
      json: boolean;
    }
  | {
      command: 'relationshipFeedback';
      projectDir: string;
      connectionId: string | null;
      decision: KtxRelationshipFeedbackDecisionFilter;
      json: boolean;
      jsonl: boolean;
    }
  | {
      command: 'relationshipCalibration';
      projectDir: string;
      connectionId: string | null;
      decision: KtxRelationshipFeedbackDecisionFilter;
      acceptThreshold: number;
      reviewThreshold: number;
      json: boolean;
    }
  | {
      command: 'relationshipThresholds';
      projectDir: string;
      connectionId: string | null;
      minTotalLabels: number;
      minAcceptedLabels: number;
      minRejectedLabels: number;
      json: boolean;
    };

interface KtxScanDeps {
  runLocalScan?: typeof runLocalScan;
  createLocalIngestAdapters?: typeof createKtxCliLocalIngestAdapters;
  getLocalScanStatus?: typeof getLocalScanStatus;
  getLocalScanReport?: typeof getLocalScanReport;
  readLocalScanRelationshipArtifacts?: typeof readLocalScanRelationshipArtifacts;
  writeLocalScanRelationshipReviewDecision?: typeof writeLocalScanRelationshipReviewDecision;
  applyLocalScanRelationshipReviewDecisions?: typeof applyLocalScanRelationshipReviewDecisions;
  exportLocalRelationshipFeedbackLabels?: typeof exportLocalRelationshipFeedbackLabels;
  formatKtxRelationshipFeedbackLabelsJsonl?: typeof formatKtxRelationshipFeedbackLabelsJsonl;
  calibrateLocalRelationshipFeedbackLabels?: typeof calibrateLocalRelationshipFeedbackLabels;
  formatKtxRelationshipFeedbackCalibrationMarkdown?: typeof formatKtxRelationshipFeedbackCalibrationMarkdown;
  adviseLocalRelationshipFeedbackThresholds?: typeof adviseLocalRelationshipFeedbackThresholds;
  formatKtxRelationshipThresholdAdviceMarkdown?: typeof formatKtxRelationshipThresholdAdviceMarkdown;
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
  const statusCommand = styled ? dim('ktx dev scan status') : 'ktx dev scan status';
  const reportCommand = styled ? dim('ktx dev scan report') : 'ktx dev scan report';
  io.stdout.write(`  ${statusCommand} --project-dir ${projectDirArg} ${report.runId}\n`);
  io.stdout.write(`  ${reportCommand} --project-dir ${projectDirArg} ${report.runId}\n`);
}

function writeReport(report: KtxScanReport, io: KtxCliIo): void {
  io.stdout.write('KTX scan report\n');
  writeHumanReportBody(report, io);
}

function formatRelationshipEndpoint(edge: KtxRelationshipArtifactEdge, side: 'from' | 'to'): string {
  const endpoint = edge[side];
  if (endpoint.columns.length === 1) {
    return `${endpoint.table.name}.${endpoint.columns[0]}`;
  }
  return `${endpoint.table.name}.(${endpoint.columns.join(',')})`;
}

function formatRelationshipScore(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function relationshipStatusTitle(status: Exclude<KtxRelationshipArtifactStatus, 'all'>): string {
  if (status === 'accepted') {
    return 'Accepted relationships';
  }
  if (status === 'review') {
    return 'Review relationships';
  }
  if (status === 'rejected') {
    return 'Rejected relationships';
  }
  return 'Skipped relationships';
}

function filteredRelationshipArtifact(
  relationships: KtxRelationshipArtifact,
  status: KtxRelationshipArtifactStatus,
): KtxRelationshipArtifact {
  if (status === 'all') {
    return relationships;
  }
  return {
    connectionId: relationships.connectionId,
    accepted: status === 'accepted' ? relationships.accepted : [],
    review: status === 'review' ? relationships.review : [],
    rejected: status === 'rejected' ? relationships.rejected : [],
    skipped: status === 'skipped' ? relationships.skipped : [],
  };
}

function writeRelationshipEdge(edge: KtxRelationshipArtifactEdge, index: number, io: KtxCliIo): void {
  io.stdout.write(
    `  ${index + 1}. ${formatRelationshipEndpoint(edge, 'from')} -> ${formatRelationshipEndpoint(edge, 'to')}\n`,
  );
  io.stdout.write(
    `     type=${edge.relationshipType} source=${edge.source} confidence=${edge.confidence.toFixed(2)} pkScore=${formatRelationshipScore(edge.pkScore)} fkScore=${formatRelationshipScore(edge.fkScore)}\n`,
  );
  io.stdout.write(`     reasons=${edge.reasons.length > 0 ? edge.reasons.join(', ') : 'none'}\n`);
}

function writeRelationshipGroup(
  status: Exclude<KtxRelationshipArtifactStatus, 'all'>,
  relationships: KtxRelationshipArtifact,
  limit: number,
  io: KtxCliIo,
): void {
  if (status === 'skipped') {
    io.stdout.write(`\n${relationshipStatusTitle(status)} (${relationships.skipped.length})\n`);
    relationships.skipped.slice(0, limit).forEach((item, index) => {
      io.stdout.write(`  ${index + 1}. ${item.relationshipId}\n`);
      io.stdout.write(`     reason=${item.reason}\n`);
    });
    return;
  }

  const edges =
    status === 'accepted'
      ? relationships.accepted
      : status === 'review'
        ? relationships.review
        : relationships.rejected;
  io.stdout.write(`\n${relationshipStatusTitle(status)} (${edges.length})\n`);
  edges.slice(0, limit).forEach((edge, index) => {
    writeRelationshipEdge(edge, index, io);
  });
  if (edges.length > limit) {
    io.stdout.write(`  ${edges.length - limit} more not shown; rerun with --limit ${edges.length}\n`);
  }
}

function writeRelationshipArtifactSummary(input: {
  runId: string;
  connectionId: string;
  syncId: string;
  status: KtxRelationshipArtifactStatus;
  limit: number;
  summary: KtxRelationshipArtifact;
  relationships: KtxRelationshipArtifact;
  diagnostics: KtxRelationshipDiagnosticsArtifact | null;
  relationshipsPath: string;
  io: KtxCliIo;
}): void {
  input.io.stdout.write('KTX relationship artifacts\n');
  input.io.stdout.write(`Run: ${input.runId}\n`);
  input.io.stdout.write(`Connection: ${input.connectionId}\n`);
  input.io.stdout.write(`Sync: ${input.syncId}\n`);
  input.io.stdout.write(
    `Summary: accepted=${input.summary.accepted.length} review=${input.summary.review.length} rejected=${input.summary.rejected.length} skipped=${input.summary.skipped.length}\n`,
  );
  if (input.diagnostics?.noAcceptedReason) {
    input.io.stdout.write(`Reason: ${input.diagnostics.noAcceptedReason}\n`);
  }
  input.io.stdout.write(`Artifacts: ${input.relationshipsPath}\n`);

  const statuses: Array<Exclude<KtxRelationshipArtifactStatus, 'all'>> =
    input.status === 'all' ? ['accepted', 'review', 'rejected', 'skipped'] : [input.status];
  for (const status of statuses) {
    writeRelationshipGroup(status, input.relationships, input.limit, input.io);
  }
}

function writeRelationshipDecisionResult(result: WriteLocalScanRelationshipReviewDecisionResult, io: KtxCliIo): void {
  io.stdout.write('Recorded relationship decision\n');
  io.stdout.write(`Decision: ${result.decision.decision}\n`);
  io.stdout.write(`Candidate: ${result.decision.candidateId}\n`);
  io.stdout.write(`Previous status: ${result.decision.previousStatus}\n`);
  io.stdout.write(`Reviewer: ${result.decision.reviewer}\n`);
  if (result.decision.note) {
    io.stdout.write(`Note: ${result.decision.note}\n`);
  }
  io.stdout.write(`Path: ${result.path}\n`);
}

function writeRelationshipApplyResult(result: ApplyLocalScanRelationshipReviewDecisionsResult, io: KtxCliIo): void {
  io.stdout.write('Relationship review apply\n');
  io.stdout.write(`Run: ${result.runId}\n`);
  io.stdout.write(`Connection: ${result.connectionId}\n`);
  io.stdout.write(`Sync: ${result.syncId}\n`);
  io.stdout.write(`Mode: ${result.dryRun ? 'dry-run' : 'write'}\n`);
  io.stdout.write(`Decisions: ${result.selectedDecisions} ${plural(result.selectedDecisions, 'accepted decision')}\n`);
  io.stdout.write(
    `Applied: ${result.appliedRelationships} manual ${plural(result.appliedRelationships, 'relationship')}\n`,
  );
  io.stdout.write(`Schema shards written: ${result.manifestShardsWritten}\n`);
  if (result.manifestShards.length > 0) {
    io.stdout.write('Schema shards:\n');
    for (const shard of result.manifestShards) {
      io.stdout.write(`  - ${shard}\n`);
    }
  }
  io.stdout.write(`Decisions: ${result.decisionsPath}\n`);
}

function formatFeedbackColumns(columns: readonly string[]): string {
  return columns.length === 1 ? (columns[0] ?? 'unknown') : `(${columns.join(',')})`;
}

function feedbackTableShortName(value: string): string {
  return value.split('.').at(-1) ?? value;
}

function feedbackEndpoint(label: KtxRelationshipFeedbackLabel, side: 'from' | 'to'): string {
  if (side === 'from') {
    return `${feedbackTableShortName(label.fromTable)}.${formatFeedbackColumns(label.fromColumns)}`;
  }
  return `${feedbackTableShortName(label.toTable)}.${formatFeedbackColumns(label.toColumns)}`;
}

function writeRelationshipFeedbackSummary(result: ExportLocalRelationshipFeedbackLabelsResult, io: KtxCliIo): void {
  io.stdout.write('KTX relationship feedback labels\n');
  io.stdout.write(`Generated: ${result.generatedAt}\n`);
  io.stdout.write(`Filter connection: ${result.filters.connectionId ?? 'all'}\n`);
  io.stdout.write(`Filter decision: ${result.filters.decision}\n`);
  io.stdout.write(`Total: ${result.summary.total}\n`);
  io.stdout.write(`Accepted: ${result.summary.accepted}\n`);
  io.stdout.write(`Rejected: ${result.summary.rejected}\n`);
  io.stdout.write(`Connections: ${result.summary.connections}\n`);
  io.stdout.write(`Runs: ${result.summary.runs}\n`);

  if (result.warnings.length > 0) {
    io.stdout.write('\nWarnings\n');
    for (const warning of result.warnings.slice(0, 5)) {
      io.stdout.write(`  - ${warning.path}: ${warning.message}\n`);
    }
  }

  if (result.labels.length === 0) {
    return;
  }

  io.stdout.write('\nLabels\n');
  for (const label of result.labels.slice(0, 25)) {
    io.stdout.write(`  - ${feedbackEndpoint(label, 'from')} -> ${feedbackEndpoint(label, 'to')}\n`);
    io.stdout.write(
      `    decision=${label.decision} previous=${label.previousStatus} score=${formatRelationshipScore(label.score)} reviewer=${label.reviewer}\n`,
    );
  }
  if (result.labels.length > 25) {
    io.stdout.write(`  ${result.labels.length - 25} more labels not shown; rerun with --jsonl for the full dataset\n`);
  }
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

function writeStatus(status: LocalScanStatusResponse, io: KtxCliIo): void {
  io.stdout.write(`Run: ${status.runId}\n`);
  io.stdout.write(`Status: ${status.status}\n`);
  io.stdout.write(`Connection: ${status.connectionId}\n`);
  io.stdout.write(`Mode: ${status.mode}\n`);
  io.stdout.write(`Sync: ${status.syncId}\n`);
  io.stdout.write(`Progress: ${status.progress}\n`);
  io.stdout.write(`Report: ${status.reportPath ?? 'none'}\n`);
}

export async function runKtxScan(args: KtxScanArgs, io: KtxCliIo = process, deps: KtxScanDeps = {}): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'status') {
      const status = await (deps.getLocalScanStatus ?? getLocalScanStatus)(project, args.runId);
      if (!status) {
        throw new Error(`Scan run "${args.runId}" was not found`);
      }
      writeStatus(status, io);
      return 0;
    }
    if (args.command === 'report') {
      const report = await (deps.getLocalScanReport ?? getLocalScanReport)(project, args.runId);
      if (!report) {
        throw new Error(`Scan report "${args.runId}" was not found`);
      }
      if (args.json) {
        io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        writeReport(report, io);
      }
      return 0;
    }
    if (args.command === 'relationships') {
      const result = await (deps.readLocalScanRelationshipArtifacts ?? readLocalScanRelationshipArtifacts)(
        project,
        args.runId,
      );
      if (!result) {
        throw new Error(`Scan run "${args.runId}" was not found`);
      }
      const filtered = filteredRelationshipArtifact(result.relationships, args.status);
      if (args.json) {
        io.stdout.write(
          `${JSON.stringify(
            {
              runId: result.runId,
              connectionId: result.connectionId,
              syncId: result.syncId,
              status: args.status,
              paths: result.paths,
              diagnostics: result.diagnostics,
              summary: {
                accepted: result.relationships.accepted.length,
                review: result.relationships.review.length,
                rejected: result.relationships.rejected.length,
                skipped: result.relationships.skipped.length,
              },
              relationships: filtered,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        writeRelationshipArtifactSummary({
          runId: result.runId,
          connectionId: result.connectionId,
          syncId: result.syncId,
          status: args.status,
          limit: args.limit,
          summary: result.relationships,
          relationships: filtered,
          diagnostics: result.diagnostics,
          relationshipsPath: result.paths.relationships,
          io,
        });
      }
      return 0;
    }
    if (args.command === 'relationshipDecision') {
      const result = await (deps.writeLocalScanRelationshipReviewDecision ?? writeLocalScanRelationshipReviewDecision)(
        project,
        {
          runId: args.runId,
          candidateId: args.candidateId,
          decision: args.decision,
          reviewer: args.reviewer,
          note: args.note,
        },
      );
      if (!result) {
        throw new Error(`Scan run "${args.runId}" was not found`);
      }
      if (args.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        writeRelationshipDecisionResult(result, io);
      }
      return 0;
    }
    if (args.command === 'relationshipApply') {
      const result = await (
        deps.applyLocalScanRelationshipReviewDecisions ?? applyLocalScanRelationshipReviewDecisions
      )(project, {
        runId: args.runId,
        applyAllAccepted: args.applyAllAccepted,
        candidateIds: args.candidateIds,
        dryRun: args.dryRun,
      });
      if (args.json) {
        io.stdout.write(
          `${JSON.stringify(result satisfies ApplyLocalScanRelationshipReviewDecisionsResult, null, 2)}\n`,
        );
      } else {
        writeRelationshipApplyResult(result, io);
      }
      return 0;
    }
    if (args.command === 'relationshipFeedback') {
      const result = await (deps.exportLocalRelationshipFeedbackLabels ?? exportLocalRelationshipFeedbackLabels)(
        project,
        {
          connectionId: args.connectionId,
          decision: args.decision,
        },
      );
      if (args.jsonl) {
        io.stdout.write(
          (deps.formatKtxRelationshipFeedbackLabelsJsonl ?? formatKtxRelationshipFeedbackLabelsJsonl)(result),
        );
      } else if (args.json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        writeRelationshipFeedbackSummary(result, io);
      }
      return 0;
    }
    if (args.command === 'relationshipCalibration') {
      const result = await (deps.calibrateLocalRelationshipFeedbackLabels ?? calibrateLocalRelationshipFeedbackLabels)(
        project,
        {
          connectionId: args.connectionId,
          decision: args.decision,
          acceptThreshold: args.acceptThreshold,
          reviewThreshold: args.reviewThreshold,
        },
      );
      if (args.json) {
        io.stdout.write(`${JSON.stringify(result satisfies KtxRelationshipFeedbackCalibrationReport, null, 2)}\n`);
      } else {
        io.stdout.write(
          (deps.formatKtxRelationshipFeedbackCalibrationMarkdown ?? formatKtxRelationshipFeedbackCalibrationMarkdown)(
            result,
          ),
        );
      }
      return 0;
    }
    if (args.command === 'relationshipThresholds') {
      const result = await (
        deps.adviseLocalRelationshipFeedbackThresholds ?? adviseLocalRelationshipFeedbackThresholds
      )(project, {
        connectionId: args.connectionId,
        minTotalLabels: args.minTotalLabels,
        minAcceptedLabels: args.minAcceptedLabels,
        minRejectedLabels: args.minRejectedLabels,
      });
      if (args.json) {
        io.stdout.write(`${JSON.stringify(result satisfies KtxRelationshipThresholdAdviceReport, null, 2)}\n`);
      } else {
        io.stdout.write(
          (deps.formatKtxRelationshipThresholdAdviceMarkdown ?? formatKtxRelationshipThresholdAdviceMarkdown)(result),
        );
      }
      return 0;
    }

    const managedDaemon = managedDaemonOptionsForScanRun(args, io);
    const connector =
      args.mode !== 'structural' || args.detectRelationships
        ? await createKtxCliScanConnector(project, args.connectionId)
        : undefined;
    const progress = createCliScanProgress(io);
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
        progress,
      });
      progress.flush();
      writeRunSummary(result.report, args.projectDir, io);
    } finally {
      progress.flush();
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
