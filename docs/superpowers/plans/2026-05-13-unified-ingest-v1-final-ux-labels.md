# Unified Ingest V1 Final UX Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking public UX gaps in unified ingest warning aggregation and setup/status terminology.

**Architecture:** Keep the implemented connection-centric ingest planner, hidden debug commands, and internal scan/live-database/historic-sql boundaries. Add one warning accumulator lane for unsupported database query-history targets, then update normal setup/status/docs copy so public database groups are called `Databases` rather than `Primary sources`.

**Tech Stack:** TypeScript ESM, Commander, Vitest, Node test runner, KTX CLI/context packages.

---

## Current Audit

Implemented unified-ingest plans already cover the original spec's main v1 behavior:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`, `--query-history`, `--no-query-history`, and `--query-history-window-days` route through `packages/cli/src/public-ingest.ts`.
- Database targets are ordered before source targets, public source ingest bypasses `ingest.adapters`, and database depth maps to structural/enriched scan internals.
- Deep readiness is evaluated before target work starts, and `--all` isolates per-target failures.
- Setup stores `connections.<id>.context.depth` and `connections.<id>.context.queryHistory`, migrates legacy `historicSql`, and uses foreground-only context-build state.
- Normal help hides `ktx scan`, `ktx ingest run`, and live `ktx ingest watch`; docs no longer present those as normal public workflows.
- Foreground progress uses `Databases` and `Context sources`, and normal progress/failure output sanitizes scan/live-database/historic-sql internals.

### V1-Blocking Gaps

- `ktx ingest --all --query-history` does not aggregate unsupported database query-history warnings. Source depth/query-history warnings are aggregated, but unsupported database drivers currently add one warning per target from `resolveDatabaseTargetOptions()`, contrary to the original spec's `--all` warning aggregation rule for non-applicable query-history flags.
- Normal setup/status surfaces still use the old `Primary sources` public label for databases:
  - `packages/cli/src/setup.ts` prints `Primary sources configured`.
  - `packages/cli/src/setup-context.ts` prints a `Primary sources:` success group.
  - `packages/cli/src/setup-ready-menu.ts` labels the database section `Primary sources`.
  - `packages/cli/src/setup-databases.ts` uses `primary source` in normal interactive prompts, skip/failure messages, and success headings.
  - `README.md`, `docs-site/content/docs/getting-started/quickstart.mdx`, and `docs-site/content/docs/cli-reference/ktx-setup.mdx` still mirror the old label.

### Non-Blocking Gaps

- Hidden debug commands can remain callable: `ktx scan`, `ktx ingest run`, and `ktx ingest watch`.
- Internal adapter keys, raw artifact paths, WorkUnit keys, package names, tests, and developer-only scripts can continue to use `scan`, `live-database`, and `historic-sql`.
- Public conceptual docs may still use `scan` as a generic noun where they are describing internal database metadata artifacts rather than documenting `ktx scan` as the public command.
- Internal readiness config names such as `scan.enrichment.mode` can remain because they are current `ktx.yaml` field names.

## File Structure

- Modify `packages/cli/src/public-ingest.ts`: aggregate unsupported database query-history warnings for `--all`.
- Modify `packages/cli/src/public-ingest.test.ts`: add regression tests for explicit and stored unsupported query-history aggregation.
- Modify `packages/cli/src/setup-ready-menu.ts`: change the ready-project database menu label to `Databases`.
- Modify `packages/cli/src/setup-ready-menu.test.ts`: update the ready-menu expected label.
- Modify `packages/cli/src/setup.ts`: change setup status output from `Primary sources configured` to `Databases configured`.
- Modify `packages/cli/src/setup.test.ts`: update status and empty-selection expectations.
- Modify `packages/cli/src/setup-context.ts`: change setup context success grouping from `Primary sources` to `Databases`.
- Modify `packages/cli/src/setup-context.test.ts`: assert the success output uses `Databases`.
- Modify `packages/cli/src/setup-databases.ts`: change normal database setup copy from `primary source(s)` / `knowledge sources` to `database(s)` / `context sources`.
- Modify `packages/cli/src/setup-databases.test.ts`: update expected prompt/output strings.
- Modify `README.md`: update the setup status example label.
- Modify `docs-site/content/docs/getting-started/quickstart.mdx`: update setup success/status examples.
- Modify `docs-site/content/docs/cli-reference/ktx-setup.mdx`: update setup status example.
- Modify `scripts/examples-docs.test.mjs`: add docs regression assertions for the old `Primary sources` label.

## Tasks

### Task 1: Aggregate Unsupported Query-History Warnings

**Files:**
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Add failing unsupported warning aggregation tests**

In `packages/cli/src/public-ingest.test.ts`, add these tests after the existing test named `warns and skips query history for unsupported database drivers`:

```ts
  it('aggregates unsupported query-history warnings for all database targets', () => {
    const plan = buildPublicIngestPlan(
      deepReadyProject({
        local: { driver: 'sqlite' },
        mysql_warehouse: { driver: 'mysql' },
        warehouse: { driver: 'postgres', context: { depth: 'deep' } },
      }),
      {
        projectDir: '/tmp/project',
        all: true,
        depth: 'deep',
        queryHistory: 'enabled',
      },
    );

    expect(plan.targets).toEqual([
      expect.objectContaining({
        connectionId: 'local',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
      expect.objectContaining({
        connectionId: 'mysql_warehouse',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
      expect.objectContaining({
        connectionId: 'warehouse',
        queryHistory: expect.objectContaining({ enabled: true, dialect: 'postgres' }),
        steps: ['database-schema', 'query-history'],
      }),
    ]);
    expect(plan.warnings).toEqual([
      '--query-history is not supported for 2 database connections (mysql, sqlite); running schema ingest for those connections.',
    ]);
  });

  it('aggregates stored unsupported query-history config warnings for all database targets', () => {
    const plan = buildPublicIngestPlan(
      projectWithConnections({
        local: { driver: 'sqlite', context: { queryHistory: { enabled: true } } },
        mysql_warehouse: { driver: 'mysql', context: { queryHistory: { enabled: true } } },
      }),
      {
        projectDir: '/tmp/project',
        all: true,
        queryHistory: 'default',
      },
    );

    expect(plan.targets).toEqual([
      expect.objectContaining({
        connectionId: 'local',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
      expect.objectContaining({
        connectionId: 'mysql_warehouse',
        queryHistory: { enabled: false, unsupported: true },
        steps: ['database-schema'],
      }),
    ]);
    expect(plan.warnings).toEqual([
      '2 database connections have query history enabled in ktx.yaml, but their drivers do not support it; running schema ingest for those connections.',
    ]);
  });
```

- [ ] **Step 2: Run the failing public ingest tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "unsupported query-history"
```

Expected: FAIL because the new `--all` cases currently receive one warning per unsupported database target.

- [ ] **Step 3: Add unsupported query-history warning accumulator state**

In `packages/cli/src/public-ingest.ts`, replace the current warning accumulator interface and factory with:

```ts
interface KtxUnsupportedQueryHistoryWarning {
  connectionId: string;
  driver: string;
  reason: 'explicit' | 'stored';
}

interface KtxPublicIngestWarningAccumulator {
  warnings: string[];
  ignoredDepthForSources: string[];
  ignoredQueryHistoryForSources: string[];
  unsupportedQueryHistoryForDatabases: KtxUnsupportedQueryHistoryWarning[];
}

function createWarningAccumulator(): KtxPublicIngestWarningAccumulator {
  return {
    warnings: [],
    ignoredDepthForSources: [],
    ignoredQueryHistoryForSources: [],
    unsupportedQueryHistoryForDatabases: [],
  };
}
```

- [ ] **Step 4: Add unsupported database warning formatting**

In `packages/cli/src/public-ingest.ts`, add these helpers after `sourceIgnoredWarning()`:

```ts
function unsupportedDriverList(entries: KtxUnsupportedQueryHistoryWarning[]): string {
  return [...new Set(entries.map((entry) => entry.driver))].sort((left, right) => left.localeCompare(right)).join(', ');
}

function unsupportedQueryHistoryWarnings(
  entries: KtxUnsupportedQueryHistoryWarning[],
  all: boolean,
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const warnings: string[] = [];
  const explicitEntries = entries.filter((entry) => entry.reason === 'explicit');
  const storedEntries = entries.filter((entry) => entry.reason === 'stored');

  if (explicitEntries.length === 1 || (!all && explicitEntries.length > 0)) {
    warnings.push(
      ...explicitEntries.map(
        (entry) =>
          `--query-history is not supported for ${entry.driver}; running schema ingest for ${entry.connectionId}.`,
      ),
    );
  } else if (explicitEntries.length > 1) {
    warnings.push(
      `--query-history is not supported for ${explicitEntries.length} database connections (${unsupportedDriverList(
        explicitEntries,
      )}); running schema ingest for those connections.`,
    );
  }

  if (storedEntries.length === 1 || (!all && storedEntries.length > 0)) {
    warnings.push(
      ...storedEntries.map(
        (entry) =>
          `${entry.connectionId} has query history enabled in ktx.yaml, but ${entry.driver} does not support it; running schema ingest.`,
      ),
    );
  } else if (storedEntries.length > 1) {
    warnings.push(
      `${storedEntries.length} database connections have query history enabled in ktx.yaml, but their drivers do not support it; running schema ingest for those connections.`,
    );
  }

  return warnings;
}
```

- [ ] **Step 5: Use the accumulator in `finalizeWarnings()`**

In `packages/cli/src/public-ingest.ts`, replace the start of `finalizeWarnings()` with:

```ts
  const warnings = [
    ...accumulator.warnings,
    ...unsupportedQueryHistoryWarnings(accumulator.unsupportedQueryHistoryForDatabases, args.all),
  ];
```

Keep the existing source depth/query-history aggregation logic below that new `warnings` initialization.

- [ ] **Step 6: Record unsupported database targets instead of pushing immediate warnings**

In `packages/cli/src/public-ingest.ts`, change the `resolveDatabaseTargetOptions()` input type so `warnings` is the full accumulator:

```ts
  warnings: KtxPublicIngestWarningAccumulator;
```

Inside the unsupported query-history branch, replace the current `input.warnings.push(...)` block with:

```ts
    input.warnings.unsupportedQueryHistoryForDatabases.push({
      connectionId: input.connectionId,
      driver: input.driver,
      reason: explicitQueryHistory === 'enabled' || input.args.queryHistoryWindowDays !== undefined ? 'explicit' : 'stored',
    });
```

In the supported query-history branch, replace:

```ts
      input.warnings.push(`--query-history requires deep ingest; running ${input.connectionId} with --deep.`);
```

with:

```ts
      input.warnings.warnings.push(`--query-history requires deep ingest; running ${input.connectionId} with --deep.`);
```

In the stored query-history skipped-by-fast branch, replace:

```ts
    input.warnings.push(
      `${input.connectionId} has query history enabled in ktx.yaml, but --fast skips query-history processing.`,
    );
```

with:

```ts
    input.warnings.warnings.push(
      `${input.connectionId} has query history enabled in ktx.yaml, but --fast skips query-history processing.`,
    );
```

In `targetForConnection()`, replace the database resolver call with:

```ts
    const options = resolveDatabaseTargetOptions({ connectionId, driver, connection, args, warnings });
```

- [ ] **Step 7: Verify unsupported warning aggregation passes**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "unsupported query-history"
```

Expected: PASS. The single-target warning tests keep the old exact messages, while `--all` unsupported database targets receive one aggregate warning per reason.

- [ ] **Step 8: Commit unsupported warning aggregation**

Run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(cli): aggregate unsupported query-history warnings"
```

### Task 2: Rename Public Setup Database Labels

**Files:**
- Modify: `packages/cli/src/setup-ready-menu.ts`
- Modify: `packages/cli/src/setup.ts`
- Modify: `packages/cli/src/setup-context.ts`
- Modify: `packages/cli/src/setup-databases.ts`
- Test: `packages/cli/src/setup-ready-menu.test.ts`
- Test: `packages/cli/src/setup.test.ts`
- Test: `packages/cli/src/setup-context.test.ts`
- Test: `packages/cli/src/setup-databases.test.ts`
- Modify: `README.md`
- Modify: `docs-site/content/docs/getting-started/quickstart.mdx`
- Modify: `docs-site/content/docs/cli-reference/ktx-setup.mdx`
- Test: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Write failing CLI copy expectations**

In `packages/cli/src/setup-ready-menu.test.ts`, change the expected database option to:

```ts
        { value: 'databases', label: 'Databases' },
```

In `packages/cli/src/setup-context.test.ts`, add these assertions after each `expect(io.stdout()).toContain('KTX context is ready for agents.');` assertion in the successful build and existing-context tests:

```ts
    expect(io.stdout()).toContain('Databases:');
    expect(io.stdout()).not.toContain('Primary sources:');
```

In `packages/cli/src/setup.test.ts`, change the empty database selection expectation to:

```ts
    expect(testIo.stdout()).toContain(
      'KTX cannot work without at least one database. Select a database or press Escape to go back.',
    );
    expect(testIo.stderr()).not.toContain('No databases selected.');
```

In `packages/cli/src/setup.test.ts`, in the existing-project status test, add:

```ts
    expect(rendered).toContain('Databases configured: no');
    expect(rendered).not.toContain('Primary sources configured');
```

- [ ] **Step 2: Write failing setup database prompt expectations**

In `packages/cli/src/setup-databases.test.ts`, update the old public copy expectations to the new database labels:

```ts
expect(prompts.multiselect).toHaveBeenCalledWith(
  expect.objectContaining({
    message: expect.stringContaining('Which databases should KTX connect to?'),
  }),
);
```

For configured database menu expectations, use:

```ts
expect(prompts.select).toHaveBeenCalledWith({
  message: 'Databases already configured: warehouse\nWhat would you like to do?',
  options: [
    { value: 'continue', label: 'Continue to context sources' },
    { value: 'add', label: 'Add another database' },
  ],
});
```

For the `postgres-warehouse` configured menu expectations, use:

```ts
expect(prompts.select).toHaveBeenCalledWith({
  message: 'Databases already configured: postgres-warehouse\nWhat would you like to do?',
  options: [
    { value: 'continue', label: 'Continue to context sources' },
    { value: 'add', label: 'Add another database' },
  ],
});
```

For empty-selection output expectations, use:

```ts
expect(io.stdout()).not.toContain('KTX cannot work without at least one database');
```

For successful initial scan/setup output, use:

```ts
expect(io.stdout()).toContain('◇  Database ready');
expect(io.stdout()).not.toContain('Primary source ready');
```

Rename test descriptions that contain `primary source` or `primary sources` so they use `database` or `databases`. For example:

```ts
  it('shows every supported database in the interactive checklist', async () => {
```

```ts
  it('shows a configured database menu instead of the type checklist when a database exists', async () => {
```

```ts
  it('lets users add another database after completing the first one', async () => {
```

- [ ] **Step 3: Run failing setup label tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-ready-menu.test.ts src/setup.test.ts src/setup-context.test.ts src/setup-databases.test.ts -t "ready menu|readiness checklist|context is ready|database|primary source|configured"
```

Expected: FAIL because production copy still uses `Primary sources` and `primary source`.

- [ ] **Step 4: Update the ready menu and status labels**

In `packages/cli/src/setup-ready-menu.ts`, change:

```ts
      { value: 'databases', label: 'Primary sources' },
```

to:

```ts
      { value: 'databases', label: 'Databases' },
```

In `packages/cli/src/setup.ts`, change:

```ts
    `Primary sources configured: ${formatConnectionList(status.databases.map((database) => database.connectionId))}`,
```

to:

```ts
    `Databases configured: ${formatConnectionList(status.databases.map((database) => database.connectionId))}`,
```

In `packages/cli/src/setup-context.ts`, change:

```ts
  io.stdout.write('Primary sources:\n');
```

to:

```ts
  io.stdout.write('Databases:\n');
```

- [ ] **Step 5: Update setup database prompt and output copy**

In `packages/cli/src/setup-databases.ts`, change:

```ts
  const backDestination = canReturnToDriverSelection ? 'primary source selection' : 'the previous setup step';
```

to:

```ts
  const backDestination = canReturnToDriverSelection ? 'database selection' : 'the previous setup step';
```

Replace the entire `configuredPrimarySourcesPrompt()` return value with:

```ts
  return {
    message: `Databases already configured: ${connectionIds.join(', ')}\nWhat would you like to do?`,
    options: [
      { value: 'continue', label: 'Continue to context sources' },
      { value: 'add', label: 'Add another database' },
    ],
  };
```

Change the successful database setup heading from:

```ts
  writeSetupSection(input.io, 'Primary source ready', [
```

to:

```ts
  writeSetupSection(input.io, 'Database ready', [
```

Change the non-interactive no-database error from:

```ts
      'KTX cannot work without a primary source. Pass --database or --database-connection-id, or pass --skip-databases to leave setup incomplete.\n',
```

to:

```ts
      'KTX cannot work without a database. Pass --database or --database-connection-id, or pass --skip-databases to leave setup incomplete.\n',
```

Change the driver multiselect message from:

```ts
      message: withMultiselectNavigation('Which primary sources should KTX connect to?'),
```

to:

```ts
      message: withMultiselectNavigation('Which databases should KTX connect to?'),
```

Change the empty-selection warning from:

```ts
    io.stdout.write('│  KTX cannot work without at least one primary source. Select a source or press Escape to go back.\n');
```

to:

```ts
    io.stdout.write('│  KTX cannot work without at least one database. Select a database or press Escape to go back.\n');
```

Change the skip output from:

```ts
    io.stdout.write('│  Primary source setup skipped. KTX cannot work until you add a primary source.\n');
```

to:

```ts
    io.stdout.write('│  Database setup skipped. KTX cannot work until you add a database.\n');
```

Change the no-completed-database output from:

```ts
      io.stdout.write('│  KTX cannot work without a primary source.\n');
```

to:

```ts
      io.stdout.write('│  KTX cannot work without a database.\n');
```

Change the retry prompt message and skip label from:

```ts
          message: `Primary source setup failed for ${connectionChoice.connectionId}`,
```

```ts
            { value: 'skip', label: 'Skip this primary source' },
```

to:

```ts
          message: `Database setup failed for ${connectionChoice.connectionId}`,
```

```ts
            { value: 'skip', label: 'Skip this database' },
```

Change the final failure line from:

```ts
      io.stderr.write('No primary source connections completed setup.\n');
```

to:

```ts
      io.stderr.write('No database connections completed setup.\n');
```

- [ ] **Step 6: Update public docs examples**

In `README.md`, replace:

```text
Primary sources configured: yes (postgres-warehouse)
```

with:

```text
Databases configured: yes (postgres-warehouse)
```

In `docs-site/content/docs/getting-started/quickstart.mdx`, replace the database-ready heading line:

```text
Primary source ready
  postgres-warehouse - PostgreSQL - schema context complete
```

with:

```text
Database ready
  postgres-warehouse - PostgreSQL - schema context complete
```

In `docs-site/content/docs/getting-started/quickstart.mdx`, replace the setup success group:

```text
Primary sources:
  postgres-warehouse: deep context complete
```

with:

```text
Databases:
  postgres-warehouse: deep context complete
```

In `docs-site/content/docs/getting-started/quickstart.mdx`, replace:

```text
Primary sources configured: yes (postgres-warehouse)
```

with:

```text
Databases configured: yes (postgres-warehouse)
```

In `docs-site/content/docs/cli-reference/ktx-setup.mdx`, replace:

```text
Primary sources configured: yes (postgres-warehouse)
```

with:

```text
Databases configured: yes (postgres-warehouse)
```

- [ ] **Step 7: Add public docs regression assertions**

In `scripts/examples-docs.test.mjs`, inside the test named `documents unified public ingest workflows in the docs site`, add:

```js
    const setupReference = await readText('docs-site/content/docs/cli-reference/ktx-setup.mdx');
```

Then add these assertions near the existing `quickstart` and `rootReadme` assertions:

```js
    assert.match(rootReadme, /Databases configured: yes \(postgres-warehouse\)/);
    assert.match(quickstart, /Databases:\n  postgres-warehouse: deep context complete/);
    assert.match(quickstart, /Databases configured: yes \(postgres-warehouse\)/);
    assert.match(setupReference, /Databases configured: yes \(postgres-warehouse\)/);
    assert.doesNotMatch(rootReadme, /Primary sources configured/);
    assert.doesNotMatch(quickstart, /Primary sources/);
    assert.doesNotMatch(setupReference, /Primary sources configured/);
```

- [ ] **Step 8: Verify setup label tests pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-ready-menu.test.ts src/setup.test.ts src/setup-context.test.ts src/setup-databases.test.ts
```

Expected: PASS.

- [ ] **Step 9: Verify docs examples pass**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 10: Scan for stale public labels**

Run:

```bash
rg -n "Primary sources?:|Primary sources? configured|Primary source ready|knowledge sources" packages/cli/src README.md docs-site/content/docs scripts/examples-docs.test.mjs
```

Expected: no matches in public CLI source, README/docs examples, or the docs regression test.

- [ ] **Step 11: Commit public setup labels**

Run:

```bash
git add packages/cli/src/setup-ready-menu.ts packages/cli/src/setup-ready-menu.test.ts packages/cli/src/setup.ts packages/cli/src/setup.test.ts packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts README.md docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/cli-reference/ktx-setup.mdx scripts/examples-docs.test.mjs
git commit -m "fix(cli): align setup database labels"
```

### Task 3: Final V1 Verification

**Files:**
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `packages/cli/src/setup-ready-menu.ts`
- Verify: `packages/cli/src/setup.ts`
- Verify: `packages/cli/src/setup-context.ts`
- Verify: `packages/cli/src/setup-databases.ts`
- Verify: `README.md`
- Verify: `docs-site/content/docs/getting-started/quickstart.mdx`
- Verify: `docs-site/content/docs/cli-reference/ktx-setup.mdx`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/context-build-view.test.ts src/setup-ready-menu.test.ts src/setup.test.ts src/setup-context.test.ts src/setup-databases.test.ts src/index.test.ts src/command-tree.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run docs regression tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run public unified-ingest stale-copy scans**

Run:

```bash
rg -n "Primary sources?:|Primary sources? configured|Primary source ready|knowledge sources" packages/cli/src README.md docs-site/content/docs scripts/examples-docs.test.mjs
```

Expected: no matches.

Run:

```bash
rg -n "ktx scan|ktx ingest run --connection-id|--adapter <adapter>|ktx ingest watch|live-database|Historic SQL|historicSql" README.md docs-site/content/docs examples/README.md examples/local-warehouse/README.md
```

Expected: no matches. Matches in developer scripts, internal package names, tests, or artifact paths outside this public-docs command are non-blocking under the original spec.

- [ ] **Step 4: Run package pre-commit on changed files**

Run:

```bash
uv run pre-commit run --files packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/setup-ready-menu.ts packages/cli/src/setup-ready-menu.test.ts packages/cli/src/setup.ts packages/cli/src/setup.test.ts packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts README.md docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/cli-reference/ktx-setup.mdx scripts/examples-docs.test.mjs
```

Expected: PASS. If pre-commit is unavailable because the local `uv` version or hook environment is missing, record the exact failure and run the focused Vitest and Node tests from Steps 1 and 2.

- [ ] **Step 5: Commit final verification if needed**

If Step 4 made formatting changes, run:

```bash
git add packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts packages/cli/src/setup-ready-menu.ts packages/cli/src/setup-ready-menu.test.ts packages/cli/src/setup.ts packages/cli/src/setup.test.ts packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts README.md docs-site/content/docs/getting-started/quickstart.mdx docs-site/content/docs/cli-reference/ktx-setup.mdx scripts/examples-docs.test.mjs
git commit -m "test: verify unified ingest final ux labels"
```

If Step 4 made no changes, do not create an empty commit.

## Self-Review

- Spec coverage: This plan covers the remaining v1-blocking public gaps found in the audit: unsupported database query-history warning aggregation for `--all`, and old public `Primary sources` terminology in setup/status/docs where the spec's user-facing grouping is `Databases`. Core routing, depth, query-history execution, setup config, foreground-only state, hidden debug commands, public docs command shape, and output sanitization are already implemented by the prior plan chain.
- Placeholder scan: The plan contains exact files, exact tests, exact code snippets, exact commands, and expected outcomes.
- Type consistency: The new accumulator type is `KtxUnsupportedQueryHistoryWarning`; `resolveDatabaseTargetOptions()` receives `KtxPublicIngestWarningAccumulator`; warning strings used in tests match the implementation snippets exactly.
