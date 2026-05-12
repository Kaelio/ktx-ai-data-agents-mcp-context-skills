---
summary: "dbt exposures declared in models/exposures.yml: three dashboards (Retention Executive, Executive Revenue, Growth Activation) with their upstream mart dependencies and owners."
usage_mode: auto
sort_order: 0
tags:
  - dbt
  - exposures
  - dashboards
  - orbit
sl_refs:
  - mart_nrr_quarterly
  - mart_retention_movement_breakout
  - mart_arr_daily
  - mart_revenue_daily
  - mart_account_activity
---

# Orbit dbt Exposures

Declared in `models/exposures.yml`. All exposures are type `dashboard` with maturity `high` or `medium`.

## Retention Executive Dashboard

- **URL:** https://orbit-demo.example.com/dashboards/retention
- **Maturity:** high
- **Owner:** Analytics (analytics@orbit-demo.example.com)
- **Depends on:** `mart_nrr_quarterly`, `mart_retention_movement_breakout`
- **Description:** Executive retention view covering NRR and movement breakout.

## Executive Revenue Dashboard

- **URL:** https://orbit-demo.example.com/dashboards/revenue
- **Maturity:** high
- **Owner:** Finance (finance@orbit-demo.example.com)
- **Depends on:** `mart_arr_daily`, `mart_revenue_daily`
- **Description:** Board reporting view for ARR and gross-to-net revenue.

## Growth Activation Dashboard

- **URL:** https://orbit-demo.example.com/dashboards/activation
- **Maturity:** medium
- **Owner:** Growth (growth@orbit-demo.example.com)
- **Depends on:** `mart_account_activity`
- **Description:** Activation policy comparison around the January 2026 workflow update.
