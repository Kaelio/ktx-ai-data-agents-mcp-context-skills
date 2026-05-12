# Demo Guided Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disconnected "Try KTX with packaged demo data" flow with a guided tour that walks users through the same setup wizard steps using pre-filled, read-only selections, then connects their agent to the populated demo project.

**Architecture:** A new `setup-demo-tour.ts` module owns the demo tour flow. It renders read-only cards (database, sources), a simulated context build replay using the existing `renderContextBuildView` + `createRepainter` pipeline from `context-build-view.ts`, then hands off to the real `runKtxSetupAgentsStep`. The entry point in `setup.ts` (`runKtxSetupDemoFromEntryMenu`) is rewired to call this new module instead of `runKtxDemo`.

**Tech Stack:** TypeScript (ESM), Node.js raw stdin for keypress handling, existing `@clack/prompts` visual patterns, vitest for tests.

---

### Task 1: Create `setup-demo-tour.ts` with keypress utility and banner

**Files:**
- Create: `packages/cli/src/setup-demo-tour.ts`
- Test: `packages/cli/src/setup-demo-tour.test.ts`

- [ ] **Step 1: Write the failing test for `renderDemoBanner`**

```typescript
// packages/cli/src/setup-demo-tour.test.ts
import { describe, expect, it } from 'vitest';
import { renderDemoBanner } from './setup-demo-tour.js';

describe('renderDemoBanner', () => {
  it('includes demo mode explanation', () => {
    const output = renderDemoBanner();
    expect(output).toContain('Demo mode');
    expect(output).toContain('pre-processed');
    expect(output).toContain('read-only');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `renderDemoBanner` and `waitForDemoNavigation`**

```typescript
// packages/cli/src/setup-demo-tour.ts
import type { KtxCliIo } from './cli-runtime.js';
import { KtxSetupExitError } from './setup-interrupt.js';

const ESC = String.fromCharCode(0x1b);

function cyan(text: string): string {
  return `${ESC}[36m${text}${ESC}[39m`;
}

function dim(text: string): string {
  return `${ESC}[2m${text}${ESC}[22m`;
}

export function renderDemoBanner(): string {
  const lines = [
    '',
    `┌  ${cyan('Demo mode')} — data has been pre-processed and KTX context is already built.`,
    `│  This walkthrough illustrates the setup steps. Selections are pre-filled and read-only.`,
    '',
  ];
  return lines.join('\n');
}

export async function waitForDemoNavigation(
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<'forward' | 'back'> {
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve('forward');
      } else if (key === '\x1b') {
        cleanup();
        resolve('back');
      } else if (key === '\x03') {
        cleanup();
        reject(new KtxSetupExitError());
      }
    };

    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
    };

    stdin.on('data', onData);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "feat(cli): add demo tour banner and keypress navigation utility"
```

---

### Task 2: Add `renderDemoCard` function

**Files:**
- Modify: `packages/cli/src/setup-demo-tour.ts`
- Modify: `packages/cli/src/setup-demo-tour.test.ts`

- [ ] **Step 1: Write the failing test for `renderDemoCard`**

Append to the test file:

```typescript
import { renderDemoCardContent } from './setup-demo-tour.js';

describe('renderDemoCardContent', () => {
  it('renders a card with title and selections', () => {
    const output = renderDemoCardContent('Database connection', ['PostgreSQL (demo warehouse)']);
    expect(output).toContain('Database connection');
    expect(output).toContain('PostgreSQL (demo warehouse)');
    expect(output).toContain('Press Enter to continue');
    expect(output).toContain('Escape to go back');
  });

  it('renders multiple selections', () => {
    const output = renderDemoCardContent('Context sources', ['dbt', 'Metabase', 'Notion']);
    expect(output).toContain('dbt');
    expect(output).toContain('Metabase');
    expect(output).toContain('Notion');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: FAIL — `renderDemoCardContent` not exported

- [ ] **Step 3: Implement `renderDemoCardContent` and `renderDemoCard`**

Add to `setup-demo-tour.ts`:

```typescript
export function renderDemoCardContent(title: string, selections: string[]): string {
  const lines = [
    `┌  ${title}`,
    '│',
    ...selections.map((s) => `│  ${cyan('▸')} ${s}`),
    '│',
    `│  ${dim('Press Enter to continue, Escape to go back')}`,
    '└',
    '',
  ];
  return lines.join('\n');
}

export async function renderDemoCard(
  title: string,
  selections: string[],
  io: KtxCliIo,
  stdin?: NodeJS.ReadStream,
  waitNav?: (stdin?: NodeJS.ReadStream) => Promise<'forward' | 'back'>,
): Promise<'forward' | 'back'> {
  io.stdout.write(renderDemoBanner());
  io.stdout.write(renderDemoCardContent(title, selections));
  const nav = waitNav ?? waitForDemoNavigation;
  return nav(stdin);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "feat(cli): add demo tour read-only card rendering"
```

---

### Task 3: Add demo context build replay animation

**Files:**
- Modify: `packages/cli/src/setup-demo-tour.ts`
- Modify: `packages/cli/src/setup-demo-tour.test.ts`

- [ ] **Step 1: Write the failing test for demo replay event sequence**

Append to the test file:

```typescript
import { buildDemoReplayTimeline, DEMO_REPLAY_TARGETS } from './setup-demo-tour.js';

describe('buildDemoReplayTimeline', () => {
  it('produces events for all four demo targets', () => {
    const events = buildDemoReplayTimeline();
    const connectionIds = new Set(events.map((e) => e.connectionId));
    expect(connectionIds).toEqual(new Set(['demo-warehouse', 'dbt', 'metabase', 'notion']));
  });

  it('ends with all targets done', () => {
    const events = buildDemoReplayTimeline();
    const lastByConnection = new Map<string, string>();
    for (const e of events) {
      lastByConnection.set(e.connectionId, e.status);
    }
    for (const status of lastByConnection.values()) {
      expect(status).toBe('done');
    }
  });

  it('events are sorted by delayMs', () => {
    const events = buildDemoReplayTimeline();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.delayMs).toBeGreaterThanOrEqual(events[i - 1]!.delayMs);
    }
  });
});

describe('DEMO_REPLAY_TARGETS', () => {
  it('has one primary source and three context sources', () => {
    expect(DEMO_REPLAY_TARGETS.primarySources).toHaveLength(1);
    expect(DEMO_REPLAY_TARGETS.contextSources).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: FAIL — exports not found

- [ ] **Step 3: Implement replay timeline and target definitions**

Add to `setup-demo-tour.ts`:

```typescript
import type { KtxPublicIngestPlanTarget } from './public-ingest.js';
import type { ContextBuildTargetState, ContextBuildViewState } from './context-build-view.js';

export interface DemoReplayEvent {
  delayMs: number;
  connectionId: string;
  status: 'running' | 'done';
  detailLine: string | null;
  summaryText: string | null;
}

function createDemoTarget(connectionId: string, operation: 'scan' | 'source-ingest', driver: string): KtxPublicIngestPlanTarget {
  return {
    connectionId,
    driver,
    operation,
    debugCommand: `ktx ${operation === 'scan' ? 'scan' : 'ingest'} ${connectionId}`,
    steps: operation === 'scan' ? ['scan'] : ['source-ingest'],
  };
}

const primaryTarget = createDemoTarget('demo-warehouse', 'scan', 'postgres');
const dbtTarget = createDemoTarget('dbt', 'source-ingest', 'dbt');
const metabaseTarget = createDemoTarget('metabase', 'source-ingest', 'metabase');
const notionTarget = createDemoTarget('notion', 'source-ingest', 'notion');

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

export const DEMO_REPLAY_TARGETS = {
  primarySources: [primaryTarget],
  contextSources: [dbtTarget, metabaseTarget, notionTarget],
};

export function buildDemoReplayTimeline(): DemoReplayEvent[] {
  return [
    { delayMs: 0, connectionId: 'demo-warehouse', status: 'running', detailLine: 'scanning...', summaryText: null },
    { delayMs: 600, connectionId: 'demo-warehouse', status: 'running', detailLine: '[50%] scanning...', summaryText: null },
    { delayMs: 1200, connectionId: 'demo-warehouse', status: 'done', detailLine: null, summaryText: 'completed' },
    { delayMs: 1200, connectionId: 'dbt', status: 'running', detailLine: 'ingesting...', summaryText: null },
    { delayMs: 1800, connectionId: 'dbt', status: 'running', detailLine: '[60%] ingesting...', summaryText: null },
    { delayMs: 2200, connectionId: 'dbt', status: 'done', detailLine: null, summaryText: 'completed' },
    { delayMs: 2200, connectionId: 'metabase', status: 'running', detailLine: 'ingesting...', summaryText: null },
    { delayMs: 2800, connectionId: 'metabase', status: 'done', detailLine: null, summaryText: 'completed' },
    { delayMs: 2800, connectionId: 'notion', status: 'running', detailLine: 'ingesting...', summaryText: null },
    { delayMs: 3400, connectionId: 'notion', status: 'done', detailLine: null, summaryText: 'completed' },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: PASS

- [ ] **Step 5: Implement `runDemoContextReplay` animation driver**

Add to `setup-demo-tour.ts`:

```typescript
import { renderContextBuildView, createRepainter } from './context-build-view.js';

export async function runDemoContextReplay(
  io: KtxCliIo,
  stdin?: NodeJS.ReadStream,
): Promise<'forward' | 'back'> {
  const repainter = createRepainter(io);
  const timeline = buildDemoReplayTimeline();

  const state: ContextBuildViewState = {
    primarySources: DEMO_REPLAY_TARGETS.primarySources.map((t) => createTargetState(t)),
    contextSources: DEMO_REPLAY_TARGETS.contextSources.map((t) => createTargetState(t)),
    frame: 0,
    startedAt: Date.now(),
    totalElapsedMs: 0,
  };

  const allTargets = [...state.primarySources, ...state.contextSources];
  const targetMap = new Map(allTargets.map((t) => [t.target.connectionId, t]));
  let eventIndex = 0;
  const startTime = Date.now();
  const FRAME_MS = 120;

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      state.frame += 1;
      state.totalElapsedMs = elapsed;

      while (eventIndex < timeline.length && timeline[eventIndex]!.delayMs <= elapsed) {
        const event = timeline[eventIndex]!;
        const target = targetMap.get(event.connectionId);
        if (target) {
          target.status = event.status;
          target.detailLine = event.detailLine;
          target.summaryText = event.summaryText;
          if (event.status === 'running' && target.startedAt === null) {
            target.startedAt = Date.now();
          }
          if (event.status === 'done') {
            target.elapsedMs = target.startedAt ? Date.now() - target.startedAt : 0;
          }
        }
        eventIndex += 1;
      }

      for (const t of allTargets) {
        if (t.status === 'running' && t.startedAt !== null) {
          t.elapsedMs = Date.now() - t.startedAt;
        }
      }

      repainter.paint(renderContextBuildView(state, { styled: io.stdout.isTTY ?? false, showHint: false }));

      if (eventIndex >= timeline.length && allTargets.every((t) => t.status === 'done')) {
        clearInterval(interval);
        resolve();
      }
    }, FRAME_MS);
  });

  io.stdout.write(renderDemoContextCompletionSummary());
  return waitForDemoNavigation(stdin);
}

function renderDemoContextCompletionSummary(): string {
  const lines = [
    '',
    `${cyan('★')} KTX finished ingesting demo data`,
    '',
    '  Placeholder — final counts will come from pre-packaged demo results.',
    '',
    `  ${dim('Press Enter to continue, Escape to go back')}`,
    '',
  ];
  return lines.join('\n');
}
```

Note: `renderDemoContextCompletionSummary` is a placeholder that will be updated when
the user provides the real pre-packaged demo data. The summary counts (business areas,
query definitions, knowledge pages) will be populated from those assets.

- [ ] **Step 6: Run tests and type-check**

Run: `pnpm --filter @ktx/cli run type-check && pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "feat(cli): add demo context build replay animation"
```

---

### Task 4: Add transition message and completion summary

**Files:**
- Modify: `packages/cli/src/setup-demo-tour.ts`
- Modify: `packages/cli/src/setup-demo-tour.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to test file:

```typescript
import { renderDemoAgentTransition, renderDemoCompletionSummary } from './setup-demo-tour.js';

describe('renderDemoAgentTransition', () => {
  it('includes transition message about connecting agent', () => {
    const output = renderDemoAgentTransition();
    expect(output).toContain('Demo project is ready');
    expect(output).toContain('connect your agent');
  });
});

describe('renderDemoCompletionSummary', () => {
  it('includes project path and temp warning', () => {
    const output = renderDemoCompletionSummary('/tmp/ktx-demo-abc123', true);
    expect(output).toContain('/tmp/ktx-demo-abc123');
    expect(output).toContain('temporary');
    expect(output).toContain('ktx setup');
  });

  it('shows manual agent instructions when agent not installed', () => {
    const output = renderDemoCompletionSummary('/tmp/ktx-demo-abc123', false);
    expect(output).toContain('ktx setup --agents');
  });

  it('shows success message when agent installed', () => {
    const output = renderDemoCompletionSummary('/tmp/ktx-demo-abc123', true);
    expect(output).toContain('agent is connected');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: FAIL — exports not found

- [ ] **Step 3: Implement transition and completion rendering**

Add to `setup-demo-tour.ts`:

```typescript
export function renderDemoAgentTransition(): string {
  const lines = [
    '',
    `┌  Demo project is ready — let's connect your agent`,
    '│',
    '│  Your KTX context has been built with demo data.',
    '│  Select an agent to start using it.',
    '└',
    '',
  ];
  return lines.join('\n');
}

export function renderDemoCompletionSummary(projectDir: string, agentInstalled: boolean): string {
  const lines = [
    '',
    `${cyan('★')} KTX demo is ready`,
    '',
  ];

  if (agentInstalled) {
    lines.push('  Your agent is connected to a demo KTX project.');
  } else {
    lines.push('  Demo project created. Connect an agent to start using it:');
    lines.push(`  $ ktx setup --agents --project-dir ${projectDir}`);
  }

  lines.push(
    '',
    `  ${dim('⚠')} This project is in a temporary directory and will be`,
    `    cleaned up by your system. To set up KTX with your own`,
    '    data, run: ktx setup',
    '',
    `  Project: ${projectDir}`,
    '',
  );
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "feat(cli): add demo tour transition and completion summary"
```

---

### Task 5: Implement `runDemoTour` orchestrator

**Files:**
- Modify: `packages/cli/src/setup-demo-tour.ts`
- Modify: `packages/cli/src/setup-demo-tour.test.ts`

- [ ] **Step 1: Write the failing test for the orchestrator**

Append to test file:

```typescript
import { vi } from 'vitest';
import type { KtxSetupAgentsResult } from './setup-agents.js';
import { runDemoTour } from './setup-demo-tour.js';

describe('runDemoTour', () => {
  function createMockIo() {
    const chunks: string[] = [];
    return {
      io: {
        stdout: { isTTY: true, columns: 80, write: (chunk: string) => { chunks.push(chunk); } },
        stderr: { write: () => {} },
      },
      chunks,
    };
  }

  it('returns 0 on successful tour with agent installed', async () => {
    const { io } = createMockIo();
    const mockAgents = vi.fn<() => Promise<KtxSetupAgentsResult>>().mockResolvedValue({
      status: 'ready',
      projectDir: '/tmp/test',
      installs: [{ target: 'claude-code' as const, scope: 'project' as const, mode: 'both' as const }],
    });

    const navigation = vi.fn<() => Promise<'forward' | 'back'>>().mockResolvedValue('forward');

    const result = await runDemoTour(
      { inputMode: 'auto' },
      io,
      { agents: mockAgents, waitForNavigation: navigation, skipReplayAnimation: true },
    );
    expect(result).toBe(0);
    expect(mockAgents).toHaveBeenCalled();
  });

  it('handles back navigation from first step', async () => {
    const { io } = createMockIo();
    const navigation = vi.fn<() => Promise<'forward' | 'back'>>().mockResolvedValue('back');

    const result = await runDemoTour(
      { inputMode: 'auto' },
      io,
      { waitForNavigation: navigation, skipReplayAnimation: true },
    );
    expect(result).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: FAIL — `runDemoTour` not exported or wrong signature

- [ ] **Step 3: Implement `runDemoTour`**

Add to `setup-demo-tour.ts`:

```typescript
import { defaultDemoProjectDir, ensureSeededDemoProject } from './demo-assets.js';
import type { KtxSetupAgentsResult } from './setup-agents.js';
import { runKtxSetupAgentsStep } from './setup-agents.js';

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
  await ensureProject({ projectDir });

  let stepIndex = 0;

  while (stepIndex < DEMO_STEPS.length) {
    const step = DEMO_STEPS[stepIndex]!;
    let direction: 'forward' | 'back';

    if (step === 'databases') {
      direction = await renderDemoCard('Database connection', ['PostgreSQL (demo warehouse)'], io, undefined, waitNav);
    } else if (step === 'sources') {
      direction = await renderDemoCard('Context sources', ['dbt', 'Metabase', 'Notion'], io, undefined, waitNav);
    } else if (step === 'context') {
      io.stdout.write(renderDemoBanner());
      if (deps.skipReplayAnimation) {
        direction = await waitNav();
      } else {
        direction = await runDemoContextReplay(io);
      }
    } else {
      io.stdout.write(renderDemoAgentTransition());
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
        io.stdout.write(renderDemoCompletionSummary(projectDir, agentInstalled));
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ktx/cli run test -- --testPathPattern setup-demo-tour`
Expected: PASS

- [ ] **Step 5: Run type-check**

Run: `pnpm --filter @ktx/cli run type-check`
Expected: PASS — all types align with existing interfaces

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "feat(cli): add runDemoTour orchestrator with step navigation"
```

---

### Task 6: Wire up in `setup.ts`

**Files:**
- Modify: `packages/cli/src/setup.ts`

- [ ] **Step 1: Read the current `runKtxSetupDemoFromEntryMenu` function**

Read `packages/cli/src/setup.ts` and locate `runKtxSetupDemoFromEntryMenu` (around lines 218-233).

Current implementation:
```typescript
async function runKtxSetupDemoFromEntryMenu(
  args: Extract<KtxSetupArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxSetupDeps,
): Promise<number> {
  const runner = deps.demo ?? (await import('./demo.js')).runKtxDemo;
  return await runner(
    {
      command: 'seeded',
      projectDir: defaultDemoProjectDir(),
      outputMode: 'viz',
      inputMode: args.inputMode,
    },
    io,
  );
}
```

- [ ] **Step 2: Replace with demo tour call**

Replace the function body to call `runDemoTour`:

```typescript
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
```

- [ ] **Step 3: Update imports — remove unused `defaultDemoProjectDir` import if no longer needed elsewhere in setup.ts**

Check if `defaultDemoProjectDir` is used elsewhere in `setup.ts`. If it's only used
in `runKtxSetupDemoFromEntryMenu`, remove the import. If used elsewhere, keep it.

Also check if the `KtxDemoArgs` import is still needed. If `runKtxSetupDemoFromEntryMenu`
was the only consumer of `deps.demo` with that type, it may now be unused. Keep the
`demo` slot in `KtxSetupDeps` for backwards compatibility but it will no longer be
called from the entry menu path.

- [ ] **Step 4: Run type-check and tests**

Run: `pnpm --filter @ktx/cli run type-check && pnpm --filter @ktx/cli run test`
Expected: PASS — existing tests continue to work, demo tour is now wired in

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts
git commit -m "feat(cli): wire demo tour into setup entry menu"
```

---

### Task 7: End-to-end verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm --filter @ktx/cli run test 2>&1 | tee /tmp/ktx-demo-tour-test.log`
Expected: All tests pass. Check the output for any regressions.

- [ ] **Step 2: Run type-check across workspace**

Run: `pnpm run type-check`
Expected: PASS

- [ ] **Step 3: Run pre-commit checks if available**

Run: `pnpm run check` (if configured)
Expected: PASS

- [ ] **Step 4: Manual smoke test (if TTY available)**

Run: `pnpm --filter @ktx/cli run build && node packages/cli/dist/cli.js setup`

1. Select "Try KTX with packaged demo data"
2. Verify demo banner appears with full explanation text
3. Verify "Database connection" card shows with "PostgreSQL (demo warehouse)"
4. Press Enter → verify "Context sources" card shows with dbt, Metabase, Notion
5. Press Escape → verify you go back to database card
6. Press Enter twice → verify context build replay animation runs
7. Verify completion summary appears after replay
8. Press Enter → verify agents step prompt appears (interactive)
9. Press Escape all the way back → verify you return to entry menu

- [ ] **Step 5: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "fix(cli): demo tour adjustments from smoke test"
```

---

## Open Seams for Demo Data

When the user provides the real pre-packaged demo results, update these locations:

1. **`renderDemoContextCompletionSummary()`** in `setup-demo-tour.ts` — replace placeholder text with actual counts (business areas, query definitions, knowledge pages) from the demo data
2. **`buildDemoReplayTimeline()`** in `setup-demo-tour.ts` — adjust timing and progress details to match the real ingestion profile
3. **`demo-assets.ts`** — update `REQUIRED_SEEDED_ASSET_PATHS` and `demoConfig()` if the demo dataset changes from SQLite/Orbit to Postgres/dbt/Metabase/Notion
4. **Pre-packaged asset files** in `packages/cli/assets/demo/` — replace with the new demo dataset
