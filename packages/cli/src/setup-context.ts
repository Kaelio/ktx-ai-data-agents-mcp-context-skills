import { mkdirSync, writeFileSync } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type KtxLocalProject, loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete, readKtxSetupState } from './context/project/setup-config.js';
import { serializeKtxProjectConfig } from './context/project/config.js';
import type { KtxCliIo } from './cli-runtime.js';
import { errorMessage, writePrefixedLines } from './clack.js';
import { buildPublicIngestPlan } from './public-ingest.js';
import { runKtxConnection } from './connection.js';
import { type BufferedCommandIo, createBufferedCommandIo } from './io/buffered-command-io.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import {
  type ContextBuildSourceProgressUpdate,
  runContextBuild,
} from './context-build-view.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

type KtxSetupContextBuildStatus =
  | 'not_started'
  | 'completed'
  | 'failed'
  | 'stale';

/** @internal */
export interface KtxSetupContextCommands {
  build: string;
  status: string;
}

export interface KtxSetupContextState {
  runId?: string;
  status: KtxSetupContextBuildStatus;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  primarySourceConnectionIds: string[];
  contextSourceConnectionIds: string[];
  reportIds: string[];
  artifactPaths: string[];
  retryableFailedTargets: string[];
  commands: KtxSetupContextCommands;
  failureReason?: string;
  sourceProgress?: ContextBuildSourceProgressUpdate[];
}

export interface KtxSetupContextStatusSummary {
  ready: boolean;
  status: KtxSetupContextBuildStatus;
  runId?: string;
  statusCommand?: string;
  retryCommand?: string;
  detail?: string;
}

interface KtxSetupContextReadiness {
  ready: boolean;
  agentContextReady: boolean;
  semanticSearchReady: boolean;
  details: string[];
  failedTargets?: string[];
}

export type KtxSetupContextResult =
  | { status: 'ready'; projectDir: string; runId: string }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

export interface KtxSetupContextStepArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  forcePrompt?: boolean;
  allowEmpty?: boolean;
  prompt?: boolean;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
}

interface KtxSetupContextPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupContextDeps {
  prompts?: KtxSetupContextPromptAdapter;
  runIdFactory?: () => string;
  now?: () => Date;
  runContextBuild?: typeof runContextBuild;
  verifyContextReady?: (projectDir: string) => Promise<KtxSetupContextReadiness>;
  testConnection?: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>;
}

interface KtxSetupContextTargets {
  primarySourceConnectionIds: string[];
  contextSourceConnectionIds: string[];
}

const SETUP_CONTEXT_STATE_PATH = ['.ktx', 'setup', 'context-build.json'] as const;
const LIVE_DATABASE_ADAPTER = 'live-database';
const SCAN_REPORT_FILE = 'scan-report.json';

function createPromptAdapter(): KtxSetupContextPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'back' });
}

function statePath(projectDir: string): string {
  return join(resolve(projectDir), ...SETUP_CONTEXT_STATE_PATH);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @internal */
export function contextBuildCommands(projectDir: string): KtxSetupContextCommands {
  const resolvedProjectDir = resolve(projectDir);
  return {
    build: `ktx setup --project-dir ${resolvedProjectDir}`,
    status: `ktx status --project-dir ${resolvedProjectDir}`,
  };
}

function notStartedState(projectDir: string): KtxSetupContextState {
  return {
    status: 'not_started',
    primarySourceConnectionIds: [],
    contextSourceConnectionIds: [],
    reportIds: [],
    artifactPaths: [],
    retryableFailedTargets: [],
    commands: contextBuildCommands(projectDir),
  };
}

function normalizeState(projectDir: string, value: unknown): KtxSetupContextState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return notStartedState(projectDir);
  }
  const record = value as Record<string, unknown>;
  const rawStatus = typeof record.status === 'string' ? record.status : 'not_started';
  const status: KtxSetupContextBuildStatus =
    rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'not_started' || rawStatus === 'stale'
      ? rawStatus
      : 'not_started';
  const runId = typeof record.runId === 'string' && record.runId.length > 0 ? record.runId : undefined;
  return {
    ...(runId ? { runId } : {}),
    status,
    ...(typeof record.startedAt === 'string' ? { startedAt: record.startedAt } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.completedAt === 'string' ? { completedAt: record.completedAt } : {}),
    primarySourceConnectionIds: Array.isArray(record.primarySourceConnectionIds)
      ? record.primarySourceConnectionIds.filter((item): item is string => typeof item === 'string')
      : [],
    contextSourceConnectionIds: Array.isArray(record.contextSourceConnectionIds)
      ? record.contextSourceConnectionIds.filter((item): item is string => typeof item === 'string')
      : [],
    reportIds: Array.isArray(record.reportIds)
      ? record.reportIds.filter((item): item is string => typeof item === 'string')
      : [],
    artifactPaths: Array.isArray(record.artifactPaths)
      ? record.artifactPaths.filter((item): item is string => typeof item === 'string')
      : [],
    retryableFailedTargets: Array.isArray(record.retryableFailedTargets)
      ? record.retryableFailedTargets.filter((item): item is string => typeof item === 'string')
      : [],
    commands: contextBuildCommands(projectDir),
    ...(typeof record.failureReason === 'string' ? { failureReason: record.failureReason } : {}),
    ...(normalizeSourceProgress(record.sourceProgress) ? { sourceProgress: normalizeSourceProgress(record.sourceProgress) } : {}),
  };
}

const VALID_SOURCE_OPERATIONS = new Set(['database-ingest', 'source-ingest']);
const VALID_SOURCE_STATUSES = new Set(['queued', 'running', 'done', 'failed']);

function normalizeSourceProgress(value: unknown): ContextBuildSourceProgressUpdate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ContextBuildSourceProgressUpdate[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.connectionId !== 'string') continue;
    if (!VALID_SOURCE_OPERATIONS.has(String(rec.operation))) continue;
    if (!VALID_SOURCE_STATUSES.has(String(rec.status))) continue;
    entries.push({
      connectionId: rec.connectionId,
      operation: rec.operation as 'database-ingest' | 'source-ingest',
      status: rec.status as 'queued' | 'running' | 'done' | 'failed',
      ...(typeof rec.startedAtMs === 'number' ? { startedAtMs: rec.startedAtMs } : {}),
      ...(typeof rec.elapsedMs === 'number' ? { elapsedMs: rec.elapsedMs } : {}),
      ...(typeof rec.percent === 'number' ? { percent: rec.percent } : {}),
      ...(typeof rec.message === 'string' ? { message: rec.message } : {}),
      ...(typeof rec.updatedAtMs === 'number' ? { updatedAtMs: rec.updatedAtMs } : {}),
      ...(typeof rec.summaryText === 'string' ? { summaryText: rec.summaryText } : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

function setupContextTargetIds(targets: KtxSetupContextTargets): string[] {
  return [...new Set([...targets.primarySourceConnectionIds, ...targets.contextSourceConnectionIds])];
}

function retryableFailedTargetsFromProgress(
  targets: KtxSetupContextTargets,
  progress: ContextBuildSourceProgressUpdate[] | undefined,
): string[] {
  const targetIds = setupContextTargetIds(targets);
  if (!progress || progress.length === 0) {
    return targetIds;
  }

  const failedIds = new Set(progress.filter((source) => source.status === 'failed').map((source) => source.connectionId));
  const failedTargets = targetIds.filter((connectionId) => failedIds.has(connectionId));
  return failedTargets.length > 0 ? failedTargets : targetIds;
}

export async function readKtxSetupContextState(projectDir: string): Promise<KtxSetupContextState> {
  const filePath = statePath(projectDir);
  if (!(await pathExists(filePath))) {
    return notStartedState(projectDir);
  }
  return normalizeState(projectDir, JSON.parse(await readFile(filePath, 'utf-8')) as unknown);
}

/** @internal */
export async function writeKtxSetupContextState(projectDir: string, state: KtxSetupContextState): Promise<void> {
  const resolvedProjectDir = resolve(projectDir);
  await mkdir(join(resolvedProjectDir, '.ktx', 'setup'), { recursive: true });
  const normalized = normalizeState(resolvedProjectDir, {
    ...state,
    commands: contextBuildCommands(resolvedProjectDir),
  });
  await writeFile(statePath(resolvedProjectDir), `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

export function setupContextStatusFromState(
  state: KtxSetupContextState,
  options: { completedStep: boolean } = { completedStep: false },
): KtxSetupContextStatusSummary {
  const status = options.completedStep && state.status === 'not_started' ? 'completed' : state.status;
  const ready = options.completedStep && status === 'completed';
  return {
    ready,
    status,
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.runId ? { statusCommand: state.commands.status } : {}),
    retryCommand: state.commands.build,
    ...(state.failureReason ? { detail: state.failureReason } : {}),
  };
}

function runIdFactory(): string {
  return `setup-context-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function listContextTargets(project: KtxLocalProject): KtxSetupContextTargets {
  if (Object.keys(project.config.connections).length === 0) {
    return { primarySourceConnectionIds: [], contextSourceConnectionIds: [] };
  }
  const plan = buildPublicIngestPlan(project, { projectDir: project.projectDir, all: true });
  return {
    primarySourceConnectionIds: plan.targets
      .filter((target) => target.operation === 'database-ingest')
      .map((target) => target.connectionId),
    contextSourceConnectionIds: plan.targets
      .filter((target) => target.operation === 'source-ingest')
      .map((target) => target.connectionId),
  };
}

interface ConnectionGateFailure {
  connectionId: string;
  driver: string;
}

type ConnectionGateResult = { ok: true } | { ok: false; failures: ConnectionGateFailure[] };

type PreparedBuild =
  | { kind: 'ready'; project: KtxLocalProject; targets: KtxSetupContextTargets }
  | { kind: 'result'; result: KtxSetupContextResult };

function requiredConnectionIds(targets: KtxSetupContextTargets): string[] {
  return [...targets.primarySourceConnectionIds, ...targets.contextSourceConnectionIds];
}

function connectorTypeLabel(project: KtxLocalProject, connectionId: string): string {
  const driver = String(project.config.connections[connectionId]?.driver ?? '')
    .trim()
    .toLowerCase();
  return driver.length > 0 ? driver : 'unknown';
}

async function defaultGateTestConnection(
  projectDir: string,
  connectionId: string,
  io: KtxCliIo,
): Promise<number> {
  return await runKtxConnection({ command: 'test', projectDir, connectionId }, io);
}

/**
 * Runs a live connection test for every connection the build depends on. Each
 * test's output is captured in a buffer and discarded so raw error text never
 * reaches the user — callers surface only the connection id and connector type.
 */
async function testRequiredConnections(
  projectDir: string,
  project: KtxLocalProject,
  targets: KtxSetupContextTargets,
  testConnection: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>,
): Promise<ConnectionGateResult> {
  const failures: ConnectionGateFailure[] = [];
  for (const connectionId of requiredConnectionIds(targets)) {
    const buffered: BufferedCommandIo = createBufferedCommandIo();
    const exitCode = await testConnection(projectDir, connectionId, buffered);
    if (exitCode !== 0) {
      failures.push({ connectionId, driver: connectorTypeLabel(project, connectionId) });
    }
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Loads the project and resolves the connections the build depends on, applying
 * the empty-targets and preflight-capability checks. Used both on first entry
 * and on interactive retry so a fix that adds, removes, or reconfigures a
 * connection is honored.
 */
async function prepareBuildTargets(args: KtxSetupContextStepArgs, io: KtxCliIo): Promise<PreparedBuild> {
  const project = await loadKtxProject({ projectDir: args.projectDir });
  const targets = listContextTargets(project);
  if (targets.primarySourceConnectionIds.length === 0 && targets.contextSourceConnectionIds.length === 0) {
    if (args.allowEmpty === true) {
      return { kind: 'result', result: { status: 'skipped', projectDir: args.projectDir } };
    }
    io.stderr.write('No databases or context sources are configured for a KTX context build.\n');
    return { kind: 'result', result: { status: 'failed', projectDir: args.projectDir } };
  }
  const preflightPlan = buildPublicIngestPlan(project, { projectDir: project.projectDir, all: true });
  const preflightFailures = preflightPlan.targets.flatMap((target) =>
    target.preflightFailure ? [`${target.connectionId}: ${target.preflightFailure}`] : [],
  );
  if (preflightFailures.length > 0) {
    if (args.allowEmpty === true) {
      return { kind: 'result', result: { status: 'skipped', projectDir: args.projectDir } };
    }
    writeMissingCapabilities(preflightFailures, io);
    return { kind: 'result', result: { status: 'missing-input', projectDir: args.projectDir } };
  }
  return { kind: 'ready', project, targets };
}

function writeConnectionGateFailureLines(
  io: KtxCliIo,
  projectDir: string,
  failures: ConnectionGateFailure[],
): void {
  io.stderr.write('KTX cannot build context: a required connection failed its live test.\n\n');
  io.stderr.write('Failed connections:\n');
  for (const failure of failures) {
    io.stderr.write(`  ${failure.connectionId} (${failure.driver})\n`);
  }
  io.stderr.write('\nEach connection must be reachable before KTX builds context.\n');
  io.stderr.write(
    `Run \`ktx connection test <id> --project-dir ${resolve(projectDir)}\` to see the error, fix the connection, then retry.\n`,
  );
}

function connectionGateFailureReason(failures: ConnectionGateFailure[]): string {
  const names = failures.map((failure) => `${failure.connectionId} (${failure.driver})`).join(', ');
  return `Required connections failed their live test: ${names}.`;
}

async function writeConnectionGateFailedState(
  args: KtxSetupContextStepArgs,
  deps: KtxSetupContextDeps,
  targets: KtxSetupContextTargets,
  failures: ConnectionGateFailure[],
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  await writeKtxSetupContextState(args.projectDir, {
    status: 'failed',
    startedAt: at,
    updatedAt: at,
    primarySourceConnectionIds: targets.primarySourceConnectionIds,
    contextSourceConnectionIds: targets.contextSourceConnectionIds,
    reportIds: [],
    artifactPaths: [],
    retryableFailedTargets: [],
    commands: contextBuildCommands(args.projectDir),
    failureReason: connectionGateFailureReason(failures),
  });
}

async function promptConnectionGateRetry(prompts: KtxSetupContextPromptAdapter): Promise<'retry' | 'back'> {
  return (await prompts.select({
    message: 'Fix the failing connection, then choose how to proceed.',
    options: [
      { value: 'retry', label: 'Retry connection tests' },
      { value: 'back', label: 'Back' },
    ],
  })) as 'retry' | 'back';
}

async function hasFileWithExtension(
  root: string,
  extensions: Set<string>,
  options: { ignoredDirectoryNames?: Set<string> } = {},
): Promise<boolean> {
  if (!(await pathExists(root))) {
    return false;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (options.ignoredDirectoryNames?.has(entry.name)) {
        continue;
      }
      if (await hasFileWithExtension(entryPath, extensions, options)) {
        return true;
      }
      continue;
    }
    if (extensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readLatestScanReport(projectDir: string, connectionId: string): Promise<unknown | null> {
  const scanRoot = join(projectDir, 'raw-sources', connectionId, LIVE_DATABASE_ADAPTER);
  if (!(await pathExists(scanRoot))) {
    return null;
  }

  const reports: Array<{ sortKey: string; report: unknown }> = [];
  for (const entry of await readdir(scanRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const report = await readJsonFile(join(scanRoot, entry.name, SCAN_REPORT_FILE));
    if (!isRecord(report)) {
      continue;
    }
    reports.push({ sortKey: stringValue(report.createdAt) ?? entry.name, report });
  }

  reports.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  return reports.at(-1)?.report ?? null;
}

function scanReportHasCompletedDeepEnrichment(
  report: unknown,
  connectionId: string,
  relationshipsRequired: boolean,
): boolean {
  if (!isRecord(report)) {
    return false;
  }
  if (report.connectionId !== connectionId || report.mode !== 'enriched' || report.dryRun === true) {
    return false;
  }
  if (!isRecord(report.enrichment) || !isRecord(report.enrichmentState) || !isRecord(report.artifactPaths)) {
    return false;
  }
  const completedStages = stringArrayValue(report.enrichmentState.completedStages);
  return (
    report.enrichment.tableDescriptions === 'completed' &&
    report.enrichment.columnDescriptions === 'completed' &&
    report.enrichment.embeddings === 'completed' &&
    completedStages.includes('descriptions') &&
    completedStages.includes('embeddings') &&
    (!relationshipsRequired || completedStages.includes('relationships')) &&
    stringArrayValue(report.artifactPaths.manifestShards).length > 0
  );
}

async function verifyPrimarySourceScans(
  project: KtxLocalProject,
  connectionIds: string[],
): Promise<{ ready: boolean; details: string[] }> {
  const details: string[] = [];
  const relationshipsRequired = project.config.scan.relationships.enabled;
  for (const connectionId of connectionIds) {
    const report = await readLatestScanReport(project.projectDir, connectionId);
    if (!scanReportHasCompletedDeepEnrichment(report, connectionId, relationshipsRequired)) {
      details.push(`${connectionId}: database context has not completed.`);
    }
  }
  return { ready: details.length === 0, details };
}

async function defaultVerifyContextReady(projectDir: string): Promise<KtxSetupContextReadiness> {
  const project = await loadKtxProject({ projectDir });
  const targets = listContextTargets(project);
  const primarySourceScans = await verifyPrimarySourceScans(project, targets.primarySourceConnectionIds);
  const semanticLayerContextReady = await hasFileWithExtension(
    join(projectDir, 'semantic-layer'),
    new Set(['.yaml', '.yml']),
    {
      ignoredDirectoryNames: new Set(['_schema']),
    },
  );
  const wikiReady = await hasFileWithExtension(join(projectDir, 'wiki'), new Set(['.md']));
  const contextSourceReady =
    targets.contextSourceConnectionIds.length === 0 || semanticLayerContextReady || wikiReady;
  const ready = primarySourceScans.ready && contextSourceReady;
  const semanticSearchReady = semanticLayerContextReady || primarySourceScans.ready;
  const details: string[] = [];
  if (!primarySourceScans.ready) {
    details.push(...primarySourceScans.details);
  }
  if (!contextSourceReady) {
    details.push('No semantic-layer or wiki assets were found after the context build.');
  }
  return {
    ready,
    agentContextReady: ready,
    semanticSearchReady,
    details: ready
      ? [
          `Agent context: ${ready ? 'ready' : 'not ready'}`,
          `Semantic search: ${semanticSearchReady ? 'ready' : 'not ready'}`,
        ]
      : details,
  };
}

async function markContextComplete(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await writeFile(project.configPath, serializeKtxProjectConfig(project.config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'context');
}

function writeMissingCapabilities(missing: string[], io: KtxCliIo): void {
  io.stderr.write('KTX cannot build agent-ready context yet.\n\n');
  io.stderr.write('Missing:\n');
  for (const item of missing) {
    io.stderr.write(`  ${item}\n`);
  }
  io.stderr.write('\nFix this in setup before building context.\n');
}

function writeSkippedContext(projectDir: string, io: KtxCliIo): void {
  io.stdout.write('\nKTX is configured, but context has not been built yet.\n\n');
  io.stdout.write('Agents were not connected because KTX has not prepared searchable context for them.\n\n');
  io.stdout.write(`Resume setup:\n  ktx setup --project-dir ${resolve(projectDir)}\n\n`);
  io.stdout.write(`Build context:\n  ktx setup --project-dir ${resolve(projectDir)}\n\n`);
  io.stdout.write(`Check status:\n  ktx status --project-dir ${resolve(projectDir)}\n`);
}

function writeSuccess(
  readiness: KtxSetupContextReadiness,
  targets: KtxSetupContextTargets,
  io: KtxCliIo,
): void {
  io.stdout.write('\nKTX context is ready for agents.\n\n');
  io.stdout.write('Databases:\n');
  if (targets.primarySourceConnectionIds.length === 0) {
    io.stdout.write('  none\n');
  } else {
    for (const connectionId of targets.primarySourceConnectionIds) {
      io.stdout.write(`  ${connectionId}: database context complete\n`);
    }
  }
  io.stdout.write('\nContext sources:\n');
  if (targets.contextSourceConnectionIds.length === 0) {
    io.stdout.write('  none\n');
  } else {
    for (const connectionId of targets.contextSourceConnectionIds) {
      io.stdout.write(`  ${connectionId}: memory update complete\n`);
    }
  }
  io.stdout.write('\nVerification:\n');
  io.stdout.write(`  Agent context: ${readiness.agentContextReady ? 'ready' : 'not ready'}\n`);
  io.stdout.write(`  Semantic search: ${readiness.semanticSearchReady ? 'ready' : 'not ready'}\n`);
}

function writeExistingContextSuccess(readiness: KtxSetupContextReadiness, io: KtxCliIo): void {
  io.stdout.write('\nKTX context is ready for agents.\n\n');
  io.stdout.write('Existing context artifacts were found from setup ingest.\n\n');
  io.stdout.write('Verification:\n');
  io.stdout.write(`  Agent context: ${readiness.agentContextReady ? 'ready' : 'not ready'}\n`);
  io.stdout.write(`  Semantic search: ${readiness.semanticSearchReady ? 'ready' : 'not ready'}\n`);
}

async function promptForBuild(prompts: KtxSetupContextPromptAdapter): Promise<'build' | 'skip' | 'back'> {
  return (await prompts.select({
    message:
      'Build KTX context for agents?\n\n' +
      'KTX is fully configured and ready to build context. This may take a few minutes to a few hours.',
    options: [
      { value: 'build', label: 'Build context now (recommended)' },
      { value: 'skip', label: 'Leave context unbuilt and exit setup' },
      { value: 'back', label: 'Back' },
    ],
  })) as 'build' | 'skip' | 'back';
}

async function runBuild(
  args: KtxSetupContextStepArgs,
  io: KtxCliIo,
  deps: KtxSetupContextDeps,
  project: KtxLocalProject,
  targets: KtxSetupContextTargets,
): Promise<KtxSetupContextResult> {
  const now = deps.now ?? (() => new Date());
  const runId = deps.runIdFactory?.() ?? runIdFactory();
  const startedAt = now().toISOString();
  const incompleteState: KtxSetupContextState = {
    runId,
    status: 'stale',
    startedAt,
    updatedAt: startedAt,
    primarySourceConnectionIds: targets.primarySourceConnectionIds,
    contextSourceConnectionIds: targets.contextSourceConnectionIds,
    reportIds: [],
    artifactPaths: [],
    retryableFailedTargets: [],
    commands: contextBuildCommands(args.projectDir),
    failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
  };
  await writeKtxSetupContextState(args.projectDir, incompleteState);

  let lastSourceProgress: ContextBuildSourceProgressUpdate[] | undefined;
  const contextBuild = deps.runContextBuild ?? runContextBuild;
  const buildResult = await contextBuild(
    project,
    {
      projectDir: args.projectDir,
      inputMode: args.inputMode,
      ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
      ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
    },
    io,
    {
      onSourceProgress: (sources) => {
        lastSourceProgress = sources;
        try {
          const resolvedDir = resolve(args.projectDir);
          mkdirSync(join(resolvedDir, '.ktx', 'setup'), { recursive: true });
          const progressState = normalizeState(resolvedDir, {
            ...incompleteState,
            sourceProgress: sources,
            updatedAt: new Date().toISOString(),
          });
          writeFileSync(statePath(resolvedDir), `${JSON.stringify(progressState, null, 2)}\n`);
        } catch {
          // Progress reporting is supplementary — don't crash the build
        }
      },
    },
  );
  const completedReportIds = buildResult.reportIds ?? [];
  const completedArtifactPaths = buildResult.artifactPaths ?? [];
  if (buildResult.exitCode !== 0) {
    const updatedAt = now().toISOString();
    await writeKtxSetupContextState(args.projectDir, {
      ...incompleteState,
      status: 'failed',
      updatedAt,
      reportIds: completedReportIds,
      artifactPaths: completedArtifactPaths,
      retryableFailedTargets: retryableFailedTargetsFromProgress(targets, lastSourceProgress),
      failureReason: 'Context build failed.',
      ...(lastSourceProgress ? { sourceProgress: lastSourceProgress } : {}),
    });
    return { status: 'failed', projectDir: args.projectDir };
  }

  const readiness = await (deps.verifyContextReady ?? defaultVerifyContextReady)(args.projectDir);
  if (!readiness.ready) {
    const updatedAt = now().toISOString();
    await writeKtxSetupContextState(args.projectDir, {
      ...incompleteState,
      status: 'failed',
      updatedAt,
      reportIds: completedReportIds,
      artifactPaths: completedArtifactPaths,
      retryableFailedTargets: readiness.failedTargets ?? [],
      failureReason: readiness.details.join(' '),
      ...(lastSourceProgress ? { sourceProgress: lastSourceProgress } : {}),
    });
    io.stderr.write('KTX context build did not pass agent-readiness verification.\n');
    for (const detail of readiness.details) {
      io.stderr.write(`  ${detail}\n`);
    }
    return { status: 'failed', projectDir: args.projectDir };
  }

  await markContextComplete(project.projectDir);
  const completedAt = now().toISOString();
  await writeKtxSetupContextState(args.projectDir, {
    ...incompleteState,
    status: 'completed',
    updatedAt: completedAt,
    completedAt,
    reportIds: completedReportIds,
    artifactPaths: completedArtifactPaths,
    retryableFailedTargets: [],
    failureReason: undefined,
    ...(lastSourceProgress ? { sourceProgress: lastSourceProgress } : {}),
  });
  writeSuccess(readiness, targets, io);
  return { status: 'ready', projectDir: args.projectDir, runId };
}

async function completeExistingContext(
  args: KtxSetupContextStepArgs,
  io: KtxCliIo,
  deps: KtxSetupContextDeps,
  targets: KtxSetupContextTargets,
): Promise<KtxSetupContextResult | null> {
  const readiness = await (deps.verifyContextReady ?? defaultVerifyContextReady)(args.projectDir);
  if (!readiness.ready) {
    return null;
  }

  const now = deps.now ?? (() => new Date());
  const completedAt = now().toISOString();
  const runId = deps.runIdFactory?.() ?? runIdFactory();
  await markContextComplete(args.projectDir);
  await writeKtxSetupContextState(args.projectDir, {
    runId,
    status: 'completed',
    startedAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    primarySourceConnectionIds: targets.primarySourceConnectionIds,
    contextSourceConnectionIds: targets.contextSourceConnectionIds,
    reportIds: [],
    artifactPaths: [],
    retryableFailedTargets: [],
    commands: contextBuildCommands(args.projectDir),
  });
  writeExistingContextSuccess(readiness, io);
  return { status: 'ready', projectDir: args.projectDir, runId };
}

export async function runKtxSetupContextStep(
  args: KtxSetupContextStepArgs,
  io: KtxCliIo,
  deps: KtxSetupContextDeps = {},
): Promise<KtxSetupContextResult> {
  try {
    const prompts = deps.prompts ?? createPromptAdapter();
    const existingState = await readKtxSetupContextState(args.projectDir);
    const completedSteps = (await readKtxSetupState(args.projectDir)).completed_steps;
    if (completedSteps.includes('context') && existingState.status === 'completed') {
      return { status: 'ready', projectDir: args.projectDir, runId: existingState.runId ?? 'setup-context-completed' };
    }
    if (
      args.allowEmpty === true &&
      (!completedSteps.includes('databases') || !completedSteps.includes('sources'))
    ) {
      return { status: 'skipped', projectDir: args.projectDir };
    }

    if (existingState.status === 'stale') {
      io.stdout.write('Previous context build state is stale; starting a fresh foreground build.\n');
    }

    const prepared = await prepareBuildTargets(args, io);
    if (prepared.kind === 'result') {
      return prepared.result;
    }
    let { project, targets } = prepared;
    const interactive = args.inputMode !== 'disabled' && args.prompt !== false;

    if (args.forcePrompt !== true && args.prompt !== false && deps.verifyContextReady === undefined) {
      const existingContextResult = await completeExistingContext(args, io, deps, targets);
      if (existingContextResult) {
        return existingContextResult;
      }
    }

    if (interactive) {
      const choice = await promptForBuild(prompts);
      if (choice === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
      if (choice === 'skip') {
        writeSkippedContext(args.projectDir, io);
        return { status: 'skipped', projectDir: args.projectDir };
      }
    }

    // Live-connection gate: every connection the build depends on must pass a
    // live test before the (expensive) build starts. A red connection is a hard
    // stop — we surface only the connection id and connector type, never raw
    // error text.
    const testConnection = deps.testConnection ?? defaultGateTestConnection;
    while (true) {
      const gate = await testRequiredConnections(args.projectDir, project, targets, testConnection);
      if (gate.ok) {
        return await runBuild(args, io, deps, project, targets);
      }
      writeConnectionGateFailureLines(io, args.projectDir, gate.failures);
      if (!interactive) {
        await writeConnectionGateFailedState(args, deps, targets, gate.failures);
        return { status: 'failed', projectDir: args.projectDir };
      }
      const choice = await promptConnectionGateRetry(prompts);
      if (choice === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
      const reprepared = await prepareBuildTargets(args, io);
      if (reprepared.kind === 'result') {
        return reprepared.result;
      }
      project = reprepared.project;
      targets = reprepared.targets;
    }
  } catch (error) {
    writePrefixedLines((chunk) => io.stderr.write(chunk), errorMessage(error));
    return { status: 'failed', projectDir: args.projectDir };
  }
}
