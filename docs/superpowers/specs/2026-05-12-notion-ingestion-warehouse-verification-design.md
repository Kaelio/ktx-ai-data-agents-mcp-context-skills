# Warehouse Verification Tools for Ingestion Synthesis

**Date:** 2026-05-12
**Author:** Andrey Avtomonov
**Status:** Design - pending implementation plan

## Background and motivation

KTX's ingest pipeline synthesises wiki pages and semantic-layer (SL) sources from third-party content (Notion, LookML, Looker, Metabase, dbt, MetricFlow, historic SQL, live-database scans, and chat). The synthesis stage is an LLM call that runs once per WorkUnit, governed by a skill prompt (e.g. `notion_synthesize`) and a set of allowed tools.

A real-world inspection (project `/tmp/ktx-proj-1`) surfaced two failure modes the synthesis stage produces:

1. **Fictional identifiers laundered into wiki output.** A Notion page mentioned `orbit_analytics.customer` as a legacy "customer source" table with a `plan_tier in {free, pro, enterprise}` column. Neither the table, the column, nor those values exist in the configured warehouse. The synthesis LLM faithfully copied them into `knowledge/global/orbit/customers-source.md` as a "Conflict Note", giving the fabricated names full wiki frontmatter, a `Source:` citation, and apparent authority.
2. **Column attribution drift.** The same wiki page documents columns under `orbit_raw.accounts` but states the `paying_account_count` measure filters on `normalized_plan_code` and `contract_status`. Those columns live on `orbit_analytics.mart_account_segments`, not on `accounts`. A reader (or a downstream agent) following the page will write `accounts.normalized_plan_code` and get a `column does not exist` error.

Root cause analysis (`packages/context/skills/notion_synthesize/SKILL.md`, `packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts`, `packages/context/src/wiki/tools/wiki-write.tool.ts`) showed three contributing factors:

- The synthesis LLM has no verification primitive that distinguishes a real warehouse identifier from a fabricated one. `sl_discover` only finds objects already promoted into the semantic layer; raw warehouse scans (which already exist on disk under `raw-sources/<conn>/live-database/<sync>/`) are not surfaced to the LLM at all.
- `wiki_write` performs no body-text validation - anything the LLM emits is written.
- The skill prompt itself uses `orbit_analytics.customer` as a canonical example string (`SKILL.md:70`), reinforcing the same fictional name the LLM ends up emitting.

Kaelio's server-side ingest WU agent (`/Users/andrey/conductor/workspaces/kaelio-main2/douala/server/src/tools/toolset-factory.service.ts`) had four verification tools that KTX dropped during the open-source extraction: `discover_data`, `entity_details`, `dictionary_search`, and `sql_execution`. The underlying connector infrastructure (`KtxScanConnector`, dialect classes, `assertReadOnlySql`, `SemanticLayerService.executeQuery`) is present in KTX, so the gap is at the tool layer, not the platform layer.

## Goal

Give every ingest adapter's synthesis-time LLM call the tools and skill-prompt instructions needed to verify warehouse identifiers (`schema.table`, `schema.table.column`) and sample values before emitting them into wiki pages, SL sources, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback` records.

## Non-goals

- Not changing `wiki_write` itself. A complementary spec covers hard write-time validation; this spec focuses on giving the LLM the tools to self-validate.
- Not modifying any Notion fetch/chunk/cluster behaviour.
- Not changing the `_schema/*.yaml` format.
- Not introducing a UUID layer for tables or columns; KTX keeps `(connection, catalog, db, name)` as the canonical table identity.
- Not adding `semantic_query` to the synthesis toolset. `semantic_query` is a future tool for the research/chat-time agent; synthesis creates SL sources rather than queries them, so the wrong shape.
- Not adding `dictionary_search`. `entity_details` already returns per-column `sampleValues` from the relationship-profile, and `sql_execution` covers the rarer "where does this literal live?" case more accurately than a sampled-JSON full-text scan.

## What already exists in KTX

The dialect/driver/connection architecture is fully ported from Kaelio. The new tools sit on top of three already-shipping primitives:

| Primitive | Location |
|---|---|
| `KtxTableRef = { catalog: string\|null, db: string\|null, name: string }` | `packages/context/src/scan/types.ts:168` |
| `SemanticLayerService.executeQuery(connectionId, sql)` | `packages/context/src/sl/semantic-layer.service.ts:1004`, used today by `sl_validate` |
| `assertReadOnlySql` / `limitSqlForExecution` | `packages/context/src/connections/read-only-sql.ts` |
| 7 connectors with parallel layout (postgres, mysql, sqlserver, snowflake, bigquery, clickhouse, sqlite), each exporting a dialect class | `packages/connector-*` |
| Raw scan artefacts: `tables/<base64(catalog??'_')>.<base64(db)>.<base64(name)>.json` and `enrichment/relationship-profile.json` (with `nativeType`, `nullable`, `primaryKey`, `foreignKeys`, `rowCount`, `nullCount`, `distinctCount`, `sampleValues`, descriptions) | `raw-sources/<connectionId>/live-database/<latest-sync>/` |
| `wiki_search`, `sl_discover`, `sl_read_source`, `sl_validate`, `emit_unmapped_fallback` | already wired into synthesis stages |

The only meaningfully new code is `WarehouseCatalogService`, a small `getDialectForDriver` dispatch, the three tool files, and the wiring in `ingest-bundle.runner.ts`.

## Architecture

### Module layout

```
packages/context/src/ingest/tools/warehouse-verification/
  discover-data.tool.ts
  entity-details.tool.ts
  sql-execution.tool.ts
  warehouse-catalog.service.ts
  index.ts                       # exports createWarehouseVerificationTools()
packages/context/src/connections/
  dialects.ts                    # adds getDialectForDriver()
packages/context/skills/_shared/
  identifier-verification.md     # the protocol snippet referenced from every synthesis skill
```

### Canonical table identity

Every tool that names a warehouse object uses the tuple `(connectionName, catalog, db, name[, column])`. `connectionName` is the slug from `ktx.yaml` (e.g., `"warehouse"`), validated against `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. There is no UUID layer.

`display` strings the LLM picks up from source pages (e.g., `"orbit_raw.accounts"` for Postgres or `"project.dataset.table"` for BigQuery) are parsed by `WarehouseCatalogService.resolveDisplay`, which knows the connection's driver via `getDialectForDriver`. Ambiguous parses (e.g., a 2-part display on BigQuery) return a candidates list instead of guessing.

Dialect mapping:

| Driver | catalog | db | name | Display |
|---|---|---|---|---|
| postgres | `null` | schema | table | `schema.table` |
| mysql | `null` | schema | table | `schema.table` |
| sqlserver | catalog | schema | table | `catalog.schema.table` |
| snowflake | database | schema | table | `db.schema.table` |
| bigquery | project | dataset | table | `project.dataset.table` |
| clickhouse | `null` | database | table | `database.table` |
| sqlite | `null` | `null` | table | `table` |

### `WarehouseCatalogService`

Stateless except for a per-WorkUnit cache. Reads raw scan files under `raw-sources/<connectionName>/live-database/<latest-sync>/`.

```ts
class WarehouseCatalogService {
  getTable(ref: { connectionName: string } & KtxTableRef): Promise<TableDetail | null>;
  listTables(connectionName: string): Promise<KtxTableRef[]>;
  resolveDisplay(connectionName: string, display: string): Promise<{
    resolved: KtxTableRef | null;
    candidates: KtxTableRef[];   // ranked by edit distance when resolved is null
    dialect: string;
  }>;
  searchByName(connectionName: string, query: string, limit: number): Promise<Array<
    | { kind: 'table';  ref: KtxTableRef; matchedOn: 'name'|'db'|'comment'|'description' }
    | { kind: 'column'; ref: KtxTableRef & { column: string }; matchedOn: 'name'|'comment'|'description' }
  >>;
  getLatestSyncId(connectionName: string): Promise<string | null>;
}
```

`getTable` merges the raw schema file (native types, PK, FK, nullable) with the enrichment profile (row counts, null rates, distinct counts, sample values, AI-generated descriptions). When no scan exists for the connection, every read returns `null`; tools surface this as a distinct "no scan available" state rather than as "identifier not found", so the LLM doesn't conclude a real table is fictional just because a scan hasn't run yet.

### `getDialectForDriver`

```ts
// packages/context/src/connections/dialects.ts
export type SupportedDriver = 'postgres'|'postgresql'|'mysql'|'sqlserver'|'snowflake'|'bigquery'|'clickhouse'|'sqlite'|'sqlite3';
export function getDialectForDriver(driver: SupportedDriver): KtxDialect;
```

Sync dispatch. The connectors' existing dialect classes already expose the same shape - `formatTableName(KtxTableRef)`, `quoteIdentifier(string)`, `mapToDimensionType(nativeType)`. The implementation plan introduces a minimal `KtxDialect` interface that these classes already satisfy structurally; no connector-internal changes required. Used by tools only for display-string parsing and error-message formatting; tools never construct executable SQL.

## Tool contracts

### `entity_details`

```ts
input = {
  connectionName: string,
  targets: Array<                          // 1..50, mixed shapes allowed
    | { display: string }                  // "orbit_raw.accounts" or "orbit_raw.accounts.account_id"
    | { catalog: string|null, db: string, name: string, column?: string }
  >,
}
```

Output (markdown, per target):

```
### orbit_raw.accounts
Type: table | Native columns: 11 | PK: account_id | FKs: parent_account_id → orbit_raw.accounts.account_id
Description: One row per customer account…

Columns:
- account_id (text, nullable=false, PK) - sample: ["acct_001","acct_002",…]
- parent_account_id (text, nullable=true, FK → orbit_raw.accounts.account_id)
- account_name (text, nullable=false)
- …

Profile: rowCount=4321 distinctCount(account_id)=4321 nullRate(parent_account_id)=0.62
```

When `column` is provided in a target, output is scoped to that one column. When a target doesn't resolve, output is `Not found in scan. Closest matches: …` with up to 5 candidates from `searchByName`. When the connection has no `live-database` scan, output is `No live-database scan available for connection "<name>"; run \`ktx scan\` first.` - distinct from the "not found" state.

Structured output: `{ resolved: TableDetail[], missing: Array<{target, candidates}>, scanAvailable: boolean }`.

Refuses `connectionName` values not in the WU-stage's `allowedConnectionNames` set.

### `sql_execution`

```ts
input = {
  connectionName: string,
  sql: string,                             // single SELECT or WITH only
  rowLimit?: number,                       // default 100, hard cap 1000
}
```

Pipeline:

1. `assertReadOnlySql(sql)` - regex rejects anything starting with `insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh`.
2. `limitSqlForExecution(sql, rowLimit)` - wraps as `select * from (<llm_sql>) as ktx_query_result limit N`.
3. `SemanticLayerService.executeQuery(connectionName, wrappedSql)`.
4. Format as markdown table; first ~20 rows inline; if truncated, append `… +N more rows`.

Structured output: `{ headers, rows, rowCount, truncated, sql, wrappedSql }`.

Connector errors surface verbatim (e.g., Postgres `relation "orbit_analytics.customer" does not exist`). That error message is the most valuable verification signal - it tells the LLM the identifier is fictional.

Refuses `connectionName` not in `allowedConnectionNames`. Each connector's driver-level read-only enforcement (Postgres read-only transaction, BigQuery query-only jobs) is a second defence under the regex gate.

### `discover_data`

```ts
input = {
  query: string,
  connectionName?: string,                 // omit to search all configured warehouse connections
  limit?: number,                          // default 10 per section
  sourceName?: string,                     // SL source detail mode (delegates to sl_discover)
}
```

Composes three searches and groups output into three sections, omitting empty sections:

1. **Wiki Pages** - `wiki_search({query, limit})`. Routing hint: *use `wiki_read(blockKey)` for full content*.
2. **Semantic Layer Sources** - `sl_discover({query, connectionName})`. Routing hint: *use `sl_read_source(sourceName)` for the YAML, or `entity_details` for warehouse-shape details*.
3. **Raw Warehouse Schema** - `WarehouseCatalogService.searchByName(connectionName, query, limit)`. Routing hint: *use `entity_details({connectionName, targets: [{display}]})` for full DDL + sample values*.

When `sourceName` is set, delegates entirely to `sl_discover` inspect mode and skips other sections. When all three sections are empty, output is `No matches for "<query>" across wiki, semantic layer, or raw warehouse schema. Try broader terms; this concept may not exist yet.`

Structured output: `{ wiki: WikiSearchStructured|null, sl: SlDiscoverStructured|null, raw: RawSchemaHits|null }`.

## Wiring

`packages/context/src/ingest/ingest-bundle.runner.ts` already plumbs `emit_unmapped_fallback` into both the WorkUnit stage (`createEmitUnmappedFallbackTool` around line 726) and the reconcile stage (around line 962), with merging done via `packages/context/src/ingest/stages/build-wu-context.ts` and `build-reconcile-context.ts`.

Add a parallel factory next to those existing calls:

```ts
const warehouseTools = createWarehouseVerificationTools({
  semanticLayerService: scopedSemanticLayerService,
  warehouseCatalog: new WarehouseCatalogService({ fileStore, projectDir }),
  dialects: getDialectForDriver,
  allowedConnectionNames: slConnectionIds,   // reuse existing scoping
  sqlExecutionRowLimit: 100,
});
// Merge `entity_details`, `sql_execution`, `discover_data` into both stage tool maps
// alongside emit_unmapped_fallback.
```

`createWarehouseVerificationTools` returns `Record<string, Tool>` with three keys. The set is wired into every adapter's synthesis stage - no per-adapter opt-in.

## Skill-prompt updates

### Shared protocol

`packages/context/skills/_shared/identifier-verification.md`:

```md
## Identifier Verification Protocol

Before writing a wiki page or SL source on any topic:
1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw tables
   already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
SL source, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:
2. `entity_details({connectionName, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and sampleValues.
3. For literal values from the source (status codes, plan tiers): check whether
   they appear in `entity_details`' `sampleValues` for the relevant column.
   If `sampleValues` is short or you suspect the sample missed real values, run
   a `sql_execution` probe: `SELECT DISTINCT <col> FROM <ref> LIMIT 50`.
4. If the candidate identifier still doesn't resolve, do one of:
   (a) Use `sql_execution` with `SELECT 1 FROM <ref> LIMIT 0`. If it errors,
       the identifier is fictional.
   (b) Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body,
       citing the exact raw path that mentioned it.
   (c) When recording `emit_unmapped_fallback` with `no_physical_table`,
       include the failing probe error in `clarification`.
5. Never copy `<schema>.<table>` placeholder strings from these instructions
   into output.
```

Each affected skill inlines this block verbatim (skill files are independent prompts; KTX has no cross-skill include mechanism today).

### Per-skill diffs

Two skills are deliberately excluded from updates: `ingest_triage` (read-only triage; produces no wiki or SL output) and `sl` (umbrella reference doc; cross-links to the protocol but doesn't need its own copy).

| Skill | Changes |
|---|---|
| `notion_synthesize` | Inline protocol; append `discover_data`, `entity_details`, `sql_execution` to `Allowed:` (line 74); replace `orbit_analytics.customer` example on line 70 with `<schema>.<table>` |
| `dbt_ingest` | Inline protocol; line 24: replace `wiki_sl_search` → `discover_data` and `sl_describe_table` → `entity_details`; strengthen the "not permission to invent physical columns" paragraph by naming `entity_details` as the verification call |
| `lookml_ingest` | Inline protocol; add: "Verify each `sql_table_name` from the LookML view with `entity_details` before mapping to an SL source" |
| `looker_ingest` | Inline protocol; add: "For every Looker field reference, call `entity_details` on the underlying `(schema, table, column)` before promoting to `sl_refs` or quoting in wiki body" |
| `metabase_ingest` | Inline protocol; add: "Before writing a wiki page derived from a Metabase question's SQL, verify each `schema.table.column` mentioned with `entity_details`" |
| `metricflow_ingest` | Inline protocol; add: "Verify each MetricFlow model's source table with `entity_details` before producing the corresponding `sl_write_source`" |
| `live_database_ingest` | Inline protocol; add: "Sample values come from the scan record; do not invent values not present in `relationship-profile.json`" |
| `historic_sql_table_digest` | Shortened protocol focused on column attribution: "Only mention columns visible in the table's scan record. Use `entity_details({display})` if uncertain" |
| `historic_sql_patterns` | Inline protocol; add: "Every join column mentioned in pattern descriptions must be verified via `entity_details` for both sides of the join" |
| `knowledge_capture` | Inline protocol; update line 44: "First call `discover_data` to find existing wiki pages, SL sources, and raw tables on the topic" |
| `sl_capture` | Inline protocol; add: "Before `sl_write_source`, call `entity_details` on the target table to confirm column names and types match the YAML being written" |

### Cleanups beyond the four-tool addition

- `notion_synthesize/SKILL.md:70` - remove `orbit_analytics.customer` (placeholder).
- `packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts:67` - same example string in the Zod `.describe()` - replace with `<schema>.<table>`.
- `dbt_ingest/SKILL.md:24` - fix `wiki_sl_search` and `sl_describe_table` (neither tool exists in KTX).
- `packages/context/src/sl/tools/sl-warehouse-validation.ts:93` - inline error message references the non-existent `sl_describe_table`. Replace with `sl_read_source`.

## Testing strategy

### Unit tests

| Component | Tests |
|---|---|
| `getDialectForDriver` | Every supported driver returns a dialect; unknown driver throws with a clear list of supported drivers |
| `WarehouseCatalogService.getTable` | Reads and merges `tables/<b64>.json` and `relationship-profile.json`; returns `null` when no sync exists; returns `null` for unknown `(catalog, db, name)` |
| `WarehouseCatalogService.resolveDisplay` | Postgres 2-part display → `{catalog: null, db, name}`; BigQuery 3-part display → `{catalog, db, name}`; ambiguous 2-part on BigQuery returns candidates list; unknown displays produce closest-match candidates ordered by edit distance |
| `WarehouseCatalogService.searchByName` | Substring and token match; tiers (exact-name → token-match) ordered correctly; cache hit on second call within same instance |
| `entity_details` | Resolves `{display}` and structured inputs; reports "Not found" with candidates for unknown ref; reports "no scan available" distinctly when scan dir missing; truncates above 50 targets |
| `discover_data` | Three sections present when all three have hits; sections omitted when empty; `sourceName` inspect mode delegates to `sl_discover` and skips other sections; `allowedConnectionNames` scope honoured |
| `sql_execution` | `assertReadOnlySql` rejects each mutating verb; row-limit wrap visible in `wrappedSql`; connector errors surface verbatim with the failing SQL; rejects `connectionName` not in `allowedConnectionNames` |

### Integration tests

- Extend `packages/context/src/ingest/ingest-bundle.runner.test.ts` to verify the three new tools are present in both WU-stage and reconcile-stage tool maps and refuse out-of-scope `connectionName` values.
- New fixture-based test: stage a small `raw-sources/<conn>/live-database/<sync>/` directory with 2 tables + 1 enrichment profile, then call each tool through the runner's tool map and assert the markdown contains the expected fields. Uses the same fake-LLM harness as `notion.adapter.test.ts`.
- One end-to-end regression test reproducing the `orbit_analytics.customer` hallucination: a fake Notion page mentioning the fictional table is fed to the synthesis stage; the run produces a wiki page where the fictional name is wrapped in `[unverified - …]` or omitted, not promoted to `tables:` frontmatter.

### Prompt-bundling tests

Extend `packages/context/src/memory/memory-runtime-assets.test.ts`:

- Every skill in the synthesis-writers list embeds the verification-protocol block (assert by stable header text).
- Every such skill lists the three new tools when it has a `## Tools / Allowed` section, or mentions them inline in a workflow step otherwise.
- No skill file contains any of the banned strings: `orbit_analytics.customer`, `wiki_sl_search`, `sl_describe_table`.

### Performance guards

`WarehouseCatalogService` caches the per-connection table list per stage (one WorkUnit's lifetime). Tests assert second call is a cache hit. No DB index for `searchByName` in this iteration - linear scan over scan artefacts is acceptable up to ~50K columns. If volume warrants it later, a follow-up PR adds a SQLite FTS index.

## Rollout

Four mergeable PRs:

| PR | Lands |
|---|---|
| 1 | `getDialectForDriver` + `WarehouseCatalogService` + `entity_details` tool + wiring in `ingest-bundle.runner.ts` + unit/integration tests |
| 2 | `sql_execution` tool + tests + the `orbit_analytics.customer` regression test (which exercises protocol steps 4a/4c) |
| 3 | `discover_data` tool + tests |
| 4 | All 11 skill prompts updated with the verification protocol + the three cleanups + extended `memory-runtime-assets.test.ts` |

Skill prompts land last so they can reference the tools that already exist.

## Out of scope

- **Hard write-time validation in `wiki_write` / `emit_unmapped_fallback`.** A complementary spec covers regex-based identifier validation at the write boundary. Defence-in-depth - separate concern.
- **SQLite FTS index for `searchByName`.** Deferred until the linear scan benchmark fails.
- **`raw_schema_search` as a standalone tool.** `discover_data`'s raw section covers the concept-search case.
- **`semantic_query` in the synthesis toolset.** `semantic_query` will exist in KTX for the research/chat-time agent; it is deliberately excluded from synthesis because synthesis creates SL sources rather than queries them.
- **`dictionary_search`.** `entity_details` already returns per-column `sampleValues`; for the rarer "where does this literal live?" case, `sql_execution` is more accurate than a sampled-JSON scan.
- **UUID layer for tables/columns.** KTX deliberately stays string-keyed on `(connection, catalog, db, name)`.
