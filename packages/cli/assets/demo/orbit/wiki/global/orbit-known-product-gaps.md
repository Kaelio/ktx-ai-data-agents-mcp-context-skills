---
summary: "Known Orbit product friction: approval routing for non-standard cases (weird supplier setups, split budgets, renewal changes) causes teams to fall back to side channels outside Orbit."
usage_mode: auto
sort_order: 0
tags:
  - product
  - orbit
  - customer-success
refs:
  - orbit-customer-stakeholder-needs
  - orbit-product-review-checklist
  - orbit-company-overview
---

## Known Product Gaps and Friction Points

**Source:** Notion - Product & Customers (Notes from Recent Customer Calls), last edited 2026-05-07

---

## Primary Friction: Approval Routing for Exceptions

The primary source of customer friction is **approval routing around non-standard cases**. When a procurement request does not fit the standard routing rules, teams fall back to side channels (email, Slack, spreadsheets) outside Orbit.

### Specific Triggers

| Trigger | Why It Causes Fallback |
|---|---|
| **Weird supplier setups** | Non-standard supplier configurations don't fit the default approval chain |
| **Split department budgets** | Requests that span multiple budget owners require manual coordination not supported in the routing UI |
| **Renewal changes** | Mid-term contract changes (scope, price, term) don't map cleanly to the new-request flow |

## Impact

- Teams that fall back to side channels for exceptions create a split record: part of the procurement history is in Orbit, part is not.
- This undermines the supplier file completeness that Procurement requires (see [[orbit-customer-stakeholder-needs]]).
- It also creates renewal risk because CS cannot see the full picture of what was agreed.

## Status

- This is a known, unresolved gap as of May 2026.
- Treat as a standing assumption in roadmap and analysis decisions until a fix is shipped and validated.
- Do not design analyses or reports that assume all procurement activity flows through Orbit for accounts with known exception patterns.

---

See also: [[orbit-customer-stakeholder-needs]], [[orbit-product-review-checklist]], [[orbit-company-overview]]
