---
summary: "Plan code normalization rules: pro_plus maps to growth. Reporting segments (self_serve, commercial, enterprise) are derived from canonical_plan_code × size_band via stg_plan_segment_mapping."
usage_mode: auto
sort_order: 0
tags:
  - segmentation
  - plans
  - sales-ops
  - governed-metric
  - normalization
sl_refs:
  - mart_account_segments
---

# Plan & Segment Normalization

**Governed metric key:** `segment`  
**Owner team:** sales_ops  
**Notion:** `notion://notion_page_sales_ops_segmentation#growth-plan-normalization`  
**Sources:** `mart_account_segments`, `stg_plan_segment_mapping`, `stg_plans`

## Canonical Plan Codes

| Raw / Legacy Code | Canonical Code |
|---|---|
| `starter` | `starter` |
| `growth` | `growth` |
| `pro_plus` | **`growth`** (normalized) |
| `enterprise` | `enterprise` |

The normalization is applied via `stg_plans.canonical_plan_code`. `mart_account_segments.normalized_plan_code` reflects the post-normalization value.

## Reporting Segments

Segments are derived from `canonical_plan_code` × `size_band` using the effective-dated lookup `stg_plan_segment_mapping`:

| Segment | Typical plan + size band |
|---|---|
| `self_serve` | starter / smb |
| `commercial` | growth / mid_market |
| `enterprise` | enterprise / enterprise |

## Size Bands

`smb`, `mid_market`, `enterprise`

## Effective Dating

`stg_plan_segment_mapping` has `effective_from` / `effective_to` columns, allowing segment rules to change over time without rewriting history.
