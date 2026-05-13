---
summary: "Overview of the kaelio_demo dbt project: connection, schema layout, model layers, and governed metrics."
usage_mode: auto
sort_order: 0
tags:
  - dbt
  - orbit
  - data-model
  - governed-metrics
sl_refs:
  - stg_accounts
  - stg_contracts
  - stg_arr_movements
  - mart_arr_daily
  - mart_nrr_quarterly
  - mart_revenue_daily
  - mart_account_activity
  - mart_procurement_activity
  - mart_customer_health
  - mart_account_segments
---

# Orbit dbt Project Overview

**Project name:** `kaelio_demo`
**dbt version:** 1.0.0
**Profile target:** Postgres (`orbit_analytics` schema, `kaelio_demo` database)
**Raw source schema:** `orbit_raw`
**Analytics schema:** `orbit_analytics` (all models materialised as views by default)

## Model Layers

| Layer | Prefix | Purpose |
|---|---|---|
| Staging | `stg_` | 1-to-1 with `orbit_raw` tables; adds type-casting, column tests, enum constraints |
| Intermediate | `int_` | Business-logic joins and rollups; not exposed to BI directly |
| Mart | `mart_` | Board/dashboard-ready aggregates; each has a `governed_metric_key` and `owner_team` |

## Governed Metrics (mart layer)

| Mart | `governed_metric_key` | Owner | Notion |
|---|---|---|---|
| `mart_arr_daily` | `arr` | finance | `notion_page_arr_contract_reporting` |
| `mart_nrr_quarterly` | `net_revenue_retention` | analytics | `notion_page_retention_policy_current` |
| `mart_retention_movement_breakout` | `net_revenue_retention` | analytics | `notion_page_retention_policy_current` |
| `mart_revenue_daily` | `net_revenue` | finance | `notion_page_revenue_reporting_policy` |
| `mart_account_activity` | `activated_accounts` | growth | `notion_page_activation_policy_decision` |
| `mart_procurement_activity` | `weekly_active_requesters` | product | `notion_page_procurement_instrumentation` |
| `mart_customer_health` | `active_customers` | customer_success | `notion_page_customer_health_playbook` |
| `mart_account_segments` | `segment` | sales_ops | `notion_page_sales_ops_segmentation` |

## Raw Source Tables (`orbit_raw` schema)

accounts, account_hierarchy, plans, contracts, subscriptions, contract_discount_terms, arr_movements, invoices, invoice_line_items, refunds, plan_segment_mapping, users, activation_events, sessions, purchase_requests, approval_events, suppliers, supplier_onboarding_events, purchase_orders, support_tickets, account_owners.
