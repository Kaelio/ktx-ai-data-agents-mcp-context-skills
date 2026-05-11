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
  operation: 'scan' | 'source-ingest',
  driver: string,
): KtxPublicIngestPlanTarget {
  const adapter = operation === 'source-ingest' ? driver : undefined;
  return {
    connectionId,
    driver,
    operation,
    ...(adapter ? { adapter } : {}),
    debugCommand: `ktx setup context build --target ${connectionId}`,
    steps: operation === 'scan'
      ? ['scan', 'enrich', 'memory-update']
      : ['source-ingest', 'enrich', 'memory-update'],
  };
}

function createTargetState(target: KtxPublicIngestPlanTarget): ContextBuildTargetState {
  return {
    target,
    status: 'queued',
    detailLine: null,
    summaryText: null,
    startedAt: null,
    elapsedMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Pure rendering functions
// ---------------------------------------------------------------------------

export function renderDemoBanner(): string {
  const lines = [
    '',
    `┌  ${cyan('Demo mode')} — data has been pre-processed and KTX context is already built.`,
    '│  This walkthrough illustrates the setup steps. Selections are pre-filled and read-only.',
  ];
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
      const char = data.toString();
      if (char === '\r' || char === '\n') {
        cleanup();
        resolve('forward');
      } else if (char === '\x1b') {
        cleanup();
        resolve('back');
      } else if (char === '\x03') {
        cleanup();
        reject(new KtxSetupExitError());
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
): Promise<'forward' | 'back'> {
  io.stdout.write(renderDemoBanner() + '\n\n');
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
    createDemoTarget('demo-warehouse', 'scan', 'postgres'),
  ],
  contextSources: [
    createDemoTarget('dbt', 'source-ingest', 'dbt'),
    createDemoTarget('metabase', 'source-ingest', 'metabase'),
    createDemoTarget('notion', 'source-ingest', 'notion'),
  ],
} as const;

export function buildDemoReplayTimeline(): DemoReplayEvent[] {
  return [
    // demo-warehouse: scan
    { delayMs: 0, connectionId: 'demo-warehouse', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 600, connectionId: 'demo-warehouse', status: 'running', detailLine: '[50%] Scanning tables...', summaryText: null },
    { delayMs: 1200, connectionId: 'demo-warehouse', status: 'done', detailLine: null, summaryText: '12 tables' },
    // dbt
    { delayMs: 1200, connectionId: 'dbt', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 1800, connectionId: 'dbt', status: 'running', detailLine: '[60%] Ingesting models...', summaryText: null },
    { delayMs: 2200, connectionId: 'dbt', status: 'done', detailLine: null, summaryText: '8 models' },
    // metabase
    { delayMs: 2200, connectionId: 'metabase', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 2800, connectionId: 'metabase', status: 'done', detailLine: null, summaryText: '5 dashboards' },
    // notion
    { delayMs: 2800, connectionId: 'notion', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 3400, connectionId: 'notion', status: 'done', detailLine: null, summaryText: '3 pages' },
  ];
}

function renderDemoContextCompletionSummary(): string {
  const lines = [
    '',
    '┌  Context build complete',
    '│',
    '│  All sources have been processed.',
    '│',
    `│  ${dim('Press Enter to continue, Escape to go back')}`,
    '└',
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

  let stepIndex = 0;

  while (stepIndex < DEMO_STEPS.length) {
    const step = DEMO_STEPS[stepIndex]!;
    let direction: 'forward' | 'back';

    if (step === 'databases') {
      direction = await renderDemoCard('Database connection', ['PostgreSQL (demo warehouse)'], io, undefined, waitNav);
    } else if (step === 'sources') {
      direction = await renderDemoCard('Context sources', ['dbt', 'Metabase', 'Notion'], io, undefined, waitNav);
    } else if (step === 'context') {
      io.stdout.write(renderDemoBanner() + '\n\n');
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
          mode: 'both',
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
