---
name: historic_sql_table_digest
description: Convert one changed historic-SQL table usage bucket into typed table usage evidence for deterministic _schema projection.
callers: [memory_agent]
---

# Historic SQL Table Digest

Use this skill when the WorkUnit raw file is one `tables/<schema>.<name>.json` file from the `historic-sql` adapter.

## Required Workflow

1. Read the WorkUnit notes first.
2. Call `read_raw_file` for the single `tables/<schema>.<name>.json` raw file.
3. Read `manifest.json` only if the table JSON omits the dialect or the WorkUnit notes are unclear.
4. Produce one concise usage narrative for this table from the staged table JSON.
5. Call `emit_historic_sql_evidence` exactly once with `kind: "table_usage"`.
6. Stop after the evidence tool succeeds.

## Evidence Shape

Call `emit_historic_sql_evidence` with this shape:

```json
{
  "kind": "table_usage",
  "table": "public.orders",
  "rawPath": "tables/public.orders.json",
  "usage": {
    "narrative": "Orders are repeatedly queried for paid/refunded lifecycle analysis and customer-level rollups.",
    "frequencyTier": "high",
    "commonFilters": ["status", "created_at"],
    "commonGroupBys": ["status"],
    "commonJoins": [{ "table": "public.customers", "on": ["customer_id"] }],
    "staleSince": null
  }
}
```

The `usage` object must match `tableUsageOutputSchema`.

## Interpretation Rules

- Treat `columnsByClause.where` as common filters.
- Treat `columnsByClause.groupBy` as common group-bys.
- Treat `observedJoins` as common joins.
- Use `stats.executionsBucket`, `stats.distinctUsersBucket`, and `stats.recencyBucket` to choose `frequencyTier`.
- Use `frequencyTier: "high"` only when executions and distinct users are both broad.
- Use `frequencyTier: "mid"` for repeated team usage that is not broad enough for high.
- Use `frequencyTier: "low"` for low-volume but present usage.
- Use `frequencyTier: "unused"` only when the table input explicitly says the table is stale or has no recent templates.
- Keep `narrative` short and concrete.

## Boundaries

- Do not call wiki_write.
- Do not call sl_write_source.
- Do not call sl_edit_source.
- Do not call context_candidate_write.
- Do not emit more than one table usage evidence object.
- Do not invent columns, joins, or tables that are absent from the staged JSON.
