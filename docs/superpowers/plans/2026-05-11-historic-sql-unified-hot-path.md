# Historic SQL Unified Hot Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic historic-SQL hot path that reads warehouse-aggregated query templates, batch-parses them once, and writes stable table-bucket and pattern-input staged artifacts.

**Architecture:** This slice adds the unified reader/stager contracts from the historic-SQL redesign without doing the LLM cold path or projection work. Dialect-specific SQL lives in reader classes; shared TypeScript code filters, batch-parses, bucketizes, and writes `manifest.json`, `tables/*.json`, and `patterns-input.json`. The existing production adapter remains on the legacy path until the follow-up skills/projection cutover can switch it without loading missing skills.

**Tech Stack:** TypeScript ESM/NodeNext, zod 4, Vitest, `SqlAnalysisPort.analyzeBatch()`, warehouse query clients.

---

## Starting Point

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Plans found that are based on this spec:

- `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md`
- `docs/superpowers/plans/2026-05-11-historic-sql-search-enrichment.md`

Implemented status from this worktree:

- `2026-05-11-historic-sql-foundations.md` is implemented. Evidence: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`, `SemanticLayerSource.usage` in `packages/context/src/sl/types.ts`, `mergeUsagePreservingExternal()` in `packages/context/src/ingest/adapters/live-database/manifest.ts`, `SqlAnalysisPort.analyzeBatch()` in `packages/context/src/sql-analysis/ports.ts`, and `/sql/analyze-batch` in `python/ktx-daemon/src/ktx_daemon/app.py`.
- `2026-05-11-historic-sql-search-enrichment.md` is implemented. Evidence: `buildSemanticLayerSourceSearchText()` indexes `source.usage` in `packages/context/src/sl/sl-search.service.ts`, SQLite FTS returns `snippet()` in `packages/context/src/sl/sqlite-sl-sources-index.ts`, and local/MCP list results expose `frequencyTier` and `snippet` in `packages/context/src/sl/local-sl.ts` and `packages/context/src/mcp/local-project-ports.ts`.

Still not implemented:

- `packages/context/src/ingest/adapters/historic-sql/stage.ts` still calls `SqlAnalysisPort.analyzeForFingerprint()` per raw query and emits `templates/*/{metadata.json,page.md,usage.json}`.
- `packages/context/src/ingest/adapters/historic-sql/stage-pgss.ts` still owns Postgres baseline-diff state and writes `.ktx/cache/historic-sql/*/pgss-baseline.json`.
- `packages/context/src/ingest/adapters/historic-sql/chunk.ts` still emits one WorkUnit per template page for `historic_sql_ingest`.
- `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts` still advertises `historic_sql_ingest` and `historic_sql_curator`.
- Old code strings still exist: `stagePgStatStatementsTemplates`, `expandCategoricalTemplates`, `classifySlot`, and `pgss-baseline`.

This plan covers the deterministic hot path from the spec: unified aggregate contracts, aggregate readers, batch parsing, table bucketing, pattern input staging, and a new chunker for the new staged shape. It does not switch `HistoricSqlSourceAdapter` to the new WorkUnits; the cutover plan must create `historic_sql_table_digest`, `historic_sql_patterns`, and projection before changing production `skillNames`.

## File Structure

Create:

- `packages/context/src/ingest/adapters/historic-sql/types.test.ts`
  Locks the new public zod contracts and the one-release `minCalls` to `minExecutions` config alias.
- `packages/context/src/ingest/adapters/historic-sql/buckets.ts`
  Owns deterministic bucket labels and frequency-tier helpers used by staging.
- `packages/context/src/ingest/adapters/historic-sql/buckets.test.ts`
  Locks stable bucket boundaries so small numeric drift does not churn staged files.
- `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
  Implements the new deterministic stager behind `stageHistoricSqlAggregatedSnapshot()`.
- `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
  Tests batch parsing, parse failures, service-account filtering, per-table bucketing, and `patterns-input.json`.
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`
  Implements the new Postgres aggregate reader over `pg_stat_statements`.
- `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`
  Tests the aggregate PGSS query shape, probe warnings, and row mapping.
- `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
  Implements the new chunker for `tables/*.json` plus `patterns-input.json`.
- `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`
  Tests table WorkUnits, the patterns WorkUnit, diff filtering, eviction, and scope detection.

Modify:

- `packages/context/src/ingest/adapters/historic-sql/types.ts`
  Adds aggregate input, staged artifact, reader, and manifest schemas. Keeps legacy exported types until adapter cutover, but marks the new contracts as the target API for the next slice.
- `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts`
  Adds `fetchAggregated()` while retaining the existing `fetch()` until the adapter cutover.
- `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts`
  Adds aggregate-query tests.
- `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts`
  Adds `fetchAggregated()` while retaining the existing `fetch()` until the adapter cutover.
- `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts`
  Adds aggregate-query tests.
- `packages/context/src/ingest/index.ts`
  Exports the new hot-path contracts and helpers.
- `packages/context/src/package-exports.test.ts`
  Asserts the new exports exist without removing old exports in this slice.

Do not modify in this plan:

- `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.ts`
- `packages/context/skills/historic_sql_ingest/SKILL.md`
- `packages/context/skills/historic_sql_curator/SKILL.md`
- `packages/context/src/ingest/ingest-runtime-assets.test.ts`

Those files change in the cutover/projection plan after the replacement skills exist.

## Task 1: Add Unified Contracts

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/types.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/types.ts`
- Modify: `packages/context/src/ingest/index.ts`
- Modify: `packages/context/src/package-exports.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `packages/context/src/ingest/adapters/historic-sql/types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  aggregatedTemplateSchema,
  historicSqlUnifiedPullConfigSchema,
  stagedManifestSchema,
  stagedPatternsInputSchema,
  stagedTableInputSchema,
} from './types.js';

describe('historic-sql unified contracts', () => {
  it('parses minExecutions and accepts minCalls as a one-release alias', () => {
    expect(historicSqlUnifiedPullConfigSchema.parse({ dialect: 'postgres', minExecutions: 9 })).toMatchObject({
      dialect: 'postgres',
      minExecutions: 9,
      windowDays: 90,
      concurrency: 12,
      redactionPatterns: [],
      staleArchiveAfterDays: 90,
    });

    expect(historicSqlUnifiedPullConfigSchema.parse({ dialect: 'postgres', minCalls: 7 }).minExecutions).toBe(7);
  });

  it('validates aggregate templates from warehouse readers', () => {
    const parsed = aggregatedTemplateSchema.parse({
      templateId: 'pg:123',
      canonicalSql: 'select status, count(*) from public.orders group by status',
      dialect: 'postgres',
      stats: {
        executions: 42,
        distinctUsers: 3,
        firstSeen: '2026-05-01T00:00:00.000Z',
        lastSeen: '2026-05-11T00:00:00.000Z',
        p50RuntimeMs: 12.5,
        p95RuntimeMs: 40,
        errorRate: 0,
        rowsProduced: 100,
      },
      topUsers: [{ user: 'analyst', executions: 40 }],
    });

    expect(parsed.templateId).toBe('pg:123');
    expect(parsed.topUsers).toEqual([{ user: 'analyst', executions: 40 }]);
  });

  it('validates staged table, patterns, and manifest artifacts', () => {
    expect(
      stagedTableInputSchema.parse({
        table: 'public.orders',
        stats: {
          executionsBucket: '10-100',
          distinctUsersBucket: '2-5',
          errorRateBucket: 'none',
          p95RuntimeBucket: '<100ms',
          recencyBucket: 'current',
        },
        columnsByClause: {
          select: [['status', 'high']],
          where: [['created_at', 'mid']],
        },
        observedJoins: [{ withTable: 'public.customers', on: ['customer_id'], freq: 'high' }],
        topTemplates: [{ id: 'pg:123', canonicalSql: 'select * from public.orders', topUsers: [{ user: 'analyst' }] }],
      }).table,
    ).toBe('public.orders');

    expect(
      stagedPatternsInputSchema.parse({
        templates: [
          {
            id: 'pg:123',
            canonicalSql: 'select * from public.orders',
            tablesTouched: ['public.orders'],
            executionsBucket: '10-100',
            distinctUsersBucket: '2-5',
            dialect: 'postgres',
          },
        ],
      }).templates,
    ).toHaveLength(1);

    expect(
      stagedManifestSchema.parse({
        source: 'historic-sql',
        connectionId: 'warehouse',
        dialect: 'postgres',
        fetchedAt: '2026-05-11T00:00:00.000Z',
        windowStart: '2026-02-10T00:00:00.000Z',
        windowEnd: '2026-05-11T00:00:00.000Z',
        snapshotRowCount: 2,
        touchedTableCount: 1,
        parseFailures: 1,
        warnings: ['parse_failed:bad'],
        probeWarnings: [],
      }).parseFailures,
    ).toBe(1);
  });
});
```

Add these assertions near the historic-SQL export assertions in `packages/context/src/package-exports.test.ts`:

```typescript
    expect(ingest.historicSqlUnifiedPullConfigSchema).toBeDefined();
    expect(ingest.aggregatedTemplateSchema).toBeDefined();
    expect(ingest.stagedTableInputSchema).toBeDefined();
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/types.test.ts src/package-exports.test.ts
```

Expected: FAIL with missing exports for `historicSqlUnifiedPullConfigSchema`, `aggregatedTemplateSchema`, and `stagedTableInputSchema`.

- [ ] **Step 3: Add the new schemas and reader contracts**

Insert this block immediately after the existing `historicSqlPullConfigSchema` definition in `packages/context/src/ingest/adapters/historic-sql/types.ts`. Keep `historicSqlPullConfigSchema` and `HistoricSqlPullConfig` unchanged in this plan because the current production adapter still reads `lastSuccessfulCursor`, `maxTemplatesPerRun`, and `minCalls`.

```typescript
const filterModeSchema = z.enum(['exclude', 'include', 'mark-only']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const historicSqlUnifiedPullConfigSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }
  if (value.minExecutions === undefined && typeof value.minCalls === 'number') {
    return { ...value, minExecutions: value.minCalls };
  }
  return value;
}, z.object({
  dialect: historicSqlDialectSchema,
  windowDays: z.number().int().positive().default(90),
  minExecutions: z.number().int().nonnegative().default(5),
  concurrency: z.number().int().positive().default(12),
  filters: z.object({
    serviceAccounts: z.object({
      patterns: z.array(z.string()).default([]),
      mode: filterModeSchema.default('exclude'),
    }).optional(),
    orchestrators: z.object({
      mode: filterModeSchema.default('mark-only'),
    }).optional(),
    dropTrivialProbes: z.boolean().default(true),
    dropFailedBelow: z.object({
      errorRate: z.number().min(0).max(1),
      executions: z.number().int().nonnegative(),
    }).optional(),
  }).default({}),
  redactionPatterns: z.array(z.string()).default([]),
  staleArchiveAfterDays: z.number().int().positive().default(90),
}));

export type HistoricSqlUnifiedPullConfig = z.infer<typeof historicSqlUnifiedPullConfigSchema>;

export const aggregatedTemplateSchema = z.object({
  templateId: z.string().min(1),
  canonicalSql: z.string().min(1),
  dialect: historicSqlDialectSchema,
  stats: z.object({
    executions: z.number().int().nonnegative(),
    distinctUsers: z.number().int().nonnegative(),
    firstSeen: z.iso.datetime(),
    lastSeen: z.iso.datetime(),
    p50RuntimeMs: z.number().nonnegative().nullable(),
    p95RuntimeMs: z.number().nonnegative().nullable(),
    errorRate: z.number().min(0).max(1),
    rowsProduced: z.number().int().nonnegative().nullable(),
  }),
  topUsers: z.array(z.object({
    user: z.string().nullable(),
    executions: z.number().int().nonnegative(),
  })).default([]),
});
export type AggregatedTemplate = z.infer<typeof aggregatedTemplateSchema>;

export const stagedTableInputSchema = z.object({
  table: z.string().min(1),
  stats: z.object({
    executionsBucket: z.string(),
    distinctUsersBucket: z.string(),
    errorRateBucket: z.string(),
    p95RuntimeBucket: z.string(),
    recencyBucket: z.string(),
  }),
  columnsByClause: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))),
  observedJoins: z.array(z.object({
    withTable: z.string(),
    on: z.array(z.string()),
    freq: z.string(),
  })),
  topTemplates: z.array(z.object({
    id: z.string(),
    canonicalSql: z.string(),
    topUsers: z.array(z.object({ user: z.string().nullable() })),
  })),
});
export type StagedTableInput = z.infer<typeof stagedTableInputSchema>;

export const stagedPatternsInputSchema = z.object({
  templates: z.array(z.object({
    id: z.string(),
    canonicalSql: z.string(),
    tablesTouched: z.array(z.string()),
    executionsBucket: z.string(),
    distinctUsersBucket: z.string(),
    dialect: historicSqlDialectSchema,
  })),
});
export type StagedPatternsInput = z.infer<typeof stagedPatternsInputSchema>;

export const stagedManifestSchema = z.object({
  source: z.literal(HISTORIC_SQL_SOURCE_KEY),
  connectionId: z.string().min(1),
  dialect: historicSqlDialectSchema,
  fetchedAt: z.iso.datetime(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  snapshotRowCount: z.number().int().nonnegative(),
  touchedTableCount: z.number().int().nonnegative(),
  parseFailures: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  probeWarnings: z.array(z.string()),
});
export type StagedManifest = z.infer<typeof stagedManifestSchema>;

export interface HistoricSqlProbeResult {
  warnings: string[];
}

export interface HistoricSqlReader {
  probe(client: unknown): Promise<HistoricSqlProbeResult>;
  fetchAggregated(
    client: unknown,
    window: HistoricSqlTimeWindow,
    config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate>;
}
```

- [ ] **Step 4: Export the new contracts**

In `packages/context/src/ingest/index.ts`, add exports for the new types and schemas:

```typescript
export type {
  AggregatedTemplate,
  HistoricSqlProbeResult,
  HistoricSqlReader,
  HistoricSqlUnifiedPullConfig,
  StagedManifest,
  StagedPatternsInput,
  StagedTableInput,
} from './adapters/historic-sql/types.js';
export {
  aggregatedTemplateSchema,
  historicSqlUnifiedPullConfigSchema,
  stagedManifestSchema,
  stagedPatternsInputSchema,
  stagedTableInputSchema,
} from './adapters/historic-sql/types.js';
```

- [ ] **Step 5: Run the contract tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/types.test.ts src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/types.ts packages/context/src/ingest/adapters/historic-sql/types.test.ts packages/context/src/ingest/index.ts packages/context/src/package-exports.test.ts
git commit -m "feat: add historic sql unified contracts"
```

## Task 2: Add Stable Bucket Helpers

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/buckets.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/buckets.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write failing bucket tests**

Create `packages/context/src/ingest/adapters/historic-sql/buckets.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  bucketDistinctUsers,
  bucketErrorRate,
  bucketExecutions,
  bucketFrequency,
  bucketP95Runtime,
  bucketRecency,
} from './buckets.js';

describe('historic-sql bucket helpers', () => {
  it('uses stable execution buckets', () => {
    expect([0, 9, 10, 99, 100, 999, 1000, 4999, 5000, 49999, 50000].map(bucketExecutions)).toEqual([
      '<10',
      '<10',
      '10-100',
      '10-100',
      '100-1k',
      '100-1k',
      '1k-5k',
      '1k-5k',
      '5k-50k',
      '5k-50k',
      '>50k',
    ]);
  });

  it('uses stable distinct-user, error-rate, runtime, and recency buckets', () => {
    expect([0, 1, 2, 5, 6, 10, 11].map(bucketDistinctUsers)).toEqual([
      '0',
      '1',
      '2-5',
      '2-5',
      '5-10',
      '5-10',
      '>10',
    ]);
    expect([0, 0.01, 0.05, 0.2].map(bucketErrorRate)).toEqual(['none', 'low', 'low', 'high']);
    expect([null, 99, 100, 999, 1000, 9999, 10000].map(bucketP95Runtime)).toEqual([
      'unknown',
      '<100ms',
      '100ms-1s',
      '100ms-1s',
      '1s-10s',
      '1s-10s',
      '>10s',
    ]);
    expect(bucketRecency('2026-05-11T00:00:00.000Z', new Date('2026-05-11T12:00:00.000Z'))).toBe('current');
    expect(bucketRecency('2026-04-20T00:00:00.000Z', new Date('2026-05-11T12:00:00.000Z'))).toBe('recent');
    expect(bucketRecency('2026-01-01T00:00:00.000Z', new Date('2026-05-11T12:00:00.000Z'))).toBe('stale');
  });

  it('maps frequency counts to high, mid, and low labels', () => {
    expect(bucketFrequency(80, 100)).toBe('high');
    expect(bucketFrequency(20, 100)).toBe('mid');
    expect(bucketFrequency(1, 100)).toBe('low');
    expect(bucketFrequency(0, 0)).toBe('low');
  });
});
```

- [ ] **Step 2: Run the bucket test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/buckets.test.ts
```

Expected: FAIL because `buckets.js` does not exist.

- [ ] **Step 3: Add the bucket helper implementation**

Create `packages/context/src/ingest/adapters/historic-sql/buckets.ts`:

```typescript
export function bucketExecutions(value: number): string {
  if (value < 10) return '<10';
  if (value < 100) return '10-100';
  if (value < 1000) return '100-1k';
  if (value < 5000) return '1k-5k';
  if (value < 50000) return '5k-50k';
  return '>50k';
}

export function bucketDistinctUsers(value: number): string {
  if (value <= 0) return '0';
  if (value === 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 10) return '5-10';
  return '>10';
}

export function bucketErrorRate(value: number): string {
  if (value <= 0) return 'none';
  if (value < 0.1) return 'low';
  return 'high';
}

export function bucketP95Runtime(value: number | null): string {
  if (value === null) return 'unknown';
  if (value < 100) return '<100ms';
  if (value < 1000) return '100ms-1s';
  if (value < 10000) return '1s-10s';
  return '>10s';
}

export function bucketRecency(lastSeen: string, now: Date): string {
  const parsed = new Date(lastSeen);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown';
  }
  const ageDays = (now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays <= 7) return 'current';
  if (ageDays <= 45) return 'recent';
  return 'stale';
}

export function bucketFrequency(count: number, total: number): 'high' | 'mid' | 'low' {
  if (total <= 0 || count <= 0) return 'low';
  const ratio = count / total;
  if (ratio >= 0.5) return 'high';
  if (ratio >= 0.1) return 'mid';
  return 'low';
}
```

- [ ] **Step 4: Run the bucket test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/buckets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Export bucket helpers**

In `packages/context/src/ingest/index.ts`, add:

```typescript
export { bucketDistinctUsers, bucketErrorRate, bucketExecutions, bucketP95Runtime, bucketRecency } from './adapters/historic-sql/buckets.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/buckets.ts packages/context/src/ingest/adapters/historic-sql/buckets.test.ts packages/context/src/ingest/index.ts
git commit -m "feat: add historic sql bucket helpers"
```

## Task 3: Stage Aggregated Snapshots

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write failing staged-artifact tests**

Create `packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts`:

```typescript
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import { stageHistoricSqlAggregatedSnapshot } from './stage-unified.js';
import type { AggregatedTemplate, HistoricSqlReader } from './types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-unified-stage-'));
}

async function readJson<T>(root: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relPath), 'utf-8')) as T;
}

function aggregate(overrides: Partial<AggregatedTemplate> & { templateId: string; canonicalSql: string }): AggregatedTemplate {
  return {
    templateId: overrides.templateId,
    canonicalSql: overrides.canonicalSql,
    dialect: overrides.dialect ?? 'postgres',
    stats: overrides.stats ?? {
      executions: 42,
      distinctUsers: 3,
      firstSeen: '2026-05-01T00:00:00.000Z',
      lastSeen: '2026-05-11T00:00:00.000Z',
      p50RuntimeMs: 20,
      p95RuntimeMs: 80,
      errorRate: 0,
      rowsProduced: 100,
    },
    topUsers: overrides.topUsers ?? [{ user: 'analyst', executions: 40 }],
  };
}

describe('stageHistoricSqlAggregatedSnapshot', () => {
  it('batch parses templates and writes stable table and patterns artifacts', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: ['pg_stat_statements.max is low; aggregation still proceeds'] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'orders-by-status',
          canonicalSql: 'select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id where o.created_at >= $1 group by o.status',
        });
        yield aggregate({
          templateId: 'service-account-only',
          canonicalSql: 'select * from public.orders where id = $1',
          stats: {
            executions: 20,
            distinctUsers: 1,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 5,
            p95RuntimeMs: 10,
            errorRate: 0,
            rowsProduced: 1,
          },
          topUsers: [{ user: 'svc_loader', executions: 20 }],
        });
        yield aggregate({
          templateId: 'bad-parse',
          canonicalSql: 'select broken from',
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'orders-by-status',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: ['status'],
              where: ['created_at'],
              join: ['customer_id'],
              groupBy: ['status'],
            },
          },
        ],
        ['bad-parse', { tablesTouched: [], columnsByClause: {}, error: 'parse failed' }],
      ])),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        filters: {
          serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
        },
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledTimes(1);
    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledWith(
      [
        {
          id: 'orders-by-status',
          sql: 'select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id where o.created_at >= $1 group by o.status',
        },
        { id: 'bad-parse', sql: 'select broken from' },
      ],
      'postgres',
    );

    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['public.customers.json', 'public.orders.json']);

    const manifest = await readJson<Record<string, unknown>>(stagedDir, 'manifest.json');
    expect(manifest).toMatchObject({
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      snapshotRowCount: 3,
      touchedTableCount: 2,
      parseFailures: 1,
      warnings: ['parse_failed:bad-parse'],
      probeWarnings: ['pg_stat_statements.max is low; aggregation still proceeds'],
    });

    const orders = await readJson<Record<string, any>>(stagedDir, 'tables/public.orders.json');
    expect(orders).toMatchObject({
      table: 'public.orders',
      stats: {
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        errorRateBucket: 'none',
        p95RuntimeBucket: '<100ms',
        recencyBucket: 'current',
      },
      columnsByClause: {
        select: [['status', 'high']],
        where: [['created_at', 'high']],
        join: [['customer_id', 'high']],
        groupBy: [['status', 'high']],
      },
      observedJoins: [{ withTable: 'public.customers', on: ['customer_id'], freq: 'high' }],
      topTemplates: [
        {
          id: 'orders-by-status',
          topUsers: [{ user: 'analyst' }],
        },
      ],
    });
    expect(orders.topTemplates[0].canonicalSql).toContain('group by o.status');

    const patterns = await readJson<Record<string, any>>(stagedDir, 'patterns-input.json');
    expect(patterns.templates).toEqual([
      {
        id: 'orders-by-status',
        canonicalSql: expect.stringContaining('public.orders'),
        tablesTouched: ['public.customers', 'public.orders'],
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        dialect: 'postgres',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the stage test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: FAIL because `stage-unified.js` does not exist.

- [ ] **Step 3: Add the unified stager**

Create `packages/context/src/ingest/adapters/historic-sql/stage-unified.ts` with these exported shapes and helpers:

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import {
  bucketDistinctUsers,
  bucketErrorRate,
  bucketExecutions,
  bucketFrequency,
  bucketP95Runtime,
  bucketRecency,
} from './buckets.js';
import {
  HISTORIC_SQL_SOURCE_KEY,
  aggregatedTemplateSchema,
  historicSqlUnifiedPullConfigSchema,
  type AggregatedTemplate,
  type HistoricSqlReader,
  type HistoricSqlUnifiedPullConfig,
  type StagedPatternsInput,
  type StagedTableInput,
} from './types.js';

interface StageHistoricSqlAggregatedSnapshotInput {
  stagedDir: string;
  connectionId: string;
  queryClient: unknown;
  reader: HistoricSqlReader;
  sqlAnalysis: SqlAnalysisPort;
  pullConfig: unknown;
  now?: Date;
}

interface ParsedTemplate {
  template: AggregatedTemplate;
  tablesTouched: string[];
  columnsByClause: Record<string, string[]>;
}

interface TableAccumulator {
  table: string;
  executions: number;
  distinctUsers: number;
  errorRateNumerator: number;
  p95RuntimeMs: number | null;
  lastSeen: string;
  columnsByClause: Map<string, Map<string, number>>;
  observedJoins: Map<string, Map<string, number>>;
  topTemplates: AggregatedTemplate[];
}

const TRIVIAL_SQL_RE = /^\s*SELECT\s+(1|NOW\(\)|CURRENT_TIMESTAMP|VERSION\(\))\s*;?\s*$/i;
const NOISE_PREFIX_RE = /^\s*(SHOW|DESCRIBE|DESC|EXPLAIN|USE|SET)\b/i;
const SYSTEM_TABLE_RE = /\b(INFORMATION_SCHEMA|SNOWFLAKE\.ACCOUNT_USAGE|pg_|system\.)/i;
const ORCHESTRATOR_RE = /\b(dbt|looker|metabase)\b/i;

function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  return mkdir(dirname(target), { recursive: true }).then(() =>
    writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8'),
  );
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern));
}

function matchesAny(value: string | null, patterns: RegExp[]): boolean {
  return !!value && patterns.some((pattern) => pattern.test(value));
}

function shouldDropBySql(sql: string, config: HistoricSqlUnifiedPullConfig): boolean {
  if (NOISE_PREFIX_RE.test(sql) || SYSTEM_TABLE_RE.test(sql)) return true;
  if (config.filters.dropTrivialProbes !== false && TRIVIAL_SQL_RE.test(sql)) return true;
  return false;
}

function shouldDropByUsers(template: AggregatedTemplate, config: HistoricSqlUnifiedPullConfig): boolean {
  const service = config.filters.serviceAccounts;
  if (!service || service.mode === 'mark-only' || service.patterns.length === 0) return false;
  const patterns = compilePatterns(service.patterns);
  const matchingExecutions = template.topUsers
    .filter((entry) => matchesAny(entry.user, patterns))
    .reduce((sum, entry) => sum + entry.executions, 0);
  const allExecutions = template.topUsers.reduce((sum, entry) => sum + entry.executions, 0);
  const serviceOnly = allExecutions > 0 && matchingExecutions >= allExecutions;
  return service.mode === 'exclude' ? serviceOnly : !serviceOnly;
}

function shouldDropByFailure(template: AggregatedTemplate, config: HistoricSqlUnifiedPullConfig): boolean {
  const failed = config.filters.dropFailedBelow;
  return !!failed && template.stats.errorRate > failed.errorRate && template.stats.executions < failed.executions;
}

function shouldDropTemplate(template: AggregatedTemplate, config: HistoricSqlUnifiedPullConfig): boolean {
  if (shouldDropBySql(template.canonicalSql, config)) return true;
  if (shouldDropByUsers(template, config)) return true;
  if (shouldDropByFailure(template, config)) return true;
  return false;
}

function recordColumn(acc: TableAccumulator, clause: string, column: string, executions: number): void {
  const byColumn = acc.columnsByClause.get(clause) ?? new Map<string, number>();
  byColumn.set(column, (byColumn.get(column) ?? 0) + executions);
  acc.columnsByClause.set(clause, byColumn);
}

function recordJoin(acc: TableAccumulator, otherTable: string, columns: string[], executions: number): void {
  const byColumns = acc.observedJoins.get(otherTable) ?? new Map<string, number>();
  const key = [...new Set(columns)].sort().join(',');
  if (key.length > 0) {
    byColumns.set(key, (byColumns.get(key) ?? 0) + executions);
    acc.observedJoins.set(otherTable, byColumns);
  }
}

function accumulatorFor(table: string): TableAccumulator {
  return {
    table,
    executions: 0,
    distinctUsers: 0,
    errorRateNumerator: 0,
    p95RuntimeMs: null,
    lastSeen: '1970-01-01T00:00:00.000Z',
    columnsByClause: new Map(),
    observedJoins: new Map(),
    topTemplates: [],
  };
}

function addTemplate(acc: TableAccumulator, parsed: ParsedTemplate): void {
  const executions = parsed.template.stats.executions;
  acc.executions += executions;
  acc.distinctUsers = Math.max(acc.distinctUsers, parsed.template.stats.distinctUsers);
  acc.errorRateNumerator += parsed.template.stats.errorRate * executions;
  acc.p95RuntimeMs =
    acc.p95RuntimeMs === null
      ? parsed.template.stats.p95RuntimeMs
      : parsed.template.stats.p95RuntimeMs === null
        ? acc.p95RuntimeMs
        : Math.max(acc.p95RuntimeMs, parsed.template.stats.p95RuntimeMs);
  acc.lastSeen = parsed.template.stats.lastSeen > acc.lastSeen ? parsed.template.stats.lastSeen : acc.lastSeen;
  for (const [clause, columns] of Object.entries(parsed.columnsByClause)) {
    for (const column of columns) {
      recordColumn(acc, clause, column, executions);
    }
  }
  const joinColumns = parsed.columnsByClause.join ?? [];
  for (const otherTable of parsed.tablesTouched.filter((table) => table !== acc.table)) {
    recordJoin(acc, otherTable, joinColumns, executions);
  }
  acc.topTemplates.push(parsed.template);
}
```

In the same file, add the staging function:

```typescript
function toStagedTable(acc: TableAccumulator, now: Date): StagedTableInput {
  const errorRate = acc.executions > 0 ? acc.errorRateNumerator / acc.executions : 0;
  const columnsByClause = Object.fromEntries(
    [...acc.columnsByClause.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([clause, counts]) => [
        clause,
        [...counts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([column, count]) => [column, bucketFrequency(count, acc.executions)]),
      ]),
  );
  const observedJoins = [...acc.observedJoins.entries()]
    .flatMap(([withTable, byColumns]) =>
      [...byColumns.entries()].map(([columns, count]) => ({
        withTable,
        on: columns.split(',').filter(Boolean),
        freq: bucketFrequency(count, acc.executions),
      })),
    )
    .sort((left, right) => left.withTable.localeCompare(right.withTable) || left.on.join(',').localeCompare(right.on.join(',')));
  const topTemplates = [...acc.topTemplates]
    .sort((left, right) => right.stats.executions - left.stats.executions || left.templateId.localeCompare(right.templateId))
    .slice(0, 5)
    .map((template) => ({
      id: template.templateId,
      canonicalSql: template.canonicalSql,
      topUsers: template.topUsers.slice(0, 5).map((entry) => ({ user: entry.user })),
    }));

  return {
    table: acc.table,
    stats: {
      executionsBucket: bucketExecutions(acc.executions),
      distinctUsersBucket: bucketDistinctUsers(acc.distinctUsers),
      errorRateBucket: bucketErrorRate(errorRate),
      p95RuntimeBucket: bucketP95Runtime(acc.p95RuntimeMs),
      recencyBucket: bucketRecency(acc.lastSeen, now),
    },
    columnsByClause,
    observedJoins,
    topTemplates,
  };
}

function toPatternsInput(parsedTemplates: ParsedTemplate[]): StagedPatternsInput {
  return {
    templates: parsedTemplates
      .map(({ template, tablesTouched }) => ({
        id: template.templateId,
        canonicalSql: template.canonicalSql,
        tablesTouched: [...tablesTouched].sort(),
        executionsBucket: bucketExecutions(template.stats.executions),
        distinctUsersBucket: bucketDistinctUsers(template.stats.distinctUsers),
        dialect: template.dialect,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function stageHistoricSqlAggregatedSnapshot(input: StageHistoricSqlAggregatedSnapshotInput): Promise<void> {
  const config = historicSqlUnifiedPullConfigSchema.parse(input.pullConfig);
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - config.windowDays * 24 * 60 * 60 * 1000);
  const probe = await input.reader.probe(input.queryClient);
  const snapshot: AggregatedTemplate[] = [];

  for await (const row of input.reader.fetchAggregated(input.queryClient, { start: windowStart, end: now }, config)) {
    const parsed = aggregatedTemplateSchema.parse(row);
    if (!shouldDropTemplate(parsed, config)) {
      snapshot.push(parsed);
    }
  }

  const analysis = await input.sqlAnalysis.analyzeBatch(
    snapshot.map((template) => ({ id: template.templateId, sql: template.canonicalSql })),
    config.dialect,
  );
  const warnings: string[] = [];
  const parsedTemplates: ParsedTemplate[] = [];
  for (const template of snapshot) {
    const parsed = analysis.get(template.templateId);
    if (!parsed || parsed.error) {
      warnings.push(`parse_failed:${template.templateId}`);
      continue;
    }
    const tablesTouched = [...new Set(parsed.tablesTouched)].filter((table) => table.length > 0).sort();
    if (tablesTouched.length === 0) {
      continue;
    }
    parsedTemplates.push({
      template,
      tablesTouched,
      columnsByClause: Object.fromEntries(
        Object.entries(parsed.columnsByClause).map(([clause, columns]) => [clause, [...new Set(columns)].sort()]),
      ),
    });
  }

  const byTable = new Map<string, TableAccumulator>();
  for (const parsed of parsedTemplates) {
    for (const table of parsed.tablesTouched) {
      const acc = byTable.get(table) ?? accumulatorFor(table);
      addTemplate(acc, parsed);
      byTable.set(table, acc);
    }
  }

  await mkdir(input.stagedDir, { recursive: true });
  for (const [table, acc] of [...byTable.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await writeJson(input.stagedDir, `tables/${table}.json`, toStagedTable(acc, now));
  }
  await writeJson(input.stagedDir, 'patterns-input.json', toPatternsInput(parsedTemplates));
  await writeJson(input.stagedDir, 'manifest.json', {
    source: HISTORIC_SQL_SOURCE_KEY,
    connectionId: input.connectionId,
    dialect: config.dialect,
    fetchedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    snapshotRowCount: snapshot.length,
    touchedTableCount: byTable.size,
    parseFailures: warnings.filter((warning) => warning.startsWith('parse_failed:')).length,
    warnings,
    probeWarnings: probe.warnings,
  });
}
```

- [ ] **Step 4: Run the staged-artifact test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/stage-unified.test.ts
```

Expected: PASS.

- [ ] **Step 5: Export the unified stager**

In `packages/context/src/ingest/index.ts`, add:

```typescript
export { stageHistoricSqlAggregatedSnapshot } from './adapters/historic-sql/stage-unified.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/stage-unified.ts packages/context/src/ingest/adapters/historic-sql/stage-unified.test.ts packages/context/src/ingest/index.ts
git commit -m "feat: stage historic sql aggregate snapshots"
```

## Task 4: Add Aggregate Readers

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts`
- Modify: `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write failing Postgres aggregate reader tests**

Create `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { PostgresPgssReader } from './postgres-pgss-reader.js';

describe('PostgresPgssReader aggregate path', () => {
  it('aggregates pg_stat_statements rows by queryid and query', async () => {
    const executeQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_stat_statements_info')) {
        return { headers: ['stats_reset', 'dealloc'], rows: [['2026-05-01T00:00:00.000Z', 1]] };
      }
      expect(sql).toContain('GROUP BY queryid, query');
      expect(sql).toContain('HAVING SUM(calls) >= $1');
      expect(params).toEqual([5]);
      return {
        headers: ['template_id', 'canonical_sql', 'executions', 'distinct_users', 'mean_ms', 'rows_produced', 'top_users'],
        rows: [
          [
            '123',
            'select status from public.orders',
            '42',
            '3',
            '11.5',
            '100',
            JSON.stringify([{ user: 'analyst', executions: 40 }]),
          ],
        ],
      };
    });

    const reader = new PostgresPgssReader();
    const rows = [];
    for await (const row of reader.fetchAggregated(
      { executeQuery },
      { start: new Date('2026-02-10T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') },
      { dialect: 'postgres', minExecutions: 5, windowDays: 90, concurrency: 12, filters: {}, redactionPatterns: [], staleArchiveAfterDays: 90 },
    )) {
      rows.push(row);
    }

    expect(rows).toEqual([
      {
        templateId: '123',
        canonicalSql: 'select status from public.orders',
        dialect: 'postgres',
        stats: {
          executions: 42,
          distinctUsers: 3,
          firstSeen: '2026-05-01T00:00:00.000Z',
          lastSeen: '2026-05-11T00:00:00.000Z',
          p50RuntimeMs: 11.5,
          p95RuntimeMs: 11.5,
          errorRate: 0,
          rowsProduced: 100,
        },
        topUsers: [{ user: 'analyst', executions: 40 }],
      },
    ]);
  });
});
```

- [ ] **Step 2: Add failing BigQuery and Snowflake aggregate assertions**

In `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts`, add a test that constructs `new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'demo', region: 'us' })`, calls `fetchAggregated()`, and asserts the SQL contains:

```typescript
expect(sql).toContain('COUNT(*) AS executions');
expect(sql).toContain('COUNT(DISTINCT user_email) AS distinct_users');
expect(sql).toContain('GROUP BY query_hash');
expect(sql).toContain('HAVING COUNT(*) >= 5');
```

Map one returned row with headers:

```typescript
[
  'template_id',
  'canonical_sql',
  'executions',
  'distinct_users',
  'first_seen',
  'last_seen',
  'p50_ms',
  'p95_ms',
  'error_rate',
  'rows_produced',
  'top_users',
]
```

and assert `templateId`, `stats.executions`, `stats.errorRate`, and `topUsers` match the row.

In `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts`, add the same shape but assert the SQL contains:

```typescript
expect(sql).toContain('SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
expect(sql).toContain('COUNT(*) AS executions');
expect(sql).toContain('GROUP BY query_hash');
expect(sql).toContain('HAVING COUNT(*) >= 5');
```

- [ ] **Step 3: Run aggregate reader tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts
```

Expected: FAIL because `fetchAggregated()` and `postgres-pgss-reader.js` do not exist.

- [ ] **Step 4: Implement the aggregate reader methods**

Create `packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts` with the same probe behavior currently implemented in `postgres-pgss-query-history-reader.ts`: `queryClient`, `execute`, `indexByHeader`, `value`, `nullableString`, `requiredString`, `requiredFiniteNumber`, `nullableInteger`, `nullableIsoTimestamp`, `firstRow`, `extensionMissingError`, and `grantsMissingError` keep their current behavior. Add this aggregate query and row mapper:

```typescript
const AGGREGATE_SQL = `
SELECT queryid::text AS template_id,
       query AS canonical_sql,
       SUM(calls)::bigint AS executions,
       COUNT(DISTINCT userid) AS distinct_users,
       SUM(total_exec_time) / NULLIF(SUM(calls), 0) AS mean_ms,
       SUM(rows)::bigint AS rows_produced,
       COALESCE(
         json_agg(json_build_object('user', rolname, 'executions', calls) ORDER BY calls DESC)
           FILTER (WHERE userid IS NOT NULL),
         '[]'::json
       )::text AS top_users
FROM pg_stat_statements
LEFT JOIN pg_roles ON pg_roles.oid = pg_stat_statements.userid
WHERE toplevel = true
GROUP BY queryid, query
HAVING SUM(calls) >= $1
ORDER BY SUM(total_exec_time) DESC
`.trim();
```

The `fetchAggregated()` method must:

```typescript
  async *fetchAggregated(
    client: unknown,
    window: HistoricSqlTimeWindow,
    config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate> {
    const pgClient = queryClient(client);
    const statsResult = await execute(pgClient, STATS_INFO_SQL);
    const { row: statsRow, headers: statsHeaders } = firstRow(statsResult, 'stats-info');
    const firstSeen = nullableIsoTimestamp(value(statsRow, statsHeaders, 'stats_reset')) ?? window.start.toISOString();
    const result = await execute(pgClient, AGGREGATE_SQL, [config.minExecutions]);
    const indexes = indexByHeader(result.headers);
    for (const row of result.rows) {
      yield aggregatedTemplateSchema.parse({
        templateId: requiredString(value(row, indexes, 'template_id'), 'template_id'),
        canonicalSql: requiredString(value(row, indexes, 'canonical_sql'), 'canonical_sql'),
        dialect: 'postgres',
        stats: {
          executions: requiredInteger(value(row, indexes, 'executions'), 'executions'),
          distinctUsers: requiredInteger(value(row, indexes, 'distinct_users'), 'distinct_users'),
          firstSeen,
          lastSeen: window.end.toISOString(),
          p50RuntimeMs: nullableNumber(value(row, indexes, 'mean_ms')),
          p95RuntimeMs: nullableNumber(value(row, indexes, 'mean_ms')),
          errorRate: 0,
          rowsProduced: nullableInteger(value(row, indexes, 'rows_produced')),
        },
        topUsers: parseTopUsers(value(row, indexes, 'top_users')),
      });
    }
  }
```

In `packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts`, add this aggregate query inside `fetchAggregated()`:

```typescript
const sql = `
SELECT
  query_hash AS template_id,
  MIN(query) AS canonical_sql,
  COUNT(*) AS executions,
  COUNT(DISTINCT user_email) AS distinct_users,
  MIN(creation_time) AS first_seen,
  MAX(creation_time) AS last_seen,
  APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, creation_time, MILLISECOND), 100)[OFFSET(50)] AS p50_ms,
  APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, creation_time, MILLISECOND), 100)[OFFSET(95)] AS p95_ms,
  SAFE_DIVIDE(COUNTIF(error_result IS NOT NULL), COUNT(*)) AS error_rate,
  CAST(NULL AS INT64) AS rows_produced,
  TO_JSON_STRING(ARRAY_AGG(STRUCT(user_email AS user, 1 AS executions) ORDER BY creation_time DESC LIMIT 5)) AS top_users
FROM ${this.viewPath}
WHERE job_type = 'QUERY'
  AND statement_type IN ('SELECT', 'MERGE')
  AND creation_time >= ${timestampExpression(window.start)}
  AND creation_time < ${timestampExpression(window.end)}
  AND query IS NOT NULL
GROUP BY query_hash
HAVING COUNT(*) >= ${config.minExecutions}
ORDER BY executions DESC`.trim();
```

Map each result row into `aggregatedTemplateSchema.parse({ templateId, canonicalSql, dialect: 'bigquery', stats: { executions, distinctUsers, firstSeen, lastSeen, p50RuntimeMs, p95RuntimeMs, errorRate, rowsProduced }, topUsers })`, where `topUsers` is parsed from the `top_users` JSON string and invalid JSON becomes `[]`.

In `packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts`, add this aggregate query inside `fetchAggregated()`:

```typescript
const sql = `
SELECT
  query_hash AS template_id,
  MIN(query_text) AS canonical_sql,
  COUNT(*) AS executions,
  COUNT(DISTINCT user_name) AS distinct_users,
  MIN(start_time) AS first_seen,
  MAX(start_time) AS last_seen,
  APPROX_PERCENTILE(total_elapsed_time, 0.50) AS p50_ms,
  APPROX_PERCENTILE(total_elapsed_time, 0.95) AS p95_ms,
  DIV0(COUNT_IF(execution_status != 'SUCCESS'), COUNT(*)) AS error_rate,
  SUM(rows_produced) AS rows_produced,
  ARRAY_AGG(OBJECT_CONSTRUCT('user', user_name, 'executions', 1)) WITHIN GROUP (ORDER BY start_time DESC)::string AS top_users
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE query_text IS NOT NULL
  AND query_type IN ('SELECT', 'MERGE')
  AND start_time >= ${timestampLiteral(window.start)}
  AND start_time < ${timestampLiteral(window.end)}
GROUP BY query_hash
HAVING COUNT(*) >= ${config.minExecutions}
ORDER BY executions DESC`.trim();
```

Map each result row into `aggregatedTemplateSchema.parse({ templateId, canonicalSql, dialect: 'snowflake', stats: { executions, distinctUsers, firstSeen, lastSeen, p50RuntimeMs, p95RuntimeMs, errorRate, rowsProduced }, topUsers })`, where `topUsers` is parsed from the `top_users` JSON string and invalid JSON becomes `[]`. Keep the existing `fetch()` methods unchanged in this plan so current adapter behavior does not move before the skill/projection cutover.

- [ ] **Step 5: Export the new Postgres reader**

In `packages/context/src/ingest/index.ts`, add:

```typescript
export { PostgresPgssReader } from './adapters/historic-sql/postgres-pgss-reader.js';
```

- [ ] **Step 6: Run aggregate reader tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.ts packages/context/src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.ts packages/context/src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.ts packages/context/src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts packages/context/src/ingest/index.ts
git commit -m "feat: add historic sql aggregate readers"
```

## Task 5: Add Unified Chunking

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write failing unified chunk tests**

Create `packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkHistoricSqlUnifiedStagedDir, describeHistoricSqlUnifiedScope } from './chunk-unified.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-unified-chunk-'));
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeUnifiedStagedDir(root: string): Promise<void> {
  await writeJson(root, 'manifest.json', {
    source: 'historic-sql',
    connectionId: 'warehouse',
    dialect: 'postgres',
    fetchedAt: '2026-05-11T00:00:00.000Z',
    windowStart: '2026-02-10T00:00:00.000Z',
    windowEnd: '2026-05-11T00:00:00.000Z',
    snapshotRowCount: 1,
    touchedTableCount: 1,
    parseFailures: 0,
    warnings: [],
    probeWarnings: [],
  });
  await writeJson(root, 'tables/public.orders.json', {
    table: 'public.orders',
    stats: {
      executionsBucket: '10-100',
      distinctUsersBucket: '2-5',
      errorRateBucket: 'none',
      p95RuntimeBucket: '<100ms',
      recencyBucket: 'current',
    },
    columnsByClause: { select: [['status', 'high']] },
    observedJoins: [],
    topTemplates: [{ id: 'orders', canonicalSql: 'select * from public.orders', topUsers: [{ user: 'analyst' }] }],
  });
  await writeJson(root, 'patterns-input.json', {
    templates: [
      {
        id: 'orders',
        canonicalSql: 'select * from public.orders',
        tablesTouched: ['public.orders'],
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        dialect: 'postgres',
      },
    ],
  });
}

describe('chunkHistoricSqlUnifiedStagedDir', () => {
  it('emits one table WorkUnit plus one patterns WorkUnit', async () => {
    const stagedDir = await tempDir();
    await writeUnifiedStagedDir(stagedDir);

    const result = await chunkHistoricSqlUnifiedStagedDir(stagedDir);

    expect(result.workUnits).toEqual([
      expect.objectContaining({
        unitKey: 'historic-sql-table-public-orders',
        displayLabel: 'Historic SQL usage: public.orders',
        rawFiles: ['tables/public.orders.json'],
        dependencyPaths: ['manifest.json'],
        notes: expect.stringContaining('historic_sql_table_digest'),
      }),
      expect.objectContaining({
        unitKey: 'historic-sql-patterns',
        displayLabel: 'Historic SQL cross-table patterns',
        rawFiles: ['patterns-input.json'],
        dependencyPaths: ['manifest.json'],
        notes: expect.stringContaining('historic_sql_patterns'),
      }),
    ]);
    expect(result.reconcileNotes).toEqual(['Historic-SQL touched tables=1 parseFailures=0']);
  });

  it('respects diff sets for unchanged table and patterns files', async () => {
    const stagedDir = await tempDir();
    await writeUnifiedStagedDir(stagedDir);

    await expect(
      chunkHistoricSqlUnifiedStagedDir(stagedDir, {
        added: [],
        modified: ['tables/public.orders.json'],
        deleted: [],
        unchanged: ['manifest.json', 'patterns-input.json'],
      }),
    ).resolves.toMatchObject({
      workUnits: [expect.objectContaining({ unitKey: 'historic-sql-table-public-orders' })],
    });

    await expect(
      chunkHistoricSqlUnifiedStagedDir(stagedDir, {
        added: [],
        modified: ['patterns-input.json'],
        deleted: [],
        unchanged: ['manifest.json', 'tables/public.orders.json'],
      }),
    ).resolves.toMatchObject({
      workUnits: [expect.objectContaining({ unitKey: 'historic-sql-patterns' })],
    });
  });

  it('describes unified staged scope', async () => {
    const stagedDir = await tempDir();
    await writeUnifiedStagedDir(stagedDir);

    const scope = await describeHistoricSqlUnifiedScope(stagedDir);

    expect(scope.isPathInScope('manifest.json')).toBe(true);
    expect(scope.isPathInScope('patterns-input.json')).toBe(true);
    expect(scope.isPathInScope('tables/public.orders.json')).toBe(true);
    expect(scope.isPathInScope('templates/old/page.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the unified chunk tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/chunk-unified.test.ts
```

Expected: FAIL because `chunk-unified.js` does not exist.

- [ ] **Step 3: Add the unified chunker**

Create `packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts`:

```typescript
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, ScopeDescriptor, WorkUnit } from '../../types.js';
import { stagedManifestSchema, stagedPatternsInputSchema, stagedTableInputSchema } from './types.js';

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

async function readJson<T>(stagedDir: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(stagedDir, relPath), 'utf-8')) as T;
}

function safeUnitKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function touchedPath(path: string, touched: Set<string> | null): boolean {
  return !touched || touched.has(path);
}

export async function chunkHistoricSqlUnifiedStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const files = await walk(stagedDir);
  const manifest = stagedManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
  const touched = diffSet ? new Set([...diffSet.added, ...diffSet.modified]) : null;
  const workUnits: WorkUnit[] = [];

  for (const path of files.filter((file) => /^tables\/.+\.json$/.test(file))) {
    if (!touchedPath(path, touched)) {
      continue;
    }
    const table = stagedTableInputSchema.parse(await readJson(stagedDir, path));
    workUnits.push({
      unitKey: `historic-sql-table-${safeUnitKey(table.table)}`,
      displayLabel: `Historic SQL usage: ${table.table}`,
      rawFiles: [path],
      dependencyPaths: ['manifest.json'],
      peerFileIndex: files.filter((file) => file !== path && file !== 'manifest.json').sort(),
      notes:
        'Use historic_sql_table_digest. Read this table usage JSON and the existing semantic-layer source for the table; output only table usage evidence shaped like tableUsageOutputSchema.',
    });
  }

  if (files.includes('patterns-input.json') && touchedPath('patterns-input.json', touched)) {
    stagedPatternsInputSchema.parse(await readJson(stagedDir, 'patterns-input.json'));
    workUnits.push({
      unitKey: 'historic-sql-patterns',
      displayLabel: 'Historic SQL cross-table patterns',
      rawFiles: ['patterns-input.json'],
      dependencyPaths: ['manifest.json'],
      peerFileIndex: files.filter((file) => file !== 'patterns-input.json' && file !== 'manifest.json').sort(),
      notes:
        'Use historic_sql_patterns. Read patterns-input.json and produce cross-table pattern evidence shaped like patternsArraySchema.',
    });
  }

  const deleted = diffSet?.deleted.filter((path) => path === 'patterns-input.json' || /^tables\/.+\.json$/.test(path)).sort();
  return {
    workUnits,
    eviction: deleted && deleted.length > 0 ? { deletedRawPaths: deleted } : undefined,
    reconcileNotes: [`Historic-SQL touched tables=${manifest.touchedTableCount} parseFailures=${manifest.parseFailures}`],
    contextReport: {
      capped: false,
      warnings: [...manifest.probeWarnings, ...manifest.warnings],
    },
  };
}

export async function describeHistoricSqlUnifiedScope(stagedDir: string): Promise<ScopeDescriptor> {
  const manifest = stagedManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      connectionId: manifest.connectionId,
      dialect: manifest.dialect,
      windowStart: manifest.windowStart,
      windowEnd: manifest.windowEnd,
    }))
    .digest('hex');
  return {
    fingerprint,
    isPathInScope: (rawPath) =>
      rawPath === 'manifest.json' || rawPath === 'patterns-input.json' || /^tables\/.+\.json$/.test(rawPath),
  };
}
```

- [ ] **Step 4: Run the unified chunk tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/chunk-unified.test.ts
```

Expected: PASS.

- [ ] **Step 5: Export the unified chunker**

In `packages/context/src/ingest/index.ts`, add:

```typescript
export { chunkHistoricSqlUnifiedStagedDir, describeHistoricSqlUnifiedScope } from './adapters/historic-sql/chunk-unified.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/chunk-unified.ts packages/context/src/ingest/adapters/historic-sql/chunk-unified.test.ts packages/context/src/ingest/index.ts
git commit -m "feat: chunk historic sql unified staging"
```

## Task 6: Verify the Hot Path Slice

**Files:**
- Modify: files changed in Tasks 1-5

- [ ] **Step 1: Run focused historic-SQL tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/historic-sql/types.test.ts \
  src/ingest/adapters/historic-sql/buckets.test.ts \
  src/ingest/adapters/historic-sql/stage-unified.test.ts \
  src/ingest/adapters/historic-sql/postgres-pgss-reader.test.ts \
  src/ingest/adapters/historic-sql/bigquery-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/snowflake-query-history-reader.test.ts \
  src/ingest/adapters/historic-sql/chunk-unified.test.ts \
  src/package-exports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run type-check for the context package**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Confirm legacy production adapter was not switched**

Run:

```bash
rg -n "historic_sql_ingest|historic_sql_curator|stagePgStatStatementsTemplates" packages/context/src/ingest/adapters/historic-sql packages/context/skills packages/context/src/ingest/ingest-runtime-assets.test.ts
```

Expected: Results still include `historic-sql.adapter.ts`, the old skill files, and runtime-asset tests. This is correct for this plan because the replacement skills and projection are not present yet.

- [ ] **Step 4: Confirm new hot-path exports exist**

Run:

```bash
rg -n "stageHistoricSqlAggregatedSnapshot|chunkHistoricSqlUnifiedStagedDir|PostgresPgssReader|aggregatedTemplateSchema" packages/context/src/ingest/index.ts packages/context/src/ingest/adapters/historic-sql
```

Expected: Results include the new stager, chunker, reader, and schemas.

- [ ] **Step 5: Commit verification fixes only when verification changed files**

```bash
git status --short
```

Expected: no output. If verification forced a fix, run:

```bash
git add packages/context/src/ingest/adapters/historic-sql packages/context/src/ingest/index.ts packages/context/src/package-exports.test.ts
git commit -m "test: verify historic sql unified hot path"
```

## Follow-Up Plan Boundary

The next plan after this one should switch the production adapter only after it also creates the cold-path pieces:

- `packages/context/skills/historic_sql_table_digest/SKILL.md`
- `packages/context/skills/historic_sql_patterns/SKILL.md`
- adapter `skillNames` change from `historic_sql_ingest` to the two new skills
- `onPullSucceeded()` projection of table usage into `_schema/{shard}.yaml`
- pattern wiki page projection and slug stability
- one-time cleanup of legacy template wiki pages and PGSS baselines
- deletion of `stage-pgss.ts`, old template staging exports, and old historic-SQL skill assets

## Self-Review

Spec coverage:

- Unified aggregate reader contracts: Task 1 and Task 4.
- Trailing-window aggregate fetch shape: Task 4.
- Batch SQL parse through `SqlAnalysisPort.analyzeBatch()`: Task 3.
- Service-account, trivial query, failed-template, parse-failure, and zero-table filtering: Task 3.
- Bucketed `tables/*.json`, `patterns-input.json`, and `manifest.json`: Task 2 and Task 3.
- WorkUnits for one table file plus patterns input: Task 5.
- Hard production cutover, LLM skills, projection, wiki pages, stale handling, and legacy deletion: explicitly excluded from this plan and listed as the next plan boundary.

Placeholder scan:

- No unresolved placeholders are left in task steps.
- Every code-changing task includes concrete test code, implementation code, commands, and expected results.

Type consistency:

- `HistoricSqlUnifiedPullConfig`, `AggregatedTemplate`, `StagedTableInput`, `StagedPatternsInput`, and `StagedManifest` are defined in Task 1 and reused consistently by Tasks 3-5.
- `PostgresPgssReader`, `fetchAggregated()`, `stageHistoricSqlAggregatedSnapshot()`, and `chunkHistoricSqlUnifiedStagedDir()` names match exports and test imports.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-unified-hot-path.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
