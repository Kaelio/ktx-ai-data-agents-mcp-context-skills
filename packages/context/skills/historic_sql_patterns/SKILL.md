---
name: historic_sql_patterns
description: Identify recurring cross-table historic-SQL analytical intents from a bounded pattern shard and emit typed pattern evidence for deterministic wiki projection.
callers: [memory_agent]
---

# Historic SQL Patterns

Use this skill when the WorkUnit raw file is a `patterns-input/part-0001.json` style shard from the `historic-sql` adapter. Older staged bundles may still provide root `patterns-input.json`; when that is the WorkUnit raw file, read it the same way.

## Required Workflow

1. Read the WorkUnit notes first.
2. Find the single pattern input file listed under the WorkUnit `rawFiles` section.
3. Call `read_raw_file` for that exact raw file path.
4. Identify recurring analytical intents that span at least two tables and have repeated usage signal.
5. Emit one `pattern` evidence object per durable cross-table intent by calling `emit_historic_sql_evidence`.
6. Set each evidence object's `rawPath` to the exact raw file path read in step 3.
7. Stop after all pattern evidence has been emitted.

Every join column mentioned in pattern descriptions must be verified via
entity_details for both sides of the join.

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

## Evidence Shape

Each call to `emit_historic_sql_evidence` must use this shape:

```json
{
  "kind": "pattern",
  "rawPath": "patterns-input/part-0001.json",
  "pattern": {
    "slug": "order-lifecycle-analysis",
    "title": "Order Lifecycle Analysis",
    "narrative": "Analysts compare order statuses with customer segments to understand lifecycle movement.",
    "definitionSql": "select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id group by o.status",
    "tablesInvolved": ["public.orders", "public.customers"],
    "slRefs": ["orders", "customers"],
    "constituentTemplateIds": ["pg:1", "pg:2"]
  }
}
```

The `pattern` object must match `patternOutputSchema`; multiple calls together must form `patternsArraySchema`.

## Pattern Selection Rules

- Prefer patterns that involve two or more tables.
- Prefer templates with `executionsBucket` at least `10-100` and `distinctUsersBucket` above solo usage.
- Merge templates into one pattern only when the business intent is the same.
- Use a stable kebab-case slug based on intent, not a template id.
- Set `definitionSql` to the clearest representative SQL from a constituent template.
- Set `slRefs` to source names when the source name is obvious from table names; omit uncertain refs rather than guessing.
- Treat each pattern shard independently; do not read peer shard files from `peerFileIndex`.

## Boundaries

- Do not call wiki_write.
- Do not call sl_write_source.
- Do not call sl_edit_source.
- Do not call context_candidate_write.
- Do not create single-table pattern pages.
- Do not copy credentials, tokens, user emails, or unredacted literals into evidence.
