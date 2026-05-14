---
name: looker_ingest
description: Extract durable KTX knowledge and semantic-layer contribution proposals from staged Looker runtime dashboard, Look, and explore JSON. Load for WorkUnits whose raw files are under explores/, dashboards/, or looks/.
callers: [memory_agent]
---

# Looker Runtime Ingest

Looker runtime ingest turns API-staged dashboards, Looks, and explores into durable KTX memory. Runtime entities are evidence. They are not themselves the final knowledge shape.

## Required Workflow

1. Read every `rawFiles` entry for the WorkUnit.
2. Read relevant `dependencyPaths` before making a decision. For dashboard and Look WUs this usually includes the referenced explore JSON, signal files, `folders/tree.json`, and `users/<id>.json`.
3. Treat `signals/*.json`, owners, folders, schedules, and favorites as prioritization or provenance context only.
4. Extract generalizable metric formulas, segment definitions, field semantics, and domain conventions.
5. Use `wiki_search`, `sl_discover`, and `sl_read_source` before writing so new content merges with existing memory instead of duplicating it.
6. Use `context_evidence_search` or `context_evidence_read` to obtain evidence chunk IDs for any wiki-bound knowledge candidate.
7. Use `context_candidate_write` for durable wiki-bound knowledge. Do not call `wiki_write` from a Looker WorkUnit; Stage 4 reconciliation promotes candidates and writes wiki pages.
8. Use `looker_query_to_sl` for each Look query or dashboard tile query that has a `query` object.
9. Write SL from Looker runtime evidence only through the staged warehouse target contract. For explores and inherited dashboard/Look queries, branch on `targetTable.ok`; when it is true, write on `targetWarehouseConnectionId` and use `targetTable.canonicalTable` as `source.table`. When it is false or missing, write wiki knowledge candidates and record `emit_unmapped_fallback` with the staged reason.
10. Run `sl_validate` after every SL write. If validation fails, fix the source or roll it back before the WorkUnit ends.

For every Looker field reference, call entity_details on the underlying
schema.table.column before promoting it to sl_refs or quoting it in wiki body.

## Identifier Verification Protocol

Before writing a wiki page or SL source on any topic:

1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw
   tables already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
SL source, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionId, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues.
3. For literal values from the source, such as status codes or plan tiers,
   check whether they appear in `entity_details` sampleValues for the relevant
   column. If sampleValues is short or the sample may have missed real values,
   run a `sql_execution` probe with the same warehouse connection id:
   `sql_execution({connectionId, sql: "SELECT DISTINCT <col> FROM <ref> LIMIT 50"})`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution({connectionId, sql: "SELECT 1 FROM <ref> LIMIT 0"})`.
     If it errors, the identifier is fictional.
   - Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body,
     citing the exact raw path that mentioned it.
   - When recording `emit_unmapped_fallback` with `no_physical_table`, include
     the failing probe error in `clarification`.
5. Never copy `<schema>.<table>` placeholder strings from these instructions
   into output.

## Explore WorkUnits

Explore WUs have raw files like `explores/<model>/<explore>.json` and usually depend on `lookml_models.json`.

Use the deterministic API-derived source key:

```text
looker__<model>__<explore>
```

For example, `modelName: "b2b"` and `exploreName: "sales_pipeline"` map to `looker__b2b__sales_pipeline`.

Mapped explore write shape:

```json
{
  "connectionId": "22222222-2222-4222-8222-222222222222",
  "sourceName": "looker__b2b__sales_pipeline",
  "source": {
    "name": "looker__b2b__sales_pipeline",
    "table": "proj.dataset.opportunities",
    "grain": ["opportunity_id"],
    "columns": [
      {
        "name": "opportunity_id",
        "type": "string"
      },
      {
        "name": "arr",
        "type": "number"
      }
    ],
    "measures": [
      {
        "name": "total_arr",
        "expr": "sum(arr)"
      }
    ]
  }
}
```

Every concrete value in that example must be backed by raw Looker field SQL, `source_tables` preflight, `source_columns`, or existing SL when applied to a real WorkUnit. If the evidence is not present, write wiki candidates and emit `emit_unmapped_fallback`.

The staged explore file carries warehouse target fields populated before the WU starts:

- `connectionName`: the Looker runtime connection name.
- `targetWarehouseConnectionId`: the resolved warehouse connection id, or `null` when the Looker connection is unmapped.
- `rawSqlTableName`: Looker's verbatim `sql_table_name`. Keep it as provenance only.
- `targetTable`: the parsed target-table union. Use this as the sole branch condition.

When `targetTable.ok === true`, the explore has a complete KTX backing target. Before writing:

1. Use `targetTable.catalog`, `targetTable.schema`, and `targetTable.name` for `source_tables` preflight matching through `sl_discover` or `sl_read_source`.
2. Use Looker field `sql`, labels, descriptions, and type metadata to derive source columns, measures, segments, joins, and grain.
3. Call `sl_write_source` or `sl_edit_source` with `connectionId: targetWarehouseConnectionId` and `rawPaths` set to the staged explore path.
4. Set `source.name` to the deterministic API-derived source key, for example `looker__b2b__sales_pipeline`.
5. Set `source.table` to `targetTable.canonicalTable`.
6. Run `sl_validate` after every SL write.

The `table` field is `targetTable.canonicalTable`, not `rawSqlTableName`. Raw Looker values can contain aliases such as `schema.table AS x`, Looker templates such as `${TABLE}`, or derived-table SQL. Those raw forms do not compose safely with SL generation. `targetTable.canonicalTable` is the dialect-quoted identifier rebuilt by the parser.

Use `targetTable.{catalog,schema,name}` only for source_tables preflight. Do not put those tuple fields separately into the SL source unless the SL schema already asks for them.

When `targetTable.ok === false`, keep the WU wiki-only for SL purposes. Capture durable domain semantics with `context_candidate_write`, then emit a fallback with the EXACT structured `reason` code from `targetTable.reason`. Put any human-readable context in `clarification`, NOT in `reason`:

```json
{
  "rawPath": "explores/b2b/sales_pipeline.json",
  "reason": "no_connection_mapping",
  "clarification": "Looker connection b2b_sandbox_bq is not mapped to a warehouse connection",
  "fallback": "wiki_only"
}
```

Valid `reason` codes (use exactly one, no other strings allowed): `no_connection_mapping`, `looker_template_unresolved`, `derived_table_not_supported`, `no_physical_table`, `multiple_table_references`, `unsupported_dialect`, `parse_error`, `missing_target_table`.

When `targetTable` is `null`, read the raw explore file again. If the target is still absent, emit the same fallback with `"reason": "missing_target_table"`.

## Look And Dashboard WorkUnits

Looks have raw files like `looks/<id>.json`. Dashboards have raw files like `dashboards/<id>.json`. Dashboard tiles with inline `query` objects follow the same decision rules as Looks.

For each query:

1. Call `looker_query_to_sl` with the query JSON, title, content type, and usage counts if available.
2. Read the proposal's `targetStatus`, `targetWarehouseConnectionId`, `targetTable`, `sourceTable`, and `canWriteStandaloneSource`.
3. If `canWriteStandaloneSource` is true, use `targetWarehouseConnectionId` for SL tools and `sourceTable` / `targetTable.canonicalTable` as the source table. Verify the proposal against the parent explore dependency and existing SL before writing.
4. If the proposal decision is `measure_added`, add or edit a measure only after verifying the expression against the explore field SQL or an existing source column.
5. If the proposal decision is `source_created`, create a source only when `canWriteStandaloneSource` is true and the filter is canonical. Use `source.table = targetTable.canonicalTable`.
6. If `targetStatus` is `unmapped`, `unparseable`, or `missing_target_table`, keep SL wiki-only for this query and call `emit_unmapped_fallback` with the proposal's target reason or status.
7. If the proposal decision is `wiki_only`, write a context candidate only when the Look or dashboard names a reusable business concept.

## Capture Rules

Write SL for:

- reusable aggregations with clear formulas;
- reusable segment predicates that appear canonical;
- calculated dimensions that are stable and backed by raw Looker query evidence;
- joins or source relationships that are explicit in the explore JSON.

Write wiki for:

- metric definitions in dashboard or Look titles, descriptions, axis labels, and filter semantics;
- business meaning of an explore;
- concept aliases used by teams;
- caveats about multiple competing definitions.

Skip:

- point-in-time values and chart screenshots;
- dashboard layout, tile positions, colors, visualization types, and render settings;
- owner names, top users, recipient counts, favorite counts, schedules, and usage counts as narrative content;
- ad-hoc low-usage queries with no durable business semantics;
- simple saved views of fields with no metric, segment, or concept definition.

## Usage Signals

Use usage only to prioritize:

- zero or near-zero usage lowers priority and often means skip;
- high usage raises confidence that a metric or segment is canonical;
- schedules and favorites can break ties between otherwise similar candidates.

When calling `context_candidate_write`, usage can affect scoring:

- High usage (`queryCount30d >= 10` or `uniqueUsers30d >= 3`) can justify `authorityScore: 3` and `reuseScore: 3` when the evidence is otherwise durable.
- Zero recent usage should usually use `actionHint: "skip"` or lower `reuseScore` unless the content clearly defines a canonical business concept.
- Schedules and favorites can raise `reuseScore` by 1 when deciding between otherwise similar candidate scores.

Never include the usage counts themselves in `assertion`, `rationale`, or eventual wiki prose.

Never write usage numbers, owner names, folder names, top users, schedule counts, or recipients into wiki article prose. If attribution is needed, keep it in provenance through the normal ingest action trail.

## Provenance And Cross-References

When writing candidates from Looker evidence, cite chunk IDs from `context_evidence_search` or `context_evidence_read`. Stage 4 reconciliation writes wiki pages from promoted candidates and sets `sl_refs` when the source exists or was created in the run.

When an SL action is written on `targetWarehouseConnectionId`, the runner records `targetConnectionId` on the action and syncs `knowledge_sl_refs` to the warehouse connection. The wiki article still belongs to the Looker run connection; the SL ref belongs to the warehouse. Do not rewrite the source name or connection id in wiki frontmatter by hand. Use normal SL tool calls and let Stage 4 reconcile refs from actions.

Use these source-key conventions:

- API-derived explore source: `looker__<model>__<explore>`
- API-derived segment source: `looker__<explore>__<slug>`
- File-adapter source, when present: `<model>__<explore>` without the `looker__` prefix

During Stage 4 reconciliation, when both `looker__<model>__<explore>` and `<model>__<explore>` exist for the same connection, treat the unprefixed file-adapter source as canonical. Rewrite wiki `sl_refs` to the unprefixed source, remove the API-derived source if it was created in this run, and call `emit_artifact_resolution` with `actionType: "subsumed"`, `artifactKind: "sl"`, `artifactKey: "looker__<model>__<explore>"`, and the raw explore path that produced it.

If a file-adapter source already exists and clearly subsumes the API-derived source, prefer the file-adapter source in `sl_refs` and mention the API entity only as evidence in the wiki content.

## Examples

Measure proposal from a Look:

```json
{
  "title": "Open Pipeline ARR",
  "query": {
    "model": "b2b",
    "view": "sales_pipeline",
    "fields": ["opportunities.arr", "opportunities.stage"],
    "filters": { "opportunities.stage": "open" }
  }
}
```

Expected handling:

- call `looker_query_to_sl`;
- verify `opportunities.arr` and `opportunities.stage` against the explore dependency and existing SL;
- add or update a measure only if the resulting expression validates;
- write wiki for the durable definition "open pipeline ARR" if it is not already captured;
- avoid mentioning query counts or users in wiki prose.

Simple saved view:

```json
{
  "title": "Accounts By Region",
  "query": {
    "model": "b2b",
    "view": "accounts",
    "fields": ["accounts.region", "accounts.segment"],
    "filters": {}
  }
}
```

Expected handling:

- no SL write;
- wiki only if the title or description defines a reusable company concept;
- otherwise skip.
