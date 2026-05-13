---
summary: "Orbit product design policy: new features must make requester or approver experience clearer; complexity for its own sake is not built."
usage_mode: auto
sort_order: 0
tags:
  - product
  - policy
  - orbit
refs:
  - orbit-product-review-checklist
  - orbit-company-overview
---

## Orbit Product Design Principles

**Source:** Notion — Product & Customers, last edited 2026-05-07

---

## Core Policy

Orbit does not build complexity for its own sake.

## Feature Complexity Rule

- When a new feature adds multiple configuration choices, it **must** be evaluated on whether it makes the requester or approver experience clearer.
- If the added configuration does not make the requester or approver experience clearer, the feature should not be built as designed.
- The test: can a first-time requester or approver use the new feature without needing to understand the configuration choices behind it?

## Design Heuristics

- **Default to simpler.** If two designs achieve the same outcome, prefer the one with fewer choices exposed to the end user.
- **Configuration is a last resort.** Expose configuration only when different customers have legitimately incompatible needs that cannot be resolved by a sensible default.
- **Requester and approver clarity are the primary UX metrics.** Speed, completeness, and confidence for those two roles are the measures of a good Orbit feature.

## What This Is Not

- This principle does not prohibit powerful or flexible features.
- It prohibits features where the complexity is internal to Orbit's implementation but leaks into the requester or approver experience without benefit.

---

See also: [[orbit-product-review-checklist]], [[orbit-company-overview]]
