# Research Agent MCP Ingest Contract Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the v1 research-agent MCP spec by converging the existing ingest warehouse-verification tools on `connectionId` terminology and a shared raw-schema catalog service.

**Architecture:** Move the existing warehouse catalog reader out of the ingest-only tool folder into `packages/context/src/scan/warehouse-catalog.ts`, rename its public contract from `connectionName` to `connectionId`, and make the ingest adapters consume that shared service. Keep the ingest tools' ingest-specific output shape (`markdown` plus `structured`) and their existing `targets` / `rowLimit` controls; the v1 blocker is the divergent connection parameter and stale prompt guidance, not changing ingest output into the MCP pure-structured shape.

**Tech Stack:** TypeScript, Zod, Vitest, existing KTX local file-store scan artifacts, existing ingest BaseTool framework.

---

## Audit Summary

Implemented and no longer v1-blocking:

- MCP `sql_execution`, `entity_details`, `dictionary_search`, and `discover_data` are registered in `packages/context/src/mcp/context-tools.ts` and wired through local project ports.
- `sql_execution` is parser-gated through the Python sqlglot validator before reaching local scan connectors.
- The HTTP-only `ktx mcp` daemon exists with Streamable HTTP `POST`, `GET`, and `DELETE` handling, session tracking, host/origin checks, token checks for `/mcp`, lifecycle state, and CLI commands.
- `ktx setup-agents` installs the `ktx-research` skill, writes Claude/Cursor JSON MCP config entries, and prints Codex/opencode snippets.

Remaining v1 blocker:

- The ingest warehouse-verification tools still expose and teach `connectionName` while the spec requires `connectionId` across `warehouse-verification/*.tool.ts`, `WarehouseCatalogService`, callers, tests, and prompt assets.

Non-blocking follow-ups not covered here:

- `ktx mcp status` does not print `startedAt` as a separate line, although the state file records it.
- `ktx setup-agents` writes safe `${KTX_MCP_TOKEN}` references for shared project configs, but it does not offer the spec's optional skip prompt when token auth is active.
- `discover_data` sample-value snippets use ASCII `" - samples: "` instead of the spec prose's middle-dot separator.

## File Structure

- Move: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts` to `packages/context/src/scan/warehouse-catalog.ts`
  - Shared live-database scan catalog reader, display resolver, raw schema search, and table detail source of truth.
- Modify: `packages/context/src/scan/index.ts`
  - Export the shared warehouse catalog service and public types.
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`
  - Accept `connectionId`, call shared catalog service, and emit connectionId-shaped markdown and structured output.
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`
  - Accept optional `connectionId`, search raw schema via shared catalog service, and teach follow-up calls with `connectionId`.
- Modify: `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts`
  - Accept `connectionId`, keep `rowLimit`, and pass `connectionId` to `SlConnectionCatalogPort.executeQuery`.
- Modify tests:
  - `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`
  - `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`
  - `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts`
  - `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`
  - Rename the service test file to `packages/context/src/scan/warehouse-catalog.test.ts`.
- Modify prompt assets:
  - `packages/context/skills/_shared/identifier-verification.md`
  - `packages/context/skills/dbt_ingest/SKILL.md`
  - `packages/context/skills/historic_sql_patterns/SKILL.md`
  - `packages/context/skills/historic_sql_table_digest/SKILL.md`
  - `packages/context/skills/live_database_ingest/SKILL.md`
  - `packages/context/skills/looker_ingest/SKILL.md`
  - `packages/context/skills/lookml_ingest/SKILL.md`
  - `packages/context/skills/metabase_ingest/SKILL.md`
  - `packages/context/skills/metricflow_ingest/SKILL.md`
  - `packages/context/skills/notion_synthesize/SKILL.md`
  - `packages/context/skills/sl_capture/SKILL.md`
  - `packages/context/skills/wiki_capture/SKILL.md`
  - Preserve Looker/LookML prose where `connectionName` refers to a Looker runtime field, not a KTX tool parameter.

## Task 1: Add Failing Contract Tests

**Files:**
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`
- Modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Add entity_details input-contract coverage**

Add this test inside the existing `describe('EntityDetailsTool', ...)` block:

```typescript
it('uses connectionId as the public input field', async () => {
  expect(
    tool.parseInput({
      connectionId: 'warehouse',
      targets: [{ display: 'public.orders' }],
    }),
  ).toEqual({
    connectionId: 'warehouse',
    targets: [{ display: 'public.orders' }],
  });

  expect(() =>
    tool.parseInput({
      connectionName: 'warehouse',
      targets: [{ display: 'public.orders' }],
    }),
  ).toThrow();
});
```

Update the existing `tool.call(...)` inputs in the same test file from `connectionName` to `connectionId`. For example:

```typescript
const result = await tool.call({ connectionId: 'warehouse', targets: [{ display: 'public.orders' }] }, context);
```

- [ ] **Step 2: Add sql_execution input-contract coverage**

Add this test inside `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts`:

```typescript
it('uses connectionId as the public input field', () => {
  expect(
    tool.parseInput({
      connectionId: 'warehouse',
      sql: 'select 1',
      rowLimit: 5,
    }),
  ).toEqual({
    connectionId: 'warehouse',
    sql: 'select 1',
    rowLimit: 5,
  });

  expect(() =>
    tool.parseInput({
      connectionName: 'warehouse',
      sql: 'select 1',
      rowLimit: 5,
    }),
  ).toThrow();
});
```

Update the existing `tool.call(...)` inputs in the same test file from `connectionName` to `connectionId`.

- [ ] **Step 3: Add discover_data input and hint coverage**

Update the existing discover tests so the first case calls:

```typescript
const result = await tool.call({ query: 'orders', connectionId: 'warehouse', limit: 5 }, context);
```

Change the routing-hint assertions to:

```typescript
expect(result.markdown).toContain('use `entity_details({connectionId, targets: [{display}]})`');
```

In the multi-connection test, use a `connectionId` hit field and assert the follow-up call is connectionId-shaped:

```typescript
catalog.searchByName.mockImplementation(async (connectionId: string, query: string) => [
  {
    kind: 'table',
    connectionId,
    ref: { catalog: null, db: 'public', name: `${connectionId}_${query}` },
    display: `public.${connectionId}_${query}`,
    matchedOn: 'name',
  },
]);

const result = await tool.call({ query: 'orders', limit: 10 }, multiConnectionContext);

expect(catalog.searchByName).toHaveBeenCalledWith('analytics', 'orders', 10);
expect(catalog.searchByName).toHaveBeenCalledWith('warehouse', 'orders', 10);
expect(result.markdown).toContain('connectionId=analytics');
expect(result.markdown).toContain('connectionId=warehouse');
expect(result.markdown).toContain(
  'entity_details({connectionId: "analytics", targets: [{display: "public.analytics_orders"}]})',
);
expect(result.structured.raw?.hits.map((hit) => hit.connectionId)).toEqual(['analytics', 'warehouse']);
```

Add a parse contract test:

```typescript
it('uses connectionId as the optional connection filter', () => {
  expect(tool.parseInput({ query: 'orders', connectionId: 'warehouse', limit: 5 })).toEqual({
    query: 'orders',
    connectionId: 'warehouse',
    limit: 5,
  });

  expect(() => tool.parseInput({ query: 'orders', connectionName: 'warehouse', limit: 5 })).toThrow();
});
```

- [ ] **Step 4: Add shared catalog output coverage**

Rename `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts` to `packages/context/src/scan/warehouse-catalog.test.ts`.

Update the import to:

```typescript
import { WarehouseCatalogService } from './warehouse-catalog.js';
```

Update the main detail assertion to use `connectionId`:

```typescript
const detail = await catalog.getTable({ connectionId: 'warehouse', catalog: null, db: 'public', name: 'orders' });

expect(detail).toMatchObject({
  connectionId: 'warehouse',
  display: 'public.orders',
});
expect(detail).not.toHaveProperty('connectionName');
```

Add raw hit coverage:

```typescript
const hits = await catalog.searchByName('warehouse', 'orders', 5);
expect(hits[0]).toMatchObject({
  kind: 'table',
  connectionId: 'warehouse',
  display: 'public.orders',
});
expect(hits[0]).not.toHaveProperty('connectionName');
```

- [ ] **Step 5: Update prompt-asset test expectations first**

In `packages/context/src/ingest/ingest-runtime-assets.test.ts`, change the identifier verification expectations to:

```typescript
expect(shared).toContain('sql_execution({connectionId, sql: "SELECT DISTINCT');
expect(shared).toContain('sql_execution({connectionId, sql: "SELECT 1 FROM');
expect(shared).not.toContain('entity_details({connectionName');
expect(shared).not.toContain('sql_execution({connectionName');
```

- [ ] **Step 6: Run focused tests and verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts \
  src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts \
  src/scan/warehouse-catalog.test.ts \
  src/ingest/ingest-runtime-assets.test.ts
```

Expected: FAIL because schemas still require `connectionName`, the catalog service still returns `connectionName`, and the prompt asset still contains old tool-call examples.

## Task 2: Move And Rename The Shared Warehouse Catalog Service

**Files:**
- Move: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts` to `packages/context/src/scan/warehouse-catalog.ts`
- Modify: `packages/context/src/scan/index.ts`
- Delete: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`

- [ ] **Step 1: Move the service into the scan package**

Run:

```bash
git mv packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts packages/context/src/scan/warehouse-catalog.ts
```

- [ ] **Step 2: Fix imports for the new location**

In `packages/context/src/scan/warehouse-catalog.ts`, change the imports at the top to:

```typescript
import { getDialectForDriver } from '../connections/index.js';
import type { KtxFileStorePort } from '../core/index.js';
import type {
  KtxConnectionDriver,
  KtxSchemaColumn,
  KtxSchemaForeignKey,
  KtxSchemaTable,
  KtxTableRef,
} from './types.js';
```

- [ ] **Step 3: Rename public catalog fields and method parameters**

In `packages/context/src/scan/warehouse-catalog.ts`, rename the service's public contract to this shape:

```typescript
export interface TableDetail {
  connectionId: string;
  catalog: string | null;
  db: string | null;
  name: string;
  display: string;
  kind: string;
  comment: string | null;
  description: string | null;
  rowCount: number | null;
  columns: WarehouseColumnDetail[];
  foreignKeys: KtxSchemaForeignKey[];
}

export type RawSchemaHit =
  | {
      kind: 'table';
      connectionId: string;
      ref: KtxTableRef;
      display: string;
      matchedOn: 'name' | 'db' | 'comment' | 'description';
    }
  | {
      kind: 'column';
      connectionId: string;
      ref: KtxTableRef & { column: string };
      display: string;
      matchedOn: 'name' | 'comment' | 'description';
    };

interface ConnectionCatalog {
  connectionId: string;
  syncId: string;
  driver: CatalogDriver;
  tables: KtxSchemaTable[];
  profile: RelationshipProfileArtifact | null;
}
```

Update the method signatures to:

```typescript
async hasScan(connectionId: string): Promise<boolean>
async getLatestSyncId(connectionId: string): Promise<string | null>
async listTables(connectionId: string): Promise<KtxTableRef[]>
async getTable(ref: { connectionId: string } & KtxTableRef): Promise<TableDetail | null>
async resolveDisplay(connectionId: string, display: string): Promise<{ resolved: KtxTableRef | null; candidates: KtxTableRef[]; dialect: string }>
async resolveDisplayTarget(connectionId: string, display: string): Promise<DisplayTargetResolution>
async searchByName(connectionId: string, query: string, limit: number): Promise<RawSchemaHit[]>
private loadCatalog(connectionId: string): Promise<ConnectionCatalog | null>
private async readCatalog(connectionId: string): Promise<ConnectionCatalog | null>
```

Within those methods, use `connectionId` for the cache key, raw artifact root, returned `TableDetail.connectionId`, and returned `RawSchemaHit.connectionId`.

- [ ] **Step 4: Export the shared service**

Add these exports to `packages/context/src/scan/index.ts` near the existing entity-details exports:

```typescript
export type {
  DisplayTargetResolution,
  RawSchemaHit,
  TableDetail,
  WarehouseCatalogServiceDeps,
} from './warehouse-catalog.js';
export { WarehouseCatalogService } from './warehouse-catalog.js';
```

- [ ] **Step 5: Run the catalog test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/scan/warehouse-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the shared catalog move**

Run:

```bash
git add packages/context/src/scan/warehouse-catalog.ts packages/context/src/scan/warehouse-catalog.test.ts packages/context/src/scan/index.ts packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts
git commit -m "refactor(context): share warehouse catalog service"
```

## Task 3: Rename Ingest Warehouse-Verification Tool Inputs

**Files:**
- Modify: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/index.ts`

- [ ] **Step 1: Update imports from the shared scan service**

In `entity-details.tool.ts`, use:

```typescript
import { WarehouseCatalogService, type TableDetail } from '../../../scan/warehouse-catalog.js';
```

In `discover-data.tool.ts`, use:

```typescript
import { WarehouseCatalogService, type RawSchemaHit } from '../../../scan/warehouse-catalog.js';
```

In `index.ts`, use:

```typescript
import { WarehouseCatalogService } from '../../../scan/warehouse-catalog.js';
```

- [ ] **Step 2: Rename entity_details input and calls**

In `entity-details.tool.ts`, update the schema:

```typescript
const entityDetailsInputSchema = z.object({
  connectionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  targets: z.array(targetSchema).min(1).max(50),
});
```

Update `resolveTarget`:

```typescript
async function resolveTarget(
  catalog: WarehouseCatalogService,
  connectionId: string,
  target: EntityDetailsTarget,
): Promise<{ resolved: (KtxTableRef & { column?: string }) | null; candidates: KtxTableRef[] }> {
  if ('display' in target) {
    return catalog.resolveDisplayTarget(connectionId, target.display);
  }

  const candidateResolution = await catalog.resolveDisplayTarget(connectionId, targetLabel(target));
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

Update the start of `call`:

```typescript
async call(input: EntityDetailsInput, context: ToolContext): Promise<ToolOutput<EntityDetailsStructured>> {
  const allowed = allowedConnectionNames(context);
  if (allowed && !allowed.has(input.connectionId)) {
    return {
      markdown: `Connection "${input.connectionId}" is not available to this ingest stage.`,
      structured: { resolved: [], missing: [], scanAvailable: false },
    };
  }

  const catalog = this.catalogFactory(context);
  const scanAvailable = await catalog.hasScan(input.connectionId);
  if (!scanAvailable) {
    return {
      markdown: `No live-database scan available for connection "${input.connectionId}"; run \`ktx scan\` first.`,
      structured: { resolved: [], missing: [], scanAvailable: false },
    };
  }
```

Update the table lookup:

```typescript
const resolution = await resolveTarget(catalog, input.connectionId, target);
const detail = await catalog.getTable({ connectionId: input.connectionId, ...resolution.resolved });
```

- [ ] **Step 3: Rename sql_execution input and calls**

In `sql-execution.tool.ts`, update the schema:

```typescript
const sqlExecutionInputSchema = z.object({
  connectionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  sql: z.string().min(1),
  rowLimit: z.number().int().positive().max(1000).optional().default(100),
});
```

Update the allowed-connection guard:

```typescript
const allowed = context.session?.allowedConnectionNames;
if (allowed && !allowed.has(input.connectionId)) {
  return {
    markdown: `Connection "${input.connectionId}" is not available to this ingest stage.`,
    structured: {
      headers: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      sql: input.sql,
      wrappedSql: '',
      error: 'connection_not_allowed',
    },
  };
}
```

Update execution:

```typescript
const result = await this.connections.executeQuery(input.connectionId, wrappedSql);
```

- [ ] **Step 4: Rename discover_data input, raw hits, and routing hints**

In `discover-data.tool.ts`, update the schema:

```typescript
const discoverDataInputSchema = z.object({
  query: z.string().optional(),
  connectionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  limit: z.number().int().positive().max(50).optional().default(10),
  sourceName: z.string().optional(),
});
```

Update the out-of-scope check:

```typescript
if (input.connectionId && allowed && !allowed.has(input.connectionId)) {
  return {
    markdown: `Connection "${input.connectionId}" is not available to this ingest stage.`,
    structured: { wiki: null, sl: null, raw: null },
  };
}
```

Update the source inspect mode:

```typescript
const sl = await this.deps.slDiscoverTool.call(
  { sourceName: input.sourceName, connectionId: input.connectionId },
  context,
);
```

Update the SL discover call:

```typescript
const slResult = await this.deps.slDiscoverTool.call(
  { query: query || undefined, connectionId: input.connectionId },
  context,
);
```

Update the raw search loop and hints:

```typescript
const connections = input.connectionId ? [input.connectionId] : [...(allowed ?? [])].sort();
const rawHits: RawSchemaHit[] = [];
for (const connectionId of connections) {
  rawHits.push(...(await catalog.searchByName(connectionId, query, limit)));
}
if (rawHits.length > 0) {
  parts.push(
    '## Raw Warehouse Schema',
    '> use `entity_details({connectionId, targets: [{display}]})` for full DDL + sample values',
  );
  parts.push(
    rawHits
      .slice(0, limit)
      .map(
        (hit) =>
          `- ${hit.kind}: ${hit.display} [connectionId=${hit.connectionId}] (matched on ${hit.matchedOn}) - ` +
          `follow up with \`entity_details({connectionId: "${hit.connectionId}", targets: [{display: "${hit.display}"}]})\``,
      )
      .join('\n'),
  );
  raw = { hits: rawHits.slice(0, limit) };
}
```

- [ ] **Step 5: Run focused tool tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts \
  src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the ingest tool contract rename**

Run:

```bash
git add packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts packages/context/src/ingest/tools/warehouse-verification/index.ts packages/context/src/ingest/tools/warehouse-verification/*.test.ts
git commit -m "refactor(context): use connectionId in warehouse verification tools"
```

## Task 4: Update Prompt Assets And Runtime Tests

**Files:**
- Modify: `packages/context/skills/_shared/identifier-verification.md`
- Modify: `packages/context/skills/dbt_ingest/SKILL.md`
- Modify: `packages/context/skills/historic_sql_patterns/SKILL.md`
- Modify: `packages/context/skills/historic_sql_table_digest/SKILL.md`
- Modify: `packages/context/skills/live_database_ingest/SKILL.md`
- Modify: `packages/context/skills/looker_ingest/SKILL.md`
- Modify: `packages/context/skills/lookml_ingest/SKILL.md`
- Modify: `packages/context/skills/metabase_ingest/SKILL.md`
- Modify: `packages/context/skills/metricflow_ingest/SKILL.md`
- Modify: `packages/context/skills/notion_synthesize/SKILL.md`
- Modify: `packages/context/skills/sl_capture/SKILL.md`
- Modify: `packages/context/skills/wiki_capture/SKILL.md`
- Modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Update the shared identifier verification protocol**

Replace the tool-call examples in `packages/context/skills/_shared/identifier-verification.md` with:

```markdown
2. `entity_details({connectionId, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues.
3. For literal values from the source, such as status codes or plan tiers,
   check whether they appear in `entity_details` sampleValues for the relevant
   column. If sampleValues is short or the sample may have missed real values,
   run a `sql_execution` probe with the same warehouse connection id:
   `sql_execution({connectionId, sql: "SELECT DISTINCT <col> FROM <ref> LIMIT 50"})`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution({connectionId, sql: "SELECT 1 FROM <ref> LIMIT 0"})`.
     If it errors, the identifier is fictional.
```

- [ ] **Step 2: Update copied skill assets**

In the listed `packages/context/skills/*/SKILL.md` files, replace only KTX tool-call examples:

```text
entity_details({connectionName, targets:
```

with:

```text
entity_details({connectionId, targets:
```

Replace:

```text
sql_execution({connectionName, sql:
```

with:

```text
sql_execution({connectionId, sql:
```

Replace concrete KTX tool-call examples like:

```text
sql_execution({connectionName: "warehouse", sql:
```

with:

```text
sql_execution({connectionId: "warehouse", sql:
```

In `packages/context/skills/sl_capture/SKILL.md`, replace the JSON field inside the example object:

```yaml
connectionName: "warehouse",
```

with:

```yaml
connectionId: "warehouse",
```

Do not change `packages/context/skills/looker_ingest/SKILL.md` text that defines Looker runtime `connectionName`, and do not change LookML parser docs where `connectionName` names a LookML model property.

- [ ] **Step 3: Update runtime asset tests**

In `packages/context/src/ingest/ingest-runtime-assets.test.ts`, ensure the identifier test asserts the new examples:

```typescript
expect(shared).toContain('sql_execution({connectionId, sql: "SELECT DISTINCT');
expect(shared).toContain('sql_execution({connectionId, sql: "SELECT 1 FROM');
expect(shared).not.toContain('entity_details({connectionName');
expect(shared).not.toContain('sql_execution({connectionName');
```

- [ ] **Step 4: Run prompt asset checks**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify stale tool-call examples are gone**

Run:

```bash
rg -n "entity_details\\(\\{connectionName|sql_execution\\(\\{connectionName|connectionName=" packages/context/skills packages/context/src/ingest/ingest-runtime-assets.test.ts
```

Expected: no output. If this reports Looker/LookML prose that is not a KTX tool-call example, narrow the regex and keep the Looker/LookML prose unchanged.

- [ ] **Step 6: Commit prompt asset updates**

Run:

```bash
git add packages/context/skills packages/context/src/ingest/ingest-runtime-assets.test.ts
git commit -m "docs(context): update ingest verification prompts for connectionId"
```

## Task 5: Final Verification

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run focused research-agent ingest tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/scan/warehouse-catalog.test.ts \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts \
  src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts \
  src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run dead-code checks after TypeScript changes**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports unrelated pre-existing findings, record the exact unrelated findings in the implementation handoff and do not add broad ignores.

- [ ] **Step 4: Verify the v1-blocking old contract is gone**

Run:

```bash
rg -n "connectionName" packages/context/src/ingest/tools/warehouse-verification packages/context/src/scan/warehouse-catalog.ts packages/context/src/scan/warehouse-catalog.test.ts
```

Expected: no output.

Run:

```bash
rg -n "entity_details\\(\\{connectionName|sql_execution\\(\\{connectionName|connectionName=" packages/context/skills packages/context/src/ingest/ingest-runtime-assets.test.ts
```

Expected: no output.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only the intended scan catalog move, warehouse-verification tools/tests, prompt assets, and ingest runtime asset test changes are present.

- [ ] **Step 6: Commit final fixes if verification required any**

If Steps 1-5 required follow-up edits, commit those edits:

```bash
git add packages/context/src packages/context/skills
git commit -m "test(context): verify warehouse verification connectionId contract"
```

If `git status --short` is empty after the earlier task commits, skip this commit.

## Self-Review

- Spec coverage: This plan covers the remaining v1 requirement that ingest-side warehouse verification uses `connectionId` and shares the raw-schema catalog service instead of preserving a divergent `connectionName` contract.
- Placeholder scan: The plan contains no deferred-work marker phrases.
- Type consistency: The plan uses `connectionId` consistently in public tool inputs, `TableDetail`, `RawSchemaHit`, `WarehouseCatalogService` method parameters, tests, and prompt assets.
