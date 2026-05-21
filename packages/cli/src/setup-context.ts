import { mkdirSync, writeFileSync } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type KtxLocalProject,
  loadKtxProject,
  markKtxSetupStateStepComplete,
  readKtxSetupState,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { buildPublicIngestPlan } from './public-ingest.js';
import {
  type KtxDatabaseContextDepth,
  databaseContextDepth,
} from './ingest-depth.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import { ensureSetupDatabaseContextDepths } from './setup-database-context-depth.js';
import {
  type ContextBuildSourceProgressUpdate,
  runContextBuild,
} from './context-build-view.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

export type KtxSetupContextBuildStatus =
  | 'not_started'
  | 'completed'
  | 'failed'
  | 'stale';

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

export interface KtxSetupContextReadiness {
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

export interface KtxSetupContextPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupContextDeps {
  prompts?: KtxSetupContextPromptAdapter;
  runIdFactory?: () => string;
  now?: () => Date;
  runContextBuild?: typeof runContextBuild;
  verifyContextReady?: (projectDir: string) => Promise<KtxSetupContextReadiness>;
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

function scanReportHasSchemaManifest(report: unknown, connectionId: string): boolean {
  if (!isRecord(report)) {
    return false;
  }
  if (report.connectionId !== connectionId || report.dryRun === true) {
    return false;
  }
  return stringArrayValue(isRecord(report.artifactPaths) ? report.artifactPaths.manifestShards : undefined).length > 0;
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

function scanReportSatisfiesDepth(input: {
  report: unknown;
  connectionId: string;
  depth: KtxDatabaseContextDepth;
  relationshipsRequired: boolean;
}): boolean {
  if (input.depth === 'fast') {
    return scanReportHasSchemaManifest(input.report, input.connectionId);
  }
  return scanReportHasCompletedDeepEnrichment(input.report, input.connectionId, input.relationshipsRequired);
}

async function verifyPrimarySourceScans(
  project: KtxLocalProject,
  connectionIds: string[],
): Promise<{ ready: boolean; details: string[] }> {
  const details: string[] = [];
  const relationshipsRequired = project.config.scan.relationships.enabled;
  for (const connectionId of connectionIds) {
    const connection = project.config.connections[connectionId];
    const depth = connection ? (databaseContextDepth(connection) ?? 'fast') : 'fast';
    const report = await readLatestScanReport(project.projectDir, connectionId);
    if (!scanReportSatisfiesDepth({ report, connectionId, depth, relationshipsRequired })) {
      details.push(
        depth === 'fast'
          ? `${connectionId}: schema context has not completed.`
          : `${connectionId}: deep database context has not completed.`,
      );
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
  project: KtxLocalProject,
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
      const connection = project.config.connections[connectionId];
      const depth = connection ? (databaseContextDepth(connection) ?? 'fast') : 'fast';
      io.stdout.write(`  ${connectionId}: ${depth === 'deep' ? 'deep context complete' : 'schema context complete'}\n`);
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
  writeSuccess(project, readiness, targets, io);
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
    let project = await loadKtxProject({ projectDir: args.projectDir });
    const prompts = deps.prompts ?? createPromptAdapter();
    const depthProject = await ensureSetupDatabaseContextDepths({
      project,
      args,
      prompts,
    });
    if (depthProject === 'back') {
      return { status: 'back', projectDir: args.projectDir };
    }
    project = depthProject;
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

    const targets = listContextTargets(project);
    if (targets.primarySourceConnectionIds.length === 0 && targets.contextSourceConnectionIds.length === 0) {
      if (args.allowEmpty === true) {
        return { status: 'skipped', projectDir: args.projectDir };
      }
      io.stderr.write('No databases or context sources are configured for a KTX context build.\n');
      return { status: 'failed', projectDir: args.projectDir };
    }

    const preflightPlan = buildPublicIngestPlan(project, { projectDir: project.projectDir, all: true });
    const preflightFailures = preflightPlan.targets.flatMap((target) =>
      target.preflightFailure ? [`${target.connectionId}: ${target.preflightFailure}`] : [],
    );
    if (preflightFailures.length > 0) {
      if (args.allowEmpty === true) {
        return { status: 'skipped', projectDir: args.projectDir };
      }
      writeMissingCapabilities(preflightFailures, io);
      return { status: 'missing-input', projectDir: args.projectDir };
    }

    if (args.forcePrompt !== true && args.prompt !== false && deps.verifyContextReady === undefined) {
      const existingContextResult = await completeExistingContext(args, io, deps, targets);
      if (existingContextResult) {
        return existingContextResult;
      }
    }

    if (args.inputMode !== 'disabled' && args.prompt !== false) {
      const choice = await promptForBuild(prompts);
      if (choice === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
      if (choice === 'skip') {
        writeSkippedContext(args.projectDir, io);
        return { status: 'skipped', projectDir: args.projectDir };
      }
    }

    return await runBuild(args, io, deps, project, targets);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: 'failed', projectDir: args.projectDir };
  }
}
