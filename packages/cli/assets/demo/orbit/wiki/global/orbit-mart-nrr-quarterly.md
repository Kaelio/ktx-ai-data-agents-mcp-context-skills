---
summary: "mart_nrr_quarterly: quarterly NRR by segment with net_revenue_retention ratio, expansion/contraction/churn ARR cents, and quarter_label. Enterprise is the primary reporting segment."
usage_mode: auto
sort_order: 0
tags:
  - nrr
  - retention
  - revenue
  - mart
  - orbit-analytics
sl_refs:
  - mart_nrr_quarterly
tables:
  - orbit_analytics.mart_nrr_quarterly
---

# mart_nrr_quarterly

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/58.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/98.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/103.json -->

**Table:** `orbit_analytics.mart_nrr_quarterly`
**Grain:** one row per `quarter_label` × `segment`

## Columns

| Column | Type | Notes |
|---|---|---|
| `quarter_start_date` | date | First day of the quarter |
| `quarter_label` | text | Quarter identifier, e.g. `'2026-Q1'` |
| `segment` | text | Customer segment: `enterprise`, `commercial`, `self_serve` |
| `starting_arr_cents` | bigint | ARR at start of quarter in cents |
| `expansion_arr_cents` | bigint | ARR added from expansions |
| `contraction_arr_cents` | bigint | ARR lost from contractions (includes discount expirations) |
| `churned_arr_cents` | bigint | ARR lost from churn |
| `net_revenue_retention` | decimal | NRR ratio (e.g. `1.12` = 112%) |

## Key measures (SL: `mart_nrr_quarterly`)

- `avg_nrr` - `avg(net_revenue_retention)` across all rows
- `avg_nrr_enterprise` - `avg(net_revenue_retention)` filtered to `segment = 'enterprise'`
- `total_expansion_arr_cents`, `total_contraction_arr_cents`, `total_churned_arr_cents`

## Common query patterns

- **Q1 enterprise NRR:** `WHERE quarter_label = '2026-Q1' AND segment = 'enterprise'`
- **NRR as percent:** `round(net_revenue_retention * 100, 1)`
- **Trend by quarter:** `ORDER BY quarter_start_date`

## Business rules

- `net_revenue_retention` is a ratio, not a percentage. Multiply by 100 for display.
- Contraction includes discount expirations (classified as contraction, not churn). See [orbit-nrr-discount-expiration-treatment](orbit-nrr-discount-expiration-treatment).
- Enterprise is the primary executive reporting segment.
