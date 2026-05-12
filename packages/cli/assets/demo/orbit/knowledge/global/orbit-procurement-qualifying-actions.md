---
summary: "Qualifying procurement actions for weekly active requester counts: non-internal, non-test requesters on large active contracts. Covers golden week metric and supplier onboarding."
usage_mode: auto
sort_order: 0
tags:
  - procurement
  - product
  - governed-metric
  - weekly-active-requesters
  - suppliers
sl_refs:
  - mart_procurement_activity
---

# Procurement — Qualifying Actions & Weekly Active Requesters

**Governed metric key:** `weekly_active_requesters`
**Owner team:** product
**Notion:** `notion://notion_page_procurement_instrumentation#qualifying-procurement-actions`
**Sources:** `mart_procurement_activity`, `int_procurement_qualifying_actions`

## Qualifying Action Definition

A qualifying procurement action is any activity by a **non-internal, non-test** requester on a **large active contract** within the measurement week. Captured in `int_procurement_qualifying_actions`.

Qualifying action types include:
- Submitting a purchase request (`stg_purchase_requests`, status: submitted/approved)
- Supplier onboarding milestones (`stg_supplier_onboarding_events`, event_type: profile_completed, approved)
- Purchase order creation (`stg_purchase_orders`)

## Exclusions

- Accounts with `lifecycle_status IN ('internal', 'test')` on `stg_accounts`
- Requesters without an approved purchase request in the window

## Supplier Onboarding Milestones

`invited` → `profile_started` → `profile_completed` → `approved`

## Approval Decisions (`stg_approval_events`)

`approved`, `rejected`, `returned`

## Dashboard

Exposed via the **Growth Activation Dashboard** (`https://orbit-demo.example.com/dashboards/activation`), which depends on `mart_account_activity`.
