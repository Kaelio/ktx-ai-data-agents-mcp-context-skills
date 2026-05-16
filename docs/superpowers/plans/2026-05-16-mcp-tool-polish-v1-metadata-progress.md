# MCP Tool Polish V1 Metadata and Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining v1-blocking MCP polish work after the surface
change: tool metadata, schemas, in-band errors, normalization, resolved-source
invariants, and progress notifications.

**Architecture:** Keep the 11-tool research surface already implemented. Add
metadata and output schemas through the shared `registerParsedTool` path, keep
runtime handlers small, and plumb progress as optional callbacks through the
MCP ports that execute work.

**Tech Stack:** TypeScript, Zod v4, MCP SDK 1.29, Vitest, pnpm workspace
commands.

---

## Audit summary

The original spec is
`docs/superpowers/specs/2026-05-16-mcp-tool-polish-design.md`.

Already implemented by
`docs/superpowers/plans/2026-05-16-mcp-tool-polish-v1-surface-change.md`:

- The MCP surface is reduced to 11 registered tools in
  `packages/context/src/mcp/context-tools.ts`.
- `memory_capture` and `memory_capture_status` are replaced by
  `memory_ingest` and `memory_ingest_status`.
- Memory ingest runs through `registerKtxContextTools`, so it shares the same
  registration path as the other retained tools.
- `packages/cli/src/skills/analytics/SKILL.md` uses `memory_ingest` and
  documents the multi-connection rule.
- `docs-site/content/docs/integrations/agent-clients.mdx` says memory ingest.

Remaining v1-blocking gaps covered by this plan:

- Add MCP tool annotations and `outputSchema` for all 11 retained tools.
- Add `.describe()` to every input field and rewrite tool descriptions with
  concrete argument examples.
- Move in-band runtime error wrapping into `registerParsedTool` and remove the
  local `sql_execution` catch.
- Normalize `sl_query.dimensions` Cube-style `{ dimension, granularity }`.
- Normalize `entity_details.entities[].table` SQL-style
  `{ schema, table }` into `{ catalog: null, db: schema, name: table }`.
- Type-narrow `jsonToolResult` so bare arrays do not type-check.
- Add the `toResolvedWire` invariant comment and narrow compute-port source
  types to resolved sources.
- Emit progress notifications for `sql_execution` and `sl_query` when the MCP
  request includes `_meta.progressToken`.

Non-blocking gaps left outside this plan:

- Delete admin tool implementation code after a future `ktx-admin` skill lands.
- MCP resources, MCP prompts, elicitation, sampling, tool icons, code execution,
  multi-tenancy, telemetry, and rate limiting.
- More exhaustive multi-client manual smoke beyond the automated in-memory MCP
  SDK coverage in this plan.

## File structure

- `packages/context/src/mcp/types.ts`: expand the local MCP server facade with
  output schemas, annotations, handler context, and progress callback types.
- `packages/context/src/mcp/context-tools.ts`: add output schemas, annotations,
  input descriptions, tool descriptions, centralized error wrapping,
  normalization, type-narrowed `jsonToolResult`, and progress callback wiring.
- `packages/context/src/mcp/server.test.ts`: add schema, annotation,
  normalization, in-band error, progress, and type-narrowing coverage.
- `packages/context/src/daemon/semantic-layer-compute.ts`: document and type
  the resolved-source invariant for daemon-backed semantic-layer calls.
- `packages/context/src/sl/local-query.ts`: accept an optional progress
  callback and emit semantic-layer query stages.
- `packages/context/src/mcp/local-project-ports.ts`: pass progress callbacks
  into `compileLocalSlQuery` and emit SQL execution stages.
- `packages/context/src/mcp/local-project-ports.test.ts`: verify local port
  progress stages.
- `packages/context/src/sl/local-query.test.ts`: verify compile and execution
  progress stages.

### Task 1: Add failing MCP metadata, schema, normalization, error, and progress tests

**Files:**

- Modify: `packages/context/src/mcp/server.test.ts`

- [ ] **Step 1: Update imports and fake server types**

In `packages/context/src/mcp/server.test.ts`, replace the import from
`./server.js` and the MCP type import with:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createDefaultKtxMcpServer, createKtxMcpServer } from './server.js';
import { jsonToolResult } from './context-tools.js';
import type {
  KtxDiscoverDataMcpPort,
  KtxDictionarySearchMcpPort,
  KtxEntityDetailsMcpPort,
  KtxKnowledgeMcpPort,
  KtxMcpContextPorts,
  KtxMcpToolHandlerContext,
  KtxSemanticLayerMcpPort,
  KtxSqlExecutionMcpPort,
  KtxSqlExecutionResponse,
  MemoryIngestPort,
} from './types.js';
```

Replace the `RegisteredTool` type with:

```typescript
type RegisteredTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema: unknown;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
  };
  handler: (input: Record<string, unknown>, context?: KtxMcpToolHandlerContext) => Promise<unknown>;
};
```

- [ ] **Step 2: Add shared test helpers**

After `getTool`, add:

```typescript
const retainedToolNames = [
  'connection_list',
  'dictionary_search',
  'discover_data',
  'entity_details',
  'memory_ingest',
  'memory_ingest_status',
  'sl_query',
  'sl_read_source',
  'sql_execution',
  'wiki_read',
  'wiki_search',
] as const;

function makeAllContextTools(): KtxMcpContextPorts {
  return {
    connections: {
      list: vi.fn().mockResolvedValue([{ id: 'warehouse', name: 'Warehouse', connectionType: 'POSTGRES' }]),
    },
    knowledge: {
      search: vi.fn<KtxKnowledgeMcpPort['search']>().mockResolvedValue({ results: [], totalFound: 0 }),
      read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue({
        key: 'revenue',
        summary: 'Paid order value',
        content: '# Revenue',
        scope: 'GLOBAL',
        tags: ['finance'],
        refs: [],
        slRefs: ['orders'],
      }),
    },
    semanticLayer: {
      readSource: vi.fn<KtxSemanticLayerMcpPort['readSource']>().mockResolvedValue({
        sourceName: 'orders',
        yaml: 'name: orders\n',
      }),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        sql: 'select 1',
        headers: ['count'],
        rows: [[1]],
        totalRows: 1,
        plan: { sources: ['orders'] },
      }),
    },
    entityDetails: {
      read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({ results: [] }),
    },
    dictionarySearch: {
      search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({ searched: [], results: [] }),
    },
    discover: {
      search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([]),
    },
    sqlExecution: {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue({
        headers: ['count'],
        headerTypes: ['integer'],
        rows: [[1]],
        rowCount: 1,
      }),
    },
    memoryIngest: {
      ingest: vi.fn<MemoryIngestPort['ingest']>().mockResolvedValue({ runId: 'run-1' }),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue({
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: [], sl: [], xrefs: [] },
        error: null,
        commitHash: null,
        skillsLoaded: [],
        signalDetected: false,
      }),
    },
  };
}

async function listToolsThroughSdk(contextTools: KtxMcpContextPorts) {
  const server = createDefaultKtxMcpServer({
    name: 'ktx-test',
    version: '0.0.0-test',
    userContext: { userId: 'mcp-user' },
    contextTools,
  });
  const client = new Client({ name: 'ktx-test-client', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}
```

- [ ] **Step 3: Add annotations and output schema assertions**

Inside `describe('createKtxMcpServer', () => {`, add:

```typescript
  it('registers annotations and output schemas for every retained tool', async () => {
    const fake = makeFakeServer();
    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: makeAllContextTools(),
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([...retainedToolNames].sort());

    const expectedAnnotations: Record<string, Record<string, unknown>> = {
      connection_list: { title: 'Connection List', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      discover_data: { title: 'Discover Data', readOnlyHint: true, openWorldHint: false },
      wiki_search: { title: 'Wiki Search', readOnlyHint: true, openWorldHint: false },
      wiki_read: { title: 'Wiki Read', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      entity_details: { title: 'Entity Details', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      dictionary_search: { title: 'Dictionary Search', readOnlyHint: true, openWorldHint: false },
      sl_read_source: {
        title: 'Semantic Layer Read Source',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      sl_query: { title: 'Semantic Layer Query', readOnlyHint: true, openWorldHint: false },
      sql_execution: { title: 'SQL Execution', readOnlyHint: true, openWorldHint: false },
      memory_ingest: { title: 'Memory Ingest', destructiveHint: true, openWorldHint: false },
      memory_ingest_status: { title: 'Memory Ingest Status', readOnlyHint: true, openWorldHint: false },
    };

    for (const toolName of retainedToolNames) {
      const tool = getTool(fake.tools, toolName);
      expect(tool.config.title).toBe(expectedAnnotations[toolName]?.title);
      expect(tool.config.annotations).toEqual(expectedAnnotations[toolName]);
      expect(tool.config.outputSchema).toBeDefined();
      const inputShape = tool.config.inputSchema as Record<string, { description?: string }>;
      for (const inputSchema of Object.values(inputShape)) {
        expect(inputSchema.description).toEqual(expect.any(String));
      }
    }
  });
```

- [ ] **Step 4: Add the SDK tools/list schema snapshot test**

Add:

```typescript
  it('exposes annotations and output schemas through the SDK tools/list response', async () => {
    const result = await listToolsThroughSdk(makeAllContextTools());
    const toolNames = result.tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual([...retainedToolNames].sort());

    await expect(result.tools).toMatchFileSnapshot('__snapshots__/mcp-tools-list.json');
  });
```

- [ ] **Step 5: Add normalization tests for the two remaining drift shapes**

Add:

```typescript
  it('sl_query normalizes cube-style dimensions to field dimensions', async () => {
    const fake = makeFakeServer();
    const semanticLayer = makeAllContextTools().semanticLayer!;

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    await getTool(fake.tools, 'sl_query').handler({
      connectionId: 'warehouse',
      measures: ['orders.count'],
      dimensions: [{ dimension: 'orders.created_at', granularity: 'month' }, 'orders.status'],
    });

    expect(semanticLayer.query).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        query: expect.objectContaining({
          dimensions: [{ field: 'orders.created_at', granularity: 'month' }, { field: 'orders.status' }],
        }),
      },
      undefined,
    );
  });

  it('entity_details normalizes sql-style schema table refs', async () => {
    const fake = makeFakeServer();
    const entityDetails = makeAllContextTools().entityDetails!;

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { entityDetails },
    });

    await getTool(fake.tools, 'entity_details').handler({
      connectionId: 'warehouse',
      entities: [{ table: { schema: 'public', table: 'orders' }, columns: ['id'] }],
    });

    expect(entityDetails.read).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      entities: [{ table: { catalog: null, db: 'public', name: 'orders' }, columns: ['id'] }],
    });
  });
```

- [ ] **Step 6: Add centralized runtime error wrapping tests**

Add:

```typescript
  it('wraps handler exceptions in-band for non-sql tools', async () => {
    const fake = makeFakeServer();
    const knowledge: KtxKnowledgeMcpPort = {
      search: vi.fn<KtxKnowledgeMcpPort['search']>().mockRejectedValue(new Error('wiki index unavailable')),
      read: vi.fn(),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { knowledge },
    });

    await expect(getTool(fake.tools, 'wiki_search').handler({ query: 'revenue' })).resolves.toEqual({
      content: [{ type: 'text', text: 'wiki index unavailable' }],
      isError: true,
    });
  });
```

- [ ] **Step 7: Add MCP progress notification tests**

Add:

```typescript
  it('wires sql_execution progress to MCP notifications when a progress token is present', async () => {
    const fake = makeFakeServer();
    const notifications: unknown[] = [];
    const sqlExecution: KtxSqlExecutionMcpPort = {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockImplementation(async (_input, options) => {
        await options?.onProgress?.({ progress: 0, message: 'Validating SQL' });
        await options?.onProgress?.({ progress: 0.3, message: 'Executing' });
        await options?.onProgress?.({ progress: 1, message: 'Fetched 1 rows' });
        return { headers: ['count'], rows: [[1]], rowCount: 1 };
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { sqlExecution },
    });

    await getTool(fake.tools, 'sql_execution').handler(
      { connectionId: 'warehouse', sql: 'select 1' },
      {
        _meta: { progressToken: 'progress-1' },
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      },
    );

    expect(notifications).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 0, message: 'Validating SQL' },
      },
      {
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 0.3, message: 'Executing' },
      },
      {
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 1, message: 'Fetched 1 rows' },
      },
    ]);
  });
```

- [ ] **Step 8: Add the compile-time array rejection assertion**

Add this test near the bottom of the describe block:

```typescript
  it('keeps jsonToolResult typed to non-array objects', () => {
    expect(jsonToolResult({ ok: true }).structuredContent).toEqual({ ok: true });

    if (false) {
      // @ts-expect-error bare arrays are not valid MCP structuredContent objects in KTX
      jsonToolResult([]);
    }
  });
```

- [ ] **Step 9: Run MCP tests and confirm they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts
```

Expected: FAIL with missing annotations, missing output schemas, missing
normalization, missing centralized error wrapping, missing progress callback
wiring, and a missing snapshot.

### Task 2: Implement MCP annotations, output schemas, descriptions, normalization, and in-band error wrapping

**Files:**

- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/context-tools.ts`
- Modify: `packages/context/src/mcp/server.test.ts`

- [ ] **Step 1: Extend MCP facade types**

In `packages/context/src/mcp/types.ts`, replace `KtxMcpToolResult`,
`KtxMcpServerLike`, `KtxSemanticLayerMcpPort`, and
`KtxSqlExecutionMcpPort` with:

```typescript
export type NonArrayObject = object & { length?: never };

export interface KtxMcpTextContent {
  type: 'text';
  text: string;
}

export interface KtxMcpToolResult<T extends NonArrayObject = NonArrayObject> {
  content: KtxMcpTextContent[];
  structuredContent?: T;
  isError?: true;
}

export interface KtxMcpProgressEvent {
  progress: number;
  total?: number;
  message: string;
}

export type KtxMcpProgressCallback = (event: KtxMcpProgressEvent) => void | Promise<void>;

export interface KtxMcpToolHandlerContext {
  _meta?: { progressToken?: string | number; [key: string]: unknown };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface KtxMcpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: unknown;
      outputSchema?: unknown;
      annotations?: Record<string, unknown>;
    },
    handler: (input: Record<string, unknown>, context?: KtxMcpToolHandlerContext) => Promise<unknown>,
  ): void;
}

export interface KtxSemanticLayerMcpPort {
  readSource(input: { connectionId: string; sourceName: string }): Promise<KtxSemanticLayerReadResponse | null>;
  query(
    input: { connectionId?: string; query: SemanticLayerQueryInput },
    options?: { onProgress?: KtxMcpProgressCallback },
  ): Promise<KtxSemanticLayerQueryResponse>;
}

export interface KtxSqlExecutionMcpPort {
  execute(
    input: { connectionId: string; sql: string; maxRows: number },
    options?: { onProgress?: KtxMcpProgressCallback },
  ): Promise<KtxSqlExecutionResponse>;
}
```

- [ ] **Step 2: Add output schemas and annotations**

In `packages/context/src/mcp/context-tools.ts`, add this import:

```typescript
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
```

Replace the MCP type import with:

```typescript
import type {
  KtxMcpContextPorts,
  KtxMcpProgressCallback,
  KtxMcpServerLike,
  KtxMcpToolHandlerContext,
  KtxMcpToolResult,
  KtxMcpUserContext,
  NonArrayObject,
} from './types.js';
```

After `const connectionIdSchema = z.string().min(1);`, add:

```typescript
const unknownRecordSchema = z.record(z.string(), z.unknown());
const tableRefSchema = z.object({
  catalog: z.string().nullable(),
  db: z.string().nullable(),
  name: z.string(),
});

const toolAnnotations = {
  connection_list: { title: 'Connection List', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  discover_data: { title: 'Discover Data', readOnlyHint: true, openWorldHint: false },
  wiki_search: { title: 'Wiki Search', readOnlyHint: true, openWorldHint: false },
  wiki_read: { title: 'Wiki Read', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  entity_details: { title: 'Entity Details', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  dictionary_search: { title: 'Dictionary Search', readOnlyHint: true, openWorldHint: false },
  sl_read_source: { title: 'Semantic Layer Read Source', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sl_query: { title: 'Semantic Layer Query', readOnlyHint: true, openWorldHint: false },
  sql_execution: { title: 'SQL Execution', readOnlyHint: true, openWorldHint: false },
  memory_ingest: { title: 'Memory Ingest', destructiveHint: true, openWorldHint: false },
  memory_ingest_status: { title: 'Memory Ingest Status', readOnlyHint: true, openWorldHint: false },
} satisfies Record<string, ToolAnnotations>;

const toolDescriptions = {
  connection_list:
    'List configured read-only data connections available to this KTX project. Use this before connection-scoped tools when the project may have multiple warehouses.',
  discover_data:
    'Search across KTX wiki pages, semantic-layer sources, measures, dimensions, raw tables, and columns. Example: discover_data({ query: "monthly orders by customer", connectionId: "warehouse", kinds: ["sl_source", "table"] }).',
  wiki_search:
    'Search KTX wiki pages for reusable business context. Example: wiki_search({ query: "revenue recognition", limit: 5 }).',
  wiki_read:
    'Read a KTX wiki page by key returned from wiki_search. Example: wiki_read({ key: "global/revenue" }).',
  entity_details:
    'Read table and column metadata from the latest live-database scan snapshot. Example: entity_details({ connectionId: "warehouse", entities: [{ table: { schema: "public", table: "orders" }, columns: ["id"] }] }).',
  dictionary_search:
    'Search profile-sampled warehouse values to locate likely source columns for business values. Example: dictionary_search({ values: ["Acme Corp"], connectionId: "warehouse" }).',
  sl_read_source:
    'Read a semantic-layer YAML source by connection id and source name. Example: sl_read_source({ connectionId: "warehouse", sourceName: "orders" }).',
  sl_query:
    'Execute a semantic-layer query and return rows, headers, generated SQL, and plan details. Example: sl_query({ connectionId: "warehouse", measures: ["orders.order_count"], dimensions: [{ dimension: "orders.created_at", granularity: "month" }] }).',
  sql_execution:
    'Execute one parser-validated read-only SQL query against a configured KTX connection. Example: sql_execution({ connectionId: "warehouse", sql: "select count(*) from public.orders", maxRows: 100 }).',
  memory_ingest:
    'Ingest free-form markdown knowledge into durable KTX memory. Use this for business rules, metric definitions, schema gotchas, recurring findings, or explicit user requests to remember something. Example: memory_ingest({ connectionId: "warehouse", content: "ARR is reported in cents in this warehouse." }).',
  memory_ingest_status:
    'Read the current or final status for a memory ingest run. Example: memory_ingest_status({ runId: "memory-run-1" }).',
} satisfies Record<string, string>;
```

After `memoryIngestStatusSchema`, add:

```typescript
const connectionListOutputSchema = z.object({
  connections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connectionType: z.string(),
    }),
  ),
});

const wikiSearchOutputSchema = z.object({
  results: z.array(
    z.object({
      key: z.string(),
      path: z.string(),
      scope: z.enum(['GLOBAL', 'USER']),
      summary: z.string(),
      score: z.number(),
      matchReasons: z.array(z.string()).optional(),
      lanes: z
        .array(
          z.object({
            lane: z.string(),
            status: z.string(),
            requestedCandidatePoolLimit: z.number(),
            effectiveCandidatePoolLimit: z.number(),
            returnedCandidateCount: z.number(),
            weight: z.number(),
            reason: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  totalFound: z.number(),
});

const wikiReadOutputSchema = z.object({
  key: z.string(),
  summary: z.string(),
  content: z.string(),
  scope: z.enum(['GLOBAL', 'USER']),
  tags: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  slRefs: z.array(z.string()).optional(),
});

const slReadSourceOutputSchema = z.object({
  sourceName: z.string(),
  yaml: z.string(),
});

const slQueryOutputSchema = z.object({
  connectionId: z.string().optional(),
  dialect: z.string().optional(),
  sql: z.string(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  totalRows: z.number(),
  plan: unknownRecordSchema.optional(),
});

const entityDetailsSnapshotOutputSchema = z.object({
  syncId: z.string(),
  extractedAt: z.string(),
  scanRunId: z.string().nullable(),
});

const entityDetailsColumnOutputSchema = z.object({
  name: z.string(),
  nativeType: z.string(),
  normalizedType: z.string(),
  dimensionType: z.enum(['time', 'string', 'number', 'boolean']),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  comment: z.string().nullable(),
});

const entityDetailsForeignKeyOutputSchema = z.object({
  fromColumn: z.string(),
  toCatalog: z.string().nullable(),
  toDb: z.string().nullable(),
  toTable: z.string(),
  toColumn: z.string(),
  constraintName: z.string().nullable(),
});

const entityDetailsOutputSchema = z.object({
  results: z.array(
    z.union([
      z.object({
        ok: z.literal(true),
        connectionId: z.string(),
        tableRef: tableRefSchema,
        display: z.string(),
        kind: z.enum(['table', 'view', 'external', 'event_stream']),
        comment: z.string().nullable(),
        estimatedRows: z.number().nullable(),
        columns: z.array(entityDetailsColumnOutputSchema),
        foreignKeys: z.array(entityDetailsForeignKeyOutputSchema),
        snapshot: entityDetailsSnapshotOutputSchema,
      }),
      z.object({
        ok: z.literal(false),
        connectionId: z.string(),
        table: z.union([z.string(), tableRefSchema]),
        snapshot: entityDetailsSnapshotOutputSchema.optional(),
        error: z.object({
          code: z.enum(['scan_missing', 'table_not_found', 'ambiguous_table', 'column_not_found']),
          message: z.string(),
          candidates: z.union([z.array(z.object({ tableRef: tableRefSchema, display: z.string() })), z.array(z.string())]).optional(),
        }),
      }),
    ]),
  ),
});

const dictionarySearchOutputSchema = z.object({
  searched: z.array(
    z.object({
      connectionId: z.string(),
      coverage: z.object({
        sampledRows: z.number().nullable(),
        valuesPerColumn: z.number().nullable(),
        profiledColumns: z.number(),
        syncId: z.string().nullable(),
        profiledAt: z.string().nullable(),
      }),
      status: z.enum(['ready', 'no_profile_artifact', 'no_candidate_columns']),
    }),
  ),
  results: z.array(
    z.object({
      value: z.string(),
      matches: z.array(
        z.object({
          connectionId: z.string(),
          sourceName: z.string(),
          columnName: z.string(),
          matchedValue: z.string(),
          cardinality: z.number().nullable(),
        }),
      ),
      misses: z.array(
        z.object({
          connectionId: z.string(),
          reason: z.enum(['no_profile_artifact', 'no_candidate_columns', 'value_not_in_sample']),
        }),
      ),
    }),
  ),
});

const discoverDataOutputSchema = z.object({
  refs: z.array(
    z.object({
      kind: discoverDataKindSchema,
      id: z.string(),
      score: z.number(),
      summary: z.string().nullable(),
      snippet: z.string().nullable(),
      matchedOn: z.enum(['name', 'display', 'description', 'comment', 'expr', 'sample_value', 'body']),
      connectionId: z.string().optional(),
      tableRef: tableRefSchema.optional(),
      columnName: z.string().optional(),
    }),
  ),
});

const sqlExecutionOutputSchema = z.object({
  headers: z.array(z.string()),
  headerTypes: z.array(z.string()).optional(),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number(),
});

const memoryIngestOutputSchema = z.object({
  runId: z.string(),
});

const memoryIngestStatusOutputSchema = z.object({
  runId: z.string(),
  status: z.enum(['running', 'done', 'error']),
  stage: z.string(),
  done: z.boolean(),
  captured: z.object({
    wiki: z.array(z.string()),
    sl: z.array(z.string()),
    xrefs: z.array(z.string()),
  }),
  error: z.string().nullable(),
  commitHash: z.string().nullable(),
  skillsLoaded: z.array(z.string()),
  signalDetected: z.boolean(),
});
```

- [ ] **Step 3: Replace input schemas with described and normalized versions**

In `context-tools.ts`, replace the input schema section from
`connectionListSchema` through `entityDetailsSchema` with:

```typescript
const connectionListSchema = z.object({});

const knowledgeSearchSchema = z.object({
  query: z.string().min(1).describe('Natural-language wiki search query, e.g. "revenue recognition policy".'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum wiki pages to return. Defaults to 10.'),
});

const knowledgeReadSchema = z.object({
  key: z.string().min(1).describe('Wiki page key returned by wiki_search, e.g. "global/revenue".'),
});

const slReadSourceSchema = z.object({
  connectionId: connectionIdSchema.describe('Connection id that owns the semantic-layer source.'),
  sourceName: z.string().min(1).describe('Semantic-layer source name without ".yaml", e.g. "orders".'),
});

const slQueryMeasureSchema = z.union([
  z.string().describe('Semantic-layer measure key, e.g. "orders.order_count".'),
  z.object({
    expr: z.string().min(1).describe('Ad hoc aggregate expression, e.g. "sum(orders.amount)".'),
    name: z.string().min(1).describe('Alias for the ad hoc measure, e.g. "gross_revenue".'),
  }),
]);

const slQueryDimensionSchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') return { field: value };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = { ...(value as Record<string, unknown>) };
      if (!('field' in obj) && typeof obj.dimension === 'string') obj.field = obj.dimension;
      return obj;
    }
    return value;
  },
  z.object({
    field: z.string().min(1).describe('Dimension to group by, e.g. "orders.created_at" or "orders.status".'),
    granularity: z.string().min(1).optional().describe('Time grain for time dimensions: day, week, month, quarter, or year.'),
  }),
);
```

Keep the existing `slQueryOrderBySchema` preprocess and replace
`slQuerySchema` plus `entityDetailsTableRefSchema` with:

```typescript
const slQuerySchema = z.object({
  connectionId: connectionIdSchema
    .optional()
    .describe('Connection id to query. Omit only when the project has exactly one configured connection.'),
  measures: z.array(slQueryMeasureSchema).min(1).describe('Measures to select. Use semantic-layer keys when available.'),
  dimensions: z.array(slQueryDimensionSchema).default([]).describe('Dimensions to group by. Strings and {dimension, granularity} are accepted.'),
  filters: z.array(z.string().describe('Semantic-layer filter expression, e.g. "orders.status = paid".')).default([]),
  segments: z.array(z.string().describe('Semantic-layer segment key to apply.')).default([]),
  order_by: z.array(slQueryOrderBySchema).default([]).describe('Sort clauses. Strings and Cube-style {id, desc} are accepted.'),
  limit: z.number().int().min(0).default(1000).describe('Maximum rows to return. Defaults to 1000.'),
  include_empty: z.boolean().default(true).describe('Whether to include empty dimension groups. Defaults to true.'),
});

const entityDetailsTableRefSchema = z.preprocess(
  (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = { ...(value as Record<string, unknown>) };
      if (!('db' in obj) && typeof obj.schema === 'string') obj.db = obj.schema;
      if (!('name' in obj) && typeof obj.table === 'string') obj.name = obj.table;
      if (!('catalog' in obj)) obj.catalog = null;
      return obj;
    }
    return value;
  },
  z.object({
    catalog: z.string().nullable().describe('Catalog/project/database. Use null when not applicable.'),
    db: z.string().nullable().describe('Schema/database/dataset. Use null when not applicable.'),
    name: z.string().min(1).describe('Table name.'),
  }),
);

const entityDetailsSchema = z.object({
  connectionId: connectionIdSchema.describe('Connection id whose latest scan snapshot should be read.'),
  entities: z
    .array(
      z.object({
        table: z
          .union([z.string().min(1), entityDetailsTableRefSchema])
          .describe('Table display string or object ref. {schema, table} is accepted as an alias for {db, name}.'),
        columns: z.array(z.string().min(1).describe('Column name to inspect.')).optional().describe('Optional column filter.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('Tables or columns to inspect. Maximum 20 entities.'),
});
```

Replace `dictionarySearchSchema`, `discoverDataSchema`, and
`sqlExecutionSchema` with:

```typescript
const dictionarySearchSchema = z.object({
  values: z
    .array(z.string().min(1).describe('Business value to locate, e.g. "Acme Corp" or "enterprise".'))
    .min(1)
    .max(20)
    .describe('Values to search for in sampled warehouse dictionaries.'),
  connectionId: connectionIdSchema
    .optional()
    .describe('Optional connection id. Pass it when user intent pins a specific warehouse.'),
});

const discoverDataKindSchema = z.enum(['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column']);

const discoverDataSchema = z.object({
  query: z.string().min(1).describe('Natural-language discovery query, e.g. "monthly orders by customer".'),
  connectionId: connectionIdSchema
    .optional()
    .describe('Optional connection id. Pass it when user intent pins a specific warehouse.'),
  kinds: z.array(discoverDataKindSchema.describe('Reference kind to include.')).optional().describe('Optional kind filter.'),
  limit: z.number().int().min(1).max(50).default(15).optional().describe('Maximum refs to return. Defaults to 15.'),
});

const sqlExecutionSchema = z.object({
  connectionId: connectionIdSchema.describe('Connection id to execute against. Required for raw SQL.'),
  sql: z.string().min(1).describe('Parser-validated read-only SQL, e.g. "select count(*) from public.orders".'),
  maxRows: z.number().int().min(1).max(10_000).default(1000).optional().describe('Maximum rows to return. Defaults to 1000.'),
});
```

- [ ] **Step 4: Replace `jsonToolResult`, `formatToolError`, and `registerParsedTool`**

Replace `jsonToolResult`, `jsonErrorToolResult`, and `registerParsedTool`
with:

```typescript
export function jsonToolResult<T extends NonArrayObject>(structuredContent: T): KtxMcpToolResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function jsonErrorToolResult(text: string): KtxMcpToolResult<Record<string, never>> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function formatToolError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function mcpProgressCallback(context?: KtxMcpToolHandlerContext): KtxMcpProgressCallback | undefined {
  const progressToken = context?._meta?.progressToken;
  if (progressToken === undefined || !context?.sendNotification) {
    return undefined;
  }
  return async (event) => {
    await context.sendNotification?.({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: event.progress,
        ...(event.total !== undefined ? { total: event.total } : {}),
        message: event.message,
      },
    });
  };
}

function registerParsedTool<TSchema extends z.ZodType>(
  server: KtxMcpServerLike,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: unknown;
    outputSchema: unknown;
    annotations: ToolAnnotations;
  },
  schema: TSchema,
  handler: (input: z.infer<TSchema>, context?: KtxMcpToolHandlerContext) => Promise<KtxMcpToolResult>,
): void {
  server.registerTool(name, config, async (input, context) => {
    try {
      return await handler(schema.parse(input), context);
    } catch (error) {
      return jsonErrorToolResult(formatToolError(error));
    }
  });
}
```

- [ ] **Step 5: Update every registration config**

For each `registerParsedTool` call, add `annotations` and `outputSchema`.
For example, replace the `connection_list` config with:

```typescript
      {
        title: toolAnnotations.connection_list.title!,
        description: toolDescriptions.connection_list,
        inputSchema: connectionListSchema.shape,
        outputSchema: connectionListOutputSchema,
        annotations: toolAnnotations.connection_list,
      },
```

Use these exact output schemas:

```typescript
connection_list -> connectionListOutputSchema
wiki_search -> wikiSearchOutputSchema
wiki_read -> wikiReadOutputSchema
sl_read_source -> slReadSourceOutputSchema
sl_query -> slQueryOutputSchema
entity_details -> entityDetailsOutputSchema
dictionary_search -> dictionarySearchOutputSchema
discover_data -> discoverDataOutputSchema
sql_execution -> sqlExecutionOutputSchema
memory_ingest -> memoryIngestOutputSchema
memory_ingest_status -> memoryIngestStatusOutputSchema
```

Use `toolAnnotations.<tool_name>` and `toolDescriptions.<tool_name>` for the
matching tool.

- [ ] **Step 6: Remove the local sql_execution catch and wire progress callbacks**

Replace the `sql_execution` handler with:

```typescript
      async (input, context) => {
        const onProgress = mcpProgressCallback(context);
        return jsonToolResult(
          await sqlExecution.execute(
            {
              connectionId: input.connectionId,
              sql: input.sql,
              maxRows: input.maxRows ?? 1000,
            },
            onProgress ? { onProgress } : undefined,
          ),
        );
      },
```

Replace the `sl_query` handler with:

```typescript
      async (input, context) => {
        const onProgress = mcpProgressCallback(context);
        return jsonToolResult(
          await semanticLayer.query(
            {
              connectionId: input.connectionId,
              query: {
                measures: input.measures,
                dimensions: input.dimensions,
                filters: input.filters,
                segments: input.segments,
                order_by: input.order_by,
                limit: input.limit,
                include_empty: input.include_empty,
              },
            },
            onProgress ? { onProgress } : undefined,
          ),
        );
      },
```

- [ ] **Step 7: Run MCP tests and update the snapshot**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -u
```

Expected: PASS. The new snapshot file is created at
`packages/context/src/mcp/__snapshots__/mcp-tools-list.json`.

- [ ] **Step 8: Commit**

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/__snapshots__/mcp-tools-list.json
git commit -m "feat(context): polish mcp tool metadata"
```

### Task 3: Enforce resolved semantic-layer compute sources

**Files:**

- Modify: `packages/context/src/daemon/semantic-layer-compute.ts`
- Modify: `packages/context/src/sl/local-query.ts`

- [ ] **Step 1: Narrow compute port source types and add invariant comments**

In `packages/context/src/daemon/semantic-layer-compute.ts`, replace the import
from `../sl/index.js` with:

```typescript
import type { ResolvedSemanticLayerSource, SemanticLayerQueryInput } from '../sl/types.js';
```

Replace the `query` and `validateSources` signatures in
`KtxSemanticLayerComputePort` with:

```typescript
  /**
   * Callers must pass sources sanitized through toResolvedWire. The Python
   * daemon rejects authoring-only fields such as usage and inherits_columns_from.
   */
  query(input: {
    sources: ResolvedSemanticLayerSource[];
    query: SemanticLayerQueryInput;
    dialect: string;
  }): Promise<KtxSemanticLayerComputeQueryResult>;

  /**
   * Callers must pass sources sanitized through toResolvedWire. The Python
   * daemon rejects authoring-only fields such as usage and inherits_columns_from.
   */
  validateSources(input: {
    sources: ResolvedSemanticLayerSource[];
    dialect: string;
    recentlyTouched?: string[];
  }): Promise<KtxSemanticLayerComputeValidationResult>;
```

- [ ] **Step 2: Remove the unnecessary cast in local query loading**

In `packages/context/src/sl/local-query.ts`, replace `loadComputableSources`
with:

```typescript
async function loadComputableSources(
  project: KtxLocalProject,
  connectionId: string,
): Promise<ReturnType<typeof toResolvedWire>[]> {
  return (await loadLocalSlSourceRecords(project, { connectionId: assertSafeConnectionId(connectionId) }))
    .filter((record) => record.source.table || record.source.sql)
    .map((record) => toResolvedWire(record.source));
}
```

- [ ] **Step 3: Run type-check and relevant semantic-layer tests**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/context exec vitest run src/sl/local-query.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/context/src/daemon/semantic-layer-compute.ts packages/context/src/sl/local-query.ts
git commit -m "fix(context): enforce resolved semantic layer compute sources"
```

### Task 4: Add local progress stages for sl_query and sql_execution

**Files:**

- Modify: `packages/context/src/sl/local-query.ts`
- Modify: `packages/context/src/sl/local-query.test.ts`
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Add failing local-query progress tests**

In `packages/context/src/sl/local-query.test.ts`, add a test that calls
`compileLocalSlQuery` with execution enabled and captures events:

```typescript
  it('emits progress while compiling and executing a local semantic-layer query', async () => {
    const progress: Array<{ progress: number; message: string }> = [];
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['status', 'order_count'],
        rows: [['paid', 2]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const result = await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
      compute,
      execute: true,
      maxRows: 10,
      queryExecutor,
      onProgress: (event) => progress.push({ progress: event.progress, message: event.message }),
    });

    expect(result.totalRows).toBe(1);
    expect(progress).toEqual([
      { progress: 0, message: 'Compiling query' },
      { progress: 0.3, message: 'Generating SQL' },
      { progress: 0.6, message: 'Executing' },
      { progress: 1, message: 'Fetched 1 rows' },
    ]);
  });
```

- [ ] **Step 2: Implement local-query progress**

In `packages/context/src/sl/local-query.ts`, import the progress type:

```typescript
import type { KtxMcpProgressCallback } from '../mcp/types.js';
```

Add the option:

```typescript
  onProgress?: KtxMcpProgressCallback;
```

In `compileLocalSlQuery`, emit stages in this order:

```typescript
  await options.onProgress?.({ progress: 0, message: 'Compiling query' });
  const connectionId = resolveLocalConnectionId(project, options.connectionId);
  const dialect = dialectForDriver(project.config.connections[connectionId]?.driver);
  const sources = await loadComputableSources(project, connectionId);

  await options.onProgress?.({ progress: 0.3, message: 'Generating SQL' });
  const response = await options.compute.query({
    sources,
    dialect,
    query: options.query,
  });
```

Before the query-executor call, add:

```typescript
  await options.onProgress?.({ progress: 0.6, message: 'Executing' });
```

After the query-executor call, add:

```typescript
  await options.onProgress?.({ progress: 1, message: `Fetched ${execution.totalRows} rows` });
```

In the compile-only branch, before returning, add:

```typescript
    await options.onProgress?.({ progress: 1, message: 'Fetched 0 rows' });
```

- [ ] **Step 3: Add failing local SQL execution progress test**

In `packages/context/src/mcp/local-project-ports.test.ts`, add:

```typescript
  it('emits sql_execution progress stages from local MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const createConnector = vi.fn(async () => connector);
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const progress: Array<{ progress: number; message: string }> = [];
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: {
        createConnector,
      },
    });

    const result = await ports.sqlExecution?.execute(
      { connectionId: 'warehouse', sql: 'select id from public.orders', maxRows: 5 },
      { onProgress: (event) => progress.push({ progress: event.progress, message: event.message }) },
    );

    expect(result?.rowCount).toBe(1);
    expect(progress).toEqual([
      { progress: 0, message: 'Validating SQL' },
      { progress: 0.3, message: 'Executing' },
      { progress: 1, message: 'Fetched 1 rows' },
    ]);
  });
```

- [ ] **Step 4: Implement local SQL execution progress**

In `packages/context/src/mcp/local-project-ports.ts`, import the progress type:

```typescript
import type { KtxMcpContextPorts, KtxMcpProgressCallback, KtxSqlExecutionResponse } from './types.js';
```

Change `executeValidatedReadOnlySql` to accept progress:

```typescript
async function executeValidatedReadOnlySql(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
  input: { connectionId: string; sql: string; maxRows: number },
  onProgress?: KtxMcpProgressCallback,
): Promise<KtxSqlExecutionResponse> {
```

At the start of the function, add:

```typescript
  await onProgress?.({ progress: 0, message: 'Validating SQL' });
```

Immediately before `connector.executeReadOnly`, add:

```typescript
    await onProgress?.({ progress: 0.3, message: 'Executing' });
```

Replace the direct return with:

```typescript
    const response = {
      headers: result.headers,
      ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
    await onProgress?.({ progress: 1, message: `Fetched ${response.rowCount} rows` });
    return response;
```

Pass progress through the port:

```typescript
      async execute(input, executionOptions) {
        return executeValidatedReadOnlySql(project, options, input, executionOptions?.onProgress);
      },
```

Pass semantic-layer progress through:

```typescript
        return compileLocalSlQuery(project, {
          connectionId: input.connectionId,
          query: input.query,
          compute: options.semanticLayerCompute,
          execute: Boolean(options.queryExecutor),
          maxRows: input.query.limit,
          queryExecutor: options.queryExecutor,
          onProgress: executionOptions?.onProgress,
        });
```

- [ ] **Step 5: Run local progress tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/local-query.test.ts src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/context/src/sl/local-query.ts packages/context/src/sl/local-query.test.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat(context): emit mcp query progress stages"
```

### Task 5: Final verification

**Files:**

- Verify: TypeScript workspace checks.

- [ ] **Step 1: Run context tests**

Run:

```bash
pnpm --filter @ktx/context run test
pnpm --filter @ktx/context run test:slow
```

Expected: PASS.

- [ ] **Step 2: Run type-checks**

Run:

```bash
pnpm --filter @ktx/context run type-check
pnpm --filter @ktx/cli run type-check
```

Expected: PASS.

- [ ] **Step 3: Run CLI tests**

Run:

```bash
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 4: Run dead-code checks**

Run:

```bash
pnpm run dead-code
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/daemon/semantic-layer-compute.ts packages/context/src/sl/local-query.ts packages/context/src/sl/local-query.test.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
```

Expected: only intended MCP polish and progress files are changed.
