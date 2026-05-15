# Research Agent MCP Entity Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the MCP-shaped `entity_details` tool so external research agents can inspect raw table and column metadata from the latest scan snapshot.

**Architecture:** Build a focused scan service over persisted `raw-sources/<connectionId>/live-database/<syncId>` artifacts, using `scan-report.json` as the latest scan identity and `readLocalScanStructuralSnapshot()` as the schema reader. Register `entity_details` as an MCP context tool with pure structured output, then expose it through local project MCP ports.

**Tech Stack:** TypeScript, Vitest, Zod, KTX local file store, KTX scan artifacts, KTX MCP context ports.

---

## Current Audit

Original spec: `docs/superpowers/specs/2026-05-14-research-agent-mcp-tools-design.md`

Implemented v1 slice:

- `docs/superpowers/plans/2026-05-14-research-agent-mcp-sql-execution-foundation.md` is implemented. Evidence in current source:
  - Python sqlglot validation exists at `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`.
  - `POST /sql/validate-read-only` exists at `python/ktx-daemon/src/ktx_daemon/app.py`.
  - `SqlAnalysisPort.validateReadOnly()` exists at `packages/context/src/sql-analysis/ports.ts`.
  - MCP `sql_execution` registration exists at `packages/context/src/mcp/context-tools.ts`.
  - Local MCP SQL execution validates through `SqlAnalysisPort` before connector execution in `packages/context/src/mcp/local-project-ports.ts`.

V1-blocking gaps after that slice:

- `entity_details` is not registered on the MCP surface.
- `discover_data` is not registered on the MCP surface.
- `dictionary_search` is not registered on the MCP surface.
- `ktx mcp start|stop|status|logs` and the HTTP Streamable MCP daemon do not exist.
- `ktx setup-agents` does not install MCP client config or a `ktx-research` skill.
- Ingest-side warehouse verification still uses `connectionName` contracts in places; the MCP surface must use `connectionId`.

This plan covers only the next dependency-aware v1 blocker: MCP `entity_details`. Later plans still need to cover `dictionary_search`, `discover_data`, the HTTP daemon, and setup-agent/research-skill installation.

## File Structure

Create:

- `packages/context/src/scan/entity-details.ts`
  - Reads latest live-database scan artifacts for a connection.
  - Resolves driver display strings or structured table refs.
  - Returns structured table/column metadata and structured per-entity errors.
- `packages/context/src/scan/entity-details.test.ts`
  - Covers latest-scan selection, display-string resolution, structured refs, column filtering, ambiguity, missing scan, and missing columns.

Modify:

- `packages/context/src/scan/index.ts`
  - Export the new service and types.
- `packages/context/src/mcp/types.ts`
  - Add `KtxEntityDetailsMcpPort` and response types to `KtxMcpContextPorts`.
- `packages/context/src/mcp/context-tools.ts`
  - Add the `entity_details` input schema and registration.
- `packages/context/src/mcp/server.test.ts`
  - Assert the MCP tool registration and structured output.
- `packages/context/src/mcp/local-project-ports.ts`
  - Wire the local project port to the scan entity-details service.
- `packages/context/src/mcp/local-project-ports.test.ts`
  - Cover local-port `entity_details` success and missing-scan behavior.
- `packages/context/src/mcp/index.ts`
  - Export the new MCP port/response types.

## Task 1: Add The Scan Entity Details Service

**Files:**
- Create: `packages/context/src/scan/entity-details.test.ts`
- Create: `packages/context/src/scan/entity-details.ts`
- Modify: `packages/context/src/scan/index.ts`

- [ ] **Step 1: Write failing service tests**

Create `packages/context/src/scan/entity-details.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { createKtxEntityDetailsService } from './entity-details.js';
import type { KtxConnectionDriver, KtxScanReport, KtxSchemaTable } from './types.js';

describe('createKtxEntityDetailsService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-entity-details-service-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function scanReport(input: {
    connectionId: string;
    syncId: string;
    runId: string;
    driver?: KtxConnectionDriver;
    createdAt?: string;
  }): KtxScanReport {
    const rawSourcesDir = `raw-sources/${input.connectionId}/live-database/${input.syncId}`;
    return {
      connectionId: input.connectionId,
      driver: input.driver ?? 'postgres',
      syncId: input.syncId,
      runId: input.runId,
      trigger: 'mcp',
      mode: 'structural',
      dryRun: false,
      artifactPaths: {
        rawSourcesDir,
        reportPath: `${rawSourcesDir}/scan-report.json`,
        manifestShards: [],
        enrichmentArtifacts: [],
      },
      diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 1 },
      manifestShardsWritten: 0,
      structuralSyncStats: { tablesWritten: 1, tablesDeleted: 0, foreignKeysWritten: 0 },
      enrichment: {
        dataDictionary: 'skipped',
        tableDescriptions: 'skipped',
        columnDescriptions: 'skipped',
        embeddings: 'skipped',
        deterministicRelationships: 'skipped',
        llmRelationshipValidation: 'skipped',
        statisticalValidation: 'skipped',
      },
      capabilityGaps: [],
      warnings: [],
      relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
      enrichmentState: { resumedStages: [], completedStages: [], failedStages: [] },
      createdAt: input.createdAt ?? '2026-05-14T09:00:00.000Z',
    };
  }

  function ordersTable(input: { db?: string | null; estimatedRows?: number | null } = {}): KtxSchemaTable {
    return {
      catalog: null,
      db: input.db ?? 'public',
      name: 'orders',
      kind: 'table',
      comment: 'Customer orders',
      estimatedRows: input.estimatedRows ?? 12,
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'Order id',
        },
        {
          name: 'status',
          nativeType: 'text',
          normalizedType: 'text',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: 'Order status',
        },
      ],
      foreignKeys: [
        {
          fromColumn: 'customer_id',
          toCatalog: null,
          toDb: 'public',
          toTable: 'customers',
          toColumn: 'id',
          constraintName: 'orders_customer_id_fkey',
        },
      ],
    };
  }

  async function seedScan(input: {
    connectionId?: string;
    syncId: string;
    runId: string;
    driver?: KtxConnectionDriver;
    extractedAt?: string;
    tables?: KtxSchemaTable[];
  }): Promise<void> {
    const connectionId = input.connectionId ?? 'warehouse';
    const report = scanReport({
      connectionId,
      syncId: input.syncId,
      runId: input.runId,
      driver: input.driver,
      createdAt: input.extractedAt,
    });
    const root = report.artifactPaths.rawSourcesDir;
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify(
        {
          connectionId,
          driver: report.driver,
          extractedAt: input.extractedAt ?? report.createdAt,
          scope: { schemas: ['public'] },
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    for (const table of input.tables ?? [ordersTable()]) {
      await project.fileStore.writeFile(
        `${root}/tables/${table.db ?? 'default'}-${table.name}.json`,
        JSON.stringify(table, null, 2),
        'ktx',
        'ktx@example.com',
        `seed ${table.name}`,
      );
    }
    await project.fileStore.writeFile(
      `${root}/scan-report.json`,
      JSON.stringify(report, null, 2),
      'ktx',
      'ktx@example.com',
      'seed scan report',
    );
  }

  it('returns the latest scan snapshot table details for a display string', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-old', extractedAt: '2026-05-14T08:00:00.000Z' });
    await seedScan({
      syncId: 'sync-2',
      runId: 'scan-new',
      extractedAt: '2026-05-14T09:00:00.000Z',
      tables: [ordersTable({ estimatedRows: 99 })],
    });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders' }],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      ok: true,
      connectionId: 'warehouse',
      display: 'public.orders',
      estimatedRows: 99,
      snapshot: {
        syncId: 'sync-2',
        scanRunId: 'scan-new',
        extractedAt: '2026-05-14T09:00:00.000Z',
      },
      columns: [
        { name: 'id', nativeType: 'integer', primaryKey: true },
        { name: 'status', nativeType: 'text', nullable: false },
      ],
    });
  });

  it('filters requested columns while keeping full-table foreign keys', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-1' });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: { catalog: null, db: 'public', name: 'orders' }, columns: ['status'] }],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      columns: [{ name: 'status' }],
      foreignKeys: [
        {
          fromColumn: 'customer_id',
          toDb: 'public',
          toTable: 'customers',
          toColumn: 'id',
        },
      ],
    });
  });

  it('returns a structured missing-scan error', async () => {
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders' }],
    });

    expect(result.results).toEqual([
      {
        ok: false,
        connectionId: 'warehouse',
        table: 'public.orders',
        error: {
          code: 'scan_missing',
          message: 'No live-database scan found for connection "warehouse"; run `ktx ingest warehouse` or `ktx scan warehouse`.',
        },
      },
    ]);
  });

  it('reports ambiguous bare table names across schemas', async () => {
    await seedScan({
      syncId: 'sync-1',
      runId: 'scan-1',
      tables: [ordersTable({ db: 'public' }), ordersTable({ db: 'archive' })],
    });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'orders' }],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'ambiguous_table',
        candidates: [
          { tableRef: { catalog: null, db: 'archive', name: 'orders' }, display: 'archive.orders' },
          { tableRef: { catalog: null, db: 'public', name: 'orders' }, display: 'public.orders' },
        ],
      },
    });
  });

  it('reports missing requested columns with available column candidates', async () => {
    await seedScan({ syncId: 'sync-1', runId: 'scan-1' });
    const service = createKtxEntityDetailsService(project);

    const result = await service.read({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders', columns: ['status', 'plan_tier'] }],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'column_not_found',
        message: 'Column(s) not found on public.orders: plan_tier',
        candidates: ['id', 'status'],
      },
    });
  });
});
```

- [ ] **Step 2: Run failing service tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/scan/entity-details.test.ts
```

Expected: FAIL because `packages/context/src/scan/entity-details.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `packages/context/src/scan/entity-details.ts`:

```typescript
import type { KtxLocalProject } from '../project/index.js';
import { readLocalScanStructuralSnapshot } from './local-structural-artifacts.js';
import type {
  KtxConnectionDriver,
  KtxScanReport,
  KtxSchemaColumn,
  KtxSchemaSnapshot,
  KtxSchemaTable,
  KtxTableRef,
} from './types.js';

export type KtxEntityDetailsTableInput = string | KtxTableRef;

export interface KtxEntityDetailsInput {
  connectionId: string;
  entities: Array<{
    table: KtxEntityDetailsTableInput;
    columns?: string[];
  }>;
}

export interface KtxEntityDetailsSnapshotInfo {
  syncId: string;
  extractedAt: string;
  scanRunId: string | null;
}

export interface KtxEntityDetailsColumn {
  name: string;
  nativeType: string;
  normalizedType: string;
  dimensionType: KtxSchemaColumn['dimensionType'];
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
}

export interface KtxEntityDetailsRecord {
  ok: true;
  connectionId: string;
  tableRef: KtxTableRef;
  display: string;
  kind: KtxSchemaTable['kind'];
  comment: string | null;
  estimatedRows: number | null;
  columns: KtxEntityDetailsColumn[];
  foreignKeys: KtxSchemaTable['foreignKeys'];
  snapshot: KtxEntityDetailsSnapshotInfo;
}

export type KtxEntityDetailsErrorCode = 'scan_missing' | 'table_not_found' | 'ambiguous_table' | 'column_not_found';

export interface KtxEntityDetailsErrorResult {
  ok: false;
  connectionId: string;
  table: KtxEntityDetailsTableInput;
  snapshot?: KtxEntityDetailsSnapshotInfo;
  error: {
    code: KtxEntityDetailsErrorCode;
    message: string;
    candidates?: Array<{ tableRef: KtxTableRef; display: string }> | string[];
  };
}

export interface KtxEntityDetailsResponse {
  results: Array<KtxEntityDetailsRecord | KtxEntityDetailsErrorResult>;
}

interface LatestScan {
  report: KtxScanReport;
  snapshot: KtxSchemaSnapshot;
}

interface ResolveResult {
  table: KtxSchemaTable | null;
  error?: Omit<KtxEntityDetailsErrorResult['error'], 'message'> & { message: string };
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function refsEqual(left: KtxTableRef, right: KtxTableRef): boolean {
  return (
    normalize(left.catalog) === normalize(right.catalog) &&
    normalize(left.db) === normalize(right.db) &&
    normalize(left.name) === normalize(right.name)
  );
}

function cleanIdentifierPart(part: string): string {
  return part.trim().replace(/^["'`\[]|["'`\]]$/g, '');
}

function splitDisplay(display: string): string[] {
  return display
    .trim()
    .split('.')
    .map(cleanIdentifierPart)
    .filter(Boolean);
}

function displayForTable(driver: KtxConnectionDriver, table: KtxTableRef): string {
  if (driver === 'sqlite') {
    return table.name;
  }
  return [table.catalog, table.db, table.name].filter((part): part is string => Boolean(part)).join('.');
}

function tableRef(table: KtxSchemaTable): KtxTableRef {
  return { catalog: table.catalog, db: table.db, name: table.name };
}

function candidateList(driver: KtxConnectionDriver, tables: KtxSchemaTable[]): Array<{ tableRef: KtxTableRef; display: string }> {
  return tables
    .map((table) => ({
      tableRef: tableRef(table),
      display: displayForTable(driver, table),
    }))
    .sort((left, right) => left.display.localeCompare(right.display));
}

function parseDisplayRef(driver: KtxConnectionDriver, display: string): KtxTableRef | null {
  const parts = splitDisplay(display);
  if (driver === 'sqlite') {
    return parts.length === 1 ? { catalog: null, db: null, name: parts[0]! } : null;
  }
  if (driver === 'bigquery' || driver === 'snowflake' || driver === 'sqlserver') {
    return parts.length === 3 ? { catalog: parts[0]!, db: parts[1]!, name: parts[2]! } : null;
  }
  if (parts.length === 2) {
    return { catalog: null, db: parts[0]!, name: parts[1]! };
  }
  if (parts.length === 3) {
    return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  }
  return null;
}

function resolveTable(snapshot: KtxSchemaSnapshot, input: KtxEntityDetailsTableInput): ResolveResult {
  if (typeof input !== 'string') {
    const table = snapshot.tables.find((candidate) => refsEqual(candidate, input)) ?? null;
    return table
      ? { table }
      : {
          table: null,
          error: {
            code: 'table_not_found',
            message: `Table not found in latest scan: ${displayForTable(snapshot.driver, input)}`,
            candidates: candidateList(snapshot.driver, snapshot.tables),
          },
        };
  }

  const parsed = parseDisplayRef(snapshot.driver, input);
  if (parsed) {
    const table = snapshot.tables.find((candidate) => refsEqual(candidate, parsed)) ?? null;
    return table
      ? { table }
      : {
          table: null,
          error: {
            code: 'table_not_found',
            message: `Table not found in latest scan: ${input}`,
            candidates: candidateList(snapshot.driver, snapshot.tables),
          },
        };
  }

  const byName = snapshot.tables.filter((candidate) => normalize(candidate.name) === normalize(input));
  if (byName.length === 1) {
    return { table: byName[0]! };
  }
  if (byName.length > 1) {
    return {
      table: null,
      error: {
        code: 'ambiguous_table',
        message: `Table name "${input}" is ambiguous across schemas/catalogs; pass a structured table ref.`,
        candidates: candidateList(snapshot.driver, byName),
      },
    };
  }
  return {
    table: null,
    error: {
      code: 'table_not_found',
      message: `Table not found in latest scan: ${input}`,
      candidates: candidateList(snapshot.driver, snapshot.tables),
    },
  };
}

function toColumn(column: KtxSchemaColumn): KtxEntityDetailsColumn {
  return {
    name: column.name,
    nativeType: column.nativeType,
    normalizedType: column.normalizedType,
    dimensionType: column.dimensionType,
    nullable: column.nullable,
    primaryKey: column.primaryKey,
    comment: column.comment,
  };
}

function snapshotInfo(report: KtxScanReport, snapshot: KtxSchemaSnapshot): KtxEntityDetailsSnapshotInfo {
  return {
    syncId: report.syncId,
    extractedAt: snapshot.extractedAt,
    scanRunId: report.runId ?? null,
  };
}

async function readJson<T>(project: KtxLocalProject, path: string): Promise<T> {
  return JSON.parse((await project.fileStore.readFile(path)).content) as T;
}

async function latestScan(project: KtxLocalProject, connectionId: string): Promise<LatestScan | null> {
  const root = `raw-sources/${connectionId}/live-database`;
  let listed;
  try {
    listed = await project.fileStore.listFiles(root);
  } catch {
    return null;
  }
  const reportPath = listed.files.filter((path) => path.endsWith('/scan-report.json')).sort().at(-1);
  if (!reportPath) {
    return null;
  }
  const report = await readJson<KtxScanReport>(project, reportPath);
  const rawSourcesDir = report.artifactPaths.rawSourcesDir ?? reportPath.slice(0, -'/scan-report.json'.length);
  const snapshot = await readLocalScanStructuralSnapshot({
    project,
    connectionId,
    driver: report.driver,
    rawSourcesDir,
    extractedAtFallback: report.createdAt,
  });
  return { report, snapshot };
}

export function createKtxEntityDetailsService(project: KtxLocalProject) {
  return {
    async read(input: KtxEntityDetailsInput): Promise<KtxEntityDetailsResponse> {
      const scan = await latestScan(project, input.connectionId);
      if (!scan) {
        return {
          results: input.entities.map((entity) => ({
            ok: false,
            connectionId: input.connectionId,
            table: entity.table,
            error: {
              code: 'scan_missing',
              message: `No live-database scan found for connection "${input.connectionId}"; run \`ktx ingest ${input.connectionId}\` or \`ktx scan ${input.connectionId}\`.`,
            },
          })),
        };
      }

      const info = snapshotInfo(scan.report, scan.snapshot);
      const results: KtxEntityDetailsResponse['results'] = [];
      for (const entity of input.entities) {
        const resolved = resolveTable(scan.snapshot, entity.table);
        if (!resolved.table) {
          results.push({
            ok: false,
            connectionId: input.connectionId,
            table: entity.table,
            snapshot: info,
            error: resolved.error!,
          });
          continue;
        }

        const requested = new Set((entity.columns ?? []).map((column) => normalize(column)));
        const columns = requested.size
          ? resolved.table.columns.filter((column) => requested.has(normalize(column.name)))
          : resolved.table.columns;
        if (requested.size && columns.length !== requested.size) {
          const found = new Set(columns.map((column) => normalize(column.name)));
          const missing = [...requested].filter((column) => !found.has(column));
          results.push({
            ok: false,
            connectionId: input.connectionId,
            table: entity.table,
            snapshot: info,
            error: {
              code: 'column_not_found',
              message: `Column(s) not found on ${displayForTable(scan.snapshot.driver, resolved.table)}: ${missing.join(', ')}`,
              candidates: resolved.table.columns.map((column) => column.name),
            },
          });
          continue;
        }

        results.push({
          ok: true,
          connectionId: input.connectionId,
          tableRef: tableRef(resolved.table),
          display: displayForTable(scan.snapshot.driver, resolved.table),
          kind: resolved.table.kind,
          comment: resolved.table.comment,
          estimatedRows: resolved.table.estimatedRows,
          columns: columns.map(toColumn),
          foreignKeys: resolved.table.foreignKeys,
          snapshot: info,
        });
      }
      return { results };
    },
  };
}
```

In `packages/context/src/scan/index.ts`, add these exports near the other scan-service exports:

```typescript
export type {
  KtxEntityDetailsColumn,
  KtxEntityDetailsErrorCode,
  KtxEntityDetailsErrorResult,
  KtxEntityDetailsInput,
  KtxEntityDetailsRecord,
  KtxEntityDetailsResponse,
  KtxEntityDetailsSnapshotInfo,
  KtxEntityDetailsTableInput,
} from './entity-details.js';
export { createKtxEntityDetailsService } from './entity-details.js';
```

- [ ] **Step 4: Run service tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/scan/entity-details.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the scan service**

Run:

```bash
git add packages/context/src/scan/entity-details.ts packages/context/src/scan/entity-details.test.ts packages/context/src/scan/index.ts
git commit -m "feat(context): add scan-backed entity details service"
```

## Task 2: Register The MCP `entity_details` Tool

**Files:**
- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/context-tools.ts`
- Modify: `packages/context/src/mcp/server.test.ts`
- Modify: `packages/context/src/mcp/index.ts`

- [ ] **Step 1: Add MCP port types**

In `packages/context/src/mcp/types.ts`, add this import near the other type imports:

```typescript
import type { KtxEntityDetailsInput, KtxEntityDetailsResponse } from '../scan/entity-details.js';
```

Add this interface immediately before `KtxSqlExecutionResponse`:

```typescript
export interface KtxEntityDetailsMcpPort {
  read(input: KtxEntityDetailsInput): Promise<KtxEntityDetailsResponse>;
}
```

Add this optional port to `KtxMcpContextPorts`:

```typescript
  entityDetails?: KtxEntityDetailsMcpPort;
```

- [ ] **Step 2: Write failing MCP registration test**

In `packages/context/src/mcp/server.test.ts`, update the `./types.js` import to include `KtxEntityDetailsMcpPort`.

Add this test after the `sql_execution` registration test:

```typescript
  it('registers entity_details when the host provides an entity-details port', async () => {
    const fake = makeFakeServer();
    const entityDetails: KtxEntityDetailsMcpPort = {
      read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({
        results: [
          {
            ok: true,
            connectionId: 'warehouse',
            tableRef: { catalog: null, db: 'public', name: 'orders' },
            display: 'public.orders',
            kind: 'table',
            comment: 'Customer orders',
            estimatedRows: 12,
            columns: [
              {
                name: 'id',
                nativeType: 'integer',
                normalizedType: 'integer',
                dimensionType: 'number',
                nullable: false,
                primaryKey: true,
                comment: null,
              },
            ],
            foreignKeys: [],
            snapshot: {
              syncId: 'sync-1',
              extractedAt: '2026-05-14T09:00:00.000Z',
              scanRunId: 'scan-1',
            },
          },
        ],
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { entityDetails },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['entity_details']);
    await expect(
      getTool(fake.tools, 'entity_details').handler({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders', columns: ['id'] }],
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        results: [
          {
            ok: true,
            connectionId: 'warehouse',
            display: 'public.orders',
            columns: [{ name: 'id' }],
          },
        ],
      },
    });
    expect(entityDetails.read).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders', columns: ['id'] }],
    });
  });
```

- [ ] **Step 3: Run failing MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t entity_details
```

Expected: FAIL because `entity_details` is not registered.

- [ ] **Step 4: Add schema and registration**

In `packages/context/src/mcp/context-tools.ts`, add this schema after `scanArtifactReadSchema` and before `sqlExecutionSchema`:

```typescript
const entityDetailsTableRefSchema = z.object({
  catalog: z.string().nullable(),
  db: z.string().nullable(),
  name: z.string().min(1),
});

const entityDetailsSchema = z.object({
  connectionId: connectionIdSchema,
  entities: z
    .array(
      z.object({
        table: z.union([z.string().min(1), entityDetailsTableRefSchema]),
        columns: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1)
    .max(20),
});
```

Add this registration block in `registerKtxContextTools`, after the semantic-layer block and before the `sqlExecution` block:

```typescript
  if (ports.entityDetails) {
    const entityDetails = ports.entityDetails;
    registerParsedTool(
      server,
      'entity_details',
      {
        title: 'Entity Details',
        description:
          'Read raw table and column metadata from the latest KTX live-database scan snapshot.',
        inputSchema: entityDetailsSchema.shape,
      },
      entityDetailsSchema,
      async (input) => jsonToolResult(await entityDetails.read(input)),
    );
  }
```

In `packages/context/src/mcp/index.ts`, add `KtxEntityDetailsMcpPort` to the exported type list.

- [ ] **Step 5: Run MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t entity_details
```

Expected: PASS.

- [ ] **Step 6: Commit MCP registration**

Run:

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/index.ts
git commit -m "feat(context): register MCP entity details tool"
```

## Task 3: Wire Local Project MCP Ports

**Files:**
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write failing local-port tests**

In `packages/context/src/mcp/local-project-ports.test.ts`, add this helper after `testConnector`:

```typescript
  async function seedScanReport(projectDir: string, syncId = 'sync-1'): Promise<void> {
    const root = `raw-sources/warehouse/live-database/${syncId}`;
    await mkdir(join(projectDir, root, 'tables'), { recursive: true });
    await writeFile(
      join(projectDir, root, 'connection.json'),
      JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          extractedAt: '2026-05-14T09:00:00.000Z',
          scope: { schemas: ['public'] },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(projectDir, root, 'tables', 'orders.json'),
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: 'Customer orders',
          estimatedRows: 12,
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(projectDir, root, 'scan-report.json'),
      JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          syncId,
          runId: 'scan-1',
          trigger: 'mcp',
          mode: 'structural',
          dryRun: false,
          artifactPaths: {
            rawSourcesDir: root,
            reportPath: `${root}/scan-report.json`,
            manifestShards: [],
            enrichmentArtifacts: [],
          },
          diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 1 },
          manifestShardsWritten: 0,
          structuralSyncStats: { tablesWritten: 1, tablesDeleted: 0, foreignKeysWritten: 0 },
          enrichment: {
            dataDictionary: 'skipped',
            tableDescriptions: 'skipped',
            columnDescriptions: 'skipped',
            embeddings: 'skipped',
            deterministicRelationships: 'skipped',
            llmRelationshipValidation: 'skipped',
            statisticalValidation: 'skipped',
          },
          capabilityGaps: [],
          warnings: [],
          relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
          enrichmentState: { resumedStages: [], completedStages: [], failedStages: [] },
          createdAt: '2026-05-14T09:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
```

Add these tests after the MCP SQL tests:

```typescript
  it('exposes local scan entity details through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await seedScanReport(project.projectDir);
    const ports = createLocalProjectMcpContextPorts(project);

    await expect(
      ports.entityDetails?.read({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders', columns: ['id'] }],
      }),
    ).resolves.toMatchObject({
      results: [
        {
          ok: true,
          connectionId: 'warehouse',
          display: 'public.orders',
          columns: [{ name: 'id', nativeType: 'integer' }],
          snapshot: { syncId: 'sync-1', scanRunId: 'scan-1' },
        },
      ],
    });
  });

  it('returns a structured local entity-details error when no scan exists', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const ports = createLocalProjectMcpContextPorts(project);

    await expect(
      ports.entityDetails?.read({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders' }],
      }),
    ).resolves.toMatchObject({
      results: [
        {
          ok: false,
          connectionId: 'warehouse',
          error: { code: 'scan_missing' },
        },
      ],
    });
  });
```

- [ ] **Step 2: Run failing local-port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "entity details"
```

Expected: FAIL because `ports.entityDetails` is undefined.

- [ ] **Step 3: Wire the service into local ports**

In `packages/context/src/mcp/local-project-ports.ts`, update the scan import block to include `createKtxEntityDetailsService`:

```typescript
  createKtxEntityDetailsService,
```

In the initial `ports` object returned by `createLocalProjectMcpContextPorts`, add this sibling after `semanticLayer` and before the closing `};`:

```typescript
    entityDetails: {
      async read(input) {
        return createKtxEntityDetailsService(project).read(input);
      },
    },
```

- [ ] **Step 4: Run local-port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "entity details"
```

Expected: PASS.

- [ ] **Step 5: Commit local-port wiring**

Run:

```bash
git add packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat(context): expose local MCP entity details"
```

## Task 4: Verification

**Files:**
- Verify: all files changed in Tasks 1-3

- [ ] **Step 1: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/scan/entity-details.test.ts src/mcp/server.test.ts src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run dead-code check for new exports**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports unrelated pre-existing findings, record the exact unrelated findings and do not broaden this entity-details slice.

- [ ] **Step 4: Confirm remaining v1 blockers still need later plans**

Run:

```bash
test -e packages/context/src/sl/dictionary-search.ts; printf 'dictionary-search:%s\n' "$?"
test -e packages/context/src/search/discover.ts; printf 'discover:%s\n' "$?"
test -e packages/cli/src/commands/mcp-commands.ts; printf 'mcp-commands:%s\n' "$?"
test -e packages/cli/src/skills/research/SKILL.md; printf 'research-skill:%s\n' "$?"
```

Expected:

```text
dictionary-search:1
discover:1
mcp-commands:1
research-skill:1
```

These markers mean this plan landed `entity_details` only and did not claim the remaining research-agent v1 work.

- [ ] **Step 5: Commit verification-only doc changes if any**

Run:

```bash
git status --short
```

Expected: no uncommitted source changes after the task commits. If verification updates this plan document, commit only the plan document with:

```bash
git add docs/superpowers/plans/2026-05-14-research-agent-mcp-entity-details.md
git commit -m "docs: record research MCP entity details plan"
```

## Self-Review

- Spec coverage for this slice: covers MCP `entity_details`, latest scan freshness by reading `scan-report.json` on each call, structured table refs, driver display strings, column filtering, FK preservation, snapshot freshness, and structured errors.
- Remaining spec coverage after this slice: `dictionary_search`, `discover_data`, `ktx mcp` HTTP daemon, setup-agent MCP config, and `ktx-research` skill are still v1-blocking and need later plans.
- Type consistency: `KtxEntityDetailsInput` is reused by the scan service, MCP port, schema parser, and local project port.
