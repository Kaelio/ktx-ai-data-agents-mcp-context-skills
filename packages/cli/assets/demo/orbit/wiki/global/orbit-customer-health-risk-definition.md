---
summary: "Customer health risk definition: risk_level (low/medium/high) derived from open critical support tickets and recent procurement activity. Mart: mart_customer_health, as of 2026-03-31."
usage_mode: auto
sort_order: 0
tags:
  - customer-health
  - risk
  - customer-success
  - governed-metric
  - support
sl_refs:
  - mart_customer_health
---

# Customer Health Risk Definition

**Governed metric key:** `active_customers`
**Owner team:** customer_success
**Notion:** `notion://notion_page_customer_health_playbook#risk-definition`
**Sources:** `mart_customer_health`, `int_customer_health_signals`

## Risk Levels

`low`, `medium`, `high` - derived from two signal types:

1. **Support ticket signals** (`stg_support_tickets`): open or pending tickets with severity `high` or `critical` increase risk.
2. **Procurement activity signals** (`stg_purchase_requests`, `stg_purchase_orders`): recent qualifying procurement actions reduce risk.

## Intermediate Model

`int_customer_health_signals` - combines open critical ticket count and recent procurement action count per account.

## Mart

`mart_customer_health` - account-grain risk mart as of **2026-03-31**.

- `account_id`: dbt not_null, unique
- `risk_level`: dbt accepted_values [low, medium, high]

## Support Ticket Severities

`low`, `medium`, `high`, `critical`

## Account Ownership Context

`stg_account_owners` provides effective-dated ownership (owner_team: sales_ops, customer_success, finance) for escalation routing.
