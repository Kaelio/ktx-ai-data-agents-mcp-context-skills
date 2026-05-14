---
summary: "mart_account_activity: pre/post policy 30-day activation rates per policy_change_date. policy_change_date = 2026-01-15 is the Jan 2026 boundary. Rates are 0–1 ratios."
usage_mode: auto
sort_order: 0
tags:
  - activation
  - policy
  - mart
  - orbit-analytics
sl_refs:
  - mart_account_activity
tables:
  - orbit_analytics.mart_account_activity
---

# mart_account_activity

<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/63.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/101.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/106.json -->
<!-- from: raw-sources/postgres-warehouse/metabase/2026-05-12-035303-local-metabase-3-114d957b-f564-4f46-8d4c-2770720a95be/cards/107.json -->

**Table:** `orbit_analytics.mart_account_activity`
**Grain:** one row per `policy_change_date`

## Columns

| Column | Type | Notes |
|---|---|---|
| `policy_change_date` | date | The policy boundary date (primary value: `2026-01-15`) |
| `pre_policy_30_day_activation_rate` | decimal | 30-day activation rate before the policy change (0–1 ratio) |
| `post_policy_30_day_activation_rate` | decimal | 30-day activation rate after the policy change (0–1 ratio) |

## Key measures (SL: `mart_account_activity`)

- `avg_pre_policy_activation_rate` - `avg(pre_policy_30_day_activation_rate)`
- `avg_post_policy_activation_rate` - `avg(post_policy_30_day_activation_rate)`

## Common query patterns

- **Policy comparison:** `WHERE policy_change_date = date '2026-01-15'`
- **As percent:** `round(pre_policy_30_day_activation_rate * 100, 1)`
- **Side-by-side:** UNION of pre and post rows with a `policy_window` label column

## Business rules

- The January 2026 activation policy change (`policy_change_date = 2026-01-15`) is the primary boundary. `policy_version` in upstream events splits into `pre_2026_01_15` and `post_2026_01_15` cohorts.
- Rates are ratios (0–1); multiply by 100 for percentage display.
- See [orbit-activation-policy-change-jan-2026](orbit-activation-policy-change-jan-2026) for full policy context.
