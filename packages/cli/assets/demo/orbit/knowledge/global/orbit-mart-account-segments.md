---
summary: "mart_account_segments: account segmentation with contract ARR, plan codes, size_band, segment (self_serve/commercial/enterprise), and contract_status. One row per account_id."
usage_mode: auto
sort_order: 0
tags:
  - arr
  - segmentation
  - accounts
  - mart
  - orbit-analytics
sl_refs:
  - mart_account_segments
tables:
  - orbit_analytics.mart_account_segments
---

# mart_account_segments

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/69.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/100.json -->

**Table:** `orbit_analytics.mart_account_segments`  
**Grain:** one row per `account_id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `account_id` | text | Primary key |
| `parent_account_id` | text | Parent account for hierarchy rollups |
| `current_plan_code` | text | Raw plan code from billing system |
| `normalized_plan_code` | text | Canonical plan code (`pro_plus` → `growth`) |
| `size_band` | text | Company size band |
| `segment` | text | Reporting segment: `self_serve`, `commercial`, `enterprise` |
| `contract_arr_cents` | bigint | Contract ARR in cents |
| `contract_status` | text | `active`, `churned`, etc. |

## Key measures (SL: `mart_account_segments`)

- `account_count` — `count(*)`
- `total_contract_arr_cents` — `sum(contract_arr_cents)`
- `active_contract_arr_cents` — `sum(contract_arr_cents)` where `contract_status = 'active'`
- `active_contract_arr_millions` — active ARR in $M

## Common query patterns

- **ARR by segment:** `GROUP BY segment WHERE contract_status = 'active'`
- **Top accounts:** `ORDER BY contract_arr_cents DESC` with `is_internal = false AND is_test = false` (join to `orbit_raw.accounts`)
- **Unmapped segment:** `COALESCE(segment, 'unmapped')`

## Business rules

- `normalized_plan_code` maps `pro_plus` → `growth`. Always use `normalized_plan_code` for plan-based reporting. See [orbit-plan-segment-normalization](orbit-plan-segment-normalization).
- `segment` is derived from `canonical_plan_code × size_band` via `stg_plan_segment_mapping`.
- `contract_arr_cents` is the contract-first ARR value. See [orbit-arr-contract-first-definition](orbit-arr-contract-first-definition).

