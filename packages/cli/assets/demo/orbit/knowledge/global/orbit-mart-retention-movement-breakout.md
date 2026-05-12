---
summary: "mart_retention_movement_breakout: quarterly ARR movement by segment, movement_type, and movement_reason. NRR waterfall source. Contraction includes discount expirations."
usage_mode: auto
sort_order: 0
tags:
  - nrr
  - retention
  - arr
  - mart
  - orbit-analytics
sl_refs:
  - mart_retention_movement_breakout
tables:
  - orbit_analytics.mart_retention_movement_breakout
---

# mart_retention_movement_breakout

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/105.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/115.json -->

**Table:** `orbit_analytics.mart_retention_movement_breakout`  
**Grain:** one row per `quarter_label` × `segment` × `movement_type` × `movement_reason`

## Columns

| Column | Type | Notes |
|---|---|---|
| `quarter_start_date` | date | First day of the quarter |
| `quarter_label` | text | Quarter identifier, e.g. `'2026-Q1'` |
| `segment` | text | Customer segment: `enterprise`, `commercial`, `self_serve` |
| `movement_type` | text | `expansion`, `contraction`, or `churn` |
| `movement_reason` | text | Specific reason (e.g. `discount_expiration`) |
| `parent_account_count` | bigint | Number of parent accounts in this bucket |
| `expansion_arr_cents` | bigint | Expansion ARR in cents |
| `contraction_arr_cents` | bigint | Contraction ARR in cents |
| `churned_arr_cents` | bigint | Churned ARR in cents |

## Key measures (SL: `mart_retention_movement_breakout`)

- `total_expansion_arr_cents`, `total_contraction_arr_cents`, `total_churned_arr_cents`
- `expansion_arr_millions`, `contraction_arr_millions`, `churned_arr_millions`
- `parent_account_count`

## Common query patterns

- **Q1 enterprise waterfall:** `WHERE quarter_label = '2026-Q1' AND segment = 'enterprise'`
- **Movement summary:** `GROUP BY movement_type ORDER BY movement_type`
- **Discount expiration contraction:** `WHERE movement_reason = 'discount_expiration'`

## Business rules

- Contraction includes discount expirations, classified as contraction (not churn), tracked via `movement_reason`. See [orbit-nrr-discount-expiration-treatment](orbit-nrr-discount-expiration-treatment).
- This table is the row-level source for `mart_nrr_quarterly` aggregations.
- Only one of `expansion_arr_cents`, `contraction_arr_cents`, `churned_arr_cents` is non-zero per row.

