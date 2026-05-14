---
name: lookml_ingest
description: Map a LookML view/model/explore into KTX semantic layer sources. Covers the LookML to KTX primitive table, provenance tagging, and three worked examples (overlay, standalone from derived_table, standalone with sql_always_where). Load when the turn contains `.lkml` content.
callers: [memory_agent]
---

# LookML to KTX Semantic Layer

LookML views map to SL sources, `measure:` to measures, `explore: { join: }` to the join graph. This skill lays out the mapping and the three capture shapes.

## Mapping table

| LookML | KTX form | Notes |
|---|---|---|
| `view: X { sql_table_name: …; measure:/dimension:/join: }` | **Overlay** at `<connId>/X.yaml` with `measures`, computed-only `columns`, `column_overrides`, `joins`, `segments` | Manifest-backed; inherit grain/columns |
| `view: X { derived_table: { sql: … } }` | **Standalone** with top-level `sql:`, explicit `grain:` + `columns:` | No manifest entry exists |
| `view: X { sql_always_where: <p> }` | **Standalone** with `sql: SELECT * FROM <base> WHERE <p>` | Enforcement, not opt-in |
| `explore: { join: Y { sql_on: …; relationship: … } }` | `joins:` entry `{ to: Y, on: "<local> = Y.<col>", relationship: … }` | On the overlay or standalone |
| `conditionally_filter` / `always_filter` | `segments: [{ name, expr }]` | Callers reference by name |
| Manifest entry | `_schema/*.yaml` | **Never edit** — auto-imported |

Type map: `date`/`datetime`/`timestamp` → `time`; `yesno` → `boolean`; `number` → `number`; `string` → `string`. Ignore `drill_fields:` (UI only).

## Decision rules

LookML writes target the run connection directly. Unlike Looker runtime ingestion, the LookML adapter is configured on the warehouse KTX connection, so do not look for `targetWarehouseConnectionId` and do not route through a mapping array.

Before any SL write, inspect the WorkUnit notes.

If notes contain:

```text
[LOOKML SL WRITES DISALLOWED]
reason: lookml_connection_mismatch
...
[/LOOKML SL WRITES DISALLOWED]
```

this is a hard gate. The model's declared Looker `connection:` does not match the warehouse connection's configured `expectedLookerConnectionName`. Continue wiki extraction and context candidates. Do not call `sl_write_source` or `sl_edit_source` for that WorkUnit. The runner also removes those write tools for this WorkUnit; treat the missing tools as expected. Preserve the mismatch reason in any `emit_unmapped_fallback` you create.

When SL is allowed:

- **Overlay** when the view is a thin wrapper over a manifest table (`sql_table_name:` matches a manifest entry). Do not repeat base columns or grain.
- **Standalone** when the view uses `derived_table:` or `sql_always_where:`. `sl_write_source` rejects overlays whose name has no manifest entry; that error points here.
- **Skip** a view with only `view:`, `sql_table_name:`, and bare `dimension:` entries (no `measure:`, `description:`, `derived_table:`, `sql_always_where:`, `join:`). The pre-filter already short-circuits those.
- Include `rawPaths` on every `sl_write_source`/`sl_edit_source` call with the exact LookML raw file(s) that support the action.

## Preflight: never guess column names

LookML's `dimension_group: date { type: time; timeframes: [raw, date, week, month] }` expands at Looker-render time into `${view.date_raw}`, `${view.date_date}`, `${view.date_week}`, and so on. **These are NOT physical warehouse columns.** The physical column is whatever the group's `sql:` clause references (e.g. `${TABLE}.date` → column `date`).

A prior replay hallucinated `date_date`, `date_week` into `sql:`, `columns:`, and `grain:` across 4+ standalones; every measure on each affected source returned `400 Unrecognized name: date_date` at query time. Preventable.

Verify each sql_table_name from the LookML view with entity_details before
mapping to an SL source.

## Identifier Verification Protocol

Before writing a wiki page or SL source on any topic:

1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw
   tables already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
SL source, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionName, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues.
3. For literal values from the source, such as status codes or plan tiers,
   check whether they appear in `entity_details` sampleValues for the relevant
   column. If sampleValues is short or the sample may have missed real values,
   run a `sql_execution` probe with the same warehouse connection name:
   `sql_execution({connectionName, sql: "SELECT DISTINCT <col> FROM <ref> LIMIT 50"})`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution({connectionName, sql: "SELECT 1 FROM <ref> LIMIT 0"})`.
     If it errors, the identifier is fictional.
   - Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body,
     citing the exact raw path that mentioned it.
   - When recording `emit_unmapped_fallback` with `no_physical_table`, include
     the failing probe error in `clarification`.
5. Never copy `<schema>.<table>` placeholder strings from these instructions
   into output.

**Required flow before writing any overlay or standalone**:

1. Call `sl_discover({ query: "<tableName>" })` for each base table you're about to touch. That returns the real columns.
2. If the table isn't in the manifest, use the warehouse `connectionName`
   returned by `discover_data` or the target connection chosen from
   `sl_discover`, then call a dialect-appropriate SQL probe with that
   connection name, for example:
   `sql_execution({connectionName: "warehouse", sql: "SELECT 1 FROM analytics.orders LIMIT 0"})`.
   Replace `warehouse`, `analytics`, and `orders` with the verified connection,
   schema or dataset, and table from the WorkUnit evidence.
3. Use only those names in `sql:`, `columns:`, and `grain:`. Map each `dimension_group` to ONE `{ name: <physical_col>, type: time, role: time }` entry — never one per timeframe.

| LookML input | KTX `columns:` entry |
|---|---|
| `dimension_group: month { type: time; timeframes: [month]; sql: ${TABLE}.month_date ;; }` | `{ name: month_date, type: time, role: time }` |
| `dimension_group: date { type: time; timeframes: [raw, date, week, month]; sql: ${TABLE}.date ;; }` | `{ name: date, type: time, role: time }` — single entry, NOT `date_raw`/`date_date`/`date_week` |

**After every `sl_write_source`**: call `sl_validate`. It runs `SELECT * FROM (<your sql:>) LIMIT 0` against the connection. If a column name was invented, the warehouse's `Unrecognized name: …` error comes back verbatim. Treat that as a hard failure — re-read the real columns with `sl_discover` and rewrite.

## Provenance markers

When a wiki mixes LookML source prose with `sl_discover` output, tag sections:

```markdown
<!-- from: lookml -->
Customers fan out many-to-one into `accounts` via `account_id`.
<!-- /from -->
<!-- from: bq_schema -->
`customers.admin_user_id` is nullable — orphan rows exist.
<!-- /from -->
```

Invisible in most renderers; lets a future pass audit provenance.

## Example 1 — overlay (thin wrapper)

LookML (excerpt):

```lookml
view: fct_labs {
  sql_table_name: analytics.fct_labs ;;
  dimension: is_byol { type: yesno; sql: ${TABLE}.lab_type = 'byol' ;; }
  measure: count_lab_orders { type: count; description: "Total lab orders." }
  measure: count_byol_labs { type: count; filters: [is_byol: "yes"] }
}
explore: fct_labs {
  join: dim_customers { sql_on: ${fct_labs.admin_user_id} = ${dim_customers.admin_user_id} ;; relationship: many_to_one }
}
```

KTX overlay at `<connId>/fct_labs.yaml`:

```yaml
name: fct_labs
descriptions:
  user: "Lab-order fact table. One row per lab order event."
columns:
  - name: is_byol
    type: boolean
    expr: "lab_type = 'byol'"
measures:
  - name: count_lab_orders
    expr: count(lab_order_id)
    description: Total lab orders.
  - name: count_byol_labs
    expr: count(lab_order_id)
    filter: "is_byol = true"
joins:
  - to: dim_customers
    on: "admin_user_id = dim_customers.admin_user_id"
    relationship: many_to_one
```

## Example 2 — standalone from `derived_table`

```lookml
view: lab_results {
  derived_table: { sql:
    SELECT lab_order_id, admin_user_id, lab_date, biomarker, value,
           value - LAG(value) OVER (PARTITION BY admin_user_id, biomarker ORDER BY lab_date) AS delta
    FROM analytics.raw_lab_results WHERE status = 'final' ;; }
  dimension: lab_order_id { primary_key: yes; type: string }
  measure: avg_delta { type: average; sql: ${delta} ;; }
}
```

```yaml
name: lab_results
description: "Lab results with biomarker delta vs previous reading per user."
source_type: sql
sql: |
  SELECT lab_order_id, admin_user_id, lab_date, biomarker, value,
         value - LAG(value) OVER (PARTITION BY admin_user_id, biomarker ORDER BY lab_date) AS delta
  FROM analytics.raw_lab_results WHERE status = 'final'
grain: [lab_order_id]
columns:
  - { name: lab_order_id, type: string }
  - { name: admin_user_id, type: string }
  - { name: lab_date, type: time, role: time }
  - { name: biomarker, type: string }
  - { name: value, type: number }
  - { name: delta, type: number }
measures:
  - { name: count_lab_results, expr: "count(lab_order_id)" }
  - { name: avg_delta, expr: "avg(delta)" }
```

## Example 3 — standalone with `sql_always_where`

```lookml
view: rpt_daily_braze_email {
  sql_table_name: analytics.fct_email_sends ;;
  sql_always_where: ${TABLE}.channel = 'braze' AND ${TABLE}.status = 'delivered' ;;
  dimension: send_id { primary_key: yes; type: string }
  measure: delivered_count { type: count }
}
```

```yaml
name: rpt_daily_braze_email
description: "Delivered Braze email sends (enforced filter: channel='braze', status='delivered')."
source_type: sql
sql: |
  SELECT * FROM analytics.fct_email_sends
  WHERE channel = 'braze' AND status = 'delivered'
grain: [send_id]
columns:
  - { name: send_id, type: string }
  - { name: admin_user_id, type: string }
  - { name: sent_at, type: time, role: time }
measures:
  - { name: delivered_count, expr: "count(send_id)" }
```

`sql_always_where` is enforcement → wrap into the `sql:`. Don't model it as a segment (segments are opt-in) or per-measure filter (fragile, duplicated).
