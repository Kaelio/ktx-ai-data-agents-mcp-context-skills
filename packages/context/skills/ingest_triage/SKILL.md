---
name: ingest_triage
description: Classify and resolve conflicts detected during bundle ingest (structural duplicates, definitional contradictions, near-duplicate clusters, re-ingest changes, evictions).
callers: [memory_agent]
---

# Ingest Triage - conflict classification and resolution

This skill is loaded in two contexts:
- By a Stage 3 WorkUnit agent when `sl_discover` reveals that a prior WU (or a prior sync) already wrote something that overlaps with what the current WU is about to write.
- By the Stage 4 reconciliation agent for cross-WU sweeps and for eviction decisions.

Apply the rules below before every write that could collide with an existing artifact.

## Decision tree

1. **Is this the same artifact I'm producing now, or a different one with the same name?**
   Read both. If names match and content matches (modulo whitespace): no conflict - skip the write, the prior one stands.

2. **If content differs, is it an expression-only change (e.g. a different `sql:` body for the same measure name, same grain, same columns)?**
   Re-ingest change (expression-only): silently replace via `sl_edit_source`. No flag.

3. **If the difference is structural - grain, columns, filter, join shape - is the current bundle the re-ingest of a previously-ingested bundle (i.e. `priorProvenance` has a row for this raw file and artifact)?**
   Re-ingest change (semantic break): replace + flag. Record in the IngestReport's `conflicts_resolved` list with `flagged_for_human: true`.

4. **If there's no prior-sync row (both are from THIS job), check for same-ingest contradictions:**

   | Kind | Detection | Resolution |
   |---|---|---|
   | Structural duplicate | Same name, near-identical expression | Elect canonical by: (a) highest inbound-ref count from other sources; tiebreak: (b) lexicographically first unit key; (c) lexicographically first source name. Subsume losers into `<canonical>-variants.md` wiki page. Do NOT flag unless ambiguous. |
   | Near-duplicate cluster | Different names, overlapping shape (same table, similar formulas) | Same as structural; one canonical, others subsumed. Flag only if no canonical emerges. |
   | Definitional contradiction | Same name, substantively different formulas (different aggregation, different filters, different columns) | **Rename + capture**: disambiguate ALL variants with suffix derived from the domain (`churn_risk_engagement_based`, `churn_risk_billing_based`) and write a unified wiki page listing every variant with provenance. The contested name does NOT land in the SL. **Always flag.** |

5. **Eviction (Stage 4 only)**: for each entry in `eviction_list()`:
   - Remove the artifact (`sl_write_source` or `sl_edit_source` with `delete: true` for SL sources, `wiki_remove` for wiki pages).
   - Record the removal with `emit_eviction_decision` and `action: "removed"`.

## Why same-ingest vs re-ingest differs

Within ONE bundle there's no user signal telling us which duplicate wins - we capture all variants and flag. Across bundles, re-uploading IS the signal that the new state is intended - we replace silently for expression changes and flag for semantic breaks.

## Naming disambiguation hints

When you rename to disambiguate, prefer domain suffixes that match the containing view/table/collection name: `customers.churn_risk_score` → `customers.churn_risk_engagement_based` (if the `customer_churn` view computes it from engagement); `billing.churn_risk_score` → `billing.churn_risk_billing_based`. Avoid numeric suffixes (`churn_risk_1`, `churn_risk_2`) - they disclose nothing.

## Applying canonical pins

When the Stage 4 system prompt includes a `<canonical_pins>` block, treat each pin as a prior user decision for that `contestedKey`.

- If the pinned `canonicalArtifactKey` is present in the Stage Index or already exists in SL, keep it as the canonical artifact for that contested key.
- Disambiguate competing artifacts instead of using the contested name for them.
- Do not flag the pinned contested key solely because the variants disagree; the user has already chosen the canonical artifact.
- If the pinned artifact cannot be found and no current WU can recreate it, emit `emit_conflict_resolution` with `flaggedForHuman: true` and explain that the pin references a missing canonical artifact.

When a pin applies cleanly, call `emit_conflict_resolution` with `kind: "definitional_contradiction"`, `artifactKey` set to the pinned `canonicalArtifactKey`, `detail` describing the pinned election, and `flaggedForHuman: false`.

## What to write in the unified wiki page

When you perform rename + capture, also write one page named `<canonical-concept>-definitions.md` under the wiki GLOBAL scope. Structure:

- One heading per variant, referencing the disambiguated SL name.
- One paragraph per variant: what it computes, where it came from (raw file + line range), when to use it.
- A closing "Choosing between these" paragraph if the variants are legitimately domain-specific.

Do not attempt to rank variants or pick a "best" - that's user-override territory.

## Silence rules

Flag for human review when:
- You did rename + capture for a definitional contradiction (kind 3 above).
- You performed an eviction retention (kind 5, second row).
- An override constraint (from a Stage 4 re-run) conflicts with current inbound refs.

Do NOT flag:
- Same-content duplicate skip (trivial).
- Structural duplicate with clear canonical election.
- Expression-only re-ingest replace.
