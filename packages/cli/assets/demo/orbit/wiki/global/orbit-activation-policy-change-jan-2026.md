---
summary: "January 2026 activation policy change: policy_version splits events into pre_2026_01_15 and post_2026_01_15 cohorts. mart_account_activity compares activation counts across the boundary."
usage_mode: auto
sort_order: 0
tags:
  - activation
  - growth
  - policy
  - governed-metric
  - procurement
sl_refs:
  - mart_account_activity
---

# Activation Policy Change - January 2026

**Governed metric key:** `activated_accounts`
**Owner team:** growth
**Notion:** `notion://notion_page_activation_policy_decision#policy-change`
**Sources:** `mart_account_activity`, `int_activation_policy_windows`, `stg_activation_events`

## Policy Boundary

The activation workflow changed on **2026-01-15**. All activation events are tagged with `policy_version`:

- `pre_2026_01_15` - events before the workflow update
- `post_2026_01_15` - events after the workflow update

## Activation Event Types

`first_requester_login`, `requester_activated`, `first_approved_purchase_request`, `account_activated`

## Account Activation Sequence

1. First requester login → `first_requester_login`
2. Requester activated → `requester_activated`
3. First approved purchase request → `first_approved_purchase_request`
4. Account activated → `account_activated`

## Exclusions

Internal and test accounts (lifecycle_status = `internal` or `test` on `stg_accounts`) are excluded from activation counts. Sessions (`stg_sessions`) are used for pre-policy activation and activity exclusions.

## Dashboard

Exposed via the **Growth Activation Dashboard** (`https://orbit-demo.example.com/dashboards/activation`), which depends on `mart_account_activity`.
