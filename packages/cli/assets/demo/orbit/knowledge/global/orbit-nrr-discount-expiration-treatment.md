---
summary: "NRR definition and the Q1 2026 discount-expiration contraction treatment: discount expirations are classified as contraction, not churn, and tracked separately via is_discount_expiration_contraction."
usage_mode: auto
sort_order: 0
tags:
  - nrr
  - retention
  - governed-metric
  - analytics
  - discount
  - contraction
sl_refs:
  - mart_nrr_quarterly
---

# NRR — Discount Expiration Treatment

**Governed metric key:** `net_revenue_retention`
**Owner team:** analytics
**Notion:** `notion://notion_page_retention_policy_current#nrr-definition` and `#discount-expiration-treatment`
**Sources:** `mart_nrr_quarterly`, `mart_retention_movement_breakout`

## NRR Definition

Net Revenue Retention (NRR) is calculated quarterly at the **parent-account** grain using `int_parent_account_arr_movements`. The enterprise segment is the primary reporting cut.

**Known assertions:**
- Enterprise NRR **2026-Q1 = 1.018** (101.8%)
- Enterprise NRR **2025-Q4 = 1.064** (106.4%)

## Discount Expiration Treatment

Contraction ARR arising from the expiry of launch/renewal/migration/goodwill discounts is **not classified as churn**. It is tracked via the boolean flag `is_discount_expiration_contraction` on `int_parent_account_arr_movements` and surfaced as `movement_reason = 'discount_expiration'` in `mart_retention_movement_breakout`.

**Known assertion:** 11 parent accounts had `movement_type = 'contraction'` and `movement_reason = 'discount_expiration'` in Q1 2026.

## Discount Types (from `stg_contract_discount_terms`)

`launch`, `renewal`, `migration`, `goodwill`

## Movement Types

`new`, `expansion`, `contraction`, `churn`, `reactivation`

## Why This Matters

Without the discount-expiration carve-out, Q1 2026 enterprise NRR would appear lower than it is. The Q4 → Q1 drop (1.064 → 1.018) is partly explained by discount expirations, not organic churn.
