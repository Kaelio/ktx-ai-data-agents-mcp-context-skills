import { type KtxLocalProject, type KtxProjectConnectionConfig, loadKtxProject } from '@ktx/context/project';
import type { KtxProgressPort } from '@ktx/context/scan';
import type { KtxCliIo } from './index.js';
import type { KtxIngestArgs, KtxIngestDeps, KtxIngestProgressUpdate } from './ingest.js';
import {
  type KtxDatabaseContextDepth,
  databaseContextDepth,
  deepReadinessGaps,
  isDatabaseDriver,
  normalizeConnectionDriver,
} from './ingest-depth.js';
import type { KtxScanArgs, KtxScanDeps } from './scan.js';
import { profileMark } from './startup-profile.js';

profileMark('module:public-ingest');

type KtxPublicIngestStepName = 'database-schema' | 'query-history' | 'source-ingest' | 'memory-update';
type KtxPublicIngestStepStatus = 'done' | 'skipped' | 'failed' | 'not-run';
type KtxPublicIngestInputMode = 'auto' | 'disabled';
type KtxPublicIngestDepth = KtxDatabaseContextDepth;
type KtxPublicIngestQueryHistoryFlag = 'default' | 'enabled' | 'disabled';
type HistoricSqlDialect = 'postgres' | 'bigquery' | 'snowflake';

export type KtxPublicIngestArgs =
  | {
      command: 'run';
      projectDir: string;
      targetConnectionId?: string;
      all: boolean;
      json: boolean;
      inputMode: KtxPublicIngestInputMode;
      depth?: KtxPublicIngestDepth;
      queryHistory?: KtxPublicIngestQueryHistoryFlag;
      queryHistoryWindowDays?: number;
      scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
      detectRelationships?: boolean;
    }
  | {
      command: 'status' | 'watch';
      projectDir: string;
      runId?: string;
      json: boolean;
      inputMode: KtxPublicIngestInputMode;
    };

export interface KtxPublicIngestPlanTarget {
  connectionId: string;
  driver: string;
  operation: 'database-ingest' | 'source-ingest';
  adapter?: string;
  sourceDir?: string;
  debugCommand: string;
  steps: KtxPublicIngestStepName[];
  databaseDepth?: KtxPublicIngestDepth;
  detectRelationships?: boolean;
  preflightFailure?: string;
  queryHistory?: {
    enabled: boolean;
    dialect?: HistoricSqlDialect;
    windowDays?: number;
    unsupported?: boolean;
    skippedStoredByFast?: boolean;
  };
}

export interface KtxPublicIngestPlan {
  projectDir: string;
  targets: KtxPublicIngestPlanTarget[];
  warnings: string[];
}

export interface KtxPublicIngestTargetResult {
  connectionId: string;
  driver: string;
  steps: Array<{
    operation: KtxPublicIngestStepName;
    status: KtxPublicIngestStepStatus;
    detail?: string;
    debugCommand?: string;
  }>;
}

export type KtxPublicIngestProject = Pick<KtxLocalProject, 'projectDir' | 'config'>;

export interface KtxPublicIngestDeps {
  loadProject?: (options: Parameters<typeof loadKtxProject>[0]) => Promise<KtxPublicIngestProject>;
  runScan?: (args: KtxScanArgs, io: KtxCliIo, deps?: KtxScanDeps) => Promise<number>;
  runIngest?: (args: KtxIngestArgs, io: KtxCliIo, deps?: KtxIngestDeps) => Promise<number>;
  scanProgress?: KtxProgressPort;
  ingestProgress?: (update: KtxIngestProgressUpdate) => void;
}

const sourceAdapterByDriver = new Map<string, string>([
  ['metabase', 'metabase'],
  ['local_metabase', 'metabase'],
  ['looker', 'looker'],
  ['local_looker', 'looker'],
  ['notion', 'notion'],
  ['metricflow', 'metricflow'],
  ['dbt', 'dbt'],
  ['lookml', 'lookml'],
]);

const queryHistoryDialectByDriver = new Map<string, HistoricSqlDialect>([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['bigquery', 'bigquery'],
  ['snowflake', 'snowflake'],
]);

interface KtxPublicIngestWarningAccumulator {
  warnings: string[];
  ignoredDepthForSources: string[];
  ignoredQueryHistoryForSources: string[];
}

function createWarningAccumulator(): KtxPublicIngestWarningAccumulator {
  return {
    warnings: [],
    ignoredDepthForSources: [],
    ignoredQueryHistoryForSources: [],
  };
}

function sourceIgnoredWarning(option: string, connectionIds: string[], all: boolean): string | null {
  if (connectionIds.length === 0) {
    return null;
  }
  if (all) {
    const sourceLabel =
      connectionIds.length === 1 ? '1 non-database source' : `${connectionIds.length} non-database sources`;
    return `${option} ignored for ${sourceLabel}.`;
  }
  return `${option} affects database ingest only; ignoring it for ${connectionIds[0]}.`;
}

function finalizeWarnings(
  accumulator: KtxPublicIngestWarningAccumulator,
  args: {
    all: boolean;
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
  },
): string[] {
  const warnings = [...accumulator.warnings];
  const depthOption = args.depth ? `--${args.depth}` : null;
  if (depthOption) {
    const warning = sourceIgnoredWarning(depthOption, accumulator.ignoredDepthForSources, args.all);
    if (warning) warnings.push(warning);
  }
  if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
    const warning = sourceIgnoredWarning('--query-history', accumulator.ignoredQueryHistoryForSources, args.all);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

function storedQueryHistory(connection: KtxProjectConnectionConfig): Record<string, unknown> {
  const context = connection.context;
  const contextRecord =
    context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
  const value = contextRecord.queryHistory;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function depthFromLegacyScanMode(
  mode: Extract<KtxScanArgs, { command: 'run' }>['mode'] | undefined,
): KtxPublicIngestDepth | undefined {
  return mode === 'enriched' || mode === 'relationships' ? 'deep' : undefined;
}

function sourceDirForConnection(connection: KtxProjectConnectionConfig): string | undefined {
  const value = connection.source_dir;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveDatabaseTargetOptions(input: {
  connectionId: string;
  driver: string;
  connection: KtxProjectConnectionConfig;
  args: {
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  };
  warnings: string[];
}): Pick<KtxPublicIngestPlanTarget, 'databaseDepth' | 'queryHistory' | 'steps'> {
  const storedQh = storedQueryHistory(input.connection);
  const dialect = queryHistoryDialectByDriver.get(input.driver);
  const explicitQueryHistory = input.args.queryHistory ?? 'default';
  const storedEnabled = storedQh.enabled === true;
  const windowOverrideRequested = input.args.queryHistoryWindowDays !== undefined;
  const requestedQh =
    explicitQueryHistory === 'enabled' ||
    (explicitQueryHistory !== 'disabled' && (windowOverrideRequested || storedEnabled));
  let depth =
    input.args.depth ?? depthFromLegacyScanMode(input.args.scanMode) ?? databaseContextDepth(input.connection) ?? 'fast';
  const queryHistory = {
    enabled: false,
    ...(input.args.queryHistoryWindowDays !== undefined
      ? { windowDays: input.args.queryHistoryWindowDays }
      : positiveInteger(storedQh.windowDays) !== undefined
        ? { windowDays: positiveInteger(storedQh.windowDays) }
        : {}),
  };

  if (requestedQh && !dialect) {
    input.warnings.push(
      explicitQueryHistory === 'enabled' || input.args.queryHistoryWindowDays !== undefined
        ? `--query-history is not supported for ${input.driver}; running schema ingest for ${input.connectionId}.`
        : `${input.connectionId} has query history enabled in ktx.yaml, but ${input.driver} does not support it; running schema ingest.`,
    );
    return {
      databaseDepth: depth,
      queryHistory: { ...queryHistory, unsupported: true },
      steps: ['database-schema'],
    };
  }

  if (requestedQh && dialect) {
    if (depth === 'fast') {
      input.warnings.push(`--query-history requires deep ingest; running ${input.connectionId} with --deep.`);
    }
    depth = 'deep';
    return {
      databaseDepth: depth,
      queryHistory: { ...queryHistory, enabled: true, dialect },
      steps: ['database-schema', 'query-history'],
    };
  }

  if (input.args.depth === 'fast' && explicitQueryHistory !== 'enabled' && storedEnabled) {
    input.warnings.push(
      `${input.connectionId} has query history enabled in ktx.yaml, but --fast skips query-history processing.`,
    );
    return {
      databaseDepth: 'fast',
      queryHistory: { ...queryHistory, skippedStoredByFast: true },
      steps: ['database-schema'],
    };
  }

  return {
    databaseDepth: depth,
    queryHistory,
    steps: ['database-schema'],
  };
}

function targetForConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
  projectConfig: KtxPublicIngestProject['config'],
  args: {
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  },
  warnings: KtxPublicIngestWarningAccumulator,
): KtxPublicIngestPlanTarget {
  const driver = normalizeConnectionDriver(connection);
  const adapter = sourceAdapterByDriver.get(driver);
  const sourceDir = sourceDirForConnection(connection);
  if (adapter) {
    if (args.depth) {
      warnings.ignoredDepthForSources.push(connectionId);
    }
    if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
      warnings.ignoredQueryHistoryForSources.push(connectionId);
    }
    return {
      connectionId,
      driver,
      operation: 'source-ingest',
      adapter,
      ...(sourceDir ? { sourceDir } : {}),
      debugCommand: `ktx ingest ${connectionId} --debug`,
      steps: ['source-ingest', 'memory-update'],
    };
  }

  if (isDatabaseDriver(driver)) {
    const options = resolveDatabaseTargetOptions({ connectionId, driver, connection, args, warnings: warnings.warnings });
    const gaps = options.databaseDepth === 'deep' ? deepReadinessGaps(projectConfig) : [];
    return {
      connectionId,
      driver,
      operation: 'database-ingest',
      debugCommand: `ktx ingest ${connectionId} --debug`,
      detectRelationships: options.databaseDepth === 'deep' && projectConfig.scan.relationships.enabled,
      ...(gaps.length > 0
        ? {
            preflightFailure: `${connectionId} requires deep ingest readiness: ${gaps.join(
              ', ',
            )}. Run ktx setup or rerun with --fast.`,
          }
        : {}),
      ...options,
    };
  }

  throw new Error(`Connection "${connectionId}" uses unsupported public ingest driver "${driver || 'unknown'}"`);
}

export function buildPublicIngestPlan(
  project: KtxPublicIngestProject,
  args: {
    projectDir: string;
    targetConnectionId?: string;
    all: boolean;
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  },
): KtxPublicIngestPlan {
  if (!args.all && !args.targetConnectionId) {
    throw new Error('Context build requires a connection id or all targets');
  }

  const entries = Object.entries(project.config.connections).sort(([a], [b]) => a.localeCompare(b));
  const selected = args.all ? entries : entries.filter(([connectionId]) => connectionId === args.targetConnectionId);

  if (!args.all && selected.length === 0) {
    throw new Error(`Connection "${args.targetConnectionId}" is not configured in ktx.yaml`);
  }
  if (selected.length === 0) {
    throw new Error('No configured connections are eligible for ingest');
  }

  const warnings = createWarningAccumulator();
  const targets = selected.map(([connectionId, connection]) =>
    targetForConnection(connectionId, connection, project.config, args, warnings),
  );
  return {
    projectDir: args.projectDir,
    targets: [
      ...targets.filter((t) => t.operation === 'database-ingest'),
      ...targets.filter((t) => t.operation === 'source-ingest'),
    ],
    warnings: finalizeWarnings(warnings, args),
  };
}

function defaultSteps(target: KtxPublicIngestPlanTarget): KtxPublicIngestTargetResult['steps'] {
  return [
    {
      operation: 'database-schema',
      status: target.steps.includes('database-schema') ? 'not-run' : 'skipped',
      ...(target.operation === 'database-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'query-history',
      status: target.steps.includes('query-history') ? 'not-run' : 'skipped',
      ...(target.operation === 'database-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'source-ingest',
      status: target.steps.includes('source-ingest') ? 'not-run' : 'skipped',
      ...(target.operation === 'source-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'memory-update',
      status: target.steps.includes('memory-update') ? 'not-run' : 'skipped',
      ...(target.operation === 'source-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
  ];
}

function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
  failureDetail?: string,
): KtxPublicIngestTargetResult {
  const selectedFailedOperation =
    failedOperation ?? (target.operation === 'database-ingest' ? 'database-schema' : 'source-ingest');
  return {
    connectionId: target.connectionId,
    driver: target.driver,
    steps: defaultSteps(target).map((step) => {
      if (!target.steps.includes(step.operation)) {
        return step;
      }
      if (status === 'done') {
        return { ...step, status: 'done' };
      }
      if (step.operation === selectedFailedOperation) {
        return {
          ...step,
          status: 'failed',
          detail: failureDetail ?? `${target.connectionId} failed at ${selectedFailedOperation}.`,
        };
      }
      return { ...step, status: 'not-run' };
    }),
  };
}

function resultFailed(result: KtxPublicIngestTargetResult): boolean {
  return result.steps.some((step) => step.status === 'failed');
}

function stepStatus(result: KtxPublicIngestTargetResult, operation: KtxPublicIngestStepName): string {
  return result.steps.find((step) => step.operation === operation)?.status ?? 'not-run';
}

function renderPlainResults(results: KtxPublicIngestTargetResult[], io: KtxCliIo): void {
  const failures = results.filter(resultFailed);
  io.stdout.write(failures.length > 0 ? 'Ingest finished with partial failures\n' : 'Ingest finished\n');
  io.stdout.write('\n');
  io.stdout.write('Source         Database schema  Query history  Source ingest  Memory update\n');
  for (const result of results) {
    io.stdout.write(
      `${result.connectionId.padEnd(14)} ${stepStatus(result, 'database-schema').padEnd(16)} ${stepStatus(
        result,
        'query-history',
      ).padEnd(14)} ${stepStatus(
        result,
        'source-ingest',
      ).padEnd(14)} ${stepStatus(result, 'memory-update')}\n`,
    );
  }

  if (failures.length === 0) {
    return;
  }

  io.stdout.write('\nFailed sources:\n');
  for (const result of failures) {
    const failedStep = result.steps.find((step) => step.status === 'failed');
    if (!failedStep) {
      continue;
    }
    io.stdout.write(`  ${failedStep.detail ?? `${result.connectionId} failed.`}\n`);
    if (failedStep.debugCommand) {
      io.stdout.write(`  Debug: ${failedStep.debugCommand}\n`);
    }
  }
}

function hasInteractiveInput(io: KtxCliIo): boolean {
  const stdin = (io as { stdin?: { isTTY?: boolean; setRawMode?: (value: boolean) => void } }).stdin;
  return stdin?.isTTY === true && typeof stdin.setRawMode === 'function';
}

function sourceIngestOutputMode(args: Extract<KtxPublicIngestArgs, { command: 'run' }>, io: KtxCliIo): 'plain' | 'viz' {
  return args.inputMode === 'auto' && io.stdout.isTTY === true && hasInteractiveInput(io) ? 'viz' : 'plain';
}

interface CapturedPublicIngestIo extends KtxCliIo {
  capturedOutput(): string;
}

function createCapturedPublicIngestIo(): CapturedPublicIngestIo {
  let output = '';
  return {
    stdout: {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        output += chunk;
      },
    },
    capturedOutput() {
      return output;
    },
  };
}

function firstCapturedFailureLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('KTX scan completed'));
}

export async function executePublicIngestTarget(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps,
): Promise<KtxPublicIngestTargetResult> {
  if (target.preflightFailure) {
    return {
      connectionId: target.connectionId,
      driver: target.driver,
      steps: defaultSteps(target).map((step) =>
        step.operation === 'database-schema'
          ? {
              ...step,
              status: 'failed',
              detail: target.preflightFailure,
            }
          : step,
      ),
    };
  }

  if (target.operation === 'database-ingest') {
    const { runKtxScan } = await import('./scan.js');
    const scanArgs: KtxScanArgs = {
      command: 'run',
      projectDir: args.projectDir,
      connectionId: target.connectionId,
      mode: target.databaseDepth === 'deep' ? 'enriched' : 'structural',
      detectRelationships: target.detectRelationships === true,
      dryRun: false,
    };
    const runScan = deps.runScan ?? runKtxScan;
    const capturedScanIo = deps.scanProgress ? null : createCapturedPublicIngestIo();
    const scanIo = capturedScanIo ?? io;
    const scanExitCode = deps.scanProgress
      ? await runScan(scanArgs, scanIo, { progress: deps.scanProgress })
      : await runScan(scanArgs, scanIo);
    if (scanExitCode !== 0) {
      return markTargetResult(
        target,
        'failed',
        'database-schema',
        capturedScanIo ? firstCapturedFailureLine(capturedScanIo.capturedOutput()) : undefined,
      );
    }

    if (target.queryHistory?.enabled === true) {
      const { runKtxIngest } = await import('./ingest.js');
      const runIngest = deps.runIngest ?? runKtxIngest;
      const ingestArgs: KtxIngestArgs = {
        command: 'run',
        projectDir: args.projectDir,
        connectionId: target.connectionId,
        adapter: 'historic-sql',
        outputMode: sourceIngestOutputMode(args, io),
        inputMode: args.inputMode,
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride: {
          dialect: target.queryHistory.dialect,
          ...(target.queryHistory.windowDays !== undefined ? { windowDays: target.queryHistory.windowDays } : {}),
        },
      };
      const qhExitCode = await runIngest(ingestArgs, io);
      if (qhExitCode !== 0) {
        return markTargetResult(target, 'failed', 'query-history');
      }
    }

    return markTargetResult(target, 'done');
  }

  const { runKtxIngest } = await import('./ingest.js');
  const ingestArgs: KtxIngestArgs = {
    command: 'run',
    projectDir: args.projectDir,
    connectionId: target.connectionId,
    adapter: target.adapter ?? target.driver,
    ...(target.sourceDir ? { sourceDir: target.sourceDir } : {}),
    outputMode: sourceIngestOutputMode(args, io),
    inputMode: args.inputMode,
    allowImplicitAdapter: true,
  };
  const runIngest = deps.runIngest ?? runKtxIngest;
  const exitCode = deps.ingestProgress
    ? await runIngest(ingestArgs, io, { progress: deps.ingestProgress })
    : await runIngest(ingestArgs, io);
  return markTargetResult(target, exitCode === 0 ? 'done' : 'failed');
}

export async function runKtxPublicIngest(
  args: KtxPublicIngestArgs,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps = {},
): Promise<number> {
  if (args.command !== 'run') {
    const { runKtxIngest } = await import('./ingest.js');
    return await (deps.runIngest ?? runKtxIngest)(
      {
        command: args.command,
        projectDir: args.projectDir,
        ...(args.runId ? { runId: args.runId } : {}),
        outputMode: args.json ? 'json' : args.command === 'watch' ? 'viz' : 'plain',
        inputMode: args.inputMode,
      },
      io,
    );
  }

  const loadProject = deps.loadProject ?? loadKtxProject;
  const project = await loadProject({ projectDir: args.projectDir });
  const plan = buildPublicIngestPlan(project, args);
  const results: KtxPublicIngestTargetResult[] = [];

  if (!args.json && plan.warnings.length > 0) {
    for (const warning of plan.warnings) {
      io.stderr.write(`Warning: ${warning}\n`);
    }
  }

  for (const target of plan.targets) {
    results.push(await executePublicIngestTarget(target, args, io, deps));
  }

  if (args.json) {
    io.stdout.write(`${JSON.stringify({ plan, results }, null, 2)}\n`);
  } else {
    renderPlainResults(results, io);
  }

  return results.some(resultFailed) ? 1 : 0;
}
