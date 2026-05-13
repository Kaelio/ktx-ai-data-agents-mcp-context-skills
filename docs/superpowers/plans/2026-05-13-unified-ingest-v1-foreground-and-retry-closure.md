# Unified Ingest V1 Foreground and Retry Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking public UX gaps in the unified
`ktx ingest` redesign.

**Architecture:** Keep the implemented connection-centric ingest planner and
shared foreground context-build view. Add a small public messaging layer for
notices, warnings, and retry guidance so TTY, non-TTY, and setup next-step
surfaces all match the original spec without changing internal adapter names.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages,
Markdown plan documentation.

---

## Current audit

The implemented unified-ingest plans cover the main v1 behavior:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` route through the public ingest planner.
- Database targets run before source targets. Public source ingest bypasses
  `ingest.adapters`. Fast and deep map to structural and enriched database
  ingest, and deep readiness failures are isolated per target under `--all`.
- `ktx scan`, `ktx ingest run`, and `ktx ingest watch` are hidden from normal
  help. Setup stores `connections.<id>.context.depth` and
  `connections.<id>.context.queryHistory`.
- Setup context builds are foreground-only, legacy context-build states are
  normalized to stale, and public docs no longer advertise `ktx scan` or
  adapter-backed `ktx ingest run` as normal workflows.

### V1-blocking gaps

- Interactive foreground `ktx ingest` and setup context builds compute public
  warnings but never render them. A TTY user can pass `--deep` for source
  connections, `--query-history` for unsupported targets, or `--fast` with
  stored query history and receive no warning in the foreground view.
- Explicit query-history runs do not state that database schema ingest runs
  before query-history processing. The spec requires that message when a user
  explicitly passes `--query-history`.
- Plain non-TTY failures report generic step failures such as
  `warehouse failed at database-schema.` and a debug command, but they do not
  include the retry guidance required by the error-handling section.
- Setup next-step output still describes the context-build action as
  `Build or resume agent-ready context` through `ktx setup`, and it says the
  build covers `primary-source scans and context-source ingests`. The public
  model is `setup` configures, `ingest` builds or refreshes context, and status
  explains readiness.
- The guided demo foreground replay still shows `scanning tables...` and
  `tables scanned`, even though the normal foreground view must use
  `reading schema` or `building schema context`.

### Non-blocking gaps

- Hidden debug commands can continue to call `ktx scan`, `ktx ingest run`, and
  `ktx ingest watch`.
- Internal adapter keys, raw artifact paths, WorkUnit keys, package names, and
  JSON or debug output can continue to use `scan`, `live-database`, and
  `historic-sql`.
- Developer docs can continue to mention scan internals when they describe
  connector implementation details.
- Existing `autoWatch`, `detached`, and `paused` type remnants in setup code
  are not user-facing because setup context state is normalized before display.

## File structure

- Modify `packages/cli/src/public-ingest.ts`: add public plan notices, print
  schema-before-query-history notices, and add retry guidance to plain
  non-TTY failure details.
- Modify `packages/cli/src/public-ingest.test.ts`: cover explicit
  query-history notices and retry guidance in plain output.
- Modify `packages/cli/src/context-build-view.ts`: render foreground notices
  and warnings from `buildPublicIngestPlan`.
- Modify `packages/cli/src/context-build-view.test.ts`: cover warning and
  notice rendering in the foreground view.
- Modify `packages/cli/src/next-steps.ts`: make the public build command
  `ktx ingest --all` and remove resume/scan wording from setup next steps.
- Modify `packages/cli/src/next-steps.test.ts`: update public next-step
  expectations.
- Modify `packages/cli/src/setup-demo-tour.ts`: replace demo replay scan copy
  with schema-context copy.
- Modify `packages/cli/src/setup-demo-tour.test.ts`: lock the demo replay
  wording against `scan` terms.

## Tasks

### Task 1: Render foreground notices and warnings

**Files:**
- Modify: `packages/cli/src/context-build-view.ts`
- Test: `packages/cli/src/context-build-view.test.ts`

- [ ] **Step 1: Write failing foreground-message tests**

In `packages/cli/src/context-build-view.test.ts`, add these tests inside the
`renderContextBuildView` describe block, near the existing rendering tests:

```ts
  it('renders public warnings in the foreground view', () => {
    const state = initViewState([
      {
        connectionId: 'docs',
        driver: 'notion',
        operation: 'source-ingest',
        adapter: 'notion',
        debugCommand: 'ktx ingest docs --debug',
        steps: ['source-ingest', 'memory-update'],
      },
    ]);

    const rendered = renderContextBuildView(state, {
      styled: false,
      warnings: ['--deep affects database ingest only; ignoring it for docs.'],
    });

    expect(rendered).toContain('Warnings:');
    expect(rendered).toContain('--deep affects database ingest only; ignoring it for docs.');
  });

  it('renders public notices in the foreground view before warnings', () => {
    const state = initViewState([
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        operation: 'database-ingest',
        debugCommand: 'ktx ingest warehouse --debug',
        steps: ['database-schema', 'query-history'],
        databaseDepth: 'deep',
        detectRelationships: true,
        queryHistory: { enabled: true, dialect: 'postgres' },
      },
    ]);

    const rendered = renderContextBuildView(state, {
      styled: false,
      notices: ['Schema ingest runs before query history for warehouse.'],
      warnings: ['--query-history requires deep ingest; running warehouse with --deep.'],
    });

    expect(rendered.indexOf('Notices:')).toBeLessThan(rendered.indexOf('Warnings:'));
    expect(rendered).toContain('Schema ingest runs before query history for warehouse.');
    expect(rendered).toContain('--query-history requires deep ingest; running warehouse with --deep.');
  });
```

- [ ] **Step 2: Run the failing foreground-message tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts -t "renders public warnings|renders public notices"
```

Expected: FAIL because `renderContextBuildView` does not accept or render
`warnings` or `notices`.

- [ ] **Step 3: Add render options for foreground messages**

In `packages/cli/src/context-build-view.ts`, add this helper after
`renderTargetGroup`:

```ts
function renderMessageGroup(label: string, messages: string[], styled: boolean): string[] {
  if (messages.length === 0) return [];
  const renderedMessages = messages.map((message) => `    - ${message}`);
  return ['', `  ${label}:`, ...renderedMessages.map((line) => (styled ? dim(line) : line))];
}
```

Then change the `renderContextBuildView` signature from:

```ts
export function renderContextBuildView(
  state: ContextBuildViewState,
  options: { styled?: boolean; showHint?: boolean; hintText?: string; projectDir?: string } = {},
): string {
```

to:

```ts
export function renderContextBuildView(
  state: ContextBuildViewState,
  options: {
    styled?: boolean;
    showHint?: boolean;
    hintText?: string;
    projectDir?: string;
    notices?: string[];
    warnings?: string[];
  } = {},
): string {
```

In the `lines` array inside `renderContextBuildView`, insert the notice and
warning groups after the `Context sources` group:

```ts
    ...renderTargetGroup('Databases', state.primarySources, state.frame, styled, width),
    ...renderTargetGroup('Context sources', state.contextSources, state.frame, styled, width),
    ...renderMessageGroup('Notices', options.notices ?? [], styled),
    ...renderMessageGroup('Warnings', options.warnings ?? [], styled),
    '',
```

- [ ] **Step 4: Pass plan messages into foreground rendering**

In `packages/cli/src/context-build-view.ts`, inside `runContextBuild`, change:

```ts
  const viewOpts = { styled: true, projectDir: args.projectDir };
```

to:

```ts
  const viewOpts = {
    styled: true,
    projectDir: args.projectDir,
    notices: plan.notices ?? [],
    warnings: plan.warnings,
  };
```

This makes every call to `paint()` and the final non-TTY foreground fallback
render the same public messages.

- [ ] **Step 5: Run the foreground-message tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts -t "renders public warnings|renders public notices"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts
git commit -m "fix: render unified ingest foreground warnings"
```

### Task 2: State schema-before-query-history for explicit runs

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/context-build-view.ts`
- Test: `packages/cli/src/public-ingest.test.ts`
- Test: `packages/cli/src/context-build-view.test.ts`

- [ ] **Step 1: Write failing explicit query-history notice tests**

In `packages/cli/src/public-ingest.test.ts`, add this test inside
`describe('buildPublicIngestPlan', ...)` after the existing query-history
planning tests:

```ts
  it('adds a schema-first notice when query history is explicitly enabled', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        queryHistory: 'enabled',
      }).notices,
    ).toEqual(['Schema ingest runs before query history for warehouse.']);
  });
```

In `packages/cli/src/public-ingest.test.ts`, add this test inside
`describe('runKtxPublicIngest', ...)` after
`runs query history after schema ingest with current-run window override`:

```ts
  it('prints the schema-first notice for explicit query-history runs', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Schema ingest runs before query history for warehouse.');
  });
```

In `packages/cli/src/context-build-view.test.ts`, add this test near the
existing `runContextBuild` tests:

```ts
  it('passes schema-first notices from the plan into foreground output', async () => {
    const io = makeIo();
    const project = {
      ...projectWithConnections({
        warehouse: { driver: 'postgres', context: { depth: 'deep' } },
      }),
      config: {
        ...projectWithConnections({ warehouse: { driver: 'postgres' } }).config,
        connections: {
          warehouse: { driver: 'postgres', context: { depth: 'deep' } },
        },
        llm: {
          provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } }, // pragma: allowlist secret
          models: { default: 'gpt-test' },
        },
        scan: {
          ...projectWithConnections({ warehouse: { driver: 'postgres' } }).config.scan,
          enrichment: {
            mode: 'llm',
            embeddings: {
              backend: 'openai',
              model: 'text-embedding-3-small',
              dimensions: 1536,
            },
          },
        },
      },
    };
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await expect(
      runContextBuild(
        project,
        {
          projectDir: '/tmp/project',
          inputMode: 'disabled',
          targetConnectionId: 'warehouse',
          all: false,
          queryHistory: 'enabled',
        },
        io.io,
        { executeTarget, now: () => 1000 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(io.stdout()).toContain('Schema ingest runs before query history for warehouse.');
  });
```

- [ ] **Step 2: Run the failing query-history notice tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/context-build-view.test.ts -t "schema-first notice|passes schema-first"
```

Expected: FAIL because plans do not include `notices`, and plain output does
not print schema-first text.

- [ ] **Step 3: Add notices to the public ingest plan**

In `packages/cli/src/public-ingest.ts`, update `KtxPublicIngestPlan`:

```ts
export interface KtxPublicIngestPlan {
  projectDir: string;
  targets: KtxPublicIngestPlanTarget[];
  warnings: string[];
  notices?: string[];
}
```

Add this helper after `finalizeWarnings`:

```ts
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
```

In `buildPublicIngestPlan`, replace the direct return with:

```ts
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
```

- [ ] **Step 4: Print notices in plain public ingest**

In `packages/cli/src/public-ingest.ts`, inside `runKtxPublicIngest`, change:

```ts
  if (!args.json && plan.warnings.length > 0) {
    for (const warning of plan.warnings) {
      io.stderr.write(`Warning: ${warning}\n`);
    }
  }
```

to:

```ts
  if (!args.json) {
    for (const notice of plan.notices ?? []) {
      io.stdout.write(`${notice}\n`);
    }
    for (const warning of plan.warnings) {
      io.stderr.write(`Warning: ${warning}\n`);
    }
  }
```

Task 1 already passes `plan.notices` into `runContextBuild`, so explicit
query-history foreground runs render the same notice in the view.

- [ ] **Step 5: Run the query-history notice tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/context-build-view.test.ts -t "schema-first notice|passes schema-first"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts
git commit -m "fix: explain query history schema order"
```

### Task 3: Add retry guidance to plain public failures

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write failing plain retry tests**

In `packages/cli/src/public-ingest.test.ts`, replace these assertions in
`runs all independent targets and reports partial failures`:

```ts
    expect(io.stdout()).toContain('warehouse failed at database-schema.');
    expect(io.stdout()).toContain('Debug: ktx ingest warehouse --debug');
```

with:

```ts
    expect(io.stdout()).toContain('warehouse failed at database-schema.');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --fast');
    expect(io.stdout()).not.toContain('Debug: ktx ingest warehouse --debug');
```

Then add this test after `runs all independent targets and reports partial
failures`:

```ts
  it('prints query-history retry guidance for query-history facet failures', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async () => 1);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'enabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(1);

    expect(io.stdout()).toContain('warehouse failed at query-history.');
    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project --deep --query-history');
    expect(io.stdout()).not.toContain('historic-sql');
  });
```

- [ ] **Step 2: Run the failing retry tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "partial failures|query-history retry"
```

Expected: FAIL because plain failures still print `Debug:` and lack retry
commands.

- [ ] **Step 3: Add retry command formatting to public ingest**

In `packages/cli/src/public-ingest.ts`, add these helpers before
`markTargetResult`:

```ts
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
```

- [ ] **Step 4: Thread run args into failure detail construction**

Change the `markTargetResult` signature in `packages/cli/src/public-ingest.ts`
from:

```ts
function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
  failureDetail?: string,
): KtxPublicIngestTargetResult {
```

to:

```ts
function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
  failureDetail?: string,
): KtxPublicIngestTargetResult {
```

Inside the failed-step branch, replace:

```ts
          detail: failureDetail ?? `${target.connectionId} failed at ${selectedFailedOperation}.`,
```

with:

```ts
          detail: failureDetailWithRetry({
            target,
            args,
            failedOperation: selectedFailedOperation,
            failureDetail,
          }),
```

Update every `markTargetResult` call in `executePublicIngestTarget`:

```ts
      return markTargetResult(
        target,
        args,
        'failed',
        'database-schema',
        capturedScanIo ? firstCapturedFailureLine(capturedScanIo.capturedOutput()) : undefined,
      );
```

```ts
        return markTargetResult(target, args, 'failed', 'query-history');
```

```ts
    return markTargetResult(target, args, 'done');
```

```ts
  return markTargetResult(target, args, exitCode === 0 ? 'done' : 'failed');
```

- [ ] **Step 5: Stop printing debug commands in plain failure summaries**

In `renderPlainResults`, remove this block:

```ts
    if (failedStep.debugCommand) {
      io.stdout.write(`  Debug: ${failedStep.debugCommand}\n`);
    }
```

Debug commands remain available through JSON and debug surfaces, but normal
plain output now focuses on the connection and retry action.

- [ ] **Step 6: Run the retry tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "partial failures|query-history retry"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix: add public ingest retry guidance"
```

### Task 4: Replace setup next-step scan/resume wording

**Files:**
- Modify: `packages/cli/src/next-steps.ts`
- Test: `packages/cli/src/next-steps.test.ts`

- [ ] **Step 1: Write failing next-step copy tests**

In `packages/cli/src/next-steps.test.ts`, replace the expected
`KTX_CONTEXT_BUILD_COMMANDS` value with:

```ts
    expect(KTX_CONTEXT_BUILD_COMMANDS).toEqual([
      {
        command: 'ktx ingest --all',
        description: 'Build or refresh agent-ready context from configured connections',
      },
      {
        command: 'ktx status',
        description: 'Check setup and context readiness',
      },
    ]);
```

In the test named `keeps setup next steps focused on building context when the
build is not ready`, replace:

```ts
    expect(rendered).toContain('primary-source scans and context-source ingests');
    expect(rendered).toContain('ktx setup');
```

with:

```ts
    expect(rendered).toContain('Run ingest to build database schema context before context-source ingest.');
    expect(rendered).toContain('ktx ingest --all');
    expect(rendered).not.toContain('resume');
    expect(rendered).not.toContain('scan');
```

- [ ] **Step 2: Run the failing next-step copy tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/next-steps.test.ts
```

Expected: FAIL because the current copy still recommends `ktx setup` for the
context-build action and uses resume/scan wording.

- [ ] **Step 3: Update the next-step command constants**

In `packages/cli/src/next-steps.ts`, change `KTX_CONTEXT_BUILD_COMMANDS` to:

```ts
export const KTX_CONTEXT_BUILD_COMMANDS = [
  {
    command: 'ktx ingest --all',
    description: 'Build or refresh agent-ready context from configured connections',
  },
  {
    command: 'ktx status',
    description: 'Check setup and context readiness',
  },
] as const;
```

In `formatSetupNextStepLines`, replace:

```ts
      `${indent}Preferred route: run the CLI build; it covers primary-source scans and context-source ingests.`,
```

with:

```ts
      `${indent}Run ingest to build database schema context before context-source ingest.`,
```

- [ ] **Step 4: Run the next-step copy tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/next-steps.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/next-steps.ts packages/cli/src/next-steps.test.ts
git commit -m "fix: align setup next steps with unified ingest"
```

### Task 5: Clean guided demo foreground scan wording

**Files:**
- Modify: `packages/cli/src/setup-demo-tour.ts`
- Test: `packages/cli/src/setup-demo-tour.test.ts`

- [ ] **Step 1: Write failing demo wording tests**

In `packages/cli/src/setup-demo-tour.test.ts`, add this test inside
`describe('buildDemoReplayTimeline', ...)`:

```ts
  it('uses schema-context wording for database progress', () => {
    const renderedTimeline = timeline
      .map((event) => [event.detailLine, event.summaryText].filter(Boolean).join(' '))
      .join('\n');

    expect(renderedTimeline).toContain('reading schema');
    expect(renderedTimeline).toContain('56 tables');
    expect(renderedTimeline).not.toContain('scanning');
    expect(renderedTimeline).not.toContain('scanned');
  });
```

- [ ] **Step 2: Run the failing demo wording test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-demo-tour.test.ts -t "schema-context wording"
```

Expected: FAIL because the demo timeline still uses `scanning tables...` and
`tables scanned`.

- [ ] **Step 3: Replace demo timeline database copy**

In `packages/cli/src/setup-demo-tour.ts`, inside `buildDemoReplayTimeline`,
replace the first three events:

```ts
    // postgres-warehouse: scan
    { delayMs: 0, connectionId: 'postgres-warehouse', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 1200, connectionId: 'postgres-warehouse', status: 'running', detailLine: '[50%] scanning tables...', summaryText: null },
    { delayMs: 2400, connectionId: 'postgres-warehouse', status: 'done', detailLine: null, summaryText: '56 tables scanned' },
```

with:

```ts
    // postgres-warehouse: database schema context
    { delayMs: 0, connectionId: 'postgres-warehouse', status: 'running', detailLine: null, summaryText: null },
    { delayMs: 1200, connectionId: 'postgres-warehouse', status: 'running', detailLine: '[50%] reading schema...', summaryText: null },
    { delayMs: 2400, connectionId: 'postgres-warehouse', status: 'done', detailLine: null, summaryText: '56 tables' },
```

- [ ] **Step 4: Run the demo wording test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-demo-tour.test.ts -t "schema-context wording"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "fix: remove scan wording from demo progress"
```

### Task 6: Final verification

**Files:**
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `packages/cli/src/context-build-view.ts`
- Verify: `packages/cli/src/next-steps.ts`
- Verify: `packages/cli/src/setup-demo-tour.ts`
- Verify: relevant tests

- [ ] **Step 1: Run focused Vitest coverage**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/context-build-view.test.ts src/next-steps.test.ts src/setup-demo-tour.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code check after TypeScript changes**

Run:

```bash
pnpm run dead-code
```

Expected: PASS.

- [ ] **Step 5: Search for stale public wording in touched surfaces**

Run:

```bash
rg -n "Build or resume agent-ready|primary-source scans|scanning tables|tables scanned|Debug: ktx ingest" packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/next-steps.ts packages/cli/src/next-steps.test.ts packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
```

Expected: no matches.

- [ ] **Step 6: Commit verification fixes if any were needed**

If verification required edits, run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/next-steps.ts packages/cli/src/next-steps.test.ts packages/cli/src/setup-demo-tour.ts packages/cli/src/setup-demo-tour.test.ts
git commit -m "test: verify unified ingest ux closure"
```

If no edits were needed, do not create an empty commit.

## Self-review

- Spec coverage: The plan covers the remaining v1-blocking warning,
  schema-first query-history, retry-guidance, setup next-step, and foreground
  demo wording gaps. Core command routing, depth policy, query-history config,
  setup depth, docs-site command references, foreground-only state, and reserved
  ids are already covered by earlier implemented plans.
- Placeholder scan: The plan contains exact file paths, concrete test code,
  implementation snippets, commands, and expected results. No red-flag
  placeholders are present.
- Type consistency: `notices` is added as an optional
  `KtxPublicIngestPlan` property and threaded through `renderContextBuildView`
  options. Retry helpers use existing `KtxPublicIngestPlanTarget`,
  `KtxPublicIngestArgs`, and `KtxPublicIngestStepName` types.
