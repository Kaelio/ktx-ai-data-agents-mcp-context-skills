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
