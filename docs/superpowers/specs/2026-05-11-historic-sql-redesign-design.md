# Historic SQL Ingestion — Redesign

**Status:** draft
**Date:** 2026-05-11
**Owner:** Andrey Avtomonov

## 1. Motivation

The current historic-SQL ingestion adapter (`packages/context/src/ingest/adapters/historic-sql/`) is slow, complex, and structurally cannot answer the questions a research/BI agent actually asks.

Concrete pain points observed:

- A full run takes **30+ minutes against a tiny demo Postgres database**. The hot loop calls `SqlAnalysisPort.analyzeForFingerprint()` once per query via HTTP to the Python daemon, so thousands of RPC round-trips dominate runtime.
- **Two completely different code paths** for Postgres (baseline-diff against `pg_stat_statements`) versus BigQuery/Snowflake (timestamp cursor over `INFORMATION_SCHEMA.JOBS` / `QUERY_HISTORY`). Postgres further cannot produce the same outputs as the others (no per-execution samples, no literal-slot bindings, error rate stuck at zero).
- The output is **fingerprint-fragmented**: the pipeline emits one document per fingerprint, expands categorical literal slots into per-value sub-clusters, and ranks templates with a recency-decayed score. The result is many near-duplicate documents per fingerprint and gratuitous churn across runs.
- The output is **rigid and shallow**: deterministic slot classification (constant / categorical / runtime) and triage-signal buckets do not produce narrative an agent can use. The current downstream skills (`historic_sql_ingest`, `historic_sql_curator`) try to recover narrative from these templates but at high cost.
- Lots of moving parts (baseline files, reset detection, atomic per-connection commit, slot heuristics, ranking formula) for what is fundamentally "find interesting queries and tell agents about them."

The end goal — per the user — is for ingested content to be **searchable by `ktx wiki search` and `ktx sl search` to help consumer research agents do data analysis and agentic BI**.

## 2. Design principles

1. **LLMs are the right tool for narrative and clustering.** Deterministic heuristics (slot classification, ranking formulas, categorical expansion) get replaced by LLM judgement applied to aggregated, bucketed inputs.
2. **The adapter stays LLM-free.** The existing convention — adapters are deterministic, skills do LLM work — is preserved.
3. **One pipeline across dialects.** A single reader interface, a single staging shape, a single set of skills. Dialect-specific behavior lives only in the snapshot query.
4. **No work where no signal changed.** Daily reruns should LLM only the things that actually changed.
5. **Lean context for caller agents.** Each retrieval tier (search hit → source read → pattern read) carries only what the agent needs to make the next decision. The principle lives in prompt instructions, not in defensive schema constraints.
6. **Simplification over backward compatibility.** Hard cutover, delete the old code path, no parallel implementations.

## 3. Architecture

```
                 ┌────────────────────────── LLM-free, deterministic ─────────────────────────┐
Reader (unified)  ─▶  Aggregated snapshot ─▶  Batch SQL parse ─▶  Bucket by table
                                                                          │
                                                                          ▼
                                                      Staged dir:
                                                        manifest.json
                                                        tables/{schema}.{name}.json   (one per touched table)
                                                        patterns-input.json
                                                                          │
                                                                          ▼
                                                                  chunk() → WorkUnits
                                                                          │
                          ┌───────────────────────────────────────────────┴────────────────────────────┐
                          ▼                                                                              ▼
              ┌────── LLM via skill ──────┐                                              ┌────── LLM via skill ──────┐
              │ historic_sql_table_digest │  (N WorkUnits, parallel)                     │ historic_sql_patterns     │
              │ produces TableUsage       │                                              │ produces Pattern[]        │
              │ evidence per table        │                                              │ evidence                  │
              └───────────────────────────┘                                              └───────────────────────────┘
                          │                                                                              │
                          └──────────────────────────┬───────────────────────────────────────────────────┘
                                                     ▼
                       onPullSucceeded() projection (no LLM):
                         Pass A — merge `usage` into _schema/{shard}.yaml (per-shard atomic, scan-managed keys)
                         Pass B — write/update pattern wiki pages (slug stability + stale handling)
                         Pass C — trigger SL search re-index for changed sources
```

## 4. Hot path (LLM-free)

### 4.1 Unified reader interface

```typescript
interface HistoricSqlReader {
  probe(client: HistoricSqlQueryClient): Promise<HistoricSqlProbeResult>;
  fetchAggregated(
    client: HistoricSqlQueryClient,
    window: { start: Date; end: Date },
  ): AsyncIterable<AggregatedTemplate>;
}
```

`AggregatedTemplate` is one record per template, already aggregated by the warehouse. Schema in §9.

**Trailing-window only.** No cursor, no baseline file. Every run reads "what was hot in the last N days." Idempotency comes from per-WorkUnit content hashing via the framework's `DiffSetComputerPort`.

### 4.2 Snapshot queries (one per dialect)

**Postgres** — `pg_stat_statements` collapsed to `queryid`:

```sql
SELECT queryid::text AS template_id,
       query AS canonical_sql,
       SUM(calls)::bigint AS executions,
       COUNT(DISTINCT userid) AS distinct_users,
       SUM(total_exec_time) / NULLIF(SUM(calls), 0) AS mean_ms,
       SUM(total_rows)::bigint AS rows_produced
FROM pg_stat_statements
WHERE toplevel = true
GROUP BY queryid, query
HAVING SUM(calls) >= @min_executions
```

`firstSeen` derives from `pg_stat_statements_info.stats_reset`; `lastSeen` is `now()`. `p50RuntimeMs` / `p95RuntimeMs` collapse to `mean_ms`. `errorRate = 0` (PG doesn't track failures in PGSS).

**BigQuery** — warehouse-side aggregation over `INFORMATION_SCHEMA.JOBS_BY_PROJECT`:

```sql
SELECT query_hash AS template_id,
       MIN(query) AS canonical_sql,
       COUNT(*) AS executions,
       COUNT(DISTINCT user_email) AS distinct_users,
       MIN(creation_time) AS first_seen,
       MAX(creation_time) AS last_seen,
       APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, creation_time, MILLISECOND), 100)[OFFSET(50)] AS p50_ms,
       APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, creation_time, MILLISECOND), 100)[OFFSET(95)] AS p95_ms,
       SAFE_DIVIDE(COUNTIF(error_result IS NOT NULL), COUNT(*)) AS error_rate
FROM `{project}.region-{region}.INFORMATION_SCHEMA.JOBS_BY_PROJECT`
WHERE job_type = 'QUERY'
  AND statement_type IN ('SELECT', 'MERGE')
  AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @window_days DAY)
GROUP BY query_hash
HAVING COUNT(*) >= @min_executions
```

**Snowflake** — analogous, over `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`:

```sql
SELECT query_hash AS template_id,
       MIN(query_text) AS canonical_sql,
       COUNT(*) AS executions,
       COUNT(DISTINCT user_name) AS distinct_users,
       MIN(start_time) AS first_seen,
       MAX(start_time) AS last_seen,
       APPROX_PERCENTILE(total_elapsed_time, 0.50) AS p50_ms,
       APPROX_PERCENTILE(total_elapsed_time, 0.95) AS p95_ms,
       DIV0(COUNT_IF(execution_status != 'SUCCESS'), COUNT(*)) AS error_rate,
       SUM(rows_produced) AS rows_produced
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE query_text IS NOT NULL
  AND query_type IN ('SELECT', 'MERGE')
  AND start_time >= DATEADD(day, -@window_days, CURRENT_TIMESTAMP())
GROUP BY query_hash
HAVING COUNT(*) >= @min_executions
```

### 4.3 Batch SQL parse

After collecting all `AggregatedTemplate` rows, **one** call to a new daemon endpoint:

```typescript
const parsed = await sqlAnalysis.analyzeBatch(
  templates.map(t => ({ id: t.templateId, sql: t.canonicalSql })),
  dialect,
);
// → Map<templateId, { tablesTouched: string[], columnsByClause: Record<Clause, string[]>, error?: string }>
```

The endpoint is implemented in `python/ktx-daemon` and uses `sqlglot` internally with `ProcessPoolExecutor` parallelism over the batch. Replaces the per-query HTTP roundtrip pattern that dominates today's runtime.

Per-row parse failures are non-fatal: the template loses table grounding (excluded from per-table bucketing and from patterns) but the failure is logged to `manifest.warnings` as `parse_failed:<templateId>`.

### 4.4 Filtering (three layers)

**Layer A — Warehouse-side (in the SQL above):**

- Noise prefixes (`SHOW`, `DESCRIBE`, `EXPLAIN`, `USE`, `SET`).
- System catalogs (`INFORMATION_SCHEMA`, `SNOWFLAKE.ACCOUNT_USAGE`, `pg_*`, `system.*`).
- DDL / non-analytical statement types via `statement_type` / `query_type` columns (PG falls back to prefix regex).
- Trivial probes (`SELECT 1`, `SELECT NOW()`, `SELECT VERSION()`) — configurable.
- Minimum executions threshold (`@min_executions`, default 5).
- Trailing window (`@window_days`, default 90) — BQ/SF only.

**Layer B — Post-fetch, in-memory:**

- Service-account exclusion/inclusion via configurable regex patterns; three modes (`exclude` default, `include`, `mark-only`).
- Orchestrator boilerplate (dbt/Looker/Metabase markers) — default `mark-only` (do not drop; dbt-generated queries are often the actual business logic).
- Failed-query filter (BQ/SF only): templates with `errorRate > 0.9 AND executions < 10`.

**Layer C — Post-parse:**

- Zero-table templates (parsed cleanly but touch no real tables) are dropped from per-table bucketization and from patterns.

### 4.5 Bucketize by table

In-memory pass: a single template touching N tables ends up in N table buckets.

### 4.6 Staged artifacts

```
{stagedDir}/
  manifest.json
  tables/
    {schema}.{name}.json         # one per touched table
  patterns-input.json
```

`manifest.json` is small (summary, window, counts, warnings — schema in §9).

`tables/{schema}.{name}.json` contains **bucketed** content so that DiffSet content hashes are stable when nothing material changed:

```jsonc
{
  "table": "public.orders",
  "stats": {
    "executionsBucket": "1k-5k",
    "distinctUsersBucket": "5-10",
    "errorRateBucket": "low",
    "p95RuntimeBucket": "100ms-1s",
    "recencyBucket": "current"
  },
  "columnsByClause": {
    "select":  [["amount","high"], ["status","high"]],
    "where":   [["status","high"], ["created_at","mid"]],
    "join":    [["customer_id","high"]],
    "groupBy": [["status","low"]]
  },
  "observedJoins": [
    { "withTable": "public.customers",  "on": ["customer_id"], "freq": "high" },
    { "withTable": "public.line_items", "on": ["order_id"],    "freq": "high" }
  ],
  "topTemplates": [
    { "id": "...", "canonicalSql": "...", "topUsers": [...] }
  ]
}
```

`patterns-input.json` contains every template in compact form (`id`, `canonicalSql`, `tablesTouched`, `executionsBucket`, `distinctUsersBucket`, `dialect`). Pulls double duty as the patterns skill input and as the audit log; no separate `templates.jsonl`.

Bucket bands are defined deterministically in code (e.g. `executionsBucket`: `<10`, `10-100`, `100-1k`, `1k-5k`, `5k-50k`, `>50k`). Exact thresholds set during implementation; the principle is that small fluctuations don't change the bucket.

### 4.7 `chunk()` (trivial, convention-following)

One `WorkUnit` per `tables/*.json` file (handled by `historic_sql_table_digest`) + one `WorkUnit` referencing `patterns-input.json` (handled by `historic_sql_patterns`). No custom diff logic — the framework's `DiffSetComputerPort` already filters to changed files.

## 5. Cold path (LLM, via skills)

Both skills produce **evidence**; the adapter's `onPullSucceeded()` projects evidence to its final homes. This avoids write contention between parallel skill invocations on the same shard file.

### 5.1 `historic_sql_table_digest`

One invocation per changed table's `WorkUnit`. Input: the table's staged JSON plus dependency reference to the existing `_schema` entry (so the LLM sees the actual column list and doesn't hallucinate).

**Prompt cache split** (`cacheControl: { type: 'ephemeral', ttl: '5m' }`, auto-bump to `'1h'` when the run is expected to exceed ~4 minutes wall clock):

- **Cached prefix:** role, output JSON schema generated from `tableUsageOutputSchema` via Zod 4's `z.toJSONSchema()`, extraction rules, 1–2 few-shot examples.
- **Variable suffix:** table name, existing columns list, existing AI description, staged usage input.

**Output schema** (zod, in `historic-sql/skill-schemas.ts`):

```typescript
export const tableUsageOutputSchema = z.object({
  narrative: z.string(),
  frequencyTier: z.enum(['high', 'mid', 'low', 'unused']),
  commonFilters: z.array(z.string()),
  commonGroupBys: z.array(z.string()).optional(),
  commonJoins: z.array(z.object({
    table: z.string(),
    on: z.array(z.string()),
  })),
  staleSince: z.iso.datetime().nullable().optional(),
});
```

No hard length/cap constraints in the schema. Concision is a behavioral instruction in the prompt prefix.

**Concurrency:** `runWithConcurrency()` from `packages/context/src/scan/description-generation.ts:147` (the same utility scan-description uses). Default 12, configurable in `ktx.yaml`.

**Idempotency:** when `tables/{name}.json`'s content hash hasn't changed (bucketed stats stable), DiffSet marks the file `unchanged`, no WorkUnit is emitted, no LLM call happens. Steady-state daily runs LLM only the meaningfully changed tables.

### 5.2 `historic_sql_patterns`

One invocation per run (or a small handful if `patterns-input.json` exceeds a context budget — split deterministically by `tablesTouched` cardinality stratification).

**Prompt:** identifies recurring analytical intents that span ≥2 tables with ≥mid executionsBucket and ≥2-5 distinct users. Output is a list of `PatternOutput`.

**Output schema:**

```typescript
export const patternOutputSchema = z.object({
  slug: z.string(),
  title: z.string(),
  narrative: z.string(),
  definitionSql: z.string(),
  tablesInvolved: z.array(z.string()),
  slRefs: z.array(z.string()),
  constituentTemplateIds: z.array(z.string()),
});
```

**Cache control:** skip. Single call per run; cache write premium doesn't amortize.

**Slug stability across runs:** the projection step (§5.3) does a deterministic similarity check against existing pattern pages. For each new pattern, find an existing slug whose `tablesInvolved` ∪ `constituentTemplateIds` overlap ≥60% with the new one and reuse it; else mint a new slug. Pure post-process, no LLM call.

### 5.3 Projection inside `onPullSucceeded()`

After all skills complete and evidence is committed, run two passes. Both are pure data transformations, no LLM calls.

**Pass A — `_schema` shard reconciliation:**

1. Collect all `historic_sql_table_usage` evidence written this run.
2. Group by `shardKey` (`catalog.schema`).
3. For each shard:
   - Load existing `_schema/{shardKey}.yaml`.
   - For each table entry: if new evidence exists, merge under `usage` via `mergeUsagePreservingExternal()` (only `historicSql`-managed keys touched; user-added keys preserved — same pattern as `mergeDescriptionsPreservingExternal` at `local-enrichment-artifacts.ts:237-242`).
   - For tables previously present with `historicSql`-managed `usage` but absent from this run's snapshot: set `usage.staleSince = lastSnapshotSeenAt`, clear other historicSql-managed fields.
   - Atomic write to `_schema/{shardKey}.yaml`.
4. Trigger SL search re-index for changed sources via the existing flow (`sl-search.service.ts:91-99` detects search-text drift).

**Pass B — wiki pattern pages:**

1. Collect all `historic_sql_pattern` evidence written this run.
2. Load existing wiki pages with tags `['historic-sql', 'pattern']` for this connection.
3. Run slug-stability matching.
4. For each pattern (existing or new):
   - Build `LocalKnowledgePage` with `key: historic-sql/{slug}`, `scope: GLOBAL`, `tags: ['historic-sql', 'pattern']`, `slRefs` to relevant SL sources, `refs` to other historic-sql pages.
   - `writeLocalKnowledgePage(...)`.
5. For existing patterns not seen this run: append frontmatter `stale_since: {today}` and add `tag: stale`. Don't delete; preserve for historical lookups.
6. After `staleArchiveAfterDays` threshold (default 90 days, configurable): move the page key under `historic-sql/_archived/` and add `tag: archived`.

## 6. Search-surface plumbing

### 6.1 `ktx wiki search` — no plumbing required

Pattern pages are written to `knowledge/global/historic-sql/{slug}.md` and are discovered by the existing `searchLocalKnowledgePages()` walk. Tags `['historic-sql', 'pattern']` enable faceted search.

### 6.2 `ktx sl search` — small extension

**6.2.1 — `SemanticLayerSource.usage` field**

Add an optional `usage` field to `SemanticLayerSource` in `packages/context/src/sl/schemas.ts`, reusing the same `tableUsageOutputSchema` from `skill-schemas.ts`. Single source of truth end-to-end.

**6.2.2 — `_schema` → `SemanticLayerSource` projection carries `usage`**

The existing projection step in `local-sl.ts` (or wherever the manifest reader builds `SemanticLayerSource` objects) needs one new field copy: `entry.usage → source.usage`.

**6.2.3 — `buildSemanticLayerSourceSearchText()` extension**

Extend the function at `sl-search.service.ts:8-74` to include usage content in the FTS5/embedding text:

```typescript
if (source.usage) {
  const u = source.usage;
  parts.push(`usage: ${u.narrative}`);
  parts.push(`frequency: ${u.frequencyTier}`);
  if (u.commonFilters?.length)  parts.push(`commonly filtered by: ${u.commonFilters.join(', ')}`);
  if (u.commonGroupBys?.length) parts.push(`commonly grouped by: ${u.commonGroupBys.join(', ')}`);
  for (const j of u.commonJoins ?? []) {
    parts.push(`commonly joined to ${j.table} on ${j.on.join(',')}`);
  }
  if (u.staleSince) parts.push(`stale since ${u.staleSince}`);
}
```

**6.2.4 — Re-index trigger**

Already wired. Per-source content-hash detection at `sl-search.service.ts:91-99` ensures only sources whose `usage` changed re-embed.

**6.2.5 — Query-mode result enrichment**

Extend the search result shape returned by `agent sl list --query` to include `score` and an FTS5 `snippet()` per hit. Implementation: small SQL change in `sqlite-sl-sources-index.ts` to select `snippet(local_sl_sources_fts, ...)` alongside the source row.

Result shape becomes:

```jsonc
{
  "connectionId": "warehouse",
  "name": "public.orders",
  "table": "orders",
  "columnCount": 12,
  "measureCount": 3,
  "joinCount": 2,
  "description": "...",
  "score": 0.81,
  "frequencyTier": "high",
  "snippet": "commonly filtered by <mark>status</mark>, joined to customers"
}
```

The full `usage` block lives in the `SemanticLayerSource` returned by `agent sl read <name>`.

## 7. Three-tier retrieval model

| Tier | Surface | What an agent gets |
|---|---|---|
| Search hit | `agent sl list --query "..."` | name, table, counts, description, score, frequencyTier, snippet |
| Source read | `agent sl read <name>` | full SemanticLayerSource YAML including columns, measures, joins, and `usage` block |
| Pattern read | `agent wiki read historic-sql/{slug}` | title, narrative, canonical SQL, tables involved, slRefs |

Agents pull deeper only when they need to. The bytes per tier are governed by prompt-side concision instructions, not by schema constraints.

## 8. Configuration

Per-connection block in `ktx.yaml`:

```yaml
connections:
  warehouse:
    driver: postgres
    connectionUrl: postgres://...
    historicSql:
      enabled: true
      # everything below is optional; defaults from the zod schema
      windowDays: 90
      minExecutions: 5
      concurrency: 12
      filters:
        serviceAccounts:
          patterns: ['^etl-', '@bot\.']
          mode: exclude              # exclude | include | mark-only
        orchestrators:
          mode: mark-only            # include | exclude | mark-only
        dropTrivialProbes: true
        dropFailedBelow:
          errorRate: 0.9
          executions: 10
      redactionPatterns: ['password', 'api_key']
      staleArchiveAfterDays: 90
```

CLI setup wizard (`ktx setup`) flags map onto this block. `--historic-sql-min-calls` is renamed `--historic-sql-min-executions` (cross-dialect clarity); both names accepted for one release.

Doctor command (`ktx dev doctor`) retains PG-specific validation: version ≥ 14, extension installed, `pg_read_all_stats` grant, `pg_stat_statements.track != 'none'`. The `pg_stat_statements.max ≥ 5000` check is downgraded from a warning to an informational note (deallocation churn no longer threatens delta-tracking integrity, because there is no delta tracking).

## 9. Schemas (zod)

Lives in `packages/context/src/ingest/adapters/historic-sql/types.ts` unless noted.

```typescript
export const historicSqlPullConfigSchema = z.object({
  dialect: z.enum(['postgres', 'bigquery', 'snowflake']),
  windowDays: z.number().int().positive().default(90),
  minExecutions: z.number().int().nonnegative().default(5),
  concurrency: z.number().int().positive().default(12),
  filters: z.object({
    serviceAccounts: z.object({
      patterns: z.array(z.string()).default([]),
      mode: z.enum(['exclude', 'include', 'mark-only']).default('exclude'),
    }).optional(),
    orchestrators: z.object({
      mode: z.enum(['exclude', 'include', 'mark-only']).default('mark-only'),
    }).optional(),
    dropTrivialProbes: z.boolean().default(true),
    dropFailedBelow: z.object({
      errorRate: z.number(),
      executions: z.number().int(),
    }).optional(),
  }).optional(),
  redactionPatterns: z.array(z.string()).default([]),
  staleArchiveAfterDays: z.number().int().positive().default(90),
});

export const aggregatedTemplateSchema = z.object({
  templateId: z.string(),
  canonicalSql: z.string(),
  dialect: z.enum(['postgres', 'bigquery', 'snowflake']),
  stats: z.object({
    executions: z.number().int(),
    distinctUsers: z.number().int(),
    firstSeen: z.iso.datetime(),
    lastSeen: z.iso.datetime(),
    p50RuntimeMs: z.number().nullable(),
    p95RuntimeMs: z.number().nullable(),
    errorRate: z.number(),
    rowsProduced: z.number().int().nullable(),
  }),
  topUsers: z.array(z.object({
    user: z.string().nullable(),
    executions: z.number().int(),
  })),
});

export const stagedTableInputSchema = z.object({
  table: z.string(),
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

export const stagedPatternsInputSchema = z.object({
  templates: z.array(z.object({
    id: z.string(),
    canonicalSql: z.string(),
    tablesTouched: z.array(z.string()),
    executionsBucket: z.string(),
    distinctUsersBucket: z.string(),
    dialect: z.enum(['postgres', 'bigquery', 'snowflake']),
  })),
});

export const stagedManifestSchema = z.object({
  source: z.literal('historic-sql'),
  connectionId: z.string(),
  dialect: z.enum(['postgres', 'bigquery', 'snowflake']),
  fetchedAt: z.iso.datetime(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  snapshotRowCount: z.number().int(),
  touchedTableCount: z.number().int(),
  parseFailures: z.number().int(),
  warnings: z.array(z.string()),
  probeWarnings: z.array(z.string()),
});
```

In `packages/context/src/ingest/adapters/historic-sql/skill-schemas.ts` — the **single source of truth for LLM I/O shapes**, imported by the prompt builder, the evidence parser, the projection step, the `SemanticLayerSource` type, and the `_schema` manifest entry type:

```typescript
export const tableUsageOutputSchema = z.object({
  narrative: z.string(),
  frequencyTier: z.enum(['high', 'mid', 'low', 'unused']),
  commonFilters: z.array(z.string()),
  commonGroupBys: z.array(z.string()).optional(),
  commonJoins: z.array(z.object({
    table: z.string(),
    on: z.array(z.string()),
  })),
  staleSince: z.iso.datetime().nullable().optional(),
});
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
export const patternsArraySchema = z.array(patternOutputSchema);
export type PatternOutput = z.infer<typeof patternOutputSchema>;
```

**Extensions to existing types:**

- `packages/context/src/sl/schemas.ts` — `SemanticLayerSource.usage: tableUsageOutputSchema.optional()`.
- `packages/context/src/ingest/adapters/live-database/manifest.ts` — `LiveDatabaseManifestTableEntry.usage?: TableUsageOutput`.

The `_schema/{shard}.yaml` manifest version need not bump — `usage` is an additive, optional field. Validators must allow unknown future keys (audit during step 1 of §10).

## 10. Cutover plan

Hard cutover. No parallel codepaths. Single coordinated PR (or PR train).

### 10.1 Code that gets deleted

Within `packages/context/src/ingest/adapters/historic-sql/`:

- `stage.ts` — rewritten
- `stage-pgss.ts` — **deleted** (no baseline tracking)
- `stage-pgss.test.ts`, `stage-pgss-golden.test.ts` — **deleted**
- `historic-sql.adapter.ts` — rewritten
- `historic-sql.adapter.test.ts` — rewritten
- `chunk.ts` / `chunk.test.ts` — rewritten (becomes trivial)
- `detect.ts` / `detect.test.ts` — trivial update
- `postgres-pgss-query-history-reader.ts` — rewritten as `postgres-pgss-reader.ts`; baseline-tracking code removed
- `bigquery-query-history-reader.ts` / `snowflake-query-history-reader.ts` — rewritten; cursor logic removed; warehouse-side GROUP BY
- `types.ts` — rewritten
- **new** `skill-schemas.ts`
- `errors.ts` — keep (probe errors); prune unused

Old skills `historic_sql_ingest` and `historic_sql_curator` — audit; if only consumed by historic-sql, delete.

`expandCategoricalTemplates`, `classifySlot`, `rankTemplate`, slot-related types — gone.

### 10.2 Existing artifacts

| Artifact | Where | Decision |
|---|---|---|
| Old per-template wiki pages | `knowledge/global/...` (legacy `historic-sql-template` tag or matching key prefix) | **One-time cleanup** in `onPullSucceeded()` on first run after upgrade. Idempotent: subsequent runs no-op. |
| PG baseline files | `.ktx/cache/historic-sql/{connectionId}/pgss-baseline.json` | **Delete on first run.** Cache; no signal lost. |
| Old `raw-sources/{connectionId}/historic-sql/{syncId}/` snapshots | `raw-sources/...` | **Leave alone.** Per-sync audit; framework handles retention. |

### 10.3 Ordering

1. **Foundations** (independent, no behavioral change):
   - Daemon `analyze-batch` endpoint + `SqlAnalysisPort.analyzeBatch()` (old method still in place, unused).
   - `SemanticLayerSource.usage` field (no producer yet).
   - `LiveDatabaseManifestTableEntry.usage` field (no producer yet).
   - `mergeUsagePreservingExternal()` utility + tests.
2. **Search enrichment** (independent, ships an unrelated win):
   - `buildSemanticLayerSourceSearchText()` extension.
   - FTS5 `snippet()` + score in query-mode results.
3. **New adapter** (replaces old in a single commit per dialect):
   - PG path first (smallest surface, has the doctor command for validation).
   - BQ + SF together (share aggregation pattern).
4. **Skills + projection:**
   - `historic_sql_table_digest` + `historic_sql_patterns`.
   - `onPullSucceeded` projection passes.
   - One-time legacy cleanup.
5. **Delete the old codepath** — same PR as step 3, ideally.
6. **Docs + setup wizard** updates.

### 10.4 Verification before merging

- **Demo DB end-to-end:** `examples/postgres-historic/` ingest completes in **under 60 seconds** (current 30-minute baseline becomes the regression bar).
- **Cross-dialect smoke:** at least one run against each of PG / BQ / SF ends with non-empty `_schema/{shard}.yaml` `usage` blocks and ≥0 pattern pages.
- **Idempotency:** a second run immediately after the first produces zero `historic_sql_table_digest` LLM calls.
- **Drift:** a run where one table disappears from the snapshot sets `usage.staleSince` on that table's `_schema` entry; reappearance clears it.
- **Search retrieval:** `agent sl list --query` returns hits with non-empty snippets; `agent wiki search "<pattern slug>"` returns the pattern page directly.
- **No old code paths:** `git grep -E "stagePgStatStatementsTemplates|expandCategoricalTemplates|classifySlot|pgss-baseline"` returns zero results.
- **Doctor still passes** on a properly configured PG with the new adapter.

### 10.5 Out of scope

- Embedding-based pattern clustering (rejected in favor of LLM-driven intent detection).
- Wiki shard pages (rejected — patterns are sparse; per-page is correct).
- Incremental dialect-by-dialect rollout behind a flag.
- A `ktx historic-sql migrate` command — cleanup runs automatically once.
- Framework-level `raw-sources/` retention policy (separate concern; not introduced here).
- Per-table wiki pages (the very problem `_schema` shards exist to avoid — see §11).

### 10.6 Risks

| Risk | Mitigation |
|---|---|
| Daemon `analyze-batch` slower than hoped on huge templates | `ProcessPoolExecutor` parallelism; configurable batch size cap |
| `_schema` shard concurrent writes (scan + historic-sql) | Atomic per-shard write + scan-managed-keys merge (`mergeUsagePreservingExternal`); new test covers concurrent invocation |
| Pattern slug churn between runs | Slug-stability matcher in projection; ≥60% overlap reuses existing slug; falls back to new mint if no match |
| Existing manifest validators reject `usage` field | Audit validators in step 1 of §10.3; extend allowed-fields list |
| User-edited `usage` fields clobbered | `mergeUsagePreservingExternal` follows the same scan-managed-keys discipline as descriptions; covered by tests |

## 11. Rejected alternatives

Documented so future readers don't relitigate.

**Per-table wiki pages** — one `.md` per table under `knowledge/global/historic-sql/`. Rejected: reintroduces the per-table-file proliferation problem (`writeLocalKnowledgePage` writes one file per page) that `_schema` shards exist to avoid. ~800 markdown files for a 1000-table warehouse, ~100 churning daily.

**Single-file all-usage page** — one giant page containing every table. Rejected: ~700 KB blob; FTS5 snippets all come from the same source; `wiki read` returns an unusable mass.

**One file per table in a new `_usage/` directory** — same file-count problem as per-table wiki, plus needs new search plumbing.

**New parallel `_usage/{shard}.yaml` shards** — same sharding benefit as merging into `_schema` but without riding SL search. Plumbing required without offsetting win.

**One wiki page per `catalog.schema`** — workable, but pages get large (200 tables per page) and only rides wiki search, not SL search. The chosen design rides both.

**Single staged `snapshot.json`** — to reduce `raw-sources/` accumulation. Rejected: required custom diff logic in `chunk()`, broke framework convention, saved bounded disk for a framework-level concern (sync retention). Per-table staged files with bucketed content is cleaner.

**Embedding-based pattern clustering** — using sentence-transformer embeddings to cluster templates into themes before naming via LLM. Rejected: reintroduces clustering hyperparameters and determinism the redesign aims to avoid. The LLM does the grouping in one call from the full template list, no embedding step.

**Skip pattern pages entirely** — ship only `_schema` enrichment for a leaner v1. Rejected: leaves `ktx wiki search` empty of historic-sql content (loses one of two stated consumption surfaces) and forces agents to synthesize cross-cutting intents from fragmented per-table mentions.

**TypeScript-native SQL parser** instead of sqlglot via daemon — `node-sql-parser`, `pgsql-parser` (WASM), etc. Rejected: materially worse dialect coverage on Snowflake/BigQuery edge cases; duplicates parser logic when KTX already uses sqlglot elsewhere (`python/ktx-daemon/src/ktx_daemon/lookml.py`); AGENTS.md explicitly mandates sqlglot. Batch endpoint on the existing daemon achieves the perf win.

**Hard length/count caps in zod output schemas** (e.g. `narrative.max(250)`, `commonFilters.max(5)`). Rejected: arbitrary thresholds, brittle retry-on-violation paths, defensive coding for a soft concern. Concision belongs in prompt instructions; the schema validates shape.

## 12. Cost / scale envelope

For a representative mid-size warehouse (~200 touched tables):

| Phase | Calls | Cost @ Sonnet |
|---|---|---|
| Hot path (deterministic) | 0 | $0 |
| First-run table digest (uncached + cached mix) | ~200 | ~$5–7 |
| First-run patterns | 1 | ~$0.05 |
| Embeddings (changed tables) | ~200 | ~$0.02 |
| **First run total** | | **~$5–7** |
| Daily steady-state (hash-skipped) | ~10–30 changed | ~$0.10–$0.25 |

Wall-clock: first run ~1–3 min on mid; demo DB <60s end-to-end.

For a large warehouse (~800 touched tables): first-run ~$20–30, daily ~$0.20–$1.00.

## 13. Open questions

- Exact bucket thresholds for `executionsBucket`, `distinctUsersBucket`, etc. — to be chosen during implementation based on what produces stable hashes in practice.
- Final naming of the daemon endpoint (`/sql/analyze-batch` vs alternatives).
- Whether `historic_sql_ingest` / `historic_sql_curator` skills are consumed elsewhere — audit during step 1.
- Whether to delete legacy wiki pages automatically or behind a confirmation flag — design assumes automatic.
