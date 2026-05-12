---
summary: "Sales Ops → Customer Success implementation handoff: required fields, ownership, enterprise account risk, and policy that CS must not rediscover sales-stage details."
usage_mode: auto
sort_order: 0
tags:
  - policy
  - sales-ops
  - customer-success
refs:
  - orbit-company-overview
  - orbit-how-we-work
  - orbit-plan-segment-normalization
---

## Sales Ops → Customer Success Implementation Handoff

**Source:** Notion — People & Operating Norms, last edited 2026-05-07
**Owner:** Sales Ops (sender), Customer Success (receiver)

---

## Policy

Sales Ops must complete the handoff **before the first implementation call**. Customer Success should not need to rediscover any of the following details.

## Required Handoff Fields

| Field | Notes |
|---|---|
| Current plan | Starter / Growth / Enterprise — use canonical plan name, not legacy aliases |
| Account segment | self_serve / commercial / enterprise (see `orbit-plan-segment-normalization`) |
| Contract shape | Term, ARR, any discounts or custom terms |
| Renewal contact | Named person on the customer side responsible for renewal |
| Unusual approval requirements | Any non-standard approval routing the customer has configured or requested |
| Unusual supplier requirements | Any supplier onboarding exceptions or pre-approved vendor lists |

## Ownership

- **Sales Ops** is responsible for populating and delivering the handoff before the first implementation call.
- **Customer Success** is responsible for flagging missing fields to Sales Ops before the call, not during or after.
- If a field is unknown at handoff time, Sales Ops must note it explicitly as "unknown — to be resolved by [date]" rather than leaving it blank.

## Common Failure Mode

Handoffs that omit contract shape or renewal contact force CS to re-engage Sales Ops mid-implementation, which delays time-to-value and creates duplicate discovery work. This is the primary failure mode this process is designed to prevent.

---

## Enterprise Account Risk: Parent/Child Complexity

- Enterprise accounts with parent/child account structures require extra care during handoff.
- Small assumptions made during handoff in these accounts tend to produce large downstream problems (billing mismatches, approval routing failures, supplier onboarding gaps).
- When the account has parent/child complexity, Sales Ops must explicitly flag it in the handoff and document the account hierarchy before the first implementation call.
- CS should treat any undocumented parent/child relationship as a blocker — do not proceed with implementation setup until the structure is confirmed.

---

See also: [[orbit-company-overview]], [[orbit-how-we-work]], [[orbit-plan-segment-normalization]]
