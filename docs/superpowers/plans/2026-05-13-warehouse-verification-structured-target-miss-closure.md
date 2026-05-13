# Warehouse Verification Structured Target Miss Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `entity_details` return model-visible not-found evidence for every documented target shape, including structured `{catalog, db, name, column?}` targets.

**Architecture:** Keep the existing warehouse verification module. Add focused tests for missing structured table and column targets, then route structured target labels through the same candidate lookup used by display targets while preserving exact structured resolution.

**Tech Stack:** TypeScript, Node 22, Vitest, AI SDK v6 tools, Zod, KTX ingest tools.

---

## Audit Summary

The implemented plans have landed the warehouse verification tools, ingest
runner wiring, adapter warehouse target fan-out, CLI read-only query executor,
and prompt-shape closures. Focused verification passed on May 13, 2026:

```bash
pnpm --filter @ktx/context exec vitest run src/connections/dialects.test.ts src/connections/read-only-sql.test.ts src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts src/ingest/tools/warehouse-verification/entity-details.tool.test.ts src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts src/ingest/tools/warehouse-verification/discover-data.tool.test.ts src/ingest/ingest-prompts.test.ts src/ingest/ingest-runtime-assets.test.ts src/memory/memory-runtime-assets.test.ts src/ingest/local-adapters.test.ts src/ingest/adapters/notion/notion.adapter.test.ts src/ingest/adapters/lookml/lookml.adapter.test.ts src/ingest/adapters/metricflow/metricflow.adapter.test.ts
pnpm --filter @ktx/cli exec vitest run src/ingest-query-executor.test.ts src/ingest.test.ts -t "supplies a scan-connector query executor"
rg -n -U "sql_execution\\(\\{\\s*\\n\\s*sql:" packages/context/skills packages/context/prompts
rg -n "wiki_sl_search|sl_describe_table|orbit_analytics\\.customer" packages/context/skills packages/context/prompts packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts packages/context/src/sl/tools/sl-warehouse-validation.ts
```

Remaining v1-blocking gap:

- `entity_details` accepts structured targets, but if a structured table target
  does not exist, it records `structured.missing` and emits no markdown. Tool
  outputs are sent to the model as markdown only, so the synthesis agent gets
  an empty response instead of the required "Not found in scan" verification
  signal.

Non-blocking gaps remain out of scope for this v1 plan:

- Full DDL-style `entity_details` formatting with FK and profile summaries.
- AST-backed SQL validation for data-modifying CTE bodies.
- Dialect-specific row-limit wrapping for SQL Server probes.
- Search over generated `enrichment/descriptions.json`.
- Per-WorkUnit reuse of a single `WarehouseCatalogService` instance for cache
  hits across separate tool calls.
- A deterministic fake-LLM end-to-end Notion hallucination regression.
- Cleanup of legacy demo Orbit wiki fixtures that still mention
  `orbit_analytics.customer`.

## File Structure

Modify these files:

- `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`: add failing coverage for missing structured targets.
- `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`: render missing structured targets into markdown and reuse candidate lookup.

### Task 1: Report Structured Target Misses In `entity_details`

**Files:**
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`

- [ ] **Step 1: Add failing structured miss tests**

In `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`, add these tests after `reports missing explicit columns instead of returning an empty column list`:

```ts
  it('reports missing structured table targets in model-visible markdown', async () => {
    const result = await tool.call(
      {
        connectionName: 'warehouse',
        targets: [{ catalog: null, db: 'public', name: 'orderz' }],
      },
      context,
    );

    expect(result.markdown).toContain('Not found in scan: public.orderz');
    expect(result.markdown).toContain('Closest matches: orders');
    expect(result.structured.resolved).toHaveLength(0);
    expect(result.structured.missing).toHaveLength(1);
  });

  it('reports missing structured column targets in model-visible markdown', async () => {
    const result = await tool.call(
      {
        connectionName: 'warehouse',
        targets: [{ catalog: null, db: 'public', name: 'orders', column: 'plan_tier' }],
      },
      context,
    );

    expect(result.markdown).toContain('Column not found in scan: public.orders.plan_tier');
    expect(result.markdown).toContain('Available columns: id, status');
    expect(result.structured.resolved).toHaveLength(0);
    expect(result.structured.missing).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the failing focused test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/entity-details.tool.test.ts -t "structured"
```

Expected: FAIL. The first new test must fail because `result.markdown` does not contain `Not found in scan: public.orderz`.

- [ ] **Step 3: Add structured target labels and candidate lookup**

In `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`, add this type alias after `type EntityDetailsInput = z.infer<typeof entityDetailsInputSchema>;`:

```ts
type EntityDetailsTarget = EntityDetailsInput['targets'][number];
```

Add these helpers after `function allowedConnectionNames(context: ToolContext): ReadonlySet<string> | null { ... }`:

```ts
function targetLabel(target: EntityDetailsTarget): string {
  if ('display' in target) {
    return target.display;
  }
  return [target.catalog, target.db, target.name, target.column].filter((part): part is string => !!part).join('.');
}

function appendMissingTargetMarkdown(parts: string[], target: EntityDetailsTarget, candidates: KtxTableRef[]): void {
  parts.push(`Not found in scan: ${targetLabel(target)}`);
  if (candidates.length > 0) {
    parts.push(`Closest matches: ${candidates.map((candidate) => candidate.name).join(', ')}`);
  }
}

async function resolveTarget(
  catalog: WarehouseCatalogService,
  connectionName: string,
  target: EntityDetailsTarget,
): Promise<{ resolved: (KtxTableRef & { column?: string }) | null; candidates: KtxTableRef[] }> {
  if ('display' in target) {
    return catalog.resolveDisplayTarget(connectionName, target.display);
  }

  const candidateResolution = await catalog.resolveDisplayTarget(connectionName, targetLabel(target));
  return {
    resolved: {
      catalog: target.catalog,
      db: target.db,
      name: target.name,
      column: target.column,
    },
    candidates: candidateResolution.candidates,
  };
}
```

Then replace the `const resolution = ...` block inside the `for (const target of input.targets)` loop with:

```ts
      const resolution = await resolveTarget(catalog, input.connectionName, target);
```

Replace the missing-resolution block with:

```ts
      if (!resolution.resolved) {
        missing.push({ target, candidates: resolution.candidates });
        appendMissingTargetMarkdown(parts, target, resolution.candidates);
        continue;
      }
```

Replace the missing-detail block with:

```ts
      if (!detail) {
        missing.push({ target, candidates: resolution.candidates });
        appendMissingTargetMarkdown(parts, target, resolution.candidates);
        continue;
      }
```

- [ ] **Step 4: Run the focused entity-details tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run warehouse verification regression tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts src/ingest/tools/warehouse-verification/entity-details.tool.test.ts src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
git commit -m "fix(context): report structured entity detail misses"
```

## Self-review

Spec coverage:

- The original `entity_details` contract says structured and display targets
  are mixed shapes and unresolved targets must produce `Not found in scan` with
  candidates. This plan adds that model-visible behavior for structured table
  misses and preserves the existing column-miss behavior.

Placeholder scan:

- This plan contains no deferred implementation placeholders.

Type consistency:

- The plan uses the existing `WarehouseCatalogService`, `KtxTableRef`,
  `EntityDetailsStructured`, and `ToolOutput` types without adding public API
  compatibility wrappers.
