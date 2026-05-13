# Unified Ingest V1 Final Public Surface Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking public-surface gaps in unified
`ktx ingest`.

**Architecture:** Keep the current connection-centric ingest planner and hidden
legacy debug commands. Fix the public query-history execution path so it passes
the full canonical `connections.<id>.context.queryHistory` pull config to the
historic-SQL adapter, and filter hidden Commander commands from the
documentation command-tree script so docs/discovery output matches normal CLI
help.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages,
pnpm workspace scripts.

---

## Current audit

The implemented unified-ingest plan chain covers most of the original
`docs/superpowers/specs/2026-05-13-unified-ingest-ux-design.md` spec:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` route through `public-ingest.ts`.
- Database targets run before source targets. Public source ingest uses
  `allowImplicitAdapter: true`, so `ingest.adapters` is no longer required for
  inferred public adapters.
- Public database ingest maps `fast` to structural scan internals and `deep` to
  enriched scan internals, honors `scan.relationships.enabled`, and isolates
  deep-readiness failures per target under `--all`.
- Normal `ktx --help` hides `scan`; normal `ktx ingest --help` hides `run` and
  `watch`; setup help exposes query-history flags instead of Historic SQL flags.
- Setup stores `connections.<id>.context.depth` and
  `connections.<id>.context.queryHistory`, migrates legacy `historicSql`, and
  uses foreground-only context-build state.
- Public docs-site CLI pages no longer document `ktx scan`,
  `ktx ingest run --adapter`, or live `ktx ingest watch` as normal workflows.

### V1-blocking gaps

- Public query-history ingest drops configured pull fields. The lower-level
  adapter path maps canonical `context.queryHistory` to the existing
  `historicSqlUnifiedPullConfigSchema`, but `executePublicIngestTarget()` always
  passes `historicSqlPullConfigOverride` with only `dialect` and sometimes
  `windowDays`. Normal `ktx ingest warehouse --query-history` can therefore
  ignore configured `minExecutions`, `filters`, `redactionPatterns`,
  `concurrency`, and `staleArchiveAfterDays`.
- The documentation command-tree script still prints hidden commands. Running
  `pnpm --filter @ktx/cli run docs:commands` currently prints top-level
  `scan <connectionId>` and `ktx ingest run` / `ktx ingest watch`, even though
  the spec requires `ktx scan` and live `ingest watch` not to be presented as
  normal public command surfaces.

### Non-blocking gaps

- Hidden debug commands remain callable: `ktx scan`, `ktx ingest run`, and
  `ktx ingest watch`. The spec allows hidden/debug placement for old
  implementation surfaces in v1.
- Internal adapter keys, package names, WorkUnit keys, raw artifact paths, and
  JSON/debug output can continue to use `scan`, `live-database`, and
  `historic-sql`.
- Developer-only scripts and tests can keep scan/live-database terminology when
  they exercise internal connector or artifact behavior.
- Public docs still use "scan" as a generic noun in a few conceptual database
  sections. They do not document `ktx scan` as the public command, so this is
  wording cleanup, not v1-blocking behavior.

## File structure

- Modify `packages/cli/src/public-ingest.ts`: preserve the full canonical
  query-history pull config in public ingest plans and pass that config to the
  lower-level historic-SQL adapter run.
- Modify `packages/cli/src/public-ingest.test.ts`: add regression coverage for
  configured query-history fields and current-run `windowDays` overrides.
- Modify `packages/cli/src/command-tree.ts`: filter Commander commands marked
  hidden via Commander private `_hidden`, matching Commander help behavior.
- Modify `packages/cli/src/command-tree.test.ts`: cover hidden top-level and
  nested command filtering in the pure walker.
- Modify `packages/cli/src/print-command-tree.test.ts`: lock the rendered KTX
  docs command tree against hidden unified-ingest commands.

## Tasks

### Task 1: Preserve canonical query-history pull config in public ingest

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write the failing public-ingest query-history config test**

In `packages/cli/src/public-ingest.test.ts`, add this test inside the
`runKtxPublicIngest` describe block, near the existing query-history execution
tests:

```ts
  it('preserves configured query-history pull fields while overriding the current-run window', async () => {
    const io = makeIo();
    const project = deepReadyProject({
      warehouse: {
        driver: 'postgres',
        context: {
          queryHistory: {
            enabled: true,
            windowDays: 90,
            minExecutions: 7,
            concurrency: 3,
            staleArchiveAfterDays: 120,
            filters: {
              dropTrivialProbes: true,
              serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
              orchestrators: { mode: 'mark-only' },
              dropFailedBelow: { errorRate: 0.5, executions: 3 },
            },
            redactionPatterns: ['(?i)secret'],
          },
        },
      },
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

    const ingestArgs = runIngest.mock.calls[0]?.[0];
    expect(ingestArgs).toMatchObject({
      command: 'run',
      connectionId: 'warehouse',
      adapter: 'historic-sql',
      allowImplicitAdapter: true,
      historicSqlPullConfigOverride: {
        dialect: 'postgres',
        windowDays: 30,
        minExecutions: 7,
        concurrency: 3,
        staleArchiveAfterDays: 120,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
          orchestrators: { mode: 'mark-only' },
          dropFailedBelow: { errorRate: 0.5, executions: 3 },
        },
        redactionPatterns: ['(?i)secret'],
      },
    });
    expect(ingestArgs?.historicSqlPullConfigOverride).not.toHaveProperty('enabled');
  });
```

- [ ] **Step 2: Run the failing public-ingest test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts --testTimeout 30000
```

Expected: FAIL. The new assertion sees `historicSqlPullConfigOverride` with
`dialect: 'postgres'` and `windowDays: 30`, but without `minExecutions`,
`filters`, `redactionPatterns`, `concurrency`, or
`staleArchiveAfterDays`.

- [ ] **Step 3: Add the full query-history pull config to public plans**

In `packages/cli/src/public-ingest.ts`, update the `queryHistory` field on
`KtxPublicIngestPlanTarget` to include a pull config for enabled query-history
runs:

```ts
  queryHistory?: {
    enabled: boolean;
    dialect?: HistoricSqlDialect;
    windowDays?: number;
    pullConfig?: Record<string, unknown>;
    unsupported?: boolean;
    skippedStoredByFast?: boolean;
  };
```

Still in `packages/cli/src/public-ingest.ts`, add this helper below
`positiveInteger()`:

```ts
function queryHistoryPullConfig(input: {
  stored: Record<string, unknown>;
  dialect: HistoricSqlDialect;
  windowDays?: number;
}): Record<string, unknown> {
  const { enabled: _enabled, dialect: _dialect, ...storedConfig } = input.stored;
  return {
    ...storedConfig,
    dialect: input.dialect,
    ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
  };
}
```

Then replace the enabled-query-history return inside
`resolveDatabaseTargetOptions()` with this version:

```ts
  if (requestedQh && dialect) {
    if (depth === 'fast') {
      input.warnings.push(`--query-history requires deep ingest; running ${input.connectionId} with --deep.`);
    }
    depth = 'deep';
    return {
      databaseDepth: depth,
      queryHistory: {
        ...queryHistory,
        enabled: true,
        dialect,
        pullConfig: queryHistoryPullConfig({
          stored: storedQh,
          dialect,
          windowDays: queryHistory.windowDays,
        }),
      },
      steps: ['database-schema', 'query-history'],
    };
  }
```

- [ ] **Step 4: Pass the preserved pull config into the historic-SQL adapter**

In `packages/cli/src/public-ingest.ts`, replace the
`historicSqlPullConfigOverride` construction in `executePublicIngestTarget()`
with:

```ts
        historicSqlPullConfigOverride:
          target.queryHistory.pullConfig ?? {
            dialect: target.queryHistory.dialect,
            ...(target.queryHistory.windowDays !== undefined ? { windowDays: target.queryHistory.windowDays } : {}),
          },
```

The surrounding `ingestArgs` object must still include:

```ts
        adapter: 'historic-sql',
        outputMode: sourceIngestOutputMode(args, io),
        inputMode: args.inputMode,
        allowImplicitAdapter: true,
```

- [ ] **Step 5: Run the public-ingest tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts --testTimeout 30000
```

Expected: PASS. The new regression test proves public ingest preserves stored
query-history fields while `--query-history-window-days 30` overrides only
`windowDays` for the current run.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(cli): preserve query-history pull config in public ingest"
```

### Task 2: Hide debug commands from the docs command tree

**Files:**
- Modify: `packages/cli/src/command-tree.ts`
- Test: `packages/cli/src/command-tree.test.ts`
- Test: `packages/cli/src/print-command-tree.test.ts`

- [ ] **Step 1: Write the failing hidden-command walker test**

In `packages/cli/src/command-tree.test.ts`, add this test inside the
`walkCommandTree` describe block:

```ts
  it('omits Commander hidden commands from the public tree', () => {
    const root = new Command('ktx');
    root.command('scan', { hidden: true }).description('Run a standalone connection scan');
    const ingest = root.command('ingest').description('Build or inspect KTX context');
    ingest.command('run', { hidden: true }).description('Run local ingest by adapter');
    ingest.command('watch', { hidden: true }).description('Open a stored visual report');
    ingest.command('status').description('Print status');
    root.command('status').description('Check readiness');

    const tree = walkCommandTree(root);

    expect(tree.children.map((child) => child.name)).toEqual(['ingest', 'status']);
    expect(tree.children[0]).toMatchObject({
      name: 'ingest',
      children: [{ name: 'status', description: 'Print status', aliases: [], arguments: [], children: [] }],
    });
  });
```

- [ ] **Step 2: Write the failing rendered KTX tree assertions**

In `packages/cli/src/print-command-tree.test.ts`, add these assertions to the
first `renders an indented tree rooted at "ktx" with known top-level commands`
test after the existing `not.toContain()` assertions:

```ts
    expect(output).not.toContain('scan <connectionId>');
    expect(output).not.toContain('│   ├── run');
    expect(output).not.toContain('│   ├── watch');
    expect(output).not.toContain('│   └── watch');
```

- [ ] **Step 3: Run the failing command-tree tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/command-tree.test.ts src/print-command-tree.test.ts
```

Expected: FAIL. The walker includes hidden commands because it currently maps
over `command.commands` without filtering Commander `_hidden` entries.

- [ ] **Step 4: Filter hidden Commander commands in the walker**

In `packages/cli/src/command-tree.ts`, add this helper above
`walkCommandTree()`:

```ts
function isHiddenCommand(command: CommandUnknownOpts): boolean {
  return (command as CommandUnknownOpts & { _hidden?: boolean })._hidden === true;
}
```

Then replace the `children` field inside `walkCommandTree()` with:

```ts
    children: command.commands.filter((child) => !isHiddenCommand(child)).map((child) => walkCommandTree(child)),
```

The complete function should read:

```ts
export function walkCommandTree(command: CommandUnknownOpts): CommandTreeNode {
  return {
    name: command.name(),
    description: command.description(),
    aliases: command.aliases(),
    arguments: command.registeredArguments.map(formatArgumentDeclaration),
    children: command.commands.filter((child) => !isHiddenCommand(child)).map((child) => walkCommandTree(child)),
  };
}
```

- [ ] **Step 5: Run the command-tree tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/command-tree.test.ts src/print-command-tree.test.ts
```

Expected: PASS. The pure walker omits hidden commands and the rendered KTX tree
no longer contains `scan <connectionId>`, `ingest run`, or `ingest watch`.

- [ ] **Step 6: Verify the docs command output directly**

Run:

```bash
pnpm --filter @ktx/cli run docs:commands > /tmp/ktx-command-tree.txt
rg -n "scan <connectionId>|^[[:space:][:graph:]]*run[[:space:]]+Run local ingest|^[[:space:][:graph:]]*watch \\[runId\\]" /tmp/ktx-command-tree.txt
```

Expected: the first command succeeds and writes the command tree. The `rg`
command exits with status `1` and prints no matches.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/cli/src/command-tree.ts packages/cli/src/command-tree.test.ts packages/cli/src/print-command-tree.test.ts
git commit -m "fix(cli): omit hidden commands from docs command tree"
```

### Task 3: Final verification

**Files:**
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `packages/cli/src/command-tree.ts`
- Verify: `packages/cli/src/public-ingest.test.ts`
- Verify: `packages/cli/src/command-tree.test.ts`
- Verify: `packages/cli/src/print-command-tree.test.ts`

- [ ] **Step 1: Run focused CLI regression tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/local-adapters.test.ts src/index.test.ts src/command-tree.test.ts src/print-command-tree.test.ts --testTimeout 30000
```

Expected: PASS. This covers public ingest execution, adapter config mapping,
normal help routing, and docs command-tree rendering.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run docs command-tree output check**

Run:

```bash
pnpm --filter @ktx/cli run docs:commands > /tmp/ktx-command-tree.txt
rg -n "scan <connectionId>|^[[:space:][:graph:]]*run[[:space:]]+Run local ingest|^[[:space:][:graph:]]*watch \\[runId\\]" /tmp/ktx-command-tree.txt
```

Expected: the `docs:commands` command succeeds. The `rg` command exits `1`
with no matches.

- [ ] **Step 4: Run TypeScript dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports unrelated existing findings, inspect them and
record the exact findings in the implementation notes before deciding whether
they are related to this plan.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git status --short
git diff -- packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/command-tree.ts packages/cli/src/command-tree.test.ts packages/cli/src/print-command-tree.test.ts
```

Expected: only the intended files are modified. The diff contains no generated
`dist/` output and no unrelated documentation changes.

- [ ] **Step 6: Commit verification-only fixes if needed**

If verification required expectation or type-only fixes, run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/command-tree.ts packages/cli/src/command-tree.test.ts packages/cli/src/print-command-tree.test.ts
git commit -m "test(cli): close unified ingest final public surface checks"
```

If no files changed during verification, do not create an empty commit.

## Self-review

- Spec coverage: This plan covers the remaining v1-blocking public query-history
  config mapping and public command discovery output. It intentionally leaves
  hidden debug command callability and internal scan/live-database/historic-sql
  names as non-blocking because the original spec allows internal/debug names
  in v1.
- Placeholder scan: No task uses deferred placeholders or unnamed edge-handling
  steps. Each code step names the exact file, insertion point, and code shape.
- Type consistency: New `pullConfig` data stays under
  `KtxPublicIngestPlanTarget.queryHistory` and flows unchanged into the
  existing `KtxIngestArgs.historicSqlPullConfigOverride` field. Command-tree
  filtering uses Commander `_hidden`, the same field Commander help uses.
