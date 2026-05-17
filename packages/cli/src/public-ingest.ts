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
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import type { KtxRuntimeFeature } from './managed-python-runtime.js';
import { publicIngestOutputLine } from './public-ingest-copy.js';
import { resolvePublicIngestRuntimeRequirements } from './runtime-requirements.js';
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
  {
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
    cliVersion?: string;
    runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
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
    pullConfig?: Record<string, unknown>;
    unsupported?: boolean;
    skippedStoredByFast?: boolean;
  };
}

export interface KtxPublicIngestPlan {
  projectDir: string;
  targets: KtxPublicIngestPlanTarget[];
  warnings: string[];
  notices?: string[];
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

type KtxPublicIngestPhaseKey = 'database-schema' | 'query-history' | 'source-ingest';

export interface KtxPublicIngestDeps {
  loadProject?: (options: Parameters<typeof loadKtxProject>[0]) => Promise<KtxPublicIngestProject>;
  runScan?: (args: KtxScanArgs, io: KtxCliIo, deps?: KtxScanDeps) => Promise<number>;
  runIngest?: (args: KtxIngestArgs, io: KtxCliIo, deps?: KtxIngestDeps) => Promise<number>;
  runContextBuild?: (
    project: KtxPublicIngestProject,
    args: KtxPublicContextBuildArgs,
    io: KtxCliIo,
  ) => Promise<{ exitCode: number }>;
  scanProgress?: KtxProgressPort;
  ingestProgress?: (update: KtxIngestProgressUpdate) => void;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: KtxRuntimeFeature;
  }) => Promise<ManagedPythonCommandRuntime>;
  env?: NodeJS.ProcessEnv;
  runtimeIo?: KtxCliIo;
  onPhaseStart?: (phaseKey: KtxPublicIngestPhaseKey) => void;
  onPhaseEnd?: (phaseKey: KtxPublicIngestPhaseKey, status: 'done' | 'failed' | 'skipped', summary?: string) => void;
}

interface KtxPublicContextBuildArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  targetConnectionId?: string;
  all?: boolean;
  depth?: KtxPublicIngestDepth;
  queryHistory?: KtxPublicIngestQueryHistoryFlag;
  queryHistoryWindowDays?: number;
  scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  detectRelationships?: boolean;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
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

interface KtxUnsupportedQueryHistoryWarning {
  connectionId: string;
  driver: string;
  reason: 'explicit' | 'stored';
}

interface KtxPublicIngestWarningAccumulator {
  warnings: string[];
  ignoredDepthForSources: string[];
  ignoredQueryHistoryForSources: string[];
  unsupportedQueryHistoryForDatabases: KtxUnsupportedQueryHistoryWarning[];
}

function createWarningAccumulator(): KtxPublicIngestWarningAccumulator {
  return {
    warnings: [],
    ignoredDepthForSources: [],
    ignoredQueryHistoryForSources: [],
    unsupportedQueryHistoryForDatabases: [],
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

function unsupportedDriverList(entries: KtxUnsupportedQueryHistoryWarning[]): string {
  return [...new Set(entries.map((entry) => entry.driver))]
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

function unsupportedQueryHistoryWarnings(
  entries: KtxUnsupportedQueryHistoryWarning[],
  all: boolean,
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const warnings: string[] = [];
  const explicitEntries = entries.filter((entry) => entry.reason === 'explicit');
  const storedEntries = entries.filter((entry) => entry.reason === 'stored');

  if (explicitEntries.length === 1 || (!all && explicitEntries.length > 0)) {
    warnings.push(
      ...explicitEntries.map(
        (entry) =>
          `--query-history is not supported for ${entry.driver}; running schema ingest for ${entry.connectionId}.`,
      ),
    );
  } else if (explicitEntries.length > 1) {
    warnings.push(
      `--query-history is not supported for ${explicitEntries.length} database connections (${unsupportedDriverList(
        explicitEntries,
      )}); running schema ingest for those connections.`,
    );
  }

  if (storedEntries.length === 1 || (!all && storedEntries.length > 0)) {
    warnings.push(
      ...storedEntries.map(
        (entry) =>
          `${entry.connectionId} has query history enabled in ktx.yaml, but ${entry.driver} does not support it; running schema ingest.`,
      ),
    );
  } else if (storedEntries.length > 1) {
    warnings.push(
      `${storedEntries.length} database connections have query history enabled in ktx.yaml, but their drivers do not support it; running schema ingest for those connections.`,
    );
  }

  return warnings;
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
  const warnings = [
    ...accumulator.warnings,
    ...unsupportedQueryHistoryWarnings(accumulator.unsupportedQueryHistoryForDatabases, args.all),
  ];
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

function schemaFirstQueryHistoryNotice(
  targets: KtxPublicIngestPlanTarget[],
  args: { queryHistory?: KtxPublicIngestQueryHistoryFlag },
): string | null {
  if (args.queryHistory !== 'enabled') {
    return null;
  }
  const queryHistoryTargets = targets.filter((target) => target.queryHistory?.enabled === true);
  if (queryHistoryTargets.length === 0) {
    return null;
  }
  if (queryHistoryTargets.length === 1) {
    return `Schema ingest runs before query history for ${queryHistoryTargets[0].connectionId}.`;
  }
  return `Schema ingest runs before query history for ${queryHistoryTargets.length} database connections.`;
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

function enabledTablesForConnection(connection: KtxProjectConnectionConfig): string[] | undefined {
  const raw = connection.enabled_tables;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tables = raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return tables.length > 0 ? tables : undefined;
}

function queryHistoryPullConfig(input: {
  stored: Record<string, unknown>;
  dialect: HistoricSqlDialect;
  windowDays?: number;
  enabledTables?: string[];
}): Record<string, unknown> {
  const { enabled: _enabled, dialect: _dialect, ...storedConfig } = input.stored;
  return {
    ...storedConfig,
    dialect: input.dialect,
    ...(input.enabledTables ? { enabledTables: input.enabledTables } : {}),
    ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
  };
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
  warnings: KtxPublicIngestWarningAccumulator;
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
    input.warnings.unsupportedQueryHistoryForDatabases.push({
      connectionId: input.connectionId,
      driver: input.driver,
      reason:
        explicitQueryHistory === 'enabled' || input.args.queryHistoryWindowDays !== undefined ? 'explicit' : 'stored',
    });
    return {
      databaseDepth: depth,
      queryHistory: { ...queryHistory, unsupported: true },
      steps: ['database-schema'],
    };
  }

  if (requestedQh && dialect) {
    if (depth === 'fast') {
      input.warnings.warnings.push(`--query-history requires deep ingest; running ${input.connectionId} with --deep.`);
    }
    depth = 'deep';
    return {
      databaseDepth: depth,
      queryHistory: {
        ...queryHistory,
        enabled: true,
        dialect,
        pullConfig: queryHistoryPullConfig({
          stored: storedQh,
          dialect,
          windowDays: queryHistory.windowDays,
          enabledTables: enabledTablesForConnection(input.connection),
        }),
      },
      steps: ['database-schema', 'query-history'],
    };
  }

  if (input.args.depth === 'fast' && explicitQueryHistory !== 'enabled' && storedEnabled) {
    input.warnings.warnings.push(
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
    const options = resolveDatabaseTargetOptions({ connectionId, driver, connection, args, warnings });
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
  const orderedTargets = [
    ...targets.filter((t) => t.operation === 'database-ingest'),
    ...targets.filter((t) => t.operation === 'source-ingest'),
  ];
  const notice = schemaFirstQueryHistoryNotice(orderedTargets, args);
  return {
    projectDir: args.projectDir,
    targets: orderedTargets,
    warnings: finalizeWarnings(warnings, args),
    ...(notice ? { notices: [notice] } : {}),
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

function retryCommandForTarget(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
): string {
  const projectPart = ` --project-dir ${args.projectDir}`;
  const depthPart = target.databaseDepth ? ` --${target.databaseDepth}` : '';
  const queryHistoryPart = target.queryHistory?.enabled === true ? ' --query-history' : '';
  const windowPart =
    target.queryHistory?.enabled === true && target.queryHistory.windowDays !== undefined
      ? ` --query-history-window-days ${target.queryHistory.windowDays}`
      : '';
  return `ktx ingest ${target.connectionId}${projectPart}${depthPart}${queryHistoryPart}${windowPart}`;
}

function trimTrailingPeriod(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

function failureDetailWithRetry(input: {
  target: KtxPublicIngestPlanTarget;
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>;
  failedOperation: KtxPublicIngestStepName;
  failureDetail?: string;
}): string {
  const detail = input.failureDetail?.trim();
  const base =
    detail && detail.startsWith(`${input.target.connectionId} `)
      ? detail
      : detail
        ? `${input.target.connectionId} failed: ${detail}`
        : `${input.target.connectionId} failed at ${input.failedOperation}.`;
  return `${trimTrailingPeriod(base)}. Retry: ${retryCommandForTarget(input.target, input.args)}`;
}

function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
  failureDetail?: string,
): KtxPublicIngestTargetResult {
  const selectedFailedOperation =
    failedOperation ?? (target.operation === 'database-ingest' ? 'database-schema' : 'source-ingest');
  const selectedFailedOperationIndex = target.steps.indexOf(selectedFailedOperation);
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
      const stepIndex = target.steps.indexOf(step.operation);
      if (selectedFailedOperationIndex >= 0 && stepIndex >= 0 && stepIndex < selectedFailedOperationIndex) {
        return { ...step, status: 'done' };
      }
      if (step.operation === selectedFailedOperation) {
        return {
          ...step,
          status: 'failed',
          detail: failureDetailWithRetry({
            target,
            args,
            failedOperation: selectedFailedOperation,
            failureDetail,
          }),
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
  }
}

function hasInteractiveInput(io: KtxCliIo): boolean {
  const stdin = (io as { stdin?: { isTTY?: boolean; setRawMode?: (value: boolean) => void } }).stdin;
  return stdin?.isTTY === true && typeof stdin.setRawMode === 'function';
}

function sourceIngestOutputMode(args: Extract<KtxPublicIngestArgs, { command: 'run' }>, io: KtxCliIo): 'plain' | 'viz' {
  return args.inputMode === 'auto' && io.stdout.isTTY === true && hasInteractiveInput(io) ? 'viz' : 'plain';
}

function shouldUseForegroundContextBuildView(
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
): boolean {
  return args.inputMode === 'auto' && args.json !== true && io.stdout.isTTY === true && hasInteractiveInput(io);
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

const INTERNAL_STATUS_LINE_RE =
  /^(Report|Run|Job|Status|Adapter|Connection|Sync|Diff|Tasks|Work units|Failed tasks|Saved memory|Provenance rows):\s*/;
const ACTIONABLE_FAILURE_LINE_RE =
  /^(Missing bundled Python runtime manifest|KTX Python runtime is required|KTX managed daemon|Error:|Failed\b|Could not\b|Cannot\b)/;
const RUNTIME_BACKED_RETRY_LINE_RE = /^Then retry the runtime-backed KTX command\.?$/;

function trimErrorPrefix(line: string): string {
  return line.replace(/^Error:\s*/, '');
}

function capturedFailureMessage(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('KTX scan completed'))
    .filter((line) => !INTERNAL_STATUS_LINE_RE.test(line))
    .map(publicIngestOutputLine);

  const actionableIndex = lines.findIndex((line) => ACTIONABLE_FAILURE_LINE_RE.test(line));
  if (actionableIndex < 0) {
    const line = lines.find((candidate) => candidate.length > 0);
    return line ? trimErrorPrefix(line) : undefined;
  }

  const firstLine = lines[actionableIndex];
  if (!firstLine?.startsWith('Missing bundled Python runtime manifest')) {
    return trimErrorPrefix(firstLine);
  }

  const followupLines = lines
    .slice(actionableIndex + 1)
    .filter((line) => !RUNTIME_BACKED_RETRY_LINE_RE.test(line))
    .filter((line) => !/\bRetry:\s/.test(line))
    .filter((line) => line.startsWith('In a source checkout, build the local runtime assets with:'));
  return [firstLine, ...followupLines].join('\n');
}

export async function executePublicIngestTarget(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps,
): Promise<KtxPublicIngestTargetResult> {
  if (target.preflightFailure) {
    if (target.operation === 'database-ingest') {
      deps.onPhaseEnd?.('database-schema', 'failed', target.preflightFailure);
      if (target.queryHistory?.enabled === true) {
        deps.onPhaseEnd?.('query-history', 'skipped');
      }
    } else {
      deps.onPhaseEnd?.('source-ingest', 'failed', target.preflightFailure);
    }
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
      ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
      ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
    };
    const runScan = deps.runScan ?? runKtxScan;
    const capturedScanIo = deps.scanProgress ? null : createCapturedPublicIngestIo();
    const scanIo = capturedScanIo ?? io;
    const scanDeps = {
      ...(deps.scanProgress ? { progress: deps.scanProgress } : {}),
      ...(deps.runtimeIo ? { runtimeIo: deps.runtimeIo } : {}),
    };
    deps.onPhaseStart?.('database-schema');
    const scanExitCode =
      Object.keys(scanDeps).length > 0 ? await runScan(scanArgs, scanIo, scanDeps) : await runScan(scanArgs, scanIo);
    if (scanExitCode !== 0) {
      deps.onPhaseEnd?.('database-schema', 'failed');
      if (target.queryHistory?.enabled === true) {
        deps.onPhaseEnd?.('query-history', 'skipped');
      }
      return markTargetResult(
        target,
        args,
        'failed',
        'database-schema',
        capturedScanIo ? capturedFailureMessage(capturedScanIo.capturedOutput()) : undefined,
      );
    }
    deps.onPhaseEnd?.('database-schema', 'done');

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
        ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
        ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride:
          target.queryHistory.pullConfig ?? {
            dialect: target.queryHistory.dialect,
            ...(target.queryHistory.windowDays !== undefined ? { windowDays: target.queryHistory.windowDays } : {}),
          },
      };
      const capturedIngestIo = deps.ingestProgress ? null : createCapturedPublicIngestIo();
      const ingestIo = capturedIngestIo ?? io;
      const ingestDeps = {
        ...(deps.ingestProgress ? { progress: deps.ingestProgress } : {}),
        ...(deps.runtimeIo ? { runtimeIo: deps.runtimeIo } : {}),
      };
      deps.onPhaseStart?.('query-history');
      const qhExitCode =
        Object.keys(ingestDeps).length > 0
          ? await runIngest(ingestArgs, ingestIo, ingestDeps)
          : await runIngest(ingestArgs, ingestIo);
      if (qhExitCode !== 0) {
        deps.onPhaseEnd?.('query-history', 'failed');
        return markTargetResult(
          target,
          args,
          'failed',
          'query-history',
          capturedIngestIo ? capturedFailureMessage(capturedIngestIo.capturedOutput()) : undefined,
        );
      }
      deps.onPhaseEnd?.('query-history', 'done');
    }

    return markTargetResult(target, args, 'done');
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
    ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
    ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
    allowImplicitAdapter: true,
  };
  const runIngest = deps.runIngest ?? runKtxIngest;
  const capturedIngestIo = deps.ingestProgress ? null : createCapturedPublicIngestIo();
  const ingestIo = capturedIngestIo ?? io;
  const ingestDeps = {
    ...(deps.ingestProgress ? { progress: deps.ingestProgress } : {}),
    ...(deps.runtimeIo ? { runtimeIo: deps.runtimeIo } : {}),
  };
  deps.onPhaseStart?.('source-ingest');
  const exitCode =
    Object.keys(ingestDeps).length > 0
      ? await runIngest(ingestArgs, ingestIo, ingestDeps)
      : await runIngest(ingestArgs, ingestIo);
  deps.onPhaseEnd?.('source-ingest', exitCode === 0 ? 'done' : 'failed');
  return markTargetResult(
    target,
    args,
    exitCode === 0 ? 'done' : 'failed',
    'source-ingest',
    capturedIngestIo ? capturedFailureMessage(capturedIngestIo.capturedOutput()) : undefined,
  );
}

export async function runKtxPublicIngest(
  args: KtxPublicIngestArgs,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps = {},
): Promise<number> {
  const loadProject = deps.loadProject ?? loadKtxProject;
  const project = await loadProject({ projectDir: args.projectDir });
  if (shouldUseForegroundContextBuildView(args, io)) {
    const plan = buildPublicIngestPlan(project, args);
    const requirements = resolvePublicIngestRuntimeRequirements(plan, { env: deps.env ?? process.env });
    const ensureRuntime = deps.ensureRuntime ?? ensureManagedPythonCommandRuntime;
    for (const feature of requirements.features) {
      try {
        await ensureRuntime({
          cliVersion: args.cliVersion ?? '0.0.0-private',
          installPolicy: args.runtimeInstallPolicy ?? 'prompt',
          io,
          feature,
        });
      } catch (error) {
        io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    const { runContextBuild } = await import('./context-build-view.js');
    const contextBuild = deps.runContextBuild ?? runContextBuild;
    const result = await contextBuild(
      project,
      {
        projectDir: args.projectDir,
        ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
        all: args.all,
        entrypoint: 'ingest',
        inputMode: args.inputMode,
        ...(args.depth ? { depth: args.depth } : {}),
        ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
        ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
        ...(args.scanMode ? { scanMode: args.scanMode } : {}),
        ...(args.detectRelationships !== undefined ? { detectRelationships: args.detectRelationships } : {}),
        ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
        ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
      },
      io,
    );
    return result.exitCode;
  }

  const plan = buildPublicIngestPlan(project, args);
  const results: KtxPublicIngestTargetResult[] = [];

  if (!args.json) {
    for (const notice of plan.notices ?? []) {
      io.stdout.write(`${notice}\n`);
    }
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
