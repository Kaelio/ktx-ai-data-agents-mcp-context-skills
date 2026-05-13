---
name: metricflow_ingest
description: Map a MetricFlow semantic_model or metric into KTX semantic layer sources. Covers the MetricFlow to KTX primitive table, `extends:` inheritance flattening, metric-type handling (simple / derived / ratio / cumulative / conversion), `model: ref('x')` resolution, and four worked examples. Load when the turn contains `.yml`/`.yaml` files with top-level `semantic_models:` or `metrics:`.
callers: [memory_agent]
---

# MetricFlow to KTX Semantic Layer

A MetricFlow `semantic_model` maps to an SL source; MetricFlow `measures` map to KTX measures; MetricFlow `entities` map to KTX `joins`; MetricFlow `metrics` (top-level) map to KTX measures OR to cross-model derived measures. Files in one WorkUnit are ALWAYS part of the same logical entity (a connected component, possibly spanning `extends:` + cross-model metric refs). Flatten inheritance and cross-file references at write time.

## Mapping table

| MetricFlow | KTX form | Notes |
|---|---|---|
| `semantic_model: X { model: ref('t') }` with measures + dimensions | **Overlay** at `<connId>/X.yaml` with `measures`, `columns` (computed), `joins` | The `model:` ref resolves to a manifest table. |
| `semantic_model: X { model: source('s','t') }` | **Overlay** at `<connId>/X.yaml` over table `t`. | Same shape; `source()` still resolves to a physical table. |
| `semantic_model: X { model: <literal> }` with no manifest entry | **Standalone** with explicit `sql:`, `grain:`, `columns:` | Happens when the dbt manifest isn't available. |
| `semantic_model: Y { extends: X }` | **Merge** Y's measures/dimensions/entities into X's overlay, or write a single overlay named for the most-derived child (Y) containing both X's and Y's primitives | Do not emit a second overlay for X — flatten. |
| `measures: [{ name, agg, expr }]` | `measures: [{ name, expr: "<agg>(<expr>)" }]` | Aggregation inlined. `agg: count_distinct` → `count(distinct ...)`. |
| `entities: [{ name, type: primary }]` | `grain: [<entity_name-or-expr>]` on the overlay/standalone | Primary/unique entities drive grain. |
| `entities: [{ name, type: foreign }]` | `joins:` entry joining to the primary-entity's semantic_model | Only when a matching primary is discoverable. |
| `metrics: [{ type: simple, type_params: { measure: X } }]` | If the base measure is labeled/described by the metric: in-place edit to the existing measure. Otherwise leave as-is. | Same-name metrics can absorb metadata. |
| `metrics: [{ type: simple, filter: <jinja> }]` | **New measure** on the same source, with the filter translated to SQL and attached via `filter:` | Translate Jinja `{{ Dimension('x__y') }}` to the column name `y`. |
| `metrics: [{ type: derived, type_params: { expr, metrics } }]` | **Derived measure** on whichever source owns the referenced measures, with `expr:` referencing measure names | If the metric spans models, still write it once on the source owning the "primary" measure (the one the agent judges most central). Mention the cross-model chain in the description. |
| `metrics: [{ type: ratio, type_params: { numerator, denominator } }]` | Same as derived; `expr: "numerator / NULLIF(denominator, 0)"` if no explicit expr | Safe-division by default. |
| `metrics: [{ type: cumulative, type_params: { window, grain_to_date } }]` | **Standalone** source with a window-function SQL; reference the resulting column as a normal measure | KTX SL has no first-class cumulative primitive (spec Non-goals). |
| `metrics: [{ type: conversion }]` | **Flag for human** — do NOT write. Emit a wiki note describing the intended semantics. | No KTX equivalent in v1. |
| Metric not mappable | Wiki page `<metric_name>-definition.md` with the full YAML body quoted | Capture the intent even if we can't emit SL. |

Type map: MetricFlow `time` to KTX `time`; `categorical` to `string`; `number` to `number`; `boolean` to `boolean`. Follow `expr` over `name` when both differ — `expr` is the physical column.

Verify each MetricFlow model source table with entity_details before producing
the corresponding sl_write_source.

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

## Flattening `extends:`

Within one WorkUnit, multiple semantic_models linked by `extends:` are guaranteed to be present (the chunker groups them). Resolve inheritance **before** writing:

1. Start with the most-derived child (the one that no other semantic_model extends).
2. Walk the `extends:` chain upward, accumulating measures, dimensions, entities.
3. Write ONE overlay/standalone, named for the most-derived child's SL-appropriate name (not the base).
4. Parents that lack their own distinctive content should NOT get a separate overlay. If a parent has unique measures a child doesn't inherit, consider whether the base is used elsewhere — if yes, write both; if no, still one overlay.
5. Measure/dimension name collisions: child wins, but note the overridden parent in the overlay's description or in a sibling wiki page.

The spec's worked example has `orders`, `orders_ext` (extends orders), and `metrics/orders_final.yml` (defines `revenue` referencing both). The right output is ONE overlay named `orders_ext` (or `orders` if the team's naming favors the base) containing `order_count`, `gross_amount`, `refund_amount`, and a derived `revenue` measure. Provenance tags point to all three source files.

## `model:` ref resolution

The `model:` field on a semantic_model is a string like `ref('table_name')`, `source('src','table_name')`, or a literal. Resolve:

- `ref('x')` → table name `x`. Verify via `sl_discover(x)`.
- `source('s','t')` → table name `t`. Verify via `sl_discover(t)`.
- Literal (no `ref(...)` / `source(...)`) → treat as the table name directly.

If `sl_discover` errors because no such table exists, use `discover_data` and
`entity_details` to find the warehouse target. If a SQL probe is still needed,
call `sql_execution` with the same warehouse connection name, for example:
`sql_execution({connectionName: "warehouse", sql: "SELECT 1 FROM analytics.orders LIMIT 0"})`.
**Never invent column names** - every column in `columns:`, `grain:`, and
`sql:` must be sourced from raw files, `entity_details`, or a successful SQL
probe.

After every `sl_write_source`, call `sl_validate`. The warehouse will reject invented columns with `Unrecognized name: <name>` — treat as a hard failure and re-read the schema.

## Cumulative metrics — sql-standalone fallback

KTX SL has no first-class `window:` or `grain_to_date:` primitive in v1 (spec Non-goals). Translate a MetricFlow cumulative metric to a standalone SL source with a window-function SQL:

```yaml
# MetricFlow input:
metrics:
  - name: cum_revenue_7d
    type: cumulative
    type_params:
      measure: gross_amount
      window: 7 days
```

```yaml
# KTX standalone output:
name: cum_revenue_7d
source_type: sql
sql: |
  SELECT
    ordered_at,
    SUM(amount) OVER (ORDER BY ordered_at RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW) AS cum_revenue_7d,
    order_id
  FROM analytics.orders
grain: [order_id]
columns:
  - {name: ordered_at, type: time, role: time}
  - {name: cum_revenue_7d, type: number}
  - {name: order_id, type: string}
measures:
  - {name: cum_revenue_7d, expr: "max(cum_revenue_7d)"}
```

Pick the time column based on the semantic_model's `defaults.agg_time_dimension` (e.g. `ordered_at`). If the MetricFlow config omits it, probe the base table for time-typed columns and choose the most obvious. After writing the standalone SQL source, call `emit_unmapped_fallback` with `rawPath` set to the MetricFlow file path, `reason: "cumulative_metric_unsupported"`, and `fallback: "sql_standalone"`.

## Conversion metrics — flag for human

```yaml
metrics:
  - name: signup_to_first_order
    type: conversion
    type_params:
      conversion_type_params:
        entity: customer
        base_measure: signup_count
        conversion_measure: first_order_count
        window: 30 days
```

Do NOT emit SL for this. Instead:
- Write a wiki page at `wiki/global/<metric_name>-intent.md` quoting the full YAML body and a one-line explanation of the intended semantics (base event → conversion event within window).
- Call `emit_unmapped_fallback` with `rawPath` set to the MetricFlow file path, `reason: "conversion_metric_unsupported"`, and `fallback: "flagged"`.

When KTX SL gains conversion primitives, re-ingesting will find the prior wiki note (via `priorProvenance`) and replace it with an SL source.

## Provenance markers

Every overlay/standalone/wiki page emitted from a MetricFlow source carries HTML-comment provenance tags. When one overlay derives from multiple files (e.g. an extends chain), emit one tag per contributing file:

```yaml
# <!-- from: raw-sources/conn-1/metricflow/<syncId>/models/orders.yml#L1-20 -->
# <!-- from: raw-sources/conn-1/metricflow/<syncId>/models/orders_ext.yml#L1-12 -->
# <!-- from: raw-sources/conn-1/metricflow/<syncId>/metrics/orders_final.yml#L1-10 -->
name: orders_ext
...
```

Line ranges (`#L<start>-<end>`) point to the exact YAML span within the file (the `semantic_models:` entry for its own `name`). Use `read_raw_span` to identify those ranges before writing.

## Example 1 — single semantic_model to overlay

```yaml
# MetricFlow:
semantic_models:
  - name: orders
    model: ref('orders')
    entities:
      - {name: order_id, type: primary}
    measures:
      - {name: order_count, agg: count, expr: order_id}
      - {name: gross_amount, agg: sum, expr: amount}
```

```yaml
# KTX overlay at <connId>/orders.yaml:
# <!-- from: raw-sources/.../models/orders.yml#L1-10 -->
name: orders
description: Order fact table.
measures:
  - {name: order_count, expr: "count(order_id)"}
  - {name: gross_amount, expr: "sum(amount)"}
grain: [order_id]
```

## Example 2 — extends chain → one flattened overlay

```yaml
# MetricFlow:
# models/orders.yml
semantic_models:
  - name: orders
    model: ref('orders')
    measures:
      - {name: order_count, agg: count, expr: order_id}
      - {name: gross_amount, agg: sum, expr: amount}

# models/orders_ext.yml
semantic_models:
  - name: orders_ext
    model: ref('orders_ext')
    extends: orders
    measures:
      - {name: refund_amount, agg: sum, expr: refund_amt}

# metrics/orders_final.yml
metrics:
  - name: revenue
    type: derived
    type_params:
      expr: gross_amount - refund_amount
      metrics:
        - {name: gross_amount}
        - {name: refund_amount}
```

```yaml
# KTX overlay at <connId>/orders_ext.yaml (one file; inheritance flattened):
# <!-- from: raw-sources/.../models/orders.yml#L1-10 -->
# <!-- from: raw-sources/.../models/orders_ext.yml#L1-8 -->
# <!-- from: raw-sources/.../metrics/orders_final.yml#L1-10 -->
name: orders_ext
description: Extended order fact including refund handling; `revenue` = gross - refund.
measures:
  - {name: order_count, expr: "count(order_id)"}
  - {name: gross_amount, expr: "sum(amount)"}
  - {name: refund_amount, expr: "sum(refund_amt)"}
  - {name: revenue, expr: "gross_amount - refund_amount"}
grain: [order_id]
```

## Example 3 — derived metric spanning two semantic_models

```yaml
# models/sales.yml
semantic_models:
  - name: sales
    model: ref('sales')
    measures:
      - {name: revenue, agg: sum, expr: revenue_cents}
# models/costs.yml
semantic_models:
  - name: costs
    model: ref('costs')
    measures:
      - {name: cost, agg: sum, expr: cost_cents}
# metrics/margin.yml
metrics:
  - name: margin
    type: derived
    type_params:
      expr: revenue - cost
      metrics: [{name: revenue}, {name: cost}]
```

Because the WorkUnit bundles all three files (cross-component union via the metric), write the derived measure on ONE of the two sources — pick the source whose domain "owns" the metric (here, `sales` — margin is inherently a sales metric). Cross-source references aren't native in KTX SL; treat the metric's operands as already-resolvable in the target source's query context OR emit a standalone SQL that joins the two tables:

```yaml
# <connId>/sales.yaml
# <!-- from: .../models/sales.yml#L1-8 -->
# <!-- from: .../models/costs.yml#L1-8 -->
# <!-- from: .../metrics/margin.yml#L1-8 -->
name: sales
measures:
  - {name: revenue, expr: "sum(revenue_cents)"}
```

```yaml
# <connId>/margin.yaml — standalone because it spans two tables
# <!-- from: .../models/sales.yml#L1-8 -->
# <!-- from: .../models/costs.yml#L1-8 -->
# <!-- from: .../metrics/margin.yml#L1-8 -->
name: margin
source_type: sql
sql: |
  SELECT s.period_id, s.revenue_cents, COALESCE(c.cost_cents, 0) AS cost_cents
  FROM analytics.sales s
  LEFT JOIN analytics.costs c ON c.period_id = s.period_id
grain: [period_id]
columns:
  - {name: period_id, type: string}
  - {name: revenue_cents, type: number}
  - {name: cost_cents, type: number}
measures:
  - {name: revenue, expr: "sum(revenue_cents)"}
  - {name: cost, expr: "sum(cost_cents)"}
  - {name: margin, expr: "sum(revenue_cents) - sum(cost_cents)"}
```

Also write a wiki page at `wiki/global/margin-metric.md` explaining the cross-source origin.

## Example 4 — filtered metric creates a new measure

```yaml
metrics:
  - name: paid_order_count
    type: simple
    type_params:
      measure: order_count
    filter: "{{ Dimension('orders__status') }} = 'paid'"
```

```yaml
# <connId>/orders.yaml
measures:
  - {name: order_count, expr: "count(order_id)"}
  - {name: paid_order_count, expr: "count(order_id)", filter: "status = 'paid'"}
```

Translate `{{ Dimension('orders__status') }}` to the bare column name `status` (the table alias prefix is implicit within the SL source's scope).
