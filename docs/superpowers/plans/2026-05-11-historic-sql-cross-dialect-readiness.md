# Historic SQL Cross-Dialect Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the redesigned historic-SQL adapter usable through the local CLI for Postgres, BigQuery, and Snowflake, with a truthful probe contract and Postgres doctor severity that matches the redesign.

**Architecture:** Keep the unified hot path and skills/projection code intact. Normalize every historic-SQL reader to return a deterministic probe object, allow the local adapter factory to inject any `HistoricSqlReader` plus matching query client, and let the CLI choose the reader/query client from the configured connection dialect. Postgres `pg_stat_statements.max` becomes informational while `pg_stat_statements.track = none` remains a warning.

**Tech Stack:** TypeScript ESM/NodeNext, zod 4, Vitest, existing KTX connector scan interfaces, existing managed daemon SQL-analysis port.

---

## Starting Point

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans found that are based on this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-skills-projection-cutover.md`

Implemented status verified in this worktree:

- `2026-05-11-historic-sql-foundations.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `SqlAnalysisPort.analyzeBatch()` in `packages/context/src/sql-analysis/ports.ts`, `/sql/analyze-batch` in `python/ktx-daemon/src/ktx_daemon/app.py`, `SemanticLayerSource.usage` in `packages/context/src/sl/types.ts`, and `mergeUsagePreservingExternal()` in `packages/context/src/ingest/adapters/live-database/manifest.ts`.
- `2026-05-11-historic-sql-search-enrichment.md` is implemented. Evidence: `packages/context/src/sl/sl-search.service.ts` indexes `source.usage`, `packages/context/src/sl/sqlite-sl-sources-index.ts` selects FTS snippets, and local/MCP list surfaces expose `frequencyTier` and `snippet`.
- `2026-05-11-historic-sql-unified-hot-path.md` is implemented for the shared stager/chunker and Postgres reader. Evidence: `stageHistoricSqlAggregatedSnapshot()`, `chunkHistoricSqlUnifiedStagedDir()`, `PostgresPgssReader`, aggregate BigQuery/Snowflake `fetchAggregated()` methods, unified schemas, and exports exist.
- `2026-05-11-historic-sql-skills-projection-cutover.md` is implemented for the production adapter, skills, evidence tool, projection post-processor, and old code deletion. Evidence: `HistoricSqlSourceAdapter` uses `stageHistoricSqlAggregatedSnapshot()` and `chunkHistoricSqlUnifiedStagedDir()`, `packages/context/skills/historic_sql_table_digest/` and `packages/context/skills/historic_sql_patterns/` exist, `HistoricSqlProjectionPostProcessor` is wired in `local-bundle-runtime.ts`, and old `historic_sql_ingest` / `historic_sql_curator` skill directories are absent.

Remaining core gaps from the spec:

- `BigQueryHistoricSqlQueryHistoryReader.probe()` and `SnowflakeHistoricSqlQueryHistoryReader.probe()` return `void`, but `stageHistoricSqlAggregatedSnapshot()` reads `probe.warnings`. A BigQuery or Snowflake historic-SQL run would fail before staging.
- `createKtxCliLocalIngestAdapters()` only registers a historic-SQL adapter when the target connection is Postgres, while `ktx setup` can enable `historicSql` for BigQuery and Snowflake.
- `PostgresPgssReader.probe()` still reports low `pg_stat_statements.max` as a warning, but the spec says that check is informational after baseline tracking was removed.

This plan does not update `examples/postgres-historic/README.md` or `examples/postgres-historic/scripts/smoke.sh`. Those still describe the legacy baseline/delta/reset behavior and should be handled in a separate documentation/acceptance plan after this cross-dialect code path is fixed.

## File Structure

Modify:

- `packages/context/src/ingest/adapters/historic-sql/types.ts`  
  Adds optional probe `info` notes and lets injected historic-SQL dependencies use any reader/query client pair while preserving the existing Postgres-specific option.
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`  
  Moves low `pg_stat_statements.max` from `warnings` to `info`.
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`  
  Locks `track = none` as warning and low `max` as info.
- `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts`  
  Returns `{ warnings: [], info: [] }` from `probe()`.
- `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts`  
  Locks the BigQuery probe return object.
- `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts`  
  Returns `{ warnings: [], info: [] }` from `probe()`.
- `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts`  
  Locks the Snowflake probe return object.
- `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`  
  Updates test readers to return the normalized probe shape.
- `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`  
  Updates test readers to return the normalized probe shape.
- `packages/context/src/ingest/local-adapters.ts`  
  Accepts generic historic-SQL reader/query-client dependencies while keeping `postgresQueryClient` as the compatibility input used by current callers.
- `packages/context/src/ingest/local-adapters.test.ts`  
  Verifies generic reader/query-client injection and the existing Postgres compatibility path.
- `packages/cli/src/local-adapters.ts`  
  Chooses Postgres, BigQuery, or Snowflake historic-SQL readers/query clients from the configured connection.
- `packages/cli/src/local-adapters.test.ts`  
  Adds direct tests for CLI local adapter registration for Postgres, BigQuery, and Snowflake.
- `packages/cli/src/historic-sql-doctor.ts`  
  Treats info-only Postgres probe notes as a passing doctor check, and warnings as warnings.
- `packages/cli/src/historic-sql-doctor.test.ts`  
  Verifies low `pg_stat_statements.max` is pass/detail, while `track = none` remains warn.
- `packages/cli/src/doctor.test.ts`  
  Updates the project doctor integration expectation for the new info-only behavior.

## Task 1: Normalize Historic-SQL Probe Results

**Files:**
- Modify: `packages/context/src/ingest/adapters/historic-sql/types.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`

- [ ] **Step 1: Update failing reader probe tests**

In `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts`, replace the existing successful probe assertion:

```typescript
await expect(reader.probe(client)).resolves.toBeUndefined();
```

with:

```typescript
await expect(reader.probe(client)).resolves.toEqual({ warnings: [], info: [] });
```

In `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts`, replace the existing successful probe assertion:

```typescript
await expect(reader.probe(client)).resolves.toBeUndefined();
```

with:

```typescript
await expect(reader.probe(client)).resolves.toEqual({ warnings: [], info: [] });
```

In `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`, change the successful probe expectation to include `info: []`:

```typescript
await expect(reader.probe(client)).resolves.toEqual({
  pgServerVersion: 'PostgreSQL 16.4',
  warnings: [],
  info: [],
});
```

In the `returns a warning instead of failing when pg_stat_statements.track is none` test, change the expected object to:

```typescript
await expect(reader.probe(client)).resolves.toEqual({
  pgServerVersion: 'PostgreSQL 16.4',
  warnings: [
    'pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config',
  ],
  info: [],
});
```

Rename the low-max test from:

```typescript
it('warns when pg_stat_statements.max is below the recommended floor', async () => {
```

to:

```typescript
it('returns an info note when pg_stat_statements.max is below the recommended floor', async () => {
```

and change its expected object to:

```typescript
await expect(reader.probe(client)).resolves.toEqual({
  pgServerVersion: 'PostgreSQL 16.4',
  warnings: [],
  info: [
    'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
  ],
});
```

In `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`, change the test reader probe from:

```typescript
async probe() {
  return { warnings: ['pg_stat_statements.max is low; aggregation still proceeds'] };
},
```

to:

```typescript
async probe() {
  return { warnings: ['pg_stat_statements.track is none; aggregation still proceeds'], info: [] };
},
```

and update the manifest expectation from:

```typescript
probeWarnings: ['pg_stat_statements.max is low; aggregation still proceeds'],
```

to:

```typescript
probeWarnings: ['pg_stat_statements.track is none; aggregation still proceeds'],
```

In `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`, replace every test reader probe result:

```typescript
return { warnings: [] };
```

with:

```typescript
return { warnings: [], info: [] };
```

- [ ] **Step 2: Run reader tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts \
  src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/stage-unified.test.ts \
  src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts
```

Expected: FAIL. The failure should show missing `info` fields and BigQuery/Snowflake probes resolving to `undefined`.

- [ ] **Step 3: Update probe contracts and implementations**

In `packages/context/src/ingest/adapters/historic-sql/types.ts`, replace:

```typescript
export interface HistoricSqlProbeResult {
  warnings: string[];
}
```

with:

```typescript
export interface HistoricSqlProbeResult {
  warnings: string[];
  info?: string[];
}
```

In the same file, replace:

```typescript
export interface PostgresPgssProbeResult {
  pgServerVersion: string;
  warnings: string[];
}
```

with:

```typescript
export interface PostgresPgssProbeResult extends HistoricSqlProbeResult {
  pgServerVersion: string;
  warnings: string[];
  info: string[];
}
```

In `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`, replace the warning construction block:

```typescript
const warnings: string[] = [];
if (track === 'none') {
  warnings.push('pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config');
}
if (pgssMax !== null && pgssMax < RECOMMENDED_PGSS_MAX) {
  warnings.push(
    `pg_stat_statements.max is ${pgssMax}; set it to at least ${RECOMMENDED_PGSS_MAX} to reduce query-template eviction churn`,
  );
}

return { pgServerVersion, warnings };
```

with:

```typescript
const warnings: string[] = [];
const info: string[] = [];
if (track === 'none') {
  warnings.push('pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config');
}
if (pgssMax !== null && pgssMax < RECOMMENDED_PGSS_MAX) {
  info.push(
    `pg_stat_statements.max is ${pgssMax}; set it to at least ${RECOMMENDED_PGSS_MAX} to reduce query-template eviction churn`,
  );
}

return { pgServerVersion, warnings, info };
```

In `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts`, replace the successful end of `probe()`:

```typescript
if (result.error) {
  throw grantsError(result.error);
}
```

with:

```typescript
if (result.error) {
  throw grantsError(result.error);
}
return { warnings: [], info: [] };
```

and change the method signature from:

```typescript
async probe(client: unknown): Promise<void> {
```

to:

```typescript
async probe(client: unknown): Promise<{ warnings: string[]; info: string[] }> {
```

In `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts`, make the same signature and return changes:

```typescript
async probe(client: unknown): Promise<{ warnings: string[]; info: string[] }> {
  let result: QueryResultLike;
  try {
    result = await queryClient(client).executeQuery(PROBE_SQL);
  } catch (error) {
    throw grantsError(error);
  }
  if (result.error) {
    throw grantsError(result.error);
  }
  return { warnings: [], info: [] };
}
```

- [ ] **Step 4: Run reader tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts \
  src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/stage-unified.test.ts \
  src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/context/src/ingest/adapters/historic-sql/types.ts \
  packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts \
  packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts \
  packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts \
  packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts \
  packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts \
  packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts \
  packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts \
  packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts
git commit -m "fix: normalize historic sql probe results"
```

## Task 2: Allow Generic Historic-SQL Reader Injection

**Files:**
- Modify: `packages/context/src/ingest/local-adapters.ts`
- Modify: `packages/context/src/ingest/local-adapters.test.ts`

- [ ] **Step 1: Write failing context adapter injection tests**

In `packages/context/src/ingest/local-adapters.test.ts`, add `HistoricSqlReader` to the existing imports from `./adapters/historic-sql/types.js` if that import exists, or add this import near the other ingest imports:

```typescript
import type { HistoricSqlReader } from './adapters/historic-sql/types.js';
```

Add this test after `registers historic-sql locally when Postgres historic-SQL deps are provided`:

```typescript
it('registers historic-sql with an injected non-Postgres reader and query client', () => {
  const reader: HistoricSqlReader = {
    async probe() {
      return { warnings: [], info: [] };
    },
    async *fetchAggregated() {},
  };
  const queryClient = { executeQuery: async () => ({ headers: [], rows: [], totalRows: 0 }) };

  const adapters = createDefaultLocalIngestAdapters(project, {
    historicSql: {
      sqlAnalysis: {
        async analyzeForFingerprint(sql) {
          return {
            fingerprint: 'fp',
            normalizedSql: sql,
            tablesTouched: [],
            literalSlots: [],
          };
        },
        async analyzeBatch() {
          return new Map();
        },
      },
      reader,
      queryClient,
    },
  });

  const adapter = adapters.find((candidate) => candidate.source === 'historic-sql');
  expect(adapter).toBeDefined();
  expect(adapter?.fetch).toBeTypeOf('function');
});
```

Add this assertion inside the existing `registers historic-sql locally when Postgres historic-SQL deps are provided` test after the adapter lookup assertion:

```typescript
expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
  'historic_sql_table_digest',
  'historic_sql_patterns',
]);
```

- [ ] **Step 2: Run context adapter tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-adapters.test.ts
```

Expected: FAIL with TypeScript or runtime errors because `DefaultLocalIngestAdaptersOptions['historicSql']` does not accept `reader` or `queryClient`.

- [ ] **Step 3: Update local adapter dependency shape**

In `packages/context/src/ingest/local-adapters.ts`, add `HistoricSqlReader` to the historic-SQL type imports:

```typescript
import {
  HISTORIC_SQL_SOURCE_KEY,
  historicSqlUnifiedPullConfigSchema,
  type HistoricSqlReader,
  type KtxPostgresQueryClient,
} from './adapters/historic-sql/types.js';
```

Replace the `historicSql` option block in `DefaultLocalIngestAdaptersOptions`:

```typescript
historicSql?: {
  sqlAnalysis: SqlAnalysisPort;
  postgresQueryClient: KtxPostgresQueryClient;
  postgresBaselineRootDir?: string;
  now?: () => Date;
};
```

with:

```typescript
historicSql?: {
  sqlAnalysis: SqlAnalysisPort;
  reader?: HistoricSqlReader;
  queryClient?: unknown;
  postgresQueryClient?: KtxPostgresQueryClient;
  postgresBaselineRootDir?: string;
  now?: () => Date;
};
```

Replace the historic-SQL adapter construction block:

```typescript
if (options.historicSql) {
  adapters.push(
    new HistoricSqlSourceAdapter({
      sqlAnalysis: options.historicSql.sqlAnalysis,
      reader: new PostgresPgssReader(),
      queryClient: options.historicSql.postgresQueryClient,
      legacyPostgresBaselineRootDir: options.historicSql.postgresBaselineRootDir,
      now: options.historicSql.now,
    }),
  );
}
```

with:

```typescript
if (options.historicSql) {
  const queryClient = options.historicSql.queryClient ?? options.historicSql.postgresQueryClient;
  if (!queryClient) {
    throw new Error('Historic SQL local adapter requires queryClient or postgresQueryClient');
  }
  adapters.push(
    new HistoricSqlSourceAdapter({
      sqlAnalysis: options.historicSql.sqlAnalysis,
      reader: options.historicSql.reader ?? new PostgresPgssReader(),
      queryClient,
      legacyPostgresBaselineRootDir: options.historicSql.postgresBaselineRootDir,
      now: options.historicSql.now,
    }),
  );
}
```

- [ ] **Step 4: Run context adapter tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/src/ingest/local-adapters.ts packages/context/src/ingest/local-adapters.test.ts
git commit -m "feat: allow generic historic sql readers locally"
```

## Task 3: Register BigQuery And Snowflake Historic SQL In The CLI

**Files:**
- Create: `packages/cli/src/local-adapters.test.ts`
- Modify: `packages/cli/src/local-adapters.ts`

- [ ] **Step 1: Write failing CLI local adapter tests**

Create `packages/cli/src/local-adapters.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKtxProject } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';

function sqlAnalysisStub() {
  return {
    async analyzeForFingerprint(sql: string) {
      return {
        fingerprint: 'fp',
        normalizedSql: sql,
        tablesTouched: [],
        literalSlots: [],
      };
    },
    async analyzeBatch() {
      return new Map();
    },
  };
}

async function writeProject(projectDir: string, body: string): Promise<void> {
  await writeFile(join(projectDir, 'ktx.yaml'), body, 'utf-8');
}

describe('CLI local ingest adapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-local-adapters-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('registers Postgres historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'warehouse',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers BigQuery historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'project: warehouse',
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    readonly: true',
        '    dataset_id: analytics',
        '    location: us',
        '    credentials_json: \'{"project_id":"demo-project"}\'',
        '    historicSql:',
        '      enabled: true',
        '      dialect: bigquery',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'bq',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers Snowflake historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'project: warehouse',
        'connections:',
        '  sf:',
        '    driver: snowflake',
        '    readonly: true',
        '    account: acct',
        '    warehouse: wh',
        '    database: ANALYTICS',
        '    schema_name: PUBLIC',
        '    username: reader',
        '    password: env:SNOWFLAKE_PASSWORD',
        '    historicSql:',
        '      enabled: true',
        '      dialect: snowflake',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'sf',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });
});
```

- [ ] **Step 2: Run the new CLI adapter test to verify it fails**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/local-adapters.test.ts
```

Expected: FAIL. BigQuery and Snowflake cases should not find a `historic-sql` adapter.

- [ ] **Step 3: Add cross-dialect query clients and reader selection**

In `packages/cli/src/local-adapters.ts`, replace the BigQuery import:

```typescript
import { createBigQueryLiveDatabaseIntrospection, isKtxBigQueryConnectionConfig } from '@ktx/connector-bigquery';
```

with:

```typescript
import {
  createBigQueryLiveDatabaseIntrospection,
  isKtxBigQueryConnectionConfig,
  KtxBigQueryScanConnector,
  type KtxBigQueryConnectionConfig,
} from '@ktx/connector-bigquery';
```

Replace the context ingest import block:

```typescript
import {
  createDaemonLiveDatabaseIntrospection,
  createDefaultLocalIngestAdapters,
  type DefaultLocalIngestAdaptersOptions,
  type LiveDatabaseIntrospectionPort,
  LiveDatabaseSourceAdapter,
  type SourceAdapter,
} from '@ktx/context/ingest';
```

with:

```typescript
import {
  BigQueryHistoricSqlQueryHistoryReader,
  createDaemonLiveDatabaseIntrospection,
  createDefaultLocalIngestAdapters,
  type DefaultLocalIngestAdaptersOptions,
  type HistoricSqlReader,
  type LiveDatabaseIntrospectionPort,
  LiveDatabaseSourceAdapter,
  PostgresPgssReader,
  SnowflakeHistoricSqlQueryHistoryReader,
  type SourceAdapter,
} from '@ktx/context/ingest';
```

Replace the SQL-analysis import:

```typescript
import { createHttpSqlAnalysisPort } from '@ktx/context/sql-analysis';
```

with:

```typescript
import { createHttpSqlAnalysisPort, type SqlAnalysisPort } from '@ktx/context/sql-analysis';
```

Add this top-level Snowflake type alias below `hasSnowflakeDriver()`:

```typescript
type SnowflakeConnectorModule = typeof import('@ktx/connector-snowflake');
```

Add an injectable SQL-analysis port to `KtxCliLocalIngestAdaptersOptions`:

```typescript
export interface KtxCliLocalIngestAdaptersOptions extends DefaultLocalIngestAdaptersOptions {
  historicSqlConnectionId?: string;
  sqlAnalysis?: SqlAnalysisPort;
  sqlAnalysisUrl?: string;
  managedDaemon?: ManagedPythonCoreDaemonOptions;
}
```

Add this as the first branch in `ktxCliHistoricSqlAnalysis()`:

```typescript
if (options.sqlAnalysis) {
  return options.sqlAnalysis;
}
```

Replace `isEnabledPostgresHistoricSqlConnection()` with these helpers:

```typescript
function historicSqlRecord(connection: unknown): Record<string, unknown> | null {
  if (
    connection &&
    typeof connection === 'object' &&
    'historicSql' in connection &&
    typeof (connection as { historicSql?: unknown }).historicSql === 'object' &&
    (connection as { historicSql?: unknown }).historicSql !== null &&
    !Array.isArray((connection as { historicSql?: unknown }).historicSql)
  ) {
    return (connection as { historicSql: Record<string, unknown> }).historicSql;
  }
  return null;
}

function enabledHistoricSqlDialect(connection: unknown): 'postgres' | 'bigquery' | 'snowflake' | null {
  const historicSql = historicSqlRecord(connection);
  if (historicSql?.enabled !== true) {
    return null;
  }
  const dialect = String(historicSql.dialect ?? '').toLowerCase();
  return dialect === 'postgres' || dialect === 'bigquery' || dialect === 'snowflake' ? dialect : null;
}
```

Keep `createEphemeralPostgresHistoricSqlClient()` and add these two query-client helpers below it:

```typescript
function createEphemeralBigQueryHistoricSqlClient(project: KtxLocalProject, connectionId: string) {
  const connection = project.config.connections[connectionId] as KtxBigQueryConnectionConfig | undefined;
  if (!isKtxBigQueryConnectionConfig(connection)) {
    throw new Error(
      `Historic SQL local ingest requires a BigQuery connection, got ${String(connection?.driver ?? 'unknown')}`,
    );
  }
  return {
    async executeQuery(query: string) {
      const connector = new KtxBigQueryScanConnector({
        connectionId,
        connection,
      });
      try {
        const result = await connector.executeReadOnly({ connectionId, sql: query }, {} as never);
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}

async function createEphemeralSnowflakeHistoricSqlClient(
  project: KtxLocalProject,
  connectionId: string,
  connectorModule: SnowflakeConnectorModule,
) {
  const connection = project.config.connections[connectionId];
  if (!connectorModule.isKtxSnowflakeConnectionConfig(connection)) {
    throw new Error(
      `Historic SQL local ingest requires a Snowflake connection, got ${String(connection?.driver ?? 'unknown')}`,
    );
  }
  return {
    async executeQuery(query: string) {
      const connector = new connectorModule.KtxSnowflakeScanConnector({
        connectionId,
        connection,
      });
      try {
        const result = await connector.executeReadOnly({ connectionId, sql: query }, {} as never);
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}
```

Replace `historicSqlOptionsForLocalRun()` with:

```typescript
function bigQueryProjectId(connection: KtxBigQueryConnectionConfig, env: NodeJS.ProcessEnv): string {
  const raw = typeof connection.credentials_json === 'string' ? connection.credentials_json : '';
  const resolved = raw.startsWith('env:') ? env[raw.slice('env:'.length)] ?? '' : raw;
  const parsed = JSON.parse(resolved) as { project_id?: unknown };
  if (typeof parsed.project_id !== 'string' || parsed.project_id.trim().length === 0) {
    throw new Error('Historic SQL BigQuery connection requires credentials_json.project_id');
  }
  return parsed.project_id;
}

function bigQueryRegion(connection: KtxBigQueryConnectionConfig): string {
  return typeof connection.location === 'string' && connection.location.trim().length > 0
    ? connection.location.trim()
    : 'us';
}

function historicSqlOptionsForLocalRun(project: KtxLocalProject, options: KtxCliLocalIngestAdaptersOptions) {
  const connectionId = options.historicSqlConnectionId;
  if (!connectionId) {
    return undefined;
  }
  const connection = project.config.connections[connectionId];
  const dialect = enabledHistoricSqlDialect(connection);
  if (!dialect) {
    return undefined;
  }

  const base = {
    sqlAnalysis: ktxCliHistoricSqlAnalysis(options),
    postgresBaselineRootDir: join(project.projectDir, '.ktx/cache/historic-sql'),
  };

  if (dialect === 'postgres') {
    return {
      ...base,
      reader: new PostgresPgssReader() satisfies HistoricSqlReader,
      queryClient: createEphemeralPostgresHistoricSqlClient(project, connectionId),
    };
  }

  if (dialect === 'bigquery') {
    if (!isKtxBigQueryConnectionConfig(connection)) {
      throw new Error(
        `Historic SQL local ingest requires a BigQuery connection, got ${String(connection?.driver ?? 'unknown')}`,
      );
    }
    return {
      ...base,
      reader: new BigQueryHistoricSqlQueryHistoryReader({
        projectId: bigQueryProjectId(connection, process.env),
        region: bigQueryRegion(connection),
      }) satisfies HistoricSqlReader,
      queryClient: createEphemeralBigQueryHistoricSqlClient(project, connectionId),
    };
  }

  return {
    ...base,
    reader: new SnowflakeHistoricSqlQueryHistoryReader() satisfies HistoricSqlReader,
    queryClient: {
      async executeQuery(query: string) {
        const connectorModule = await import('@ktx/connector-snowflake');
        const client = await createEphemeralSnowflakeHistoricSqlClient(project, connectionId, connectorModule);
        return client.executeQuery(query);
      },
    },
  };
}
```

- [ ] **Step 4: Run CLI adapter tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing ingest wiring tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest.test.ts
pnpm --filter @ktx/context exec vitest run src/ingest/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/local-adapters.ts packages/cli/src/local-adapters.test.ts
git commit -m "feat: wire historic sql readers for bigquery and snowflake"
```

## Task 4: Downgrade Low PGSS Max To Informational Doctor Output

**Files:**
- Modify: `packages/cli/src/historic-sql-doctor.ts`
- Modify: `packages/cli/src/historic-sql-doctor.test.ts`
- Modify: `packages/cli/src/doctor.test.ts`

- [ ] **Step 1: Write failing doctor severity tests**

In `packages/cli/src/historic-sql-doctor.test.ts`, replace the existing low-max warning test with:

```typescript
it('passes with an informational note when only pg_stat_statements.max is below the recommended floor', async () => {
  const checks = await runPostgresHistoricSqlDoctorChecks(
    projectWithConnections({
      warehouse: {
        driver: 'postgres',
        url: 'env:WAREHOUSE_DATABASE_URL',
        readonly: true,
        historicSql: { enabled: true, dialect: 'postgres' },
      },
    }),
    {
      postgresHistoricSqlProbe: async () => ({
        pgServerVersion: 'PostgreSQL 16.4',
        warnings: [],
        info: [
          'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
        ],
      }),
    },
  );

  expect(checks).toEqual([
    {
      id: 'historic-sql-postgres-warehouse',
      label: 'Postgres Historic SQL (warehouse)',
      status: 'pass',
      detail:
        'pg_stat_statements ready (PostgreSQL 16.4); info: pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
    },
  ]);
});
```

Add this test immediately after it:

```typescript
it('warns when pg_stat_statements tracking is disabled', async () => {
  const checks = await runPostgresHistoricSqlDoctorChecks(
    projectWithConnections({
      warehouse: {
        driver: 'postgres',
        url: 'env:WAREHOUSE_DATABASE_URL',
        readonly: true,
        historicSql: { enabled: true, dialect: 'postgres' },
      },
    }),
    {
      postgresHistoricSqlProbe: async () => ({
        pgServerVersion: 'PostgreSQL 16.4',
        warnings: [
          'pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config',
        ],
        info: [
          'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
        ],
      }),
    },
  );

  expect(checks).toEqual([
    {
      id: 'historic-sql-postgres-warehouse',
      label: 'Postgres Historic SQL (warehouse)',
      status: 'warn',
      detail:
        'pg_stat_statements ready (PostgreSQL 16.4) with warnings: pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config; info: pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
      fix: 'Update the Postgres parameter group or config, then rerun `ktx dev doctor --project-dir /tmp/ktx-project`',
    },
  ]);
});
```

In `packages/cli/src/doctor.test.ts`, replace the `includes Postgres historic-SQL readiness in project doctor output` test's fake historic-SQL check with a pass/info check:

```typescript
const runHistoricSqlDoctorChecks = vi.fn(async () => [
  {
    id: 'historic-sql-postgres-warehouse',
    label: 'Postgres Historic SQL (warehouse)',
    status: 'pass' as const,
    detail:
      'pg_stat_statements ready (PostgreSQL 16.4); info: pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
  },
]);
```

and replace the output assertions:

```typescript
expect(testIo.stdout()).toContain('WARN Postgres Historic SQL (warehouse): pg_stat_statements ready');
expect(testIo.stdout()).toContain('Fix: Update the Postgres parameter group or config');
```

with:

```typescript
expect(testIo.stdout()).toContain('PASS Postgres Historic SQL (warehouse): pg_stat_statements ready');
expect(testIo.stdout()).toContain('info: pg_stat_statements.max is 1000');
expect(testIo.stdout()).not.toContain('Fix: Update the Postgres parameter group or config');
```

- [ ] **Step 2: Run doctor tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/historic-sql-doctor.test.ts src/doctor.test.ts
```

Expected: FAIL. The current doctor still treats any probe note as `warn`.

- [ ] **Step 3: Update doctor probe and rendering logic**

In `packages/cli/src/historic-sql-doctor.ts`, replace:

```typescript
export interface PostgresHistoricSqlDoctorProbeResult {
  pgServerVersion: string;
  warnings: string[];
}
```

with:

```typescript
export interface PostgresHistoricSqlDoctorProbeResult {
  pgServerVersion: string;
  warnings: string[];
  info?: string[];
}
```

Add this helper below `failureDetail()`:

```typescript
function readinessDetail(result: PostgresHistoricSqlDoctorProbeResult): string {
  const warningText = result.warnings.length > 0 ? ` with warnings: ${result.warnings.join('; ')}` : '';
  const info = result.info ?? [];
  const infoText = info.length > 0 ? `; info: ${info.join('; ')}` : '';
  return `pg_stat_statements ready (${result.pgServerVersion})${warningText}${infoText}`;
}
```

Replace this block:

```typescript
if (result.warnings.length > 0) {
  checks.push(
    check(
      'warn',
      checkId(connectionId),
      label,
      `pg_stat_statements ready (${result.pgServerVersion}) with warnings: ${result.warnings.join('; ')}`,
      `Update the Postgres parameter group or config, then rerun \`ktx dev doctor --project-dir ${project.projectDir}\``,
    ),
  );
} else {
  checks.push(
    check('pass', checkId(connectionId), label, `pg_stat_statements ready (${result.pgServerVersion})`),
  );
}
```

with:

```typescript
if (result.warnings.length > 0) {
  checks.push(
    check(
      'warn',
      checkId(connectionId),
      label,
      readinessDetail(result),
      `Update the Postgres parameter group or config, then rerun \`ktx dev doctor --project-dir ${project.projectDir}\``,
    ),
  );
} else {
  checks.push(check('pass', checkId(connectionId), label, readinessDetail(result)));
}
```

- [ ] **Step 4: Run doctor tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/historic-sql-doctor.test.ts src/doctor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/historic-sql-doctor.ts packages/cli/src/historic-sql-doctor.test.ts packages/cli/src/doctor.test.ts
git commit -m "fix: make pgss max advisory informational"
```

## Task 5: Final Verification

**Files:**
- Verify: `packages/context/src/ingest/adapters/historic-sql/*`
- Verify: `packages/context/src/ingest/local-adapters.ts`
- Verify: `packages/cli/src/local-adapters.ts`
- Verify: `packages/cli/src/historic-sql-doctor.ts`

- [ ] **Step 1: Run focused historic-SQL test suites**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/types.test.ts \
  src/ingest/adapters/historic-sql/buckets.test.ts \
  src/ingest/adapters/historic-sql/stage-unified.test.ts \
  src/ingest/adapters/historic-sql/chunk-unified.test.ts \
  src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts \
  src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts \
  src/ingest/local-adapters.test.ts
pnpm --filter @ktx/cli exec vitest run \
  src/local-adapters.test.ts \
  src/historic-sql-doctor.test.ts \
  src/doctor.test.ts \
  src/ingest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run the no-old-code grep**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline|historic_sql_ingest|historic_sql_curator|PostgresPgssQueryHistoryReader|historic_sql_template" packages/context packages/cli
```

Expected: no matches.

- [ ] **Step 4: Run pre-commit for touched files**

Run with the actual touched file list:

```bash
uv run pre-commit run --files $(git diff --name-only)
```

Expected: PASS. If local `uv` refuses due the repo's exact uv pin, activate `.venv` and run the nearest available checks, then record the exact uv version mismatch in the implementation summary.

- [ ] **Step 5: Confirm verification did not create unintended changes**

Run:

```bash
git status --short
```

Expected: the only changed files are the files committed in Tasks 1-4. If a verification command changed another tracked file, inspect it with `git diff -- <path>` and either commit it with the task that intentionally owns that file or revert only that verification-generated file after confirming it was not user-authored work.

## Self-Review

Spec coverage:

- One pipeline across dialects: Task 1 fixes reader probe compatibility; Task 3 wires BigQuery and Snowflake into the CLI local adapter path.
- Unified reader interface: Task 1 makes every reader return the probe result shape consumed by the stager.
- Doctor command severity: Task 4 implements the spec's downgrade of low `pg_stat_statements.max` from warning to informational note.
- Hard cutover and old-code deletion: Task 5 keeps the no-old-code grep in verification.
- Search surfaces, skills, evidence projection, wiki pattern pages, and old skill deletion are already implemented by earlier plans and intentionally unchanged here.
- Postgres example smoke/docs are outside this plan because they are documentation/acceptance assets, not cross-dialect adapter plumbing. The next plan should update `examples/postgres-historic/scripts/smoke.sh`, `examples/postgres-historic/README.md`, `examples/README.md`, and `scripts/examples-docs.test.mjs` from legacy baseline/delta/reset assertions to unified `manifest.json`, `tables/*.json`, `patterns-input.json`, and no-WorkUnit idempotency assertions.

Plan-quality scan:

- No unresolved marker text from the forbidden-pattern list is present.
- Every code-changing task names exact files, includes concrete test snippets or replacement blocks, and specifies commands plus expected outcomes.

Type consistency:

- `HistoricSqlProbeResult.info` is optional for the generic reader interface.
- `PostgresPgssProbeResult.info` is required because the doctor consumes Postgres-specific info notes.
- `DefaultLocalIngestAdaptersOptions.historicSql.reader` and `.queryClient` align with `HistoricSqlSourceAdapterDeps`.
- CLI query-client helpers return the `headers`, `rows`, and `totalRows` shape already consumed by BigQuery and Snowflake historic-SQL readers.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-cross-dialect-readiness.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
