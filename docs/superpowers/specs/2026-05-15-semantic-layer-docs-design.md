# Semantic Layer Docs Design

**Date:** 2026-05-15
**Status:** Design - pending implementation plan

## Goal

Add a concise Concepts page that explains the semantic layer as the query
planning engine inside KTX's broader context layer.

The page should make the technical depth visible to skeptical data users
without positioning KTX as only a semantic-layer product. Success means a reader
understands:

- KTX is a context layer for agents.
- The semantic layer is one core subsystem inside that context layer.
- The join graph, grain declarations, and relationship metadata are what make
  generated SQL safer than schema-only or markdown-only approaches.
- KTX maintains this semantic layer through ingest, validation, analyst edits,
  and reviewable files.

## Current State

The docs currently explain semantic sources in two places:

- `docs-site/content/docs/concepts/the-context-layer.mdx` describes semantic
  sources as one pillar of KTX context.
- `docs-site/content/docs/guides/writing-context.mdx` documents the YAML fields
  for sources, measures, joins, grain, validation, and common errors.

That content is useful, but the differentiator is not visually obvious. The
semantic layer is embedded in longer narrative pages, so readers can miss the
hard parts: join graph construction, fan-out prevention, chasm traps, and query
planning.

## Positioning

Create a standalone Concepts page with a guarded title such as
`Semantic Layer Internals` or `The Semantic Engine Inside KTX`.

The first screen must frame the product clearly:

> KTX is a context layer. Its semantic layer is the query-planning core that
> turns reviewed context into safe SQL.

The page should avoid a title like `Semantic Layer` by itself because that can
make KTX look like a narrow semantic-layer tool. The page should repeatedly show
the semantic layer between the broader context inputs and the agent workflows it
supports.

Add a short cross-link from `the-context-layer.mdx` so the existing overview
keeps owning the product category. That section should say the semantic layer is
one critical pillar, then link to the internals page for readers who want the
mechanics.

## Page Structure

Add `docs-site/content/docs/concepts/semantic-layer-internals.mdx` and include
it in `docs-site/content/docs/concepts/meta.json` after `the-context-layer`.

Recommended sections:

1. `What this page explains`
   - One short paragraph.
   - A two-column `KTX is / KTX is not just` table.

2. `Where the semantic layer fits`
   - A visual block showing:
     `context inputs -> semantic layer engine -> agent workflows`.
   - Inputs include semantic YAML, wiki pages, scans, and provenance.
   - Outputs include search, SQL generation, explanations, edits, and review.

3. `The join graph`
   - Explain nodes as semantic sources and edges as validated joins.
   - Show a small graph with `orders`, `customers`, `order_items`, and
     `refunds`.
   - Keep text to one or two short paragraphs plus bullets.

4. `How KTX builds it`
   - Show a pipeline from database evidence and imported modeling tools to
     reviewable YAML.
   - Mention declared keys, inferred relationships, dbt/MetricFlow/LookML
     imports, query history, validation, and analyst review.

5. `How KTX maintains it`
   - Show a feedback loop:
     ingest evidence -> YAML diff -> validation -> analyst review -> agent use
     -> corrections.
   - Emphasize that files remain the source of truth.

6. `Why grain and relationships matter`
   - Use the fan-out problem as the central example.
   - Compare a naive join against a safe semantic-layer plan.
   - Explain many-to-one, one-to-many, many-to-many, chasm traps, and ambiguous
     paths in compact bullets.

7. `How the execution engine uses the graph`
   - Explain path selection, unsafe path rejection, pre-aggregation into CTEs,
     filter placement, and dialect transpilation.
   - Include a small before/after SQL-shape diagram or table.

8. `What this means for agents`
   - Summarize why this is more than saving markdown:
     agents can inspect, query, validate, edit, and review the same semantic
     files.
   - Link to `Writing Context` and `ktx sl`.

## Scannability Rules

The implementation should shorten long prose blocks across the touched pages.

- Keep most text blocks to one or two paragraphs.
- Prefer bullets, tables, diagrams, and compact callout blocks between prose.
- Avoid four-paragraph narrative runs.
- Use diagrams before dense explanations when the concept is spatial.
- Keep examples concrete and copy-pasteable.

## Visual Direction

Use the existing docs-site MDX style rather than a new design system. The current
`the-context-layer.mdx` page already uses custom `not-prose` MDX diagrams with
Fumadocs color tokens; the new page should follow that pattern.

The diagrams should feel like technical product documentation:

- restrained, dense, and readable;
- high contrast for the semantic-layer engine box;
- visible arrows or adjacency that make flow obvious;
- tables for classification and comparison;
- no marketing hero, decorative gradients, or generic card-heavy layout.

## Non-goals

- Do not redesign the whole docs site.
- Do not rename KTX concepts, packages, commands, or directories.
- Do not claim KTX replaces every BI or semantic-layer system.
- Do not add implementation details that are not true in the current codebase.
- Do not expand the page into a long reference for every YAML field; keep that
  in `Writing Context`.

## Verification

Because this is docs-only work, verification should focus on the docs site:

- Run the docs build or the narrowest available docs-site type/build check.
- Run formatting or lint checks if the docs package exposes them.
- Preview the page locally and inspect desktop and mobile widths.
- Confirm the page is listed in Concepts navigation.
- Confirm the opening section clearly says KTX is a context layer, not just a
  semantic-layer tool.

If implementation changes only MDX and metadata, TypeScript workspace tests are
not required unless the page introduces shared components.

## Acceptance Criteria

- A standalone Concepts page explains the semantic-layer internals.
- The Context Layer page links to the new internals page without making the
  overview longer.
- The new page includes diagrams for the system fit, join graph, maintenance
  loop, and fan-out-safe execution path.
- Long prose is broken into scannable sections with bullets, tables, and visual
  interruptions.
- The positioning consistently says KTX is a context layer with a semantic
  execution core.
- Docs-site verification passes or any skipped check is reported with a reason.
