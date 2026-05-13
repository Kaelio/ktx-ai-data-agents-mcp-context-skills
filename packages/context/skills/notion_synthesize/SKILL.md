---
name: notion_synthesize
description: Synthesize durable KTX wiki pages and semantic-layer sources from staged Notion pages, databases, data-source rows, and clustered Notion evidence. Load when a WorkUnit contains Notion raw files or Notion evidence chunks.
callers: [memory_agent]
---

# Notion Cluster Synthesis

Use this skill when a WorkUnit contains staged Notion content from `pages/**`, `databases/**`, `data-sources/**`, or clustered Notion evidence.

## Role

Each WorkUnit is either a single Notion page/span or a topical cluster of related Notion pages, pre-grouped by embedding similarity. Read the assigned raw files, then write a small set of durable wiki entries and, when applicable, semantic-layer sources that synthesize the WorkUnit's knowledge. Write final memory directly; do not write candidates.

## Required Workflow

1. Read the WorkUnit notes and rawFiles list. Page content lives in `page.md`; `metadata.json` holds title, path, object type, data-source ids, last edited metadata, and properties.
2. For each assigned page, call `read_raw_file`, or `read_raw_span` for oversized pages when the notes specify a span.
3. Search `wiki_search` for existing pages that overlap the WorkUnit topics. Prefer updating an existing page over creating a duplicate.
4. Use `context_evidence_search`, `context_evidence_read`, and `context_evidence_neighbors` to pull supporting chunks when indexed evidence is relevant. Pass `chunkId` and `documentId` values verbatim as returned by the evidence tools.
5. Write durable business knowledge with `wiki_write`. Aim for a small number of high-quality pages per WorkUnit or cluster. Include `rawPaths` with the exact Notion raw files that support each page.
6. When the Notion content defines a reusable dataset, metric, segment, join rule, source-of-truth mapping, or table with explicit columns, load `sl_capture`, discover existing sources first with `sl_discover` or `sl_read_source`, then use `sl_write_source` or `sl_edit_source` only for a confirmed mapped non-Notion target source. Include `rawPaths` with the exact Notion raw files that support the SL action. If no mapped target exists, call `emit_unmapped_fallback` and keep the content wiki-only.
7. For every deleted raw path in the Eviction Set, call `eviction_list`, decide retention, then `context_eviction_decision_write`. Do this even when no wiki write is needed.

## What To Capture

Capture durable, reusable company knowledge:

- metric definitions, KPI formulas, named business concepts, and reusable filters
- workflows, policies, ownership rules, approval conventions, and source-of-truth mappings
- data-source row pages that describe tables, columns, semantic models, dashboards, or business entities
- cross-system aliases connecting Notion terms to warehouse, dbt, Looker, Metabase, or MetricFlow names
- caveats, conflicts, supersession notes, and customer/product assumptions affecting future analysis

Skip noisy or transient content:

- meeting notes with no reusable rule
- task lists, project status updates, and time-bounded snapshots
- duplicate docs with no new fact
- database metadata pages when row pages contain the actual business content
- transient announcements and long page summaries

## Quality

Prefer fewer, stronger entries. Every wiki entry must cite at least one Notion page or row using its path and last edited date when available. When evidence conflicts, write a conflict note inside the wiki page rather than choosing silently.

If a clustered WorkUnit includes several related pages, synthesize the shared rule or concept instead of writing one thin page per source. For oversized page spans, read only the assigned span unless the WorkUnit explicitly asks for neighboring context.

Search existing wiki pages for the same `tables:` or `sl_refs:` frontmatter and for source-of-truth aliases before creating a new page. If an existing page already documents the same warehouse object or business concept, update it instead of creating a differently named duplicate.

## Citation Style

```md
## Revenue Recognition
- Booked revenue excludes refunds and test accounts.
- Source: Notion - Company Handbook / Finance / Revenue Recognition, last edited 2026-04-12.
- Conflict note: An older Sales Ops page uses gross revenue before refunds; treat the Finance Handbook as current unless Finance says otherwise.
```

## Semantic-Layer Rules

- Load `sl_capture` before writing or editing SL sources.
- Discover existing sources first with `sl_discover`; read existing source YAML before editing.
- Prefer overlays on manifest-backed sources over standalone SQL.
- If Notion describes a dashboard or metric but does not define executable logic, write a wiki page and attach `sl_refs` only after confirming the referenced source exists.
- Notion `dataSourceCount` counts Notion databases/data sources only. It does not prove that a warehouse/dbt table has or lacks a mapped semantic-layer source.
- Do not create SL sources under the Notion connection just because a page mentions a warehouse, dbt, Looker, or Metabase object. Use the mapped warehouse/source connection after discovery, or emit an unmapped fallback and write wiki-only.
- Distinguish fallback reasons precisely: if a non-Notion warehouse/dbt connection exists but `sl_discover` cannot find the named table/source, use `no_physical_table`; reserve `no_connection_mapping` for cases where there is no plausible non-Notion target connection at all.
- If `sl_discover` resolves the table/source, do not call `emit_unmapped_fallback` for that table. Use the resolved source for `sl_refs`, overlay edits, or wiki-only documentation.
- When calling `emit_unmapped_fallback`, pass the table or source identifier as `tableRef` (e.g. `tableRef: "<schema>.<table>"`) — the tool generates the canonical detail string from the reason code and `tableRef`. Use the optional `clarification` field only to add context that does not contradict the reason. Do not restate the reason in `clarification`.

## Identifier Verification Protocol

Before writing a wiki page or SL source on any topic:

1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw
   tables already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
SL source, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionName, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues.
3. For literal values from the source, such as status codes or plan tiers,
   check whether they appear in `entity_details` sampleValues for the relevant
   column. If sampleValues is short or the sample may have missed real values,
   run a `sql_execution` probe with the same warehouse connection name:
   `sql_execution({connectionName, sql: "SELECT DISTINCT <col> FROM <ref> LIMIT 50"})`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution({connectionName, sql: "SELECT 1 FROM <ref> LIMIT 0"})`.
     If it errors, the identifier is fictional.
   - Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body,
     citing the exact raw path that mentioned it.
   - When recording `emit_unmapped_fallback` with `no_physical_table`, include
     the failing probe error in `clarification`.
5. Never copy `<schema>.<table>` placeholder strings from these instructions
   into output.

## Tools

Allowed: `read_raw_file`, `read_raw_span`, `wiki_search`, `wiki_read`, `wiki_write`, `discover_data`, `entity_details`, `sql_execution`, `sl_discover`, `sl_read_source`, `sl_write_source`, `sl_edit_source`, `sl_validate`, `context_evidence_search`, `context_evidence_read`, `context_evidence_neighbors`, `emit_unmapped_fallback`, `eviction_list`, `context_eviction_decision_write`.

Not allowed: `context_candidate_write`, `context_candidate_mark`.
