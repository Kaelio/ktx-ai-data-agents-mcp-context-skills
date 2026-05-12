---
summary: "Gross-to-net revenue reconciliation: mart_revenue_daily reconciles gross invoice revenue, credits, and refunds to net revenue daily. reconciliation_check must be true on every row."
usage_mode: auto
sort_order: 0
tags:
  - revenue
  - net-revenue
  - governed-metric
  - finance
  - reconciliation
sl_refs:
  - mart_revenue_daily
---

# Revenue — Gross-to-Net Reconciliation

**Governed metric key:** `net_revenue`
**Owner team:** finance
**Notion:** `notion://notion_page_revenue_reporting_policy#gross-to-net-reconciliation`
**Source:** `mart_revenue_daily` (grain: `revenue_date`)

## Formula

```
net_revenue = gross_revenue - credits - refunds
```

All amounts are in **cents** (USD only — `stg_invoices.currency` is asserted to be `USD`).

## Components

| Column | Source | Description |
|---|---|---|
| `gross_revenue_cents` | `stg_invoices` / `stg_invoice_line_items` | Billed amounts before adjustments |
| `credit_cents` | `stg_invoice_line_items` (type=credit) | Credits applied to invoices |
| `refund_cents` | `stg_refunds` | Refunds reduce net revenue in the refund month |
| `net_revenue_cents` | Derived | gross − credits − refunds |

## Intermediate model

`int_revenue_components` — daily gross, credit, refund, and net revenue components.

## Quality Gates

- `reconciliation_check` must be `true` on every row of `mart_revenue_daily`.
- `assert_february_2026_net_revenue` — a dbt singular test covering February 2026 net revenue total.

## Line Item Types (`stg_invoice_line_items`)

`subscription`, `seat`, `usage`, `addon`, `credit`
