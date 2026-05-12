---
summary: "mart_revenue_daily: daily gross-to-net revenue reconciliation with gross_revenue_cents, credits_cents, refunds_cents, net_revenue_cents, and reconciliation_check."
usage_mode: auto
sort_order: 0
tags:
  - revenue
  - reconciliation
  - mart
  - orbit-analytics
sl_refs:
  - mart_revenue_daily
tables:
  - orbit_analytics.mart_revenue_daily
---

# mart_revenue_daily

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/57.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/97.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/102.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/104.json -->

**Table:** `orbit_analytics.mart_revenue_daily`  
**Grain:** one row per `revenue_date`

## Columns

| Column | Type | Notes |
|---|---|---|
| `revenue_date` | date | Revenue recognition date |
| `gross_revenue_cents` | bigint | Gross invoice revenue in cents |
| `credits_cents` | bigint | Credits applied in cents |
| `refunds_cents` | bigint | Refunds issued in cents |
| `net_revenue_cents` | bigint | Net revenue = gross − credits − refunds |
| `reconciliation_check` | boolean | Must be `true` on every row; flags rows where net ≠ gross − credits − refunds |

## Key measures (SL: `mart_revenue_daily`)

- `total_gross_revenue_cents` — `sum(gross_revenue_cents)`
- `total_credits_cents` — `sum(credits_cents)`
- `total_refunds_cents` — `sum(refunds_cents)`
- `total_net_revenue_cents` — `sum(net_revenue_cents)`
- `net_revenue_millions` — `round(sum(net_revenue_cents) / 100000000.0, 3)`
- `gross_revenue_millions` — `round(sum(gross_revenue_cents) / 100000000.0, 3)`

## Common query patterns

- **Q1 net revenue:** `WHERE revenue_date BETWEEN '2026-01-01' AND '2026-03-31'`
- **February reconciliation:** `WHERE revenue_date BETWEEN '2026-02-01' AND '2026-02-28'`
- **Monthly trend:** `GROUP BY date_trunc('month', revenue_date)`

## Business rules

- `reconciliation_check` must be `true` on every row. Any `false` row indicates a data quality issue.
- Gross-to-net reconciliation: gross revenue − credits − refunds = net revenue. See [orbit-revenue-gross-to-net-reconciliation](orbit-revenue-gross-to-net-reconciliation).
- All amounts are in cents; divide by 100 for USD, by 100,000,000 for $M.

