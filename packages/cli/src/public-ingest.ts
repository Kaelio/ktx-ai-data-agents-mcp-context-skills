import { type KtxLocalProject, type KtxProjectConnectionConfig, loadKtxProject } from '@ktx/context/project';
import type { KtxCliIo } from './index.js';
import type { KtxIngestArgs } from './ingest.js';
import type { KtxScanArgs } from './scan.js';
import { profileMark } from './startup-profile.js';

profileMark('module:public-ingest');

type KtxPublicIngestStepName = 'scan' | 'source-ingest' | 'enrich' | 'memory-update';
type KtxPublicIngestStepStatus = 'done' | 'skipped' | 'failed' | 'not-run';
type KtxPublicIngestInputMode = 'auto' | 'disabled';

export type KtxPublicIngestArgs =
  | {
      command: 'run';
      projectDir: string;
      targetConnectionId?: string;
      all: boolean;
      json: boolean;
      inputMode: KtxPublicIngestInputMode;
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
  operation: 'scan' | 'source-ingest';
  adapter?: string;
  sourceDir?: string;
  debugCommand: string;
  steps: KtxPublicIngestStepName[];
}

export interface KtxPublicIngestPlan {
  projectDir: string;
  targets: KtxPublicIngestPlanTarget[];
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
  runScan?: (args: KtxScanArgs, io: KtxCliIo) => Promise<number>;
  runIngest?: (args: KtxIngestArgs, io: KtxCliIo) => Promise<number>;
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

const warehouseDrivers = new Set([
  'sqlite',
  'postgres',
  'postgresql',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
]);

function normalizedDriver(connection: KtxProjectConnectionConfig): string {
  return String(connection.driver ?? '')
    .trim()
    .toLowerCase();
}

function sourceDirForConnection(connection: KtxProjectConnectionConfig): string | undefined {
  const value = connection.source_dir ?? connection.sourceDir;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function targetForConnection(connectionId: string, connection: KtxProjectConnectionConfig): KtxPublicIngestPlanTarget {
  const driver = normalizedDriver(connection);
  const adapter = sourceAdapterByDriver.get(driver);
  const sourceDir = sourceDirForConnection(connection);
  if (adapter) {
    return {
      connectionId,
      driver,
      operation: 'source-ingest',
      adapter,
      ...(sourceDir ? { sourceDir } : {}),
      debugCommand: `ktx ingest run --connection-id ${connectionId} --adapter ${adapter} --debug`,
      steps: ['source-ingest', 'memory-update'],
    };
  }

  if (warehouseDrivers.has(driver)) {
    return {
      connectionId,
      driver,
      operation: 'scan',
      debugCommand: `ktx scan ${connectionId} --debug`,
      steps: ['scan'],
    };
  }

  throw new Error(`Connection "${connectionId}" uses unsupported public ingest driver "${driver || 'unknown'}"`);
}

export function buildPublicIngestPlan(
  project: KtxPublicIngestProject,
  args: { projectDir: string; targetConnectionId?: string; all: boolean },
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

  const targets = selected.map(([connectionId, connection]) => targetForConnection(connectionId, connection));
  return {
    projectDir: args.projectDir,
    targets: [...targets.filter((t) => t.operation === 'scan'), ...targets.filter((t) => t.operation === 'source-ingest')],
  };
}

function defaultSteps(target: KtxPublicIngestPlanTarget): KtxPublicIngestTargetResult['steps'] {
  return [
    {
      operation: 'scan',
      status: target.steps.includes('scan') ? 'not-run' : 'skipped',
      ...(target.operation === 'scan' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'source-ingest',
      status: target.steps.includes('source-ingest') ? 'not-run' : 'skipped',
      ...(target.operation === 'source-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    { operation: 'enrich', status: 'skipped' },
    {
      operation: 'memory-update',
      status: target.steps.includes('memory-update') ? 'not-run' : 'skipped',
      ...(target.operation === 'source-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
  ];
}

function markTargetResult(target: KtxPublicIngestPlanTarget, status: 'done' | 'failed'): KtxPublicIngestTargetResult {
  const failedOperation = target.operation === 'scan' ? 'scan' : 'source-ingest';
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
      if (step.operation === failedOperation) {
        return { ...step, status: 'failed', detail: `${target.connectionId} failed at ${failedOperation}.` };
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
  io.stdout.write('Source         Scan      Source ingest  Enrich   Memory update\n');
  for (const result of results) {
    io.stdout.write(
      `${result.connectionId.padEnd(14)} ${stepStatus(result, 'scan').padEnd(9)} ${stepStatus(
        result,
        'source-ingest',
      ).padEnd(14)} ${stepStatus(result, 'enrich').padEnd(8)} ${stepStatus(result, 'memory-update')}\n`,
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

export async function executePublicIngestTarget(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps,
): Promise<KtxPublicIngestTargetResult> {
  if (target.operation === 'scan') {
    const { runKtxScan } = await import('./scan.js');
    const exitCode = await (deps.runScan ?? runKtxScan)(
      {
        command: 'run',
        projectDir: args.projectDir,
        connectionId: target.connectionId,
        mode: args.scanMode ?? 'structural',
        detectRelationships: args.detectRelationships ?? false,
        dryRun: false,
      },
      io,
    );
    return markTargetResult(target, exitCode === 0 ? 'done' : 'failed');
  }

  const { runKtxIngest } = await import('./ingest.js');
  const exitCode = await (deps.runIngest ?? runKtxIngest)(
    {
      command: 'run',
      projectDir: args.projectDir,
      connectionId: target.connectionId,
      adapter: target.adapter ?? target.driver,
      ...(target.sourceDir ? { sourceDir: target.sourceDir } : {}),
      outputMode: sourceIngestOutputMode(args, io),
      inputMode: args.inputMode,
    },
    io,
  );
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
