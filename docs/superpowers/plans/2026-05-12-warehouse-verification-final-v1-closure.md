# Warehouse Verification Final V1 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v1 gaps that still prevent ingest agents from
reliably following warehouse verification results through to `entity_details`
and `sql_execution`.

**Architecture:** Keep the existing warehouse verification module and runner
session scoping. Add connection names to raw discovery hits, expose primary
warehouse targets from the remaining source adapters, and make local ingest
SQL probes use the same scan connector read-only execution path as schema scan.

**Tech Stack:** TypeScript, Node 22, Vitest, AI SDK v6 tools, Zod, KTX local
ingest runtime, KTX scan connectors.

---

## Audit summary

The first two implementation plans landed the warehouse verification tools,
prompt protocol, Notion warehouse scoping, and stale prompt-name cleanup. The
focused audit on May 12, 2026, found three remaining v1-blocking gaps:

- `discover_data` searches multiple allowed raw warehouse scans, but raw hits do
  not carry or render `connectionName`. The tool tells the agent to call
  `entity_details({connectionName, targets: [...]})`, then omits the required
  `connectionName` from the follow-up evidence.
- Local LookML and MetricFlow adapters do not expose primary warehouse target
  IDs. The runner only adds adapter-provided targets to `allowedConnectionNames`,
  so those WorkUnits cannot use raw warehouse verification unless their source
  connection is itself the warehouse.
- `sql_execution` calls the local ingest connection catalog, but the catalog
  either has no query executor in normal CLI ingest or calls an injected
  executor without `projectDir` and connection config. The default local query
  executor cannot dispatch without that config.

Non-blocking gaps remain out of scope for this v1 plan:

- Full DDL-style `entity_details` formatting with FK profile summaries.
- AST-backed SQL read-only validation for data-modifying CTE bodies.
- Search over generated `enrichment/descriptions.json`.
- Lexicographic latest-sync edge cases for non-timestamp sync IDs.
- Hard write-time validation in `wiki_write` and `emit_unmapped_fallback`.

## File structure

Modify these files:

- `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`:
  add `connectionName` to raw schema hit records.
- `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`:
  render raw hit connection names and preserve them in structured output.
- `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`:
  cover multi-connection raw discovery follow-up data.
- `packages/context/src/ingest/adapters/lookml/lookml.adapter.ts`:
  accept and return configured target warehouse connection IDs.
- `packages/context/src/ingest/adapters/lookml/lookml.adapter.test.ts`:
  cover LookML target warehouse IDs.
- `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts`:
  accept and return configured target warehouse connection IDs.
- `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts`:
  cover MetricFlow target warehouse IDs.
- `packages/context/src/ingest/local-adapters.ts`:
  pass primary warehouse IDs into LookML and MetricFlow adapters.
- `packages/context/src/ingest/local-adapters.test.ts`:
  cover local adapter warehouse target fan-out.
- `packages/context/src/ingest/local-bundle-runtime.ts`:
  pass full project connection config to local ingest query executors.
- `packages/context/src/ingest/local-bundle-runtime.test.ts`:
  cover the local ingest query executor call shape.
- `packages/context/src/ingest/local-ingest.ts`:
  use the shared query executor port type.
- `packages/context/src/mcp/local-project-ports.ts`:
  no behavior change expected, but type-checks against the updated local ingest
  query executor type.
- `packages/cli/src/ingest.ts`:
  provide a read-only scan-connector-backed query executor for normal local
  ingest runs.

Create these files:

- `packages/cli/src/ingest-query-executor.ts`: CLI query executor that adapts
  scan connectors' `executeReadOnly()` method to `KtxSqlQueryExecutorPort`.
- `packages/cli/src/ingest-query-executor.test.ts`: unit coverage for the CLI
  ingest query executor.

### Task 1: Preserve raw discovery connection names

**Files:**
- Modify: `packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`
- Modify: `packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`

- [ ] **Step 1: Write the failing multi-connection discovery test**

Add this test to
`packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts`:

```ts
  it('includes connectionName on raw schema hits so entity_details can follow up', async () => {
    const multiConnectionContext: ToolContext = {
      ...context,
      session: { allowedConnectionNames: new Set(['warehouse', 'analytics']) } as any,
    };
    catalog.searchByName.mockImplementation(async (connectionName: string, query: string) => [
      {
        kind: 'table',
        connectionName,
        ref: { catalog: null, db: 'public', name: `${connectionName}_${query}` },
        display: `public.${connectionName}_${query}`,
        matchedOn: 'name',
      },
    ]);

    const result = await tool.call({ query: 'orders', limit: 10 }, multiConnectionContext);

    expect(catalog.searchByName).toHaveBeenCalledWith('analytics', 'orders', 10);
    expect(catalog.searchByName).toHaveBeenCalledWith('warehouse', 'orders', 10);
    expect(result.markdown).toContain('connectionName=analytics');
    expect(result.markdown).toContain('connectionName=warehouse');
    expect(result.markdown).toContain(
      'entity_details({connectionName: "analytics", targets: [{display: "public.analytics_orders"}]})',
    );
    expect(result.structured.raw?.hits.map((hit) => hit.connectionName)).toEqual([
      'analytics',
      'warehouse',
    ]);
  });
```

- [ ] **Step 2: Run the failing discovery test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/discover-data.tool.test.ts -t "connectionName on raw schema hits"
```

Expected: FAIL because `RawSchemaHit` has no `connectionName` property and the
markdown only renders the display string.

- [ ] **Step 3: Add `connectionName` to raw schema hits**

Modify the raw hit type and hit construction in
`packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts`:

```ts
export type RawSchemaHit =
  | {
      kind: 'table';
      connectionName: string;
      ref: KtxTableRef;
      display: string;
      matchedOn: 'name' | 'db' | 'comment' | 'description';
    }
  | {
      kind: 'column';
      connectionName: string;
      ref: KtxTableRef & { column: string };
      display: string;
      matchedOn: 'name' | 'comment' | 'description';
    };
```

In the table hit block, add `connectionName`:

```ts
        hits.push({
          kind: 'table',
          connectionName,
          ref: { catalog: table.catalog, db: table.db, name: table.name },
          display: formatDisplay(catalog.driver, table),
          matchedOn: tableMatch,
        });
```

In the column hit block, add `connectionName`:

```ts
        hits.push({
          kind: 'column',
          connectionName,
          ref: { catalog: table.catalog, db: table.db, name: table.name, column: column.name },
          display: `${formatDisplay(catalog.driver, table)}.${column.name}`,
          matchedOn: columnMatch,
        });
```

- [ ] **Step 4: Render follow-up-ready raw hits**

Modify the raw schema markdown in
`packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts`:

```ts
      parts.push('## Raw Warehouse Schema', '> use `entity_details({connectionName, targets: [{display}]})` for full DDL + sample values');
      parts.push(
        rawHits
          .slice(0, limit)
          .map(
            (hit) =>
              `- ${hit.kind}: ${hit.display} [connectionName=${hit.connectionName}] (matched on ${hit.matchedOn}) - ` +
              `follow up with \`entity_details({connectionName: "${hit.connectionName}", targets: [{display: "${hit.display}"}]})\``,
          )
          .join('\n'),
      );
```

- [ ] **Step 5: Run the discovery test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts
git commit -m "fix(context): include raw discovery connection names"
```

### Task 2: Expose LookML and MetricFlow warehouse targets

**Files:**
- Modify: `packages/context/src/ingest/adapters/lookml/lookml.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/lookml/lookml.adapter.test.ts`
- Modify: `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts`
- Modify: `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts`
- Modify: `packages/context/src/ingest/local-adapters.ts`
- Modify: `packages/context/src/ingest/local-adapters.test.ts`

- [ ] **Step 1: Write failing adapter target tests**

Add this test to
`packages/context/src/ingest/adapters/lookml/lookml.adapter.test.ts`:

```ts
  it('returns configured target warehouse connection ids', async () => {
    const adapter = new LookmlSourceAdapter({
      homeDir: join(tmpRoot, 'home'),
      targetConnectionIds: ['warehouse', 'analytics', 'warehouse'],
    });

    await expect(adapter.listTargetConnectionIds?.(join(tmpRoot, 'staged'))).resolves.toEqual([
      'analytics',
      'warehouse',
    ]);
  });
```

Add this test to
`packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts`:

```ts
  it('returns configured target warehouse connection ids', async () => {
    const metricflow = new MetricflowSourceAdapter({
      homeDir: join(tmpRoot, 'cache-home'),
      targetConnectionIds: ['warehouse', 'analytics', 'warehouse'],
    });

    await expect(metricflow.listTargetConnectionIds?.(stagedDir)).resolves.toEqual([
      'analytics',
      'warehouse',
    ]);
  });
```

- [ ] **Step 2: Run the failing adapter tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/lookml/lookml.adapter.test.ts -t "target warehouse connection ids" \
  src/ingest/adapters/metricflow/metricflow.adapter.test.ts -t "target warehouse connection ids"
```

Expected: FAIL because neither adapter accepts `targetConnectionIds` or
implements `listTargetConnectionIds()`.

- [ ] **Step 3: Implement target ID support in LookML**

Modify `packages/context/src/ingest/adapters/lookml/lookml.adapter.ts`:

```ts
export interface LookmlSourceAdapterDeps {
  homeDir: string;
  targetConnectionIds?: string[];
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}
```

Add this method to `LookmlSourceAdapter`:

```ts
  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return uniqueSorted(this.deps.targetConnectionIds);
  }
```

- [ ] **Step 4: Implement target ID support in MetricFlow**

Modify `packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts`:

```ts
export interface MetricflowSourceAdapterDeps {
  homeDir: string;
  targetConnectionIds?: string[];
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}
```

Add this method to `MetricflowSourceAdapter`:

```ts
  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return uniqueSorted(this.deps.targetConnectionIds);
  }
```

- [ ] **Step 5: Pass primary warehouses from the local adapter factory**

Modify the LookML and MetricFlow adapter construction in
`packages/context/src/ingest/local-adapters.ts`:

```ts
    new LookmlSourceAdapter({
      homeDir: join(project.projectDir, '.ktx/cache'),
      targetConnectionIds: primaryWarehouseConnectionIds(project),
    }),
```

```ts
    new MetricflowSourceAdapter({
      homeDir: join(project.projectDir, '.ktx/cache'),
      targetConnectionIds: primaryWarehouseConnectionIds(project),
    }),
```

- [ ] **Step 6: Write the local adapter fan-out test**

Add this test to `packages/context/src/ingest/local-adapters.test.ts`:

```ts
  it('passes primary warehouse connection ids to local LookML and MetricFlow adapters', async () => {
    const adapters = createDefaultLocalIngestAdapters(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'postgresql://readonly@db.example.test/analytics',
        },
        lookml_docs: {
          driver: 'lookml',
          lookml: {
            repoUrl: 'https://github.com/acme/lookml.git',
          },
        },
        metrics_repo: {
          driver: 'metricflow',
          metricflow: {
            repoUrl: 'https://github.com/acme/metrics.git',
          },
        },
      } as never),
    );

    const lookml = adapters.find((adapter) => adapter.source === 'lookml');
    const metricflow = adapters.find((adapter) => adapter.source === 'metricflow');

    await expect(lookml?.listTargetConnectionIds?.('/tmp/staged-lookml')).resolves.toEqual([
      'warehouse',
    ]);
    await expect(metricflow?.listTargetConnectionIds?.('/tmp/staged-metricflow')).resolves.toEqual([
      'warehouse',
    ]);
  });
```

- [ ] **Step 7: Run the target fan-out tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/adapters/lookml/lookml.adapter.test.ts \
  src/ingest/adapters/metricflow/metricflow.adapter.test.ts \
  src/ingest/local-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/adapters/lookml/lookml.adapter.ts \
  packages/context/src/ingest/adapters/lookml/lookml.adapter.test.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts \
  packages/context/src/ingest/local-adapters.ts \
  packages/context/src/ingest/local-adapters.test.ts
git commit -m "fix(context): expose warehouse targets for LookML and MetricFlow"
```

### Task 3: Pass full connection config to local ingest SQL execution

**Files:**
- Modify: `packages/context/src/ingest/local-bundle-runtime.ts`
- Modify: `packages/context/src/ingest/local-bundle-runtime.test.ts`
- Modify: `packages/context/src/ingest/local-ingest.ts`

- [ ] **Step 1: Write the failing local connection catalog test**

In `packages/context/src/ingest/local-bundle-runtime.test.ts`, change the
Vitest import to include `vi`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

Extend `RuntimeWithConnectionDeps`:

```ts
type RuntimeWithConnectionDeps = {
  deps: {
    connections: {
      listEnabledConnections(ids: string[]): Promise<Array<{ id: string; name: string; connectionType: string }>>;
      getConnectionById(connectionId: string): Promise<{ id: string; name: string; connectionType: string } | null>;
      executeQuery(connectionId: string, sql: string): Promise<unknown>;
    };
  };
};
```

Add this test:

```ts
  it('passes project connection config to local ingest query executors', async () => {
    const agentRunner = new AgentRunnerService({ llmProvider: { getModel: () => ({}) as never } as any });
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['answer'],
        rows: [[1]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
      queryExecutor,
    });
    const connections = (runtime.runner as unknown as RuntimeWithConnectionDeps).deps.connections;

    await expect(connections.executeQuery('warehouse', 'select 1')).resolves.toMatchObject({
      headers: ['answer'],
    });
    expect(queryExecutor.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      projectDir: project.projectDir,
      connection: project.config.connections.warehouse,
      sql: 'select 1',
    });
  });
```

- [ ] **Step 2: Run the failing local runtime test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts -t "project connection config"
```

Expected: FAIL because `LocalConnectionCatalog.executeQuery()` only passes
`connectionId` and `sql`.

- [ ] **Step 3: Update local ingest query executor types**

In `packages/context/src/ingest/local-bundle-runtime.ts`, import the shared
query executor type:

```ts
import { localConnectionInfoFromConfig, type KtxSqlQueryExecutorPort } from '../connections/index.js';
```

Change `CreateLocalBundleIngestRuntimeOptions.queryExecutor` to:

```ts
  queryExecutor?: KtxSqlQueryExecutorPort;
```

Change `LocalConnectionCatalog` to store that type:

```ts
class LocalConnectionCatalog implements SlConnectionCatalogPort {
  constructor(
    private readonly project: KtxLocalProject,
    private readonly queryExecutor?: KtxSqlQueryExecutorPort,
  ) {}
```

Change `executeQuery()`:

```ts
  async executeQuery(connectionId: string, sql: string): Promise<KtxQueryResult> {
    if (!this.queryExecutor) {
      throw new Error('Local ingest has no query executor configured');
    }
    return this.queryExecutor.execute({
      connectionId,
      projectDir: this.project.projectDir,
      connection: this.project.config.connections[connectionId],
      sql,
    });
  }
```

In `packages/context/src/ingest/local-ingest.ts`, replace the local query
executor object type with the shared port:

```ts
import type { KtxSqlQueryExecutorPort } from '../connections/index.js';
```

```ts
  queryExecutor?: KtxSqlQueryExecutorPort;
```

- [ ] **Step 4: Run the local runtime test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/ingest/local-bundle-runtime.test.ts -t "project connection config"
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/local-bundle-runtime.test.ts \
  packages/context/src/ingest/local-ingest.ts
git commit -m "fix(context): pass connection config to ingest query executors"
```

### Task 4: Supply a scan-connector query executor to CLI ingest

**Files:**
- Create: `packages/cli/src/ingest-query-executor.ts`
- Create: `packages/cli/src/ingest-query-executor.test.ts`
- Modify: `packages/cli/src/ingest.ts`

- [ ] **Step 1: Write the CLI query executor tests**

Create `packages/cli/src/ingest-query-executor.test.ts`:

```ts
import type { KtxLocalProject } from '@ktx/context/project';
import { createKtxConnectorCapabilities, type KtxScanConnector } from '@ktx/context/scan';
import { describe, expect, it, vi } from 'vitest';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';

function project(): KtxLocalProject {
  return {
    projectDir: '/tmp/ktx-query-project',
    config: {
      project: 'warehouse',
      connections: {
        warehouse: { driver: 'postgres', url: 'postgresql://readonly@example.test/db' },
      },
    },
  } as unknown as KtxLocalProject;
}

function connector(overrides: Partial<KtxScanConnector> = {}): KtxScanConnector {
  return {
    id: 'warehouse',
    driver: 'postgres',
    capabilities: createKtxConnectorCapabilities({ readOnlySql: true }),
    async introspect() {
      throw new Error('introspect is not used by this test');
    },
    executeReadOnly: vi.fn(async () => ({
      headers: ['answer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    })),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('createKtxCliIngestQueryExecutor', () => {
  it('executes read-only SQL through the scan connector and cleans it up', async () => {
    const scanConnector = connector();
    const createConnector = vi.fn(async () => scanConnector);
    const executor = createKtxCliIngestQueryExecutor(project(), { createConnector });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'postgres', url: 'postgresql://readonly@example.test/db' },
        projectDir: '/tmp/ktx-query-project',
        sql: 'select 1',
        maxRows: 5,
      }),
    ).resolves.toMatchObject({
      headers: ['answer'],
      rows: [[1]],
      totalRows: 1,
      command: 'SELECT',
      rowCount: 1,
    });

    expect(createConnector).toHaveBeenCalledWith(project(), 'warehouse');
    expect(scanConnector.executeReadOnly).toHaveBeenCalledWith(
      { connectionId: 'warehouse', sql: 'select 1', maxRows: 5 },
      { runId: 'ingest-sql-execution' },
    );
    expect(scanConnector.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects connectors without read-only SQL support', async () => {
    const scanConnector = connector({
      capabilities: createKtxConnectorCapabilities({ readOnlySql: false }),
      executeReadOnly: undefined,
    });
    const executor = createKtxCliIngestQueryExecutor(project(), {
      createConnector: vi.fn(async () => scanConnector),
    });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'postgres' },
        projectDir: '/tmp/ktx-query-project',
        sql: 'select 1',
      }),
    ).rejects.toThrow('Connection "warehouse" driver "postgres" does not support read-only SQL execution.');
    expect(scanConnector.cleanup).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the failing CLI query executor test**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest-query-executor.test.ts
```

Expected: FAIL because `ingest-query-executor.ts` does not exist.

- [ ] **Step 3: Add the scan-connector-backed query executor**

Create `packages/cli/src/ingest-query-executor.ts`:

```ts
import type { KtxSqlQueryExecutionInput, KtxSqlQueryExecutorPort } from '@ktx/context/connections';
import type { KtxLocalProject } from '@ktx/context/project';
import type { KtxScanConnector, KtxScanContext } from '@ktx/context/scan';
import { createKtxCliScanConnector } from './local-scan-connectors.js';

type CreateConnector = typeof createKtxCliScanConnector;

export interface KtxCliIngestQueryExecutorDeps {
  createConnector?: CreateConnector;
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  await connector?.cleanup?.();
}

export function createKtxCliIngestQueryExecutor(
  project: KtxLocalProject,
  deps: KtxCliIngestQueryExecutorDeps = {},
): KtxSqlQueryExecutorPort {
  const createConnector = deps.createConnector ?? createKtxCliScanConnector;
  return {
    async execute(input: KtxSqlQueryExecutionInput) {
      let connector: KtxScanConnector | null = null;
      try {
        connector = await createConnector(project, input.connectionId);
        if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
          throw new Error(
            `Connection "${input.connectionId}" driver "${connector.driver}" does not support read-only SQL execution.`,
          );
        }

        const ctx: KtxScanContext = { runId: 'ingest-sql-execution' };
        const result = await connector.executeReadOnly(
          { connectionId: input.connectionId, sql: input.sql, maxRows: input.maxRows },
          ctx,
        );
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
          command: 'SELECT',
          rowCount: result.rowCount,
        };
      } finally {
        await cleanupConnector(connector);
      }
    },
  };
}
```

- [ ] **Step 4: Wire the CLI executor into local ingest runs**

In `packages/cli/src/ingest.ts`, import the executor and type:

```ts
import type { KtxSqlQueryExecutorPort } from '@ktx/context/connections';
import type { KtxLocalProject } from '@ktx/context/project';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';
```

Extend `KtxIngestDeps`:

```ts
  createQueryExecutor?: (project: KtxLocalProject) => KtxSqlQueryExecutorPort;
```

Inside the `args.command === 'run'` branch, after `localIngestOptions` is
defined, add:

```ts
      const queryExecutor =
        localIngestOptions.queryExecutor ??
        (deps.createQueryExecutor ?? createKtxCliIngestQueryExecutor)(project);
```

Pass `queryExecutor` to both local ingest execution paths. In the Metabase
fan-out call:

```ts
          ...localIngestOptions,
          queryExecutor,
          trigger: 'manual_resync',
```

In the normal local ingest call:

```ts
          ...localIngestOptions,
          queryExecutor,
          pullConfigOptions: adapterOptions,
```

- [ ] **Step 5: Add CLI wiring coverage**

Add this test to `packages/cli/src/ingest.test.ts`:

```ts
  it('supplies a scan-connector query executor to local ingest runs', async () => {
    const io = makeIo();
    const projectDir = join(tempDir, 'query-executor-project');
    await writeWarehouseConfig(projectDir);
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: [],
        rows: [],
        totalRows: 0,
        command: 'SELECT',
        rowCount: 0,
      })),
    };
    const runLocalIngest = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> =>
      completedLocalBundleRun(input, 'query-executor-run'),
    );

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'json',
        },
        io.io,
        {
          runLocalIngest,
          createAdapters: () => [],
          createQueryExecutor: () => queryExecutor,
        },
      ),
    ).resolves.toBe(0);

    expect(runLocalIngest).toHaveBeenCalledWith(expect.objectContaining({ queryExecutor }));
  });
```

- [ ] **Step 6: Run CLI query executor tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest-query-executor.test.ts src/ingest.test.ts -t "query executor"
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add \
  packages/cli/src/ingest-query-executor.ts \
  packages/cli/src/ingest-query-executor.test.ts \
  packages/cli/src/ingest.ts \
  packages/cli/src/ingest.test.ts
git commit -m "fix(cli): enable read-only SQL probes for local ingest"
```

### Task 5: Final verification

**Files:**
- Verify: all files changed by Tasks 1-4.

- [ ] **Step 1: Run focused context tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run \
  src/ingest/tools/warehouse-verification/warehouse-catalog.service.test.ts \
  src/ingest/tools/warehouse-verification/entity-details.tool.test.ts \
  src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  src/ingest/tools/warehouse-verification/sql-execution.tool.test.ts \
  src/ingest/local-bundle-runtime.test.ts \
  src/ingest/local-adapters.test.ts \
  src/ingest/adapters/lookml/lookml.adapter.test.ts \
  src/ingest/adapters/metricflow/metricflow.adapter.test.ts \
  src/ingest/ingest-bundle.runner.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused CLI tests**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/ingest-query-executor.test.ts src/ingest.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: both commands pass.

- [ ] **Step 4: Run pre-commit on changed files if configured**

Run:

```bash
uv run pre-commit run --files \
  packages/context/src/ingest/tools/warehouse-verification/warehouse-catalog.service.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.ts \
  packages/context/src/ingest/tools/warehouse-verification/discover-data.tool.test.ts \
  packages/context/src/ingest/adapters/lookml/lookml.adapter.ts \
  packages/context/src/ingest/adapters/lookml/lookml.adapter.test.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.ts \
  packages/context/src/ingest/adapters/metricflow/metricflow.adapter.test.ts \
  packages/context/src/ingest/local-adapters.ts \
  packages/context/src/ingest/local-adapters.test.ts \
  packages/context/src/ingest/local-bundle-runtime.ts \
  packages/context/src/ingest/local-bundle-runtime.test.ts \
  packages/context/src/ingest/local-ingest.ts \
  packages/cli/src/ingest-query-executor.ts \
  packages/cli/src/ingest-query-executor.test.ts \
  packages/cli/src/ingest.ts \
  packages/cli/src/ingest.test.ts \
  docs/superpowers/plans/2026-05-12-warehouse-verification-final-v1-closure.md
```

Expected: PASS. If the repository has no pre-commit config or the local `uv`
version cannot satisfy the configured toolchain, record the exact error and use
the focused test and type-check results as the closest verification.

- [ ] **Step 5: Commit final verification fixes if any were needed**

If verification required edits, run:

```bash
git add <changed-files>
git commit -m "test: cover warehouse verification v1 closure"
```

If verification required no edits, do not create an empty commit.

## Self-review

Spec coverage:

- Raw warehouse discovery still covers wiki, semantic-layer, and raw schema
  results, and now raw hits include the connection name needed by the required
  `entity_details` follow-up.
- Every local synthesis adapter with an external source connection now has a
  path to target warehouse IDs: dbt and Notion already had it, Looker resolves
  staged mappings, Metabase fan-out runs under target warehouse IDs, and this
  plan adds LookML and MetricFlow.
- `sql_execution` remains scoped by `allowedConnectionNames`, retains the
  read-only SQL wrapper, and gains a normal local ingest execution backend.

Placeholder scan:

- This plan contains no deferred implementation placeholders.
- Every code-changing step includes the exact test or implementation snippet to
  add.

Type consistency:

- `connectionName` is added to `RawSchemaHit` and used by `DiscoverDataTool`.
- `targetConnectionIds` and `listTargetConnectionIds()` match the existing dbt
  and Notion adapter pattern.
- Local ingest uses `KtxSqlQueryExecutorPort` consistently from CLI to context.
