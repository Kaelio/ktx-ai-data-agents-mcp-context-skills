import { mkdirSync, writeFileSync } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cancel, isCancel, select } from '@clack/prompts';
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
  type ContextBuildSourceProgressUpdate,
  createRepainter,
  defaultSetupKeystroke,
  renderContextBuildView,
  runContextBuild,
  viewStateFromSourceProgress,
} from './context-build-view.js';
import { withMenuOptionsSpacing } from './prompt-navigation.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';

export type KtxSetupContextBuildStatus =
  | 'not_started'
  | 'running'
  | 'detached'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stale';

export interface KtxSetupContextCommands {
  build: string;
  watch: string;
  status: string;
  stop: string;
  resume: string;
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
  watchCommand?: string;
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
  | { status: 'detached'; projectDir: string; runId: string }
  | { status: 'paused'; projectDir: string; runId: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

export interface KtxSetupContextStepArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  forcePrompt?: boolean;
  allowEmpty?: boolean;
  prompt?: boolean;
  autoWatch?: boolean;
}

interface KtxSetupContextWatchArgs {
  projectDir: string;
  runId?: string;
  inputMode: 'auto' | 'disabled';
}

export interface KtxSetupContextPromptAdapter {
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupContextDeps {
  prompts?: KtxSetupContextPromptAdapter;
  runIdFactory?: () => string;
  now?: () => Date;
  runContextBuild?: typeof runContextBuild;
  verifyContextReady?: (projectDir: string) => Promise<KtxSetupContextReadiness>;
  sleep?: (ms: number) => Promise<void>;
  watchIntervalMs?: number;
  setupKeystroke?: (onDetach: () => void, onCtrlC: () => void) => (() => void) | null;
}

interface KtxSetupContextTargets {
  primarySourceConnectionIds: string[];
  contextSourceConnectionIds: string[];
}

const SETUP_CONTEXT_STATE_PATH = ['.ktx', 'setup', 'context-build.json'] as const;
const LIVE_DATABASE_ADAPTER = 'live-database';
const SCAN_REPORT_FILE = 'scan-report.json';
const DEFAULT_WATCH_INTERVAL_MS = 2_000;

function createPromptAdapter(): KtxSetupContextPromptAdapter {
  return {
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return 'back';
      }
      return String(value);
    },
    cancel(message) {
      cancel(message);
    },
  };
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

export function contextBuildCommands(projectDir: string, runId?: string): KtxSetupContextCommands {
  const resolvedProjectDir = resolve(projectDir);
  return {
    build: `ktx setup --project-dir ${resolvedProjectDir}`,
    watch: `ktx setup --project-dir ${resolvedProjectDir}`,
    status: `ktx status --project-dir ${resolvedProjectDir}`,
    stop: `ktx setup --project-dir ${resolvedProjectDir}`,
    resume: `ktx setup --project-dir ${resolvedProjectDir}`,
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
  const record = value as Partial<KtxSetupContextState>;
  const status = record.status ?? 'not_started';
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
    commands: contextBuildCommands(projectDir, runId),
    ...(typeof record.failureReason === 'string' ? { failureReason: record.failureReason } : {}),
    ...(normalizeSourceProgress(record.sourceProgress) ? { sourceProgress: normalizeSourceProgress(record.sourceProgress) } : {}),
  };
}

const VALID_SOURCE_OPERATIONS = new Set(['scan', 'source-ingest']);
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
      operation: rec.operation as 'scan' | 'source-ingest',
      status: rec.status as 'queued' | 'running' | 'done' | 'failed',
      ...(typeof rec.startedAtMs === 'number' ? { startedAtMs: rec.startedAtMs } : {}),
      ...(typeof rec.elapsedMs === 'number' ? { elapsedMs: rec.elapsedMs } : {}),
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
    commands: contextBuildCommands(resolvedProjectDir, state.runId),
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
    ...(state.runId ? { watchCommand: state.commands.watch, statusCommand: state.commands.status } : {}),
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
      .filter((target) => target.operation === 'scan')
      .map((target) => target.connectionId),
    contextSourceConnectionIds: plan.targets
      .filter((target) => target.operation === 'source-ingest')
      .map((target) => target.connectionId),
  };
}

function missingCapabilities(project: KtxLocalProject): string[] {
  const missing: string[] = [];
  const llm = project.config.llm;
  if (llm.provider.backend === 'none' || !llm.models.default) {
    missing.push('Models are not ready.');
  }
  const embeddings = project.config.ingest.embeddings;
  if (
    embeddings.backend === 'none' ||
    embeddings.backend === 'deterministic' ||
    !embeddings.model ||
    embeddings.dimensions <= 0
  ) {
    missing.push('Embeddings are not ready.');
  }
  if (project.config.scan.enrichment.mode === 'none') {
    missing.push('Scan enrichment is not configured.');
  }
  return missing;
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
  } catch {
    return null;
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

function scanReportHasCompletedDescriptionEnrichment(report: unknown, connectionId: string): boolean {
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
    stringArrayValue(report.artifactPaths.manifestShards).length > 0
  );
}

async function verifyPrimarySourceScans(
  projectDir: string,
  connectionIds: string[],
): Promise<{ ready: boolean; details: string[] }> {
  const details: string[] = [];
  for (const connectionId of connectionIds) {
    const report = await readLatestScanReport(projectDir, connectionId);
    if (!scanReportHasCompletedDescriptionEnrichment(report, connectionId)) {
      details.push(`${connectionId}: enriched database scan with AI descriptions has not completed.`);
    }
  }
  return { ready: details.length === 0, details };
}

async function defaultVerifyContextReady(projectDir: string): Promise<KtxSetupContextReadiness> {
  const project = await loadKtxProject({ projectDir });
  const targets = listContextTargets(project);
  const primarySourceScans = await verifyPrimarySourceScans(projectDir, targets.primarySourceConnectionIds);
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

function writeSuccess(readiness: KtxSetupContextReadiness, targets: KtxSetupContextTargets, io: KtxCliIo): void {
  io.stdout.write('\nKTX context is ready for agents.\n\n');
  io.stdout.write('Primary sources:\n');
  if (targets.primarySourceConnectionIds.length === 0) {
    io.stdout.write('  none\n');
  } else {
    for (const connectionId of targets.primarySourceConnectionIds) {
      io.stdout.write(`  ${connectionId}: enriched scan complete\n`);
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
  const runningState: KtxSetupContextState = {
    runId,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    primarySourceConnectionIds: targets.primarySourceConnectionIds,
    contextSourceConnectionIds: targets.contextSourceConnectionIds,
    reportIds: [],
    artifactPaths: [],
    retryableFailedTargets: [],
    commands: contextBuildCommands(args.projectDir, runId),
  };
  await writeKtxSetupContextState(args.projectDir, runningState);

  let lastSourceProgress: ContextBuildSourceProgressUpdate[] | undefined;
  const contextBuild = deps.runContextBuild ?? runContextBuild;
  const buildResult = await contextBuild(
    project,
    {
      projectDir: args.projectDir,
      inputMode: args.inputMode,
      scanMode: 'enriched',
      detectRelationships: true,
    },
    io,
    {
      onDetach: () => {
        const resolvedDir = resolve(args.projectDir);
        mkdirSync(join(resolvedDir, '.ktx', 'setup'), { recursive: true });
        const detachedState = normalizeState(resolvedDir, {
          ...runningState,
          status: 'detached',
          updatedAt: new Date().toISOString(),
          ...(lastSourceProgress ? { sourceProgress: lastSourceProgress } : {}),
        });
        writeFileSync(statePath(resolvedDir), `${JSON.stringify(detachedState, null, 2)}\n`);
      },
      onSourceProgress: (sources) => {
        lastSourceProgress = sources;
        try {
          const resolvedDir = resolve(args.projectDir);
          mkdirSync(join(resolvedDir, '.ktx', 'setup'), { recursive: true });
          const progressState = normalizeState(resolvedDir, {
            ...runningState,
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
  if (buildResult.detached) {
    const updatedAt = now().toISOString();
    await writeKtxSetupContextState(args.projectDir, {
      ...runningState,
      status: 'detached',
      updatedAt,
      reportIds: completedReportIds,
      artifactPaths: completedArtifactPaths,
      ...(lastSourceProgress ? { sourceProgress: lastSourceProgress } : {}),
    });
    return { status: 'detached', projectDir: args.projectDir, runId };
  }
  if (buildResult.exitCode !== 0) {
    const updatedAt = now().toISOString();
    await writeKtxSetupContextState(args.projectDir, {
      ...runningState,
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
      ...runningState,
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
    ...runningState,
    status: 'completed',
    updatedAt: completedAt,
    completedAt,
    reportIds: completedReportIds,
    artifactPaths: completedArtifactPaths,
    retryableFailedTargets: [],
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
    commands: contextBuildCommands(args.projectDir, runId),
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
    const project = await loadKtxProject({ projectDir: args.projectDir });
    const existingState = await readKtxSetupContextState(args.projectDir);
    const completedSteps = (await readKtxSetupState(args.projectDir)).completed_steps;
    if (completedSteps.includes('context') && existingState.status === 'completed') {
      return { status: 'ready', projectDir: args.projectDir, runId: existingState.runId ?? 'setup-context-completed' };
    }

    if (
      (existingState.status === 'running' || existingState.status === 'detached') &&
      args.inputMode !== 'disabled'
    ) {
      if (args.autoWatch) {
        const watched = await watchContextStatus(
          {
            projectDir: args.projectDir,
            ...(existingState.runId ? { runId: existingState.runId } : {}),
            inputMode: args.inputMode,
          },
          existingState,
          io,
          deps,
        );
        return setupResultFromWatchedState(args.projectDir, watched.state);
      }
      const prompts = deps.prompts ?? createPromptAdapter();
      const choice = await prompts.select({
        message:
          'A context build is running in the background.\n\n' +
          'You can watch it until it finishes, check its status once, or start a fresh build.',
        options: [
          { value: 'watch', label: 'Watch progress' },
          { value: 'status', label: 'Check status' },
          { value: 'rebuild', label: 'Start a fresh context build' },
          { value: 'back', label: 'Back' },
        ],
      });
      if (choice === 'watch') {
        const watched = await watchContextStatus(
          {
            projectDir: args.projectDir,
            ...(existingState.runId ? { runId: existingState.runId } : {}),
            inputMode: args.inputMode,
          },
          existingState,
          io,
          deps,
        );
        return setupResultFromWatchedState(args.projectDir, watched.state);
      }
      if (choice === 'status') {
        const commands = contextBuildCommands(args.projectDir, existingState.runId);
        io.stdout.write(`\nRun: ${commands.status}\n`);
        io.stdout.write(`Log: ${join(resolve(args.projectDir), '.ktx', 'setup', 'context-build.log')}\n`);
        return { status: 'detached', projectDir: args.projectDir, runId: existingState.runId ?? '' };
      }
      if (choice === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
    }

    const targets = listContextTargets(project);
    if (targets.primarySourceConnectionIds.length === 0 && targets.contextSourceConnectionIds.length === 0) {
      if (args.allowEmpty === true) {
        return { status: 'skipped', projectDir: args.projectDir };
      }
      io.stderr.write('No primary or context sources are configured for a KTX context build.\n');
      return { status: 'failed', projectDir: args.projectDir };
    }

    const missing = missingCapabilities(project);
    if (missing.length > 0) {
      if (args.allowEmpty === true) {
        return { status: 'skipped', projectDir: args.projectDir };
      }
      writeMissingCapabilities(missing, io);
      return { status: 'missing-input', projectDir: args.projectDir };
    }

    if (args.forcePrompt !== true && args.prompt !== false && deps.verifyContextReady === undefined) {
      const existingContextResult = await completeExistingContext(args, io, deps, targets);
      if (existingContextResult) {
        return existingContextResult;
      }
    }

    if (args.inputMode !== 'disabled' && args.prompt !== false) {
      const choice = await promptForBuild(deps.prompts ?? createPromptAdapter());
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

function stateMatchesRunId(state: KtxSetupContextState, runId: string | undefined): boolean {
  return !runId || state.runId === runId;
}

function isActiveStatus(status: KtxSetupContextBuildStatus): boolean {
  return status === 'running' || status === 'detached';
}

function watchExitCode(status: KtxSetupContextBuildStatus): number {
  return status === 'failed' || status === 'interrupted' || status === 'stale' ? 1 : 0;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function writeContextStatus(state: KtxSetupContextState, io: KtxCliIo): void {
  io.stdout.write(`KTX context built: ${state.status === 'completed' ? 'yes' : state.status.replaceAll('_', ' ')}\n`);
  if (state.runId) {
    io.stdout.write(`Run: ${state.runId}\n`);
    io.stdout.write(`Watch: ${state.commands.watch}\n`);
    io.stdout.write(`Status: ${state.commands.status}\n`);
  }
  if (state.failureReason) {
    io.stdout.write(`Detail: ${state.failureReason}\n`);
  }
}

async function watchContextStatus(
  args: KtxSetupContextWatchArgs,
  initialState: KtxSetupContextState,
  io: KtxCliIo,
  deps: KtxSetupContextDeps,
): Promise<{ exitCode: number; state: KtxSetupContextState }> {
  if (initialState.sourceProgress && initialState.sourceProgress.length > 0) {
    return watchContextStatusWithProgressView(args, initialState, io, deps);
  }
  return watchContextStatusText(args, initialState, io, deps);
}

async function watchContextStatusText(
  args: KtxSetupContextWatchArgs,
  initialState: KtxSetupContextState,
  io: KtxCliIo,
  deps: KtxSetupContextDeps,
): Promise<{ exitCode: number; state: KtxSetupContextState }> {
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  let state = initialState;
  let lastRenderedStatus = '';

  io.stdout.write('KTX context build\n');
  while (true) {
    const renderedStatus = `${state.status}:${state.updatedAt ?? ''}:${state.completedAt ?? ''}:${state.failureReason ?? ''}`;
    if (renderedStatus !== lastRenderedStatus) {
      writeContextStatus(state, io);
      lastRenderedStatus = renderedStatus;
    }

    if (!isActiveStatus(state.status)) {
      return { exitCode: watchExitCode(state.status), state };
    }

    await sleep(intervalMs);
    state = await readKtxSetupContextState(args.projectDir);
    if (!stateMatchesRunId(state, args.runId)) {
      io.stderr.write(`KTX setup context run "${args.runId}" was not found.\n`);
      return { exitCode: 1, state };
    }
  }
}

async function watchContextStatusWithProgressView(
  args: KtxSetupContextWatchArgs,
  initialState: KtxSetupContextState,
  io: KtxCliIo,
  deps: KtxSetupContextDeps,
): Promise<{ exitCode: number; state: KtxSetupContextState }> {
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const isTTY = io.stdout.isTTY === true;
  const repainter = isTTY ? createRepainter(io) : null;
  const projectDir = resolve(args.projectDir);
  const viewOpts = { styled: isTTY, showHint: true, projectDir };
  let state = initialState;
  let lastProgressKey = '';
  let detached = false;

  let viewState = viewStateFromSourceProgress(state.sourceProgress ?? [], Date.now(),
    state.startedAt ? new Date(state.startedAt).getTime() : undefined);

  const cleanupKeystroke = (isTTY || deps.setupKeystroke)
    ? (deps.setupKeystroke ?? defaultSetupKeystroke)(
        () => { detached = true; },
        () => { detached = true; },
      )
    : null;

  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  if (repainter) {
    repainter.paint(renderContextBuildView(viewState, viewOpts));
    spinnerInterval = setInterval(() => {
      viewState.frame++;
      const now = Date.now();
      viewState.totalElapsedMs = viewState.startedAt !== null ? now - viewState.startedAt : 0;
      for (const t of [...viewState.primarySources, ...viewState.contextSources]) {
        if (t.status === 'running' && t.startedAt !== null) {
          t.elapsedMs = now - t.startedAt;
        }
      }
      repainter.paint(renderContextBuildView(viewState, viewOpts));
    }, 140);
  }

  try {
    while (true) {
      if (!repainter) {
        const currentKey = JSON.stringify(state.sourceProgress?.map((s) => s.status));
        if (currentKey !== lastProgressKey || !isActiveStatus(state.status)) {
          io.stdout.write(renderContextBuildView(viewState, viewOpts));
          lastProgressKey = currentKey;
        }
      }

      if (!isActiveStatus(state.status)) {
        return { exitCode: watchExitCode(state.status), state };
      }
      if (detached) break;

      await sleep(intervalMs);
      if (detached) break;

      try {
        state = await readKtxSetupContextState(args.projectDir);
      } catch {
        continue;
      }

      if (!stateMatchesRunId(state, args.runId)) {
        io.stderr.write(`KTX setup context run "${args.runId}" was not found.\n`);
        return { exitCode: 1, state };
      }

      const now = Date.now();
      const startedAtMs = state.startedAt ? new Date(state.startedAt).getTime() : undefined;
      viewState = viewStateFromSourceProgress(state.sourceProgress ?? [], now, startedAtMs);
    }
  } finally {
    if (spinnerInterval) clearInterval(spinnerInterval);
    cleanupKeystroke?.();
  }

  io.stdout.write('\n\nContext build continuing in the background.\n');
  io.stdout.write(`Resume: ktx setup --project-dir ${projectDir}\n`);
  io.stdout.write(`Status: ktx status --project-dir ${projectDir}\n`);
  return { exitCode: 0, state };
}

function setupResultFromWatchedState(projectDir: string, state: KtxSetupContextState): KtxSetupContextResult {
  if (state.status === 'completed') {
    return { status: 'ready', projectDir, runId: state.runId ?? 'setup-context-completed' };
  }
  if (state.status === 'paused') {
    return { status: 'paused', projectDir, runId: state.runId ?? '' };
  }
  if (state.status === 'running' || state.status === 'detached') {
    return { status: 'detached', projectDir, runId: state.runId ?? '' };
  }
  return { status: 'failed', projectDir };
}
