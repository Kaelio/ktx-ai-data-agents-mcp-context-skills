---
summary: "mart_procurement_activity: weekly active requester counts by contract_arr_threshold_cents. Standard threshold is 20000000 cents ($200k ARR). Used for golden-week procurement metrics."
usage_mode: auto
sort_order: 0
tags:
  - procurement
  - mart
  - orbit-analytics
  - active-requesters
sl_refs:
  - mart_procurement_activity
tables:
  - orbit_analytics.mart_procurement_activity
---

# mart_procurement_activity

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/88.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/108.json -->

**Table:** `orbit_analytics.mart_procurement_activity`  
**Grain:** one row per `week_start_date` × `contract_arr_threshold_cents`

## Columns

| Column | Type | Notes |
|---|---|---|
| `week_start_date` | date | Monday of the reporting week |
| `week_end_date` | date | Sunday of the reporting week |
| `contract_arr_threshold_cents` | bigint | ARR threshold filter applied (e.g. `20000000` = $200k) |
| `active_requesters` | bigint | Count of qualifying active requesters for the week |

## Key measures (SL: `mart_procurement_activity`)

- `total_active_requesters` — `sum(active_requesters)`
- `active_requesters_200k_threshold` — `sum(active_requesters)` where `contract_arr_threshold_cents = 20000000`

## Common query patterns

- **Golden week (week of 2026-03-23):** `WHERE week_start_date = date '2026-03-23' AND contract_arr_threshold_cents = 20000000`
- **Weekly trend at $200k threshold:** `WHERE contract_arr_threshold_cents = 20000000 ORDER BY week_start_date`

## Business rules

- `active_requesters` counts non-internal, non-test requesters on large active contracts. See [orbit-procurement-qualifying-actions](orbit-procurement-qualifying-actions).
- The standard threshold is `contract_arr_threshold_cents = 20000000` ($200k ARR).
- Always filter by `contract_arr_threshold_cents` — the table contains rows for multiple threshold values.

