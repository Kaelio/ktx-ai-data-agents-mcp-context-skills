---
name: live_database_ingest
description: Capture semantic-layer and knowledge updates from a live database schema snapshot.
callers: [memory_agent]
---

# Live Database Ingest

Use this skill when the ingest work unit contains raw files under
`raw-sources/<connectionId>/live-database/<syncId>/`.

## Workflow

1. Read the table JSON file listed in the work unit.
2. Read `connection.json` to understand the snapshot metadata.
3. Read `foreign-keys.json` when the table has a foreign key or when joins are
   needed for the semantic-layer source.
4. Create or update one semantic-layer source for the table with
   `sl_write_source`.
5. Use the physical table name from the raw JSON as the source `table` field.
6. Preserve database comments as `descriptions.db` on tables and columns.
7. Add joins only when the foreign key index names both sides.
8. Write wiki pages only for durable business meaning that is present in table
   or column comments.
9. Run `sl_validate` for the table source before the work unit completes.

Sample values come from the scan record; do not invent values not present in
relationship-profile.json.

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
   run a `sql_execution` probe:
   `SELECT DISTINCT <col> FROM <ref> LIMIT 50`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution` with `SELECT 1 FROM <ref> LIMIT 0`. If it errors, the
     identifier is fictional.
   - Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body,
     citing the exact raw path that mentioned it.
   - When recording `emit_unmapped_fallback` with `no_physical_table`, include
     the failing probe error in `clarification`.
5. Never copy `<schema>.<table>` placeholder strings from these instructions
   into output.

## Source shape

For a raw table with this shape:

```json
{
  "name": "orders",
  "db": "public",
  "columns": [
    { "name": "id", "type": "integer", "nullable": false, "primaryKey": true }
  ]
}
```

Write a semantic-layer source with this shape:

```yaml
name: orders
table: public.orders
grain: id
columns:
  - name: id
    type: number
```

Use `string`, `number`, `time`, or `boolean` for column types. When a database
type is ambiguous, use `string`.

## Boundaries

The raw snapshot is structural evidence. Do not invent measures, segments,
business definitions, or joins that are not present in the snapshot files.
