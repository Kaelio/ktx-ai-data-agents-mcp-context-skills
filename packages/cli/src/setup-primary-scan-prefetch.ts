import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cancel, isCancel, select } from '@clack/prompts';
import { loadKtxProject } from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import {
  contextBuildCommands,
  readKtxSetupContextState,
  readKtxSetupContextStateSync,
  writeKtxSetupContextState,
  writeKtxSetupContextStateSync,
  type KtxSetupContextState,
} from './setup-context.js';
import { buildPublicIngestPlan } from './public-ingest.js';
import {
  type ContextBuildSourceProgressUpdate,
  type ContextBuildResult,
  runContextBuild,
} from './context-build-view.js';
import { withMenuOptionsSpacing } from './prompt-navigation.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';

export interface KtxPrimaryScanPrefetchArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  yes: boolean;
  connectionIds?: string[];
}

export interface KtxPrimaryScanPrefetchWorkerArgs {
  projectDir: string;
  runId?: string;
  connectionIds?: string[];
}

export type KtxPrimaryScanPrefetchResult =
  | { status: 'started'; projectDir: string; runId: string; logPath?: string }
  | { status: 'running'; projectDir: string; runId?: string }
  | { status: 'skipped'; projectDir: string; reason: string }
  | { status: 'failed'; projectDir: string; reason: string };

export interface KtxPrimaryScanPrefetchPromptAdapter {
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxPrimaryScanPrefetchDeps {
  prompts?: KtxPrimaryScanPrefetchPromptAdapter;
  runIdFactory?: () => string;
  now?: () => Date;
  spawnPrefetch?: (args: { projectDir: string; runId: string; connectionIds: string[] }) => { logPath?: string } | null;
  runContextBuild?: typeof runContextBuild;
}

const ACTIVE_CONTEXT_STATUSES = new Set(['running', 'detached']);

function createPromptAdapter(): KtxPrimaryScanPrefetchPromptAdapter {
  return {
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return 'wait';
      }
      return String(value);
    },
    cancel(message) {
      cancel(message);
    },
  };
}

function runIdFactory(): string {
  return `setup-context-prefetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveKtxEntryScript(): string | null {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith('.js') || argv1.endsWith('.ts') || argv1.endsWith('.mjs'))) {
    return argv1;
  }
  return null;
}

function spawnPrimaryScanPrefetch(input: {
  projectDir: string;
  runId: string;
  connectionIds: string[];
}): { logPath: string } | null {
  const entryScript = resolveKtxEntryScript();
  if (!entryScript) return null;

  const resolvedDir = resolve(input.projectDir);
  const logDir = join(resolvedDir, '.ktx', 'setup');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'context-build.log');
  const logFd = openSync(logPath, 'a');
  const connectionArgs = input.connectionIds.flatMap((connectionId) => [
    '--primary-scan-prefetch-connection-id',
    connectionId,
  ]);

  const child = spawn(
    process.execPath,
    [
      entryScript,
      'setup',
      '--project-dir',
      resolvedDir,
      '--no-input',
      '--internal-primary-scan-prefetch',
      '--primary-scan-prefetch-run-id',
      input.runId,
      ...connectionArgs,
    ],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();
  return { logPath };
}

function missingPrimaryScanCapabilities(config: Awaited<ReturnType<typeof loadKtxProject>>['config']): string[] {
  const missing: string[] = [];
  if (config.llm.provider.backend === 'none' || !config.llm.models.default) {
    missing.push('models');
  }
  const embeddings = config.ingest.embeddings;
  if (
    embeddings.backend === 'none' ||
    embeddings.backend === 'deterministic' ||
    !embeddings.model ||
    embeddings.dimensions <= 0
  ) {
    missing.push('embeddings');
  }
  if (config.scan.enrichment.mode === 'none') {
    missing.push('scan enrichment');
  }
  return missing;
}

function primaryScanConnectionIds(
  project: Awaited<ReturnType<typeof loadKtxProject>>,
  preferredConnectionIds: string[] | undefined,
): string[] {
  const preferred = preferredConnectionIds && preferredConnectionIds.length > 0 ? new Set(preferredConnectionIds) : null;
  try {
    const plan = buildPublicIngestPlan(project, { projectDir: project.projectDir, all: true });
    return plan.targets
      .filter((target) => target.operation === 'scan')
      .filter((target) => !preferred || preferred.has(target.connectionId))
      .map((target) => target.connectionId);
  } catch {
    return [];
  }
}

function queuedProgress(connectionIds: string[]): ContextBuildSourceProgressUpdate[] {
  return connectionIds.map((connectionId) => ({ connectionId, operation: 'scan', status: 'queued' }));
}

function sourceProgressKey(source: Pick<ContextBuildSourceProgressUpdate, 'connectionId' | 'operation'>): string {
  return `${source.operation}:${source.connectionId}`;
}

function mergeSourceProgress(
  latest: ContextBuildSourceProgressUpdate[],
  current: ContextBuildSourceProgressUpdate[] | undefined,
): ContextBuildSourceProgressUpdate[] {
  const latestKeys = new Set(latest.map(sourceProgressKey));
  return [...latest, ...(current ?? []).filter((source) => !latestKeys.has(sourceProgressKey(source)))];
}

function currentStateWithProgress(projectDir: string, fallback: KtxSetupContextState, latest: ContextBuildSourceProgressUpdate[]) {
  try {
    const current = readKtxSetupContextStateSync(projectDir);
    return {
      contextSourceConnectionIds: current.contextSourceConnectionIds,
      sourceProgress: mergeSourceProgress(latest, current.sourceProgress),
    };
  } catch {
    return {
      contextSourceConnectionIds: fallback.contextSourceConnectionIds,
      sourceProgress: latest,
    };
  }
}

function stateForPrefetch(input: {
  projectDir: string;
  runId: string;
  status: KtxSetupContextState['status'];
  now: Date;
  primarySourceConnectionIds: string[];
  sourceProgress?: ContextBuildSourceProgressUpdate[];
  reportIds?: string[];
  artifactPaths?: string[];
  failureReason?: string;
}): KtxSetupContextState {
  const timestamp = input.now.toISOString();
  return {
    runId: input.runId,
    status: input.status,
    startedAt: timestamp,
    updatedAt: timestamp,
    primarySourceConnectionIds: input.primarySourceConnectionIds,
    contextSourceConnectionIds: [],
    reportIds: input.reportIds ?? [],
    artifactPaths: input.artifactPaths ?? [],
    retryableFailedTargets: input.status === 'failed' ? input.primarySourceConnectionIds : [],
    commands: contextBuildCommands(input.projectDir, input.runId),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    ...(input.sourceProgress ? { sourceProgress: input.sourceProgress } : {}),
  };
}

async function chooseStartPrefetch(
  args: KtxPrimaryScanPrefetchArgs,
  io: KtxCliIo,
  deps: KtxPrimaryScanPrefetchDeps,
): Promise<boolean> {
  if (args.yes) {
    return true;
  }
  if (args.inputMode === 'disabled') {
    return false;
  }
  if (io.stdout.isTTY !== true && !deps.prompts) {
    return false;
  }
  const prompts = deps.prompts ?? createPromptAdapter();
  const choice = await prompts.select({
    message:
      'Prepare primary source context while you finish setup?\n\n' +
      'KTX can start the enriched primary-source scan now, then finish context sources later.',
    options: [
      { value: 'start', label: 'Start in background (recommended)' },
      { value: 'wait', label: 'Wait until Build Context' },
    ],
  });
  return choice === 'start';
}

export async function startPrimaryScanPrefetch(
  args: KtxPrimaryScanPrefetchArgs,
  io: KtxCliIo,
  deps: KtxPrimaryScanPrefetchDeps = {},
): Promise<KtxPrimaryScanPrefetchResult> {
  const existingState = await readKtxSetupContextState(args.projectDir);
  if (ACTIVE_CONTEXT_STATUSES.has(existingState.status)) {
    return { status: 'running', projectDir: args.projectDir, runId: existingState.runId };
  }
  if (existingState.status === 'completed') {
    return { status: 'skipped', projectDir: args.projectDir, reason: 'context already built' };
  }

  const project = await loadKtxProject({ projectDir: args.projectDir });
  const missing = missingPrimaryScanCapabilities(project.config);
  if (missing.length > 0) {
    return { status: 'skipped', projectDir: args.projectDir, reason: `missing ${missing.join(', ')}` };
  }

  const connectionIds = primaryScanConnectionIds(project, args.connectionIds);
  if (connectionIds.length === 0) {
    return { status: 'skipped', projectDir: args.projectDir, reason: 'no primary sources' };
  }
  if (!(await chooseStartPrefetch(args, io, deps))) {
    return { status: 'skipped', projectDir: args.projectDir, reason: 'user deferred' };
  }

  const runId = deps.runIdFactory?.() ?? runIdFactory();
  const now = deps.now?.() ?? new Date();
  const initialState = stateForPrefetch({
    projectDir: args.projectDir,
    runId,
    status: 'detached',
    now,
    primarySourceConnectionIds: connectionIds,
    sourceProgress: queuedProgress(connectionIds),
  });
  const spawned = (deps.spawnPrefetch ?? spawnPrimaryScanPrefetch)({
    projectDir: args.projectDir,
    runId,
    connectionIds,
  });
  if (!spawned) {
    return { status: 'skipped', projectDir: args.projectDir, reason: 'background runner unavailable' };
  }
  await writeKtxSetupContextState(args.projectDir, initialState);
  io.stdout.write(`│  Primary source context scan started in the background (${connectionIds.join(', ')}).\n`);
  return {
    status: 'started',
    projectDir: args.projectDir,
    runId,
    ...(spawned.logPath ? { logPath: spawned.logPath } : {}),
  };
}

export async function runPrimaryScanPrefetchWorker(
  args: KtxPrimaryScanPrefetchWorkerArgs,
  io: KtxCliIo,
  deps: KtxPrimaryScanPrefetchDeps = {},
): Promise<number> {
  const project = await loadKtxProject({ projectDir: args.projectDir });
  const connectionIds = primaryScanConnectionIds(
    project,
    args.connectionIds ?? project.config.setup?.database_connection_ids,
  );
  if (connectionIds.length === 0) {
    return 0;
  }

  const runId = args.runId ?? deps.runIdFactory?.() ?? runIdFactory();
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const runningState = stateForPrefetch({
    projectDir: args.projectDir,
    runId,
    status: 'running',
    now: startedAt,
    primarySourceConnectionIds: connectionIds,
    sourceProgress: queuedProgress(connectionIds),
  });
  await writeKtxSetupContextState(args.projectDir, runningState);

  let lastSourceProgress: ContextBuildSourceProgressUpdate[] | undefined = runningState.sourceProgress;
  const contextBuild = deps.runContextBuild ?? runContextBuild;
  let result: ContextBuildResult;
  try {
    result = await contextBuild(
      project,
      {
        projectDir: args.projectDir,
        inputMode: 'disabled',
        scanMode: 'enriched',
        detectRelationships: true,
        targetOperations: ['scan'],
        targetConnectionIds: connectionIds,
      },
      io,
      {
        onSourceProgress: (sources) => {
          const current = currentStateWithProgress(args.projectDir, runningState, sources);
          lastSourceProgress = current.sourceProgress;
          try {
            writeKtxSetupContextStateSync(args.projectDir, {
              ...runningState,
              contextSourceConnectionIds: current.contextSourceConnectionIds,
              updatedAt: now().toISOString(),
              sourceProgress: current.sourceProgress,
            });
          } catch {
            // Progress reporting is supplementary; the worker should keep scanning.
          }
        },
      },
    );
  } catch (error) {
    await writeKtxSetupContextState(args.projectDir, {
      ...runningState,
      status: 'failed',
      updatedAt: now().toISOString(),
      retryableFailedTargets: connectionIds,
      failureReason: error instanceof Error ? error.message : String(error),
      ...(lastSourceProgress ? { sourceProgress: lastSourceProgress } : {}),
    });
    return 1;
  }

  const completedAt = now().toISOString();
  const current = currentStateWithProgress(args.projectDir, runningState, lastSourceProgress ?? []);
  await writeKtxSetupContextState(args.projectDir, {
    ...runningState,
    contextSourceConnectionIds: current.contextSourceConnectionIds,
    status: result.exitCode === 0 ? 'paused' : 'failed',
    updatedAt: completedAt,
    reportIds: result.reportIds ?? [],
    artifactPaths: result.artifactPaths ?? [],
    retryableFailedTargets: result.exitCode === 0 ? [] : connectionIds,
    ...(result.exitCode === 0 ? {} : { failureReason: 'Primary source context scan failed.' }),
    ...(current.sourceProgress.length > 0 ? { sourceProgress: current.sourceProgress } : {}),
  });
  return result.exitCode;
}
