---
summary: "ARR is calculated contract-first: active contract ARR takes precedence over subscription ARR for any covered period."
usage_mode: auto
sort_order: 0
tags:
  - arr
  - governed-metric
  - finance
  - contracts
  - subscriptions
sl_refs:
  - mart_arr_daily
  - mart_account_segments
---

# ARR - Contract-First Definition

**Governed metric key:** `arr`
**Owner team:** finance
**Notion:** `notion://notion_page_arr_contract_reporting#arr-contract-first`
**Source:** `mart_arr_daily` (grain: `metric_date`)

## Rule

ARR is calculated **contract-first**: when an active contract exists for an account and period, `int_active_contract_arr` is used. Subscription ARR (`stg_subscriptions`) is only used when no active contract covers the period.

## Known Assertion

The dbt test on `mart_arr_daily.arr_cents` asserts the value equals **1,874,200,000 cents ($18,742,000)** as of `metric_date = 2026-03-31`.

## Intermediate model

`int_active_contract_arr` - active contract ARR as of 2026-03-31 (grain: `contract_id`).

## Related

- `stg_contracts` - contract records (status: draft, active, cancelled, expired)
- `stg_subscriptions` - fallback ARR source (status: active, cancelled, past_due, trialing)
- `mart_arr_daily` - board-prep daily ARR mart
