---
name: sl_capture
description: How to capture new reusable patterns into KTX's semantic layer — when a measure, segment, or join belongs in the catalog and how to write it generically so it stays small and useful over time. Loaded by the post-turn memory-agent only. The research agent does not write to the SL.
callers: [memory_agent]
---

# Semantic Layer — Capture

This skill covers **when** and **how** to capture new patterns into the semantic layer. For schema reference and query grammar, load the `sl` skill first.

When the current turn produces a reusable pattern (business metric, derived view, join pattern, computed dimension), capture it so future queries can reach for it instead of rediscovering it.

## SQL dialect

The user-facing prompt includes a `Warehouse:` line under the SL Sources index
(e.g. `Warehouse: BIGQUERY`). All `expr` strings — measure expressions, segment
predicates, computed-column SQL — execute on that warehouse and must use its
syntax. Date arithmetic in particular varies by dialect:

- **BigQuery**: `transaction_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)` (when the column is `TIMESTAMP`); `event_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)` (when `DATE`).
- **Postgres / Redshift**: `transaction_date >= current_date - interval '90 days'`.
- **Snowflake**: `transaction_date >= dateadd(day, -90, current_timestamp())`.

Match the column's manifest type (`type: time` → TIMESTAMP/DATETIME on the
warehouse) — comparing TIMESTAMP to a DATE-arithmetic result fails on
BigQuery. After every `sl_edit_source`/`sl_write_source`, the inline validator runs a
`LIMIT 1` warehouse probe per measure and surfaces dialect mismatches; if
you see an error trailer, fix the expression and retry rather than leaving
the source for the post-squash gate to revert.

## What's worth capturing

- Business metric aggregations (ARR, MRR, revenue, churn, retention, conversion, LTV, CAC).
- Derived calculations combining multiple signals (risk scores, health scores, composite KPIs).
- Multi-table join patterns producing a reusable analytical view.
- Computed categories or flags useful as reusable dimensions (`case when num_protocols >= 3 then 'power' else 'regular' end`).
- Missing joins between two sources that both exist but aren't connected in the join graph.

Skip:
- Simple `SELECT * LIMIT 10` previews.
- Trivial `COUNT(*)` on one table with no business filtering.
- One-off ad-hoc explorations unlikely to repeat.
- Equivalent measures that already exist (cite the existing one as `source.measure_name`).

When in doubt, capture. Measures are easy to remove but impossible to recover from a lost conversation.

## Generalization rules

The SL must stay small and general over time. Before adding a measure, decide whether it belongs as a generic pattern or a specific constant.

**Prefer one generic measure with query-time filters over N hardcoded variants.**

Anti-pattern:
```yaml
- name: revenue_us_region
  expr: sum(case when region = 'US' then amount end)
- name: revenue_eu_region
  expr: sum(case when region = 'EU' then amount end)
```

Preferred:
```yaml
- name: total_revenue
  expr: sum(amount)
```
Callers filter `region = 'US'` at query time.

**Bake constants in only when the filter has named business meaning that won't change** (`enterprise_arr` for a contractually defined tier), cannot be expressed via the source's dimensions, or comes from a regulated/fixed list.

**Time anchors and value lists belong in callers' filters, not in measure expressions or source SQL.**
- Anti-pattern (date anchor inlined): `expr: count(distinct case when transaction_date >= '2026-04-12' then customer_id end)` — the date will need editing every time the question shifts, and every reader has to discover it.
- Anti-pattern (value list inlined in source SQL): `WHERE product_category_1 IN ('Testosterone', 'Weight Loss', …)` — locks the source to today's catalog and blocks callers from broadening or narrowing.
- Preferred: a generic measure (`count(distinct customer_id)`) plus either a named segment that captures the *meaning* of the anchor (`gh_new_products_since_launch`) or a query-time filter. Callers compose; the source stays small.
- A date is durable to bake in only when it represents a regulatory cutover, a contractually fixed boundary, or a one-time event that reshapes how the source itself is read.

**If you create a segment whose expr matches a measure's filter, the measure MUST reference the segment via `segments: [segment_name]` rather than re-inlining the predicate.** This is the canonical pattern even with a single measure — duplicating the predicate inline defeats the purpose of naming it.

Anti-pattern:
```yaml
segments:
  - name: engaged_subscriber
    expr: "is_paid = true AND <date-window-90-days-on-transaction_date>"
measures:
  - name: engaged_subscriber_count
    expr: "count(distinct case when is_paid = true and transaction_date >= current_date - interval '90 day' then admin_user_id end)"
```

Preferred:
```yaml
segments:
  - name: engaged_subscriber
    expr: "is_paid = true AND <date-window-90-days-on-transaction_date>"
measures:
  - name: engaged_subscriber_count
    expr: "count(distinct admin_user_id)"
    segments: [engaged_subscriber]
```

**Use computed dimensions for derived categories.** A flag like `is_power_user` belongs on `columns[]` with `expr`, not inlined into every measure.

**Extract repeated filter bundles into named segments.** If the same predicate appears on multiple measures of the same source, lift it to a `segments[]` entry and have each measure reference it. One edit updates every measure that depends on it.

**Never write a standalone file on a manifest-backed name.** If `sl_discover({ query: "<table-or-source-name>" })` finds an existing schema for that name, you MUST write an overlay (`name:` + `measures:`/`segments:`/`descriptions:` only — no `sql:`, `table:`, `grain:`, `columns:`, `joins:`). A standalone with `sql:` or `table:` on a manifest-backed name clobbers the inherited columns and joins; `sl_write_source` and `sl_validate` both reject this shape with a clear fix hint. Always run `sl_discover` before your first write on any existing name.

**Prefer overlay decomposition over standalone SQL sources.** Before reaching for `source_type: sql`, check whether the metric decomposes into measures on existing overlays (including cross-source derived measures). Use `source_type: sql` only when:
- The metric requires per-user/per-entity derivation that cannot be expressed as a single `expr` (e.g., `EXISTS` over a time-windowed subset), OR
- The metric requires multi-step CTEs whose intermediate grain is not a column in any existing source.

When an `sql` source is unavoidable, note in its `descriptions` map which SL gap forced the choice so it can be retired once the primitive ships. It must target a name NOT in the manifest — pick a distinct one (e.g. `mrr_waterfall_rollup`, not `fct_orders`).

## Slim standalone sources via `inherits_columns_from`

When a standalone SQL source filters or projects from a single manifest-backed base table (the common pattern for derived views like `aav_consignments` over `MARTS.CONSIGNMENTS`), set `inherits_columns_from:` to the base table's manifest key and list only column **names** in `columns:`. Compose-time enrichment fills `type`, `descriptions`, and `role` from the matching manifest column.

Discover the manifest key with `sl_discover` — pass the bare name (`CONSIGNMENTS`), the fully-qualified path (`ANALYTICS.MARTS.CONSIGNMENTS`), or any suffix; the tool resolves all forms and prints the canonical key in its output.

```yaml
name: aav_consignments
descriptions:
  user: AAV consignments — filtered view of MARTS.CONSIGNMENTS for the auto-auction-vaulting channel.
source_type: sql
sql: |
  SELECT CONSIGNED_ITEM_ID, CASH_ADV_AMOUNT, ALT_VALUE_COMBINED, my_derived_flag
  FROM MARTS.CONSIGNMENTS
  WHERE IS_AUTO_AUCTION_VAULTING_SUBMISSION = TRUE
    AND IS_CARD_SHOW_SUBMISSION = FALSE
    AND CONSIGNMENT_CANCELED_FLAG = FALSE
inherits_columns_from: CONSIGNMENTS
grain: [CONSIGNED_ITEM_ID]
columns:
  - { name: CONSIGNED_ITEM_ID }      # type/descriptions inherited from manifest
  - { name: CASH_ADV_AMOUNT }
  - { name: ALT_VALUE_COMBINED }
  - { name: my_derived_flag, type: boolean, expr: "CASH_ADV_AMOUNT > 0", descriptions: { user: "Computed locally — has any cash advance." } }
measures:
  - name: total_cash_advance
    expr: sum(CASH_ADV_AMOUNT)
```

Rules:

- Inheritance fills only **blank** fields. If you set a `description` locally, it wins — useful when the base description is misleading in the filtered view.
- A column not in the manifest (a derived/aliased column, or one from a different table in a `JOIN`) needs its own `type` and `description` declared.
- If `inherits_columns_from` doesn't resolve, the source still loads, but every column without a type triggers a validator error on the warehouse probe — `sl_discover` first to confirm the key.
- Don't use `inherits_columns_from` for sources backed by `table:` (those should be overlays — see the rule against shadowing the manifest above).

## Refinement — replace, don't append

When the user corrects a prior answer, the existing measure is wrong by the user's own standard. Replace it, don't add a parallel measure.

Signals that the current turn is a refinement:
- "no, I meant...", "actually use X", "exclude Y", "wait, by X I mean Z".
- Pushback on a prior result ("that's wrong because...", "this should be higher").
- Redefinition of a term used in an existing measure.

Distinguishing question: *would the prior measure still be correct for someone else asking the prior question?* If no → replace. If yes → add.

## Edit SL vs document in wiki

If the user explicitly names an SL artifact and asks to change it, the primary
action is always an SL tool call. Examples:

- "edit the source", "edit the YAML", "edit `fct_intakes.yaml`" → `sl_edit_source` or
  `sl_write_source`.
- "refine the measure", "change the filter on `active_users`", "fix the expr",
  "add `is_test = false`" → `sl_edit_source` on the source that owns the measure.
- "don't create a new one, update the existing" → `sl_edit_source` (never `sl_write_source`
  with a new source name; never `wiki_write` as the only action).

A wiki update may ALSO make sense in the same turn (owner note, lineage,
caveat), but it is never a substitute for editing the YAML when the user's
request is about changing the measure/source definition itself.

Wiki-only is correct when the user is documenting *about* the measure
(definition in business terms, owner, policy, glossary, examples of when to
use it) without changing its SQL expression or filters.

Before sl_write_source, call entity_details on the target table to confirm
column names and types match the YAML being written.

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

## Tool sequence

1. `sl_discover` — see what source files exist.
2. `sl_discover({ query: "<table-or-source-name>" })` — **REQUIRED before the first write on any name**. Shows columns/joins/grain from the manifest. If the call returns a schema, you MUST write an overlay, not a standalone. Skipping this is the #1 cause of accidentally shadowing the manifest.
3. `sl_read_source({ connectionId, sourceName })` — read the raw YAML before editing.
4. For modifications: `sl_edit_source({ connectionId, sourceName, yaml_edits: [{ oldText, newText, reason }] })` with exact-string replacements. `oldText` must match exactly and be unique in the file.
5. For new sources or full rewrites: `sl_write_source({ connectionId, sourceName, source })` with the full structured source definition.
6. For join discovery: use `sql_execution({connectionId: "warehouse", sql: "SELECT count(*) FROM public.orders o JOIN public.customers c ON c.id = o.customer_id LIMIT 20"})` with the target warehouse connection id and dialect-correct table names to verify the join key exists in both tables and assess cardinality before declaring the join.
7. Cross-reference knowledge: author the edge once on the **wiki** side via `sl_refs: [source_name]` in the page's front-matter. The reverse edge (wiki pages that cite an SL source) is derived automatically by the reconciler — do not add a `knowledge_refs:` field to SL YAMLs.
8. `sl_validate` — run after writing or editing to surface schema issues, duplicate measure names, and cross-source validation errors. Read-only; the writes are already committed (the squash-at-end flow will collapse them into one commit).

## Editing patterns

- **`sl_edit_source`** is the workhorse for additive changes: add a measure, add a join, tweak a description, replace a filter. Cheap, targeted, preserves the rest of the file.
- **`sl_write_source`** is for brand-new sources or when the entire file needs restructuring. It overwrites the file completely.
- Do NOT modify existing measures or their descriptions unless the current turn explicitly corrects them.
- During bundle/external ingest, include `rawPaths` on every `sl_write_source`/`sl_edit_source` call with only the raw files that directly support the SL action.

## Worked example — additive overlay

Conversation:
- User: "What was the average order value last quarter?"
- Assistant fell back to SQL: `SELECT AVG(amount) FROM orders WHERE order_date >= ...`

Existing index: `orders [measures=0, joins=0] — candidate for enrichment`.

```
sl_discover()
  → orders.yaml does not exist yet
sl_discover({ query: "orders" })
  → see grain, columns, no current overlay
sl_write_source({
  connectionId: "warehouse",
  sourceName: "orders",
  source: {
    name: "orders",
    measures: [{
      name: "avg_order_value",
      expr: "avg(amount)",
      description: "Mean order transaction amount - filter by product_category at query time"
    }]
  }
})
sl_validate({ connectionId: "warehouse" })
  → clean
```

The overlay only contains `name` and `measures` — no columns, grain, or table. Those are inherited from the manifest.

## Worked example — refinement (replace)

Prior turn:
- [user] "How many active users do we have per region?"
- [assistant] "… used `count(*) filter: last_login_at > now() - interval '30 days'`"

Current user: "Wait, by 'active' I mean users who have placed an order in the last 30 days, not just logged in."

The existing `users.active_count` measure is wrong by the new definition.

```
sl_read_source({ connectionId: "warehouse", sourceName: "users" })
  → see the wrong measure
sl_edit_source({
  connectionId: "warehouse",
  sourceName: "users",
  yaml_edits: [{
    oldText: "  - name: active_count\n    expr: \"count(*)\"\n    filter: \"last_login_at > now() - interval '30 days'\"\n    description: Users who logged in within the last 30 days",
    newText: "  - name: active_count\n    expr: \"count(distinct case when last_order_at > now() - interval '30 days' then user_id end)\"\n    description: Users with at least one order in the last 30 days"
  }]
})
sl_validate({ connectionId: "warehouse" })
```

If you only added a new measure, the old incorrect `active_count` would stay and future queries would keep answering the wrong question.

## Worked example — new join

Prior turn: user asked to correlate LTV with protocol count; assistant joined `fct_orders` with `fct_mau_multiprotocol` on `admin_user_id` in raw SQL.

```
sl_read_source({ connectionId: "warehouse", sourceName: "fct_orders" })
  → no joins section yet
sql_execution({
  connectionId: "warehouse",
  sql: "SELECT COUNT(*), COUNT(DISTINCT a.admin_user_id) FROM public.fct_orders a JOIN public.fct_mau_multiprotocol b ON a.admin_user_id = b.admin_user_id LIMIT 1"
})
  → confirms cardinality (many orders per MAU row = many_to_one)
sl_edit_source({
  connectionId: "warehouse",
  sourceName: "fct_orders",
  yaml_edits: [{
    oldText: "measures:",
    newText: "joins:\n  - to: fct_mau_multiprotocol\n    on: admin_user_id = fct_mau_multiprotocol.admin_user_id\n    relationship: many_to_one\nmeasures:"
  }]
})
sl_validate({ connectionId: "warehouse" })
```

Always verify joins with `sql_execution` before adding them.

## Rules recap

- Read existing sources before editing (`sl_read_source` or `sl_discover`).
- Prefer overlays over standalone sources on manifest-backed tables.
- Prefer generic measures + query-time filters over per-value variants.
- Time anchors and value lists belong in callers' filters, not in measure expressions.
- A measure whose filter matches a segment MUST reference the segment via `segments: [name]`.
- Extract repeated predicates into named segments.
- Use computed dimensions for derived categories.
- When the user corrects a prior answer, replace — don't append.
- Always run `sl_validate` after writing to surface issues.
- If nothing is worth capturing, respond without calling any SL write tool.
