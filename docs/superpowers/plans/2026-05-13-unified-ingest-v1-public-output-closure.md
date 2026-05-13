# Unified Ingest V1 Public Output Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking gaps where public `ktx ingest` and
setup still expose internal scan, adapter, or Historic SQL behavior.

**Architecture:** Keep the current connection-centric `ktx ingest` planner and
depth policy. Tighten the public execution layer so inferred source adapters
bypass `ingest.adapters`, database ingest captures internal scan output, TTY
public ingest uses the shared foreground context-build view, and setup output
uses schema-context and query-history language.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages.

---

## Audit

The implemented unified-ingest plans cover the core command routing, depth
policy, setup depth defaults, foreground-only setup context build, canonical
`context.queryHistory` setup storage, reserved ingest connection ids, and
default config cleanup.

### V1-blocking gaps

- `ktx ingest <sourceConnectionId>` still calls `runKtxIngest` without
  `allowImplicitAdapter: true`, so public source ingest still requires
  `ingest.adapters` entries.
- Direct public database ingest still streams internal `runKtxScan` output,
  including `KTX scan completed`, `Mode: structural`, artifact paths, and
  `live-database` path segments.
- Direct interactive public ingest does not use the shared foreground
  context-build view; only setup uses that view.
- `--query-history-window-days` does not itself request query-history ingest,
  so `ktx ingest warehouse --query-history-window-days 30` silently runs only
  schema ingest when stored query history is disabled.
- `ktx ingest --all --deep` emits one ignored-depth warning per non-database
  source instead of aggregating the warning.
- Setup database output still says `Scanning`, `structural scan`, prints
  `live-database` report paths, and suggests `ktx scan` as a retry/debug
  command.
- Setup help and prompts still expose `Historic SQL` flags and wording instead
  of query-history wording.

### Non-blocking gaps

- Hidden debug surfaces can still call internal commands: `ktx scan`,
  `ktx ingest run`, and `ktx ingest watch`.
- Internal package names, adapter keys, raw artifact paths, scan tests, and
  scripts can continue to use `scan`, `live-database`, and `historic-sql`.
- README package descriptions such as `Postgres scan connector` are internal
  package taxonomy, not normal CLI command guidance.
- `README.md` says rerunning setup resumes the wizard; that is setup-flow
  language, not a context-build background resume path.

## File structure

- Modify `packages/cli/src/public-ingest.ts`: set implicit adapters for public
  source ingest, treat query-history window overrides as query-history
  requests, aggregate `--all` source warnings, capture database scan output for
  plain public ingest, and delegate interactive TTY runs to the shared context
  build view.
- Modify `packages/cli/src/public-ingest.test.ts`: cover adapter bypass,
  quiet database ingest output, query-history window semantics, aggregated
  warnings, and TTY foreground delegation.
- Modify `packages/cli/src/context-build-view.ts`: allow the foreground view
  to run a single requested connection and pass through public ingest flags.
- Modify `packages/cli/src/context-build-view.test.ts`: cover single-target
  foreground execution and flag passthrough.
- Modify `packages/cli/src/setup-databases.ts`: rename public setup wording to
  schema context and query history, stop printing internal report paths in
  normal setup output, and replace `ktx scan` retry/debug suggestions with
  `ktx ingest <connectionId> --fast`.
- Modify `packages/cli/src/setup-databases.test.ts`: update setup output,
  failure, and query-history expectations.
- Modify `packages/cli/src/commands/setup-commands.ts`: replace public
  Historic SQL setup flags with query-history setup flags.
- Modify `packages/cli/src/index.test.ts`: update setup help and conflicting
  query-history flag tests.

## Tasks

### Task 1: Bypass adapter allow-lists for public source ingest

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write the failing adapter-bypass test**

Add this test inside the `runKtxPublicIngest` describe block in
`packages/cli/src/public-ingest.test.ts`:

```ts
  it('bypasses adapter allow-lists for connection-centric source ingest', async () => {
    const runIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/ktx',
          targetConnectionId: 'docs',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        {
          loadProject: async () =>
            projectWithConnections({
              docs: { driver: 'notion' },
            }),
          runIngest,
        },
      ),
    ).resolves.toBe(0);

    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        connectionId: 'docs',
        adapter: 'notion',
        allowImplicitAdapter: true,
      }),
      io.io,
    );
  });
```

- [ ] **Step 2: Run the failing adapter-bypass test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "adapter allow-lists"
```

Expected: FAIL because public source ingest does not pass
`allowImplicitAdapter: true`.

- [ ] **Step 3: Add `allowImplicitAdapter` for inferred source adapters**

In `packages/cli/src/public-ingest.ts`, update the source-ingest
`KtxIngestArgs` object in `executePublicIngestTarget`:

```ts
  const ingestArgs: KtxIngestArgs = {
    command: 'run',
    projectDir: args.projectDir,
    connectionId: target.connectionId,
    adapter: target.adapter ?? target.driver,
    ...(target.sourceDir ? { sourceDir: target.sourceDir } : {}),
    outputMode: sourceIngestOutputMode(args, io),
    inputMode: args.inputMode,
    allowImplicitAdapter: true,
  };
```

- [ ] **Step 4: Run the adapter-bypass test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "adapter allow-lists"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(ingest): bypass adapter allow-list for public source ingest"
```

### Task 2: Fix query-history window semantics and aggregate source warnings

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write failing query-history and warning tests**

Add these tests inside the `buildPublicIngestPlan` describe block in
`packages/cli/src/public-ingest.test.ts`:

```ts
  it('treats query-history window override as current-run query-history enablement', () => {
    const project = deepReadyProject({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: false, windowDays: 90 } } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      queryHistory: 'default',
      queryHistoryWindowDays: 30,
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      queryHistory: { enabled: true, dialect: 'postgres', windowDays: 30 },
      steps: ['database-schema', 'query-history'],
    });
  });

  it('warns and skips query-history window override for unsupported database drivers', () => {
    const plan = buildPublicIngestPlan(
      projectWithConnections({
        local: { driver: 'sqlite' },
      }),
      {
        projectDir: '/tmp/project',
        targetConnectionId: 'local',
        all: false,
        queryHistory: 'default',
        queryHistoryWindowDays: 30,
      },
    );

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'local',
      databaseDepth: 'fast',
      queryHistory: { enabled: false, windowDays: 30, unsupported: true },
      steps: ['database-schema'],
    });
    expect(plan.warnings).toEqual(['--query-history is not supported for sqlite; running schema ingest for local.']);
  });

  it('aggregates ignored database-depth warnings for all source targets', () => {
    const plan = buildPublicIngestPlan(
      projectWithConnections({
        warehouse: { driver: 'postgres' },
        docs: { driver: 'notion' },
        dbt: { driver: 'dbt' },
      }),
      {
        projectDir: '/tmp/project',
        all: true,
        depth: 'deep',
        queryHistory: 'default',
      },
    );

    expect(plan.warnings).toEqual(['--deep ignored for 2 non-database sources.']);
  });
```

- [ ] **Step 2: Run the failing public ingest planning tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "query-history window override|unsupported database drivers|aggregates ignored"
```

Expected: FAIL because window-days alone does not request query history and
source warnings are emitted per source.

- [ ] **Step 3: Add a warning accumulator**

In `packages/cli/src/public-ingest.ts`, add these types and helpers near
`queryHistoryDialectByDriver`:

```ts
interface KtxPublicIngestWarningAccumulator {
  warnings: string[];
  ignoredDepthForSources: string[];
  ignoredQueryHistoryForSources: string[];
}

function createWarningAccumulator(): KtxPublicIngestWarningAccumulator {
  return {
    warnings: [],
    ignoredDepthForSources: [],
    ignoredQueryHistoryForSources: [],
  };
}

function sourceIgnoredWarning(option: string, connectionIds: string[], all: boolean): string | null {
  if (connectionIds.length === 0) {
    return null;
  }
  if (all) {
    const sourceLabel = connectionIds.length === 1 ? '1 non-database source' : `${connectionIds.length} non-database sources`;
    return `${option} ignored for ${sourceLabel}.`;
  }
  return `${option} affects database ingest only; ignoring it for ${connectionIds[0]}.`;
}

function finalizeWarnings(
  accumulator: KtxPublicIngestWarningAccumulator,
  args: {
    all: boolean;
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
  },
): string[] {
  const warnings = [...accumulator.warnings];
  const depthOption = args.depth ? `--${args.depth}` : null;
  if (depthOption) {
    const warning = sourceIgnoredWarning(depthOption, accumulator.ignoredDepthForSources, args.all);
    if (warning) warnings.push(warning);
  }
  if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
    const warning = sourceIgnoredWarning('--query-history', accumulator.ignoredQueryHistoryForSources, args.all);
    if (warning) warnings.push(warning);
  }
  return warnings;
}
```

- [ ] **Step 4: Use window-days as query-history intent**

In `resolveDatabaseTargetOptions`, replace the current `requestedQh` line with:

```ts
  const windowOverrideRequested = input.args.queryHistoryWindowDays !== undefined;
  const requestedQh =
    explicitQueryHistory === 'enabled' ||
    (explicitQueryHistory !== 'disabled' && (windowOverrideRequested || storedEnabled));
```

Leave the existing `--query-history requires deep ingest` warning in place so
`--fast --query-history-window-days 30` upgrades the run to deep with the same
warning as `--fast --query-history`.

- [ ] **Step 5: Route source warnings through the accumulator**

Change the `warnings` parameter in `targetForConnection` from `string[]` to
`KtxPublicIngestWarningAccumulator`. In the source-adapter branch, replace the
current warning pushes with:

```ts
    if (args.depth) {
      warnings.ignoredDepthForSources.push(connectionId);
    }
    if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
      warnings.ignoredQueryHistoryForSources.push(connectionId);
    }
```

In the database branch, pass `warnings.warnings` into
`resolveDatabaseTargetOptions`:

```ts
    const options = resolveDatabaseTargetOptions({
      connectionId,
      driver,
      connection,
      args,
      warnings: warnings.warnings,
    });
```

In `buildPublicIngestPlan`, replace the `warnings` array construction with:

```ts
  const warnings = createWarningAccumulator();
  const targets = selected.map(([connectionId, connection]) =>
    targetForConnection(connectionId, connection, project.config, args, warnings),
  );
  return {
    projectDir: args.projectDir,
    targets: [
      ...targets.filter((t) => t.operation === 'database-ingest'),
      ...targets.filter((t) => t.operation === 'source-ingest'),
    ],
    warnings: finalizeWarnings(warnings, args),
  };
```

- [ ] **Step 6: Run the public ingest planning tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "query-history window override|unsupported database drivers|aggregates ignored"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(ingest): honor query history window intent"
```

### Task 3: Suppress internal scan output in public database ingest

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write the failing quiet-output test**

Add this test inside the `runKtxPublicIngest` describe block in
`packages/cli/src/public-ingest.test.ts`:

```ts
  it('suppresses internal scan output for public database ingest summaries', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const runScan = vi.fn(async (_args, scanIo) => {
      scanIo.stdout.write('KTX scan completed\n');
      scanIo.stdout.write('Mode: structural\n');
      scanIo.stdout.write('Report: raw-sources/warehouse/live-database/sync-1/scan-report.json\n');
      scanIo.stdout.write('Raw sources: raw-sources/warehouse/live-database/sync-1\n');
      return 0;
    });

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'disabled',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runScan },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Ingest finished\n');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).not.toContain('KTX scan completed');
    expect(io.stdout()).not.toContain('Mode: structural');
    expect(io.stdout()).not.toContain('Report: raw-sources');
    expect(io.stdout()).not.toContain('live-database');
  });
```

- [ ] **Step 2: Run the failing quiet-output test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "suppresses internal scan output"
```

Expected: FAIL because `executePublicIngestTarget` passes the public IO
directly to `runScan`.

- [ ] **Step 3: Add captured public scan IO**

In `packages/cli/src/public-ingest.ts`, add these helpers near
`sourceIngestOutputMode`:

```ts
interface CapturedPublicIngestIo extends KtxCliIo {
  capturedOutput(): string;
}

function createCapturedPublicIngestIo(): CapturedPublicIngestIo {
  let output = '';
  return {
    stdout: {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        output += chunk;
      },
    },
    capturedOutput() {
      return output;
    },
  };
}

function firstCapturedFailureLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('KTX scan completed'));
}
```

Change `markTargetResult` to accept a detail override:

```ts
function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
  failureDetail?: string,
): KtxPublicIngestTargetResult {
  const selectedFailedOperation =
    failedOperation ?? (target.operation === 'database-ingest' ? 'database-schema' : 'source-ingest');
  return {
    connectionId: target.connectionId,
    driver: target.driver,
    steps: defaultSteps(target).map((step) => {
      if (!target.steps.includes(step.operation)) {
        return step;
      }
      if (status === 'done') {
        return { ...step, status: 'done' };
      }
      if (step.operation === selectedFailedOperation) {
        return {
          ...step,
          status: 'failed',
          detail: failureDetail ?? `${target.connectionId} failed at ${selectedFailedOperation}.`,
        };
      }
      return { ...step, status: 'not-run' };
    }),
  };
}
```

In the database-ingest branch of `executePublicIngestTarget`, replace the direct
`runScan` call block with:

```ts
    const runScan = deps.runScan ?? runKtxScan;
    const capturedScanIo = deps.scanProgress ? null : createCapturedPublicIngestIo();
    const scanIo = capturedScanIo ?? io;
    const scanExitCode = deps.scanProgress
      ? await runScan(scanArgs, scanIo, { progress: deps.scanProgress })
      : await runScan(scanArgs, scanIo);
    if (scanExitCode !== 0) {
      return markTargetResult(
        target,
        'failed',
        'database-schema',
        capturedScanIo ? firstCapturedFailureLine(capturedScanIo.capturedOutput()) : undefined,
      );
    }
```

- [ ] **Step 4: Run the quiet-output test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "suppresses internal scan output"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(ingest): hide scan internals from public database ingest"
```

### Task 4: Use the shared foreground view for interactive public ingest

**Files:**
- Modify: `packages/cli/src/context-build-view.ts`
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/context-build-view.test.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write failing foreground-view tests**

In `packages/cli/src/context-build-view.test.ts`, add this test inside the
`runContextBuild` describe block:

```ts
  it('runs only the requested connection when foreground build receives a target', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      docs: { driver: 'notion' },
    });
    const executeTarget = vi.fn(async (target) =>
      successResult(target.connectionId, target.driver, target.operation),
    );

    await expect(
      runContextBuild(
        project,
        {
          projectDir: '/tmp/project',
          inputMode: 'disabled',
          targetConnectionId: 'warehouse',
          all: false,
          depth: 'fast',
          queryHistory: 'default',
        },
        io.io,
        { executeTarget, now: () => 1000 },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(executeTarget).toHaveBeenCalledTimes(1);
    expect(executeTarget.mock.calls[0]?.[0]).toMatchObject({
      connectionId: 'warehouse',
      operation: 'database-ingest',
      databaseDepth: 'fast',
    });
    expect(io.stdout()).toContain('Databases:');
    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).not.toContain('docs');
  });
```

In `packages/cli/src/public-ingest.test.ts`, update `makeIo` to accept
interactive stdin:

```ts
function makeIo(options: { isTTY?: boolean; interactive?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      ...(options.interactive
        ? {
            stdin: {
              isTTY: true,
              setRawMode: vi.fn(),
            },
          }
        : {}),
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
```

Then add this test inside the `runKtxPublicIngest` describe block:

```ts
  it('delegates interactive TTY public ingest to the foreground context-build view', async () => {
    const io = makeIo({ isTTY: true, interactive: true });
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const runContextBuild = vi.fn(async () => ({ exitCode: 0 }));
    const runScan = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        {
          command: 'run',
          projectDir: '/tmp/project',
          targetConnectionId: 'warehouse',
          all: false,
          json: false,
          inputMode: 'auto',
          depth: 'fast',
          queryHistory: 'default',
        },
        io.io,
        { loadProject: vi.fn(async () => project), runContextBuild, runScan },
      ),
    ).resolves.toBe(0);

    expect(runContextBuild).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        depth: 'fast',
        queryHistory: 'default',
      }),
      io.io,
    );
    expect(runScan).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the failing foreground-view tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/public-ingest.test.ts -t "requested connection|foreground context-build view"
```

Expected: FAIL because `runContextBuild` always plans `--all`, and
`runKtxPublicIngest` does not delegate interactive TTY runs.

- [ ] **Step 3: Extend foreground context-build args**

In `packages/cli/src/context-build-view.ts`, replace `ContextBuildArgs` with:

```ts
export interface ContextBuildArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  targetConnectionId?: string;
  all?: boolean;
  depth?: Extract<KtxPublicIngestArgs, { command: 'run' }>['depth'];
  queryHistory?: Extract<KtxPublicIngestArgs, { command: 'run' }>['queryHistory'];
  queryHistoryWindowDays?: number;
  scanMode?: 'structural' | 'enriched';
  detectRelationships?: boolean;
}
```

In `runContextBuild`, replace the hard-coded plan call with:

```ts
  const plan = buildPublicIngestPlan(project, {
    projectDir: args.projectDir,
    ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
    all: args.all ?? true,
    ...(args.depth ? { depth: args.depth } : {}),
    ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
    ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
    ...(args.scanMode ? { scanMode: args.scanMode } : {}),
  });
```

Replace the `runArgs` construction with:

```ts
  const runArgs: Extract<KtxPublicIngestArgs, { command: 'run' }> = {
    command: 'run',
    projectDir: args.projectDir,
    ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
    all: args.all ?? true,
    json: false,
    inputMode: args.inputMode,
    ...(args.depth ? { depth: args.depth } : {}),
    ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
    ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
    ...(args.scanMode ? { scanMode: args.scanMode } : {}),
    ...(args.detectRelationships !== undefined ? { detectRelationships: args.detectRelationships } : {}),
  };
```

- [ ] **Step 4: Add a foreground-build dependency to public ingest**

In `packages/cli/src/public-ingest.ts`, add this interface near
`KtxPublicIngestDeps`:

```ts
interface KtxPublicContextBuildArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  targetConnectionId?: string;
  all?: boolean;
  depth?: KtxPublicIngestDepth;
  queryHistory?: KtxPublicIngestQueryHistoryFlag;
  queryHistoryWindowDays?: number;
  scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  detectRelationships?: boolean;
}
```

Add this optional dependency to `KtxPublicIngestDeps`:

```ts
  runContextBuild?: (
    project: KtxPublicIngestProject,
    args: KtxPublicContextBuildArgs,
    io: KtxCliIo,
  ) => Promise<{ exitCode: number }>;
```

Add this helper near `sourceIngestOutputMode`:

```ts
function shouldUseForegroundContextBuildView(
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
): boolean {
  return args.inputMode === 'auto' && args.json !== true && io.stdout.isTTY === true && hasInteractiveInput(io);
}
```

In `runKtxPublicIngest`, after loading `project` and before rendering warnings
or executing targets, add:

```ts
  if (shouldUseForegroundContextBuildView(args, io)) {
    const { runContextBuild } = await import('./context-build-view.js');
    const contextBuild = deps.runContextBuild ?? runContextBuild;
    const result = await contextBuild(
      project,
      {
        projectDir: args.projectDir,
        ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
        all: args.all,
        inputMode: args.inputMode,
        ...(args.depth ? { depth: args.depth } : {}),
        ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
        ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
        ...(args.scanMode ? { scanMode: args.scanMode } : {}),
        ...(args.detectRelationships !== undefined ? { detectRelationships: args.detectRelationships } : {}),
      },
      io,
    );
    return result.exitCode;
  }
```

- [ ] **Step 5: Run the foreground-view tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/public-ingest.test.ts -t "requested connection|foreground context-build view"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "feat(ingest): use foreground view for interactive public ingest"
```

### Task 5: Clean setup database output and query-history setup wording

**Files:**
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/setup-databases.test.ts`
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing setup output expectations**

In `packages/cli/src/setup-databases.test.ts`, update the test named
`summarizes connection test and structural scan output during setup` so the
final output expectation is:

```ts
    expect(io.stdout()).toContain('◇  Building schema context for postgres-warehouse');
    expect(io.stdout()).toContain('│  Running fast database ingest…');
    expect(io.stdout()).toContain('◇  Schema context complete for postgres-warehouse');
    expect(io.stdout()).toContain('│  Changes: 3 changed tables');
    expect(io.stdout()).toContain('◇  Primary source ready');
    expect(io.stdout()).toContain('│  postgres-warehouse · PostgreSQL · schema context complete');
    expect(io.stdout()).not.toContain('Scanning postgres-warehouse');
    expect(io.stdout()).not.toContain('Scan complete for postgres-warehouse');
    expect(io.stdout()).not.toContain('structural scan complete');
    expect(io.stdout()).not.toContain('Report: raw-sources');
    expect(io.stdout()).not.toContain('live-database');
```

In the setup scan-failure test that currently expects `ktx scan`, replace the
expectation with:

```ts
    expect(io.stderr()).toContain(`Retry: ktx ingest warehouse --project-dir ${tempDir} --fast`);
    expect(io.stderr()).not.toContain('ktx scan');
```

In the test named `writes Postgres Historic SQL config with minExecutions and
ignores window/redaction output`, replace the output expectation with:

```ts
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).not.toContain('Historic SQL probe...');
```

In the test named `prints a non-blocking Postgres Historic SQL probe failure
after connection test succeeds`, replace the output expectation with:

```ts
    expect(io.stdout()).toContain('Query history probe...');
    expect(io.stdout()).not.toContain('Historic SQL probe...');
```

- [ ] **Step 2: Write failing setup help expectations**

In `packages/cli/src/index.test.ts`, update the setup help assertion that
currently checks Historic SQL flags to:

```ts
    for (const expected of [
      '--enable-query-history',
      '--disable-query-history',
      '--query-history-window-days',
      '--query-history-min-executions',
      '--query-history-service-account-pattern',
      '--query-history-redaction-pattern',
    ]) {
      expect(testIo.stdout()).toContain(expected);
    }
    expect(testIo.stdout()).not.toContain('--enable-historic-sql');
    expect(testIo.stdout()).not.toContain('--historic-sql-window-days');
```

Replace the conflicting Historic SQL setup flags test with:

```ts
  it('rejects conflicting query-history setup flags', async () => {
    const tempDir = await makeTempProject();
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--enable-query-history', '--disable-query-history'], setupIo.io, {
        setup: vi.fn(async () => 0),
      }),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain(
      'Choose only one query-history action: --enable-query-history or --disable-query-history.',
    );
  });
```

- [ ] **Step 3: Run the failing setup tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts src/index.test.ts -t "structural scan output|query-history setup flags|conflicting query-history|Postgres Historic SQL|non-blocking Postgres"
```

Expected: FAIL because setup still uses scan and Historic SQL wording.

- [ ] **Step 4: Rename setup database args to query history**

In `packages/cli/src/setup-databases.ts`, replace the Historic SQL argument
fields in `KtxSetupDatabasesArgs` with query-history fields:

```ts
  enableQueryHistory?: boolean;
  disableQueryHistory?: boolean;
  queryHistoryWindowDays?: number;
  queryHistoryMinExecutions?: number;
  queryHistoryServiceAccountPatterns?: string[];
  queryHistoryRedactionPatterns?: string[];
```

Update references in `maybeApplyHistoricSqlConfig`:

```ts
  if (!dialect) {
    if (input.args.enableQueryHistory === true) {
      throw new Error(
        `Query history setup is only supported for Snowflake, BigQuery, and Postgres, not ${driverLabel(input.driver)}.`,
      );
    }
    return input.connection;
  }

  let enabled = input.args.enableQueryHistory === true;
  if (input.args.disableQueryHistory === true) {
    enabled = false;
  } else if (input.args.inputMode !== 'disabled' && input.args.enableQueryHistory !== true && dialect !== 'postgres') {
    const choice = await input.prompts.select({
      message: `Enable query-history ingest for this ${driverLabel(input.driver)} connection?`,
      options: [
        { value: 'yes', label: 'Enable query history' },
        { value: 'no', label: 'Do not enable query history' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    enabled = choice === 'yes';
  }

  if (dialect === 'postgres' && input.args.enableQueryHistory !== true && input.args.disableQueryHistory !== true) {
    return input.connection;
  }
```

Update the query-history config construction:

```ts
  const common: Record<string, unknown> = {
    ...existing,
    enabled: true,
    filters: historicSqlFiltersForSetup(input.args.queryHistoryServiceAccountPatterns),
  };

  if (dialect === 'postgres') {
    return withQueryHistoryConfig(input.connection, {
      ...common,
      minExecutions: input.args.queryHistoryMinExecutions ?? 5,
    });
  }

  return withQueryHistoryConfig(input.connection, {
    ...common,
    windowDays: input.args.queryHistoryWindowDays ?? 90,
    redactionPatterns: input.args.queryHistoryRedactionPatterns ?? [],
  });
```

Update both calls to `maybeApplyHistoricSqlConfig` and
`applyHistoricSqlConfigToExistingConnection` by using the renamed args fields;
the function name can remain internal for this task because the source adapter
key is still `historic-sql`.

- [ ] **Step 5: Replace setup scan wording and command suggestions**

In `packages/cli/src/setup-databases.ts`, delete `shortenScanReportPath`.
Then replace the scan output block in `validateAndScanConnection` with:

```ts
  writeSetupSection(input.io, `Building schema context for ${input.connectionId}`, [
    'Running fast database ingest…',
  ]);
```

Replace the Native SQLite retry failure lines with:

```ts
          [
            rebuildCode === 0
              ? `Fast database ingest still failed for ${input.connectionId} after rebuilding Native SQLite.`
              : `Native SQLite rebuild failed for ${input.connectionId}.`,
            'Fix: pnpm run native:rebuild',
            `Retry: ktx ingest ${input.connectionId} --project-dir ${input.projectDir} --fast`,
          ].join('\n'),
```

Replace the non-ABI failure lines with:

```ts
        [
          `Fast database ingest failed for ${input.connectionId}.`,
          `Debug command: ktx ingest ${input.connectionId} --project-dir ${input.projectDir} --fast --debug`,
        ].join('\n'),
```

Replace the success section with:

```ts
  const scanOutput = scanIo.stdoutText();
  writeSetupSection(
    input.io,
    `Schema context complete for ${input.connectionId}`,
    [`Changes: ${summarizeScanChanges(scanOutput)}`],
  );
  writeSetupSection(input.io, 'Primary source ready', [
    `${input.connectionId} · ${driverDisplay} · schema context complete`,
  ]);
```

Replace the probe label in `maybeRunHistoricSqlSetupProbe`:

```ts
  input.io.stdout.write('│  Query history probe...\n');
```

- [ ] **Step 6: Replace public setup flags**

In `packages/cli/src/commands/setup-commands.ts`, replace the Historic SQL
options with:

```ts
    .option('--enable-query-history', 'Enable query history when the selected database supports it', false)
    .option('--disable-query-history', 'Disable query history for the selected database', false)
    .option('--query-history-window-days <number>', 'Query-history lookback window', positiveInteger)
    .option('--query-history-min-executions <number>', 'Minimum executions for a query-history template', positiveInteger)
    .option(
      '--query-history-service-account-pattern <pattern>',
      'Query-history service-account regex; repeatable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--query-history-redaction-pattern <pattern>',
      'Query-history SQL-literal redaction regex; repeatable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
```

Replace the conflict check with:

```ts
    if (options.enableQueryHistory && options.disableQueryHistory) {
      context.io.stderr.write(
        'Choose only one query-history action: --enable-query-history or --disable-query-history.\n',
      );
      context.setExitCode(1);
      return;
    }
```

Replace the setup arg mapping with:

```ts
      ...(options.enableQueryHistory ? { enableQueryHistory: true } : {}),
      ...(options.disableQueryHistory ? { disableQueryHistory: true } : {}),
      ...(options.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: options.queryHistoryWindowDays } : {}),
      ...(options.queryHistoryMinExecutions !== undefined
        ? { queryHistoryMinExecutions: options.queryHistoryMinExecutions }
        : {}),
      ...(options.queryHistoryServiceAccountPattern.length > 0
        ? { queryHistoryServiceAccountPatterns: options.queryHistoryServiceAccountPattern }
        : {}),
      ...(options.queryHistoryRedactionPattern.length > 0
        ? { queryHistoryRedactionPatterns: options.queryHistoryRedactionPattern }
        : {}),
```

- [ ] **Step 7: Update setup database tests to renamed args**

In `packages/cli/src/setup-databases.test.ts`, replace test input property
names as follows:

```ts
enableHistoricSql -> enableQueryHistory
disableHistoricSql -> disableQueryHistory
historicSqlWindowDays -> queryHistoryWindowDays
historicSqlMinExecutions -> queryHistoryMinExecutions
historicSqlServiceAccountPatterns -> queryHistoryServiceAccountPatterns
historicSqlRedactionPatterns -> queryHistoryRedactionPatterns
```

Also rename test names that include `Historic SQL` to use `query history`.
Keep assertions that `configText` does not contain `historic-sql`.

- [ ] **Step 8: Run the setup tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts src/index.test.ts -t "schema context|query history|query-history setup flags|conflicting query-history"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/index.test.ts
git commit -m "fix(setup): use schema context and query history wording"
```

### Task 6: Final verification

**Files:**
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `packages/cli/src/context-build-view.ts`
- Verify: `packages/cli/src/setup-databases.ts`
- Verify: `packages/cli/src/commands/setup-commands.ts`

- [ ] **Step 1: Run targeted CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/context-build-view.test.ts src/setup-databases.test.ts src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run the CLI test suite**

Run:

```bash
pnpm --filter @ktx/cli run test 2>&1 | tee /tmp/ktx-cli-unified-ingest-public-output.log
```

Expected: PASS. If it fails, inspect
`/tmp/ktx-cli-unified-ingest-public-output.log`, fix the failing assertion or
implementation, and rerun this command.

- [ ] **Step 4: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports public exports or dynamic CLI entrypoints,
verify each report before deleting code.

- [ ] **Step 5: Commit verification fixes**

If Step 1 through Step 4 required any changes, commit them:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/index.test.ts
git commit -m "test(cli): verify unified ingest public output"
```

If no files changed during verification, do not create an empty commit.

## Self-review

- Spec coverage: This plan covers the remaining public v1 gaps: adapter
  allow-list bypass, quiet public database ingest output, TTY foreground view,
  query-history window overrides, aggregated `--all` source warnings, setup
  schema-context wording, setup query-history wording, and `ktx scan` retry
  removal from normal setup output.
- Placeholder scan: The plan contains no placeholder markers, deferred tasks,
  or "write tests later" steps.
- Type consistency: The plan keeps public ingest fields aligned with
  `KtxPublicIngestArgs`, uses `allowImplicitAdapter` consistently with
  `runKtxIngest`, and renames setup query-history args consistently from the
  Commander layer through `runKtxSetupDatabasesStep`.
