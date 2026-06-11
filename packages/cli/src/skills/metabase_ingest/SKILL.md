---
name: metabase_ingest
description: Convert Metabase questions, models, and metrics into ktx Semantic Layer source definitions. Covers result-metadata to KSL column type mapping, FK/PK detection, near-duplicate deduplication, pre-aggregation decomposition, join-graph connectivity, and how to react to priorProvenance from earlier ingest syncs. Load when the WorkUnit contains `cards/<id>.json` files under a Metabase bundle.
callers: [memory_agent]
---

# Metabase to ktx Semantic Layer

Each WorkUnit represents one Metabase collection's cards for one Metabase database (mapped to exactly one ktx connection). Every `cards/<id>.json` file carries the resolved SQL, result_metadata, card type, collection path, and referenced-card ids. The WU's `sync-config.json` tells you which sync mode is active and which selections apply. `databases/<id>.json` tells you the target ktx connection.

## Context format

Each card JSON looks like:
```json
{
  "metabaseId": 7,
  "name": "Daily orders",
  "description": "Orders by day",
  "type": "model",
  "databaseId": 42,
  "collectionId": 5,
  "resolvedSql": "SELECT ...",
  "templateTags": [{"name": "ref", "type": "card", "cardReference": 10}],
  "resultMetadata": [
    {"name": "day", "base_type": "type/DateTime", "semantic_type": "type/CreationTimestamp"},
    {"name": "order_count", "base_type": "type/Integer"}
  ],
  "collectionPath": ["Data", "Orders Team"],
  "referencedCardIds": [10]
}
```

Use `resultMetadata` to:
- Map `base_type` to KSL column type: `type/Integer`, `type/Float`, `type/Decimal`, `type/BigInteger` → `number`; `type/Text`, `type/TextLike` → `string`; `type/DateTime`, `type/Date`, `type/DateTimeWithTZ` → `time`; `type/Boolean` → `boolean`.
- Identify grain candidates: columns with `semantic_type: type/PK`.
- Identify join candidates: columns with `semantic_type: type/FK` plus `fk_target_field_id`.
- Identify time columns: `semantic_type: type/CreationTimestamp` or `type/UpdatedTimestamp` → set `role: time`.
- Use `display_name` for measure descriptions when available.

### Additional card metadata

- `parameters`: list of card-level parameters with widget types and defaults. When SQL resolution fell back to unresolved SQL, use this to drive Step A of the SQL-translation workflow (drop optional clauses): knowing each `{{ var }}` is `type: "date/range"` vs `type: "category"` tells you what kind of clause it is.
- `resultMetadata[i].field_ref`: Metabase's canonical reference to the source warehouse field. Shape `["field", <field_id>, <options>]`. When this is set, the column maps directly to a warehouse field, which is useful for declaring joins from FK metadata without re-parsing SQL.
- `lastRunAt`: ISO timestamp of the card's last execution. If null or very old, the card may be dead; prefer skipping over creating a source.
- `dashboardCount`: number of dashboards referencing the card. Cards with `dashboardCount: 0` and a stale `lastRunAt` are strong skip signals.

Before writing a wiki page derived from a Metabase question SQL, verify each
schema.table.column mentioned with entity_details.

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

## Decision tree

For each card:
1. Analyze `resolvedSql` + `resultMetadata`: identify base tables, aggregations, joins, filters, column types.
2. **REQUIRED before any write**: call `sl_discover` for every candidate target source name. The response tells you whether the name is manifest-backed (`Type: table` or `Type: sql`). For manifest-backed names you MUST use the overlay shape (`name:` plus overlay fields such as `measures:`, `segments:`, `descriptions:`, `joins:`, `disable_joins:`, `column_overrides:`, and computed-only `columns:` entries with `expr` + `type`; no `sql:`, `table:`, `grain:`, or base-table `columns:`); the tool will reject a standalone write and you'll have wasted the call. If `sl_discover` returns nothing for the name, you can write a standalone source. Also call `sl_read_source` on existing sources you intend to extend so you don't duplicate measures.
3. Include `rawPaths: ["cards/<id>.json"]` on every `sl_write_source`, `sl_edit_source`, and `wiki_write` call. If one artifact generalizes multiple near-duplicate cards, include each contributing card path and no unrelated cards.
4. Decide:
   - Simple aggregation on a table that already has a source → `sl_edit_source` to add a measure.
   - Join between tables that should be linked in the SL graph → `sl_edit_source` to add a join.
   - Complex derived SQL (CTEs, multi-layer aggregation, scoring models) → `sl_write_source` with `source_type: sql`. When the SQL projects/filters from a single manifest-backed base table, set `inherits_columns_from: <manifest_key>` so columns inherit type and description from the manifest - see `sl_capture` skill for the slim form. Use `sl_discover` to discover the manifest key from the table reference in the SQL (it accepts `MARTS.CONSIGNMENTS`, `ANALYTICS.MARTS.CONSIGNMENTS`, or `CONSIGNMENTS`).
   - New base table not yet in the semantic layer → `sl_write_source` with `source_type: table`.
   - Trivial query (`SELECT *`, simple `COUNT(*)` with no business logic) → do nothing; the runner will record this card as `action_type='skipped'`.
   - Duplicate of an existing measure → same as trivial; do nothing for this card.

**Manifest-only names need an overlay first.** If `sl_discover` shows a source name with `Type: table` but `sl_read_source` returns "Source not found", the source lives only in the schema manifest (no standalone overlay yet). `sl_edit_source` cannot edit manifest-only names, and a full standalone `sl_write_source` for that name would shadow manifest columns and joins. Bootstrap an overlay with `sl_write_source` using the overlay shape:

```yaml
name: <SOURCE_NAME>
measures:
  - name: <measure_name>
    expr: "<expression>"
```

Overlay shape: `name:` plus any of `measures:`, `segments:`, `descriptions:`, `joins:`, `disable_joins:`, `exclude_columns:`, `column_overrides:`, or computed-only `columns:` entries with `expr` + `type`. Never include `sql:`, `table:`, `grain:`, or base-table `columns:` on a manifest-backed name — those would shadow the manifest's schema and drop its joins. Use `column_overrides:` for inherited column descriptions. Overlay `joins:` are merged additively with the manifest's joins (deduped by `to` + `on`); use `disable_joins: ["<on-clause>"]` to suppress a specific manifest join. After the overlay exists, use `sl_edit_source` for further tweaks. See `sl_capture` skill for the canonical overlay rule.

**Join discovery:** When your card's SQL references warehouse tables (e.g. in `FROM` or `JOIN` clauses), call `sl_discover({ query: '<table>' })` before writing. The matching manifest entry's `name` is the value you use in `joins: [- to: <name>]` only when the card output exposes a local key that matches the target source grain (for example `account_id = mart_account_segments.account_id`). Do not declare a ktx join just because the card SQL joins that table internally. If the output only exposes display fields such as `account_name`, keep the SQL source self-contained or project the key before adding the join. Use `many_to_one` for FK-to-dimension joins, `one_to_many` for the reverse.

**Hard rule on join columns (prevents broken joins):** For every join you declare, the local column on the left of `on:` MUST be (a) present in your source's projected output and (b) a key/ID column, never a display value. If the natural FK isn't in your SELECT, add it to SELECT before declaring the join. Joining `account_name = mart_account_segments.account_id` is always wrong - names are not identifiers and the equality produces zero matches. The validator rejects this with a "display value to identifier" error; the tool will refuse to save it. Add `account_id` to your SELECT and join on `account_id = mart_account_segments.account_id`, or omit the join entirely.

## priorProvenance

If the WU prompt includes a `priorProvenance` section for a card, it tells you what happened on prior ingest syncs. Treat it as advisory:
- `action_type: source_created` on source X → prefer editing X with `sl_edit_source` rather than writing a new source.
- `action_type: measure_added` on source X → you already contributed to X; add only measures that aren't present.
- `action_type: subsumed` or `merged` → this card was folded into another source last time; unless its SQL has changed structurally, keep it subsumed (no new write).
- `action_type: skipped` → last time we decided not to ingest this card; re-read the SQL and confirm the decision still holds. If the card now has non-trivial business logic, ingest it.

## Deduplication

Before writing, scan all cards in this WU for near-duplicate groups - cards whose `resolvedSql` shares the same CTEs, base tables, joins, and aggregation structure but differs only in:
- Trailing filters (e.g. `date_trunc(week, date)` vs `date_trunc(month, date)`).
- Minor `WHERE` clause variations.
- Column aliases or output column subsets.
- Aggregation granularity (daily vs weekly vs monthly).

When you find a group of near-duplicates:
1. Create ONE generalized source from the most comprehensive card in the group.
2. Strip card-specific trailing filters from the SQL so the source covers all variants (e.g. keep daily grain instead of filtering to week/month).
3. If each card had a distinct measure or filter, add them as separate measures on the single source.
4. For all cards except the canonical one, do nothing - they'll be recorded as `action_type='skipped'` automatically by the runner.

Do NOT merge cards with fundamentally different business logic, even if they share CTEs.

## Pre-aggregation decomposition

When a card's `resolvedSql` contains `GROUP BY` with aggregation functions (`SUM`, `COUNT`, `AVG`, …):

1. **Detect**: simple aggregation on base tables/joins - `SELECT` with `GROUP BY`, no complex CTEs or window functions.
2. **Decompose**: strip the `GROUP BY` and aggregation functions. Keep `FROM`, `JOIN`, and `WHERE` intact.
3. **Expose row-level columns**: include the grouped-by columns AND the raw columns being aggregated (e.g. `money_out` instead of `SUM(money_out) AS total_money_out`).
4. **Define aggregations as measures**: convert each aggregation into a KSL measure (e.g. `sum(money_out)`).
5. **Add joins**: with FK columns now exposed, declare joins to dimension sources.

Exception: keep the pre-aggregated SQL when the query involves multi-CTE pipelines, window functions, or recursive logic where decomposition would lose business logic.

## SQL translation from raw native to KSL

Every card carries a `resolvedSql` field. Check the staged card's `resolutionStatus` first:

- `resolutionStatus: "resolved"` - `{{#N}}` references are inlined and `[[ ... ]]` optional clauses have been dropped locally. If the resolved SQL contains no other parameters the SQL is executable as-is. If the card had **required** (non-bracketed) `{{ var }}` placeholders, the SQL is prefixed with a placeholder-warning comment block listing every dummy substitution Metabase made - see "Step A" below.
- `resolutionStatus: "fallback"` - Metabase failed to resolve. The SQL still contains `{{#N}}`, `{{#N-name}} alias`, `{{ var }}`, and `[[ ... ]]` syntax. Do the translation steps below before writing a source.

### Step A - Handle dummy-substituted placeholders (resolved cards only)

When a card has a required `{{ var }}` outside any `[[ ]]` block, the resolver substitutes a **dummy value** purely so Metabase's parser will accept the query. The resulting SQL is prefixed with a comment like:

```sql
-- PLACEHOLDER_WARNING: this SQL was extracted from a Metabase card with
-- unbound template parameters. The placeholders below were substituted with DUMMY
-- values to satisfy Metabase's parser - they DO NOT represent intended filters.
-- Drop the corresponding clauses (or expose them as runtime SL filters) before
-- persisting this SQL as a semantic-layer source.
--   {{ auction_end }} (type=dimension, widget=date/all-options) → '2020-01-01~2020-12-31'
--   {{ status }} (type=text) → 'placeholder'
SELECT ...
WHERE start_date >= '2020-01-01' AND start_date < '2021-01-01' AND status = 'placeholder'
```

For each listed placeholder: locate the WHERE clause(s) in the SQL that reference the dummy literal and **drop them**, then strip the warning comment. SL chat-time filters compose narrowing predicates dynamically, so the source should represent the unfiltered dataset.

For `fallback` cards, dropping is simpler - the SQL still has the `[[ ... ]]` brackets and `{{ var }}` placeholders intact:

```sql
-- before:
WHERE 1=1
  [[AND {{ auction_end }} ]]
  [[AND status = {{ status }} ]]

-- after:
WHERE 1=1
```

### Step B - Inline `{{#N}}` references (fallback cards only)

Resolved cards already have `{{#N}}` inlined for you. For `fallback` cards, each `{{#N}}` (or `{{#N-some-slug}}`) in the SQL refers to another card's `resolvedSql`. The referenced card is in the WU's `rawFiles` or `dependencyPaths`. Read it with `read_raw_file`, then inline its SQL.

If the reference has an alias (`from {{#5996-listing-interactions}} tb`), the **outer** SQL probably uses that alias (`select tb.* ...`, `tb.column_name`, etc.). When you inline, you must EITHER:

1. **Pick a single base table inside the inlined SQL and rename its alias to the outer alias.** Useful when the inlined card is `SELECT * FROM listings JOIN ...` - set the LISTINGS alias to `tb` and `tb.*` keeps working in the outer query.
2. **Replace the outer alias references with explicit columns from the inlined SQL.** Useful when the inlined card has multiple JOINs and `tb.*` is ambiguous.

Never leave the outer alias dangling: after inlining, **grep your SQL for the outer alias name and rewrite or remove every reference**. A leftover `tb.*` with no `tb` table is the most common failure mode here.

### Step C - Inlining cleanup checklist

After Steps A and B, your SQL must:

- Contain no placeholder-warning comment, no `{{`, `}}`, `[[`, or `]]` characters anywhere.
- Reference no aliases that aren't defined inside the SQL itself.
- Be valid as a standalone subquery (the validator runs `SELECT * FROM (your_sql) LIMIT 1`).

If `resolutionStatus: "fallback"` and the SQL is still complex enough that you can't confidently translate it, **skip the card** rather than writing broken SQL. Call `emit_unmapped_fallback` with the staged card path as `rawPath`, `reason: "parse_error"`, `clarification: "metabase_sql_untranslated"`, and `fallback: "flagged"`.

## Join-graph connectivity

For `source_type: table`:
- Use FK columns (`semantic_type: type/FK`) to declare `many_to_one` joins to dimension sources.
- Match column names ending in `_id` against existing sources' grain columns.

For `source_type: sql`:
- The validator parses your SQL and rejects the write when a referenced manifest table has a viable projected local key but no declared `joins:` entry. Add the join only after confirming the output key and target grain match.
- If `sl_discover` resolves the table, it is not outside the manifest. Do not write an `unmapped-table-*` fallback for resolved `orbit_raw`, `mart`, or other manifest-backed sources just because they appear inside card SQL.
- If `sl_discover` cannot resolve a referenced table at all, write a single-line `wiki_write` with key `unmapped-table-<table_name>` and `rawPaths: ["cards/<id>.json"]` so the gap is documented, then call `emit_unmapped_fallback` with the staged card path as `rawPath`, `reason: "missing_target_table"`, `tableRef: "<table_name>"`, and `fallback: "wiki_only"`. Do not use this fallback if `sl_discover` resolved the table/source.

Joins on manifest-backed names compose: the manifest's joins are inherited automatically, and any overlay `joins:` are merged on top (deduped by `to` + `on`). Use `disable_joins: ["<on-clause>"]` in the overlay to suppress a specific manifest join. If `sl_discover` shows a manifest-backed source with `Joins: 0` and the warehouse FK metadata is genuinely absent, declaring application-level joins via the overlay is fair game - bootstrap with `sl_write_source` (overlay shape above), then refine via `sl_edit_source`.

## Cross-card references (`{{#N}}`)

Resolved cards (`resolutionStatus: "resolved"`) have these inlined for you. Unresolved cards (`resolutionStatus: "fallback"`) need manual handling - see "SQL translation from raw native to KSL" above.

## Provenance markers

Every SL source and wiki page you write carries HTML-comment provenance tags pointing to the `cards/<id>.json` files they derive from:

```yaml
# <!-- from: raw-sources/<connId>/metabase/<syncId>/cards/7.json -->
name: orders
...
```

If a source is derived from multiple cards (e.g. a generalized source for a near-duplicate group), emit one tag per contributing card.

## Quality standards

Source definitions must follow ktx-sl YAML conventions:
- `source_type`: `"table"` (physical table/view) or `"sql"` (arbitrary SQL / derived view).
- `table`: required when `source_type: "table"` (e.g. `"public.orders"`).
- `sql`: required when `source_type: "sql"`.
- `grain`: what one row represents (e.g. `[id]`, `[customer_id, product_id]`).
- `columns`: all columns with correct types (`string`, `number`, `time`, `boolean`).
- Time columns: mark with `role: time`.
- `joins`: use correct `relationship` types (`many_to_one` for FK→PK, `one_to_many` for reverse).
- `joins.on`: `local_column = TARGET_SOURCE.target_column` - the right side MUST include the target source name.
- `measures.expr`: aggregation expression (e.g. `"sum(amount)"`); optional `filter` for business rules; required `description`.

Measure naming: descriptive `snake_case` (e.g. `total_revenue`, `avg_order_value`).

## Rules

- Prefer adding measures to existing sources over creating new ones.
- Before editing, always `sl_read_source` the source to check for existing measures.
- Don't duplicate measures (same aggregation on the same column).
- If two measures differ only by a filter (e.g. `revenue` vs `paid_revenue`), they are distinct.
- Use the card's `name` + `description` to write meaningful measure descriptions.
- When multiple cards in a WU are near-duplicates, create ONE generalized source; the runner will skip the rest automatically.
- Process every card in the WU - don't stop early.
