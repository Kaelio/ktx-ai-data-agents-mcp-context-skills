---
summary: "mart_arr_daily: daily ARR snapshot with contract-first valuation, arr_cents and display columns, used for ARR trend and EoQ reporting."
usage_mode: auto
sort_order: 0
tags:
  - arr
  - revenue
  - mart
  - orbit-analytics
sl_refs:
  - mart_arr_daily
tables:
  - orbit_analytics.mart_arr_daily
---

# mart_arr_daily

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/56.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/96.json -->

**Table:** `orbit_analytics.mart_arr_daily`  
**Grain:** one row per `metric_date`

## Columns

| Column | Type | Notes |
|---|---|---|
| `metric_date` | date | Snapshot date |
| `arr_cents` | bigint | ARR in cents (contract-first: active contract ARR takes precedence over subscription ARR) |
| `display` | text | Human-readable ARR label (e.g. formatted dollar string) |

## Key measures (SL: `mart_arr_daily`)

- `total_arr_cents` — `sum(arr_cents)`
- `arr_millions` — `round(sum(arr_cents) / 100000000.0, 3)` — ARR in $M

## Common query patterns

- **Current ARR:** filter `metric_date = current_date` (or latest available date)
- **EoQ ARR:** filter `metric_date = date '2026-03-31'`
- **ARR trend:** group by `metric_date`, plot `arr_cents`

## Business rules

- ARR is calculated contract-first: active contract ARR takes precedence over subscription ARR for any covered period. See [orbit-arr-contract-first-definition](orbit-arr-contract-first-definition).
- `display` is a formatted label for UI rendering; use `arr_cents` for all arithmetic.

