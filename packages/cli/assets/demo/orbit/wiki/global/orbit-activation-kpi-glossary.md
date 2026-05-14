---
summary: "Customer activation: email verified + first project + team invite within 14 days of signup. D7/D14 activation rates and Time-to-Activate formulas. Source tables: customer, project, invite."
usage_mode: auto
sort_order: 0
tags:
  - activation
  - kpi
  - growth
  - funnel
  - metrics
refs:
  - orbit-customers-source
  - orbit-activation-policy-change-jan-2026
  - orbit-mart-account-activity
tables:
  - orbit_analytics.customer
  - orbit_analytics.project
  - orbit_analytics.invite
---

# Activation KPI Glossary

**Owner team:** Growth
**Source:** Notion - Orbit Demo Home / Data Team - Onboarding / Activation KPI Glossary, last edited 2026-05-07

Use this when a question is about signup-to-habit behavior. Orbit uses activation language across Growth, Product, and CS conversations.

## Activation Definition

A customer is **activated** when **all three** of the following happen **within 14 days of signup**:

1. Email is verified
2. First project is created
3. At least one teammate is invited

## Funnel Stages

| Stage | Signal | Data source |
|---|---|---|
| 1. Signup | Customer row created | `orbit_analytics.customer` |
| 2. Email Verified | `customer.email_verified_at` is not null | `orbit_analytics.customer` |
| 3. First Project | At least one row in `orbit_analytics.project` for the customer | `orbit_analytics.project` |
| 4. Team Invite | At least one row in `orbit_analytics.invite` for the customer | `orbit_analytics.invite` |
| 5. Activated | All of (2), (3), and (4) within 14 days of (1) | - |

## Conversion-Rate KPIs

| KPI | Formula |
|---|---|
| **D7 Activation Rate** | `activated_customers_within_7_days / signups_in_cohort` |
| **D14 Activation Rate** | `activated_customers_within_14_days / signups_in_cohort` |
| **Time-to-Activate** | `median(activated_at - created_at)` in hours |

Growth conversations typically use D7 and D14 Activation Rate. Product and CS may ask about individual funnel steps - confirm whether they mean the full activation definition or only one stage.

## Source Notes

- Use `orbit_analytics.customer` for `created_at` and `email_verified_at`.
- For project or invite timing, check `orbit_analytics.project` and `orbit_analytics.invite` before changing the activation definition.
- `created_at` is UTC; confirm timezone expectations before cohort filtering.

## Relationship to Account-Level Activation

This glossary defines **customer-level** activation (signup-to-habit). The **account-level** activation workflow (requester login → first approved purchase request → account activated) is a separate concept tracked in `mart_account_activity` and governed by the January 2026 policy change. See `orbit-activation-policy-change-jan-2026` for that definition.
