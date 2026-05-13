# Unified Ingest V1 Query History Status Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking public UX gaps in the unified
`ktx ingest` redesign.

**Architecture:** Keep the implemented connection-centric ingest planner and
foreground context-build view. Patch the public setup, status, doctor, retry,
and example surfaces so canonical `context.queryHistory` and
`ktx ingest <connectionId>` are the only normal user-facing paths.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages,
Markdown examples, shell smoke scripts.

---

## Current audit

The three implemented unified-ingest plans cover most of the original spec:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` are routed through `public-ingest.ts`.
- Database targets run before source targets, inferred public adapters bypass
  `ingest.adapters`, fast/deep map to structural/enriched scan internals, and
  deep readiness failures are per-target failures under `--all`.
- `ktx scan`, `ktx ingest run`, and `ktx ingest watch` are hidden from normal
  help.
- Setup stores `connections.<id>.context.depth`, config parsing rejects
  reserved ingest subcommand ids, generated default config omits normal
  adapter allow-list entries, and setup context builds are foreground-only.
- Public database ingest suppresses normal internal scan output, source ingest
  passes `allowImplicitAdapter: true`, query-history window overrides enable
  query history for the current run, and TTY public ingest delegates to the
  shared foreground view.

### V1-blocking gaps

- `packages/cli/src/setup.ts` still exposes and forwards
  `enableHistoricSql`, `disableHistoricSql`, and `historicSql*` args into the
  database setup step. Public Commander flags now produce `enableQueryHistory`
  and `queryHistory*`, so full `ktx setup --enable-query-history ...` does not
  reach `runKtxSetupDatabasesStep`.
- Interactive Postgres setup does not ask whether to enable query history when
  no query-history flag is provided, even though Postgres is a supported v1
  query-history driver.
- `ktx status`/project doctor still reads legacy
  `connections.<id>.historicSql`, ignores canonical
  `connections.<id>.context.queryHistory`, and prints public
  `Postgres Historic SQL` labels.
- `ktx ingest status` with no stored reports still suggests
  `ktx ingest run --connection-id <id> --adapter <adapter>`, which the spec
  explicitly removes from normal guidance.
- Public query-history failures can surface `Historic SQL local ingest...`
  messages from `local-adapters.ts`.
- The shared foreground view always formats retry guidance as `ktx setup`,
  even when it is running direct public `ktx ingest <connectionId>`.
- Query-history foreground progress can show raw `historic-sql` adapter text
  from lower-level ingest progress messages.
- Public examples still document old query-history and adapter surfaces:
  `examples/postgres-historic/README.md`,
  `examples/postgres-historic/scripts/smoke.sh`, and
  `examples/README.md` still use `Historic SQL`, `--enable-historic-sql`,
  `--historic-sql-*`, and `ktx ingest run --adapter historic-sql`.
- Checked-in example project configs still contain normal
  `ingest.adapters: [live-database]`, contrary to the v1 config model.

### Non-blocking gaps

- Hidden debug commands can continue to call `ktx scan`, `ktx ingest run`, and
  `ktx ingest watch`.
- Internal adapter keys, package names, raw artifact paths, WorkUnit keys,
  skill names, and JSON/debug output can continue to use `scan`,
  `live-database`, and `historic-sql`.
- Internal scripts such as relationship verification and artifact packaging can
  keep standalone scan/live-database terminology when they are explicitly
  developer-only.
- `setup.ts` still has dead `detached`/`paused`/`autoWatch` type remnants.
  They are not currently user-facing because setup context state is normalized
  and background watch flows have been removed.
- README package taxonomy such as `Postgres scan connector` can remain because
  it describes internal package ownership, not public command usage.

## File structure

- Modify `packages/cli/src/setup.ts`: rename setup args and database-step
  forwarding from historic-SQL names to query-history names.
- Modify `packages/cli/src/setup.test.ts`: cover full setup forwarding of
  query-history flags into the database setup runner.
- Modify `packages/cli/src/setup-databases.ts`: ask the query-history prompt
  for Postgres when interactive and no explicit query-history flag is supplied.
- Modify `packages/cli/src/setup-databases.test.ts`: cover interactive
  Postgres query-history enablement through the canonical
  `context.queryHistory` shape.
- Modify `packages/cli/src/historic-sql-doctor.ts`: read canonical
  query-history config, keep legacy fallback for pre-migration configs, and
  rename public doctor labels/messages to query history.
- Modify `packages/cli/src/historic-sql-doctor.test.ts`: update doctor unit
  expectations for canonical config and public wording.
- Modify `packages/cli/src/doctor.test.ts`: update project doctor integration
  expectations.
- Modify `packages/cli/src/ingest.ts`: replace stale no-report status guidance
  with `ktx ingest <connectionId>` wording.
- Modify `packages/cli/src/ingest-viz.test.ts`: cover the no-report status
  guidance.
- Modify `packages/cli/src/local-adapters.ts`: change public-facing
  query-history capability errors away from `Historic SQL`.
- Modify `packages/cli/src/local-adapters.test.ts`: cover at least one
  query-history capability error message.
- Modify `packages/cli/src/context-build-view.ts`: accept an entrypoint for
  retry text and sanitize public query-history progress messages.
- Modify `packages/cli/src/context-build-view.test.ts`: cover direct ingest
  retry guidance and sanitized query-history progress.
- Modify `packages/cli/src/public-ingest.ts`: pass `entrypoint: 'ingest'` to
  the foreground context-build view.
- Modify `packages/cli/src/public-ingest.test.ts`: cover public foreground
  delegation with the entrypoint.
- Modify `examples/postgres-historic/README.md`: rename public query-history
  wording and commands.
- Modify `examples/postgres-historic/scripts/smoke.sh`: use new setup flags.
- Modify `examples/README.md`: remove old Historic SQL public wording.
- Modify `examples/local-warehouse/ktx.yaml` and
  `examples/orbit-relationship-verification/ktx.yaml`: remove
  `live-database` from normal checked-in `ingest.adapters`.
- Modify `scripts/examples-docs.test.mjs`: assert the public examples no
  longer advertise old flags or adapter commands.

## Tasks

### Task 1: Fix full setup query-history argument plumbing

**Files:**
- Modify: `packages/cli/src/setup.ts`
- Test: `packages/cli/src/setup.test.ts`

- [ ] **Step 1: Write the failing setup forwarding test**

In `packages/cli/src/setup.test.ts`, add query-history fields to the existing
test named `runs database setup after embeddings succeed`:

```ts
          enableQueryHistory: true,
          queryHistoryWindowDays: 30,
          queryHistoryMinExecutions: 12,
          queryHistoryServiceAccountPatterns: ['^svc_'],
          queryHistoryRedactionPatterns: ['(?i)secret'],
```

The full args object in that test should include:

```ts
          databaseDrivers: ['postgres'],
          databaseConnectionId: 'warehouse',
          databaseUrl: 'env:DATABASE_URL',
          databaseSchemas: ['public'],
          enableQueryHistory: true,
          queryHistoryWindowDays: 30,
          queryHistoryMinExecutions: 12,
          queryHistoryServiceAccountPatterns: ['^svc_'],
          queryHistoryRedactionPatterns: ['(?i)secret'],
          skipDatabases: false,
```

Extend the `expect(databases).toHaveBeenCalledWith(...)` assertion in the same
test:

```ts
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryMinExecutions: 12,
        queryHistoryServiceAccountPatterns: ['^svc_'],
        queryHistoryRedactionPatterns: ['(?i)secret'],
```

- [ ] **Step 2: Run the failing setup test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup.test.ts -t "runs database setup after embeddings succeed"
```

Expected: FAIL because `runKtxSetup` still forwards the old
`enableHistoricSql` and `historicSql*` fields.

- [ ] **Step 3: Rename setup args and forwarding**

In `packages/cli/src/setup.ts`, replace the query-history section of
`KtxSetupArgs`:

```ts
      enableHistoricSql?: boolean;
      disableHistoricSql?: boolean;
      historicSqlWindowDays?: number;
      historicSqlMinExecutions?: number;
      historicSqlServiceAccountPatterns?: string[];
      historicSqlRedactionPatterns?: string[];
```

with:

```ts
      enableQueryHistory?: boolean;
      disableQueryHistory?: boolean;
      queryHistoryWindowDays?: number;
      queryHistoryMinExecutions?: number;
      queryHistoryServiceAccountPatterns?: string[];
      queryHistoryRedactionPatterns?: string[];
```

In the database-step call in `runKtxSetupInner`, replace:

```ts
            ...(args.enableHistoricSql !== undefined ? { enableHistoricSql: args.enableHistoricSql } : {}),
            ...(args.disableHistoricSql !== undefined ? { disableHistoricSql: args.disableHistoricSql } : {}),
            ...(args.historicSqlWindowDays !== undefined ? { historicSqlWindowDays: args.historicSqlWindowDays } : {}),
            ...(args.historicSqlMinExecutions !== undefined
              ? { historicSqlMinExecutions: args.historicSqlMinExecutions }
              : {}),
            ...(args.historicSqlServiceAccountPatterns
              ? { historicSqlServiceAccountPatterns: args.historicSqlServiceAccountPatterns }
              : {}),
            ...(args.historicSqlRedactionPatterns
              ? { historicSqlRedactionPatterns: args.historicSqlRedactionPatterns }
              : {}),
```

with:

```ts
            ...(args.enableQueryHistory !== undefined ? { enableQueryHistory: args.enableQueryHistory } : {}),
            ...(args.disableQueryHistory !== undefined ? { disableQueryHistory: args.disableQueryHistory } : {}),
            ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
            ...(args.queryHistoryMinExecutions !== undefined
              ? { queryHistoryMinExecutions: args.queryHistoryMinExecutions }
              : {}),
            ...(args.queryHistoryServiceAccountPatterns
              ? { queryHistoryServiceAccountPatterns: args.queryHistoryServiceAccountPatterns }
              : {}),
            ...(args.queryHistoryRedactionPatterns
              ? { queryHistoryRedactionPatterns: args.queryHistoryRedactionPatterns }
              : {}),
```

- [ ] **Step 4: Run the setup forwarding test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup.test.ts -t "runs database setup after embeddings succeed"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/src/setup.test.ts
git commit -m "fix(setup): forward query history flags"
```

### Task 2: Ask Postgres query-history setup interactively

**Files:**
- Modify: `packages/cli/src/setup-databases.ts`
- Test: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Write the failing Postgres prompt test**

In `packages/cli/src/setup-databases.test.ts`, add this test after
`writes Postgres query history config with minExecutions and ignores window/redaction output`:

```ts
  it('asks interactive Postgres setup whether to enable query history', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '    readonly: true',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['yes'] });
    const historicSqlProbe = vi.fn(async () => ({ ok: true, lines: [] }));

    const result = await runKtxSetupDatabasesStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        databaseConnectionIds: ['warehouse'],
        databaseSchemas: [],
        skipDatabases: false,
      },
      io.io,
      {
        prompts,
        testConnection: vi.fn(async () => 0),
        scanConnection: vi.fn(async () => 0),
        historicSqlProbe,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Enable query-history ingest for this PostgreSQL connection?',
      options: [
        { value: 'yes', label: 'Enable query history' },
        { value: 'no', label: 'Do not enable query history' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(historicSqlProbe).toHaveBeenCalledWith({
      projectDir: tempDir,
      connectionId: 'warehouse',
      dialect: 'postgres',
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse).toMatchObject({
      context: {
        queryHistory: {
          enabled: true,
          minExecutions: 5,
          filters: { dropTrivialProbes: true },
        },
      },
    });
  });
```

- [ ] **Step 2: Run the failing Postgres prompt test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts -t "asks interactive Postgres setup"
```

Expected: FAIL because Postgres currently returns without asking when no
explicit query-history flag is supplied.

- [ ] **Step 3: Prompt for all supported query-history drivers**

In `packages/cli/src/setup-databases.ts`, replace this branch in
`maybeApplyHistoricSqlConfig`:

```ts
  } else if (input.args.inputMode !== 'disabled' && input.args.enableQueryHistory !== true && dialect !== 'postgres') {
```

with:

```ts
  } else if (input.args.inputMode !== 'disabled' && input.args.enableQueryHistory !== true) {
```

Then delete this early return:

```ts
  if (dialect === 'postgres' && input.args.enableQueryHistory !== true && input.args.disableQueryHistory !== true) {
    return input.connection;
  }
```

- [ ] **Step 4: Run the Postgres prompt test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts -t "asks interactive Postgres setup|writes Postgres query history config"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "fix(setup): prompt for postgres query history"
```

### Task 3: Rename status/doctor query-history readiness output

**Files:**
- Modify: `packages/cli/src/historic-sql-doctor.ts`
- Modify: `packages/cli/src/historic-sql-doctor.test.ts`
- Modify: `packages/cli/src/doctor.test.ts`

- [ ] **Step 1: Write failing canonical doctor expectations**

In `packages/cli/src/historic-sql-doctor.test.ts`, update the first test name
and expected object:

```ts
  it('passes when no Postgres query-history connections are enabled', async () => {
```

```ts
    expect(checks).toEqual([
      {
        id: 'query-history-postgres',
        label: 'Postgres query history',
        status: 'pass',
        detail: 'No enabled Postgres query-history connections',
      },
    ]);
```

In the success test, replace the configured connection with canonical
query-history config:

```ts
        warehouse: {
          driver: 'postgres',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          context: { queryHistory: { enabled: true } },
        },
```

Update the probe assertion to match the same connection shape, and update the
expected check:

```ts
      {
        id: 'query-history-postgres-warehouse',
        label: 'Postgres query history (warehouse)',
        status: 'pass',
        detail: 'pg_stat_statements ready (PostgreSQL 16.4)',
      },
```

Update the warning and capability-error tests to expect
`query-history-postgres-warehouse` and
`Postgres query history (warehouse)`.

Add this legacy fallback test before the non-Postgres-driver failure test:

```ts
  it('still checks legacy historicSql blocks before setup migration', async () => {
    const probe = vi.fn<PostgresHistoricSqlDoctorProbe>(async () => ({
      pgServerVersion: 'PostgreSQL 16.4',
      warnings: [],
    }));

    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          historicSql: { enabled: true, dialect: 'postgres' },
        },
      }),
      { postgresHistoricSqlProbe: probe },
    );

    expect(checks).toEqual([
      {
        id: 'query-history-postgres-warehouse',
        label: 'Postgres query history (warehouse)',
        status: 'pass',
        detail: 'pg_stat_statements ready (PostgreSQL 16.4)',
      },
    ]);
  });
```

Update the non-Postgres-driver failure expected object:

```ts
      {
        id: 'query-history-postgres-warehouse',
        label: 'Postgres query history (warehouse)',
        status: 'fail',
        detail: 'connections.warehouse.context.queryHistory is enabled but driver is mysql',
        fix: 'Set connections.warehouse.driver to postgres or disable query history for this connection',
      },
```

In `packages/cli/src/doctor.test.ts`, rename the test to
`includes Postgres query-history readiness in project doctor output`, write
canonical config, and update the injected check:

```ts
        '    context:',
        '      queryHistory:',
        '        enabled: true',
```

```ts
        id: 'query-history-postgres-warehouse',
        label: 'Postgres query history (warehouse)',
```

Update the output assertion:

```ts
    expect(testIo.stdout()).toContain('PASS Postgres query history (warehouse): pg_stat_statements ready');
```

- [ ] **Step 2: Run the failing doctor tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/historic-sql-doctor.test.ts src/doctor.test.ts -t "query-history|historicSql blocks"
```

Expected: FAIL because the doctor still reads `historicSql` only and prints
`Postgres Historic SQL`.

- [ ] **Step 3: Read canonical query-history config in the doctor**

In `packages/cli/src/historic-sql-doctor.ts`, replace `historicSqlRecord` and
`isEnabledPostgresHistoricSql` with:

```ts
function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function queryHistoryRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> | null {
  const context = recordValue(connection.context);
  return recordValue(context?.queryHistory);
}

function legacyHistoricSqlRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> | null {
  return recordValue(connection.historicSql);
}

function isEnabledPostgresQueryHistory(connection: KtxProjectConnectionConfig): boolean {
  const queryHistory = queryHistoryRecord(connection);
  if (queryHistory) {
    return queryHistory.enabled === true;
  }
  const legacy = legacyHistoricSqlRecord(connection);
  return legacy?.enabled === true && legacy.dialect === 'postgres';
}
```

Rename `checkId`:

```ts
function checkId(connectionId: string): string {
  return `query-history-postgres-${connectionId.replace(/[^a-z0-9_-]+/gi, '-')}`;
}
```

Update `capabilityFailureFix`:

```ts
  if (error instanceof Error && error.name === 'HistoricSqlVersionUnsupportedError') {
    return 'Use PostgreSQL 14 or newer, or disable query history for this connection';
  }
  return `Fix connections.${connectionId} Postgres settings, then rerun \`ktx status --project-dir ${projectDir}\``;
```

Update `runPostgresHistoricSqlDoctorChecks` target selection and no-target
result:

```ts
  const targets = Object.entries(project.config.connections)
    .filter(([, connection]) => isEnabledPostgresQueryHistory(connection))
    .sort(([left], [right]) => left.localeCompare(right));

  if (targets.length === 0) {
    return [
      check('pass', 'query-history-postgres', 'Postgres query history', 'No enabled Postgres query-history connections'),
    ];
  }
```

Update the per-target label and non-Postgres failure:

```ts
    const label = `Postgres query history (${connectionId})`;
    if (!isPostgresDriver(connection)) {
      checks.push(
        check(
          'fail',
          checkId(connectionId),
          label,
          `connections.${connectionId}.context.queryHistory is enabled but driver is ${String(connection.driver)}`,
          `Set connections.${connectionId}.driver to postgres or disable query history for this connection`,
        ),
      );
      continue;
    }
```

- [ ] **Step 4: Run the doctor tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/historic-sql-doctor.test.ts src/doctor.test.ts -t "query-history|historicSql blocks"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/historic-sql-doctor.ts packages/cli/src/historic-sql-doctor.test.ts packages/cli/src/doctor.test.ts
git commit -m "fix(status): report query history readiness"
```

### Task 4: Remove stale adapter-command suggestions and public Historic SQL errors

**Files:**
- Modify: `packages/cli/src/ingest.ts`
- Modify: `packages/cli/src/ingest-viz.test.ts`
- Modify: `packages/cli/src/local-adapters.ts`
- Modify: `packages/cli/src/local-adapters.test.ts`

- [ ] **Step 1: Write failing no-report status guidance test**

In `packages/cli/src/ingest-viz.test.ts`, add this test after
`returns an error code for missing status`:

```ts
  it('suggests public ingest when status has no stored reports', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const io = makeIo();

    await expect(runKtxIngest({ command: 'status', projectDir, outputMode: 'plain' }, io.io)).resolves.toBe(1);

    expect(io.stderr()).toContain('No local ingest reports were found. Run `ktx ingest <connectionId>` first.');
    expect(io.stderr()).not.toContain('ktx ingest run --connection-id');
    expect(io.stderr()).not.toContain('--adapter');
  });
```

- [ ] **Step 2: Write failing query-history error wording test**

In `packages/cli/src/local-adapters.test.ts`, add this test before the closing
`describe` block:

```ts
  it('uses query-history wording for public BigQuery capability errors', async () => {
    await writeProject(
      tempDir,
      [
        'project: warehouse',
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    readonly: true',
        '    dataset_id: analytics',
        '    credentials_json: "{}"',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    expect(() =>
      createKtxCliLocalIngestAdapters(project, {
        historicSqlConnectionId: 'bq',
        sqlAnalysis: sqlAnalysisStub(),
      }),
    ).toThrow('Query history BigQuery connection requires credentials_json.project_id');
  });
```

- [ ] **Step 3: Run the failing output tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest-viz.test.ts src/local-adapters.test.ts -t "public ingest when status|query-history wording"
```

Expected: FAIL because current output still mentions `ktx ingest run` and
`Historic SQL`.

- [ ] **Step 4: Replace stale status guidance**

In `packages/cli/src/ingest.ts`, replace:

```ts
          : 'No local ingest reports were found. Run `ktx ingest run --connection-id <id> --adapter <adapter>` first.',
```

with:

```ts
          : 'No local ingest reports were found. Run `ktx ingest <connectionId>` first.',
```

- [ ] **Step 5: Rename public query-history capability errors**

In `packages/cli/src/local-adapters.ts`, replace user-facing error strings:

```ts
`Historic SQL local ingest requires a Postgres connection, got ${String(connection?.driver ?? 'unknown')}`
`Historic SQL local ingest requires a BigQuery connection, got ${String(connection?.driver ?? 'unknown')}`
`Historic SQL local ingest requires a Snowflake connection, got ${String(connection?.driver ?? 'unknown')}`
'Historic SQL BigQuery connection requires credentials_json.project_id'
```

with:

```ts
`Query history ingest requires a Postgres connection, got ${String(connection?.driver ?? 'unknown')}`
`Query history ingest requires a BigQuery connection, got ${String(connection?.driver ?? 'unknown')}`
`Query history ingest requires a Snowflake connection, got ${String(connection?.driver ?? 'unknown')}`
'Query history BigQuery connection requires credentials_json.project_id'
```

- [ ] **Step 6: Run the output tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest-viz.test.ts src/local-adapters.test.ts -t "public ingest when status|query-history wording"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/ingest.ts packages/cli/src/ingest-viz.test.ts packages/cli/src/local-adapters.ts packages/cli/src/local-adapters.test.ts
git commit -m "fix(ingest): remove legacy public guidance"
```

### Task 5: Fix foreground retry guidance and query-history progress copy

**Files:**
- Modify: `packages/cli/src/context-build-view.ts`
- Modify: `packages/cli/src/context-build-view.test.ts`
- Modify: `packages/cli/src/public-ingest.ts`
- Modify: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write failing foreground view tests**

In `packages/cli/src/context-build-view.test.ts`, add this test in the
`runContextBuild` describe block:

```ts
  it('uses direct ingest retry guidance for public ingest failures', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const executeTarget = vi.fn(async (target) => failedResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled', targetConnectionId: 'warehouse', all: false, entrypoint: 'ingest' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(io.stdout()).toContain('Retry: ktx ingest warehouse --project-dir /tmp/project');
    expect(io.stdout()).not.toContain('Retry: ktx setup');
  });
```

Add this progress-copy test in the same describe block:

```ts
  it('renders query-history progress without the historic-sql adapter key', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { queryHistory: { enabled: true } } },
    });
    const executeTarget = vi.fn(async (target, _args, _targetIo, deps) => {
      deps.ingestProgress?.({ percent: 5, message: 'Fetching source files for warehouse/historic-sql' });
      return successResult(target.connectionId, target.driver, target.operation);
    });

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled', targetConnectionId: 'warehouse', all: false, entrypoint: 'ingest' },
      io.io,
      { executeTarget, now: () => 1000, sourceProgressThrottleMs: 0 },
    );

    expect(io.stdout()).toContain('Fetching query history for warehouse');
    expect(io.stdout()).not.toContain('historic-sql');
  });
```

In `packages/cli/src/public-ingest.test.ts`, update the test named
`delegates interactive TTY public ingest to the foreground context-build view`
so the `runContextBuild` assertion includes:

```ts
        entrypoint: 'ingest',
```

- [ ] **Step 2: Run the failing foreground tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/public-ingest.test.ts -t "direct ingest retry|query-history progress|foreground context-build view"
```

Expected: FAIL because `ContextBuildArgs` has no entrypoint and progress text
is not sanitized.

- [ ] **Step 3: Add entrypoint-aware retry commands**

In `packages/cli/src/context-build-view.ts`, extend `ContextBuildArgs`:

```ts
  entrypoint?: 'setup' | 'ingest';
```

Replace `resumeCommand` with:

```ts
function retryCommand(input: {
  projectDir?: string;
  entrypoint?: 'setup' | 'ingest';
  connectionId?: string;
  depth?: 'fast' | 'deep';
}): string {
  const projectPart = input.projectDir ? ` --project-dir ${input.projectDir}` : '';
  if (input.entrypoint === 'ingest' && input.connectionId) {
    const depthPart = input.depth ? ` --${input.depth}` : '';
    return `ktx ingest ${input.connectionId}${projectPart}${depthPart}`;
  }
  return input.projectDir ? `ktx setup --project-dir ${input.projectDir}` : 'ktx setup';
}
```

Update `failureTextForTarget` to accept `entrypoint` and pass the target depth:

```ts
  entrypoint?: 'setup' | 'ingest';
```

Replace the network retry line:

```ts
      `Retry: ${resumeCommand(input.projectDir)}`,
```

with:

```ts
      `Retry: ${retryCommand({
        projectDir: input.projectDir,
        entrypoint: input.entrypoint,
        connectionId: input.target.connectionId,
        depth: input.target.databaseDepth,
      })}`,
```

For non-network failures, append retry text when `entrypoint === 'ingest'`:

```ts
  const fallback = input.fallback ?? `${input.target.connectionId} failed.`;
  if (input.entrypoint === 'ingest') {
    return `${fallback} Retry: ${retryCommand({
      projectDir: input.projectDir,
      entrypoint: input.entrypoint,
      connectionId: input.target.connectionId,
      depth: input.target.databaseDepth,
    })}`;
  }
  return fallback;
```

Pass `entrypoint: args.entrypoint` where `failureTextForTarget` is called.

- [ ] **Step 4: Sanitize public query-history progress text**

In `packages/cli/src/context-build-view.ts`, add:

```ts
function publicProgressMessage(message: string, target: KtxPublicIngestPlanTarget): string {
  if (target.steps.includes('query-history')) {
    return message
      .replace(`${target.connectionId}/historic-sql`, `${target.connectionId} query history`)
      .replace(/\bhistoric-sql\b/g, 'query history')
      .replace(/\bhistoric SQL\b/gi, 'query history');
  }
  return message;
}
```

Change `formatProgressDetail` to accept the target:

```ts
function formatProgressDetail(
  update: Pick<KtxIngestProgressUpdate, 'percent' | 'message'>,
  target: KtxPublicIngestPlanTarget,
): string {
  const percent = Math.max(0, Math.min(100, Math.round(update.percent)));
  return `[${percent}%] ${publicProgressMessage(update.message, target)}`;
}
```

Update the `updateTargetProgress` call site:

```ts
        targetState.detailLine = formatProgressDetail(update, targetState.target);
```

Update the capture progress callback:

```ts
          targetState.detailLine = publicProgressMessage(message, targetState.target);
```

- [ ] **Step 5: Pass foreground entrypoint from public ingest**

In `packages/cli/src/public-ingest.ts`, add this field to the
`contextBuild(...)` args object:

```ts
        entrypoint: 'ingest',
```

- [ ] **Step 6: Run the foreground tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/public-ingest.test.ts -t "direct ingest retry|query-history progress|foreground context-build view"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "fix(ingest): polish foreground retry copy"
```

### Task 6: Update public examples and checked-in example configs

**Files:**
- Modify: `examples/postgres-historic/README.md`
- Modify: `examples/postgres-historic/scripts/smoke.sh`
- Modify: `examples/README.md`
- Modify: `examples/local-warehouse/ktx.yaml`
- Modify: `examples/orbit-relationship-verification/ktx.yaml`
- Modify: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Write failing examples-docs assertions**

In `scripts/examples-docs.test.mjs`, replace the historic-SQL assertions with:

```js
    assert.doesNotMatch(examples, /Historic SQL/);
    assert.doesNotMatch(examples, /historic-SQL/);
    assert.match(examples, /query-history ingest via `pg_stat_statements`/);
    assert.doesNotMatch(readme, /--enable-historic-sql/);
    assert.doesNotMatch(readme, /--historic-sql-min-executions/);
    assert.doesNotMatch(readme, /ktx ingest run --project-dir/);
    assert.doesNotMatch(readme, /--adapter historic-sql/);
    assert.match(readme, /--enable-query-history/);
    assert.match(readme, /--query-history-min-executions 2/);
    assert.match(readme, /Postgres query history/);
```

Add assertions for checked-in example configs:

```js
  test('checked-in example configs do not include public live-database adapters', async () => {
    const localWarehouseConfig = await readFile('examples/local-warehouse/ktx.yaml', 'utf8');
    const orbitConfig = await readFile('examples/orbit-relationship-verification/ktx.yaml', 'utf8');

    assert.doesNotMatch(localWarehouseConfig, /live-database/);
    assert.doesNotMatch(orbitConfig, /live-database/);
  });
```

- [ ] **Step 2: Run the failing examples-docs test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: FAIL because examples still document old flags and configs still
contain `live-database`.

- [ ] **Step 3: Update Postgres query-history example docs**

In `examples/postgres-historic/README.md`, replace the title:

```md
# Postgres Historic SQL Example
```

with:

```md
# Postgres Query History Example
```

Replace the opening paragraph:

```md
This example is a manual smoke for the redesigned Postgres historic-SQL ingest
path through `pg_stat_statements`. It starts Postgres 14 with the extension
preloaded, generates query workload under separate users, runs `ktx setup` with
`--enable-historic-sql`, and verifies the unified staged artifacts:
```

with:

```md
This example is a manual smoke for Postgres query-history ingest through
`pg_stat_statements`. It starts Postgres 14 with the extension preloaded,
generates query workload under separate users, runs `ktx setup` with
`--enable-query-history`, and verifies the staged query-history artifacts:
```

Replace setup flags:

```bash
  --enable-historic-sql \
  --historic-sql-min-executions 2 \
```

with:

```bash
  --enable-query-history \
  --query-history-min-executions 2 \
```

Replace the manual ingest command:

```bash
pnpm run ktx -- ingest run --project-dir /tmp/ktx-postgres-historic \
  --connection-id warehouse \
  --adapter historic-sql \
  --plain \
  --yes \
  --no-input
```

with:

```bash
pnpm run ktx -- ingest warehouse --project-dir /tmp/ktx-postgres-historic \
  --query-history \
  --no-input
```

Apply these exact prose replacements in `examples/postgres-historic/README.md`:

```md
Postgres Historic SQL Example
```

becomes:

```md
Postgres Query History Example
```

```md
The smoke validates the historic-SQL raw snapshot path without requiring LLM
credentials. It uses KTX's local stage-only ingest API after `ktx setup`, so the
deterministic reader, batch SQL parser, stable artifact writer, and diff-based
WorkUnit planning are checked independently from curation.
```

becomes:

```md
The smoke validates the query-history raw snapshot path without requiring LLM
credentials. It uses KTX's local stage-only ingest API after `ktx setup`, so the
deterministic reader, batch SQL parser, stable artifact writer, and diff-based
WorkUnit planning are checked independently from curation.
```

```md
Create a project and enable historic SQL:
```

becomes:

```md
Create a project and enable query history:
```

```md
Expected output includes `PASS Postgres Historic SQL (warehouse)` when
`pg_stat_statements` is installed, `pg_read_all_stats` is granted, and tracking
is enabled.
```

becomes:

```md
Expected output includes `PASS Postgres query history (warehouse)` when
`pg_stat_statements` is installed, `pg_read_all_stats` is granted, and tracking
is enabled.
```

```md
Run local historic-SQL ingest:
```

becomes:

```md
Run query-history ingest:
```

```md
The full `ingest run` path also runs curation WorkUnits, so it requires a
configured LLM provider.
```

becomes:

```md
The public query-history ingest path also runs curation WorkUnits, so it
requires a configured LLM provider.
```

Keep literal `source: "historic-sql"`, raw
`raw-sources/.../historic-sql` paths, and WorkUnit key examples only in the
artifact inspection section where they describe internal artifacts.

Replace the troubleshooting bullet:

```md
- Empty snapshot: rerun `scripts/generate-workload.sh base` and keep
  `--historic-sql-min-executions 2` for the smoke.
```

with:

```md
- Empty snapshot: rerun `scripts/generate-workload.sh base` and keep
  `--query-history-min-executions 2` for the smoke.
```

- [ ] **Step 4: Update the smoke setup flags**

In `examples/postgres-historic/scripts/smoke.sh`, replace:

```bash
  --enable-historic-sql \
  --historic-sql-min-executions 2 \
```

with:

```bash
  --enable-query-history \
  --query-history-min-executions 2 \
```

- [ ] **Step 5: Update example index wording**

In `examples/README.md`, replace:

```md
`postgres-historic/` is a manual Docker-backed smoke for Postgres historic-SQL
ingest via `pg_stat_statements`. It verifies setup, unified Historic SQL artifacts,
managed daemon batch SQL analysis, bounded pattern WorkUnit shards, and
no-WorkUnit idempotency for unchanged bucketed table inputs and pattern shards.
```

with:

```md
`postgres-historic/` is a manual Docker-backed smoke for Postgres query-history
ingest via `pg_stat_statements`. It verifies setup, staged query-history
artifacts, managed daemon batch SQL analysis, bounded pattern WorkUnit shards,
and no-WorkUnit idempotency for unchanged bucketed table inputs and pattern
shards.
```

- [ ] **Step 6: Remove live-database from example configs**

In `examples/local-warehouse/ktx.yaml`, replace:

```yaml
ingest:
  adapters:
    - fake
    - live-database
```

with:

```yaml
ingest:
  adapters:
    - fake
```

In `examples/orbit-relationship-verification/ktx.yaml`, replace:

```yaml
ingest:
  adapters:
    - live-database
```

with:

```yaml
ingest:
  adapters: []
```

- [ ] **Step 7: Run examples-docs tests**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add examples/postgres-historic/README.md examples/postgres-historic/scripts/smoke.sh examples/README.md examples/local-warehouse/ktx.yaml examples/orbit-relationship-verification/ktx.yaml scripts/examples-docs.test.mjs
git commit -m "docs(examples): use unified query history wording"
```

### Task 7: Final verification

**Files:**
- Verify: `packages/cli/src/setup.ts`
- Verify: `packages/cli/src/setup-databases.ts`
- Verify: `packages/cli/src/historic-sql-doctor.ts`
- Verify: `packages/cli/src/ingest.ts`
- Verify: `packages/cli/src/local-adapters.ts`
- Verify: `packages/cli/src/context-build-view.ts`
- Verify: `packages/cli/src/public-ingest.ts`
- Verify: `examples/`
- Verify: `scripts/examples-docs.test.mjs`

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run \
  src/setup.test.ts \
  src/setup-databases.test.ts \
  src/historic-sql-doctor.test.ts \
  src/doctor.test.ts \
  src/ingest-viz.test.ts \
  src/local-adapters.test.ts \
  src/context-build-view.test.ts \
  src/public-ingest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI type-check**

Run:

```bash
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run examples docs test**

Run:

```bash
node --test scripts/examples-docs.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run dead-code check for TypeScript changes**

Run:

```bash
pnpm run dead-code
```

Expected: PASS, or only known unrelated Knip findings. Investigate and fix
new findings introduced by this plan.

- [ ] **Step 5: Check remaining public old-surface references**

Run:

```bash
rg -n "ktx ingest run --connection-id|--enable-historic-sql|--historic-sql|Postgres Historic SQL|Historic SQL local ingest|live-database" README.md examples packages/cli/src scripts/examples-docs.test.mjs
```

Expected: no matches in public docs, setup/status/ingest public output, or
example configs. Matches in hidden-command tests, internal adapter tests,
debug-only scripts, and low-level scan tests are acceptable only when the file
is explicitly exercising internal behavior.

- [ ] **Step 6: Commit verification-only fixes if needed**

If Step 4 or Step 5 required edits, commit them:

```bash
git add <changed-files>
git commit -m "chore(ingest): finish public query history cleanup"
```

Expected: no commit is needed when all checks pass without further edits.

## Self-review

- Spec coverage: this plan covers the remaining public setup query-history
  path, canonical status readiness, stale command guidance, public foreground
  retry/progress copy, public examples, and generated/example config cleanup.
- Placeholder scan: no task uses placeholder implementation language.
- Type consistency: all new public fields use `queryHistory*`; internal file
  names and adapter keys can remain `historic-sql` where they are not normal
  public UX.
