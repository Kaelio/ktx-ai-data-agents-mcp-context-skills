---
summary: "Metabase SQL Library collection (collection 7): reusable query patterns, the account_join snippet, and field-filter conventions used across Orbit Showcase cards."
usage_mode: auto
sort_order: 0
tags:
  - metabase
  - sql-patterns
  - orbit-showcase
sl_refs:
  - mart_account_segments
  - mart_procurement_activity
  - mart_customer_health
  - mart_retention_movement_breakout
  - mart_revenue_daily
  - mart_nrr_quarterly
---

# Orbit Metabase SQL Library - Patterns & Conventions

Collection **7 "SQL Library"** (parent: Orbit Showcase, collection 5) contains reference queries that demonstrate how to write Metabase native SQL against the Orbit analytics marts. Cards here are intentionally illustrative; several have `dashboardCount: 0` and are not embedded in live dashboards.

## Reusable snippet: `account_join`

Card 55 ("Large contract requesters") references `{{snippet: account_join}}`. The resolved SQL shows the canonical pattern for joining `orbit_analytics.mart_account_segments` to `orbit_raw.accounts`:

```sql
FROM orbit_analytics.mart_account_segments mart
LEFT JOIN orbit_raw.accounts a
     ON a.account_id = mart.account_id
    AND a.is_internal = false
    AND a.is_test = false
```

Key points:
- The `is_internal = false AND is_test = false` guard is applied **in the JOIN condition**, not the WHERE clause, so it does not drop rows from `mart_account_segments` that have no matching account row.
- The alias `mart` is used for `mart_account_segments` throughout the snippet.
- This pattern is equivalent to the filter used in card 48 ("Top accounts by contract ARR"), which applies the same guards in the WHERE clause instead.

## Field-filter conventions

Cards in this collection use Metabase dimension field filters (`type: dimension`) for optional narrowing:
- `segment` filter → maps to `mart_account_segments.segment` or `mart_retention_movement_breakout.segment`.
- `date_range` filter → maps to `mart_procurement_activity.week_start_date`.
- `quarter` filter → maps to `mart_nrr_quarterly.quarter_label`.

These filters are **optional** (`[[ ... ]]` blocks in raw SQL); the resolved SQL drops them, leaving the unfiltered dataset. SL sources derived from these cards should not bake in the filter.

## Hard-coded date anti-pattern

Card 54 ("February credits drilldown") is explicitly documented as a **counter-example**: it hard-codes `revenue_date BETWEEN DATE '2026-02-01' AND DATE '2026-02-28'`. This card is not embedded in any dashboard and should not be used as a template. Use `mart_revenue_daily` directly with a runtime date filter instead.

## Near-duplicate pair: cards 48 and 55

Both cards query `mart_account_segments` + `orbit_raw.accounts` and project `account_name`, `contract_arr`, `segment`, `size_band`. They differ only in:
- Card 48: no ARR floor filter, LIMIT 20, on 1 dashboard.
- Card 55: `contract_arr_cents >= 20,000,000` ($200k floor), LIMIT 25, no dashboard.

Card 48 is the canonical reference; card 55 is a filtered variant for large-contract analysis.

## Cards and their mart sources

| Card | Name | Mart | Dashboard count |
|------|------|------|----------------|
| 48 | Top accounts by contract ARR | mart_account_segments | 1 |
| 49 | Procurement actions by week | mart_procurement_activity | 1 |
| 50 | Accounts at risk | mart_customer_health | 1 |
| 51 | ARR movement breakout | mart_retention_movement_breakout | 1 |
| 52 | Revenue refund audit | mart_revenue_daily | 0 |
| 53 | Enterprise NRR quarter breakout | mart_nrr_quarterly | 0 |
| 54 | February credits drilldown | mart_revenue_daily | 0 |
| 55 | Large contract requesters | mart_account_segments | 0 |
