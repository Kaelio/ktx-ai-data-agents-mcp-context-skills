# Unified Ingest V1 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1-blocking gaps in the unified `ktx ingest`
redesign after the public CLI surface slice.

**Architecture:** Keep the implemented connection-centric `ktx ingest` command
as the public entry point, and add the missing policy layer around it: depth
readiness, setup depth defaults, foreground-only context builds, legacy
query-history config migration, and reserved connection-id validation. Put
shared depth policy in a small CLI helper so public ingest and setup use the
same rules.

**Tech Stack:** TypeScript ESM, Commander, Vitest, KTX CLI/context packages,
YAML config serialization.

---

## Current audit

The implemented `2026-05-13-unified-ingest-public-cli-surface.md` slice covers
the first public-surface layer:

- `ktx ingest [connectionId]`, `ktx ingest --all`, `--fast`, `--deep`,
  `--query-history`, `--no-query-history`, and
  `--query-history-window-days` are routed in
  `packages/cli/src/commands/ingest-commands.ts`.
- `ktx scan`, `ktx ingest run`, and `ktx ingest watch` are hidden from normal
  help while still callable as debug or stored-report surfaces.
- `packages/cli/src/public-ingest.ts` plans database targets before source
  targets, maps fast/deep to scan internals, runs query history after schema
  ingest, and bypasses adapter allow lists for inferred public adapters.
- `packages/context/src/project/config.ts` no longer generates normal
  `ingest.adapters` entries.
- README and smoke scripts now document public `ktx ingest` examples.

Remaining v1-blocking gaps against the original spec:

- Explicit or stored `deep` currently does not fail before work starts when
  model, scan-enrichment, or scan-embedding config is missing.
- Deep database ingest always passes `detectRelationships: true` instead of
  honoring `scan.relationships.enabled`.
- `ktx setup` does not ask for or store
  `connections.<id>.context.depth`, and still forces enriched context builds.
- Setup readiness still requires enriched AI artifacts for every database
  context and blocks all context builds when AI inputs are missing, even when
  the effective depth is `fast`.
- Setup still writes legacy `connections.<id>.historicSql` instead of
  canonical `connections.<id>.context.queryHistory`.
- Legacy `historicSql` migration is not performed by setup.
- Context build still supports detach, watch, resume, stop, paused/detached
  state, and background subprocesses.
- Setup/config validation does not reject connection ids that collide with
  surviving ingest subcommands: `status`, `replay`, `run`, and `watch`.

Non-blocking gaps after this plan:

- Internal package names, adapter names, raw-source artifact paths, and debug
  output can still use `scan`, `live-database`, and `historic-sql`.
- The hidden debug `ktx scan` and hidden adapter-backed `ktx ingest run`
  commands can remain until an explicit internal cleanup plan removes them.
- MCP scan tool names and low-level scan tests can continue to use scan
  terminology because the original spec only requires normal CLI/help/output
  cleanup for v1.

## File structure

- Create `packages/cli/src/ingest-depth.ts`: shared database driver detection,
  depth defaults, deep-readiness checks, and context-depth config helpers.
- Modify `packages/cli/src/public-ingest.ts`: use shared depth policy, add
  preflight failures, and pass relationship detection only when enabled.
- Modify `packages/cli/src/public-ingest.test.ts`: cover deep preflight,
  per-target `--all` isolation, and relationship flag mapping.
- Modify `packages/cli/src/setup-databases.ts`: write
  `context.queryHistory`, migrate legacy `historicSql`, and read the canonical
  shape for query-history probe behavior.
- Modify `packages/cli/src/setup-databases.test.ts`: replace legacy
  `historicSql` expectations with canonical `context.queryHistory`
  expectations and migration coverage.
- Modify `packages/cli/src/setup-context.ts`: prompt/store context depth,
  remove foreground detach/background logic, normalize legacy state, and make
  readiness depth-aware.
- Modify `packages/cli/src/setup-context.test.ts`: cover fast readiness, deep
  readiness, stored depth, foreground-only state, and removed watch/detach
  affordances.
- Modify `packages/cli/src/context-build-view.ts`: remove detach hint and
  background subprocess support.
- Modify `packages/cli/src/context-build-view.test.ts`: assert foreground-only
  progress copy.
- Modify `packages/context/src/project/config.ts`: reject reserved connection
  ids during config parse.
- Modify `packages/context/src/project/index.ts`: export reserved-id helpers
  for setup flows.
- Modify `packages/context/src/project/config.test.ts`: cover reserved
  connection ids.
- Modify `packages/cli/src/setup-sources.ts`,
  `packages/cli/src/setup-sources.test.ts`,
  `packages/cli/src/commands/setup-commands.ts`, and
  `packages/cli/src/index.test.ts`: reject reserved ids during setup prompts
  and setup flags.

## Tasks

### Task 1: Add depth policy and public deep preflight

**Files:**
- Create: `packages/cli/src/ingest-depth.ts`
- Modify: `packages/cli/src/public-ingest.ts`
- Test: `packages/cli/src/public-ingest.test.ts`

- [ ] **Step 1: Write failing public ingest preflight tests**

In `packages/cli/src/public-ingest.test.ts`, add this helper after
`projectWithConnections`:

```ts
function deepReadyProject(connections: KtxProjectConfig['connections'], relationshipsEnabled = true): KtxPublicIngestProject {
  const config = buildDefaultKtxProjectConfig('warehouse');
  return {
    projectDir: '/tmp/project',
    config: {
      ...config,
      connections,
      llm: {
        ...config.llm,
        provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } },
        models: { default: 'gpt-test' },
      },
      scan: {
        ...config.scan,
        enrichment: {
          mode: 'llm',
          embeddings: {
            backend: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
          },
        },
        relationships: {
          ...config.scan.relationships,
          enabled: relationshipsEnabled,
        },
      },
    },
  };
}
```

Add these tests inside the `buildPublicIngestPlan` describe block:

```ts
  it('records a preflight failure for deep database ingest when readiness config is missing', () => {
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
    });

    const plan = buildPublicIngestPlan(project, {
      projectDir: '/tmp/project',
      targetConnectionId: 'warehouse',
      all: false,
      queryHistory: 'default',
    });

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      preflightFailure:
        'warehouse requires deep ingest readiness: model configuration, scan enrichment mode, scan embeddings. Run ktx setup or rerun with --fast.',
    });
  });

  it('honors scan.relationships.enabled when planning deep database ingest', () => {
    const plan = buildPublicIngestPlan(
      deepReadyProject({ warehouse: { driver: 'postgres', context: { depth: 'deep' } } }, false),
      {
        projectDir: '/tmp/project',
        targetConnectionId: 'warehouse',
        all: false,
        queryHistory: 'default',
      },
    );

    expect(plan.targets[0]).toMatchObject({
      connectionId: 'warehouse',
      databaseDepth: 'deep',
      detectRelationships: false,
    });
  });
```

Add this test inside the `runKtxPublicIngest` describe block:

```ts
  it('fails deep-readiness targets before work starts while continuing independent --all targets', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres', context: { depth: 'deep' } },
      docs: { driver: 'notion' },
    });
    const runScan = vi.fn(async () => 0);
    const runIngest = vi.fn(async () => 0);

    await expect(
      runKtxPublicIngest(
        { command: 'run', projectDir: '/tmp/project', all: true, json: false, inputMode: 'disabled' },
        io.io,
        { loadProject: vi.fn(async () => project), runScan, runIngest },
      ),
    ).resolves.toBe(1);

    expect(runScan).not.toHaveBeenCalled();
    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'run', connectionId: 'docs', adapter: 'notion' }),
      expect.anything(),
    );
    expect(io.stdout()).toContain('warehouse requires deep ingest readiness');
  });
```

- [ ] **Step 2: Run the failing public ingest tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts -t "preflight failure|relationships.enabled|deep-readiness"
```

Expected: FAIL because `preflightFailure`, shared depth policy, and
relationship-aware deep planning do not exist.

- [ ] **Step 3: Create shared depth policy**

Create `packages/cli/src/ingest-depth.ts`:

```ts
import type { KtxProjectConfig, KtxProjectConnectionConfig } from '@ktx/context/project';

export type KtxDatabaseContextDepth = 'fast' | 'deep';

export const KTX_DATABASE_DRIVER_IDS = new Set([
  'sqlite',
  'postgres',
  'postgresql',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
]);

export function normalizeConnectionDriver(connection: KtxProjectConnectionConfig): string {
  return String(connection.driver ?? '').trim().toLowerCase();
}

export function isDatabaseDriver(driver: string): boolean {
  return KTX_DATABASE_DRIVER_IDS.has(driver.trim().toLowerCase());
}

export function connectionContextRecord(connection: KtxProjectConnectionConfig): Record<string, unknown> {
  const context = connection.context;
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : {};
}

export function databaseContextDepth(connection: KtxProjectConnectionConfig): KtxDatabaseContextDepth | undefined {
  const depth = connectionContextRecord(connection).depth;
  return depth === 'fast' || depth === 'deep' ? depth : undefined;
}

export function withDatabaseContextDepth(
  connection: KtxProjectConnectionConfig,
  depth: KtxDatabaseContextDepth,
): KtxProjectConnectionConfig {
  return {
    ...connection,
    context: {
      ...connectionContextRecord(connection),
      depth,
    },
  };
}

export function deepReadinessGaps(config: KtxProjectConfig): string[] {
  const gaps: string[] = [];
  if (config.llm.provider.backend === 'none' || !config.llm.models.default) {
    gaps.push('model configuration');
  }

  if (config.scan.enrichment.mode !== 'llm') {
    gaps.push('scan enrichment mode');
  }

  const embeddings = config.scan.enrichment.embeddings;
  if (
    !embeddings ||
    embeddings.backend === 'none' ||
    embeddings.backend === 'deterministic' ||
    !embeddings.model ||
    embeddings.dimensions <= 0
  ) {
    gaps.push('scan embeddings');
  }

  return gaps;
}

export function recommendedDatabaseContextDepth(config: KtxProjectConfig): KtxDatabaseContextDepth {
  return deepReadinessGaps(config).length === 0 ? 'deep' : 'fast';
}
```

- [ ] **Step 4: Apply preflight and relationship policy in public ingest**

In `packages/cli/src/public-ingest.ts`, replace the local depth and warehouse
driver definitions with imports:

```ts
import {
  type KtxDatabaseContextDepth,
  databaseContextDepth,
  deepReadinessGaps,
  isDatabaseDriver,
  normalizeConnectionDriver,
} from './ingest-depth.js';
```

Change `type KtxPublicIngestDepth = 'fast' | 'deep';` to:

```ts
type KtxPublicIngestDepth = KtxDatabaseContextDepth;
```

Remove the local `warehouseDrivers`, `normalizedDriver`,
`connectionContext`, and `storedDepth` helpers.

Add these fields to `KtxPublicIngestPlanTarget`:

```ts
  detectRelationships?: boolean;
  preflightFailure?: string;
```

In `resolveDatabaseTargetOptions`, replace:

```ts
  let depth = input.args.depth ?? depthFromLegacyScanMode(input.args.scanMode) ?? storedDepth(input.connection) ?? 'fast';
```

with:

```ts
  let depth =
    input.args.depth ?? depthFromLegacyScanMode(input.args.scanMode) ?? databaseContextDepth(input.connection) ?? 'fast';
```

Change `targetForConnection` to accept the project config:

```ts
function targetForConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
  projectConfig: KtxPublicIngestProject['config'],
  args: {
    depth?: KtxPublicIngestDepth;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  },
  warnings: string[],
): KtxPublicIngestPlanTarget {
```

Use shared driver detection:

```ts
  const driver = normalizeConnectionDriver(connection);
```

Replace the warehouse branch with:

```ts
  if (isDatabaseDriver(driver)) {
    const options = resolveDatabaseTargetOptions({ connectionId, driver, connection, args, warnings });
    const gaps = options.databaseDepth === 'deep' ? deepReadinessGaps(projectConfig) : [];
    return {
      connectionId,
      driver,
      operation: 'database-ingest',
      debugCommand: `ktx ingest ${connectionId} --debug`,
      detectRelationships: options.databaseDepth === 'deep' && projectConfig.scan.relationships.enabled,
      ...(gaps.length > 0
        ? {
            preflightFailure: `${connectionId} requires deep ingest readiness: ${gaps.join(
              ', ',
            )}. Run ktx setup or rerun with --fast.`,
          }
        : {}),
      ...options,
    };
  }
```

In `buildPublicIngestPlan`, pass `project.config`:

```ts
  const targets = selected.map(([connectionId, connection]) =>
    targetForConnection(connectionId, connection, project.config, args, warnings),
  );
```

At the start of `executePublicIngestTarget`, add:

```ts
  if (target.preflightFailure) {
    return {
      connectionId: target.connectionId,
      driver: target.driver,
      steps: defaultSteps(target).map((step) =>
        step.operation === 'database-schema'
          ? {
              ...step,
              status: 'failed',
              detail: target.preflightFailure,
            }
          : step,
      ),
    };
  }
```

Change database scan args from:

```ts
      detectRelationships: target.databaseDepth === 'deep' ? true : false,
```

to:

```ts
      detectRelationships: target.detectRelationships === true,
```

- [ ] **Step 5: Run public ingest tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit depth preflight**

Run:

```bash
git add packages/cli/src/ingest-depth.ts packages/cli/src/public-ingest.ts packages/cli/src/public-ingest.test.ts
git commit -m "feat(cli): preflight deep public ingest readiness"
```

### Task 2: Store query history under `context.queryHistory`

**Files:**
- Modify: `packages/cli/src/setup-databases.ts`
- Test: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Write failing setup query-history shape tests**

In `packages/cli/src/setup-databases.test.ts`, update the existing tests that
expect `config.connections.<id>.historicSql` so they expect
`config.connections.<id>.context.queryHistory` instead.

Add this test near the existing Historic SQL setup tests:

```ts
  it('migrates legacy historicSql to context.queryHistory during database setup', async () => {
    await writeProjectConfig(tempDir, {
      connections: {
        warehouse: {
          driver: 'postgres',
          readonly: true,
          historicSql: {
            enabled: true,
            dialect: 'postgres',
            windowDays: 45,
            minExecutions: 9,
            concurrency: 3,
            staleArchiveAfterDays: 120,
            filters: {
              dropTrivialProbes: true,
              serviceAccounts: { mode: 'exclude', patterns: ['^svc_'] },
              orchestrators: { mode: 'exclude', patterns: ['airflow'] },
              dropFailedBelow: 2,
            },
            redactionPatterns: ['(?i)secret'],
          },
        },
      },
    });

    const io = makeIo();

    await expect(
      runKtxSetupDatabasesStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          databaseConnectionIds: ['warehouse'],
          skipConnectionTest: true,
          skipInitialScan: true,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse.historicSql).toBeUndefined();
    expect(config.connections.warehouse.context).toMatchObject({
      queryHistory: {
        enabled: true,
        windowDays: 45,
        minExecutions: 9,
        concurrency: 3,
        staleArchiveAfterDays: 120,
        filters: {
          dropTrivialProbes: true,
          serviceAccounts: { mode: 'exclude', patterns: ['^svc_'] },
          orchestrators: { mode: 'exclude', patterns: ['airflow'] },
          dropFailedBelow: 2,
        },
        redactionPatterns: ['(?i)secret'],
      },
    });
  });
```

- [ ] **Step 2: Run failing setup database tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts -t "queryHistory|historicSql|migrates legacy"
```

Expected: FAIL because setup still writes and reads `historicSql`.

- [ ] **Step 3: Add query-history config helpers**

In `packages/cli/src/setup-databases.ts`, add these helpers after
`historicSqlConfigRecord`:

```ts
function contextRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> {
  const context = connection?.context;
  return context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
}

function queryHistoryConfigRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> | null {
  const queryHistory = contextRecord(connection).queryHistory;
  return queryHistory && typeof queryHistory === 'object' && !Array.isArray(queryHistory)
    ? (queryHistory as Record<string, unknown>)
    : null;
}

function stripLegacyHistoricSql(connection: KtxProjectConnectionConfig): KtxProjectConnectionConfig {
  const { historicSql: _historicSql, ...rest } = connection as KtxProjectConnectionConfig & {
    historicSql?: unknown;
  };
  return rest;
}

function withQueryHistoryConfig(
  connection: KtxProjectConnectionConfig,
  queryHistory: Record<string, unknown>,
): KtxProjectConnectionConfig {
  return {
    ...stripLegacyHistoricSql(connection),
    context: {
      ...contextRecord(connection),
      queryHistory,
    },
  };
}

function migrateLegacyHistoricSqlConnection(connection: KtxProjectConnectionConfig): KtxProjectConnectionConfig {
  const existingQueryHistory = queryHistoryConfigRecord(connection);
  const legacy = historicSqlConfigRecord(connection);
  if (existingQueryHistory || !legacy) {
    return existingQueryHistory ? stripLegacyHistoricSql(connection) : connection;
  }
  const { dialect: _dialect, ...queryHistory } = legacy;
  return withQueryHistoryConfig(connection, queryHistory);
}
```

- [ ] **Step 4: Write canonical query-history config from setup**

In `applyHistoricSqlConfigToConnection`, replace each returned `historicSql`
object with a call to `withQueryHistoryConfig(input.connection, queryHistory)`.

For disabled query history, return:

```ts
    return withQueryHistoryConfig(input.connection, { ...existing, enabled: false });
```

For Postgres enabled query history, return:

```ts
    return withQueryHistoryConfig(input.connection, {
      ...common,
      minExecutions: input.args.historicSqlMinExecutions ?? 5,
    });
```

For BigQuery and Snowflake enabled query history, return:

```ts
  return withQueryHistoryConfig(input.connection, {
    ...common,
    windowDays: input.args.historicSqlWindowDays ?? 90,
    redactionPatterns: input.args.historicSqlRedactionPatterns ?? [],
  });
```

Change `common` so it does not include `dialect`:

```ts
  const common: Record<string, unknown> = {
    ...existing,
    enabled: true,
    filters: historicSqlFiltersForSetup(input.args.historicSqlServiceAccountPatterns),
  };
```

Where `existing` is built, prefer canonical config:

```ts
  const existing = queryHistoryConfigRecord(input.connection) ?? historicSqlConfigRecord(input.connection) ?? {};
```

- [ ] **Step 5: Migrate legacy blocks during setup writes**

In `writeConnectionConfig`, normalize all project connections before writing:

```ts
  const migratedConnections = Object.fromEntries(
    Object.entries(project.config.connections).map(([connectionId, connection]) => [
      connectionId,
      migrateLegacyHistoricSqlConnection(connection),
    ]),
  );
  const nextConnection = migrateLegacyHistoricSqlConnection(input.connection);
  const config = {
    ...project.config,
    connections: {
      ...migratedConnections,
      [input.connectionId]: nextConnection,
    },
  };
```

Change the post-write Historic SQL defaults check to read canonical config:

```ts
  const queryHistory = queryHistoryConfigRecord(nextConnection);
  if (queryHistory?.enabled === true) {
    await ensureHistoricSqlIngestDefaults(input.projectDir);
  }
```

Update `historicSqlConfigRecord` callers used for probe decisions to prefer
`queryHistoryConfigRecord(connection)` and only fall back to legacy
`historicSqlConfigRecord(connection)`.

- [ ] **Step 6: Run setup database tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-databases.test.ts
```

Expected: PASS after updating assertions from `historicSql` to
`context.queryHistory`.

- [ ] **Step 7: Commit setup query-history config**

Run:

```bash
git add packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts
git commit -m "feat(setup): store query history in connection context"
```

### Task 3: Store setup database context depth

**Files:**
- Modify: `packages/cli/src/setup-context.ts`
- Test: `packages/cli/src/setup-context.test.ts`

- [ ] **Step 1: Write failing setup depth tests**

In `packages/cli/src/setup-context.test.ts`, replace the test named
`does not treat schema-only scan shards as completed setup context` with:

```ts
  it('treats fast database context as ready from schema manifest shards without AI artifacts', async () => {
    await writeReadyProject(tempDir, {
      connections: {
        warehouse: { driver: 'postgres', readonly: true, context: { depth: 'fast' } },
      },
      llm: { provider: { backend: 'none' }, models: {} },
      scan: { enrichment: { mode: 'none' } },
    });
    await mkdir(join(tempDir, 'semantic-layer', 'warehouse', '_schema'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'warehouse', '_schema', 'public.yaml'), 'tables: {}\n');
    await writeScanReport(tempDir, '2026-05-09T10:00:00.000Z', {
      mode: 'structural',
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
      manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Existing context artifacts were found from setup ingest.');
  });
```

Add these tests near the existing setup context build tests:

```ts
  it('stores fast context depth non-interactively when deep readiness is missing', async () => {
    await writeReadyProject(tempDir, {
      connections: { warehouse: { driver: 'postgres', readonly: true } },
      llm: { provider: { backend: 'none' }, models: {} },
      scan: { enrichment: { mode: 'none' } },
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['ready'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock, verifyContextReady },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse.context).toMatchObject({ depth: 'fast' });
    expect(runContextBuildMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectDir: tempDir, inputMode: 'disabled' }),
      expect.anything(),
      expect.anything(),
    );
    expect(runContextBuildMock.mock.calls[0]?.[1]).not.toMatchObject({
      scanMode: 'enriched',
      detectRelationships: true,
    });
  });

  it('prompts for database context depth after final readiness is known', async () => {
    await writeReadyProject(tempDir, {
      connections: { warehouse: { driver: 'postgres', readonly: true } },
      llm: {
        provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } },
        models: { default: 'gpt-test' },
      },
      scan: {
        enrichment: {
          mode: 'llm',
          embeddings: { backend: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        },
      },
    });
    const io = makeIo();
    const select = vi.fn(async () => 'deep');
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['ready'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'auto' },
        io.io,
        {
          prompts: { select, cancel: vi.fn() },
          runContextBuild: runContextBuildMock,
          verifyContextReady,
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('How much database context should KTX build?'),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.warehouse.context).toMatchObject({ depth: 'deep' });
  });
```

- [ ] **Step 2: Run failing setup depth tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-context.test.ts -t "fast database context|stores fast context depth|prompts for database context depth"
```

Expected: FAIL because setup has no depth prompt/storage and still gates all
context builds on AI readiness.

- [ ] **Step 3: Add setup depth helpers**

In `packages/cli/src/setup-context.ts`, add imports:

```ts
import {
  type KtxDatabaseContextDepth,
  databaseContextDepth,
  deepReadinessGaps,
  isDatabaseDriver,
  normalizeConnectionDriver,
  recommendedDatabaseContextDepth,
  withDatabaseContextDepth,
} from './ingest-depth.js';
```

Add these helpers after `listContextTargets`:

```ts
function databaseConnectionsNeedingDepth(project: KtxLocalProject): string[] {
  return Object.entries(project.config.connections)
    .filter(([, connection]) => isDatabaseDriver(normalizeConnectionDriver(connection)))
    .filter(([, connection]) => databaseContextDepth(connection) === undefined)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

async function writeDatabaseContextDepths(
  project: KtxLocalProject,
  connectionIds: string[],
  depth: KtxDatabaseContextDepth,
): Promise<KtxLocalProject> {
  if (connectionIds.length === 0) {
    return project;
  }
  const nextConnections = { ...project.config.connections };
  for (const connectionId of connectionIds) {
    const connection = nextConnections[connectionId];
    if (connection) {
      nextConnections[connectionId] = withDatabaseContextDepth(connection, depth);
    }
  }
  const nextConfig = { ...project.config, connections: nextConnections };
  await writeFile(project.configPath, serializeKtxProjectConfig(nextConfig), 'utf-8');
  return await loadKtxProject({ projectDir: project.projectDir });
}

async function ensureSetupDatabaseContextDepths(input: {
  project: KtxLocalProject;
  args: KtxSetupContextStepArgs;
  prompts: KtxSetupContextPromptAdapter;
}): Promise<KtxLocalProject | 'back'> {
  const missingDepthConnectionIds = databaseConnectionsNeedingDepth(input.project);
  if (missingDepthConnectionIds.length === 0) {
    return input.project;
  }

  const recommended = recommendedDatabaseContextDepth(input.project.config);
  if (input.args.inputMode === 'disabled') {
    return await writeDatabaseContextDepths(input.project, missingDepthConnectionIds, recommended);
  }

  const deepReady = deepReadinessGaps(input.project.config).length === 0;
  const options =
    recommended === 'deep'
      ? [
          { value: 'deep', label: 'Deep: AI descriptions, embeddings, relationships, slower' },
          { value: 'fast', label: 'Fast: schema only, no AI, quickest' },
          { value: 'back', label: 'Back' },
        ]
      : [
          { value: 'fast', label: 'Fast: schema only, no AI, quickest' },
          { value: 'deep', label: 'Deep: AI descriptions, embeddings, relationships, slower' },
          { value: 'back', label: 'Back' },
        ];

  const choice = await input.prompts.select({
    message:
      'How much database context should KTX build?\n\n' +
      (deepReady
        ? 'Deep is available because model, embedding, and scan enrichment are configured.'
        : 'Fast is recommended because model, embedding, or scan enrichment is not configured.'),
    options,
  });
  if (choice === 'back') {
    return 'back';
  }
  return await writeDatabaseContextDepths(input.project, missingDepthConnectionIds, choice as KtxDatabaseContextDepth);
}
```

- [ ] **Step 4: Use stored depth in setup context builds**

In `runKtxSetupContextStep`, after loading `project` and before reading the
existing setup context state, change `const project` to `let project`, then
add:

```ts
    const depthProject = await ensureSetupDatabaseContextDepths({
      project,
      args,
      prompts: deps.prompts ?? createPromptAdapter(),
    });
    if (depthProject === 'back') {
      return { status: 'back', projectDir: args.projectDir };
    }
    project = depthProject;
```

Remove the unconditional missing-capability gate:

```ts
    const missing = missingCapabilities(project);
    if (missing.length > 0) {
      if (args.allowEmpty === true) {
        return { status: 'skipped', projectDir: args.projectDir };
      }
      writeMissingCapabilities(missing, io);
      return { status: 'missing-input', projectDir: args.projectDir };
    }
```

Replace it with a deep-only target preflight gate:

```ts
    const preflightPlan = buildPublicIngestPlan(project, { projectDir: project.projectDir, all: true });
    const preflightFailures = preflightPlan.targets.flatMap((target) =>
      target.preflightFailure ? [`${target.connectionId}: ${target.preflightFailure}`] : [],
    );
    if (preflightFailures.length > 0) {
      if (args.allowEmpty === true) {
        return { status: 'skipped', projectDir: args.projectDir };
      }
      writeMissingCapabilities(preflightFailures, io);
      return { status: 'missing-input', projectDir: args.projectDir };
    }
```

In `runBuild`, change the `runContextBuild` call from:

```ts
    {
      projectDir: args.projectDir,
      inputMode: args.inputMode,
      scanMode: 'enriched',
      detectRelationships: true,
    },
```

to:

```ts
    {
      projectDir: args.projectDir,
      inputMode: args.inputMode,
    },
```

- [ ] **Step 5: Run setup context depth tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-context.test.ts -t "fast database context|stores fast context depth|prompts for database context depth"
```

Expected: PASS after updating helper fixtures to accept the override shape in
the new tests.

- [ ] **Step 6: Commit setup context depth**

Run:

```bash
git add packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts
git commit -m "feat(setup): store database context depth"
```

### Task 4: Make setup readiness depth-aware

**Files:**
- Modify: `packages/cli/src/setup-context.ts`
- Test: `packages/cli/src/setup-context.test.ts`

- [ ] **Step 1: Write failing depth-aware readiness tests**

In `packages/cli/src/setup-context.test.ts`, add:

```ts
  it('requires completed relationships for deep context when relationship discovery is enabled', async () => {
    await writeReadyProject(tempDir, {
      connections: {
        warehouse: { driver: 'postgres', readonly: true, context: { depth: 'deep' } },
      },
      scan: { relationships: { enabled: true } },
    });
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:00:00.000Z', {
      completedStages: ['descriptions', 'embeddings'],
      relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => {
      await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:01:00.000Z', {
        completedStages: ['descriptions', 'embeddings', 'relationships'],
        relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
      });
      return { exitCode: 0 };
    });

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).toHaveBeenCalledOnce();
  });

  it('does not require relationships for deep context when relationship discovery is disabled', async () => {
    await writeReadyProject(tempDir, {
      connections: {
        warehouse: { driver: 'postgres', readonly: true, context: { depth: 'deep' } },
      },
      scan: { relationships: { enabled: false } },
    });
    await mkdir(join(tempDir, 'semantic-layer', 'dbt-main'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'dbt-main', 'mart_revenue_daily.yaml'), 'name: mart_revenue_daily\n');
    await writeReadyEnrichedScanReport(tempDir, '2026-05-09T10:00:00.000Z', {
      completedStages: ['descriptions', 'embeddings'],
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run failing depth-aware readiness tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-context.test.ts -t "requires completed relationships|does not require relationships"
```

Expected: FAIL because readiness only checks enriched descriptions and
embeddings.

- [ ] **Step 3: Replace scan readiness helpers**

In `packages/cli/src/setup-context.ts`, replace
`scanReportHasCompletedDescriptionEnrichment` with:

```ts
function scanReportHasSchemaManifest(report: unknown, connectionId: string): boolean {
  if (!isRecord(report)) {
    return false;
  }
  if (report.connectionId !== connectionId || report.dryRun === true) {
    return false;
  }
  return stringArrayValue(isRecord(report.artifactPaths) ? report.artifactPaths.manifestShards : undefined).length > 0;
}

function scanReportHasCompletedDeepEnrichment(
  report: unknown,
  connectionId: string,
  relationshipsRequired: boolean,
): boolean {
  if (!isRecord(report)) {
    return false;
  }
  if (report.connectionId !== connectionId || report.mode !== 'enriched' || report.dryRun === true) {
    return false;
  }
  if (!isRecord(report.enrichment) || !isRecord(report.enrichmentState) || !isRecord(report.artifactPaths)) {
    return false;
  }
  const completedStages = stringArrayValue(report.enrichmentState.completedStages);
  return (
    report.enrichment.tableDescriptions === 'completed' &&
    report.enrichment.columnDescriptions === 'completed' &&
    report.enrichment.embeddings === 'completed' &&
    completedStages.includes('descriptions') &&
    completedStages.includes('embeddings') &&
    (!relationshipsRequired || completedStages.includes('relationships')) &&
    stringArrayValue(report.artifactPaths.manifestShards).length > 0
  );
}

function scanReportSatisfiesDepth(input: {
  report: unknown;
  connectionId: string;
  depth: KtxDatabaseContextDepth;
  relationshipsRequired: boolean;
}): boolean {
  if (input.depth === 'fast') {
    return scanReportHasSchemaManifest(input.report, input.connectionId);
  }
  return scanReportHasCompletedDeepEnrichment(input.report, input.connectionId, input.relationshipsRequired);
}
```

Replace `verifyPrimarySourceScans` with:

```ts
async function verifyPrimarySourceScans(
  project: KtxLocalProject,
  connectionIds: string[],
): Promise<{ ready: boolean; details: string[] }> {
  const details: string[] = [];
  const relationshipsRequired = project.config.scan.relationships.enabled;
  for (const connectionId of connectionIds) {
    const connection = project.config.connections[connectionId];
    const depth = connection ? (databaseContextDepth(connection) ?? 'fast') : 'fast';
    const report = await readLatestScanReport(project.projectDir, connectionId);
    if (!scanReportSatisfiesDepth({ report, connectionId, depth, relationshipsRequired })) {
      details.push(
        depth === 'fast'
          ? `${connectionId}: schema context has not completed.`
          : `${connectionId}: deep database context has not completed.`,
      );
    }
  }
  return { ready: details.length === 0, details };
}
```

In `defaultVerifyContextReady`, change:

```ts
  const primarySourceScans = await verifyPrimarySourceScans(projectDir, targets.primarySourceConnectionIds);
```

to:

```ts
  const primarySourceScans = await verifyPrimarySourceScans(project, targets.primarySourceConnectionIds);
```

- [ ] **Step 4: Update success wording away from scan**

In `writeSuccess`, replace:

```ts
      io.stdout.write(`  ${connectionId}: enriched scan complete\n`);
```

with:

```ts
      const connection = project.config.connections[connectionId];
      const depth = connection ? (databaseContextDepth(connection) ?? 'fast') : 'fast';
      io.stdout.write(`  ${connectionId}: ${depth === 'deep' ? 'deep context complete' : 'schema context complete'}\n`);
```

Change the function signature to accept `project`:

```ts
function writeSuccess(
  project: KtxLocalProject,
  readiness: KtxSetupContextReadiness,
  targets: KtxSetupContextTargets,
  io: KtxCliIo,
): void {
```

Change the caller from:

```ts
  writeSuccess(readiness, targets, io);
```

to:

```ts
  writeSuccess(project, readiness, targets, io);
```

- [ ] **Step 5: Run setup context readiness tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-context.test.ts
```

Expected: PASS after updating old test names and assertions that referred to
`enriched scan complete`.

- [ ] **Step 6: Commit depth-aware readiness**

Run:

```bash
git add packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts
git commit -m "feat(setup): verify context readiness by database depth"
```

### Task 5: Remove background context-build control

**Files:**
- Modify: `packages/cli/src/context-build-view.ts`
- Modify: `packages/cli/src/setup-context.ts`
- Test: `packages/cli/src/context-build-view.test.ts`
- Test: `packages/cli/src/setup-context.test.ts`
- Test: `packages/cli/src/setup.test.ts`

- [ ] **Step 1: Write failing foreground-only tests**

In `packages/cli/src/context-build-view.test.ts`, add:

```ts
  it('renders foreground-only progress hints without detach or resume commands', () => {
    const state = initViewState([
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        operation: 'database-ingest',
        debugCommand: 'ktx ingest warehouse --debug',
        steps: ['database-schema'],
      },
    ]);
    state.primarySources[0]!.status = 'running';

    const rendered = renderContextBuildView(state, { styled: false, showHint: true, projectDir: '/tmp/project' });

    expect(rendered).toContain('Ctrl+C to stop');
    expect(rendered).not.toContain('d to detach');
    expect(rendered).not.toContain('resume');
  });
```

In `packages/cli/src/setup-context.test.ts`, replace tests that expect
detached/watch behavior with:

```ts
  it('normalizes legacy detached and paused setup context states to stale', async () => {
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-old',
      status: 'detached' as never,
      startedAt: '2026-05-09T09:00:00.000Z',
      updatedAt: '2026-05-09T09:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-old'),
    });

    await expect(readKtxSetupContextState(tempDir)).resolves.toMatchObject({
      status: 'stale',
      failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
    });
  });

  it('starts a fresh foreground build when a stale running state is found', async () => {
    await writeReadyProject(tempDir, {
      connections: { warehouse: { driver: 'postgres', readonly: true, context: { depth: 'fast' } } },
    });
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-running',
      status: 'running',
      startedAt: '2026-05-09T09:00:00.000Z',
      updatedAt: '2026-05-09T09:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-running'),
    });
    const io = makeIo();
    const runContextBuildMock = vi.fn(async () => ({ exitCode: 0 }));
    const verifyContextReady = vi.fn(async () => ({
      ready: true,
      agentContextReady: true,
      semanticSearchReady: true,
      details: ['ready'],
    }));

    await expect(
      runKtxSetupContextStep(
        { projectDir: tempDir, inputMode: 'disabled' },
        io.io,
        { runContextBuild: runContextBuildMock, verifyContextReady },
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(runContextBuildMock).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Run failing foreground-only tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/setup-context.test.ts src/setup.test.ts -t "foreground-only|legacy detached|stale running|detached|watch"
```

Expected: FAIL because detach, watch, paused, and background logic still
exist.

- [ ] **Step 3: Remove detach and background spawning from the progress view**

In `packages/cli/src/context-build-view.ts`, remove these imports:

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
```

Delete these functions:

```ts
function resolveKtxEntryScript(): string | null
function spawnBackgroundBuild(projectDir: string): { logPath: string } | null
export function defaultSetupKeystroke(
  onDetach: () => void,
  onCtrlC: () => void,
): (() => void) | null
```

Change the default hint in `renderContextBuildView`:

```ts
    const hintContent = options.hintText ?? 'Ctrl+C to stop';
```

Remove these fields from `ContextBuildDeps`:

```ts
  setupKeystroke?: (onDetach: () => void, onCtrlC: () => void) => (() => void) | null;
  onDetach?: () => void;
```

Change `ContextBuildResult` to:

```ts
export interface ContextBuildResult {
  exitCode: number;
  reportIds?: string[];
  artifactPaths?: string[];
}
```

In `runContextBuild`, delete the `detached`, `exiting`, `cleanupKeystroke`,
and `setupKeystroke` block. Keep the `try/finally` cleanup for
`spinnerInterval`.

Delete this branch:

```ts
  if (detached) {
    return { exitCode: 0, detached: true };
  }
```

Return:

```ts
  return {
    exitCode: hasFailure ? 1 : 0,
    ...(reportIds.size > 0 ? { reportIds: [...reportIds] } : {}),
    ...(artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : {}),
  };
```

- [ ] **Step 4: Normalize setup context state to foreground-only statuses**

In `packages/cli/src/setup-context.ts`, remove `detached` and `paused` from
`KtxSetupContextBuildStatus` and `KtxSetupContextResult`.

Change `KtxSetupContextCommands` to:

```ts
export interface KtxSetupContextCommands {
  build: string;
  status: string;
}
```

Change `contextBuildCommands` to return:

```ts
  return {
    build: `ktx setup --project-dir ${resolvedProjectDir}`,
    status: `ktx status --project-dir ${resolvedProjectDir}`,
  };
```

In `normalizeState`, normalize legacy states:

```ts
  const rawStatus = record.status ?? 'not_started';
  const legacyActive = rawStatus === 'detached' || rawStatus === 'paused' || rawStatus === 'running';
  const status: KtxSetupContextBuildStatus = legacyActive ? 'stale' : rawStatus;
```

Add a default failure reason for legacy active states:

```ts
    ...(typeof record.failureReason === 'string'
      ? { failureReason: record.failureReason }
      : legacyActive
        ? { failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.' }
        : {}),
```

In `setupContextStatusFromState`, remove `watchCommand`:

```ts
    ...(state.runId ? { statusCommand: state.commands.status } : {}),
```

In `runBuild`, remove `onDetach` handling and remove the
`buildResult.detached` branch.

Delete `isActiveStatus`, `watchExitCode`, `defaultSleep`, `writeContextStatus`,
`watchContextStatus`, `watchContextStatusText`,
`watchContextStatusWithProgressView`, and `setupResultFromWatchedState`.

In `runKtxSetupContextStep`, remove the branch that prompts:

```ts
      'A context build is running in the background.\n\n' +
      'You can watch it until it finishes, check its status once, or start a fresh build.'
```

Replace it with:

```ts
    if (existingState.status === 'stale') {
      io.stdout.write('Previous context build state is stale; starting a fresh foreground build.\n');
    }
```

- [ ] **Step 5: Update setup tests that referenced detached/watch**

In `packages/cli/src/setup.test.ts`, replace expectations for returned
`status: 'detached'` from the context step with `status: 'failed'` only when
the mocked context step returns failed. Remove tests named:

- `does not install agents when full setup context build is detached`
- `skips entry menu and auto-watches when context build is active and showEntryMenu is true`

Replace them with one test:

```ts
  it('does not offer background watch choices from setup status', async () => {
    const tempDir = await makeTempProject();
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-stale',
      status: 'running',
      startedAt: '2026-05-09T09:00:00.000Z',
      updatedAt: '2026-05-09T09:00:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir, 'setup-context-local-stale'),
    });

    const result = await runKtxSetupStatus({ projectDir: tempDir }, makeIo().io);

    expect(result).toBe(0);
    const state = await readKtxSetupContextState(tempDir);
    expect(state.status).toBe('stale');
  });
```

- [ ] **Step 6: Run foreground-only tests again**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/context-build-view.test.ts src/setup-context.test.ts src/setup.test.ts
```

Expected: PASS after removing stale detached/watch assertions.

- [ ] **Step 7: Commit foreground-only cleanup**

Run:

```bash
git add packages/cli/src/context-build-view.ts packages/cli/src/context-build-view.test.ts packages/cli/src/setup-context.ts packages/cli/src/setup-context.test.ts packages/cli/src/setup.test.ts
git commit -m "fix(setup): keep context build foreground only"
```

### Task 6: Reject ingest subcommand connection ids

**Files:**
- Modify: `packages/context/src/project/config.ts`
- Modify: `packages/context/src/project/index.ts`
- Modify: `packages/context/src/project/config.test.ts`
- Modify: `packages/cli/src/setup-sources.ts`
- Modify: `packages/cli/src/setup-sources.test.ts`
- Modify: `packages/cli/src/commands/setup-commands.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/setup-databases.ts`
- Modify: `packages/cli/src/setup-databases.test.ts`

- [ ] **Step 1: Write failing reserved-id tests**

In `packages/context/src/project/config.test.ts`, add:

```ts
  it.each(['status', 'replay', 'run', 'watch'])(
    'rejects reserved ingest connection id "%s"',
    (connectionId) => {
      expect(() =>
        parseKtxProjectConfig(`
project: reserved-test
connections:
  ${connectionId}:
    driver: postgres
`),
      ).toThrow(`"${connectionId}" is reserved for ktx ingest ${connectionId}`);
    },
  );
```

In `packages/cli/src/index.test.ts`, add a Commander setup flag test:

```ts
  it('rejects reserved setup database connection ids before dispatch', async () => {
    const testIo = makeIo();
    const setup = vi.fn(async () => 0);

    await expect(
      runKtxCli(['setup', '--new-database-connection-id', 'status', '--no-input'], testIo.io, { setup }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain('"status" is reserved for ktx ingest status; choose a different connection id.');
  });
```

In `packages/cli/src/setup-sources.test.ts`, add a prompt test that enters
`status` for a Notion connection id and expects the step to fail with the same
message.

In `packages/cli/src/setup-databases.test.ts`, add a non-interactive test that
passes `databaseConnectionId: 'replay'` and expects `status: 'failed'` with the
same reserved-id message.

- [ ] **Step 2: Run failing reserved-id tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts -t "reserved ingest connection"
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/setup-sources.test.ts src/setup-databases.test.ts -t "reserved"
```

Expected: FAIL because only the unsafe-character regex exists.

- [ ] **Step 3: Add reserved-id validation to project config**

In `packages/context/src/project/config.ts`, add after `isRecord`:

```ts
const RESERVED_INGEST_CONNECTION_IDS = new Map([
  ['status', 'ktx ingest status'],
  ['replay', 'ktx ingest replay'],
  ['run', 'ktx ingest run'],
  ['watch', 'ktx ingest watch'],
]);

export function reservedKtxIngestConnectionIdMessage(connectionId: string): string | null {
  const command = RESERVED_INGEST_CONNECTION_IDS.get(connectionId);
  return command ? `"${connectionId}" is reserved for ${command}; choose a different connection id.` : null;
}

export function assertKtxConnectionIdIsNotReserved(connectionId: string): void {
  const message = reservedKtxIngestConnectionIdMessage(connectionId);
  if (message) {
    throw new Error(message);
  }
}
```

In `parseKtxProjectConfig`, before returning the parsed object, validate
connection ids:

```ts
  const parsedConnections = isRecord(parsed.connections)
    ? (parsed.connections as Record<string, KtxProjectConnectionConfig>)
    : defaults.connections;
  for (const connectionId of Object.keys(parsedConnections)) {
    assertKtxConnectionIdIsNotReserved(connectionId);
  }
```

Then change the returned `connections` field to:

```ts
    connections: parsedConnections,
```

In `packages/context/src/project/index.ts`, export the helpers:

```ts
export {
  assertKtxConnectionIdIsNotReserved,
  buildDefaultKtxProjectConfig,
  parseKtxProjectConfig,
  reservedKtxIngestConnectionIdMessage,
  serializeKtxProjectConfig,
} from './config.js';
```

- [ ] **Step 4: Use reserved-id validation in setup**

In `packages/cli/src/setup-sources.ts`, import:

```ts
import { assertKtxConnectionIdIsNotReserved } from '@ktx/context/project';
```

Change `assertSafeConnectionId`:

```ts
function assertSafeConnectionId(connectionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  assertKtxConnectionIdIsNotReserved(connectionId);
}
```

In `packages/cli/src/setup-databases.ts`, import
`assertKtxConnectionIdIsNotReserved` and add:

```ts
function assertSafeDatabaseConnectionId(connectionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  assertKtxConnectionIdIsNotReserved(connectionId);
}
```

In `chooseConnectionIdForDriver`, validate every new id before returning:

```ts
    assertSafeDatabaseConnectionId(input.args.databaseConnectionId);
    return { kind: 'new', connectionId: input.args.databaseConnectionId };
```

and:

```ts
    assertSafeDatabaseConnectionId(connectionId);
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
```

In `packages/cli/src/commands/setup-commands.ts`, update
`--new-database-connection-id` parsing:

```ts
    .option('--new-database-connection-id <id>', 'Connection id for one new database connection', (value) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
        throw new InvalidArgumentError(`Unsafe connection id: ${value}`);
      }
      const reservedMessage = reservedKtxIngestConnectionIdMessage(value);
      if (reservedMessage) {
        throw new InvalidArgumentError(reservedMessage);
      }
      return value;
    })
```

Add the import:

```ts
import { reservedKtxIngestConnectionIdMessage } from '@ktx/context/project';
```

- [ ] **Step 5: Run reserved-id tests again**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts -t "reserved ingest connection"
pnpm --filter @ktx/cli exec vitest run src/index.test.ts src/setup-sources.test.ts src/setup-databases.test.ts -t "reserved"
```

Expected: PASS.

- [ ] **Step 6: Commit reserved-id validation**

Run:

```bash
git add packages/context/src/project/config.ts packages/context/src/project/index.ts packages/context/src/project/config.test.ts packages/cli/src/setup-sources.ts packages/cli/src/setup-sources.test.ts packages/cli/src/setup-databases.ts packages/cli/src/setup-databases.test.ts packages/cli/src/commands/setup-commands.ts packages/cli/src/index.test.ts
git commit -m "fix(config): reject reserved ingest connection ids"
```

### Task 7: Final verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused TypeScript tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/public-ingest.test.ts src/setup-context.test.ts src/context-build-view.test.ts src/setup-databases.test.ts src/setup-sources.test.ts src/setup.test.ts src/index.test.ts
pnpm --filter @ktx/context exec vitest run src/project/config.test.ts src/ingest/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type checks**

Run:

```bash
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run docs and script tests touched by unified ingest**

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

Expected: PASS. If the check reports unrelated pre-existing findings, record
the exact findings in the implementation notes and do not silence them with a
broad ignore.

- [ ] **Step 5: Run pre-commit for changed files**

Run:

```bash
uv run pre-commit run --files \
  packages/cli/src/ingest-depth.ts \
  packages/cli/src/public-ingest.ts \
  packages/cli/src/public-ingest.test.ts \
  packages/cli/src/setup-context.ts \
  packages/cli/src/setup-context.test.ts \
  packages/cli/src/context-build-view.ts \
  packages/cli/src/context-build-view.test.ts \
  packages/cli/src/setup-databases.ts \
  packages/cli/src/setup-databases.test.ts \
  packages/cli/src/setup-sources.ts \
  packages/cli/src/setup-sources.test.ts \
  packages/cli/src/commands/setup-commands.ts \
  packages/cli/src/index.test.ts \
  packages/context/src/project/config.ts \
  packages/context/src/project/config.test.ts \
  packages/context/src/project/index.ts
```

Expected: PASS. If local `uv` cannot satisfy the pinned project version, state
the version mismatch and run the TypeScript checks above as the closest
available verification.

- [ ] **Step 6: Commit verification-only fixes**

If verification required expectation or formatting changes, run:

```bash
git add packages/cli/src packages/context/src scripts README.md
git commit -m "test: close unified ingest v1 expectations"
```

If no files changed during verification, do not create an empty commit.

## Self-review notes

Spec coverage in this plan:

- Covers deep readiness failures before work starts for explicit or stored
  `deep` and for query-history depth upgrades.
- Covers `scan.relationships.enabled` in deep database ingest.
- Covers setup depth prompting and storage under
  `connections.<id>.context.depth`.
- Covers fast readiness without AI descriptions or embeddings.
- Covers deep readiness with relationship-stage gating only when relationship
  discovery is enabled.
- Covers generated setup query-history config under
  `connections.<id>.context.queryHistory`.
- Covers setup migration from legacy `connection.historicSql`.
- Covers foreground-only context build by removing detach, watch, resume, stop,
  paused/detached state, and background subprocess behavior.
- Covers reserved ingest subcommand ids in setup and config validation.

Placeholder scan: no deferred markers, unnamed edge handling, or undefined
types remain in the plan. The plan uses concrete file paths, commands, and
code shapes for each implementation task.
