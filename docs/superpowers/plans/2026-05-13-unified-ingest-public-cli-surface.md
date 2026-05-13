# Unified Ingest Public CLI Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ktx ingest` the public foreground context-build command for one connection or all configured connections.

**Architecture:** Reuse the existing `public-ingest.ts` orchestration as the public command engine, then extend it to resolve database depth, query-history intent, warnings, and adapter bypasses for connection-centric ingest. Keep low-level `scan` and adapter-backed `ingest run` available as hidden debug surfaces while normal help, output, generated config, and setup recovery text point to `ktx ingest <connectionId>`.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages, existing scan and local ingest adapters.

---

## Current audit

The unified ingest spec is not v1-complete. Relevant implemented pieces exist,
but they are not wired as the public product surface:

- `packages/cli/src/public-ingest.ts` can plan database connections before
  source connections and can call scan or source ingest internals.
- `packages/cli/src/context-build-view.ts` renders a foreground progress view
  and captures target progress.
- Historic SQL internals exist in `packages/context/src/ingest/adapters/historic-sql`
  and CLI adapter wiring exists in `packages/cli/src/local-adapters.ts`.
- The public CLI still rejects `ktx ingest warehouse`; see
  `packages/cli/src/index.test.ts`, test name
  `rejects removed public ingest shorthand`.
- Root help still exposes `scan`, `ktx ingest --help` still exposes `run` and
  `watch`, and generated default config still includes `live-database`.

This plan addresses the first v1-blocking slice: the public command surface,
connection-centric execution, public depth flags, query-history run overrides,
hidden legacy debug commands, and stale public wording. Setup depth prompting
and foreground-only state cleanup remain separate v1-blocking work after this
slice.

## File structure

- Modify `packages/cli/src/cli-runtime.ts`: add an injectable
  `publicIngest` dependency for Commander tests and for command routing.
- Modify `packages/cli/src/commands/ingest-commands.ts`: make the parent
  `ktx ingest` command accept `[connectionId]`, `--all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days`; hide legacy `run` and `watch`.
- Modify `packages/cli/src/commands/scan-commands.ts`: hide `ktx scan` from
  root help while keeping direct debug invocation.
- Modify `packages/cli/src/cli-program.ts`: remove `scan` from normal
  project-aware root command help expectations only where user-facing.
- Modify `packages/cli/src/public-ingest.ts`: resolve target type, depth,
  query-history settings, warnings, readiness failures, and adapter bypasses.
- Modify `packages/cli/src/context-build-view.ts`: rename public labels and
  public operation text away from scan terminology.
- Modify `packages/cli/src/ingest.ts`: allow connection-centric ingest to run
  an inferred adapter without requiring `ingest.adapters`.
- Modify `packages/cli/src/local-adapters.ts`: accept current-run
  query-history overrides for `context.queryHistory` without rewriting config.
- Modify `packages/context/src/project/config.ts`: stop generating
  `live-database` and source adapters in default `ktx.yaml`.
- Modify `packages/cli/src/setup-sources.ts`: replace stale recovery command
  suggestions with `ktx ingest <connectionId>`.
- Modify `README.md` and script assertions that document normal public command
  output.

## Tasks

### Task 1: Route the public `ktx ingest` command

**Files:**
- Modify: `packages/cli/src/cli-runtime.ts`
- Modify: `packages/cli/src/commands/ingest-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/dev.test.ts`

- [ ] **Step 1: Write failing Commander routing tests**

In `packages/cli/src/index.test.ts`, replace the test named
`rejects removed public ingest shorthand` with:

```ts
  it('routes public connection-centric ingest shorthand', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', '/tmp/project', 'ingest', 'warehouse', '--fast', '--no-input'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        json: false,
        inputMode: 'disabled',
        depth: 'fast',
        queryHistory: 'default',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('Project: /tmp/project\n');
  });

  it('routes public ingest --all --deep with JSON output', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', '/tmp/project', 'ingest', '--all', '--deep', '--json'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: '/tmp/project',
        all: true,
        json: true,
        inputMode: 'auto',
        depth: 'deep',
        queryHistory: 'default',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('rejects mutually exclusive public ingest depth flags before dispatch', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', '/tmp/project', 'ingest', 'warehouse', '--fast', '--deep'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);

    expect(publicIngest).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain("option '--deep' cannot be used with option '--fast'");
  });
```

In the existing ingest help test, change the expected help assertions to:

```ts
    expect(testIo.stdout()).toContain('Usage: ktx ingest [options] [connectionId]');
    expect(testIo.stdout()).toContain('Build or inspect KTX context');
    expect(testIo.stdout()).toContain('--all');
    expect(testIo.stdout()).toContain('--fast');
    expect(testIo.stdout()).toContain('--deep');
    expect(testIo.stdout()).toContain('--query-history');
    expect(testIo.stdout()).toContain('--no-query-history');
    expect(testIo.stdout()).toContain('--query-history-window-days <days>');
    expect(testIo.stdout()).toContain('status');
    expect(testIo.stdout()).toContain('replay');
    expect(testIo.stdout()).not.toContain('run');
    expect(testIo.stdout()).not.toContain('watch');
```

In `packages/cli/src/dev.test.ts`, update the generated nested help case for
`['ingest', 'run', '--help']` so it no longer treats legacy run help as a
normal generated public help case. Add this direct hidden-command regression
test instead:

```ts
  it('keeps legacy adapter-backed ingest run callable but hidden from ingest help', async () => {
    const helpIo = makeIo();
    const runIo = makeIo();
    const ingest = vi.fn(async () => 0);

    await expect(runKtxCli(['ingest', '--help'], helpIo.io, { ingest })).resolves.toBe(0);
    await expect(
      runKtxCli(
        ['ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase', '--project-dir', '/tmp/project'],
        runIo.io,
        { ingest },
      ),
    ).resolves.toBe(0);

    expect(helpIo.stdout()).not.toContain('run');
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', connectionId: 'warehouse', adapter: 'metabase' }),
      runIo.io,
    );
  });
```

- [ ] **Step 2: Run the failing Commander tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/dev.test.ts -t "public connection-centric ingest|public ingest --all|mutually exclusive public ingest|legacy adapter-backed ingest run|prints ingest help"
```

Expected: FAIL because `KtxCliDeps` has no `publicIngest`, `ktx ingest
warehouse` is unknown, and `run`/`watch` are still visible in help.

- [ ] **Step 3: Add the injectable public ingest dependency**

In `packages/cli/src/cli-runtime.ts`, add this import near the existing CLI
argument type imports:

```ts
import type { KtxPublicIngestArgs } from './public-ingest.js';
```

In `KtxCliDeps`, add:

```ts
  publicIngest?: (args: KtxPublicIngestArgs, io: KtxCliIo) => Promise<number>;
```

- [ ] **Step 4: Register parent `ktx ingest` options and hidden legacy commands**

In `packages/cli/src/commands/ingest-commands.ts`, add:

```ts
import type { KtxPublicIngestArgs } from '../public-ingest.js';
import { parsePositiveIntegerOption } from '../cli-program.js';
```

Replace the current `const ingest = program.command('ingest')...` block with:

```ts
  const ingest = program
    .command('ingest')
    .description('Build or inspect KTX context')
    .argument('[connectionId]', 'Configured connection id to ingest')
    .option('--all', 'Ingest all configured connections', false)
    .addOption(new Option('--fast', 'Use deterministic database schema ingest').conflicts('deep'))
    .addOption(new Option('--deep', 'Use AI-enriched database ingest').conflicts('fast'))
    .addOption(new Option('--query-history', 'Include database query-history usage patterns').conflicts('noQueryHistory'))
    .addOption(new Option('--no-query-history', 'Skip database query-history usage patterns'))
    .option('--query-history-window-days <days>', 'Query-history lookback window for this run', parsePositiveIntegerOption)
    .addOption(new Option('--plain', 'Print plain text output').conflicts(['json']))
    .addOption(new Option('--json', 'Print JSON output').conflicts(['plain']))
    .option('--no-input', 'Disable interactive terminal input')
    .showHelpAfterError();

  ingest.action(async (connectionId: string | undefined, options, command) => {
    const { runKtxPublicIngest } = await import('../public-ingest.js');
    const queryHistory =
      options.queryHistory === true ? 'enabled' : options.queryHistory === false ? 'disabled' : 'default';
    const args: KtxPublicIngestArgs = {
      command: 'run',
      projectDir: resolveCommandProjectDir(command),
      ...(connectionId ? { targetConnectionId: connectionId } : {}),
      all: options.all === true,
      json: options.json === true,
      inputMode: options.input === false ? 'disabled' : 'auto',
      ...(options.fast === true ? { depth: 'fast' as const } : {}),
      ...(options.deep === true ? { depth: 'deep' as const } : {}),
      queryHistory,
      ...(options.queryHistoryWindowDays !== undefined
        ? { queryHistoryWindowDays: options.queryHistoryWindowDays }
        : {}),
    };
    context.setExitCode(await (context.deps.publicIngest ?? runKtxPublicIngest)(args, context.io));
  });
```

Then hide the legacy `run` and `watch` subcommands by changing:

```ts
    .command('run')
```

to:

```ts
    .command('run', { hidden: true })
```

and changing:

```ts
    .command('watch')
```

to:

```ts
    .command('watch', { hidden: true })
```

- [ ] **Step 5: Run Commander tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/dev.test.ts
```

Expected: PASS after updating any remaining help text expectations that still
assume public `run` or `watch`.

- [ ] **Step 6: Commit public route wiring**

Run:

```bash
git add packages/cli/src/cli-runtime.ts packages/cli/src/commands/ingest-commands.ts packages/cli/src/index.test.ts packages/cli/src/dev.test.ts
git commit -m "feat(cli): route public connection ingest command"
```

### Task 2: Hide top-level `scan` from normal help

**Files:**
- Modify: `packages/cli/src/commands/scan-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/dev.test.ts`
- Modify: `packages/cli/src/cli-program.ts`

- [ ] **Step 1: Update public help tests**

In `packages/cli/src/index.test.ts`, in the test `prints the public command
surface in root help`, change the visible command list:

```ts
    for (const command of ['setup', 'connection', 'ingest', 'wiki', 'sl', 'status']) {
      expect(testIo.stdout()).toContain(`${command}`);
    }
    expect(testIo.stdout()).not.toMatch(/^  scan\s/m);
```

In `packages/cli/src/dev.test.ts`, keep the direct `['scan', '--help']` case
so the hidden debug command is still callable.

- [ ] **Step 2: Run the failing scan help tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/dev.test.ts -t "public command surface|generated nested help"
```

Expected: FAIL because root help still prints `scan`.

- [ ] **Step 3: Hide the scan command**

In `packages/cli/src/commands/scan-commands.ts`, change:

```ts
  program
    .command('scan')
```

to:

```ts
  program
    .command('scan', { hidden: true })
```

In `packages/cli/src/cli-program.ts`, leave `scan` in
`PROJECT_AWARE_ROOT_COMMANDS` so hidden direct invocations still receive
project-dir behavior:

```ts
const PROJECT_AWARE_ROOT_COMMANDS = new Set(['setup', 'connection', 'ingest', 'wiki', 'sl', 'status', 'scan']);
```

- [ ] **Step 4: Run scan help tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/dev.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit scan help hiding**

Run:

```bash
git add packages/cli/src/commands/scan-commands.ts packages/cli/src/index.test.ts packages/cli/src/dev.test.ts packages/cli/src/cli-program.ts
git commit -m "feat(cli): hide standalone scan from public help"
```

### Task 3: Resolve public ingest depth, warnings, and query-history intent

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write failing public ingest planner tests**

In `packages/cli/src/public-ingest.test.ts`, add these tests inside
`describe('buildPublicIngestPlan', ...)`:

```ts
  it('resolves database depth from flags, stored context, and defaults', () => {
    const project = projectWithConnections({
      fast_default: { driver: 'postgres' },
      deep_default: { driver: 'postgres', context: { depth: 'deep' } },
      docs: { driver: 'notion' },
    });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'fast_default',
        all: false,
        queryHistory: 'default',
      }).targets[0],
    ).toMatchObject({ connectionId: 'fast_default', databaseDepth: 'fast', queryHistory: { enabled: false } });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'deep_default',
        all: false,
        queryHistory: 'default',
      }).targets[0],
    ).toMatchObject({ connectionId: 'deep_default', databaseDepth: 'deep' });

    expect(
      buildPublicIngestPlan(project, {
        projectDir: '/tmp/project',
        targetConnectionId: 'docs',
        all: false,
        depth: 'deep',
        queryHistory: 'default',
      }).warnings,
    ).toEqual(['--deep affects database ingest only; ignoring it for docs.']);
  });

  it('upgrades effective depth when query history is explicitly enabled', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: false } } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      depth: 'fast',
      queryHistory: 'enabled',
      queryHistoryWindowDays: 30,
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      queryHistory: { enabled: true, windowDays: 30, dialect: 'postgres' },
    });
    expect(plan.warnings).toEqual(['--query-history requires deep ingest; running warehouse with --deep.']);
  });

  it('warns and skips query history for unsupported database drivers', () => {
    const project = projectWithConnections({ local: { driver: 'sqlite' } });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'local',
      all: false,
      queryHistory: 'enabled',
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'local',
      databaseDepth: 'fast',
      queryHistory: { enabled: false, unsupported: true },
    });
    expect(plan.warnings).toEqual(['--query-history is not supported for sqlite; running schema ingest for local.']);
  });
```

- [ ] **Step 2: Run the failing public ingest planner tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "resolves database depth|upgrades effective depth|unsupported database drivers"
```

Expected: FAIL because `depth`, `queryHistory`, `databaseDepth`, and plan
warnings do not exist.

- [ ] **Step 3: Extend public ingest types**

In `packages/cli/src/public-ingest.ts`, replace the public step and args types
near the top with:

```ts
type KtxPublicIngestStepName = 'database-schema' | 'query-history' | 'source-ingest' | 'memory-update';
type KtxPublicIngestStepStatus = 'done' | 'skipped' | 'failed' | 'not-run';
type KtxPublicIngestInputMode = 'auto' | 'disabled';
type KtxPublicIngestDepth = 'fast' | 'deep';
type KtxPublicIngestQueryHistoryFlag = 'default' | 'enabled' | 'disabled';
type HistoricSqlDialect = 'postgres' | 'bigquery' | 'snowflake';
```

In the `command: 'run'` variant of `KtxPublicIngestArgs`, add:

```ts
      depth?: KtxPublicIngestDepth;
      queryHistory?: KtxPublicIngestQueryHistoryFlag;
      queryHistoryWindowDays?: number;
```

Replace `KtxPublicIngestPlanTarget` with:

```ts
export interface KtxPublicIngestPlanTarget {
  connectionId: string;
  driver: string;
  operation: 'database-ingest' | 'source-ingest';
  adapter?: string;
  sourceDir?: string;
  debugCommand: string;
  steps: KtxPublicIngestStepName[];
  databaseDepth?: KtxPublicIngestDepth;
  queryHistory?: {
    enabled: boolean;
    dialect?: HistoricSqlDialect;
    windowDays?: number;
    unsupported?: boolean;
    skippedStoredByFast?: boolean;
  };
}
```

Add warnings to `KtxPublicIngestPlan`:

```ts
export interface KtxPublicIngestPlan {
  projectDir: string;
  targets: KtxPublicIngestPlanTarget[];
  warnings: string[];
}
```

- [ ] **Step 4: Add depth and query-history resolver helpers**

Add these helpers after `warehouseDrivers`:

```ts
const queryHistoryDialectByDriver = new Map<string, HistoricSqlDialect>([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['bigquery', 'bigquery'],
  ['snowflake', 'snowflake'],
]);

function connectionContext(connection: KtxProjectConnectionConfig): Record<string, unknown> {
  const value = connection.context;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function storedDepth(connection: KtxProjectConnectionConfig): KtxPublicIngestDepth | undefined {
  const value = connectionContext(connection).depth;
  return value === 'fast' || value === 'deep' ? value : undefined;
}

function storedQueryHistory(connection: KtxProjectConnectionConfig): Record<string, unknown> {
  const value = connectionContext(connection).queryHistory;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
```

Add:

```ts
function resolveDatabaseTargetOptions(input: {
  connectionId: string;
  driver: string;
  connection: KtxProjectConnectionConfig;
  args: {
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
  };
  warnings: string[];
}): Pick<KtxPublicIngestPlanTarget, 'databaseDepth' | 'queryHistory' | 'steps'> {
  const storedQh = storedQueryHistory(input.connection);
  const dialect = queryHistoryDialectByDriver.get(input.driver);
  const explicitQueryHistory = input.args.queryHistory ?? 'default';
  const storedEnabled = storedQh.enabled === true;
  const requestedQh = explicitQueryHistory === 'enabled' || (explicitQueryHistory === 'default' && storedEnabled);
  let depth = input.args.depth ?? storedDepth(input.connection) ?? 'fast';
  const queryHistory = {
    enabled: false,
    ...(input.args.queryHistoryWindowDays !== undefined
      ? { windowDays: input.args.queryHistoryWindowDays }
      : positiveInteger(storedQh.windowDays) !== undefined
        ? { windowDays: positiveInteger(storedQh.windowDays) }
        : {}),
  };

  if (requestedQh && !dialect) {
    input.warnings.push(
      explicitQueryHistory === 'enabled' || input.args.queryHistoryWindowDays !== undefined
        ? `--query-history is not supported for ${input.driver}; running schema ingest for ${input.connectionId}.`
        : `${input.connectionId} has query history enabled in ktx.yaml, but ${input.driver} does not support it; running schema ingest.`,
    );
    return {
      databaseDepth: depth,
      queryHistory: { ...queryHistory, unsupported: true },
      steps: ['database-schema'],
    };
  }

  if (requestedQh && dialect) {
    if (depth === 'fast') {
      input.warnings.push(`--query-history requires deep ingest; running ${input.connectionId} with --deep.`);
    }
    depth = 'deep';
    return {
      databaseDepth: depth,
      queryHistory: { ...queryHistory, enabled: true, dialect },
      steps: ['database-schema', 'query-history'],
    };
  }

  if (input.args.depth === 'fast' && explicitQueryHistory !== 'enabled' && storedEnabled) {
    input.warnings.push(
      `${input.connectionId} has query history enabled in ktx.yaml, but --fast skips query-history processing.`,
    );
    return {
      databaseDepth: 'fast',
      queryHistory: { ...queryHistory, skippedStoredByFast: true },
      steps: ['database-schema'],
    };
  }

  return {
    databaseDepth: depth,
    queryHistory,
    steps: ['database-schema'],
  };
}
```

- [ ] **Step 5: Use the resolver in plan construction**

Change `targetForConnection` to accept args and warnings:

```ts
function targetForConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
  args: {
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
  },
  warnings: string[],
): KtxPublicIngestPlanTarget {
```

In the source-adapter branch, before returning, add:

```ts
    if (args.depth) {
      warnings.push(`--${args.depth} affects database ingest only; ignoring it for ${connectionId}.`);
    }
    if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
      warnings.push(`--query-history affects database ingest only; ignoring it for ${connectionId}.`);
    }
```

Change the source debug command to:

```ts
      debugCommand: `ktx ingest ${connectionId} --debug`,
```

In the warehouse branch, replace the return object with:

```ts
    const options = resolveDatabaseTargetOptions({ connectionId, driver, connection, args, warnings });
    return {
      connectionId,
      driver,
      operation: 'database-ingest',
      debugCommand: `ktx ingest ${connectionId} --debug`,
      ...options,
    };
```

In `buildPublicIngestPlan`, add warnings and return them:

```ts
  const warnings: string[] = [];
  const targets = selected.map(([connectionId, connection]) => targetForConnection(connectionId, connection, args, warnings));
  return {
    projectDir: args.projectDir,
    targets: [
      ...targets.filter((t) => t.operation === 'database-ingest'),
      ...targets.filter((t) => t.operation === 'source-ingest'),
    ],
    warnings,
  };
```

- [ ] **Step 6: Run planner tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "buildPublicIngestPlan"
```

Expected: PASS after updating older expected target snapshots from
`operation: 'scan'` to `operation: 'database-ingest'`, from `steps: ['scan']`
to `steps: ['database-schema']`, and adding `warnings: []`.

- [ ] **Step 7: Commit public ingest planning**

Run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "feat(cli): plan public ingest depth and query history"
```

### Task 4: Execute database depth and query-history facets

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/public-ingest.test.ts`
- Modify: `packages/cli/src/ingest.ts`

- [ ] **Step 1: Write failing execution tests**

In `packages/cli/src/public-ingest.test.ts`, add:

```ts
  it('maps fast and deep database targets to scan internals', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      fast: { driver: 'postgres' },
      deep: { driver: 'postgres', context: { depth: 'deep' } },
    });
    const runScan = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled', queryHistory: 'default' },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(0);

    expect(runScan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ connectionId: 'deep', mode: 'enriched', detectRelationships: true }),
      expect.anything(),
    );
    expect(runScan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ connectionId: 'fast', mode: 'structural', detectRelationships: false }),
      expect.anything(),
    );
  });

  it('runs query history after schema ingest with current-run window override', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true, windowDays: 90 } } },
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
          queryHistoryWindowDays: 30,
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(0);

    expect(runScan).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'warehouse', mode: 'enriched' }),
      expect.anything(),
    );
    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'warehouse',
        adapter: 'historic-sql',
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride: expect.objectContaining({ dialect: 'postgres', windowDays: 30 }),
      }),
      expect.anything(),
    );
  });
```

- [ ] **Step 2: Run the failing execution tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "maps fast and deep|runs query history"
```

Expected: FAIL because execution still uses `scanMode`, no query-history step
exists, and `KtxIngestArgs` has no implicit-adapter fields.

- [ ] **Step 3: Add implicit adapter and query-history override fields**

In `packages/cli/src/ingest.ts`, extend the `command: 'run'` args type:

```ts
      allowImplicitAdapter?: boolean;
      historicSqlPullConfigOverride?: Record<string, unknown>;
```

In the `adapterOptions` object inside `runKtxIngest`, add:

```ts
        ...(args.historicSqlPullConfigOverride
          ? { historicSqlPullConfigOverride: args.historicSqlPullConfigOverride }
          : {}),
```

Before calling `executeLocalIngest`, create the project used for local ingest:

```ts
      const ingestProject =
        args.allowImplicitAdapter && !project.config.ingest.adapters.includes(args.adapter)
          ? {
              ...project,
              config: {
                ...project.config,
                ingest: {
                  ...project.config.ingest,
                  adapters: [...project.config.ingest.adapters, args.adapter],
                },
              },
            }
          : project;
```

Then pass `ingestProject` instead of `project` to `runLocalMetabaseIngest`,
`createAdapters`, `createQueryExecutor`, and `executeLocalIngest` in the
`command: 'run'` branch.

Keep `packages/context/src/ingest/local-ingest.ts` unchanged. The public path
satisfies its strict `assertConfigured()` contract by passing an in-memory
project config whose adapter list includes the inferred adapter for this run.

- [ ] **Step 4: Execute database targets from effective depth**

In `packages/cli/src/public-ingest.ts`, update the database branch of
`executePublicIngestTarget`:

```ts
  if (target.operation === 'database-ingest') {
    const { runKtxScan } = await import('./scan.js');
    const scanArgs: KtxScanArgs = {
      command: 'run',
      projectDir: args.projectDir,
      connectionId: target.connectionId,
      mode: target.databaseDepth === 'deep' ? 'enriched' : 'structural',
      detectRelationships: target.databaseDepth === 'deep' ? true : false,
      dryRun: false,
    };
    const runScan = deps.runScan ?? runKtxScan;
    const scanExitCode = deps.scanProgress
      ? await runScan(scanArgs, io, { progress: deps.scanProgress })
      : await runScan(scanArgs, io);
    if (scanExitCode !== 0) {
      return markTargetResult(target, 'failed', 'database-schema');
    }

    if (target.queryHistory?.enabled === true) {
      const { runKtxIngest } = await import('./ingest.js');
      const runIngest = deps.runIngest ?? runKtxIngest;
      const ingestArgs: KtxIngestArgs = {
        command: 'run',
        projectDir: args.projectDir,
        connectionId: target.connectionId,
        adapter: 'historic-sql',
        outputMode: sourceIngestOutputMode(args, io),
        inputMode: args.inputMode,
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride: {
          dialect: target.queryHistory.dialect,
          ...(target.queryHistory.windowDays !== undefined ? { windowDays: target.queryHistory.windowDays } : {}),
        },
      };
      const qhExitCode = await runIngest(ingestArgs, io);
      if (qhExitCode !== 0) {
        return markTargetResult(target, 'failed', 'query-history');
      }
    }

    return markTargetResult(target, 'done');
  }
```

Update `markTargetResult` to accept the failed operation:

```ts
function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
): KtxPublicIngestTargetResult {
```

Inside the function, replace the failed-operation selection with:

```ts
  const selectedFailedOperation =
    failedOperation ?? (target.operation === 'database-ingest' ? 'database-schema' : 'source-ingest');
```

Then use `selectedFailedOperation` in the failed-step comparison and detail.

- [ ] **Step 5: Print plan warnings before results**

In `runKtxPublicIngest`, after building `plan` and before executing targets,
add:

```ts
  if (!args.json && plan.warnings.length > 0) {
    for (const warning of plan.warnings) {
      io.stderr.write(`Warning: ${warning}\n`);
    }
  }
```

For JSON output, the existing `{ plan, results }` payload now includes
`plan.warnings`.

- [ ] **Step 6: Run execution tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/ingest.test.ts
```

Expected: PASS after updating public result table labels from `Scan` to
`Database` or `Schema` in existing assertions.

- [ ] **Step 7: Commit public execution behavior**

Run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/ingest.ts
git commit -m "feat(cli): execute public database ingest facets"
```

### Task 5: Accept `context.queryHistory` in historic-SQL adapter plumbing

**Files:**
- Modify: `packages/cli/src/local-adapters.ts`
- Modify: `packages/cli/src/local-adapters.test.ts`
- Modify: `packages/context/src/ingest/local-adapters.ts`
- Modify: `packages/context/src/ingest/local-adapters.test.ts`

- [ ] **Step 1: Write failing query-history config tests**

In `packages/context/src/ingest/local-adapters.test.ts`, add:

```ts
  it('maps connection context.queryHistory to historic-sql pull config', async () => {
    const project = projectWithConnections({
      warehouse: {
        driver: 'postgres',
        context: {
          queryHistory: {
            enabled: true,
            windowDays: 45,
            minExecutions: 7,
            filters: { dropTrivialProbes: true },
          },
        },
      },
    });
    const adapter = { source: 'historic-sql' } as never;

    await expect(localPullConfigForAdapter(project, adapter, 'warehouse')).resolves.toMatchObject({
      dialect: 'postgres',
      windowDays: 45,
      minExecutions: 7,
      filters: { dropTrivialProbes: true },
    });
  });

  it('prefers context.queryHistory over legacy historicSql', async () => {
    const project = projectWithConnections({
      warehouse: {
        driver: 'postgres',
        historicSql: { enabled: true, dialect: 'postgres', windowDays: 90 },
        context: { queryHistory: { enabled: true, windowDays: 30 } },
      },
    });
    const adapter = { source: 'historic-sql' } as never;

    await expect(localPullConfigForAdapter(project, adapter, 'warehouse')).resolves.toMatchObject({
      dialect: 'postgres',
      windowDays: 30,
    });
  });
```

In `packages/cli/src/local-adapters.test.ts`, add a test that creates a
Postgres connection with `context.queryHistory.enabled: true`, calls
`createKtxCliLocalIngestAdapters(project, { historicSqlConnectionId:
'warehouse' })`, and expects one adapter with `source === 'historic-sql'`.

- [ ] **Step 2: Run the failing adapter tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-adapters.test.ts
pnpm --filter @ktx/cli exec vitest run src/local-adapters.test.ts
```

Expected: FAIL because both layers only look at `connection.historicSql`.

- [ ] **Step 3: Add context-query-history mapping in context local adapters**

In `packages/context/src/ingest/local-adapters.ts`, add:

```ts
const historicSqlDialectByDriver = new Map<string, 'postgres' | 'bigquery' | 'snowflake'>([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['bigquery', 'bigquery'],
  ['snowflake', 'snowflake'],
]);

function queryHistoryRecord(connection: unknown): Record<string, unknown> | null {
  if (!isRecord(connection)) return null;
  const context = isRecord(connection.context) ? connection.context : null;
  const queryHistory = isRecord(context?.queryHistory) ? context.queryHistory : null;
  return queryHistory;
}

function queryHistoryPullConfig(connection: unknown): Record<string, unknown> | null {
  const queryHistory = queryHistoryRecord(connection);
  if (queryHistory?.enabled !== true || !isRecord(connection)) return null;
  const dialect = historicSqlDialectByDriver.get(String(connection.driver ?? '').toLowerCase());
  if (!dialect) return null;
  return { ...queryHistory, dialect };
}
```

In `localPullConfigForAdapter`, replace the historic-SQL block with:

```ts
  if (adapter.source === HISTORIC_SQL_SOURCE_KEY) {
    const queryHistory = queryHistoryPullConfig(connection);
    if (queryHistory) {
      return historicSqlUnifiedPullConfigSchema.parse(queryHistory);
    }
    const historicSql = isRecord(connection?.historicSql) ? connection.historicSql : null;
    if (historicSql?.enabled !== true) {
      throw new Error(`Connection "${connectionId}" does not have context.queryHistory.enabled: true`);
    }
    return historicSqlUnifiedPullConfigSchema.parse({
      ...historicSql,
    });
  }
```

- [ ] **Step 4: Add context-query-history detection in CLI local adapters**

In `packages/cli/src/local-adapters.ts`, replace `enabledHistoricSqlDialect`
with:

```ts
function enabledHistoricSqlDialect(connection: unknown): 'postgres' | 'bigquery' | 'snowflake' | null {
  const direct = historicSqlRecord(connection);
  const context =
    connection && typeof connection === 'object' && !Array.isArray(connection)
      ? (connection as { context?: unknown }).context
      : null;
  const queryHistory =
    context && typeof context === 'object' && !Array.isArray(context)
      ? (context as { queryHistory?: unknown }).queryHistory
      : null;
  const enabled =
    queryHistory && typeof queryHistory === 'object' && !Array.isArray(queryHistory)
      ? (queryHistory as { enabled?: unknown }).enabled === true
      : direct?.enabled === true;
  if (!enabled) {
    return null;
  }
  const driver = String((connection as { driver?: unknown })?.driver ?? '').toLowerCase();
  if (driver === 'postgres' || driver === 'postgresql') return 'postgres';
  if (driver === 'bigquery') return 'bigquery';
  if (driver === 'snowflake') return 'snowflake';
  const legacyDialect = String(direct?.dialect ?? '').toLowerCase();
  return legacyDialect === 'postgres' || legacyDialect === 'bigquery' || legacyDialect === 'snowflake'
    ? legacyDialect
    : null;
}
```

- [ ] **Step 5: Run adapter tests again**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-adapters.test.ts
pnpm --filter @ktx/cli exec vitest run src/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit query-history adapter config**

Run:

```bash
git add packages/context/src/ingest/local-adapters.ts packages/context/src/ingest/local-adapters.test.ts packages/cli/src/local-adapters.ts packages/cli/src/local-adapters.test.ts
git commit -m "feat(ingest): read connection query history config"
```

### Task 6: Remove normal `live-database`, adapter, and scan wording from public output

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/context-build-view.ts`
- Modify: `packages/cli/src/context-build-view.test.ts`
- Modify: `packages/cli/src/setup-sources.ts`
- Modify: `packages/cli/src/setup-sources.test.ts`

- [ ] **Step 1: Write failing wording tests**

In `packages/cli/src/context-build-view.test.ts`, change the group label
assertions from `Primary sources:` to `Databases:` and update the running
database detail test to expect `reading schema` instead of `scanning...`.

Add this setup recovery assertion in the test covering failed initial source
ingest in `packages/cli/src/setup-sources.test.ts`:

```ts
    expect(io.stdout()).toContain(`Run later: ktx ingest ${connectionId}`);
    expect(io.stdout()).not.toContain('ktx ingest run --connection-id');
    expect(io.stdout()).not.toContain('--adapter');
```

- [ ] **Step 2: Run failing wording tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/setup-sources.test.ts -t "Databases|reading schema|Run later"
```

Expected: FAIL because labels still say `Primary sources`, running database
detail says `scanning...`, and setup recovery still suggests adapter-backed
ingest.

- [ ] **Step 3: Update public render labels**

In `packages/cli/src/context-build-view.ts`, change:

```ts
    ...renderTargetGroup('Primary sources', state.primarySources, state.frame, styled, width),
```

to:

```ts
    ...renderTargetGroup('Databases', state.primarySources, state.frame, styled, width),
```

In `targetDetail`, change:

```ts
      ?? (target.target.operation === 'scan' ? 'scanning...' : 'ingesting...');
```

to:

```ts
      ?? (target.target.operation === 'database-ingest' ? 'reading schema' : 'ingesting...');
```

Update type comparisons in this file from `'scan'` to `'database-ingest'` for
public target operation checks.

- [ ] **Step 4: Update setup source recovery text**

In `packages/cli/src/setup-sources.ts`, replace:

```ts
      input.io.stdout.write(`│  Run later: ktx ingest run --connection-id ${input.connectionId} --adapter <adapter>\n`);
```

with:

```ts
      input.io.stdout.write(`│  Run later: ktx ingest ${input.connectionId}\n`);
```

- [ ] **Step 5: Run wording tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/setup-sources.test.ts
```

Expected: PASS after updating existing snapshots for the new public operation
name.

- [ ] **Step 6: Commit public wording cleanup**

Run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/setup-sources.ts packages/cli/src/setup-sources.test.ts
git commit -m "fix(cli): use public ingest wording"
```

### Task 7: Stop generating adapter allow-list entries in normal config

**Files:**
- Modify: `packages/context/src/project/config.ts`
- Modify: `packages/context/src/project/config.test.ts`
- Modify: `packages/cli/src/setup-sources.ts`
- Modify: `packages/cli/src/setup-sources.test.ts`
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Write failing config tests**

In `packages/context/src/project/config.test.ts`, update default assertions:

```ts
      ingest: {
        adapters: [],
```

and:

```ts
    expect(serialized).not.toContain('live-database');
    expect(parsed.ingest.adapters).toEqual([]);
```

In setup database and source tests, add assertions after generated config is
read:

```ts
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect(configText).not.toMatch(/^\s+adapters:/m);
```

- [ ] **Step 2: Run failing config tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts src/setup-sources.test.ts
```

Expected: FAIL because defaults and setup still write adapter entries.

- [ ] **Step 3: Change default config**

In `packages/context/src/project/config.ts`, change:

```ts
      adapters: ['live-database', 'lookml', 'metabase', 'metricflow', 'notion'],
```

to:

```ts
      adapters: [],
```

- [ ] **Step 4: Stop setup from appending normal source adapters**

In `packages/cli/src/setup-sources.ts`, change `writeSourceConnection` so the
new config only writes `connections`:

```ts
  const nextConfig = {
    ...project.config,
    connections: {
      ...project.config.connections,
      [connectionId]: connection,
    },
  };
```

Remove the `adapters` mutation in that helper and remove adapter rollback code
that only exists to undo automatic adapter appends.

- [ ] **Step 5: Stop Historic SQL setup from appending adapters**

In `packages/cli/src/setup-databases.ts`, change `ensureHistoricSqlIngestDefaults`
so it only raises `ingest.workUnits.maxConcurrency`:

```ts
async function ensureHistoricSqlIngestDefaults(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const maxConcurrency = Math.max(
    project.config.ingest.workUnits.maxConcurrency,
    HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY,
  );
  if (maxConcurrency === project.config.ingest.workUnits.maxConcurrency) {
    return;
  }
  await writeFile(
    project.configPath,
    serializeKtxProjectConfig({
      ...project.config,
      ingest: {
        ...project.config.ingest,
        workUnits: {
          ...project.config.ingest.workUnits,
          maxConcurrency,
        },
      },
    }),
    'utf-8',
  );
}
```

- [ ] **Step 6: Run config tests again**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts src/setup-sources.test.ts src/public-ingest.test.ts
```

Expected: PASS. Public source ingest still works because Task 4 synthesizes the
inferred adapter for public connection-centric runs.

- [ ] **Step 7: Commit config cleanup**

Run:

```bash
git add packages/context/src/project/config.ts packages/context/src/project/config.test.ts packages/cli/src/setup-sources.ts packages/cli/src/setup-sources.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "fix(config): stop generating ingest adapter allow lists"
```

### Task 8: Update public docs and script assertions

**Files:**
- Modify: `README.md`
- Modify: `scripts/examples-docs.test.mjs`
- Modify: `scripts/package-artifacts.mjs`
- Modify: `scripts/package-artifacts.test.mjs`
- Modify: `scripts/installed-live-database-smoke.mjs`
- Modify: `scripts/installed-live-database-smoke.test.mjs`

- [ ] **Step 1: Write failing docs assertion changes**

In `scripts/examples-docs.test.mjs`, replace assertions that require
`ktx scan <connection-id>`, `ktx scan <connectionId> [options]`, and
`live-database/` in normal README output with assertions for:

```js
assert.match(buildingContext, /ktx ingest <connection-id>/);
assert.match(buildingContext, /ktx ingest --all/);
assert.doesNotMatch(rootReadme, /live-database\//);
assert.doesNotMatch(rootReadme, /ktx scan/);
```

In package artifact smoke tests, change normal public smoke labels from
`ktx scan structural` and `ktx scan enriched` to `ktx ingest fast` and
`ktx ingest deep`.

- [ ] **Step 2: Run failing docs/script tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs scripts/package-artifacts.test.mjs scripts/installed-live-database-smoke.test.mjs
```

Expected: FAIL because docs and smoke scripts still mention `scan` and
`live-database`.

- [ ] **Step 3: Update README public examples**

In `README.md`, replace normal context-build examples:

```md
ktx scan warehouse --project-dir "$PROJECT_DIR"
```

with:

```md
ktx ingest warehouse --project-dir "$PROJECT_DIR" --fast
```

Replace enriched examples with:

```md
ktx ingest warehouse --project-dir "$PROJECT_DIR" --deep
```

Replace adapter-backed ingest examples for normal users with:

```md
ktx ingest notion --project-dir "$PROJECT_DIR"
```

Keep internal artifact paths only in sections explicitly labeled as debug or
implementation details.

- [ ] **Step 4: Update smoke scripts to use public ingest**

In `scripts/package-artifacts.mjs`, replace public scan smoke invocations with:

```js
const structuralScan = await run('pnpm', [
  'exec',
  'ktx',
  'ingest',
  'warehouse',
  '--project-dir',
  projectDir,
  '--fast',
  '--no-input',
]);
```

and:

```js
const enrichedScan = await run('pnpm', [
  'exec',
  'ktx',
  'ingest',
  'warehouse',
  '--project-dir',
  projectDir,
  '--deep',
  '--no-input',
]);
```

Update expected output matches from `Mode: structural` and `Mode: enriched` to
the public result summary that `runKtxPublicIngest` prints, for example
`Database schema` or `database-schema done` depending on the final Task 4
rendering.

In `scripts/installed-live-database-smoke.mjs`, keep the file name if renaming
would churn scripts, but change the public CLI invocation from adapter-backed
`ktx ingest run --adapter live-database` to:

```js
return ['exec', 'ktx', 'ingest', connectionId, '--project-dir', projectDir, '--fast', '--no-input'];
```

- [ ] **Step 5: Run docs/script tests again**

Run:

```bash
node --test scripts/examples-docs.test.mjs scripts/package-artifacts.test.mjs scripts/installed-live-database-smoke.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit docs and smoke cleanup**

Run:

```bash
git add README.md scripts/examples-docs.test.mjs scripts/package-artifacts.mjs scripts/package-artifacts.test.mjs scripts/installed-live-database-smoke.mjs scripts/installed-live-database-smoke.test.mjs
git commit -m "docs: document public ingest command"
```

### Task 9: Run final verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused CLI and context tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/dev.test.ts src/public-ingest.test.ts src/context-build-view.test.ts src/ingest.test.ts src/local-adapters.test.ts src/setup-sources.test.ts src/setup-databases.test.ts
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts src/ingest/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run workspace type checks for touched packages**

Run:

```bash
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run docs and script tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs scripts/package-artifacts.test.mjs scripts/installed-live-database-smoke.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only pre-existing findings unrelated to the files changed
in this plan.

- [ ] **Step 5: Commit any verification-only expectation fixes**

If verification required expectation-only changes, run:

```bash
git add packages/cli/src packages/context/src scripts README.md
git commit -m "test: align ingest surface expectations"
```

If there were no changes, do not create an empty commit.

## Self-review notes

Spec coverage in this plan:

- Covers `ktx ingest <connectionId>` and `ktx ingest --all`.
- Covers public `--fast` and `--deep` mapping to structural and enriched scan
  internals.
- Covers hidden legacy `scan`, `ingest run`, and `ingest watch` help behavior.
- Covers adapter allow-list bypass for public connection-centric ingest.
- Covers current-run query-history enablement and window override.
- Covers normal generated config removing adapter allow lists.
- Covers normal help, docs, setup recovery text, and progress wording.

Known v1-blocking work not included in this plan:

- Setup must ask for and store `connections.<id>.context.depth`.
- Setup readiness must treat fast and deep contexts differently.
- Setup context state must remove detach, watch, resume, stop, paused, and
  background subprocess behavior.
- Config rewrite must migrate legacy `connection.historicSql` into
  `connection.context.queryHistory`.
- Config/setup validation must reject connection ids that collide with
  surviving ingest subcommands.

Placeholder scan: no task uses deferred code markers or unnamed edge handling.
Each implementation task names exact files, tests, commands, and the concrete
code shape to add.
