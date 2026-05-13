---
summary: "orbit_analytics.customer: one row per customer. Columns, joins to account/subscription_event, measures (customer_count, paying_customer_count, mrr), and watch-outs."
usage_mode: auto
sort_order: 0
tags:
  - data-source
  - customers
  - orbit-analytics
  - measures
refs:
  - orbit-plan-segment-normalization
  - orbit-activation-kpi-glossary
tables:
  - orbit_analytics.customer
  - orbit_analytics.account
  - orbit_analytics.subscription_event
---

# Orbit Customers Source

**Table:** `orbit_analytics.customer`
**Grain:** one row per signed-up customer
**Source:** Notion — Orbit Demo Home / Data Team - Onboarding / Orbit Customers Source, last edited 2026-05-07

Use this when a question needs customer identity, plan tier, signup timing, recent activity, or the standard customer joins.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | number | Primary key, surrogate key |
| `email` | string | Login email, unique — **do not use as join key** |
| `name` | string | Display name |
| `country` | string | ISO 3166-1 alpha-2 code |
| `plan_tier` | string | One of `free`, `pro`, `enterprise` |
| `created_at` | time | UTC signup timestamp |
| `last_seen_at` | time | UTC most recent app activity |
| `email_verified_at` | time | UTC email verification timestamp (used in activation funnel) |

## Joins

- **one-to-many** → `orbit_analytics.account` on `customer.id = account.customer_id`
- **one-to-many** → `orbit_analytics.subscription_event` on `customer.id = subscription_event.customer_id`

Always join through `customer.id`. Do not join on `email`.

## Standard Measures

| Measure | Formula |
|---|---|
| `customer_count` | `count(distinct id)` |
| `paying_customer_count` | `count(distinct id) where plan_tier in ('pro', 'enterprise')` |
| `mrr` | `sum(subscription_event.amount) where event_type = 'renewed'` |

## Watch-outs

- **Join key:** Always use `customer.id`, never `email`.
- **Timezone:** `created_at` and `last_seen_at` are UTC. Confirm whether a question expects UTC or a local business day before filtering.
- **Paying vs. all:** `free` customers must be excluded from paying-customer follow-ups. Use `paying_customer_count`, not `customer_count`.
- **plan_tier values:** `free`, `pro`, `enterprise`. Note: use the canonical plan names from the account/contract layer (see `orbit-plan-segment-normalization`); `plan_tier` on this table uses `pro` rather than `growth`.
