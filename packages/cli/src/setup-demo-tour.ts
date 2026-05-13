import type { KtxCliIo } from './cli-runtime.js';
import type {
  ContextBuildTargetState,
  ContextBuildViewState,
} from './context-build-view.js';
import { createRepainter, renderContextBuildView } from './context-build-view.js';
import { defaultDemoProjectDir, ensureSeededDemoProject } from './demo-assets.js';
import type { KtxPublicIngestPlanTarget } from './public-ingest.js';
import type { KtxSetupAgentsResult } from './setup-agents.js';
import { runKtxSetupAgentsStep } from './setup-agents.js';
import { KtxSetupExitError } from './setup-interrupt.js';

// ---------------------------------------------------------------------------
// ANSI helpers (internal)
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(0x1b);

function cyan(text: string): string {
  return `${ESC}[36m${text}${ESC}[39m`;
}

function dim(text: string): string {
  return `${ESC}[2m${text}${ESC}[22m`;
}

// ---------------------------------------------------------------------------
// Demo target helpers (internal)
// ---------------------------------------------------------------------------

function createDemoTarget(
  connectionId: string,
  operation: 'database-ingest' | 'source-ingest',
  driver: string,
): KtxPublicIngestPlanTarget {
  const adapter = operation === 'source-ingest' ? driver : undefined;
  return {
    connectionId,
    driver,
    operation,
    ...(adapter ? { adapter } : {}),
    debugCommand: `ktx setup --project-dir <project-dir>`,
    steps: operation === 'database-ingest'
      ? ['database-schema']
      : ['source-ingest', 'memory-update'],
  };
}

function createTargetState(target: KtxPublicIngestPlanTarget): ContextBuildTargetState {
  return {
    target,
    status: 'queued',
    detailLine: null,
    summaryText: null,
    failureText: null,
    startedAt: null,
    elapsedMs: 0,
    progressUpdatedAtMs: null,
  };
}

// ---------------------------------------------------------------------------
// Pure rendering functions
// ---------------------------------------------------------------------------

export function renderDemoBanner(projectDir?: string): string {
  const lines = [
    '',
    `┌  ${cyan('Demo mode')} — data has been pre-processed and KTX context is already built.`,
    '│  This walkthrough illustrates the setup steps. Selections are pre-filled and read-only.',
  ];
  if (projectDir) {
    lines.push(`│  Project directory: ${dim(projectDir)}`);
  }
  return lines.join('\n');
}

export function renderDemoCardContent(title: string, selections: string[]): string {
  const lines = [
    `┌  ${title}`,
    '│',
    ...selections.map((s) => `│  ${cyan('▸')} ${s}`),
    '│',
    `│  ${dim('Press Enter to continue, Escape to go back')}`,
    '└',
  ];
  return lines.join('\n');
}

export function renderDemoAgentTransition(): string {
  const lines = [
    '┌  Demo project is ready — let\'s connect your agent',
    '│',
    '│  Your KTX context has been built with demo data.',
    '│  Select an agent to start using it.',
    '└',
  ];
  return lines.join('\n');
}

export function renderDemoCompletionSummary(projectDir: string, agentInstalled: boolean): string {
  const lines: string[] = [
    '',
    `${cyan('★')} KTX demo is ready`,
    '',
  ];

  if (agentInstalled) {
    lines.push('  Your agent is connected to a demo KTX project.');
  } else {
    lines.push('  Demo project created. Connect an agent to start using it:');
    lines.push(`  $ ${cyan(`ktx setup --agents --project-dir ${projectDir}`)}`);
  }

  lines.push(
    '',
    `  ${dim('⚠')} This project is in a temporary directory and will be`,
    '    cleaned up by your system. To set up KTX with your own',
    '    data, run: ktx setup',
    '',
    `  Project: ${projectDir}`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Keypress navigation
// ---------------------------------------------------------------------------

export async function waitForDemoNavigation(
  stdin?: NodeJS.ReadStream,
): Promise<'forward' | 'back'> {
  const input = stdin ?? process.stdin;
  const hadRawMode = input.isRaw ?? false;

  return new Promise<'forward' | 'back'>((resolve, reject) => {
    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
    }
    input.resume();

    const cleanup = () => {
      input.off('data', onData);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(hadRawMode);
      }
    };

    const onData = (data: Buffer) => {
      if (data[0] === 0x03) {
        cleanup();
        reject(new KtxSetupExitError());
      } else if (data[0] === 0x0d || data[0] === 0x0a) {
        cleanup();
        resolve('forward');
      } else if (data[0] === 0x1b) {
        cleanup();
        resolve('back');
      }
    };

    input.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// Interactive card
// ---------------------------------------------------------------------------

export async function renderDemoCard(
  title: string,
  selections: string[],
  io: KtxCliIo,
  stdin?: NodeJS.ReadStream,
  waitNav: (stdin?: NodeJS.ReadStream) => Promise<'forward' | 'back'> = waitForDemoNavigation,
  projectDir?: string,
): Promise<'forward' | 'back'> {
  io.stdout.write(renderDemoBanner(projectDir) + '\n\n');
  io.stdout.write(renderDemoCardContent(title, selections) + '\n');
  return waitNav(stdin);
}

// ---------------------------------------------------------------------------
// Context build replay
// ---------------------------------------------------------------------------

export interface DemoReplayEvent {
  delayMs: number;
  connectionId: string;
  status: 'running' | 'done';
  detailLine: string | null;
  summaryText: string | null;
}

export const DEMO_REPLAY_TARGETS = {
  primarySources: [
    createDemoTarget('postgres-warehouse', 'database-ingest', 'postgres'),
  ],
  contextSources: [
    createDemoTarget('dbt-main', 'source-ingest', 'dbt'),
    createDemoTarget('metabase-main', 'source-ingest', 'metabase'),
    createDemoTarget('notion-main', 'source-ingest', 'notion'),
  ],
} as const;

export function buildDemoReplayTimeline(): DemoReplayEvent[] {
  return [
    // postgres-warehouse: database schema context
    { delayMs: 0, connectionId: 'postgres-warehouse', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 1200, connectionId: 'postgres-warehouse', status: 'running', detailLine: '[50%] reading schema...', summaryText: null },
    { delayMs: 2400, connectionId: 'postgres-warehouse', status: 'done', detailLine: null, summaryText: '56 tables' },
    // dbt-main
    { delayMs: 2400, connectionId: 'dbt-main', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 3600, connectionId: 'dbt-main', status: 'running', detailLine: '[60%] ingesting models...', summaryText: null },
    { delayMs: 4400, connectionId: 'dbt-main', status: 'done', detailLine: null, summaryText: '34 models ingested' },
    // metabase-main
    { delayMs: 4400, connectionId: 'metabase-main', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 5600, connectionId: 'metabase-main', status: 'done', detailLine: null, summaryText: '80 cards ingested' },
    // notion-main
    { delayMs: 5600, connectionId: 'notion-main', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 6800, connectionId: 'notion-main', status: 'done', detailLine: null, summaryText: '9 pages ingested' },
  ];
}

function renderDemoContextCompletionSummary(): string {
  const lines = [
    '',
    `${cyan('★')} KTX finished building context`,
    '',
    '  KTX created:',
    `    ${cyan('📊')} 46 semantic layer definitions`,
    `    ${cyan('📝')} 28 wiki pages`,
    '',
    `  ${dim('Press Enter to continue, Escape to go back')}`,
    '',
  ];
  return lines.join('\n');
}

export async function runDemoContextReplay(
  io: KtxCliIo,
  stdin?: NodeJS.ReadStream,
): Promise<'forward' | 'back'> {
  const allPrimary = DEMO_REPLAY_TARGETS.primarySources.map(createTargetState);
  const allContext = DEMO_REPLAY_TARGETS.contextSources.map(createTargetState);

  const state: ContextBuildViewState = {
    primarySources: allPrimary,
    contextSources: allContext,
    frame: 0,
    startedAt: Date.now(),
    totalElapsedMs: 0,
  };

  const allTargets = [...allPrimary, ...allContext];
  const timeline = buildDemoReplayTimeline();

  const repainter = createRepainter(io);
  const paint = () => repainter.paint(renderContextBuildView(state, { styled: true }));

  paint();

  let eventIndex = 0;
  const startTime = Date.now();

  await new Promise<void>((resolve) => {
    const frameInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      state.frame++;
      state.totalElapsedMs = elapsed;

      // Apply all events up to the current elapsed time
      while (eventIndex < timeline.length && timeline[eventIndex].delayMs <= elapsed) {
        const event = timeline[eventIndex];
        const target = allTargets.find((t) => t.target.connectionId === event.connectionId);
        if (target) {
          target.status = event.status;
          target.detailLine = event.detailLine;
          if (event.summaryText !== null) {
            target.summaryText = event.summaryText;
          }
          if (event.status === 'running' && target.startedAt === null) {
            target.startedAt = Date.now();
          }
          if (event.status === 'done') {
            target.elapsedMs = target.startedAt !== null ? Date.now() - target.startedAt : 0;
          }
        }
        eventIndex++;
      }

      // Update running target elapsed times
      for (const t of allTargets) {
        if (t.status === 'running' && t.startedAt !== null) {
          t.elapsedMs = Date.now() - t.startedAt;
        }
      }

      paint();

      // Check if all events have been applied
      if (eventIndex >= timeline.length) {
        clearInterval(frameInterval);
        resolve();
      }
    }, 120);
  });

  // Final paint with all done
  paint();

  // Show completion summary and wait for navigation
  io.stdout.write(renderDemoContextCompletionSummary() + '\n');
  return waitForDemoNavigation(stdin);
}

// ---------------------------------------------------------------------------
// Demo tour orchestrator
// ---------------------------------------------------------------------------

type DemoStep = 'databases' | 'sources' | 'context' | 'agents';

const DEMO_STEPS: DemoStep[] = ['databases', 'sources', 'context', 'agents'];

export interface DemoTourDeps {
  agents?: (args: Parameters<typeof runKtxSetupAgentsStep>[0], io: KtxCliIo) => Promise<KtxSetupAgentsResult>;
  waitForNavigation?: (stdin?: NodeJS.ReadStream) => Promise<'forward' | 'back'>;
  ensureProject?: typeof ensureSeededDemoProject;
  skipReplayAnimation?: boolean;
}

export async function runDemoTour(
  args: { inputMode: 'auto' | 'disabled' },
  io: KtxCliIo,
  deps: DemoTourDeps = {},
): Promise<number> {
  const waitNav = deps.waitForNavigation ?? waitForDemoNavigation;
  const ensureProject = deps.ensureProject ?? ensureSeededDemoProject;

  const projectDir = defaultDemoProjectDir();
  await ensureProject({ projectDir, force: false });

  io.stdout.write(renderDemoBanner(projectDir) + '\n');
  io.stdout.write(`\n│  ${dim('Press Enter to continue, Escape to go back')}\n└\n`);
  const introDirection = await waitNav();
  if (introDirection === 'back') return 0;

  let stepIndex = 0;

  while (stepIndex < DEMO_STEPS.length) {
    const step = DEMO_STEPS[stepIndex]!;
    let direction: 'forward' | 'back';

    if (step === 'databases') {
      direction = await renderDemoCard('Database connection', ['PostgreSQL — Orbit Analytics (56 tables, 2 schemas)'], io, undefined, waitNav, projectDir);
    } else if (step === 'sources') {
      direction = await renderDemoCard('Context sources', ['dbt — 34 transformation models', 'Metabase — 80 dashboard cards', 'Notion — 9 wiki pages'], io, undefined, waitNav, projectDir);
    } else if (step === 'context') {
      io.stdout.write(renderDemoBanner(projectDir) + '\n\n');
      if (deps.skipReplayAnimation) {
        direction = await waitNav();
      } else {
        direction = await runDemoContextReplay(io);
      }
    } else {
      // agents step — real interactive
      io.stdout.write(renderDemoAgentTransition() + '\n');
      const agentsRunner = deps.agents ?? runKtxSetupAgentsStep;
      const agentsResult = await agentsRunner(
        {
          projectDir,
          inputMode: args.inputMode,
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io,
      );
      const agentInstalled = agentsResult.status === 'ready';
      if (agentsResult.status === 'back') {
        direction = 'back';
      } else {
        io.stdout.write(renderDemoCompletionSummary(projectDir, agentInstalled) + '\n');
        return 0;
      }
    }

    if (direction === 'back') {
      if (stepIndex === 0) return 0;
      stepIndex -= 1;
    } else {
      stepIndex += 1;
    }
  }

  return 0;
}
