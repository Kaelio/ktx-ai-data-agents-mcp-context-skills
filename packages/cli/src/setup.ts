import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cancel, isCancel, select } from '@clack/prompts';
import { getLatestLocalIngestStatus, savedMemoryCountsForReport } from '@ktx/context/ingest';
import {
  ktxLocalStateDbPath,
  ktxSetupCompletedSteps,
  loadKtxProject,
  readKtxSetupState,
  type KtxLocalProject,
} from '@ktx/context/project';
import type { KtxCliIo } from './cli-runtime.js';
import { formatSetupNextStepLines } from './next-steps.js';
import { isKtxSetupExitError, withSetupInterruptConfirmation } from './setup-interrupt.js';
import {
  type KtxAgentScope,
  type KtxAgentTarget,
  type KtxSetupAgentsDeps,
  readKtxAgentInstallManifest,
  runKtxSetupAgentsStep,
} from './setup-agents.js';
import {
  type KtxSetupDatabaseDriver,
  type KtxSetupDatabasesDeps,
  runKtxSetupDatabasesStep,
} from './setup-databases.js';
import { type KtxSetupEmbeddingsDeps, runKtxSetupEmbeddingsStep } from './setup-embeddings.js';
import { type KtxSetupModelDeps, isKtxSetupLlmConfigReady, runKtxSetupAnthropicModelStep } from './setup-models.js';
import {
  type KtxPrimaryScanPrefetchArgs,
  type KtxPrimaryScanPrefetchResult,
  type KtxPrimaryScanPrefetchDeps,
  runPrimaryScanPrefetchWorker,
  startPrimaryScanPrefetch,
} from './setup-primary-scan-prefetch.js';
import { type KtxSetupProjectDeps, runKtxSetupProjectStep } from './setup-project.js';
import {
  isKtxPreAgentSetupReady,
  isKtxSetupReady,
  type KtxSetupReadyMenuDeps,
  runKtxSetupReadyChangeMenu,
} from './setup-ready-menu.js';
import { type KtxSetupSourcesDeps, type KtxSetupSourceType, runKtxSetupSourcesStep } from './setup-sources.js';
import { withMenuOptionsSpacing } from './prompt-navigation.js';
import {
  readKtxSetupContextState,
  type KtxSetupContextDeps,
  type KtxSetupContextResult,
  runKtxSetupContextStep,
  setupContextStatusFromState,
  type KtxSetupContextStatusSummary,
} from './setup-context.js';

export interface KtxSetupStatus {
  project: { path: string; ready: boolean; name?: string };
  llm: { backend?: string; ready: boolean; model?: string };
  embeddings: { backend?: string; ready: boolean; model?: string; dimensions?: number };
  databases: Array<{ connectionId: string; ready: boolean }>;
  sources: Array<{ connectionId: string; type: string; ready: boolean }>;
  context: KtxSetupContextStatusSummary;
  agents: Array<{ target: string; scope: string; ready: boolean }>;
}

export type KtxSetupArgs =
  | {
      command: 'primary-scan-prefetch';
      projectDir: string;
      runId?: string;
      connectionIds?: string[];
    }
  | {
      command: 'run';
      projectDir: string;
      mode: 'auto' | 'new' | 'existing';
      agents: boolean;
      target?: KtxAgentTarget;
      agentScope?: KtxAgentScope;
      skipAgents?: boolean;
      inputMode: 'auto' | 'disabled';
      yes: boolean;
      cliVersion: string;
      anthropicApiKeyEnv?: string;
      anthropicApiKeyFile?: string;
      anthropicModel?: string;
      skipLlm: boolean;
      embeddingBackend?: 'openai' | 'sentence-transformers';
      embeddingApiKeyEnv?: string;
      embeddingApiKeyFile?: string;
      skipEmbeddings: boolean;
      databaseDrivers?: KtxSetupDatabaseDriver[];
      databaseConnectionIds?: string[];
      databaseConnectionId?: string;
      databaseUrl?: string;
      databaseSchemas: string[];
      enableHistoricSql?: boolean;
      disableHistoricSql?: boolean;
      historicSqlWindowDays?: number;
      historicSqlMinExecutions?: number;
      historicSqlMinCalls?: number;
      historicSqlServiceAccountPatterns?: string[];
      historicSqlRedactionPatterns?: string[];
      skipDatabases: boolean;
      source?: KtxSetupSourceType;
      sourceConnectionId?: string;
      sourcePath?: string;
      sourceGitUrl?: string;
      sourceBranch?: string;
      sourceSubpath?: string;
      sourceAuthTokenRef?: string;
      sourceUrl?: string;
      sourceApiKeyRef?: string;
      sourceClientId?: string;
      sourceClientSecretRef?: string;
      sourceWarehouseConnectionId?: string;
      sourceProjectName?: string;
      sourceProfilesPath?: string;
      sourceTarget?: string;
      metabaseDatabaseId?: number;
      notionCrawlMode?: 'all_accessible' | 'selected_roots';
      notionRootPageIds?: string[];
      runInitialSourceIngest?: boolean;
      skipSources?: boolean;
      showEntryMenu?: boolean;
    };

export interface KtxSetupDeps {
  project?: KtxSetupProjectDeps;
  model?: (
    args: Parameters<typeof runKtxSetupAnthropicModelStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupAnthropicModelStep>>>;
  modelDeps?: KtxSetupModelDeps;
  embeddings?: (
    args: Parameters<typeof runKtxSetupEmbeddingsStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupEmbeddingsStep>>>;
  embeddingsDeps?: KtxSetupEmbeddingsDeps;
  databases?: (
    args: Parameters<typeof runKtxSetupDatabasesStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupDatabasesStep>>>;
  databasesDeps?: KtxSetupDatabasesDeps;
  sources?: (
    args: Parameters<typeof runKtxSetupSourcesStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupSourcesStep>>>;
  sourcesDeps?: KtxSetupSourcesDeps;
  agents?: (
    args: Parameters<typeof runKtxSetupAgentsStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupAgentsStep>>>;
  agentsDeps?: KtxSetupAgentsDeps;
  primaryScanPrefetch?: (args: KtxPrimaryScanPrefetchArgs, io: KtxCliIo) => Promise<KtxPrimaryScanPrefetchResult>;
  primaryScanPrefetchDeps?: KtxPrimaryScanPrefetchDeps;
  context?: (args: Parameters<typeof runKtxSetupContextStep>[0], io: KtxCliIo) => Promise<KtxSetupContextResult>;
  contextDeps?: KtxSetupContextDeps;
  readyMenuDeps?: KtxSetupReadyMenuDeps;
  entryMenuDeps?: KtxSetupEntryMenuDeps;
}

const SOURCE_DRIVERS = new Set(['dbt', 'metricflow', 'metabase', 'looker', 'lookml', 'notion']);

type KtxSetupEntryAction = 'setup' | 'new-project' | 'agents' | 'status' | 'demo' | 'exit';
type KtxSetupFlowStep = 'models' | 'embeddings' | 'databases' | 'sources' | 'context' | 'agents';
type KtxSetupFlowStatus =
  | 'ready'
  | 'skipped'
  | 'back'
  | 'missing-input'
  | 'failed'
  | 'detached'
  | 'paused'
  | 'interrupted';

export interface KtxSetupEntryMenuPromptAdapter {
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupEntryMenuDeps {
  prompts?: KtxSetupEntryMenuPromptAdapter;
}

function createEntryMenuPromptAdapter(): KtxSetupEntryMenuPromptAdapter {
  return {
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        return 'exit';
      }
      return String(value);
    },
    cancel(message) {
      cancel(message);
    },
  };
}

async function runKtxSetupEntryMenu(
  status: KtxSetupStatus,
  deps: KtxSetupEntryMenuDeps = {},
): Promise<{ action: KtxSetupEntryAction }> {
  const prompts = deps.prompts ?? createEntryMenuPromptAdapter();
  const options = status.project.ready
    ? [
        { value: 'setup', label: 'Resume or change an existing setup' },
        { value: 'new-project', label: 'Create a new KTX project' },
        { value: 'agents', label: 'Connect a coding agent to KTX' },
        { value: 'status', label: 'Check setup status' },
        { value: 'demo', label: 'Explore a pre-built KTX project' },
        { value: 'exit', label: 'Exit' },
      ]
    : [
        { value: 'setup', label: 'Set up KTX for my data' },
        { value: 'status', label: 'Check setup status' },
        { value: 'demo', label: 'Explore a pre-built KTX project' },
        { value: 'exit', label: 'Exit' },
      ];
  const action = (await prompts.select({
    message: 'What do you want to do?',
    options,
  })) as KtxSetupEntryAction;
  return { action };
}

async function runKtxSetupDemoFromEntryMenu(
  args: Extract<KtxSetupArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxSetupDeps,
): Promise<number> {
  const { runDemoTour } = await import('./setup-demo-tour.js');
  return await runDemoTour(
    { inputMode: args.inputMode },
    io,
    { agents: deps.agents },
  );
}

function embeddingsReady(status: KtxSetupStatus['embeddings']): boolean {
  return (
    status.backend !== undefined &&
    status.backend !== 'none' &&
    status.backend !== 'deterministic' &&
    typeof status.model === 'string' &&
    status.model.length > 0 &&
    typeof status.dimensions === 'number' &&
    status.dimensions > 0
  );
}

function sourceConnections(config: Awaited<ReturnType<typeof loadKtxProject>>['config']) {
  return Object.entries(config.connections)
    .filter(([, connection]) => SOURCE_DRIVERS.has(String(connection.driver ?? '').toLowerCase()))
    .map(([connectionId, connection]) => ({
      connectionId,
      type: String(connection.driver).toLowerCase(),
    }))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

type LocalIngestStatusReport = NonNullable<Awaited<ReturnType<typeof getLatestLocalIngestStatus>>>;

function reportHasSavedContext(report: LocalIngestStatusReport): boolean {
  if (report.body.failedWorkUnits.length > 0) {
    return false;
  }
  const counts = savedMemoryCountsForReport(report);
  return counts.wikiCount > 0 || counts.slCount > 0;
}

async function readIngestContextStatus(project: KtxLocalProject): Promise<KtxSetupContextStatusSummary | null> {
  if (!existsSync(ktxLocalStateDbPath(project))) {
    return null;
  }
  const report = await getLatestLocalIngestStatus(project);
  if (!report || !reportHasSavedContext(report)) {
    return null;
  }
  return {
    ready: true,
    status: 'completed',
    runId: report.runId,
  };
}

export async function readKtxSetupStatus(projectDir: string): Promise<KtxSetupStatus> {
  const resolvedProjectDir = resolve(projectDir);
  if (!existsSync(join(resolvedProjectDir, 'ktx.yaml'))) {
    return {
      project: { path: resolvedProjectDir, ready: false },
      llm: { ready: false },
      embeddings: { ready: false },
      databases: [],
      sources: [],
      context: setupContextStatusFromState(await readKtxSetupContextState(resolvedProjectDir)),
      agents: [],
    };
  }

  const project = await loadKtxProject({ projectDir: resolvedProjectDir });
  const llm = {
    backend: project.config.llm.provider.backend,
    ready: isKtxSetupLlmConfigReady(project.config.llm),
    model: project.config.llm.models.default,
  };

  const embeddings = {
    backend: project.config.ingest.embeddings.backend,
    ready: false,
    model: project.config.ingest.embeddings.model,
    dimensions: project.config.ingest.embeddings.dimensions,
  };
  embeddings.ready = embeddingsReady(embeddings);

  const completedSteps = ktxSetupCompletedSteps(project.config, await readKtxSetupState(resolvedProjectDir));
  const contextState = await readKtxSetupContextState(resolvedProjectDir);
  const setupContextStatus = setupContextStatusFromState(contextState, {
    completedStep: completedSteps.includes('context'),
  });
  const ingestContextStatus = setupContextStatus.ready ? null : await readIngestContextStatus(project);
  const databaseIds = project.config.setup?.database_connection_ids ?? Object.keys(project.config.connections);
  const databasesComplete = completedSteps.includes('databases');
  const manifest = await readKtxAgentInstallManifest(resolvedProjectDir);
  const agents =
    manifest?.installs.map((install) => ({
      target: install.target,
      scope: install.scope,
      ready: true,
    })) ?? [];

  return {
    project: { path: resolvedProjectDir, ready: true, name: project.config.project },
    llm,
    embeddings,
    databases: databaseIds.map((connectionId) => ({
      connectionId,
      ready: databasesComplete && Object.hasOwn(project.config.connections, connectionId),
    })),
    sources: sourceConnections(project.config).map((source) => ({
      ...source,
      ready: completedSteps.includes('sources'),
    })),
    context: ingestContextStatus ?? setupContextStatus,
    agents,
  };
}

function formatReady(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function formatConnectionList(ids: string[]): string {
  return ids.length > 0 ? `yes (${ids.join(', ')})` : 'no';
}

function formatContextBuilt(status: KtxSetupContextStatusSummary): string {
  if (status.ready) {
    return 'yes';
  }
  if (status.status === 'not_started') {
    return 'no';
  }
  const runSuffix = status.runId ? ` (${status.runId})` : '';
  return `${status.status.replaceAll('_', ' ')}${runSuffix}`;
}

export function formatKtxSetupStatus(status: KtxSetupStatus): string {
  if (!status.project.ready) {
    return [
      `No KTX project found at ${status.project.path}.`,
      '',
      'Check another project: ktx --project-dir <folder> status',
      'Or from that folder: ktx status',
      'Create a new KTX project here: ktx setup',
      '',
    ].join('\n');
  }

  const lines = [
    `KTX project: ${status.project.path}`,
    `Project ready: ${formatReady(status.project.ready)}`,
    `LLM ready: ${formatReady(status.llm.ready)}${status.llm.model ? ` (${status.llm.model})` : ''}`,
    `Embeddings ready: ${formatReady(status.embeddings.ready)}${
      status.embeddings.model ? ` (${status.embeddings.model})` : ''
    }`,
    `Primary sources configured: ${formatConnectionList(status.databases.map((database) => database.connectionId))}`,
    `Context sources configured: ${formatConnectionList(status.sources.map((source) => source.connectionId))}`,
    `KTX context built: ${formatContextBuilt(status.context)}`,
    `Agent integration ready: ${formatReady(status.agents.some((agent) => agent.ready))}${
      status.agents.length > 0 ? ` (${status.agents.map((agent) => `${agent.target}:${agent.scope}`).join(', ')})` : ''
    }`,
  ];
  if (!status.context.ready && status.context.watchCommand && status.context.status === 'running') {
    lines.push(`Resume: ${status.context.watchCommand}`);
  }
  if (!status.context.ready && status.context.status === 'failed' && status.context.detail) {
    lines.push(`Retry: ${status.context.retryCommand ?? `ktx setup --project-dir ${status.project.path}`}`);
  }

  return `${lines.join('\n')}\n`;
}

function setupStatusReady(status: KtxSetupStatus): boolean {
  if (!status.project.ready) {
    return false;
  }
  if (!setupHasContextTargets(status)) {
    return true;
  }
  return (
    status.llm.ready &&
    embeddingsReady(status.embeddings) &&
    status.databases.every((database) => database.ready) &&
    status.sources.every((source) => source.ready)
  );
}

function setupHasContextTargets(status: KtxSetupStatus): boolean {
  return status.databases.length > 0 || status.sources.length > 0;
}

function setupContextReady(status: KtxSetupStatus): boolean {
  return status.context.ready;
}

function setupContextActive(status: KtxSetupStatus): boolean {
  return status.context.status === 'running' || status.context.status === 'detached';
}

function writeContextNotReadyForAgents(projectDir: string, io: KtxCliIo): void {
  io.stderr.write('KTX context is not ready for agents.\n\n');
  io.stderr.write(`Build context first:\n  ktx setup --project-dir ${resolve(projectDir)}\n\n`);
  io.stderr.write(`Then install agent integration:\n  ktx setup --agents --project-dir ${resolve(projectDir)}\n`);
}

function setupRuntimeInstallPolicy(args: Extract<KtxSetupArgs, { command: 'run' }>): 'prompt' | 'auto' | 'never' {
  if (args.yes) {
    return 'auto';
  }
  return args.inputMode === 'disabled' ? 'never' : 'prompt';
}

async function commitSetupConfigChanges(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await project.git.commitFile('ktx.yaml', 'setup: update KTX project config', 'ktx setup', 'setup@ktx.local');
}

export async function runKtxSetup(args: KtxSetupArgs, io: KtxCliIo, deps: KtxSetupDeps = {}): Promise<number> {
  try {
    return await runKtxSetupInner(args, io, deps);
  } catch (error) {
    if (isKtxSetupExitError(error)) {
      return 0;
    }
    throw error;
  }
}

async function runKtxSetupInner(args: KtxSetupArgs, io: KtxCliIo, deps: KtxSetupDeps = {}): Promise<number> {
  if (args.command === 'primary-scan-prefetch') {
    return await runPrimaryScanPrefetchWorker(args, io, deps.primaryScanPrefetchDeps);
  }

  io.stdout.write('KTX setup\n');
  let entryAction: KtxSetupEntryAction | undefined;
  let projectResult: Awaited<ReturnType<typeof runKtxSetupProjectStep>>;
  const canShowEntryMenu =
    args.showEntryMenu === true &&
    args.inputMode !== 'disabled' &&
    !args.agents &&
    (io.stdout.isTTY === true || deps.entryMenuDeps?.prompts !== undefined);
  let autoWatchActiveBuild = false;

  setupLoop: while (true) {
    entryAction = undefined;
    if (canShowEntryMenu) {
      const status = await readKtxSetupStatus(args.projectDir);
      if (setupContextActive(status)) {
        autoWatchActiveBuild = true;
      } else {
        entryAction = (await runKtxSetupEntryMenu(status, deps.entryMenuDeps)).action;
        if (entryAction === 'exit') {
          (deps.entryMenuDeps?.prompts ?? createEntryMenuPromptAdapter()).cancel('Setup cancelled.');
          return 0;
        }
        if (entryAction === 'status') {
          io.stdout.write(formatKtxSetupStatus(status));
          return 0;
        }
        if (entryAction === 'demo') {
          return await runKtxSetupDemoFromEntryMenu(args, io, deps);
        }
      }
    }

    const projectMode = entryAction === 'new-project' ? 'prompt-new' : args.mode;
    projectResult = await runKtxSetupProjectStep(
      {
        projectDir: args.projectDir,
        mode: projectMode,
        inputMode: args.inputMode,
        yes: args.yes,
        allowBack: canShowEntryMenu,
      },
      io,
      deps.project,
    );

    if (projectResult.status === 'back') {
      continue;
    }

    if (projectResult.status !== 'ready') {
      return projectResult.status === 'cancelled' ? 0 : 1;
    }

    const agentsRequested = args.agents || entryAction === 'agents';
    const currentStatus = await readKtxSetupStatus(projectResult.projectDir);
    let readyAction: string | undefined;

    if (args.inputMode !== 'disabled' && !agentsRequested && setupContextActive(currentStatus)) {
      const contextRunner =
        deps.context ?? ((contextArgs, contextIo) => runKtxSetupContextStep(contextArgs, contextIo, deps.contextDeps));
      const contextResult = await contextRunner(
        {
          projectDir: projectResult.projectDir,
          inputMode: args.inputMode,
          allowEmpty: true,
          ...(autoWatchActiveBuild ? { autoWatch: true } : {}),
        },
        io,
      );
      autoWatchActiveBuild = false;
      if (contextResult.status === 'back') {
        continue;
      }
      if (contextResult.status === 'failed' || contextResult.status === 'missing-input') {
        return 1;
      }
      if (contextResult.status !== 'ready') {
        return 0;
      }
    }

    if (args.inputMode !== 'disabled' && !agentsRequested) {
      if (isKtxSetupReady(currentStatus)) {
        readyAction = (await runKtxSetupReadyChangeMenu(currentStatus, deps.readyMenuDeps)).action;
        if (readyAction === 'exit') return 0;
      } else if (isKtxPreAgentSetupReady(currentStatus)) {
        readyAction = 'agents';
      }
    }

    const runOnly = readyAction;
    const shouldRunModels = !runOnly || runOnly === 'models';
    const shouldRunEmbeddings = !runOnly || runOnly === 'embeddings';
    const shouldRunDatabases = !runOnly || runOnly === 'databases';
    const shouldRunSources = !runOnly || runOnly === 'sources';
    const shouldRunContext = agentsRequested || !runOnly || runOnly === 'context';
    const shouldRunAgents = agentsRequested || !runOnly || runOnly === 'agents';
    const showPromptInstructions = projectResult.confirmedCreation !== true;

    const setupSteps: KtxSetupFlowStep[] = agentsRequested
      ? ['context']
      : ['models', 'embeddings', 'databases', 'sources', 'context'];
    if (shouldRunAgents && args.skipAgents !== true) {
      setupSteps.push('agents');
    }

    const forcePromptSteps = new Set<KtxSetupFlowStep>();
    let autoWatchPrefetchAtContext = false;
    const isNavigableSetupStep = (step: KtxSetupFlowStep): boolean => {
      if (step === 'models') return !args.skipLlm && shouldRunModels;
      if (step === 'embeddings') return !args.skipEmbeddings && shouldRunEmbeddings;
      if (step === 'databases') return !args.skipDatabases && shouldRunDatabases;
      if (step === 'sources') return args.skipSources !== true && shouldRunSources;
      if (step === 'context') return shouldRunContext;
      return shouldRunAgents && args.skipAgents !== true;
    };
    const previousNavigableStepIndex = (currentIndex: number): number => {
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const previousStep = setupSteps[index];
        if (previousStep && isNavigableSetupStep(previousStep)) {
          return index;
        }
      }
      return -1;
    };

    for (let stepIndex = 0; stepIndex < setupSteps.length; ) {
      const step = setupSteps[stepIndex];
      if (!step) break;

      let stepResult: { status: KtxSetupFlowStatus };
      if (step === 'models') {
        const modelRunner =
          deps.model ?? ((modelArgs, modelIo) => runKtxSetupAnthropicModelStep(modelArgs, modelIo, deps.modelDeps));
        stepResult = await modelRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            ...(args.anthropicApiKeyEnv ? { anthropicApiKeyEnv: args.anthropicApiKeyEnv } : {}),
            ...(args.anthropicApiKeyFile ? { anthropicApiKeyFile: args.anthropicApiKeyFile } : {}),
            ...(args.anthropicModel ? { anthropicModel: args.anthropicModel } : {}),
            forcePrompt: forcePromptSteps.has('models') || runOnly === 'models',
            showPromptInstructions,
            skipLlm: args.skipLlm || !shouldRunModels,
          },
          io,
        );
      } else if (step === 'embeddings') {
        const embeddingsRunner =
          deps.embeddings ??
          ((embeddingArgs, embeddingIo) => runKtxSetupEmbeddingsStep(embeddingArgs, embeddingIo, deps.embeddingsDeps));
        stepResult = await embeddingsRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            cliVersion: args.cliVersion,
            runtimeInstallPolicy: setupRuntimeInstallPolicy(args),
            ...(args.embeddingBackend ? { embeddingBackend: args.embeddingBackend } : {}),
            ...(args.embeddingApiKeyEnv ? { embeddingApiKeyEnv: args.embeddingApiKeyEnv } : {}),
            ...(args.embeddingApiKeyFile ? { embeddingApiKeyFile: args.embeddingApiKeyFile } : {}),
            forcePrompt: forcePromptSteps.has('embeddings') || runOnly === 'embeddings',
            showPromptInstructions,
            skipEmbeddings: args.skipEmbeddings || !shouldRunEmbeddings,
          },
          io,
        );
      } else if (step === 'databases') {
        const databasesRunner =
          deps.databases ??
          ((databaseArgs, databaseIo) => runKtxSetupDatabasesStep(databaseArgs, databaseIo, deps.databasesDeps));
        stepResult = await databasesRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            ...(args.databaseDrivers ? { databaseDrivers: args.databaseDrivers } : {}),
            ...(args.databaseConnectionIds ? { databaseConnectionIds: args.databaseConnectionIds } : {}),
            ...(args.databaseConnectionId ? { databaseConnectionId: args.databaseConnectionId } : {}),
            ...(args.databaseUrl ? { databaseUrl: args.databaseUrl } : {}),
            databaseSchemas: args.databaseSchemas,
            ...(args.enableHistoricSql !== undefined ? { enableHistoricSql: args.enableHistoricSql } : {}),
            ...(args.disableHistoricSql !== undefined ? { disableHistoricSql: args.disableHistoricSql } : {}),
            ...(args.historicSqlWindowDays !== undefined ? { historicSqlWindowDays: args.historicSqlWindowDays } : {}),
            ...(args.historicSqlMinExecutions !== undefined
              ? { historicSqlMinExecutions: args.historicSqlMinExecutions }
              : {}),
            ...(args.historicSqlMinCalls !== undefined ? { historicSqlMinCalls: args.historicSqlMinCalls } : {}),
            ...(args.historicSqlServiceAccountPatterns
              ? { historicSqlServiceAccountPatterns: args.historicSqlServiceAccountPatterns }
              : {}),
            ...(args.historicSqlRedactionPatterns
              ? { historicSqlRedactionPatterns: args.historicSqlRedactionPatterns }
              : {}),
            skipDatabases: args.skipDatabases || !shouldRunDatabases,
          },
          io,
        );
      } else if (step === 'sources') {
        const sourcesRunner =
          deps.sources ?? ((sourceArgs, sourceIo) => runKtxSetupSourcesStep(sourceArgs, sourceIo, deps.sourcesDeps));
        stepResult = await sourcesRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            ...(args.source ? { source: args.source } : {}),
            ...(args.sourceConnectionId ? { sourceConnectionId: args.sourceConnectionId } : {}),
            ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
            ...(args.sourceGitUrl ? { sourceGitUrl: args.sourceGitUrl } : {}),
            ...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
            ...(args.sourceSubpath ? { sourceSubpath: args.sourceSubpath } : {}),
            ...(args.sourceAuthTokenRef ? { sourceAuthTokenRef: args.sourceAuthTokenRef } : {}),
            ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
            ...(args.sourceApiKeyRef ? { sourceApiKeyRef: args.sourceApiKeyRef } : {}),
            ...(args.sourceClientId ? { sourceClientId: args.sourceClientId } : {}),
            ...(args.sourceClientSecretRef ? { sourceClientSecretRef: args.sourceClientSecretRef } : {}),
            ...(args.sourceWarehouseConnectionId ? { sourceWarehouseConnectionId: args.sourceWarehouseConnectionId } : {}),
            ...(args.sourceProjectName ? { sourceProjectName: args.sourceProjectName } : {}),
            ...(args.sourceProfilesPath ? { sourceProfilesPath: args.sourceProfilesPath } : {}),
            ...(args.sourceTarget ? { sourceTarget: args.sourceTarget } : {}),
            ...(args.metabaseDatabaseId !== undefined ? { metabaseDatabaseId: args.metabaseDatabaseId } : {}),
            ...(args.notionCrawlMode ? { notionCrawlMode: args.notionCrawlMode } : {}),
            ...(args.notionRootPageIds ? { notionRootPageIds: args.notionRootPageIds } : {}),
            runInitialSourceIngest: args.runInitialSourceIngest ?? false,
            skipSources: args.skipSources === true || !shouldRunSources,
          },
          io,
        );
      } else if (step === 'context') {
        const contextRunner =
          deps.context ??
          ((contextArgs, contextIo) => runKtxSetupContextStep(contextArgs, contextIo, deps.contextDeps));
        stepResult = await contextRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            forcePrompt: forcePromptSteps.has('context') || runOnly === 'context',
            allowEmpty: true,
            ...(autoWatchPrefetchAtContext ? { autoWatch: true } : {}),
          },
          io,
        );
        autoWatchPrefetchAtContext = false;
      } else {
        const agentsRunner =
          deps.agents ?? ((agentArgs, agentIo) => runKtxSetupAgentsStep(agentArgs, agentIo, deps.agentsDeps));
        stepResult = await agentsRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            yes: args.yes,
            agents: true,
            ...(args.target ? { target: args.target } : {}),
            scope: args.agentScope ?? 'project',
            mode: 'cli',
            skipAgents: false,
          },
          io,
        );
      }

      if (stepResult.status === 'failed' || stepResult.status === 'missing-input') {
        return 1;
      }
      if (stepResult.status === 'back') {
        const previousIndex = previousNavigableStepIndex(stepIndex);
        if (previousIndex < 0) {
          if (canShowEntryMenu) {
            continue setupLoop;
          }
          return 0;
        }
        const previousStep = setupSteps[previousIndex];
        if (previousStep) {
          forcePromptSteps.add(previousStep);
        }
        stepIndex = previousIndex;
        continue;
      }
      if (step === 'context' && stepResult.status !== 'ready') {
        if (shouldRunAgents && args.skipAgents !== true) {
          if (agentsRequested) {
            writeContextNotReadyForAgents(projectResult.projectDir, io);
            return args.inputMode === 'disabled' ? 1 : 0;
          }
          return 0;
        }
      }
      if (step === 'databases' && stepResult.status === 'ready' && shouldRunContext) {
        const databaseResult = stepResult as Awaited<ReturnType<typeof runKtxSetupDatabasesStep>>;
        const connectionIds = 'connectionIds' in databaseResult ? databaseResult.connectionIds : [];
        const primaryScanPrefetch =
          deps.primaryScanPrefetch ??
          ((prefetchArgs, prefetchIo) =>
            startPrimaryScanPrefetch(prefetchArgs, prefetchIo, deps.primaryScanPrefetchDeps));
        const prefetchResult = await primaryScanPrefetch(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            yes: args.yes,
            connectionIds,
          },
          io,
        );
        if (prefetchResult.status === 'started' || prefetchResult.status === 'running') {
          autoWatchPrefetchAtContext = true;
        }
      }

      forcePromptSteps.delete(step);
      stepIndex += 1;
    }

    break;
  }

  await commitSetupConfigChanges(projectResult.projectDir);

  const status = await readKtxSetupStatus(projectResult.projectDir);
  io.stdout.write(formatKtxSetupStatus(status));
  io.stdout.write('\nWhat you can do next:\n');
  io.stdout.write(
    `${formatSetupNextStepLines({
      setupReady: setupStatusReady(status),
      hasContextTargets: setupHasContextTargets(status),
      contextReady: setupContextReady(status),
      agentIntegrationReady: status.agents.some((agent) => agent.ready),
    }).join('\n')}\n`,
  );
  return 0;
}
