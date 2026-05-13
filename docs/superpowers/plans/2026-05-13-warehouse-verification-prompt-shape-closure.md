# Warehouse Verification Prompt Shape Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every warehouse-verification prompt use KTX's shipped
`sql_execution` input shape so ingest agents include `connectionName` when they
probe warehouse identifiers.

**Architecture:** Keep the warehouse verification tool code unchanged. Add
prompt-asset tests that reject Kaelio's old session-only SQL examples, then
update the shared identifier protocol and the three remaining per-skill SQL
probe examples that still show the legacy shape.

**Tech Stack:** Markdown skill prompts, TypeScript, Vitest, pnpm workspace
commands.

---

## Audit Summary

The warehouse verification tools, runner wiring, adapter target fan-out, and
focused tests are present. Focused verification passed:

```bash
pnpm --filter @ktx/context exec vitest run src/connections/dialects.test.ts src/connections/read-only-sql.test.ts src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts src/ingest/tools/warehouse-verification/entity-details.tool.test.ts src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts src/ingest/tools/warehouse-verification/discover-data.tool.test.ts src/ingest/ingest-prompts.test.ts src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts src/ingest/local-adapters.test.ts src/ingest/adapters/notion/notion.adapter.test.ts src/ingest/adapters/lookml/lookml.adapter.test.ts src/ingest/adapters/metricflow/metricflow.adapter.test.ts
pnpm --filter @ktx/cli exec vitest run src/ingest-query-executor.test.ts src/ingest.test.ts -t "supplies a scan-connector query executor"
```

Remaining v1-blocking gap:

- `packages/context/skills/lookml_ingest/SKILL.md`,
  `packages/context/skills/metricflow_ingest/SKILL.md`, and
  `packages/context/skills/sl_capture/SKILL.md` still contain
  `sql_execution({ sql ... })` / "session shape" guidance inherited from
  Kaelio. KTX's tool contract is
  `sql_execution({connectionName, sql, rowLimit?})`, so these examples can make
  agents call the shipped tool with invalid input.

Non-blocking gaps remain out of scope for this v1 plan:

- Full DDL-style `entity_details` formatting with FK profile summaries.
- AST-backed SQL validation for data-modifying CTE bodies.
- Search over generated `enrichment/descriptions.json`.
- Per-WorkUnit reuse of a single `WarehouseCatalogService` instance for cache
  hits across separate tool calls.
- A deterministic fake-LLM end-to-end Notion hallucination regression. Prompt
  guards and tool contract tests cover the v1 contract; a broader behavior
  regression can land as follow-up.

## File Structure

Modify these files:

- `packages/context/src/memory/memory-runtime-assets.test.ts`: add a prompt
  guard that rejects the legacy session-only `sql_execution` shape.
- `packages/context/src/ingest/ingest-runtime-assets.test.ts`: strengthen the
  shared prompt asset assertion for the KTX `connectionName` SQL shape.
- `packages/context/skills/_shared/identifier-verification.md`: make both SQL
  probe instructions show the KTX `connectionName` argument.
- `packages/context/skills/notion_synthesize/SKILL.md`: inline the updated
  protocol block.
- `packages/context/skills/dbt_ingest/SKILL.md`: inline the updated protocol
  block.
- `packages/context/skills/lookml_ingest/SKILL.md`: inline the updated protocol
  block and fix the legacy SQL fallback example.
- `packages/context/skills/looker_ingest/SKILL.md`: inline the updated
  protocol block.
- `packages/context/skills/metabase_ingest/SKILL.md`: inline the updated
  protocol block.
- `packages/context/skills/metricflow_ingest/SKILL.md`: inline the updated
  protocol block and fix the legacy SQL fallback example.
- `packages/context/skills/live_database_ingest/SKILL.md`: inline the updated
  protocol block.
- `packages/context/skills/historic_sql_table_digest/SKILL.md`: inline the
  updated protocol block.
- `packages/context/skills/historic_sql_patterns/SKILL.md`: inline the updated
  protocol block.
- `packages/context/skills/knowledge_capture/SKILL.md`: inline the updated
  protocol block.
- `packages/context/skills/sl_capture/SKILL.md`: inline the updated protocol
  block and fix the join-discovery SQL example.

### Task 1: Add Prompt Guards For The KTX SQL Tool Shape

**Files:**
- Modify: `packages/context/src/memory/memory-runtime-assets.test.ts`
- Modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Add the failing memory asset guard**

In `packages/context/src/memory/memory-runtime-assets.test.ts`, add this test
after `does not ship stale warehouse verification tool names or fictional
identifiers`:

```ts
  it('ships only the KTX connectionName sql_execution call shape in writer guidance', async () => {
    const shared = await readFile(join(skillsDir, '_shared', 'identifier-verification.md'), 'utf-8');

    expect(shared).toContain('sql_execution({connectionName, sql: "SELECT DISTINCT');
    expect(shared).toContain('sql_execution({connectionName, sql: "SELECT 1 FROM');

    for (const skillName of verificationWriterSkills) {
      const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
      expect(body).toContain('sql_execution({connectionName');
      expect(body).not.toContain('sql_execution({ sql');
      expect(body).not.toContain('session shape');
      expect(body).not.toContain('connection is already pinned by the ingest session');
    }
  });
```

- [ ] **Step 2: Strengthen the shared ingest asset guard**

In `packages/context/src/ingest/ingest-runtime-assets.test.ts`, update
`packages identifier verification prompt assets` so the final assertions are:

```ts
    expect(shared).toContain('discover_data');
    expect(shared).toContain('entity_details');
    expect(shared).toContain('sql_execution');
    expect(shared).toContain('sql_execution({connectionName, sql: "SELECT DISTINCT');
    expect(shared).toContain('sql_execution({connectionName, sql: "SELECT 1 FROM');
```

- [ ] **Step 3: Run the failing prompt guards**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runtime-assets.test.ts src/ingest/ingest-runtime-assets.test.ts
```

Expected: FAIL. The failure must mention at least one current legacy string:
`sql_execution({ sql`, `session shape`, or missing
`sql_execution({connectionName`.

### Task 2: Update The Shared Identifier Verification Protocol

**Files:**
- Modify: `packages/context/skills/_shared/identifier-verification.md`
- Modify: `packages/context/skills/notion_synthesize/SKILL.md`
- Modify: `packages/context/skills/dbt_ingest/SKILL.md`
- Modify: `packages/context/skills/lookml_ingest/SKILL.md`
- Modify: `packages/context/skills/looker_ingest/SKILL.md`
- Modify: `packages/context/skills/metabase_ingest/SKILL.md`
- Modify: `packages/context/skills/metricflow_ingest/SKILL.md`
- Modify: `packages/context/skills/live_database_ingest/SKILL.md`
- Modify: `packages/context/skills/historic_sql_table_digest/SKILL.md`
- Modify: `packages/context/skills/historic_sql_patterns/SKILL.md`
- Modify: `packages/context/skills/knowledge_capture/SKILL.md`
- Modify: `packages/context/skills/sl_capture/SKILL.md`

- [ ] **Step 1: Replace the shared protocol text**

Replace the full `## Identifier Verification Protocol` block in
`packages/context/skills/_shared/identifier-verification.md` with:

```md
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
```

- [ ] **Step 2: Inline the same protocol in every writer skill**

Replace the existing `## Identifier Verification Protocol` block in each writer
skill with the exact block from Step 1:

```bash
packages/context/skills/notion_synthesize/SKILL.md
packages/context/skills/dbt_ingest/SKILL.md
packages/context/skills/lookml_ingest/SKILL.md
packages/context/skills/looker_ingest/SKILL.md
packages/context/skills/metabase_ingest/SKILL.md
packages/context/skills/metricflow_ingest/SKILL.md
packages/context/skills/live_database_ingest/SKILL.md
packages/context/skills/historic_sql_table_digest/SKILL.md
packages/context/skills/historic_sql_patterns/SKILL.md
packages/context/skills/knowledge_capture/SKILL.md
packages/context/skills/sl_capture/SKILL.md
```

- [ ] **Step 3: Run the shared prompt asset tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runtime-assets.test.ts src/ingest/ingest-runtime-assets.test.ts
```

Expected: still FAIL because the per-skill legacy SQL examples in LookML,
MetricFlow, and `sl_capture` have not been fixed yet.

### Task 3: Fix Legacy Per-Skill SQL Examples

**Files:**
- Modify: `packages/context/skills/lookml_ingest/SKILL.md`
- Modify: `packages/context/skills/metricflow_ingest/SKILL.md`
- Modify: `packages/context/skills/sl_capture/SKILL.md`

- [ ] **Step 1: Fix the LookML fallback probe example**

In `packages/context/skills/lookml_ingest/SKILL.md`, replace the current
Required flow item 2 with:

```md
2. If the table isn't in the manifest, use the warehouse `connectionName`
   returned by `discover_data` or the target connection chosen from
   `sl_discover`, then call a dialect-appropriate SQL probe with that
   connection name, for example:
   `sql_execution({connectionName: "warehouse", sql: "SELECT 1 FROM analytics.orders LIMIT 0"})`.
   Replace `warehouse`, `analytics`, and `orders` with the verified connection,
   schema or dataset, and table from the WorkUnit evidence.
```

- [ ] **Step 2: Fix the MetricFlow fallback probe example**

In `packages/context/skills/metricflow_ingest/SKILL.md`, replace the paragraph
that begins `If \`sl_discover\` errors` with:

```md
If `sl_discover` errors because no such table exists, use `discover_data` and
`entity_details` to find the warehouse target. If a SQL probe is still needed,
call `sql_execution` with the same warehouse connection name, for example:
`sql_execution({connectionName: "warehouse", sql: "SELECT 1 FROM analytics.orders LIMIT 0"})`.
**Never invent column names** - every column in `columns:`, `grain:`, and
`sql:` must be sourced from raw files, `entity_details`, or a successful SQL
probe.
```

- [ ] **Step 3: Fix the `sl_capture` join probe example**

In `packages/context/skills/sl_capture/SKILL.md`, replace Tool sequence item 6
with:

```md
6. For join discovery: use `sql_execution({connectionName: "warehouse", sql: "SELECT count(*) FROM public.orders o JOIN public.customers c ON c.id = o.customer_id LIMIT 20"})` with the target warehouse connection name and dialect-correct table names to verify the join key exists in both tables and assess cardinality before declaring the join.
```

- [ ] **Step 4: Run the prompt asset tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runtime-assets.test.ts src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS. The tests must report 2 files passed.

### Task 4: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused warehouse prompt and tool tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/connections/dialects.test.ts src/connections/read-only-sql.test.ts src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts src/ingest/tools/warehouse-verification/entity-details.tool.test.ts src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts src/ingest/tools/warehouse-verification/discover-data.tool.test.ts src/ingest/ingest-prompts.test.ts src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git diff -- packages/context/src/memory/memory-runtime-assets.test.ts packages/context/src/ingest/ingest-runtime-assets.test.ts packages/context/skills/_shared/identifier-verification.md packages/context/skills/notion_synthesize/SKILL.md packages/context/skills/dbt_ingest/SKILL.md packages/context/skills/lookml_ingest/SKILL.md packages/context/skills/looker_ingest/SKILL.md packages/context/skills/metabase_ingest/SKILL.md packages/context/skills/metricflow_ingest/SKILL.md packages/context/skills/live_database_ingest/SKILL.md packages/context/skills/historic_sql_table_digest/SKILL.md packages/context/skills/historic_sql_patterns/SKILL.md packages/context/skills/knowledge_capture/SKILL.md packages/context/skills/sl_capture/SKILL.md
```

Expected: only prompt wording and prompt-asset guards changed. No tool
implementation files changed.

- [ ] **Step 4: Commit**

Run:

```bash
git add packages/context/src/memory/memory-runtime-assets.test.ts packages/context/src/ingest/ingest-runtime-assets.test.ts packages/context/skills/_shared/identifier-verification.md packages/context/skills/notion_synthesize/SKILL.md packages/context/skills/dbt_ingest/SKILL.md packages/context/skills/lookml_ingest/SKILL.md packages/context/skills/looker_ingest/SKILL.md packages/context/skills/metabase_ingest/SKILL.md packages/context/skills/metricflow_ingest/SKILL.md packages/context/skills/live_database_ingest/SKILL.md packages/context/skills/historic_sql_table_digest/SKILL.md packages/context/skills/historic_sql_patterns/SKILL.md packages/context/skills/knowledge_capture/SKILL.md packages/context/skills/sl_capture/SKILL.md
git commit -m "fix(context): align warehouse sql probe prompt shape"
```

Expected: one focused commit.

## Self-Review

Spec coverage:

- The original spec requires `sql_execution` inputs to include
  `connectionName`; this plan removes contradictory session-only examples from
  all active writer guidance.
- The shared protocol remains in `_shared` and inlined in every synthesis
  writer skill named by the original spec.
- The tool implementation remains unchanged because the shipped schema already
  enforces the v1 contract.

Placeholder scan:

- The plan has no deferred implementation markers.
- Prompt examples use concrete `warehouse`, `analytics`, and `orders` example
  names only to demonstrate JSON shape, and each example tells the worker to
  replace them with discovered evidence.

Type consistency:

- Tests assert the exact KTX tool call shape:
  `sql_execution({connectionName, sql: ...})`.
- Prompt wording consistently uses `connectionName`, matching
  `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts`.
