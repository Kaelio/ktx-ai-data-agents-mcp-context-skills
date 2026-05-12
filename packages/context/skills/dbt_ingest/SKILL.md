---
name: dbt_ingest
description: Map dbt `schema.yml` / `properties.yml` models and sources into KTX semantic-layer overlays and column notes. Covers `sources:` vs `models:`, column `data_tests` (not_null, unique, accepted_values, relationships), and how bundle-time writes complement manifest backfill from git sync. Load when the WorkUnit's `skillNames` includes `dbt_ingest` or when raw files are dbt YAML under `models/` / `sources/`.
callers: [memory_agent]
---

# dbt → KTX (bundle ingest)

Use this skill for **uploaded** dbt projects (`dbt_project.yml` at stage root, `models/**`, `sources/**`, `schema.yml`). There is **no** `fetch()` in v1 — scheduled `dbt parse` / `manifest.json` pulls are out of scope; host-provided dbt sync may still backfill structured test metadata into `_schema` on the next sync.

## Mapping (models / sources → SL)

| dbt | KTX | Notes |
|-----|--------|--------|
| `models:` entry with `columns:` | **Overlay** on the manifest table with the same name (after `discover_data` / `entity_details`) | One SL source per physical table; model name may differ from DB name — resolve with `read_raw_file` + warehouse context. |
| `sources:` → `tables:` | Same as models; use `identifier` when present instead of logical `name`. | Schema + name must match how the connection sees tables. |
| Column `description` | `descriptions.user` or merged `descriptions` map on the column | Do not overwrite `dbt` description keys from sync. |
| `data_tests: not_null` / `unique` | Short hint in column `descriptions` or notes: “dbt: not null”, “dbt: unique” | Full structured metadata lands in manifest via **sync**; the skill keeps bundle-time SL text useful for the agent. |
| `accepted_values` | Add a **brief** line in the column description: allowed values (truncate long lists) | Also mention enum-like use in `discover_data` / filters. |
| `relationships` | Add or confirm `joins:` on the overlay **only** when `to` resolves to a real table via `read_raw_file` + `discover_data` / `entity_details` | If the ref cannot be resolved, capture the intent in a wiki page instead. |

## Physical schema grounding

dbt YAML is documentation and test metadata; it is not permission to invent physical columns. Before writing any table-backed SL source, confirm the real warehouse shape with `discover_data`, `sl_discover`, or `entity_details` and use only confirmed column names in `columns:`, `grain:`, `joins:`, `segments:`, and `measures[].expr`.

For dbt context-source ingest, the dbt connection is usually not the warehouse connection. Call `sl_discover` without `connectionId` first, then write overlays to the connection that owns the matching manifest-backed source (for example `postgres-warehouse`), not to the dbt connection (for example `dbt-main`). If no matching manifest-backed source is visible on any warehouse connection, do not call `sl_write_source`; record `emit_unmapped_fallback` and keep the fact wiki-only.

If a `models:` entry has no `columns:` block, or the available raw files do not confirm the physical column names, do **not** synthesize a full standalone source. Write a wiki note or a description-only overlay for the resolved manifest table instead. If a business metric is described but its referenced column is not confirmed in the warehouse schema, omit the measure and capture the unresolved intent in the wiki.

Include `rawPaths` on every `wiki_write`, `sl_write_source`, and `sl_edit_source` call with only the dbt YAML files that directly support the action.

After every `sl_write_source`, call `sl_validate`. A validation error saying a declared column or measure reference is absent from the physical table is a hard stop: re-read the warehouse-backed source and rewrite with confirmed names, or remove the invalid SL fields.

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

## 1.1 test hints (descriptions / meta)

When YAML shows `accepted_values` or `not_null`, add **short** hints into `columns[].descriptions` (e.g. under `user`) or freeform column notes so chat and validation see intent before the next git sync refreshes `constraints` / `enum_values` in `_schema`. Keep hints under a few words when possible.

## Overlap with MetricFlow

If the same bundle also has MetricFlow `semantic_models:` / `metrics:`, the **`metricflow_ingest`** skill owns semantic/metric shapes. This skill focuses on **raw dbt schema** YAML (`models`, `sources`, tests). If both apply, load `metricflow_ingest` first when the file is clearly MetricFlow; otherwise use `dbt_ingest` for `schema.yml` without semantic_models.

## Do not

- Do not run `dbt` CLI or assume `target/` / `manifest.json` exists in the upload.
- Do not invent column names, grain keys, or measure expressions from dbt model names, descriptions, tests, or common naming patterns.
- Do not write `columns:`, `grain:`, or `measures:` for a dbt model unless those exact column names are confirmed by dbt YAML columns or warehouse schema discovery.
- Do not invent joins from `relationships` tests if the target model/table is not found in SL or the warehouse.
- Do not read `peerFileIndex` paths — use `read_raw_file` only on `rawFiles` and `dependencyPaths` from the WorkUnit.
