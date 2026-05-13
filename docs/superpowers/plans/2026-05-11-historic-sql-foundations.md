# Historic SQL Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation slice for the historic SQL redesign: shared usage schemas, semantic-layer usage plumbing, scan-safe usage preservation, and batch SQL analysis across the Python daemon and TypeScript port.

**Architecture:** Keep the existing historic-SQL adapter behavior unchanged in this slice. Add the additive contracts from the redesign first so later adapter, skill, projection, and search work can depend on stable types and daemon APIs. The Python daemon owns SQL parsing through `sqlglot`; TypeScript owns HTTP mapping, semantic-layer schema acceptance, and manifest projection.

**Tech Stack:** TypeScript ESM/NodeNext, zod 4, Vitest, FastAPI, Pydantic v2, sqlglot, pytest, uv.

---

## Starting Point

Spec: `docs/superpowers/specs/2026-05-11-historic-sql-redesign-design.md`

Existing plans derived from this spec: none found. A repo search found only managed-runtime plans that mention historic-SQL smoke commands or `pg_stat_statements`; those plans are not based on the redesign spec and do not implement the redesign architecture.

Current implementation state:

- `packages/context/src/sql-analysis/ports.ts` exposes only `analyzeForFingerprint()`.
- `packages/context/src/sql-analysis/http-sql-analysis-port.ts` only calls `/api/sql/analyze-for-fingerprint`.
- `python/ktx-daemon/src/ktx_daemon/app.py` has no `/sql/analyze-batch` endpoint.
- `packages/context/src/sl/types.ts` has no `SemanticLayerSource.usage`.
- `packages/context/src/sl/schemas.ts` is strict and rejects top-level `usage`.
- `packages/context/src/sl/semantic-layer.service.ts` does not project `_schema` manifest `usage`.
- `packages/context/src/ingest/adapters/live-database/manifest.ts` does not preserve usage through live database scan rewrites.
- The old historic-SQL code path is still present (`stage-pgss.ts`, `stagePgStatStatementsTemplates`, `pgss-baseline`, slot classification, per-template wiki page staging).

This plan implements only the foundation ordering item from spec §10.3:

- Daemon `analyze-batch` endpoint.
- `SqlAnalysisPort.analyzeBatch()`.
- `SemanticLayerSource.usage`.
- `LiveDatabaseManifestTableEntry.usage`.
- `mergeUsagePreservingExternal()` plus tests.

The next plan after this one should cover search enrichment from spec §6.2.3-§6.2.5.

## File Structure

Create:

- `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`
  Owns the shared zod schemas for historic-SQL LLM outputs.
- `packages/context/src/ingest/adapters/historic-sql/skill-schemas.test.ts`
  Locks schema acceptance, JSON schema generation, and future-key tolerance.
- `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`
  Implements batch sqlglot parsing for table and clause-level column extraction.
- `python/ktx-daemon/tests/test_sql_analysis.py`
  Tests batch parser behavior without FastAPI.

Modify:

- `packages/context/src/ingest/index.ts`
  Exports the new historic-SQL skill schemas.
- `packages/context/src/sl/types.ts`
  Adds `usage?: TableUsageOutput` to `SemanticLayerSource`.
- `packages/context/src/sl/schemas.ts`
  Accepts `usage` in standalone and overlay semantic-layer source validation.
- `packages/context/src/sl/semantic-layer.service.ts`
  Projects manifest `usage` onto `SemanticLayerSource` and composes overlay usage intentionally.
- `packages/context/src/sl/semantic-layer.service.test.ts`
  Tests source schema acceptance, manifest projection, and overlay composition.
- `packages/context/src/ingest/adapters/live-database/manifest.ts`
  Adds `LiveDatabaseManifestTableEntry.usage`, existing-usage inputs, and `mergeUsagePreservingExternal()`.
- `packages/context/src/ingest/adapters/live-database/manifest.test.ts`
  Tests scan-managed usage replacement while preserving external keys.
- `packages/context/src/scan/local-enrichment-artifacts.ts`
  Loads existing manifest usage and passes it through scan manifest rebuilds.
- `packages/context/src/scan/local-enrichment-artifacts.test.ts`
  Tests that structural scan rewrites preserve existing usage.
- `python/ktx-daemon/src/ktx_daemon/app.py`
  Registers `/sql/analyze-batch`.
- `python/ktx-daemon/tests/test_app.py`
  Tests the FastAPI endpoint.
- `packages/context/src/sql-analysis/ports.ts`
  Adds batch analysis types and `SqlAnalysisPort.analyzeBatch()`.
- `packages/context/src/sql-analysis/index.ts`
  Exports the new batch analysis types.
- `packages/context/src/sql-analysis/http-sql-analysis-port.ts`
  Maps `/sql/analyze-batch` request and response payloads.
- `packages/context/src/sql-analysis/http-sql-analysis-port.test.ts`
  Tests HTTP mapping and malformed response rejection.
- `packages/cli/src/managed-python-http.test.ts`
  Verifies the managed daemon wrapper routes `analyzeBatch()`.
- Existing test files with `SqlAnalysisPort` object literals
  Add a no-op `analyzeBatch: async () => new Map()` while legacy paths still use `analyzeForFingerprint()`.

## Task 1: Add Historic SQL Skill Schemas

**Files:**
- Create: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`
- Create: `packages/context/src/ingest/adapters/historic-sql/skill-schemas.test.ts`
- Modify: `packages/context/src/ingest/index.ts`

- [ ] **Step 1: Write the failing schema tests**

Create `packages/context/src/ingest/adapters/historic-sql/skill-schemas.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  patternOutputSchema,
  patternsArraySchema,
  tableUsageOutputSchema,
} from './skill-schemas.js';

describe('historic-sql skill schemas', () => {
  it('accepts table usage output and preserves future keys', () => {
    const parsed = tableUsageOutputSchema.parse({
      narrative: 'Orders are queried for paid/refunded lifecycle analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonGroupBys: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      staleSince: null,
      analystNote: 'preserve me',
    });

    expect(parsed).toMatchObject({
      narrative: 'Orders are queried for paid/refunded lifecycle analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonGroupBys: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      staleSince: null,
      analystNote: 'preserve me',
    });
  });

  it('rejects invalid frequency tiers', () => {
    const result = tableUsageOutputSchema.safeParse({
      narrative: 'Orders are queried often.',
      frequencyTier: 'sometimes',
      commonFilters: [],
      commonJoins: [],
    });

    expect(result.success).toBe(false);
  });

  it('accepts pattern outputs used for wiki projection', () => {
    const parsed = patternsArraySchema.parse([
      {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Teams inspect order status by customer and month.',
        definitionSql: 'select status, count(*) from public.orders group by status',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['template_1', 'template_2'],
      },
    ]);

    expect(parsed[0]).toEqual({
      slug: 'order-lifecycle-analysis',
      title: 'Order Lifecycle Analysis',
      narrative: 'Teams inspect order status by customer and month.',
      definitionSql: 'select status, count(*) from public.orders group by status',
      tablesInvolved: ['public.orders', 'public.customers'],
      slRefs: ['orders', 'customers'],
      constituentTemplateIds: ['template_1', 'template_2'],
    });
  });

  it('exports zod schemas that can produce JSON schema for prompt prefixes', () => {
    const tableUsageJsonSchema = z.toJSONSchema(tableUsageOutputSchema);
    const patternJsonSchema = z.toJSONSchema(patternOutputSchema);

    expect(tableUsageJsonSchema).toMatchObject({ type: 'object' });
    expect(patternJsonSchema).toMatchObject({ type: 'object' });
  });
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/skill-schemas.test.ts
```

Expected: FAIL with an import error for `./skill-schemas.js`.

- [ ] **Step 3: Add the schema implementation**

Create `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts`:

```typescript
import { z } from 'zod';

export const tableUsageOutputSchema = z
  .object({
    narrative: z.string(),
    frequencyTier: z.enum(['high', 'mid', 'low', 'unused']),
    commonFilters: z.array(z.string()),
    commonGroupBys: z.array(z.string()).optional(),
    commonJoins: z.array(
      z.object({
        table: z.string(),
        on: z.array(z.string()),
      }),
    ),
    staleSince: z.iso.datetime().nullable().optional(),
  })
  .passthrough();
export type TableUsageOutput = z.infer<typeof tableUsageOutputSchema>;

export const patternOutputSchema = z.object({
  slug: z.string(),
  title: z.string(),
  narrative: z.string(),
  definitionSql: z.string(),
  tablesInvolved: z.array(z.string()),
  slRefs: z.array(z.string()),
  constituentTemplateIds: z.array(z.string()),
});
export type PatternOutput = z.infer<typeof patternOutputSchema>;

export const patternsArraySchema = z.array(patternOutputSchema);
```

- [ ] **Step 4: Export the schemas from the ingest barrel**

Add this export block to `packages/context/src/ingest/index.ts` near the other historic-SQL exports:

```typescript
export {
  patternOutputSchema,
  patternsArraySchema,
  tableUsageOutputSchema,
} from './adapters/historic-sql/skill-schemas.js';
export type {
  PatternOutput,
  TableUsageOutput,
} from './adapters/historic-sql/skill-schemas.js';
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/skill-schemas.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts packages/context/src/ingest/adapters/historic-sql/skill-schemas.test.ts packages/context/src/ingest/index.ts
git commit -m "feat: add historic sql skill schemas"
```

## Task 2: Add `usage` to Semantic Layer Sources

**Files:**
- Modify: `packages/context/src/sl/types.ts`
- Modify: `packages/context/src/sl/schemas.ts`
- Modify: `packages/context/src/sl/semantic-layer.service.ts`
- Test: `packages/context/src/sl/semantic-layer.service.test.ts`

- [ ] **Step 1: Write failing semantic-layer usage tests**

In `packages/context/src/sl/semantic-layer.service.test.ts`, extend the import from `./semantic-layer.service.js`:

```typescript
import {
  composeOverlay,
  enrichColumnsFromManifest,
  findDanglingSegmentRefs,
  projectManifestEntry,
  SemanticLayerService,
} from './semantic-layer.service.js';
```

Add this test inside `describe('composeOverlay', ...)` after the descriptions test:

```typescript
  it('replaces manifest usage only when an overlay explicitly provides usage', () => {
    const baseWithUsage: SemanticLayerSource = {
      ...baseTable,
      usage: {
        narrative: 'Orders are commonly queried by lifecycle status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      },
    };

    expect(composeOverlay(baseWithUsage, { name: 'fct_labs', measures: [] }).usage).toEqual(baseWithUsage.usage);

    const composed = composeOverlay(baseWithUsage, {
      name: 'fct_labs',
      usage: {
        narrative: 'Overlay-curated usage note.',
        frequencyTier: 'mid',
        commonFilters: ['created_at'],
        commonGroupBys: ['created_at'],
        commonJoins: [],
      },
    });

    expect(composed.usage).toEqual({
      narrative: 'Overlay-curated usage note.',
      frequencyTier: 'mid',
      commonFilters: ['created_at'],
      commonGroupBys: ['created_at'],
      commonJoins: [],
    });
  });
```

Add this test inside `describe('sourceDefinitionSchema', ...)`:

```typescript
  it('accepts historic SQL usage on standalone sources', () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'orders',
      table: 'public.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'string' }],
      joins: [],
      measures: [],
      usage: {
        narrative: 'Orders are queried for fulfillment and revenue analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        externalOwner: 'analytics',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.usage).toMatchObject({
      narrative: 'Orders are queried for fulfillment and revenue analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      externalOwner: 'analytics',
    });
  });
```

Add a new describe block before `describe('findManifestEntryByTableRef', ...)`:

```typescript
describe('projectManifestEntry', () => {
  it('projects manifest usage onto the semantic-layer source', () => {
    const source = projectManifestEntry('orders', {
      table: 'public.orders',
      usage: {
        narrative: 'Orders are frequently filtered by status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      },
      columns: [
        { name: 'id', type: 'string', pk: true },
        { name: 'status', type: 'string' },
      ],
    });

    expect(source.usage).toEqual({
      narrative: 'Orders are frequently filtered by status.',
      frequencyTier: 'high',
      commonFilters: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
    });
  });
});
```

- [ ] **Step 2: Run the semantic-layer tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/semantic-layer.service.test.ts
```

Expected: FAIL because `usage` is rejected by strict schemas and not projected from manifest entries.

- [ ] **Step 3: Add `usage` to the TypeScript source type**

In `packages/context/src/sl/types.ts`, add this import at the top:

```typescript
import type { TableUsageOutput } from '../ingest/adapters/historic-sql/skill-schemas.js';
```

Add this field to `SemanticLayerSource` after `freshness`:

```typescript
  usage?: TableUsageOutput;
```

- [ ] **Step 4: Add `usage` to zod validation**

In `packages/context/src/sl/schemas.ts`, add this import after the existing zod import:

```typescript
import { tableUsageOutputSchema } from '../ingest/adapters/historic-sql/skill-schemas.js';
```

Add this field to `sourceDefinitionSchema` near `freshness`:

```typescript
    usage: tableUsageOutputSchema.optional(),
```

Add this field to `sourceOverlaySchema` near `default_time_dimension`:

```typescript
    usage: tableUsageOutputSchema.optional(),
```

- [ ] **Step 5: Project and compose usage intentionally**

In `packages/context/src/sl/semantic-layer.service.ts`, add this type import:

```typescript
import type { TableUsageOutput } from '../ingest/adapters/historic-sql/skill-schemas.js';
```

Add this field to `ManifestTableEntry`:

```typescript
  usage?: TableUsageOutput;
```

In `projectManifestEntry()`, add `usage` to the returned object:

```typescript
    ...(entry.usage ? { usage: entry.usage } : {}),
```

Add `'usage'` to `COMPOSE_KNOWN_KEYS`:

```typescript
  'usage',
```

In `composeOverlay()`, add this block after the descriptions merge and before column filtering:

```typescript
  if (normalizedOverlay.usage !== undefined) {
    result.usage = normalizedOverlay.usage as SemanticLayerSource['usage'];
  }
```

- [ ] **Step 6: Run the semantic-layer tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/semantic-layer.service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/context/src/sl/types.ts packages/context/src/sl/schemas.ts packages/context/src/sl/semantic-layer.service.ts packages/context/src/sl/semantic-layer.service.test.ts
git commit -m "feat: carry historic sql usage in semantic sources"
```

## Task 3: Preserve Manifest Usage Through Scan Rewrites

**Files:**
- Modify: `packages/context/src/ingest/adapters/live-database/manifest.ts`
- Test: `packages/context/src/ingest/adapters/live-database/manifest.test.ts`
- Modify: `packages/context/src/scan/local-enrichment-artifacts.ts`
- Test: `packages/context/src/scan/local-enrichment-artifacts.test.ts`

- [ ] **Step 1: Write failing manifest-builder test**

In `packages/context/src/ingest/adapters/live-database/manifest.test.ts`, add this test inside `describe('buildLiveDatabaseManifestShards', ...)`:

```typescript
  it('preserves external usage keys while replacing historic SQL managed keys', () => {
    const existingUsage = new Map([
      [
        'orders',
        {
          narrative: 'Old generated usage narrative.',
          frequencyTier: 'low' as const,
          commonFilters: ['old_status'],
          commonJoins: [],
          ownerNote: 'Pinned analyst note',
        },
      ],
    ]);

    const result = buildLiveDatabaseManifestShards({
      connectionType: 'POSTGRESQL',
      mapColumnType: (nativeType) => nativeType.toLowerCase(),
      existingUsage,
      tables: [
        {
          name: 'orders',
          catalog: null,
          db: 'public',
          usage: {
            narrative: 'Fresh generated usage narrative.',
            frequencyTier: 'high',
            commonFilters: ['status'],
            commonGroupBys: ['created_at'],
            commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
          },
          columns: [{ name: 'id', type: 'INTEGER' }],
        },
      ],
      joins: [],
    });

    expect(shardObject(result.shards)).toEqual({
      public: {
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              ownerNote: 'Pinned analyst note',
              narrative: 'Fresh generated usage narrative.',
              frequencyTier: 'high',
              commonFilters: ['status'],
              commonGroupBys: ['created_at'],
              commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
            },
            columns: [{ name: 'id', type: 'integer' }],
          },
        },
      },
    });
  });
```

- [ ] **Step 2: Run the manifest test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/live-database/manifest.test.ts
```

Expected: FAIL because `existingUsage` and table input `usage` are not supported.

- [ ] **Step 3: Add usage types and merge helper**

In `packages/context/src/ingest/adapters/live-database/manifest.ts`, add this import at the top:

```typescript
import type { TableUsageOutput } from '../historic-sql/skill-schemas.js';
```

Add this constant after `SCAN_MANAGED_DESCRIPTION_KEYS`:

```typescript
const HISTORIC_SQL_MANAGED_USAGE_KEYS = new Set([
  'narrative',
  'frequencyTier',
  'commonFilters',
  'commonGroupBys',
  'commonJoins',
  'staleSince',
]);
```

Add `usage` to `LiveDatabaseManifestTableEntry`:

```typescript
  usage?: TableUsageOutput;
```

Add `usage` to `LiveDatabaseManifestTableData`:

```typescript
  usage?: TableUsageOutput;
```

Add `existingUsage` to `BuildLiveDatabaseManifestShardsInput`:

```typescript
  existingUsage?: Map<string, TableUsageOutput>;
```

Add this exported helper after `mergeDescriptionsPreservingExternal()`:

```typescript
export function mergeUsagePreservingExternal(
  existing: TableUsageOutput | undefined,
  incoming: TableUsageOutput | undefined,
): TableUsageOutput | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (!HISTORIC_SQL_MANAGED_USAGE_KEYS.has(key)) {
        result[key] = value;
      }
    }
  }
  if (incoming) {
    Object.assign(result, incoming);
  }
  return Object.keys(result).length > 0 ? (result as TableUsageOutput) : undefined;
}
```

In `buildLiveDatabaseManifestShards()`, add this block after table descriptions are set:

```typescript
    const usage = mergeUsagePreservingExternal(input.existingUsage?.get(table.name), table.usage);
    if (usage) {
      entry.usage = usage;
    }
```

- [ ] **Step 4: Run the manifest test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/live-database/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing scan-preservation test**

In `packages/context/src/scan/local-enrichment-artifacts.test.ts`, inside the existing structural manifest shard test, extend the seeded YAML under `orders` with this block:

```yaml
              usage:
                narrative: Orders are commonly filtered by lifecycle status.
                frequencyTier: high
                commonFilters:
                  - status
                commonJoins:
                  - table: public.customers
                    on:
                      - customer_id
                ownerNote: Preserve analyst note
```

Extend the parsed manifest type in that test:

```typescript
          usage?: Record<string, unknown>;
```

Add this assertion after the descriptions assertions:

```typescript
    expect(manifest.tables.orders.usage).toEqual({
      narrative: 'Orders are commonly filtered by lifecycle status.',
      frequencyTier: 'high',
      commonFilters: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      ownerNote: 'Preserve analyst note',
    });
```

- [ ] **Step 6: Run the scan-preservation test to verify it fails**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/scan/local-enrichment-artifacts.test.ts
```

Expected: FAIL because `loadExistingManifestState()` does not capture usage and scan rewrites drop it.

- [ ] **Step 7: Preserve usage in local enrichment artifact writes**

In `packages/context/src/scan/local-enrichment-artifacts.ts`, add `TableUsageOutput` to the ingest import:

```typescript
  type TableUsageOutput,
```

Add `usage` to `ExistingManifestState`:

```typescript
  usage: Map<string, TableUsageOutput>;
```

Initialize it in `loadExistingManifestState()`:

```typescript
  const usage = new Map<string, TableUsageOutput>();
```

Update the early catch return:

```typescript
    return { descriptions, preservedJoins, usage };
```

Inside the `for (const [tableName, entry] of Object.entries(shard.tables))` loop, after descriptions are captured, add:

```typescript
        if (entry.usage) {
          usage.set(tableName, { ...entry.usage });
        }
```

Update the final return:

```typescript
  return { descriptions, preservedJoins, usage };
```

Pass usage into `buildLiveDatabaseManifestShards()`:

```typescript
    existingUsage: existing.usage,
```

- [ ] **Step 8: Run scan-preservation test to verify it passes**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/scan/local-enrichment-artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/context/src/ingest/adapters/live-database/manifest.ts packages/context/src/ingest/adapters/live-database/manifest.test.ts packages/context/src/scan/local-enrichment-artifacts.ts packages/context/src/scan/local-enrichment-artifacts.test.ts
git commit -m "feat: preserve historic sql usage in manifest shards"
```

## Task 4: Add Python Batch SQL Analysis

**Files:**
- Create: `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`
- Create: `python/ktx-daemon/tests/test_sql_analysis.py`
- Modify: `python/ktx-daemon/src/ktx_daemon/app.py`
- Test: `python/ktx-daemon/tests/test_app.py`

- [ ] **Step 1: Write failing parser tests**

Create `python/ktx-daemon/tests/test_sql_analysis.py`:

```python
from __future__ import annotations

from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchItem,
    AnalyzeSqlBatchRequest,
    analyze_sql_batch_response,
)


def test_analyze_sql_batch_extracts_tables_and_clause_columns() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            items=[
                AnalyzeSqlBatchItem(
                    id="orders_by_customer",
                    sql=(
                        "select o.status, count(*) "
                        "from public.orders o "
                        "join public.customers c on o.customer_id = c.id "
                        "where o.created_at >= current_date - interval '30 day' "
                        "group by o.status"
                    ),
                )
            ],
            max_workers=1,
        )
    )

    result = response.results["orders_by_customer"]
    assert result.error is None
    assert result.tables_touched == ["public.orders", "public.customers"]
    assert result.columns_by_clause == {
        "select": ["status"],
        "where": ["created_at"],
        "join": ["customer_id", "id"],
        "groupBy": ["status"],
    }


def test_analyze_sql_batch_returns_per_item_parse_errors() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            items=[AnalyzeSqlBatchItem(id="broken", sql="select * from where")],
            max_workers=1,
        )
    )

    result = response.results["broken"]
    assert result.tables_touched == []
    assert result.columns_by_clause == {}
    assert result.error is not None
```

- [ ] **Step 2: Run parser tests to verify they fail**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'ktx_daemon.sql_analysis'`.

- [ ] **Step 3: Add the batch parser module**

Create `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`:

```python
from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from typing import Literal

import sqlglot
from pydantic import BaseModel, ConfigDict, Field
from sqlglot import exp

SqlAnalysisClause = Literal["select", "where", "join", "groupBy", "having", "orderBy"]


class AnalyzeSqlBatchItem(BaseModel):
    id: str
    sql: str


class AnalyzeSqlBatchRequest(BaseModel):
    dialect: str
    items: list[AnalyzeSqlBatchItem]
    max_workers: int | None = Field(default=None, ge=1, le=32)


class AnalyzeSqlBatchResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tables_touched: list[str] = Field(default_factory=list)
    columns_by_clause: dict[SqlAnalysisClause, list[str]] = Field(default_factory=dict)
    error: str | None = None


class AnalyzeSqlBatchResponse(BaseModel):
    results: dict[str, AnalyzeSqlBatchResult]


def _ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _table_ref(table: exp.Table) -> str:
    parts: list[str] = []
    catalog = table.args.get("catalog")
    db = table.args.get("db")
    if catalog is not None and getattr(catalog, "name", None):
        parts.append(str(catalog.name))
    if db is not None and getattr(db, "name", None):
        parts.append(str(db.name))
    if table.name:
        parts.append(str(table.name))
    return ".".join(parts)


def _column_name(column: exp.Column) -> str:
    return str(column.name)


def _columns_from_nodes(nodes: list[exp.Expression | None]) -> list[str]:
    names: list[str] = []
    for node in nodes:
        if node is None:
            continue
        names.extend(_column_name(column) for column in node.find_all(exp.Column))
    return _ordered_unique(names)


def _columns_by_clause(tree: exp.Expression) -> dict[SqlAnalysisClause, list[str]]:
    result: dict[SqlAnalysisClause, list[str]] = {}

    select_columns = _columns_from_nodes(list(tree.expressions))
    if select_columns:
        result["select"] = select_columns

    where_columns = _columns_from_nodes([tree.args.get("where")])
    if where_columns:
        result["where"] = where_columns

    join_columns = _columns_from_nodes([join.args.get("on") for join in tree.args.get("joins") or []])
    if join_columns:
        result["join"] = join_columns

    group = tree.args.get("group")
    group_columns = _columns_from_nodes(list(group.expressions) if group is not None else [])
    if group_columns:
        result["groupBy"] = group_columns

    having_columns = _columns_from_nodes([tree.args.get("having")])
    if having_columns:
        result["having"] = having_columns

    order = tree.args.get("order")
    order_columns = _columns_from_nodes(list(order.expressions) if order is not None else [])
    if order_columns:
        result["orderBy"] = order_columns

    return result


def _analyze_one(item_id: str, sql: str, dialect: str) -> tuple[str, AnalyzeSqlBatchResult]:
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except sqlglot.errors.SQLGlotError as exc:
        return item_id, AnalyzeSqlBatchResult(error=str(exc))

    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    table_refs = [
        table_ref
        for table_ref in (_table_ref(table) for table in tree.find_all(exp.Table))
        if table_ref and table_ref.split(".")[-1].lower() not in cte_names
    ]

    return item_id, AnalyzeSqlBatchResult(
        tables_touched=_ordered_unique(table_refs),
        columns_by_clause=_columns_by_clause(tree),
        error=None,
    )


def _analyze_payload(payload: tuple[str, str, str]) -> tuple[str, AnalyzeSqlBatchResult]:
    item_id, sql, dialect = payload
    return _analyze_one(item_id, sql, dialect)


def _worker_count(request: AnalyzeSqlBatchRequest) -> int:
    if len(request.items) <= 1:
        return 1
    if request.max_workers is not None:
        return min(request.max_workers, len(request.items))
    return min(os.cpu_count() or 1, len(request.items), 8)


def analyze_sql_batch_response(request: AnalyzeSqlBatchRequest) -> AnalyzeSqlBatchResponse:
    payloads = [(item.id, item.sql, request.dialect) for item in request.items]
    if _worker_count(request) == 1:
        analyzed = [_analyze_payload(payload) for payload in payloads]
    else:
        with ProcessPoolExecutor(max_workers=_worker_count(request)) as executor:
            analyzed = list(executor.map(_analyze_payload, payloads))

    return AnalyzeSqlBatchResponse(results={item_id: result for item_id, result in analyzed})
```

- [ ] **Step 4: Run parser tests to verify they pass**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py -q
```

Expected: PASS.

- [ ] **Step 5: Write failing FastAPI endpoint test**

In `python/ktx-daemon/tests/test_app.py`, add this test after `test_sql_parse_table_identifier_endpoint()`:

```python
def test_sql_analyze_batch_endpoint_returns_per_item_results() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/sql/analyze-batch",
        json={
            "dialect": "postgres",
            "max_workers": 1,
            "items": [
                {
                    "id": "orders",
                    "sql": "select status from public.orders where created_at is not null",
                },
                {"id": "broken", "sql": "select * from where"},
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["results"]["orders"]["tables_touched"] == ["public.orders"]
    assert body["results"]["orders"]["columns_by_clause"] == {
        "select": ["status"],
        "where": ["created_at"],
    }
    assert body["results"]["orders"]["error"] is None
    assert body["results"]["broken"]["tables_touched"] == []
    assert body["results"]["broken"]["columns_by_clause"] == {}
    assert body["results"]["broken"]["error"] is not None
```

- [ ] **Step 6: Run the endpoint test to verify it fails**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_app.py::test_sql_analyze_batch_endpoint_returns_per_item_results -q
```

Expected: FAIL with HTTP 404.

- [ ] **Step 7: Register the daemon endpoint**

In `python/ktx-daemon/src/ktx_daemon/app.py`, add this import block with the other daemon imports:

```python
from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchRequest,
    AnalyzeSqlBatchResponse,
    analyze_sql_batch_response,
)
```

Add this route after `/sql/parse-table-identifier`:

```python
    @app.post("/sql/analyze-batch", response_model=AnalyzeSqlBatchResponse)
    async def sql_analyze_batch(
        request: AnalyzeSqlBatchRequest,
    ) -> AnalyzeSqlBatchResponse:
        try:
            return analyze_sql_batch_response(request)
        except Exception as error:
            logger.exception("SQL batch analysis failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"SQL batch analysis failed: {error}",
            ) from error
```

- [ ] **Step 8: Run Python tests to verify the daemon slice passes**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py::test_sql_analyze_batch_endpoint_returns_per_item_results -q
```

Expected: PASS.

- [ ] **Step 9: Check Python formatting/lint hook availability**

Run:

```bash
test -f .pre-commit-config.yaml && source .venv/bin/activate && uv run pre-commit run --files python/ktx-daemon/src/ktx_daemon/sql_analysis.py python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py || printf 'pre-commit config missing\n'
```

Expected in this workspace: prints `pre-commit config missing`.

- [ ] **Step 10: Commit**

```bash
git add python/ktx-daemon/src/ktx_daemon/sql_analysis.py python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py
git commit -m "feat: add daemon sql batch analysis"
```

## Task 5: Add TypeScript Batch SQL Analysis Port

**Files:**
- Modify: `packages/context/src/sql-analysis/ports.ts`
- Modify: `packages/context/src/sql-analysis/index.ts`
- Modify: `packages/context/src/sql-analysis/http-sql-analysis-port.ts`
- Test: `packages/context/src/sql-analysis/http-sql-analysis-port.test.ts`
- Test: `packages/cli/src/managed-python-http.test.ts`
- Modify: legacy `SqlAnalysisPort` mocks found by `rg -n "const .*SqlAnalysis|sqlAnalysis: \\{" packages/context packages/cli`

- [ ] **Step 1: Write failing HTTP port tests**

In `packages/context/src/sql-analysis/http-sql-analysis-port.test.ts`, add these tests before the malformed daemon response test:

```typescript
  it('calls the SQL batch endpoint and maps snake_case response fields into a Map', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: ['public.orders', 'public.customers'],
          columns_by_clause: {
            select: ['status'],
            where: ['created_at'],
            join: ['customer_id', 'id'],
          },
          error: null,
        },
        broken: {
          tables_touched: [],
          columns_by_clause: {},
          error: 'Invalid expression / Unexpected token',
        },
      },
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(
      port.analyzeBatch(
        [
          { id: 'orders', sql: 'select status from public.orders' },
          { id: 'broken', sql: 'select * from where' },
        ],
        'postgres',
      ),
    ).resolves.toEqual(
      new Map([
        [
          'orders',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: ['status'],
              where: ['created_at'],
              join: ['customer_id', 'id'],
            },
            error: null,
          },
        ],
        [
          'broken',
          {
            tablesTouched: [],
            columnsByClause: {},
            error: 'Invalid expression / Unexpected token',
          },
        ],
      ]),
    );

    expect(requestJson).toHaveBeenCalledWith('/sql/analyze-batch', {
      dialect: 'postgres',
      items: [
        { id: 'orders', sql: 'select status from public.orders' },
        { id: 'broken', sql: 'select * from where' },
      ],
    });
  });

  it('rejects malformed SQL batch responses instead of inventing defaults', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: ['public.orders'],
          columns_by_clause: { select: ['status'], where: [42] },
          error: null,
        },
      },
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(port.analyzeBatch([{ id: 'orders', sql: 'select status from public.orders' }], 'postgres')).rejects
      .toThrow('sql analysis response is missing string[] field columns_by_clause.where');
  });
```

- [ ] **Step 2: Run HTTP port tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sql-analysis/http-sql-analysis-port.test.ts
```

Expected: FAIL because `analyzeBatch` is not defined.

- [ ] **Step 3: Add batch types to the port**

In `packages/context/src/sql-analysis/ports.ts`, add these types after `SqlAnalysisFingerprintResult`:

```typescript
export type SqlAnalysisClause = 'select' | 'where' | 'join' | 'groupBy' | 'having' | 'orderBy' | (string & {});

export interface SqlAnalysisBatchItem {
  id: string;
  sql: string;
}

export interface SqlAnalysisBatchResult {
  tablesTouched: string[];
  columnsByClause: Partial<Record<SqlAnalysisClause, string[]>>;
  error?: string | null;
}
```

Update `SqlAnalysisPort`:

```typescript
export interface SqlAnalysisPort {
  analyzeForFingerprint(sql: string, dialect: SqlAnalysisDialect): Promise<SqlAnalysisFingerprintResult>;
  analyzeBatch(
    items: SqlAnalysisBatchItem[],
    dialect: SqlAnalysisDialect,
  ): Promise<Map<string, SqlAnalysisBatchResult>>;
}
```

In `packages/context/src/sql-analysis/index.ts`, export the new types:

```typescript
  SqlAnalysisBatchItem,
  SqlAnalysisBatchResult,
  SqlAnalysisClause,
```

- [ ] **Step 4: Map the HTTP batch response**

In `packages/context/src/sql-analysis/http-sql-analysis-port.ts`, add the new type imports:

```typescript
  SqlAnalysisBatchItem,
  SqlAnalysisBatchResult,
```

Add this helper after `requiredStringArray()`:

```typescript
function requiredObject(raw: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = raw[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`sql analysis response is missing object field ${field}`);
  }
  return value as Record<string, unknown>;
}
```

Add this helper after `mapResult()`:

```typescript
function mapColumnsByClause(raw: Record<string, unknown>): SqlAnalysisBatchResult['columnsByClause'] {
  const value = requiredObject(raw, 'columns_by_clause');
  const result: SqlAnalysisBatchResult['columnsByClause'] = {};
  for (const [clause, columns] of Object.entries(value)) {
    if (!Array.isArray(columns) || columns.some((item) => typeof item !== 'string')) {
      throw new Error(`sql analysis response is missing string[] field columns_by_clause.${clause}`);
    }
    result[clause] = columns;
  }
  return result;
}

function mapBatchResult(raw: Record<string, unknown>): SqlAnalysisBatchResult {
  const error = optionalString(raw, 'error');
  return {
    tablesTouched: requiredStringArray(raw, 'tables_touched'),
    columnsByClause: mapColumnsByClause(raw),
    ...(error !== undefined ? { error } : {}),
  };
}

function mapBatchResponse(raw: Record<string, unknown>): Map<string, SqlAnalysisBatchResult> {
  const results = requiredObject(raw, 'results');
  return new Map(
    Object.entries(results).map(([id, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`sql analysis response contains invalid batch result ${id}`);
      }
      return [id, mapBatchResult(value as Record<string, unknown>)];
    }),
  );
}
```

Add `analyzeBatch()` to the object returned by `createHttpSqlAnalysisPort()`:

```typescript
    async analyzeBatch(items: SqlAnalysisBatchItem[], dialect: SqlAnalysisDialect) {
      const raw = await requestJson('/sql/analyze-batch', {
        dialect,
        items,
      });
      return mapBatchResponse(raw);
    },
```

- [ ] **Step 5: Run HTTP port tests to verify they pass**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sql-analysis/http-sql-analysis-port.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update managed-daemon wrapper test**

In `packages/cli/src/managed-python-http.test.ts`, add this test after the existing SQL analysis port test:

```typescript
  it('routes SQL batch analysis through the managed daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: ['public.orders'],
          columns_by_clause: { select: ['status'] },
          error: null,
        },
      },
    }));
    const sqlAnalysis = createManagedDaemonSqlAnalysisPort({ requestJson });

    await expect(sqlAnalysis.analyzeBatch([{ id: 'orders', sql: 'select status from public.orders' }], 'postgres'))
      .resolves.toEqual(
        new Map([
          [
            'orders',
            {
              tablesTouched: ['public.orders'],
              columnsByClause: { select: ['status'] },
              error: null,
            },
          ],
        ]),
      );
    expect(requestJson).toHaveBeenCalledWith('/sql/analyze-batch', {
      dialect: 'postgres',
      items: [{ id: 'orders', sql: 'select status from public.orders' }],
    });
  });
```

- [ ] **Step 7: Update legacy `SqlAnalysisPort` mocks**

Run:

```bash
rg -n "SqlAnalysisPort|sqlAnalysis: \\{|analyzeForFingerprint" packages/context/src/ingest packages/cli/src
```

For every object literal typed as `SqlAnalysisPort` or passed into a typed `sqlAnalysis` dependency, add:

```typescript
  async analyzeBatch() {
    return new Map();
  },
```

Known files from the current workspace:

- `packages/context/src/ingest/local-adapters.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage-pgss-golden.test.ts`
- `packages/context/src/ingest/adapters/historic-sql/stage-pgss.test.ts`

- [ ] **Step 8: Run CLI wrapper and context type checks**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/managed-python-http.test.ts
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS. If type-check reports a `SqlAnalysisPort` mock missing `analyzeBatch`, add the no-op method from Step 7 and rerun the failing type-check command.

- [ ] **Step 9: Commit**

```bash
git add packages/context/src/sql-analysis/ports.ts packages/context/src/sql-analysis/index.ts packages/context/src/sql-analysis/http-sql-analysis-port.ts packages/context/src/sql-analysis/http-sql-analysis-port.test.ts packages/cli/src/managed-python-http.test.ts packages/context/src/ingest/local-adapters.test.ts packages/context/src/ingest/adapters/historic-sql/stage.test.ts packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts packages/context/src/ingest/adapters/historic-sql/stage-pgss-golden.test.ts packages/context/src/ingest/adapters/historic-sql/stage-pgss.test.ts
git commit -m "feat: add sql analysis batch port"
```

## Task 6: Final Verification

**Files:**
- Read-only verification across TypeScript and Python.

- [ ] **Step 1: Run focused TypeScript tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/historic-sql/skill-schemas.test.ts src/sl/semantic-layer.service.test.ts src/ingest/adapters/live-database/manifest.test.ts src/scan/local-enrichment-artifacts.test.ts src/sql-analysis/http-sql-analysis-port.test.ts
pnpm --filter @ktx/cli exec vitest run src/managed-python-http.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused Python tests**

Run:

```bash
source .venv/bin/activate && uv run pytest python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py::test_sql_analyze_batch_endpoint_returns_per_item_results -q
```

Expected: PASS.

- [ ] **Step 3: Run package type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 4: Run Python pre-commit check if configured**

Run:

```bash
test -f .pre-commit-config.yaml && source .venv/bin/activate && uv run pre-commit run --files python/ktx-daemon/src/ktx_daemon/sql_analysis.py python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py || printf 'pre-commit config missing\n'
```

Expected in this workspace: prints `pre-commit config missing`.

- [ ] **Step 5: Confirm the old adapter was not cut over in this slice**

Run:

```bash
rg -n "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline" packages/context/src/ingest/adapters/historic-sql packages/context/src/ingest/index.ts
```

Expected: matches still exist. This confirms the foundation slice did not silently perform the hard cutover from spec §10.1.

- [ ] **Step 6: Commit verification notes if code changed during verification**

If verification required edits, commit only those files:

```bash
git status --short
git add packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts packages/context/src/ingest/adapters/historic-sql/skill-schemas.test.ts packages/context/src/ingest/index.ts packages/context/src/sl/types.ts packages/context/src/sl/schemas.ts packages/context/src/sl/semantic-layer.service.ts packages/context/src/sl/semantic-layer.service.test.ts packages/context/src/ingest/adapters/live-database/manifest.ts packages/context/src/ingest/adapters/live-database/manifest.test.ts packages/context/src/scan/local-enrichment-artifacts.ts packages/context/src/scan/local-enrichment-artifacts.test.ts python/ktx-daemon/src/ktx_daemon/sql_analysis.py python/ktx-daemon/src/ktx_daemon/app.py python/ktx-daemon/tests/test_sql_analysis.py python/ktx-daemon/tests/test_app.py packages/context/src/sql-analysis/ports.ts packages/context/src/sql-analysis/index.ts packages/context/src/sql-analysis/http-sql-analysis-port.ts packages/context/src/sql-analysis/http-sql-analysis-port.test.ts packages/cli/src/managed-python-http.test.ts packages/context/src/ingest/local-adapters.test.ts packages/context/src/ingest/adapters/historic-sql/stage.test.ts packages/context/src/ingest/adapters/historic-sql/historic-sql.adapter.test.ts packages/context/src/ingest/adapters/historic-sql/stage-pgss-golden.test.ts packages/context/src/ingest/adapters/historic-sql/stage-pgss.test.ts
git commit -m "test: finish historic sql foundations verification"
```

If verification required no edits, do not create an empty commit.

## Self-Review

**Spec coverage:** This plan covers the foundation item in spec §10.3. It intentionally does not cover search enrichment (§6.2.3-§6.2.5), the unified reader and staged artifacts (§4), skills and projection (§5), legacy cleanup (§10.2), or setup/doctor docs (§8). Those should be separate plans because each produces a testable subsystem and avoids one oversized cutover plan.

**Placeholder scan:** The plan contains exact file paths, test code, implementation snippets, commands, expected failures, expected passes, and commit commands. It does not use placeholder markers or deferred implementation text.

**Type consistency:** `TableUsageOutput` is created in `skill-schemas.ts`, then reused by `SemanticLayerSource`, `ManifestTableEntry`, and `LiveDatabaseManifestTableEntry`. `SqlAnalysisPort.analyzeBatch()` returns `Map<string, SqlAnalysisBatchResult>` consistently across `ports.ts`, `http-sql-analysis-port.ts`, and `managed-python-http.test.ts`. The Python daemon response uses snake_case fields that the TypeScript HTTP port maps to camelCase.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-historic-sql-foundations.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
