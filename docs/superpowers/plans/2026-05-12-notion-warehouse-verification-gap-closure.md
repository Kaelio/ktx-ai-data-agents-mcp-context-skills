# Notion Warehouse Verification Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1 gaps that prevent ingest agents, especially
Notion WorkUnits, from reliably verifying warehouse table and column
identifiers before writing wiki or semantic-layer output.

**Architecture:** Keep the existing warehouse verification tool module and
runner wiring. Add Notion target-warehouse scoping through the local adapter
factory, make the active WorkUnit prompt name the shipped tools, enforce
`allowedConnectionNames` in `discover_data`, and teach `entity_details` to
resolve and reject column-level display targets.

**Tech Stack:** TypeScript, Node 22, Vitest, AI SDK v6 tools, Zod, KTX local
ingest adapters, KTX file store.

---

## Audit summary

The previous implementation plan landed the main tool module and prompt
protocol, but four v1-blocking gaps remain:

- Notion ingest sessions still allow only the Notion connection unless a
  specific adapter supplies target IDs. `NotionSourceAdapter` does not supply
  target warehouse IDs, so the original Notion hallucination case cannot use
  `entity_details` or raw-schema `discover_data` for the warehouse connection.
- The active WorkUnit framing prompt still tells agents to call
  `wiki_sl_search` and `sl_describe_table`, which are not shipped KTX tools.
- `discover_data` accepts an explicit out-of-scope `connectionName` and still
  searches raw schema for that connection.
- `entity_details({ targets: [{ display: "schema.table.column" }] })` does not
  resolve column display strings and does not fail explicit missing-column
  targets.

Non-blocking gaps remain out of scope for this plan:

- Full DDL-style `entity_details` formatting with FK and profile summaries.
- AST-backed SQL read-only validation for data-modifying CTEs.
- Search over `enrichment/descriptions.json` for generated descriptions.
- Lexicographic latest-sync edge cases for non-timestamp sync IDs.
- Hard write-time validation in `wiki_write` and `emit_unmapped_fallback`.

## File structure

Modify these files:

- `packages/context/src/ingest/adapters/notion/notion.adapter.ts`: add
  configured target warehouse IDs and implement `listTargetConnectionIds()`.
- `packages/context/src/ingest/adapters/notion/notion.adapter.test.ts`: cover
  Notion target connection ID fan-out.
- `packages/context/src/ingest/local-adapters.ts`: pass primary warehouse IDs
  into `NotionSourceAdapter`.
- `packages/context/src/ingest/local-adapters.test.ts`: cover local Notion
  adapter target IDs.
- `packages/context/src/ingest/adapters/notion/chunk.ts`: update Notion
  WorkUnit notes to prefer the warehouse verification tools.
- `packages/context/src/ingest/adapters/notion/notion.adapter.test.ts`: update
  Notion note expectations.
- `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`: replace
  stale tool names in the active WorkUnit prompt.
- `packages/context/src/ingest/ingest-prompts.test.ts`: guard the WorkUnit
  prompt against stale tool names.
- `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`:
  refuse explicit out-of-scope connection names.
- `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`:
  cover `discover_data` scoping.
- `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`:
  add column-aware display-target resolution.
- `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`:
  cover column display resolution.
- `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`:
  use column-aware resolution and report missing columns.
- `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`:
  cover column display and missing-column behavior.

### Task 1: Give Notion ingest access to target warehouses

**Files:**
- Modify: `packages/context/src/ingest/adapters/notion/notion.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/notion/notion.adapter.test.ts`
- Modify: `packages/context/src/ingest/local-adapters.ts`
- Modify: `packages/context/src/ingest/local-adapters.test.ts`

- [ ] **Step 1: Write the failing Notion adapter test**

Add this test inside `describe('NotionSourceAdapter', ...)` in
`packages/context/src/ingest/adapters/notion/notion.adapter.test.ts`:

```ts
it('returns configured target warehouse connection ids', async () => {
  const adapter = new NotionSourceAdapter({
    targetConnectionIds: ['warehouse', 'warehouse', 'analytics'],
  });

  await expect(adapter.listTargetConnectionIds?.(stagedDir)).resolves.toEqual([
    'analytics',
    'warehouse',
  ]);
});
```

- [ ] **Step 2: Run the failing Notion adapter test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/adapters/notion/notion.adapter.test.ts -t "target warehouse connection ids"
```

Expected: FAIL because `NotionSourceAdapterDeps` has no
`targetConnectionIds` option and `NotionSourceAdapter` does not implement
`listTargetConnectionIds()`.

- [ ] **Step 3: Implement Notion target connection IDs**

Modify `packages/context/src/ingest/adapters/notion/notion.adapter.ts`:

```ts
export interface NotionSourceAdapterDeps {
  onPullSucceeded?: (ctx: NotionPullSucceededContext) => Promise<void>;
  logger?: NotionFetchLogger;
  targetConnectionIds?: string[];
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}
```

Add this method to `NotionSourceAdapter`:

```ts
  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return uniqueSorted(this.deps.targetConnectionIds);
  }
```

- [ ] **Step 4: Pass primary warehouses into the local Notion adapter**

Modify the Notion adapter construction in
`packages/context/src/ingest/local-adapters.ts`:

```ts
    new NotionSourceAdapter({
      targetConnectionIds: primaryWarehouseConnectionIds(project),
      ...(options.logger ? { logger: options.logger } : {}),
    }),
```

- [ ] **Step 5: Write the local adapter fan-out test**

Add this test to `packages/context/src/ingest/local-adapters.test.ts`:

```ts
it('passes primary warehouse connection ids to the local Notion adapter', async () => {
  const adapters = createDefaultLocalIngestAdapters(
    projectWithConnections({
      notion: {
        driver: 'notion',
        auth_token: 'secret',
        crawl_mode: 'selected_roots',
        root_page_ids: ['page-1'],
      },
      warehouse: {
        driver: 'postgres',
        url: 'postgresql://readonly@db.example.test/analytics',
      },
      docs: {
        driver: 'dbt',
        source_dir: './dbt',
      },
    } as never),
  );

  const notion = adapters.find((adapter) => adapter.source === 'notion');

  await expect(notion?.listTargetConnectionIds?.('/tmp/staged-notion')).resolves.toEqual([
    'warehouse',
  ]);
});
```

- [ ] **Step 6: Run the Notion target tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/notion/notion.adapter.test.ts -t "target warehouse connection ids" \
  src/ingest/local-adapters.test.ts -t "local Notion adapter"
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/adapters/notion/notion.adapter.ts \
  packages/context/src/ingest/adapters/notion/notion.adapter.test.ts \
  packages/context/src/ingest/local-adapters.ts \
  packages/context/src/ingest/local-adapters.test.ts
git commit -m "fix(context): expose target warehouses to Notion ingest"
```

### Task 2: Remove stale tool names from active ingest prompts

**Files:**
- Modify: `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`
- Modify: `packages/context/src/ingest/ingest-prompts.test.ts`
- Modify: `packages/context/src/ingest/adapters/notion/chunk.ts`
- Modify: `packages/context/src/ingest/adapters/notion/notion.adapter.test.ts`

- [ ] **Step 1: Add failing prompt guards**

Add this test to `packages/context/src/ingest/ingest-prompts.test.ts`:

```ts
it('uses shipped warehouse verification tools in the WorkUnit prompt', async () => {
  const prompt = await readFile(
    new URL('../../prompts/memory_agent_bundle_ingest_work_unit.md', import.meta.url),
    'utf-8',
  );

  expect(prompt).toContain('discover_data');
  expect(prompt).toContain('entity_details');
  expect(prompt).not.toContain('wiki_sl_search');
  expect(prompt).not.toContain('sl_describe_table');
});
```

- [ ] **Step 2: Run the failing prompt guard**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-prompts.test.ts -t "warehouse verification tools"
```

Expected: FAIL because the WorkUnit prompt still contains `wiki_sl_search` and
`sl_describe_table`.

- [ ] **Step 3: Update the WorkUnit framing prompt**

In `packages/context/prompts/memory_agent_bundle_ingest_work_unit.md`, replace
the first `<role>` paragraph with:

```md
You are processing ONE WorkUnit of a multi-file ingest bundle. The WorkUnit gives you a slice of raw source files (LookML views, dbt/MetricFlow YAMLs, Metabase card JSONs, Notion pages, or similar) and you must translate that slice into KTX semantic-layer sources and/or knowledge wiki pages, in one pass. Prior WorkUnits in this same job may have already written SL sources and wiki pages; their writes are visible on the working branch and discoverable with `discover_data`.
```

In workflow step 2, replace the final sentence with:

```md
The triage skill tells you how to react when `discover_data` reveals that a prior WU already wrote something overlapping.
```

In workflow step 4, replace the sentence that starts
`For each raw file:` with:

```md
4. For each raw file: call `read_raw_file` (or `read_raw_span` for slicing large files) to load content. Before writing a new SL source or wiki page, call `discover_data` for each candidate source, table, metric, or topic name to find prior-WU writes, existing wiki pages, SL sources, and raw warehouse matches; apply `ingest_triage` when you hit one, and apply any matching canonical pin before deciding whether to edit, rename, or skip.
```

In the `<do_not>` block, replace the physical-column rule with:

```md
- Do not invent physical column names or grain keys. For table-backed SL sources, every `columns:`, `grain:`, `joins:`, `segments:`, and `measures[].expr` column must come from raw-file column declarations or warehouse-backed discovery (`discover_data`, `sl_discover`, `entity_details`). If column names are not confirmed, capture the business context in wiki instead of writing a full SL source.
```

- [ ] **Step 4: Update Notion WorkUnit notes**

In `packages/context/src/ingest/adapters/notion/chunk.ts`, replace
`NOTION_SL_WRITE_GUIDANCE` with:

```ts
const NOTION_SL_WRITE_GUIDANCE =
  'Write wiki entries with wiki_write. Wiki keys must be flat slugs like orbit-company-overview, not orbit/company-overview. Search existing wiki pages, SL sources, and raw warehouse schema for the same tables or sl_refs with discover_data before creating a new page. Only write or edit SL sources after discover_data plus sl_discover/sl_read_source or entity_details confirms a mapped non-Notion target source; if no mapped target exists, emit_unmapped_fallback and keep the fact wiki-only. Notion dataSourceCount counts Notion databases/data sources only, not warehouse/dbt mappings. If a warehouse/dbt connection exists but the named table or source is absent, use reason no_physical_table rather than no_connection_mapping. Do not create SL sources under the Notion connection just because a page mentions a warehouse table.';
```

In the `reconcileNotes` array in the same file, replace:

```ts
      'Notion dataSourceCount is Notion-only; use sl_discover for warehouse/dbt mapping decisions.',
```

with:

```ts
      'Notion dataSourceCount is Notion-only; use discover_data/entity_details for warehouse/dbt mapping decisions.',
```

- [ ] **Step 5: Update Notion note expectations**

In `packages/context/src/ingest/adapters/notion/notion.adapter.test.ts`,
update the note expectations in `it('chunks changed Notion pages...')`:

```ts
expect(result.workUnits[0].notes).toContain('discover_data');
expect(result.workUnits[0].notes).toContain('entity_details');
```

Update the exact `reconcileNotes` expectation to:

```ts
expect(result.reconcileNotes).toEqual([
  'Notion maxKnowledgeCreatesPerRun=25',
  'Notion maxKnowledgeUpdatesPerRun=20',
  'Notion dataSourceCount is Notion-only; use discover_data/entity_details for warehouse/dbt mapping decisions.',
  'Reconcile Notion wiki pages sharing tables/sl_refs before creating distinct artifacts.',
]);
```

- [ ] **Step 6: Run prompt and Notion note tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/ingest-prompts.test.ts \
  src/ingest/adapters/notion/notion.adapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add \
  packages/context/prompts/memory_agent_bundle_ingest_work_unit.md \
  packages/context/src/ingest/ingest-prompts.test.ts \
  packages/context/src/ingest/adapters/notion/chunk.ts \
  packages/context/src/ingest/adapters/notion/notion.adapter.test.ts
git commit -m "fix(context): update ingest prompts for warehouse verification tools"
```

### Task 3: Enforce allowed connection scope in discover_data

**Files:**
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`

- [ ] **Step 1: Write the failing scoping test**

Add this test to
`packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`:

```ts
it('refuses explicit out-of-scope connection names', async () => {
  const result = await tool.call({ query: 'orders', connectionName: 'billing' }, context);

  expect(result.markdown).toContain('Connection "billing" is not available to this ingest stage.');
  expect(result.structured).toEqual({ wiki: null, sl: null, raw: null });
  expect(wikiSearchTool.call).not.toHaveBeenCalled();
  expect(slDiscoverTool.call).not.toHaveBeenCalled();
  expect(catalog.searchByName).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the failing scoping test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/discover-data.tool.test.ts -t "out-of-scope"
```

Expected: FAIL because `discover_data` currently searches raw schema for an
explicit `connectionName` even when it is not in `allowedConnectionNames`.

- [ ] **Step 3: Add the scope guard**

In
`packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`,
add this helper near `totalSources()`:

```ts
function allowedConnectionNames(context: ToolContext): ReadonlySet<string> | null {
  return context.session?.allowedConnectionNames ?? null;
}
```

At the top of `DiscoverDataTool.call()`, before the `sourceName` branch and
before calling any child tool, add:

```ts
    const allowed = allowedConnectionNames(context);
    if (input.connectionName && allowed && !allowed.has(input.connectionName)) {
      return {
        markdown: `Connection "${input.connectionName}" is not available to this ingest stage.`,
        structured: { wiki: null, sl: null, raw: null },
      };
    }
```

Then replace the raw connection-list construction with:

```ts
    const connections = input.connectionName ? [input.connectionName] : [...(allowed ?? [])].sort();
```

- [ ] **Step 4: Run discover_data tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
git commit -m "fix(context): scope raw schema discovery to allowed connections"
```

### Task 4: Fix column-level entity_details verification

**Files:**
- Modify: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`

- [ ] **Step 1: Write failing catalog column-target tests**

First update `seedLiveDatabaseScan()` in that test file so BigQuery tables have
a project/catalog. Replace the repeated inline table refs with:

```ts
const tableRef = {
  catalog: driver === 'bigquery' ? 'analytics' : null,
  db: driver === 'sqlite' ? null : 'public',
  name: 'orders',
};
```

Use `tableRef.catalog`, `tableRef.db`, and `tableRef.name` for the seeded
table and profile table references.

Then add these tests to
`packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`:

```ts
it('resolves postgres column display strings without treating the column as a table', async () => {
  await seedLiveDatabaseScan();
  const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

  await expect(catalog.resolveDisplayTarget('warehouse', 'public.orders.status')).resolves.toMatchObject({
    resolved: { catalog: null, db: 'public', name: 'orders', column: 'status' },
    candidates: [],
    dialect: 'postgres',
  });
});

it('resolves BigQuery column display strings with four parts', async () => {
  await seedLiveDatabaseScan('warehouse', 'sync-bigquery', 'bigquery');
  const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

  await expect(catalog.resolveDisplayTarget('warehouse', 'analytics.public.orders.status')).resolves.toMatchObject({
    resolved: { catalog: 'analytics', db: 'public', name: 'orders', column: 'status' },
    candidates: [],
    dialect: 'bigquery',
  });
});
```

- [ ] **Step 2: Run the failing catalog tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts -t "column display"
```

Expected: FAIL because `resolveDisplayTarget()` does not exist.

- [ ] **Step 3: Implement column-aware display resolution**

In
`packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`,
add this exported interface near `RawSchemaHit`:

```ts
export interface DisplayTargetResolution {
  resolved: (KtxTableRef & { column?: string }) | null;
  candidates: KtxTableRef[];
  dialect: string;
}
```

Add these helpers near `parseDisplay()`:

```ts
function expectedDisplayPartCount(driver: CatalogDriver): number {
  if (driver === 'sqlite' || driver === 'sqlite3') {
    return 1;
  }
  if (driver === 'bigquery' || driver === 'snowflake' || driver === 'sqlserver') {
    return 3;
  }
  return 2;
}

function parseColumnDisplay(driver: CatalogDriver, display: string): (KtxTableRef & { column: string }) | null {
  const parts = splitDisplay(display);
  const tablePartCount = expectedDisplayPartCount(driver);
  if (parts.length !== tablePartCount + 1) {
    return null;
  }
  const column = parts.at(-1);
  if (!column) {
    return null;
  }
  const table = parseDisplay(driver, parts.slice(0, -1).join('.'));
  return table ? { ...table, column } : null;
}
```

Add this method to `WarehouseCatalogService` after `resolveDisplay()`:

```ts
  async resolveDisplayTarget(connectionName: string, display: string): Promise<DisplayTargetResolution> {
    const catalog = await this.loadCatalog(connectionName);
    if (!catalog) {
      return { resolved: null, candidates: [], dialect: 'unknown' };
    }

    const dialect = getDialectForDriver(catalog.driver).type;
    const tableResolution = await this.resolveDisplay(connectionName, display);
    if (tableResolution.resolved) {
      return tableResolution;
    }

    const parsedColumn = parseColumnDisplay(catalog.driver, display);
    if (!parsedColumn) {
      return { resolved: null, candidates: bestCandidates(catalog.tables, display), dialect };
    }

    const table = catalog.tables.find((candidate) => refsEqual(candidate, parsedColumn));
    if (!table) {
      return { resolved: null, candidates: bestCandidates(catalog.tables, display), dialect };
    }

    return {
      resolved: {
        catalog: table.catalog,
        db: table.db,
        name: table.name,
        column: parsedColumn.column,
      },
      candidates: [],
      dialect,
    };
  }
```

- [ ] **Step 4: Write failing entity_details column tests**

Add these tests to
`packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`:

```ts
it('resolves display targets that include a column name', async () => {
  const result = await tool.call(
    { connectionName: 'warehouse', targets: [{ display: 'public.orders.status' }] },
    context,
  );

  expect(result.markdown).toContain('### public.orders');
  expect(result.markdown).toContain('- status (text, nullable=false)');
  expect(result.markdown).not.toContain('- id (integer');
  expect(result.structured.resolved).toHaveLength(1);
  expect(result.structured.resolved[0]?.columns.map((column) => column.name)).toEqual(['status']);
});

it('reports missing explicit columns instead of returning an empty column list', async () => {
  const result = await tool.call(
    { connectionName: 'warehouse', targets: [{ display: 'public.orders.plan_tier' }] },
    context,
  );

  expect(result.markdown).toContain('Column not found in scan: public.orders.plan_tier');
  expect(result.markdown).toContain('Available columns: id, status');
  expect(result.structured.resolved).toHaveLength(0);
  expect(result.structured.missing).toHaveLength(1);
});
```

- [ ] **Step 5: Run the failing entity_details tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/entity-details.tool.test.ts -t "column"
```

Expected: FAIL because display column targets are treated as table names and
missing columns are not reported.

- [ ] **Step 6: Use column-aware resolution in entity_details**

In
`packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`,
add this helper near `appendTableMarkdown()`:

```ts
function findColumn(detail: TableDetail, columnName: string): TableDetail['columns'][number] | null {
  const normalized = columnName.toLowerCase();
  return detail.columns.find((column) => column.name.toLowerCase() === normalized) ?? null;
}
```

Replace the display resolution block inside the `for (const target of
input.targets)` loop with:

```ts
      const resolution =
        'display' in target
          ? await catalog.resolveDisplayTarget(input.connectionName, target.display)
          : {
              resolved: { catalog: target.catalog, db: target.db, name: target.name, column: target.column },
              candidates: [],
              dialect: '',
            };
```

After `const detail = await catalog.getTable(...)`, replace the existing
`resolved.push(detail); appendTableMarkdown(...)` lines with:

```ts
      const requestedColumn = resolution.resolved.column;
      if (requestedColumn) {
        const column = findColumn(detail, requestedColumn);
        if (!column) {
          missing.push({
            target,
            candidates: [{ catalog: detail.catalog, db: detail.db, name: detail.name }],
          });
          parts.push(`Column not found in scan: ${detail.display}.${requestedColumn}`);
          parts.push(`Available columns: ${detail.columns.map((candidate) => candidate.name).join(', ')}`);
          continue;
        }
        const scopedDetail = { ...detail, columns: [column] };
        resolved.push(scopedDetail);
        appendTableMarkdown(parts, scopedDetail, column.name);
        continue;
      }

      resolved.push(detail);
      appendTableMarkdown(parts, detail);
```

- [ ] **Step 7: Run warehouse verification tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
git commit -m "fix(context): verify warehouse column display targets"
```

### Task 5: Verify the v1 gap closure

**Files:**
- Verify all files changed by Tasks 1-4.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/notion/notion.adapter.test.ts \
  src/ingest/local-adapters.test.ts \
  src/ingest/ingest-prompts.test.ts \
  src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run package tests**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 4: Run pre-commit on changed files when configured**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/adapters/notion/notion.adapter.ts \
  packages/context/src/ingest/adapters/notion/notion.adapter.test.ts \
  packages/context/src/ingest/local-adapters.ts \
  packages/context/src/ingest/local-adapters.test.ts \
  packages/context/src/ingest/adapters/notion/chunk.ts \
  packages/context/prompts/memory_agent_bundle_ingest_work_unit.md \
  packages/context/src/ingest/ingest-prompts.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
```

Expected: PASS. If the repo has no pre-commit config or the local `uv` version
cannot satisfy the project pin, record the exact error and rely on focused
tests plus type-check.

- [ ] **Step 5: Inspect final git status**

Run:

```bash
git status --short
```

Expected: only intentional files are modified. Commit any formatter-driven
changes with:

```bash
git add packages/context
git commit -m "chore(context): verify warehouse verification v1 gaps"
```

## Self-review checklist

- Spec coverage: this plan closes the remaining v1 paths for Notion warehouse
  verification, active WorkUnit prompt correctness, raw discovery scoping, and
  column-level identifier verification.
- Placeholder scan: no task relies on future-work markers, unnamed edge-case
  handling, or cross-task shorthand.
- Type consistency: `discover_data` continues to use `connectionName`,
  `sl_discover` still receives `connectionId` internally, and
  `resolveDisplayTarget()` returns the same table identity plus optional
  `column`.
