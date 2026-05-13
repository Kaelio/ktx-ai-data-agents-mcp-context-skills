---
name: sl
description: KTX's semantic layer — a structured catalog of sources (tables/views), measures, joins, and segments expressed as YAML. Covers the schema and how to query it via `semantic_query`. Use when the task involves querying pre-defined metrics (ARR, churn, retention, LTV, MAU) or reading SL source YAML to understand the catalog. Capture is handled by the `sl_capture` skill (memory-agent only).
---

# Semantic Layer

KTX's semantic layer (SL) is a structured catalog. Each **source** represents a table, a SQL view, or an overlay that enriches a manifest-backed table with measures, computed columns, joins, and named segments. The catalog is the single source of truth for reusable business metrics.

This skill covers two parts:
- **Part 1** — Schema reference (what an SL source looks like).
- **Part 2** — Querying via `semantic_query`.

Capture (when and how to add new patterns to the SL) is a separate concern handled by the memory-agent — see the `sl_capture` skill if you are running in capture mode. The research agent **reads** and **queries** the SL via the tools described here; it does not write to it.

For capture-time identifier verification, load `sl_capture`. Synthesis writer
skills must verify warehouse identifiers with `discover_data`,
`entity_details`, and `sql_execution` before emitting table or column names.

---

## Part 1 — Schema reference

An SL source is a YAML file at `semantic-layer/<connectionId>/<source_name>.yaml`. There are three flavors:

### Overlay sources

Enrich a manifest-backed table with measures, computed columns, joins, and segments. No `table` or `sql` field. The base table's columns and grain are inherited from the manifest.

```yaml
name: fct_orders           # must match an existing manifest table
descriptions:
  user: "Overlay adding business measures to the orders fact table."
measures:
  - name: total_revenue
    expr: sum(amount)
    description: Total order revenue — filter by status or region at query time
columns:                    # computed dimensions only
  - name: is_large_order
    type: boolean
    expr: "amount > 1000"
segments:
  - name: paid_non_refunded
    expr: "is_paid = true AND is_refunded = false"
joins:
  - to: customers
    on: "customer_id = customers.id"
    relationship: many_to_one
```

Rules:
- Do **not** repeat base-table columns, grain, `table`, or `source_type` in an overlay — those are inherited.
- Overlay columns MUST be computed (`expr` + `type`).
- `exclude_columns` hides specific manifest columns; `disable_joins` suppresses specific auto-detected joins.

### Standalone table sources

Self-contained; own their schema. Has `source_type: table` and `table:`.

```yaml
name: account_health_scores
source_type: table
table: "analytics.account_health_scores"
grain: [account_id, snapshot_date]
columns:
  - name: account_id
    type: string
  - name: snapshot_date
    type: time
    role: time
  - name: health_score
    type: number
measures:
  - name: avg_health_score
    expr: avg(health_score)
```

### Standalone SQL sources

Self-contained; schema derived from a SQL query. Has `source_type: sql` and `sql:`.

```yaml
name: monthly_cancellations
source_type: sql
sql: |
  SELECT
    date_trunc('month', cancelled_at) AS month,
    customer_id,
    plan_name,
    mrr_amount
  FROM subscriptions
  WHERE status = 'cancelled'
grain: [customer_id, month]
columns:
  - name: month
    type: time
    role: time
  - name: customer_id
    type: string
  - name: plan_name
    type: string
  - name: mrr_amount
    type: number
measures:
  - name: cancellation_count
    expr: count(*)
```

An SQL source is a one-shot answer: the aggregation is frozen, callers cannot re-group or re-filter by columns the SQL has collapsed, and the source is disconnected from the join graph. Prefer overlays + measures over SQL sources when possible — the `sl_capture` skill covers when SQL is justified.

### Columns

Every standalone column requires `name` and `type`. Overlays have computed columns only.

- `type`: one of `string`, `number`, `boolean`, `time`. Map LookML `date`/`datetime`/`timestamp` → `time`. Map LookML `yesno` → `boolean`.
- `role` (optional): `time` enables time-granularity queries (month, week, day). `default` is the implicit fallback.
- `visibility` (optional): `public`, `internal`, or `hidden`.
- `expr` (optional for standalone, required for overlay columns): SQL expression that computes the value. Expanded by sqlglot before generating SQL, so you can reference other columns on the same source.

### Grain

`grain: [col_a, col_b]` — the set of columns that uniquely identify one row. The query engine uses grain to prevent fan-out in joins. Overlays inherit grain from the manifest unless they override.

### Joins

```yaml
joins:
  - to: customers                                    # target source name
    on: "customer_id = customers.id"                 # local_col = TARGET.target_col
    relationship: many_to_one                        # or one_to_many, one_to_one
    alias: primary_customer                          # optional — lets you join the same target twice
```

- `on` format: `local_col = TARGET.target_col`. Always qualify the right side with the target source name.
- `relationship` is the cardinality **from this source to the target**. Most joins are `many_to_one` (FK → PK on the parent).

### Measures

```yaml
measures:
  - name: total_arr
    expr: sum(arr_amount)
    description: Sum of ARR — filter by plan_name at query time
    filter: "is_active = true"
    segments: [paid_non_refunded]
```

- `name` (required, snake_case).
- `expr` (required): any valid SQL aggregate — `sum(x)`, `count(*)`, `count(distinct user_id)`, `avg(score)`.
- `description` (required on capture): what the measure computes and how to use it.
- `filter` (optional): SQL predicate applied as a WHERE clause specific to this measure.
- `segments` (optional): names of segments defined on the same source. The engine AND-composes each segment's `expr` into this measure's effective filter.

Use `safe_divide(num, den)` for ratio measures to avoid division by zero.

### Segments

```yaml
segments:
  - name: paid_non_refunded
    expr: "is_paid = true AND is_refunded = false"
    description: Orders that were paid and not refunded
```

Named, reusable boolean predicates scoped to one source. Reference by bare name in a measure's `segments: []`, or by dotted form `source.segment_name` in a `semantic_query`. Segments are predicates only — they are NOT selectable as dimensions. If you need to group by the predicate, add a `columns[]` entry instead.

### Cross-references with the wiki

The reverse edge (wiki pages that cite this source) is derived automatically from each wiki's `sl_refs:` — you don't emit anything on the SL side. Author the edge once on the wiki via `sl_refs:`; the post-write reconciler populates the knowledge↔SL index.

---

## Part 2 — Querying via `semantic_query`

The `semantic_query` tool generates correct SQL from a structured query. It handles joins, fan-out prevention, aggregation correctness, and filter classification automatically. Prefer it over writing raw SQL whenever the SL has the relevant sources.

### When to prefer semantic_query over raw SQL

- A pre-defined measure already exists (`source.measure_name` appears in the catalog).
- The question combines fields from multiple sources — the engine resolves the join path automatically.
- The question asks for a standard metric (revenue, ARR, churn, retention, LTV, conversion, MAU, etc.) — even if no pre-defined measure exists, a runtime aggregation over a catalog column is usually correct.

Use raw SQL (`sql_execution`) only when:
- The computation requires multi-step CTEs whose intermediate grain is not a column in any source.
- The question explicitly asks for a one-off exploration that will never be asked again.

### Input shape

```json
{
  "connectionId": "uuid-of-the-connection",
  "reasoning": "Brief note on what this query analyzes",
  "query": {
    "measures": ["orders.total_revenue", "sum(orders.amount)"],
    "dimensions": ["customers.segment", { "field": "orders.created_at", "granularity": "month" }],
    "filters": ["orders.status != 'cancelled'", "orders.total_revenue > 10000"],
    "segments": ["orders.paid_non_refunded"],
    "order_by": [{ "field": "orders.created_at", "direction": "desc" }],
    "limit": 1000
  }
}
```

- **`measures`**: mix pre-defined refs (`source.measure`) and runtime aggregations (`sum(source.column)`).
- **`dimensions`**: column refs or `{ field, granularity }` objects for time grains (`day`, `week`, `month`, `quarter`, `year`).
- **`filters`**: free-form SQL predicates. The engine auto-classifies each as WHERE or HAVING based on whether it references an aggregated measure.
- **`segments`**: dotted `source.segment_name`. Each segment is AND-ed into the effective filter of every measure whose base source matches. Segments never become a global WHERE — use `filters` for cross-source predicates.
- **`order_by`**: string or `{ field, direction }`. Direction defaults to `asc`.
- **`limit`**: integer row cap.

### Join resolution

You don't specify a base table. The engine infers the set of sources needed from the fields you reference and resolves the shortest join path through the catalog's declared joins. If no path exists between two sources, the query fails with a path-not-found error — check `discover_data` or `sl_discover` to see which sources are connected.

### Worked examples

Cross-source query — engine resolves `account_health_scores → accounts ← opportunities` automatically:

```json
{
  "measures": ["account_health_scores.avg_health_score"],
  "dimensions": ["opportunities.stage"],
  "filters": ["opportunities.stage != 'Closed Won'"]
}
```

Monthly ARR trend with a segment:

```json
{
  "measures": ["subscriptions.arr"],
  "dimensions": [{ "field": "subscriptions.month", "granularity": "month" }],
  "segments": ["subscriptions.paid_non_refunded"],
  "order_by": [{ "field": "subscriptions.month", "direction": "asc" }]
}
```

Multi-source with runtime aggregation:

```json
{
  "measures": ["sum(orders.amount)", "count(support_tickets.ticket_id)"],
  "dimensions": ["customers.segment"]
}
```
