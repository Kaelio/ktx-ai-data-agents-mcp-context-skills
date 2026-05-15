# Semantic Layer Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a standalone, scannable Concepts page that explains the semantic-layer internals while positioning KTX as a broader context layer.

**Architecture:** Implement this as docs-only MDX content inside the existing Fumadocs tree. The new page uses inline MDX diagrams and Fumadocs color tokens, matching the custom diagram pattern already used in `the-context-layer.mdx`.

**Tech Stack:** MDX, Fumadocs content, Next.js docs site, pnpm workspace commands.

---

### Task 1: Add Concepts Navigation Entry

**Files:**
- Modify: `docs-site/content/docs/concepts/meta.json`

- [x] **Step 1: Update the Concepts page order**

Replace the `pages` array with:

```json
{
  "title": "Concepts",
  "defaultOpen": true,
  "pages": ["the-context-layer", "semantic-layer-internals", "context-as-code"]
}
```

- [x] **Step 2: Verify JSON parses**

Run:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('docs-site/content/docs/concepts/meta.json', 'utf8')); console.log('concepts meta ok')"
```

Expected output:

```text
concepts meta ok
```

### Task 2: Create the Semantic Layer Internals Page

**Files:**
- Create: `docs-site/content/docs/concepts/semantic-layer-internals.mdx`

- [x] **Step 1: Add frontmatter and opening positioning**

Create the page with this frontmatter and opening section:

```mdx
---
title: Semantic Layer Internals
description: How KTX uses join graphs, grain, and relationship metadata to turn context into safe SQL.
---

KTX is a context layer for agents. Its semantic layer is the query-planning core
that turns reviewed context into safe SQL.

Use this page to understand the mechanics behind KTX's semantic execution:
the join graph, how KTX builds and maintains it, and how that graph prevents
classic analytics errors like fan-out and ambiguous join paths.

| KTX is | KTX is not just |
|---|---|
| A context layer for agents | A metric definition store |
| A system for ingesting, reviewing, and serving analytics context | A markdown saver |
| A semantic execution layer plus wiki pages, scans, provenance, and agent workflows | A replacement for every BI semantic layer |
```

- [x] **Step 2: Add the system-fit diagram**

Add a `Where the semantic layer fits` section with a custom `not-prose` diagram.
The diagram must show:

```text
Context inputs -> Semantic layer engine -> Agent workflows
```

The semantic-layer box must be visually prominent and list:

```text
join graph
grain
measures
relationships
safe query planning
```

- [x] **Step 3: Add the join graph section**

Add `## The join graph` with:

- one short paragraph defining nodes and edges;
- bullets for why the graph matters;
- an inline diagram using `orders`, `customers`, `order_items`, and `refunds`.

The section must include this claim in plain language:

```text
The graph lets KTX choose valid paths, reject unsafe paths, and reason about
whether a join preserves or multiplies rows before SQL is generated.
```

- [x] **Step 4: Add build and maintenance sections**

Add `## How KTX builds it` and `## How KTX maintains it`.

`How KTX builds it` must cover these inputs:

```text
declared primary keys
declared foreign keys
inferred relationships
dbt, MetricFlow, and LookML imports
query history
analyst review
```

`How KTX maintains it` must show this loop:

```text
ingest evidence -> YAML diff -> validation -> analyst review -> agent use -> corrections
```

- [x] **Step 5: Add the fan-out and safe execution sections**

Add `## Why grain and relationships matter` with a fan-out example comparing
orders joined to order items. Include a compact table with columns:

```text
Problem
What happens
How KTX avoids it
```

Add `## How the execution engine uses the graph` with a before/after table:

```text
Naive SQL shape
Semantic-layer SQL shape
```

The safe path must mention:

```text
pre-aggregates fact measures at their own grain before joining dimensions
```

- [x] **Step 6: Add agent outcome links**

Add a closing `## What this means for agents` section with bullets explaining
that agents can:

```text
search semantic sources
compile SQL through ktx sl query
validate changes before review
patch YAML and Markdown files in git
explain provenance and metric meaning
```

End with links to:

```mdx
[Writing Context](/docs/guides/writing-context)
[ktx sl](/docs/cli-reference/ktx-sl)
```

### Task 3: Add the Cross-Link from The Context Layer

**Files:**
- Modify: `docs-site/content/docs/concepts/the-context-layer.mdx`

- [x] **Step 1: Replace the semantic sources paragraph with a scannable block**

Find the `**Semantic sources**` paragraph under `KTX organizes context into four pillars`.
Replace the long paragraph with:

```mdx
**Semantic sources** are YAML definitions that describe your data in terms
agents can reason about:

- source tables or SQL queries;
- row grain;
- typed columns;
- valid joins;
- named measures, filters, and segments.

This is where "revenue means `sum(amount)` excluding refunds" lives. For the
join graph, fan-out protections, and execution mechanics, read
[Semantic Layer Internals](/docs/concepts/semantic-layer-internals).
```

- [x] **Step 2: Confirm the page still owns the product positioning**

Search the edited file:

```bash
rg -n "context layer|Semantic Layer Internals|semantic layer - that's a critical component" docs-site/content/docs/concepts/the-context-layer.mdx
```

Expected: output includes the existing context-layer framing and the new internals link.

### Task 4: Fix Mobile Docs Header Overflow

**Files:**
- Modify: `docs-site/app/docs/[[...slug]]/page.tsx`

- [x] **Step 1: Stack title actions on narrow screens**

Replace the non-hero page header wrapper:

```tsx
<div className="flex items-start justify-between gap-4">
```

with:

```tsx
<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
```

This keeps desktop layout unchanged while preventing the action buttons from
forcing horizontal overflow on mobile.

- [x] **Step 2: Allow the docs article to shrink in the layout grid**

Update the `DocsPage` and `DocsBody` wrappers:

```tsx
<DocsPage
  toc={page.data.toc}
  className="!mx-0 min-w-0 !max-w-[calc(100vw-2rem)] md:!mx-auto md:!max-w-[900px]"
>
```

```tsx
<DocsBody className="min-w-0 max-w-full">
```

This prevents tables, code blocks, and custom diagrams from forcing the
Fumadocs main article column wider than the mobile viewport, overrides the
library's built-in max-width rule on mobile, aligns the article to the left on
mobile, and preserves the normal centered desktop max width.

If long words still clip under mobile viewport capture, add the same wrapping
behavior used by the Fumadocs sidebar:

```tsx
<DocsDescription className="wrap-anywhere">
  {page.data.description}
</DocsDescription>
```

```tsx
<DocsBody className="min-w-0 max-w-full wrap-anywhere">
```

- [x] **Step 3: Recheck mobile render**

Capture or inspect a 390px-wide render of:

```text
http://127.0.0.1:3000/docs/concepts/semantic-layer-internals
```

Expected: the title, description, action buttons, and positioning block stay
within the viewport.

### Task 5: Verify Docs Content and Build

**Files:**
- Check: `docs-site/content/docs/concepts/semantic-layer-internals.mdx`
- Check: `docs-site/content/docs/concepts/the-context-layer.mdx`
- Check: `docs-site/content/docs/concepts/meta.json`
- Check: `docs-site/app/docs/[[...slug]]/page.tsx`

- [x] **Step 1: Run content checks**

Run:

```bash
rg -n "KTX is a context layer|markdown saver|fan-out|join graph|pre-aggregates|Semantic Layer Internals" docs-site/content/docs/concepts
```

Expected: matches appear in the new page and the cross-link appears in
`the-context-layer.mdx`.

- [x] **Step 2: Build the docs site**

Run:

```bash
pnpm --filter ktx-docs build
```

Expected: build exits 0.

- [x] **Step 3: Preview locally**

Run:

```bash
pnpm --filter ktx-docs dev
```

Open:

```text
http://localhost:3000/docs/concepts/semantic-layer-internals
```

Inspect desktop and mobile widths. The opening should clearly position KTX as a
context layer, the Concepts navigation should list the new page, and diagrams
should not overlap or produce unreadable text.

- [x] **Step 4: Commit implementation**

Run:

```bash
git status --short
git add docs-site/content/docs/concepts/meta.json docs-site/content/docs/concepts/semantic-layer-internals.mdx docs-site/content/docs/concepts/the-context-layer.mdx docs-site/app/docs/[[...slug]]/page.tsx docs/superpowers/plans/2026-05-15-semantic-layer-docs.md
git commit -m "docs: add semantic layer internals concept"
```
