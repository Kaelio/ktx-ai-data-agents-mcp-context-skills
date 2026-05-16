---
name: ktx-analytics
description: Use when answering a question that needs data from a KTX-connected database - investigating, analyzing, "how many", "show me", "what's the breakdown of", finding records by value, exploring tables, comparing periods, explaining metrics, or any data-analysis request. Triggers even when the user does not say "analytics"; if the answer requires querying a configured KTX connection, this skill applies.
---

# KTX Analytics Workflow

You have access to KTX MCP tools for data discovery, semantic-layer analysis, raw read-only SQL, wiki context, and memory ingest. Follow this workflow.

<workflow>
1. **Discover** - call `discover_data` first to see what exists across wiki pages, semantic-layer sources, metrics, dimensions, raw tables, and columns. Returns refs only.
2. **Inspect top hits in parallel** - for each promising ref:
   - `kind: 'wiki'` -> `wiki_read`
   - `kind: 'sl_source'`, `kind: 'sl_measure'`, or `kind: 'sl_dimension'` -> `sl_read_source`
   - `kind: 'table'` or `kind: 'column'` -> `entity_details`
3. **Resolve business values** - if the user named a value such as "Acme Corp", "enterprise", or "status=shipped", call `dictionary_search` to find which column holds it.
4. **Plan the analysis** - identify the grain, metrics, dimensions, filters, time window, and expected row limits before querying.
5. **Query** -
   - Prefer `sl_query` when the semantic layer covers the question.
   - Use `sql_execution` only for questions the semantic layer does not cover.
6. **Validate and explain** - sanity-check totals, filters, null handling, and time zones. State the source tables or semantic-layer objects used.
7. **Capture durable learnings** - call `memory_ingest` whenever a turn produces something worth remembering (business rules, metric definitions, schema gotchas, recurring findings) **or** whenever the user asks you to remember something. Pass markdown in `content` including any source context the memory agent should weigh. Each call is a feedback loop; better notes today mean smarter `discover_data` and `wiki_search` results tomorrow.
</workflow>

<rules>
- Always run `discover_data` before writing SQL. Do not guess table names.
- Prefer the semantic layer over raw SQL when both can answer the question; measures are the source of truth.
- Read entity details before writing SQL against an unfamiliar table. Do not assume column names.
- Treat `sql_execution` as read-only. Writes are rejected by the server.
- Validate value mentions with `dictionary_search` instead of guessing case or spelling. Treat a `dictionary_search` miss as non-authoritative. The index is built from profile-sampled values, so a missing value may simply have been outside the sample. Follow up with `sql_execution` against the most plausible columns before concluding the value is absent.
- When `connection_list` shows multiple connections, pass an explicit `connectionId` to every tool that takes one and where user intent pins a specific warehouse. Required: `entity_details`, `sl_read_source`, and `sql_execution`. Required when user intent is warehouse-specific, including wording like "in our warehouse" or "this warehouse": `memory_ingest`; without `connectionId`, the memory agent cannot update the semantic layer and the knowledge lands as wiki-only. Pass `connectionId` when intent pins a warehouse, otherwise omit for unscoped discovery: `sl_query`, `discover_data`, and `dictionary_search`. Never pass `connectionId` to `connection_list`, `wiki_search`, `wiki_read`, or `memory_ingest_status`. If intent is ambiguous for a required-or-scoped tool, ask the user which warehouse before calling.
- Show compact result tables for small outputs. For broad results, summarize the top findings and mention the applied limit.
- Ask a concise clarification only when the metric, date range, entity, or grain is genuinely ambiguous and cannot be inferred from context.
</rules>

<examples>
**Input:** "How many orders did Acme Corp place last month?"

**Workflow:**
1. `dictionary_search({ values: ["Acme Corp"] })` finds `customers.name`.
2. `discover_data({ query: "orders customer monthly" })` finds an orders semantic-layer source.
3. `sl_read_source({ connectionId: "warehouse", sourceName: "orders_facts" })` confirms the source grain, measures, and dimensions.
4. `sl_query({ connectionId: "warehouse", measures: ["order_count"], filters: ["customer_name = 'Acme Corp'"] })` answers through the semantic layer.
5. `memory_ingest({ connectionId: "warehouse", content: "Acme Corp order analysis used orders_facts.order_count filtered by customers.name = 'Acme Corp'. Source: current analysis turn." })` captures the durable finding.

---

**Input:** "What columns does the events table have?"

**Workflow:**
1. `discover_data({ query: "events table" })` returns a `table` ref.
2. `entity_details({ connectionId: "warehouse", entities: [{ table: "analytics.events" }] })` returns columns, types, and foreign keys.
3. Answer directly. No query is needed.

---

**Input:** "Heads up: ARR is always reported in cents in our warehouse."

**Workflow:**
1. If multiple connections exist, call `connection_list` and identify the warehouse the user means. Ask if ambiguous.
2. `memory_ingest({ connectionId: "warehouse", content: "ARR is reported in cents (not dollars) in this warehouse. Multiply by 0.01 for dollar amounts. Source: user clarification." })` remembers the warehouse-specific rule without running an analysis turn.
</examples>
