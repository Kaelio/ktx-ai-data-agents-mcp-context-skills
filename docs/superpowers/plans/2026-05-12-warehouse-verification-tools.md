# Warehouse Verification Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add synthesis-time warehouse verification tools so ingest agents can verify raw warehouse tables, columns, and sample values before writing wiki pages, SL sources, `tables:` frontmatter, `sl_refs`, or unmapped fallback records.

**Architecture:** Add a raw scan catalog service over `raw-sources/<connection>/live-database/<sync>/`, three BaseTool-backed ingest tools, and runner/tool-session scoping for allowed warehouse connections. Register the tools in the local ingest toolset so both WorkUnit and reconcile stages receive them through the existing `toAiSdkTools()` path.

**Tech Stack:** TypeScript, Node 22, Vitest, AI SDK v6 tools, Zod, KTX file store, KTX semantic layer and wiki tools.

---

## Audit summary

The current repo has the original spec file only; no matching plan or implementation exists under `docs/superpowers/plans`. The following v1-blocking gaps remain:

- `packages/context/src/connections/dialects.ts` does not exist.
- `packages/context/src/ingest/tools/warehouse-verification/` does not exist.
- `entity_details`, `sql_execution`, and `discover_data` are not available to ingest WU or reconcile toolsets.
- `ToolSession` does not carry the ingest stage's allowed warehouse connection IDs.
- Prompt updates are absent from the 11 writer skills named in the spec.
- Cleanup strings remain: `orbit_analytics.customer`, `wiki_sl_search`, and `sl_describe_table`.
- Prompt-bundling and warehouse-tool tests are absent.

Non-blocking gaps remain out of scope for this plan:

- Hard write-time validation in `wiki_write` and `emit_unmapped_fallback`.
- `dictionary_search`.
- `semantic_query` in synthesis toolsets.
- A raw-schema FTS index.
- A UUID identity layer for tables and columns.

One repo-specific adjustment is required: do not import `@ktx/connector-*`
dialect classes into `@ktx/context`, because every connector package already
depends on `@ktx/context`. Add a minimal context-local dialect dispatch instead.

## File structure

Create these files:

- `packages/context/src/connections/dialects.ts`: Context-local driver dispatch for identifier quoting and display formatting.
- `packages/context/src/connections/dialects.test.ts`: Driver dispatch and display-format tests.
- `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`: Reads the latest live-database scan, resolves display identifiers, and searches table and column metadata.
- `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`: Fixture-backed catalog tests.
- `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`: `entity_details` ingest tool.
- `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`: Tool contract tests.
- `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts`: `sql_execution` ingest tool.
- `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts`: Read-only SQL and output tests.
- `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`: `discover_data` ingest tool composing wiki, SL, and raw-schema search.
- `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`: Discovery composition tests.
- `packages/context/src/ingest/tools/warehouse-verification/index.ts`: Exports tool classes and `createWarehouseVerificationTools()`.
- `packages/context/skills/_shared/identifier-verification.md`: Shared protocol text kept in the tree for review even though writer skills inline it.

Modify these files:

- `packages/context/src/connections/index.ts`: Export the dialect helper.
- `packages/context/src/tools/tool-session.ts`: Add `allowedConnectionNames`.
- `packages/context/src/ingest/ingest-bundle.runner.ts`: Populate `allowedConnectionNames` for WU and reconcile sessions.
- `packages/context/src/ingest/local-bundle-runtime.ts`: Register the warehouse verification tools in `LocalIngestToolsetFactory`.
- `packages/context/src/ingest/ingest-bundle.runner.test.ts`: Assert the runner scopes allowed warehouse connections.
- `packages/context/src/memory/memory-runtime-assets.test.ts`: Assert writer skills contain the protocol and banned strings are gone.
- `packages/context/src/ingest/ingest-runtime-assets.test.ts`: Assert ingest skill packaging includes the protocol.
- `packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts`: Replace the fictional table example.
- `packages/context/src/sl/tools/sl-warehouse-validation.ts`: Replace the stale `sl_describe_table` hint.
- `packages/context/skills/*/SKILL.md`: Inline protocol updates for the writer skills listed in the spec.

### Task 1: Add context-local dialect dispatch

**Files:**
- Create: `packages/context/src/connections/dialects.ts`
- Create: `packages/context/src/connections/dialects.test.ts`
- Modify: `packages/context/src/connections/index.ts`

- [ ] **Step 1: Write the failing dialect tests**

Create `packages/context/src/connections/dialects.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getDialectForDriver } from './dialects.js';

describe('getDialectForDriver', () => {
  it.each([
    ['postgres', '"public"."orders"'],
    ['postgresql', '"public"."orders"'],
    ['mysql', '`public`.`orders`'],
    ['clickhouse', '`public`.`orders`'],
    ['sqlite', '"orders"'],
    ['snowflake', '"analytics"."public"."orders"'],
    ['bigquery', '`analytics`.`public`.`orders`'],
    ['sqlserver', '[analytics].[public].[orders]'],
  ] as const)('formats table names for %s', (driver, expected) => {
    const dialect = getDialectForDriver(driver);
    expect(
      dialect.formatTableName({
        catalog: driver === 'snowflake' || driver === 'bigquery' || driver === 'sqlserver' ? 'analytics' : null,
        db: driver === 'sqlite' ? null : 'public',
        name: 'orders',
      }),
    ).toBe(expected);
  });

  it('throws with a supported-driver list for unknown drivers', () => {
    expect(() => getDialectForDriver('oracle')).toThrow(
      'Unsupported warehouse driver "oracle". Supported drivers: bigquery, clickhouse, mysql, postgres, postgresql, sqlite, sqlite3, snowflake, sqlserver',
    );
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/connections/dialects.test.ts
```

Expected: FAIL because `./dialects.js` does not exist.

- [ ] **Step 3: Add the minimal dialect implementation**

Create `packages/context/src/connections/dialects.ts`:

```ts
import type { KtxSchemaDimensionType, KtxTableRef } from '../scan/types.js';

export type SupportedDriver =
  | 'postgres'
  | 'postgresql'
  | 'mysql'
  | 'sqlserver'
  | 'snowflake'
  | 'bigquery'
  | 'clickhouse'
  | 'sqlite'
  | 'sqlite3';

export interface KtxDialect {
  readonly type: SupportedDriver;
  quoteIdentifier(identifier: string): string;
  formatTableName(table: KtxTableRef): string;
  mapToDimensionType(nativeType: string): KtxSchemaDimensionType;
}

const supportedDrivers: SupportedDriver[] = [
  'bigquery',
  'clickhouse',
  'mysql',
  'postgres',
  'postgresql',
  'sqlite',
  'sqlite3',
  'snowflake',
  'sqlserver',
];

function doubleQuoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function backtickQuoted(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function bigQueryQuoted(identifier: string): string {
  return `\`${identifier.replace(/`/g, '\\`')}\``;
}

function bracketQuoted(identifier: string): string {
  return `[${identifier.replace(/\]/g, ']]')}]`;
}

function inferDimensionType(nativeType: string): KtxSchemaDimensionType {
  const normalized = nativeType.toLowerCase().trim();
  if (normalized.includes('date') || normalized.includes('time')) {
    return 'time';
  }
  if (
    normalized.includes('int') ||
    normalized.includes('num') ||
    normalized.includes('dec') ||
    normalized.includes('float') ||
    normalized.includes('double') ||
    normalized.includes('real')
  ) {
    return 'number';
  }
  if (normalized.includes('bool') || normalized === 'bit') {
    return 'boolean';
  }
  return 'string';
}

function formatWithParts(table: KtxTableRef, quote: (identifier: string) => string, sqlite = false): string {
  const parts = sqlite ? [table.name] : [table.catalog, table.db, table.name].filter((part): part is string => !!part);
  return parts.map(quote).join('.');
}

function createDialect(type: SupportedDriver, quote: (identifier: string) => string, sqlite = false): KtxDialect {
  return {
    type,
    quoteIdentifier: quote,
    formatTableName: (table) => formatWithParts(table, quote, sqlite),
    mapToDimensionType: inferDimensionType,
  };
}

const dialects: Record<SupportedDriver, KtxDialect> = {
  postgres: createDialect('postgres', doubleQuoted),
  postgresql: createDialect('postgresql', doubleQuoted),
  mysql: createDialect('mysql', backtickQuoted),
  clickhouse: createDialect('clickhouse', backtickQuoted),
  sqlite: createDialect('sqlite', doubleQuoted, true),
  sqlite3: createDialect('sqlite3', doubleQuoted, true),
  snowflake: createDialect('snowflake', doubleQuoted),
  bigquery: createDialect('bigquery', bigQueryQuoted),
  sqlserver: createDialect('sqlserver', bracketQuoted),
};

export function getDialectForDriver(driver: string): KtxDialect {
  const normalized = driver.toLowerCase().trim();
  if (normalized in dialects) {
    return dialects[normalized as SupportedDriver];
  }
  throw new Error(`Unsupported warehouse driver "${driver}". Supported drivers: ${supportedDrivers.join(', ')}`);
}
```

Modify `packages/context/src/connections/index.ts`:

```ts
export type { KtxDialect, SupportedDriver } from './dialects.js';
export { getDialectForDriver } from './dialects.js';
```

- [ ] **Step 4: Run the dialect tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/connections/dialects.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/connections/dialects.ts packages/context/src/connections/dialects.test.ts packages/context/src/connections/index.ts
git commit -m "feat(context): add warehouse dialect dispatch"
```

### Task 2: Add the raw scan warehouse catalog service

**Files:**
- Create: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`
- Create: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Create `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../project/index.js';
import { WarehouseCatalogService } from './warehouse-catalog.service.js';

describe('WarehouseCatalogService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-warehouse-catalog-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedLiveDatabaseScan(connectionName = 'warehouse', syncId = 'sync-2', driver = 'postgres') {
    const root = `raw-sources/${connectionName}/live-database/${syncId}`;
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify({ connectionId: connectionName, driver, extractedAt: '2026-05-12T00:00:00.000Z' }, null, 2),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    await project.fileStore.writeFile(
      `${root}/tables/orders.json`,
      JSON.stringify(
        {
          catalog: null,
          db: driver === 'sqlite' ? null : 'public',
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
          foreignKeys: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed orders',
    );
    await project.fileStore.writeFile(
      `${root}/enrichment/relationship-profile.json`,
      JSON.stringify(
        {
          connectionId: connectionName,
          driver,
          sqlAvailable: true,
          queryCount: 3,
          tables: [{ table: { catalog: null, db: driver === 'sqlite' ? null : 'public', name: 'orders' }, rowCount: 12 }],
          columns: {
            'orders.status': {
              table: { catalog: null, db: driver === 'sqlite' ? null : 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'text',
              rowCount: 12,
              nullCount: 0,
              distinctCount: 2,
              uniquenessRatio: 0.1667,
              nullRate: 0,
              sampleValues: ['paid', 'refunded'],
              minTextLength: 4,
              maxTextLength: 8,
            },
          },
          warnings: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed profile',
    );
  }

  it('finds the latest sync and merges table schema with relationship profile values', async () => {
    await seedLiveDatabaseScan('warehouse', 'sync-1');
    await seedLiveDatabaseScan('warehouse', 'sync-2');
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.getLatestSyncId('warehouse')).resolves.toBe('sync-2');
    const detail = await catalog.getTable({ connectionName: 'warehouse', catalog: null, db: 'public', name: 'orders' });

    expect(detail).toMatchObject({
      connectionName: 'warehouse',
      display: 'public.orders',
      rowCount: 12,
      columns: [
        { name: 'id', nativeType: 'integer', primaryKey: true },
        { name: 'status', nativeType: 'text', sampleValues: ['paid', 'refunded'], distinctCount: 2 },
      ],
    });
  });

  it('returns scanAvailable=false when no live-database scan exists', async () => {
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });
    await expect(catalog.getTable({ connectionName: 'missing', catalog: null, db: 'public', name: 'orders' })).resolves.toBeNull();
    await expect(catalog.hasScan('missing')).resolves.toBe(false);
  });

  it('resolves postgres display strings and returns closest candidates for missing tables', async () => {
    await seedLiveDatabaseScan();
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.resolveDisplay('warehouse', 'public.orders')).resolves.toMatchObject({
      resolved: { catalog: null, db: 'public', name: 'orders' },
      candidates: [],
      dialect: 'postgres',
    });
    await expect(catalog.resolveDisplay('warehouse', 'public.orderz')).resolves.toMatchObject({
      resolved: null,
      candidates: [{ name: 'orders' }],
    });
  });

  it('treats two-part BigQuery identifiers as ambiguous instead of guessing', async () => {
    await seedLiveDatabaseScan('warehouse', 'sync-bigquery', 'bigquery');
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.resolveDisplay('warehouse', 'public.orders')).resolves.toMatchObject({
      resolved: null,
      dialect: 'bigquery',
    });
  });

  it('searches table names, column names, comments, and descriptions', async () => {
    await seedLiveDatabaseScan();
    const catalog = new WarehouseCatalogService({ fileStore: project.fileStore });

    await expect(catalog.searchByName('warehouse', 'status', 10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'column',
          ref: expect.objectContaining({ db: 'public', name: 'orders', column: 'status' }),
          matchedOn: 'name',
        }),
      ]),
    );
  });
});
```

- [ ] **Step 2: Run the failing catalog tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts
```

Expected: FAIL because the service file does not exist.

- [ ] **Step 3: Add the catalog service**

Create `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts` with these exported shapes and behavior:

```ts
import type { KtxFileStorePort } from '../../../core/index.js';
import { getDialectForDriver } from '../../../connections/index.js';
import type { KtxConnectionDriver, KtxSchemaColumn, KtxSchemaForeignKey, KtxSchemaTable, KtxTableRef } from '../../../scan/types.js';

export interface WarehouseCatalogServiceDeps {
  fileStore: KtxFileStorePort;
}

export interface WarehouseColumnDetail extends KtxSchemaColumn {
  descriptions: Record<string, string>;
  rowCount: number | null;
  nullCount: number | null;
  distinctCount: number | null;
  nullRate: number | null;
  sampleValues: string[];
}

export interface TableDetail {
  connectionName: string;
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
  | { kind: 'table'; ref: KtxTableRef; display: string; matchedOn: 'name' | 'db' | 'comment' | 'description' }
  | { kind: 'column'; ref: KtxTableRef & { column: string }; display: string; matchedOn: 'name' | 'comment' | 'description' };

interface ConnectionArtifact {
  driver?: KtxConnectionDriver;
}

interface RelationshipProfileColumn {
  table?: KtxTableRef;
  column?: string;
  rowCount?: number;
  nullCount?: number;
  distinctCount?: number;
  nullRate?: number;
  sampleValues?: unknown[];
}

interface RelationshipProfileArtifact {
  driver?: KtxConnectionDriver;
  tables?: Array<{ table?: KtxTableRef; rowCount?: number }>;
  columns?: Record<string, RelationshipProfileColumn>;
}

interface ConnectionCatalog {
  connectionName: string;
  syncId: string;
  driver: KtxConnectionDriver;
  tables: KtxSchemaTable[];
  profile: RelationshipProfileArtifact | null;
}
```

The implementation must:

- Use `fileStore.listFiles("raw-sources/<connectionName>/live-database")` and choose the lexicographically latest path ending in `/connection.json`.
- Read every JSON file under `<latestRoot>/tables/` rather than reconstructing a path from the table ref. This supports encoded and simple table filenames already present in tests.
- Parse display strings by driver:
  - Postgres, MySQL, and ClickHouse: `schema.table`.
  - SQL Server, Snowflake, and BigQuery: `catalog.schema.table`.
  - SQLite: `table`.
  - For BigQuery, a two-part display must return `resolved: null` and candidate matches.
- Match table refs case-insensitively, while preserving stored casing in outputs.
- Merge relationship-profile fields by `(catalog, db, name, column)`, with fallback matching on `table.name + "." + column`.
- Cache a loaded connection catalog per `connectionName` within the service instance.
- Return `null` from `getTable()` when the scan is absent or the table ref is not found.

Use these method signatures:

```ts
export class WarehouseCatalogService {
  constructor(private readonly deps: WarehouseCatalogServiceDeps) {}

  async hasScan(connectionName: string): Promise<boolean>;
  async getLatestSyncId(connectionName: string): Promise<string | null>;
  async listTables(connectionName: string): Promise<KtxTableRef[]>;
  async getTable(ref: { connectionName: string } & KtxTableRef): Promise<TableDetail | null>;
  async resolveDisplay(connectionName: string, display: string): Promise<{
    resolved: KtxTableRef | null;
    candidates: KtxTableRef[];
    dialect: string;
  }>;
  async searchByName(connectionName: string, query: string, limit: number): Promise<RawSchemaHit[]>;
}
```

- [ ] **Step 4: Run the catalog tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts
git commit -m "feat(context): read warehouse scan catalog"
```

### Task 3: Add `entity_details`

**Files:**
- Create: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`
- Create: `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts`

- [ ] **Step 1: Write failing `entity_details` tests**

Create tests that instantiate the tool with a seeded `WarehouseCatalogService` and a `ToolContext` whose session has `allowedConnectionNames: new Set(['warehouse'])`. Test these cases:

```ts
it('returns scoped table detail for a display target', async () => {
  const result = await tool.call(
    { connectionName: 'warehouse', targets: [{ display: 'public.orders' }] },
    context,
  );
  expect(result.markdown).toContain('### public.orders');
  expect(result.markdown).toContain('- status (text, nullable=false)');
  expect(result.markdown).toContain('sample: ["paid","refunded"]');
  expect(result.structured.scanAvailable).toBe(true);
  expect(result.structured.resolved).toHaveLength(1);
});

it('returns a no-scan state distinct from not found', async () => {
  const result = await tool.call(
    { connectionName: 'empty', targets: [{ display: 'public.orders' }] },
    { ...context, session: { ...context.session!, allowedConnectionNames: new Set(['empty']) } },
  );
  expect(result.markdown).toContain('No live-database scan available for connection "empty"; run `ktx scan` first.');
  expect(result.structured.scanAvailable).toBe(false);
});

it('refuses out-of-scope connections', async () => {
  const result = await tool.call(
    { connectionName: 'billing', targets: [{ display: 'public.orders' }] },
    context,
  );
  expect(result.markdown).toContain('Connection "billing" is not available to this ingest stage.');
  expect(result.structured.scanAvailable).toBe(false);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
```

Expected: FAIL because the tool file does not exist.

- [ ] **Step 3: Implement the tool**

Create `packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts`:

```ts
import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../tools/index.js';
import type { KtxTableRef } from '../../../scan/types.js';
import { WarehouseCatalogService, type TableDetail } from './warehouse-catalog.service.js';

const targetSchema = z.union([
  z.object({ display: z.string().min(1) }),
  z.object({
    catalog: z.string().nullable(),
    db: z.string().nullable(),
    name: z.string().min(1),
    column: z.string().optional(),
  }),
]);

const entityDetailsInputSchema = z.object({
  connectionName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  targets: z.array(targetSchema).min(1).max(50),
});

type EntityDetailsInput = z.infer<typeof entityDetailsInputSchema>;

export interface EntityDetailsStructured {
  resolved: TableDetail[];
  missing: Array<{ target: unknown; candidates: KtxTableRef[] }>;
  scanAvailable: boolean;
}

function allowedConnectionNames(context: ToolContext): ReadonlySet<string> | null {
  return context.session?.allowedConnectionNames ?? null;
}

function sampleText(values: string[]): string {
  return values.length > 0 ? ` - sample: ${JSON.stringify(values.slice(0, 10))}` : '';
}

function appendTableMarkdown(parts: string[], detail: TableDetail, columnName?: string): void {
  const columns = columnName ? detail.columns.filter((column) => column.name === columnName) : detail.columns;
  parts.push(`### ${detail.display}`);
  parts.push(`Type: ${detail.kind} | Native columns: ${detail.columns.length}`);
  if (detail.description || detail.comment) {
    parts.push(`Description: ${detail.description ?? detail.comment}`);
  }
  parts.push('', 'Columns:');
  for (const column of columns) {
    const pk = column.primaryKey ? ', PK' : '';
    parts.push(`- ${column.name} (${column.nativeType}, nullable=${column.nullable}${pk})${sampleText(column.sampleValues)}`);
  }
  parts.push('');
}

export class EntityDetailsTool extends BaseTool<typeof entityDetailsInputSchema> {
  readonly name = 'entity_details';

  constructor(private readonly catalogFactory: (context: ToolContext) => WarehouseCatalogService) {
    super();
  }

  get description(): string {
    return 'Verify warehouse tables and columns from the latest live-database scan before writing them into wiki or semantic-layer output.';
  }

  get inputSchema() {
    return entityDetailsInputSchema;
  }

  async call(input: EntityDetailsInput, context: ToolContext): Promise<ToolOutput<EntityDetailsStructured>> {
    const allowed = allowedConnectionNames(context);
    if (allowed && !allowed.has(input.connectionName)) {
      return {
        markdown: `Connection "${input.connectionName}" is not available to this ingest stage.`,
        structured: { resolved: [], missing: [], scanAvailable: false },
      };
    }

    const catalog = this.catalogFactory(context);
    const scanAvailable = await catalog.hasScan(input.connectionName);
    if (!scanAvailable) {
      return {
        markdown: `No live-database scan available for connection "${input.connectionName}"; run \`ktx scan\` first.`,
        structured: { resolved: [], missing: [], scanAvailable: false },
      };
    }

    const parts: string[] = [];
    const resolved: TableDetail[] = [];
    const missing: EntityDetailsStructured['missing'] = [];

    for (const target of input.targets) {
      const resolution =
        'display' in target
          ? await catalog.resolveDisplay(input.connectionName, target.display)
          : { resolved: { catalog: target.catalog, db: target.db, name: target.name }, candidates: [], dialect: '' };
      if (!resolution.resolved) {
        missing.push({ target, candidates: resolution.candidates });
        parts.push(`Not found in scan: ${'display' in target ? target.display : target.name}`);
        if (resolution.candidates.length > 0) {
          parts.push(`Closest matches: ${resolution.candidates.map((candidate) => candidate.name).join(', ')}`);
        }
        continue;
      }
      const detail = await catalog.getTable({ connectionName: input.connectionName, ...resolution.resolved });
      if (!detail) {
        missing.push({ target, candidates: resolution.candidates });
        continue;
      }
      resolved.push(detail);
      appendTableMarkdown(parts, detail, 'column' in target ? target.column : undefined);
    }

    return {
      markdown: parts.join('\n').trim(),
      structured: { resolved, missing, scanAvailable: true },
    };
  }
}
```

- [ ] **Step 4: Run the `entity_details` tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts
git commit -m "feat(context): add entity details verification tool"
```

### Task 4: Add `sql_execution`

**Files:**
- Create: `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts`
- Create: `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts`

- [ ] **Step 1: Write failing `sql_execution` tests**

Create tests for:

```ts
it('wraps read-only SQL with a capped row limit', async () => {
  connections.executeQuery.mockResolvedValue({ headers: ['status'], rows: [['paid']], totalRows: 1 });
  const result = await tool.call(
    { connectionName: 'warehouse', sql: 'select status from public.orders', rowLimit: 5 },
    context,
  );
  expect(connections.executeQuery).toHaveBeenCalledWith(
    'warehouse',
    'select * from (select status from public.orders) as ktx_query_result limit 5',
  );
  expect(result.markdown).toContain('| status |');
  expect(result.structured.wrappedSql).toContain('limit 5');
});

it.each(['insert into x values (1)', 'drop table x', 'vacuum'])('rejects mutating SQL: %s', async (sql) => {
  const result = await tool.call({ connectionName: 'warehouse', sql }, context);
  expect(result.markdown).toContain('Only read-only SELECT/WITH queries can be executed locally.');
  expect(connections.executeQuery).not.toHaveBeenCalled();
});

it('surfaces connector errors verbatim', async () => {
  connections.executeQuery.mockRejectedValue(new Error('relation "orbit_analytics.customer" does not exist'));
  const result = await tool.call(
    { connectionName: 'warehouse', sql: 'select 1 from orbit_analytics.customer', rowLimit: 1 },
    context,
  );
  expect(result.markdown).toContain('relation "orbit_analytics.customer" does not exist');
  expect(result.structured.error).toContain('relation "orbit_analytics.customer" does not exist');
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts
```

Expected: FAIL because the tool file does not exist.

- [ ] **Step 3: Implement the tool**

Create `packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts`:

```ts
import { z } from 'zod';
import { assertReadOnlySql, limitSqlForExecution } from '../../../connections/index.js';
import type { SlConnectionCatalogPort } from '../../../sl/index.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../tools/index.js';

const sqlExecutionInputSchema = z.object({
  connectionName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  sql: z.string().min(1),
  rowLimit: z.number().int().positive().max(1000).optional().default(100),
});

type SqlExecutionInput = z.infer<typeof sqlExecutionInputSchema>;

export interface SqlExecutionStructured {
  headers: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  sql: string;
  wrappedSql: string;
  error?: string;
}

function markdownTable(headers: string[], rows: unknown[][], totalRows: number): string {
  if (headers.length === 0) {
    return rows.length === 0 ? 'Query returned no rows.' : JSON.stringify(rows.slice(0, 20));
  }
  const visible = rows.slice(0, 20);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...visible.map((row) => `| ${row.map((value) => String(value ?? '')).join(' | ')} |`),
  ];
  if (totalRows > visible.length) {
    lines.push(`... +${totalRows - visible.length} more rows`);
  }
  return lines.join('\n');
}

export class SqlExecutionTool extends BaseTool<typeof sqlExecutionInputSchema> {
  readonly name = 'sql_execution';

  constructor(private readonly connections: SlConnectionCatalogPort) {
    super();
  }

  get description(): string {
    return 'Run a single read-only SELECT or WITH probe against an allowed warehouse connection and return a capped markdown table or the warehouse error.';
  }

  get inputSchema() {
    return sqlExecutionInputSchema;
  }

  async call(input: SqlExecutionInput, context: ToolContext): Promise<ToolOutput<SqlExecutionStructured>> {
    const allowed = context.session?.allowedConnectionNames;
    if (allowed && !allowed.has(input.connectionName)) {
      return {
        markdown: `Connection "${input.connectionName}" is not available to this ingest stage.`,
        structured: { headers: [], rows: [], rowCount: 0, truncated: false, sql: input.sql, wrappedSql: '', error: 'connection_not_allowed' },
      };
    }

    let sql: string;
    let wrappedSql: string;
    try {
      sql = assertReadOnlySql(input.sql);
      wrappedSql = limitSqlForExecution(sql, input.rowLimit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        markdown: message,
        structured: { headers: [], rows: [], rowCount: 0, truncated: false, sql: input.sql, wrappedSql: '', error: message },
      };
    }

    try {
      const result = await this.connections.executeQuery(input.connectionName, wrappedSql);
      const headers = result.headers ?? [];
      const rows = result.rows ?? [];
      const rowCount = result.totalRows ?? rows.length;
      return {
        markdown: markdownTable(headers, rows, rowCount),
        structured: { headers, rows, rowCount, truncated: rowCount > rows.length, sql, wrappedSql },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        markdown: `SQL execution failed: ${message}`,
        structured: { headers: [], rows: [], rowCount: 0, truncated: false, sql, wrappedSql, error: message },
      };
    }
  }
}
```

- [ ] **Step 4: Run the `sql_execution` tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts
git commit -m "feat(context): add ingest SQL verification tool"
```

### Task 5: Add `discover_data`

**Files:**
- Create: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`
- Create: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`
- Create: `packages/context/src/ingest/tools/warehouse-verification/index.ts`

- [ ] **Step 1: Write failing `discover_data` tests**

Create tests with fake `wikiSearchTool.call`, `slDiscoverTool.call`, and `WarehouseCatalogService.searchByName`. Cover:

```ts
it('groups wiki, semantic layer, and raw schema hits with routing hints', async () => {
  const result = await tool.call({ query: 'orders', connectionName: 'warehouse', limit: 5 }, context);
  expect(result.markdown).toContain('## Wiki Pages');
  expect(result.markdown).toContain('use `wiki_read(blockKey)` for full content');
  expect(result.markdown).toContain('## Semantic Layer Sources');
  expect(result.markdown).toContain('use `sl_read_source(sourceName)` for the YAML');
  expect(result.markdown).toContain('## Raw Warehouse Schema');
  expect(result.markdown).toContain('use `entity_details({connectionName, targets: [{display}]})`');
  expect(result.structured.raw?.hits).toHaveLength(1);
});

it('delegates sourceName inspect mode to sl_discover only', async () => {
  const result = await tool.call({ sourceName: 'orders', connectionName: 'warehouse' }, context);
  expect(slDiscoverTool.call).toHaveBeenCalledWith({ sourceName: 'orders', connectionId: 'warehouse' }, context);
  expect(wikiSearchTool.call).not.toHaveBeenCalled();
  expect(catalog.searchByName).not.toHaveBeenCalled();
  expect(result.markdown).toContain('source detail');
});

it('returns the empty-state message when all sections are empty', async () => {
  const result = await tool.call({ query: 'customer source', connectionName: 'warehouse' }, emptyContext);
  expect(result.markdown).toContain('No matches for "customer source" across wiki, semantic layer, or raw warehouse schema.');
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
```

Expected: FAIL because the tool file does not exist.

- [ ] **Step 3: Implement the tool and index export**

Create `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`:

```ts
import { z } from 'zod';
import type { BaseTool, ToolContext, ToolOutput } from '../../../tools/index.js';
import { BaseTool as ToolBase } from '../../../tools/index.js';
import { WarehouseCatalogService, type RawSchemaHit } from './warehouse-catalog.service.js';

const discoverDataInputSchema = z.object({
  query: z.string().optional(),
  connectionName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  limit: z.number().int().positive().max(50).optional().default(10),
  sourceName: z.string().optional(),
});

type DiscoverDataInput = z.infer<typeof discoverDataInputSchema>;

export interface DiscoverDataStructured {
  wiki: unknown | null;
  sl: unknown | null;
  raw: { hits: RawSchemaHit[] } | null;
}

interface DiscoverDataDeps {
  wikiSearchTool: BaseTool;
  slDiscoverTool: BaseTool;
  catalogFactory: (context: ToolContext) => WarehouseCatalogService;
}

export class DiscoverDataTool extends ToolBase<typeof discoverDataInputSchema> {
  readonly name = 'discover_data';

  constructor(private readonly deps: DiscoverDataDeps) {
    super();
  }

  get description(): string {
    return 'Discover existing wiki pages, semantic layer sources, and raw warehouse schema hits before writing ingest output.';
  }

  get inputSchema() {
    return discoverDataInputSchema;
  }

  async call(input: DiscoverDataInput, context: ToolContext): Promise<ToolOutput<DiscoverDataStructured>> {
    if (input.sourceName) {
      const sl = await this.deps.slDiscoverTool.call(
        { sourceName: input.sourceName, connectionId: input.connectionName },
        context,
      );
      return { markdown: sl.markdown, structured: { wiki: null, sl: sl.structured, raw: null } };
    }

    const query = input.query?.trim() || '';
    const limit = input.limit ?? 10;
    const parts: string[] = [];
    let wiki: unknown | null = null;
    let sl: unknown | null = null;
    let raw: DiscoverDataStructured['raw'] = null;

    if (query) {
      const wikiResult = await this.deps.wikiSearchTool.call({ query, limit }, context);
      if (wikiResult.structured?.totalFound > 0) {
        parts.push('## Wiki Pages', '> use `wiki_read(blockKey)` for full content', wikiResult.markdown, '');
        wiki = wikiResult.structured;
      }
    }

    const slResult = await this.deps.slDiscoverTool.call(
      { query: query || undefined, connectionId: input.connectionName },
      context,
    );
    if (slResult.structured?.totalSources > 0) {
      parts.push('## Semantic Layer Sources', '> use `sl_read_source(sourceName)` for the YAML, or `entity_details` for warehouse-shape details', slResult.markdown, '');
      sl = slResult.structured;
    }

    const catalog = this.deps.catalogFactory(context);
    const connections = input.connectionName
      ? [input.connectionName]
      : [...(context.session?.allowedConnectionNames ?? [])].sort();
    const rawHits: RawSchemaHit[] = [];
    for (const connectionName of connections) {
      rawHits.push(...(await catalog.searchByName(connectionName, query, limit)));
    }
    if (rawHits.length > 0) {
      parts.push('## Raw Warehouse Schema', '> use `entity_details({connectionName, targets: [{display}]})` for full DDL + sample values');
      parts.push(
        rawHits
          .slice(0, limit)
          .map((hit) => `- ${hit.kind}: ${hit.display} (matched on ${hit.matchedOn})`)
          .join('\n'),
      );
      raw = { hits: rawHits.slice(0, limit) };
    }

    if (parts.length === 0) {
      return {
        markdown: `No matches for "${query}" across wiki, semantic layer, or raw warehouse schema. Try broader terms; this concept may not exist yet.`,
        structured: { wiki, sl, raw },
      };
    }

    return { markdown: parts.join('\n'), structured: { wiki, sl, raw } };
  }
}
```

Create `packages/context/src/ingest/tools/warehouse-verification/index.ts`:

```ts
import type { BaseTool, ToolContext } from '../../../tools/index.js';
import type { KtxFileStorePort } from '../../../core/index.js';
import type { SlConnectionCatalogPort } from '../../../sl/index.js';
import { DiscoverDataTool } from './discover-data.tool.js';
import { EntityDetailsTool } from './entity-details.tool.js';
import { SqlExecutionTool } from './sql-execution.tool.js';
import { WarehouseCatalogService } from './warehouse-catalog.service.js';

export { DiscoverDataTool } from './discover-data.tool.js';
export { EntityDetailsTool } from './entity-details.tool.js';
export { SqlExecutionTool } from './sql-execution.tool.js';
export { WarehouseCatalogService } from './warehouse-catalog.service.js';
export type { TableDetail, WarehouseColumnDetail, RawSchemaHit } from './warehouse-catalog.service.js';

export function createWarehouseVerificationTools(deps: {
  connections: SlConnectionCatalogPort;
  fallbackFileStore: KtxFileStorePort;
  wikiSearchTool: BaseTool;
  slDiscoverTool: BaseTool;
}): BaseTool[] {
  const catalogFactory = (context: ToolContext) =>
    new WarehouseCatalogService({
      fileStore: context.session?.configService ?? deps.fallbackFileStore,
    });
  return [
    new EntityDetailsTool(catalogFactory),
    new SqlExecutionTool(deps.connections),
    new DiscoverDataTool({
      wikiSearchTool: deps.wikiSearchTool,
      slDiscoverTool: deps.slDiscoverTool,
      catalogFactory,
    }),
  ];
}
```

- [ ] **Step 4: Run the `discover_data` tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts packages/context/src/ingest/tools/warehouse-verification/index.ts
git commit -m "feat(context): add raw warehouse discovery tool"
```

### Task 6: Wire tools into ingest sessions

**Files:**
- Modify: `packages/context/src/tools/tool-session.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/ingest-bundle.runner.test.ts`

- [ ] **Step 1: Write failing scoping test**

Add to `packages/context/src/ingest/ingest-bundle.runner.test.ts`:

```ts
it('threads target warehouse connection names into WorkUnit and reconcile tool sessions', async () => {
  const deps = makeDeps();
  const sessions: any[] = [];
  deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['warehouse']);
  deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
    sessions.push(toolSession);
    return {
      toAiSdkTools: vi.fn().mockReturnValue({}),
      getAllTools: vi.fn().mockReturnValue([]),
      getToolNames: vi.fn().mockReturnValue([]),
    };
  });
  deps.agentRunner.runLoop.mockResolvedValue({ stopReason: 'natural' });

  const runner = buildRunner(deps);
  (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
    currentHashes: new Map([['a.yml', 'h1']]),
    rawDirInWorktree: 'raw-sources/notion/fake/s',
  });
  (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

  await runner.run({
    jobId: 'j1',
    connectionId: 'notion',
    sourceKey: 'fake',
    trigger: 'upload',
    bundleRef: { kind: 'upload', uploadId: 'upload-x' },
  });

  expect([...sessions[0].allowedConnectionNames].sort()).toEqual(['notion', 'warehouse']);
});
```

- [ ] **Step 2: Run the failing runner test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.test.ts -t "threads target warehouse connection names"
```

Expected: FAIL because `allowedConnectionNames` is absent.

- [ ] **Step 3: Thread allowed connection names**

Modify `packages/context/src/tools/tool-session.ts`:

```ts
  allowedRawPaths?: ReadonlySet<string>;
  allowedConnectionNames?: ReadonlySet<string>;
  semanticLayerService: SemanticLayerService;
```

Modify WU session creation in `packages/context/src/ingest/ingest-bundle.runner.ts`:

```ts
            allowedRawPaths: new Set(wu.rawFiles),
            allowedConnectionNames: new Set(slConnectionIds),
            semanticLayerService: scopedSemanticLayerService,
```

Modify reconcile session creation in the same file:

```ts
        allowedRawPaths: reconciliationAllowedRawPaths,
        allowedConnectionNames: new Set(slConnectionIds),
        semanticLayerService: rcScopedSl,
```

- [ ] **Step 4: Register the tools in the local ingest toolset**

Modify `packages/context/src/ingest/local-bundle-runtime.ts`:

```ts
import {
  createWarehouseVerificationTools,
} from './tools/warehouse-verification/index.js';
```

Refactor the existing inline wiki and SL tool instances in `LocalIngestToolsetFactory` so `wikiSearchTool` and `slDiscoverTool` are named constants, then add the warehouse tools:

```ts
    const wikiSearchTool = new WikiSearchTool({
      search: async (input) => {
        const results = await searchLocalKnowledgePages(deps.project, {
          userId: input.userId,
          query: input.query,
          limit: input.limit,
          embeddingService: deps.embedding,
        });
        return {
          results: results.slice(0, input.limit).map((result) => ({
            key: result.key,
            path: result.path,
            summary: result.summary,
            score: result.score,
            matchReasons: result.matchReasons,
            lanes: result.lanes,
          })),
          totalFound: results.length,
        };
      },
    });
    const slDiscoverTool = new SlDiscoverTool(slDeps, { maxSources: 25, minRrfScore: 0, maxDetailedSources: 5 });
    const warehouseVerificationTools = createWarehouseVerificationTools({
      connections: deps.connections,
      fallbackFileStore: deps.project.fileStore,
      wikiSearchTool,
      slDiscoverTool,
    });

    this.baseTools = [
      new WikiReadTool(deps.wikiService, deps.knowledgeIndex),
      wikiSearchTool,
      new WikiListTagsTool(deps.wikiService, deps.knowledgeIndex),
      new WikiWriteTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      new WikiRemoveTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      slDiscoverTool,
      new SlEditSourceTool(slDeps),
      new SlReadSourceTool(slDeps),
      new SlWriteSourceTool(slDeps),
      new SlValidateTool(slDeps),
      new SlRollbackTool(deps.slSourcesRepository, deps.connections, 0),
      ...warehouseVerificationTools,
    ];
```

- [ ] **Step 5: Run integration and toolset tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/ingest-bundle.runner.test.ts -t "threads target warehouse connection names"
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/context/src/tools/tool-session.ts packages/context/src/ingest/ingest-bundle.runner.ts packages/context/src/ingest/local-bundle-runtime.ts packages/context/src/ingest/ingest-bundle.runner.test.ts
git commit -m "feat(context): expose warehouse verification tools to ingest"
```

### Task 7: Update writer prompts and cleanup stale references

**Files:**
- Create: `packages/context/skills/_shared/identifier-verification.md`
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
- Modify: `packages/context/skills/sl/SKILL.md`
- Modify: `packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts`
- Modify: `packages/context/src/sl/tools/sl-warehouse-validation.ts`

- [ ] **Step 1: Add the shared protocol file**

Create `packages/context/skills/_shared/identifier-verification.md`:

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
```

- [ ] **Step 2: Inline the protocol into writer skills**

Add the same protocol block to these skills:

```text
packages/context/skills/notion_synthesize/SKILL.md
packages/context/skills/dbt_ingest/SKILL.md
packages/context/skills/lookml_ingest/SKILL.md
packages/context/skills/looker_ingest/SKILL.md
packages/context/skills/metabase_ingest/SKILL.md
packages/context/skills/metricflow_ingest/SKILL.md
packages/context/skills/live_database_ingest/SKILL.md
packages/context/skills/historic_sql_patterns/SKILL.md
packages/context/skills/knowledge_capture/SKILL.md
packages/context/skills/sl_capture/SKILL.md
```

For `packages/context/skills/historic_sql_table_digest/SKILL.md`, add this shorter block:

```md
## Identifier Verification Protocol

Only mention columns visible in the table's scan record. Use
`entity_details({connectionName, targets: [{display: "<identifier>"}]})` if
the table or column attribution is uncertain. Do not infer join columns or
filters from neighboring SQL unless the scan record confirms the column exists
on the named table.
```

For `packages/context/skills/sl/SKILL.md`, add this cross-reference:

```md
For capture-time identifier verification, load `sl_capture`. Synthesis writer
skills must verify warehouse identifiers with `discover_data`,
`entity_details`, and `sql_execution` before emitting table or column names.
```

- [ ] **Step 3: Apply per-skill edits**

Make these exact content changes:

- In `notion_synthesize`, add `discover_data`, `entity_details`, and `sql_execution` to the `Allowed:` line. Replace `tableRef: "orbit_analytics.customer"` with `tableRef: "<schema>.<table>"`.
- In `dbt_ingest`, replace `wiki_sl_search` with `discover_data` and `sl_describe_table` with `entity_details`.
- In `lookml_ingest`, add: `Verify each sql_table_name from the LookML view with entity_details before mapping to an SL source.`
- In `looker_ingest`, add: `For every Looker field reference, call entity_details on the underlying schema.table.column before promoting it to sl_refs or quoting it in wiki body.`
- In `metabase_ingest`, add: `Before writing a wiki page derived from a Metabase question SQL, verify each schema.table.column mentioned with entity_details.`
- In `metricflow_ingest`, add: `Verify each MetricFlow model source table with entity_details before producing the corresponding sl_write_source.`
- In `live_database_ingest`, add: `Sample values come from the scan record; do not invent values not present in relationship-profile.json.`
- In `historic_sql_patterns`, add: `Every join column mentioned in pattern descriptions must be verified via entity_details for both sides of the join.`
- In `knowledge_capture`, update the workflow to call `discover_data` first when a page relates to data or SL concepts.
- In `sl_capture`, add: `Before sl_write_source, call entity_details on the target table to confirm column names and types match the YAML being written.`

- [ ] **Step 4: Remove stale code and prompt strings**

Modify `packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts`:

```ts
.describe('The fully-qualified table or source reference that triggered the fallback (e.g. "<schema>.<table>"). Used to generate canonical detail text.'),
```

Modify `packages/context/src/sl/tools/sl-warehouse-validation.ts`:

```ts
          `that inherits the manifest schema. Call sl_read_source to inspect the existing source first.`,
```

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/context/skills packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts packages/context/src/sl/tools/sl-warehouse-validation.ts
git commit -m "docs(context): add ingest identifier verification protocol"
```

### Task 8: Add prompt-bundling and banned-string tests

**Files:**
- Modify: `packages/context/src/memory/memory-runtime-assets.test.ts`
- Modify: `packages/context/src/ingest/ingest-runtime-assets.test.ts`

- [ ] **Step 1: Add failing asset tests**

Add to `packages/context/src/memory/memory-runtime-assets.test.ts`:

```ts
const verificationWriterSkills = [
  'notion_synthesize',
  'dbt_ingest',
  'lookml_ingest',
  'looker_ingest',
  'metabase_ingest',
  'metricflow_ingest',
  'live_database_ingest',
  'historic_sql_table_digest',
  'historic_sql_patterns',
  'knowledge_capture',
  'sl_capture',
] as const;

it('ships identifier verification protocol in every synthesis writer skill', async () => {
  for (const skillName of verificationWriterSkills) {
    const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
    expect(body).toContain('## Identifier Verification Protocol');
    expect(body).toMatch(/discover_data|entity_details/);
  }
});

it('does not ship stale warehouse verification tool names or fictional identifiers', async () => {
  for (const skillName of verificationWriterSkills) {
    const body = await readFile(join(skillsDir, skillName, 'SKILL.md'), 'utf-8');
    expect(body).not.toContain('orbit_analytics.customer');
    expect(body).not.toContain('wiki_sl_search');
    expect(body).not.toContain('sl_describe_table');
  }
});
```

Add to `packages/context/src/ingest/ingest-runtime-assets.test.ts`:

```ts
it('packages identifier verification prompt assets', async () => {
  const shared = await readFile(join(skillsDir, '_shared', 'identifier-verification.md'), 'utf-8');
  expect(shared).toContain('## Identifier Verification Protocol');
  expect(shared).toContain('discover_data');
  expect(shared).toContain('entity_details');
  expect(shared).toContain('sql_execution');
});
```

- [ ] **Step 2: Run the asset tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runtime-assets.test.ts src/ingest/ingest-runtime-assets.test.ts
```

Expected: PASS after Task 7.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/context/src/memory/memory-runtime-assets.test.ts packages/context/src/ingest/ingest-runtime-assets.test.ts
git commit -m "test(context): guard ingest identifier verification prompts"
```

### Task 9: Run the full v1 verification set

**Files:**
- Verify all files changed by Tasks 1-8.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/connections/dialects.test.ts \
  src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts \
  src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts \
  src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  src/ingest/ingest-bundle.runner.test.ts \
  src/memory/memory-runtime-assets.test.ts \
  src/ingest/ingest-runtime-assets.test.ts
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
  packages/context/src/connections/dialects.ts \
  packages/context/src/connections/dialects.test.ts \
  packages/context/src/connections/index.ts \
  packages/context/src/tools/tool-session.ts \
  packages/context/src/ingest/ingest-bundle.runner.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/ingest-bundle.runner.test.ts \
  packages/context/src/ingest/tools/emit-unmapped-fallback.tool.ts \
  packages/context/src/sl/tools/sl-warehouse-validation.ts \
  packages/context/src/memory/memory-runtime-assets.test.ts \
  packages/context/src/ingest/ingest-runtime-assets.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/entity-details.tool.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  packages/context/src/ingest/tools/warehouse-verification/index.ts \
  packages/context/skills/_shared/identifier-verification.md \
  packages/context/skills/notion_synthesize/SKILL.md \
  packages/context/skills/dbt_ingest/SKILL.md \
  packages/context/skills/lookml_ingest/SKILL.md \
  packages/context/skills/looker_ingest/SKILL.md \
  packages/context/skills/metabase_ingest/SKILL.md \
  packages/context/skills/metricflow_ingest/SKILL.md \
  packages/context/skills/live_database_ingest/SKILL.md \
  packages/context/skills/historic_sql_table_digest/SKILL.md \
  packages/context/skills/historic_sql_patterns/SKILL.md \
  packages/context/skills/knowledge_capture/SKILL.md \
  packages/context/skills/sl_capture/SKILL.md \
  packages/context/skills/sl/SKILL.md
```

Expected: PASS. If the repo has no pre-commit config or the local `uv` version cannot satisfy the project pin, record the exact error and rely on the focused tests plus type-check.

- [ ] **Step 5: Commit final verification notes if any files changed during checks**

Run:

```bash
git status --short
```

Expected: only intentional files are modified. Commit any formatter-driven edits with:

```bash
git add packages/context
git commit -m "chore(context): verify warehouse verification tools"
```

## Self-review checklist

- Spec coverage: the plan covers dialect dispatch, raw scan catalog reads, `entity_details`, `sql_execution`, `discover_data`, WU and reconcile availability, prompt updates, cleanups, and tests.
- Placeholder scan: no task relies on unnamed future work.
- Type consistency: tool inputs use `connectionName`; existing `sl_discover` calls receive `connectionId` internally; raw SQL execution uses `SlConnectionCatalogPort.executeQuery()` because `SemanticLayerService.executeQuery()` currently accepts semantic-layer query input, not raw SQL.
