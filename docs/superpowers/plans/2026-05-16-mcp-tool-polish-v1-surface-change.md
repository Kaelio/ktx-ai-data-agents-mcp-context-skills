# MCP Tool Polish V1 Surface Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the atomic MCP surface change from the MCP tool polish spec:
retain only the research-loop tools, replace `memory_capture` with
`memory_ingest`, and update the installed analytics skill in the same change.

**Architecture:** Keep the existing context, memory, and CLI services, but make
the MCP server register only the v1 research surface. Move memory ingest into
`registerKtxContextTools` so the next polish plan can apply annotations,
`outputSchema`, descriptions, and in-band error handling through one path.

**Tech Stack:** TypeScript, Zod, MCP SDK, Vitest, pnpm workspace commands.

---

## Audit summary

The original spec is
`docs/superpowers/specs/2026-05-16-mcp-tool-polish-design.md`.

Implemented before this plan:

- `discover_data` already returns an object shape:
  `jsonToolResult({ refs: await discover.search(input) })`.
- `sl_query.order_by` already accepts bare strings and Cube-style
  `{ id, desc }` objects through `z.preprocess`.
- The local `sl_query` path already sanitizes sources with `toResolvedWire`.

Remaining v1 blockers:

- The MCP server still registers the broad admin surface:
  `connection_test`, `wiki_write`, `sl_list_sources`, `sl_write_source`,
  `sl_validate`, `ingest_*`, and `scan_*`.
- The MCP memory tools are still `memory_capture` and
  `memory_capture_status`, with `userMessage` and `assistantMessage` input.
- Memory tools are still registered directly in `server.ts`, bypassing
  `registerParsedTool`.
- The analytics skill and agent client docs still say "memory capture."

Remaining v1 blockers after this plan:

- Per-tool polish kit: annotations, `outputSchema`, input field
  descriptions, long tool descriptions, in-band error wrapping, union-drift
  normalization, `jsonToolResult` type narrowing, and `toResolvedWire`
  invariant enforcement for `validateSources`.
- Progress notifications for `sql_execution` and `sl_query`.

Non-blocking items from the spec:

- Deleting admin tool implementation code after a future `ktx-admin` skill
  lands.
- MCP resources, MCP prompts, elicitation, sampling, tool icons, code
  execution, multi-tenancy, telemetry, and rate limiting.
- Error-message redaction for `formatToolError`, which belongs to the polish
  kit plan.

## File structure

- `packages/context/src/memory/memory-runs.ts`: rename the memory run service
  API from capture to ingest with no compatibility wrapper.
- `packages/context/src/memory/local-memory.ts`: rename the local factory to
  `createLocalProjectMemoryIngest`.
- `packages/context/src/memory/index.ts`: re-export the new memory ingest
  names only.
- `packages/context/src/mcp/types.ts`: rename `MemoryCapturePort` to
  `MemoryIngestPort`, add `memoryIngest` to `KtxMcpContextPorts`, and remove
  MCP context ports for removed admin tool families.
- `packages/context/src/mcp/context-tools.ts`: remove removed tool
  registrations and register `memory_ingest` plus `memory_ingest_status`.
- `packages/context/src/mcp/server.ts`: delete direct memory tool
  registration and route all tools through `registerKtxContextTools`.
- `packages/context/src/mcp/local-project-ports.ts`: stop assembling MCP
  ports for removed admin tools.
- `packages/cli/src/mcp-server-factory.ts`: create the local memory ingest
  port and include it in `contextTools.memoryIngest`.
- `packages/cli/src/text-ingest.ts`: rename CLI text ingest dependency names
  from capture to ingest while preserving behavior.
- `packages/cli/src/skills/analytics/SKILL.md`: replace memory capture
  guidance with memory ingest guidance and add multi-connection routing.
- `docs-site/content/docs/integrations/agent-clients.mdx`: replace the
  existing memory capture wording.
- Tests:
  `packages/context/src/mcp/server.test.ts`,
  `packages/context/src/memory/memory-runs.test.ts`,
  `packages/context/src/memory/local-memory.test.ts`,
  `packages/cli/src/text-ingest.test.ts`,
  `packages/cli/src/setup-agents.test.ts`.

### Task 1: Lock the new MCP surface with failing tests

**Files:**

- Modify: `packages/context/src/mcp/server.test.ts`

- [ ] **Step 1: Update the imports for new memory names**

In `packages/context/src/mcp/server.test.ts`, replace the memory imports at
the top with:

```typescript
import {
  createLocalProjectMemoryIngest,
  detectCaptureSignals,
  type MemoryAgentInput,
} from '../memory/index.js';
```

In the MCP type import from `./types.js`, replace `MemoryCapturePort` with
`MemoryIngestPort`:

```typescript
import type {
  KtxDiscoverDataMcpPort,
  KtxDictionarySearchMcpPort,
  KtxEntityDetailsMcpPort,
  KtxKnowledgeMcpPort,
  KtxMcpContextPorts,
  KtxSemanticLayerMcpPort,
  KtxSqlExecutionMcpPort,
  KtxSqlExecutionResponse,
  MemoryIngestPort,
} from './types.js';
```

- [ ] **Step 2: Replace the standalone memory capture test**

Replace the test named
`registers memory capture tools without host app dependencies` with this test:

```typescript
  it('registers memory ingest tools through the context tool surface', async () => {
    const fake = makeFakeServer();
    let receivedInput: MemoryAgentInput | undefined;
    const ingest: MemoryIngestPort = {
      ingest: vi.fn<MemoryIngestPort['ingest']>().mockImplementation(async (input) => {
        receivedInput = input;
        return { runId: 'run-1' };
      }),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue({
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: ['revenue'], sl: [], xrefs: [] },
        error: null,
        commitHash: 'abc123',
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: { memoryIngest: ingest },
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
      'memory_ingest',
      'memory_ingest_status',
    ]);

    const content = [
      'view: orders {',
      '  sql_table_name: public.orders ;;',
      '  measure: gross_revenue {',
      '    type: sum',
      '    sql: ${TABLE}.gross_revenue_cents ;;',
      '  }',
      '}',
    ].join('\n');
    const memoryIngest = getTool(fake.tools, 'memory_ingest');
    await expect(
      memoryIngest.handler({
        content,
        connectionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ runId: 'run-1' }, null, 2) }],
      structuredContent: { runId: 'run-1' },
    });
    expect(ingest.ingest).toHaveBeenCalledWith({
      userId: 'mcp-user',
      chatId: expect.stringMatching(/^mcp-/),
      userMessage: 'Ingest external knowledge into KTX memory.',
      assistantMessage: content,
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    });

    const cliEquivalentInput: MemoryAgentInput = {
      userId: 'mcp-user',
      chatId: 'cli-text-ingest-test-1',
      userMessage: 'Ingest external text artifact "orders lookml" into KTX memory.',
      assistantMessage: content,
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    };
    expect(detectCaptureSignals(receivedInput!)).toEqual(detectCaptureSignals(cliEquivalentInput));

    const memoryStatus = getTool(fake.tools, 'memory_ingest_status');
    await expect(memoryStatus.handler({ runId: 'run-1' })).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              runId: 'run-1',
              status: 'done',
              stage: 'done',
              done: true,
              captured: { wiki: ['revenue'], sl: [], xrefs: [] },
              error: null,
              commitHash: 'abc123',
              skillsLoaded: ['wiki_capture'],
              signalDetected: true,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: ['revenue'], sl: [], xrefs: [] },
        error: null,
        commitHash: 'abc123',
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
      },
    });
  });
```

- [ ] **Step 3: Replace the missing memory run test**

Replace the test that looks up `memory_capture_status` for a missing run with:

```typescript
  it('returns an in-band error when a memory ingest run is missing', async () => {
    const fake = makeFakeServer();
    const ingest: MemoryIngestPort = {
      ingest: vi.fn<MemoryIngestPort['ingest']>(),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue(null),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: { memoryIngest: ingest },
    });

    const memoryStatus = getTool(fake.tools, 'memory_ingest_status');
    await expect(memoryStatus.handler({ runId: 'missing-run' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Memory ingest run "missing-run" was not found.' }],
      isError: true,
    });
  });
```

- [ ] **Step 4: Update the local project MCP memory test**

Rename the test `runs MCP memory_capture against a local project memory port`
to `runs MCP memory_ingest against a local project memory port`.

Inside that test, rename the factory call and handler calls:

```typescript
      const memoryIngest = createLocalProjectMemoryIngest(project, {
        agentRunner,
        llmProvider,
        runIdFactory: () => 'memory-run-mcp',
      });

      createKtxMcpServer({
        server: fake.server,
        userContext: { userId: 'local' },
        contextTools: { memoryIngest },
      });

      const capture = await getTool(fake.tools, 'memory_ingest').handler({
        content: 'Revenue means paid order value.',
        connectionId: 'warehouse',
      });

      await memoryIngest.waitForRun('memory-run-mcp');
      const status = await getTool(fake.tools, 'memory_ingest_status').handler({
        runId: 'memory-run-mcp',
      });
```

Keep the existing wiki assertion in the test. Update its expected memory-agent
input to use:

```typescript
{
  userId: 'local',
  chatId: expect.stringMatching(/^mcp-/),
  userMessage: 'Ingest external knowledge into KTX memory.',
  assistantMessage: 'Revenue means paid order value.',
  connectionId: 'warehouse',
  sourceType: 'external_ingest',
}
```

- [ ] **Step 5: Update the full-surface registration assertion**

In the large registration test, replace the expected tool-name list with the
retained v1 list:

```typescript
    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
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
    ]);
```

Delete assertions that call removed tools:
`connection_test`, `wiki_write`, `sl_list_sources`, `sl_write_source`,
`sl_validate`, `ingest_trigger`, `ingest_status`, `ingest_report`,
`ingest_replay`, `scan_trigger`, `scan_status`, `scan_report`,
`scan_list_artifacts`, and `scan_read_artifact`.

- [ ] **Step 6: Run the MCP tests and confirm they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t "memory ingest|registers all available"
```

Expected: FAIL. The current implementation still registers `memory_capture`,
accepts `userMessage` and `assistantMessage`, and exposes removed admin tools.

### Task 2: Rename memory capture internals to memory ingest

**Files:**

- Modify: `packages/context/src/memory/memory-runs.ts`
- Modify: `packages/context/src/memory/memory-runs.test.ts`
- Modify: `packages/context/src/memory/local-memory.ts`
- Modify: `packages/context/src/memory/local-memory.test.ts`
- Modify: `packages/context/src/memory/index.ts`

- [ ] **Step 1: Update memory run tests to the new API**

In `packages/context/src/memory/memory-runs.test.ts`, replace the import with:

```typescript
import { MemoryIngestService, type MemoryRunStorePort } from './memory-runs.js';
```

Replace `MemoryCaptureService` with `MemoryIngestService`, rename local
variables from `capture` to `ingest`, and replace `.capture(` calls with
`.ingest(` calls. The shared test setup type becomes:

```typescript
let ingest: MemoryIngestService;
```

The service construction becomes:

```typescript
ingest = new MemoryIngestService({ memoryAgent, runs: store });
```

- [ ] **Step 2: Update local memory tests to the new factory**

In `packages/context/src/memory/local-memory.test.ts`, replace the import with:

```typescript
import { createLocalProjectMemoryIngest } from './local-memory.js';
```

Rename the describe block to:

```typescript
describe('createLocalProjectMemoryIngest', () => {
```

Replace `createLocalProjectMemoryCapture(` with
`createLocalProjectMemoryIngest(` and replace local variables named `capture`
with `ingest`.

- [ ] **Step 3: Run the renamed memory tests and confirm they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runs.test.ts src/memory/local-memory.test.ts
```

Expected: FAIL with missing exports and missing `.ingest()` method.

- [ ] **Step 4: Rename the memory run service**

In `packages/context/src/memory/memory-runs.ts`, replace the capture-specific
type and class declarations with:

```typescript
export interface MemoryIngestServiceDeps {
  memoryAgent: Pick<MemoryAgentService, 'ingest'>;
  runs: MemoryRunStorePort;
}

export interface MemoryIngestStartResult {
  runId: string;
}

export interface MemoryIngestStatus {
  runId: string;
  status: MemoryRunStatus;
  stage: string;
  done: boolean;
  captured: {
    wiki: string[];
    sl: string[];
    xrefs: string[];
  };
  error: string | null;
  commitHash: string | null;
  skillsLoaded: string[];
  signalDetected: boolean;
}
```

Update `capturedKeys` to return the renamed status type:

```typescript
function capturedKeys(actions: MemoryAction[]): MemoryIngestStatus['captured'] {
```

Replace the class with:

```typescript
export class MemoryIngestService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: MemoryIngestServiceDeps) {}

  async ingest(input: MemoryAgentInput): Promise<MemoryIngestStartResult> {
    const row = await this.deps.runs.createRunning({
      inputHash: inputHash(input),
      chatId: input.chatId,
    });

    await this.deps.runs.markRunning(row.id, 'ingesting');

    const run = this.runIngest(row.id, input);
    this.inFlight.set(row.id, run);
    run.finally(() => this.inFlight.delete(row.id)).catch(() => undefined);

    return { runId: row.id };
  }

  async waitForRun(runId: string): Promise<void> {
    await this.inFlight.get(runId);
  }

  private async runIngest(runId: string, input: MemoryAgentInput): Promise<void> {
    try {
      const outputSummary = await this.deps.memoryAgent.ingest(input);
      await this.deps.runs.markDone(runId, outputSummary);
    } catch (error) {
      await this.deps.runs.markError(runId, error instanceof Error ? error.message : String(error));
    }
  }

  async status(runId: string): Promise<MemoryIngestStatus | null> {
    const row = await this.deps.runs.findById(runId);
    if (!row) {
      return null;
    }

    const output = row.outputSummary;
    return {
      runId: row.id,
      status: row.status,
      stage: row.stage,
      done: row.status !== 'running',
      captured: output ? capturedKeys(output.actions) : { wiki: [], sl: [], xrefs: [] },
      error: row.error,
      commitHash: output?.commitHash ?? null,
      skillsLoaded: output?.skillsLoaded ?? [],
      signalDetected: output?.signalDetected ?? false,
    };
  }
}
```

- [ ] **Step 5: Rename the local memory factory**

In `packages/context/src/memory/local-memory.ts`, replace the service import:

```typescript
import { MemoryIngestService } from './memory-runs.js';
```

Rename the options interface and factory:

```typescript
export interface CreateLocalProjectMemoryIngestOptions {
  llmProvider?: KtxLlmProvider;
  agentRunner?: AgentRunnerService;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: { execute(input: { connectionId: string; sql: string; maxRows?: number }): Promise<KtxQueryResult> };
  runIdFactory?: () => string;
  logger?: KtxLogger;
}

export function createLocalProjectMemoryIngest(
  project: KtxLocalProject,
  options: CreateLocalProjectMemoryIngestOptions = {},
): MemoryIngestService {
```

Update the error string:

```typescript
throw new Error('createLocalProjectMemoryIngest requires llm.provider.backend or an injected agentRunner');
```

Return the renamed service:

```typescript
  return new MemoryIngestService({
    memoryAgent,
    runs: new LocalMemoryRunStore({ projectDir: project.projectDir, idFactory: options.runIdFactory }),
  });
```

- [ ] **Step 6: Update memory exports**

In `packages/context/src/memory/index.ts`, replace the memory run exports with:

```typescript
export { createLocalProjectMemoryIngest, type CreateLocalProjectMemoryIngestOptions } from './local-memory.js';
export { LocalMemoryRunStore, type LocalMemoryRunStoreOptions } from './local-memory-runs.js';
export {
  MemoryIngestService,
  type MemoryIngestServiceDeps,
  type MemoryIngestStartResult,
  type MemoryIngestStatus,
  type MemoryRunRecord,
  type MemoryRunStatus,
  type MemoryRunStorePort,
} from './memory-runs.js';
```

- [ ] **Step 7: Run memory tests and commit**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/memory/memory-runs.test.ts src/memory/local-memory.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/context/src/memory/memory-runs.ts packages/context/src/memory/memory-runs.test.ts packages/context/src/memory/local-memory.ts packages/context/src/memory/local-memory.test.ts packages/context/src/memory/index.ts
git commit -m "refactor(context): rename memory capture service to ingest"
```

### Task 3: Move memory ingest into the shared MCP context tool path

**Files:**

- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/context-tools.ts`
- Modify: `packages/context/src/mcp/server.ts`
- Modify: `packages/context/src/mcp/server.test.ts`

- [ ] **Step 1: Update MCP types**

In `packages/context/src/mcp/types.ts`, replace the memory import with:

```typescript
import type { MemoryIngestService } from '../memory/index.js';
```

Replace `MemoryCapturePort` with:

```typescript
export interface MemoryIngestPort {
  ingest: MemoryIngestService['ingest'];
  status: MemoryIngestService['status'];
}
```

Reduce the retained MCP port interfaces to the v1 surface:

```typescript
export interface KtxConnectionsMcpPort {
  list(): Promise<KtxConnectionSummary[]>;
}

export interface KtxKnowledgeMcpPort {
  search(input: { userId: string; query: string; limit: number }): Promise<KtxKnowledgeSearchResponse>;
  read(input: { userId: string; key: string }): Promise<KtxKnowledgePage | null>;
}

export interface KtxSemanticLayerMcpPort {
  readSource(input: { connectionId: string; sourceName: string }): Promise<KtxSemanticLayerReadResponse | null>;
  query(input: { connectionId?: string; query: SemanticLayerQueryInput }): Promise<KtxSemanticLayerQueryResponse>;
}

export interface KtxMcpContextPorts {
  connections?: KtxConnectionsMcpPort;
  knowledge?: KtxKnowledgeMcpPort;
  semanticLayer?: KtxSemanticLayerMcpPort;
  entityDetails?: KtxEntityDetailsMcpPort;
  dictionarySearch?: KtxDictionarySearchMcpPort;
  discover?: KtxDiscoverDataMcpPort;
  sqlExecution?: KtxSqlExecutionMcpPort;
  memoryIngest?: MemoryIngestPort;
}

export interface KtxMcpServerDeps {
  server: KtxMcpServerLike;
  userContext: KtxMcpUserContext;
  contextTools?: KtxMcpContextPorts;
}
```

- [ ] **Step 2: Add memory ingest schemas to `context-tools.ts`**

At the top of `packages/context/src/mcp/context-tools.ts`, add:

```typescript
import { randomUUID } from 'node:crypto';
import type { MemoryAgentInput } from '../memory/index.js';
```

After `sqlExecutionSchema`, add:

```typescript
const memoryIngestSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'Free-form markdown to ingest. Include the knowledge itself plus any context (source, the user question, why this came up) that the memory agent should consider when triaging into wiki/SL.',
    ),
  connectionId: connectionIdSchema
    .optional()
    .describe(
      'Scope this memory to a specific connection. Required when the knowledge is warehouse-specific, including measure definitions, schema gotchas, or anything tied to a particular warehouse. Omit only for global wiki knowledge.',
    ),
});

const memoryIngestStatusSchema = z.object({
  runId: z.string().min(1).describe('The memory ingest run id returned by memory_ingest.'),
});
```

- [ ] **Step 3: Delete removed registration blocks**

In `registerKtxContextTools`, delete the registration blocks for these tool
names:

```text
connection_test
wiki_write
sl_list_sources
sl_write_source
sl_validate
ingest_trigger
ingest_status
ingest_report
ingest_replay
scan_trigger
scan_status
scan_report
scan_list_artifacts
scan_read_artifact
```

Also delete their now-unused input schemas from `context-tools.ts`:
`connectionTestSchema`, `historicSqlUsageFrontmatterSchema`,
`knowledgeWriteSchema`, `slListSourcesSchema`, `slWriteSourceSchema`,
`slValidateSchema`, `ingestTriggerSchema`, `ingestStatusSchema`,
`ingestReportSchema`, `ingestReplaySchema`, `scanTriggerSchema`,
`scanStatusSchema`, and `scanArtifactReadSchema`.

- [ ] **Step 4: Register memory ingest through `registerParsedTool`**

Add this block near the end of `registerKtxContextTools`, after
`sql_execution`:

```typescript
  if (ports.memoryIngest) {
    const memoryIngest = ports.memoryIngest;
    registerParsedTool(
      server,
      'memory_ingest',
      {
        title: 'Memory Ingest',
        description:
          'Ingest free-form markdown knowledge into KTX durable memory. Use this for business rules, metric definitions, schema gotchas, recurring findings, or explicit user requests to remember something.',
        inputSchema: memoryIngestSchema.shape,
      },
      memoryIngestSchema,
      async (input) => {
        const ingestInput: MemoryAgentInput = {
          userId: userContext.userId,
          chatId: `mcp-${randomUUID()}`,
          userMessage: 'Ingest external knowledge into KTX memory.',
          assistantMessage: input.content,
          connectionId: input.connectionId,
          sourceType: 'external_ingest',
        };
        return jsonToolResult(await memoryIngest.ingest(ingestInput));
      },
    );

    registerParsedTool(
      server,
      'memory_ingest_status',
      {
        title: 'Memory Ingest Status',
        description: 'Read the current or final status for a memory ingest run.',
        inputSchema: memoryIngestStatusSchema.shape,
      },
      memoryIngestStatusSchema,
      async (input) => {
        const status = await memoryIngest.status(input.runId);
        return status ? jsonToolResult(status) : jsonErrorToolResult(`Memory ingest run "${input.runId}" was not found.`);
      },
    );
  }
```

- [ ] **Step 5: Simplify `server.ts`**

Replace `packages/context/src/mcp/server.ts` with:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKtxContextTools } from './context-tools.js';
import type { KtxMcpServerDeps, KtxMcpServerLike } from './types.js';

export function createKtxMcpServer(deps: KtxMcpServerDeps): KtxMcpServerDeps['server'] {
  if (deps.contextTools) {
    registerKtxContextTools({
      server: deps.server,
      ports: deps.contextTools,
      userContext: deps.userContext,
    });
  }

  return deps.server;
}

export function createDefaultKtxMcpServer(
  deps: Omit<KtxMcpServerDeps, 'server'> & { name?: string; version?: string },
): McpServer {
  const server = new McpServer({
    name: deps.name ?? 'ktx',
    version: deps.version ?? '0.0.0-private',
  });
  createKtxMcpServer({
    server: server as KtxMcpServerLike,
    userContext: deps.userContext,
    contextTools: deps.contextTools,
  });
  return server;
}
```

- [ ] **Step 6: Run MCP tests and commit**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t "memory ingest|registers all available"
```

Expected: PASS for the new memory ingest and retained surface tests.

Commit:

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.ts packages/context/src/mcp/server.test.ts
git commit -m "feat(mcp): slim research tool surface"
```

### Task 4: Slim local MCP port assembly and CLI server factory

**Files:**

- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`
- Modify: `packages/cli/src/mcp-server-factory.ts`

- [ ] **Step 1: Remove local admin MCP port assembly**

In `packages/context/src/mcp/local-project-ports.ts`, remove the
`localIngest` option:

```typescript
interface CreateLocalProjectMcpContextPortsOptions {
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  localScan?: LocalScanMcpOptions;
  embeddingService?: KtxEmbeddingPort | null;
}
```

Inside `createLocalProjectMcpContextPorts`, remove these object members:

```typescript
      async test(input) {
        return testLocalConnection(project, options, input.connectionId);
      },
```

```typescript
      async write(input) {
        const existing = await readLocalKnowledgePage(project, {
          key: input.key,
          userId: input.userId,
        });
        await writeLocalKnowledgePage(project, {
          key: input.key,
          scope: 'GLOBAL',
          userId: input.userId,
          summary: input.summary,
          content: input.content,
          tags: input.tags,
          refs: input.refs,
          slRefs: input.slRefs,
          source: input.source,
          intent: input.intent,
          tables: input.tables,
          representativeSql: input.representativeSql,
          usage: input.usage,
          fingerprints: input.fingerprints,
        });
        return { success: true, key: input.key, action: existing ? 'updated' : 'created' };
      },
```

Remove `semanticLayer.listSources`, `semanticLayer.writeSource`, and
`semanticLayer.validate` from the returned semantic-layer port. Keep only
`readSource` and `query`.

Delete the `if (options.localIngest) { ... }` block and the
`if (options.localScan) { ... }` block at the bottom of the function. Keep
the `options.localScan` value available to `sql_execution`, because
`executeValidatedReadOnlySql` still uses it.

- [ ] **Step 2: Remove local-project helper code that became unused**

In `packages/context/src/mcp/local-project-ports.ts`, delete these helper
functions when no references remain:

```text
testLocalConnection
scanArtifactType
listArtifactsForReport
readScanArtifact
loadComputableSources
validateSourceRecord
localIngestSourceDir
rawFileCountFromIngestReport
statusFromIngestReport
```

Remove now-unused imports from `../ingest/index.js`, `../wiki/local-knowledge.js`,
`yaml`, and `./types.js`. Keep imports used by `connection_list`,
`wiki_search`, `wiki_read`, `sl_read_source`, `sl_query`, `entity_details`,
`dictionary_search`, `discover_data`, and `sql_execution`.

- [ ] **Step 3: Update local-project port tests**

In `packages/context/src/mcp/local-project-ports.test.ts`, remove assertions
that depend on `ports.connections.test`, `ports.knowledge.write`,
`ports.semanticLayer.listSources`, `ports.semanticLayer.writeSource`,
`ports.semanticLayer.validate`, `ports.ingest`, or `ports.scan`.

Add this retained-surface assertion to the test that constructs local ports:

```typescript
expect(Object.keys(ports).sort()).toEqual([
  'connections',
  'dictionarySearch',
  'discover',
  'entityDetails',
  'knowledge',
  'semanticLayer',
  'sqlExecution',
]);
expect(Object.keys(ports.connections ?? {}).sort()).toEqual(['list']);
expect(Object.keys(ports.knowledge ?? {}).sort()).toEqual(['read', 'search']);
expect(Object.keys(ports.semanticLayer ?? {}).sort()).toEqual(['query', 'readSource']);
```

- [ ] **Step 4: Update the CLI MCP server factory**

In `packages/cli/src/mcp-server-factory.ts`, replace the memory import:

```typescript
import { createLocalProjectMemoryIngest } from '@ktx/context/memory';
```

Remove the `localIngest` block from the call to
`createLocalProjectMcpContextPorts`. Keep `semanticLayerCompute`,
`queryExecutor`, `sqlAnalysis`, and `localScan`.

Replace the memory creation block with:

```typescript
  let memoryIngest: ReturnType<typeof createLocalProjectMemoryIngest> | undefined;
  try {
    memoryIngest = createLocalProjectMemoryIngest(input.project, { semanticLayerCompute, queryExecutor });
  } catch (error) {
    input.io?.stderr.write(`KTX MCP memory_ingest disabled: ${error instanceof Error ? error.message : String(error)}\n`);
  }
```

Pass memory ingest through the context tools object:

```typescript
  return () =>
    createDefaultKtxMcpServer({
      name: 'ktx',
      version: input.cliVersion,
      userContext: { userId: 'local' },
      contextTools: {
        ...contextTools,
        ...(memoryIngest ? { memoryIngest } : {}),
      },
    });
```

- [ ] **Step 5: Run local MCP and CLI factory tests and commit**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts src/mcp/server.test.ts
pnpm --filter @ktx/cli exec vitest run src/commands/mcp-commands.test.ts src/mcp-http-server.test.ts src/managed-mcp-daemon.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts packages/cli/src/mcp-server-factory.ts
git commit -m "refactor(mcp): remove admin ports from server factory"
```

### Task 5: Rename CLI text ingest dependencies

**Files:**

- Modify: `packages/cli/src/text-ingest.ts`
- Modify: `packages/cli/src/text-ingest.test.ts`

- [ ] **Step 1: Update text-ingest tests**

In `packages/cli/src/text-ingest.test.ts`, replace
`MemoryCaptureStatus` with `MemoryIngestStatus` and
`TextMemoryCapturePort` with `TextMemoryIngestPort`.

Rename helper functions and dependency keys:

```typescript
function createMemoryIngestStub(
  status: MemoryIngestStatus | null,
): TextMemoryIngestPort {
```

Replace `createMemoryCapture` dependency uses with `createMemoryIngest`.

- [ ] **Step 2: Run text ingest tests and confirm they fail**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/text-ingest.test.ts
```

Expected: FAIL with missing `MemoryIngestStatus`,
`TextMemoryIngestPort`, and `createMemoryIngest`.

- [ ] **Step 3: Update `text-ingest.ts` imports and types**

In `packages/cli/src/text-ingest.ts`, replace the memory import with:

```typescript
import { createLocalProjectMemoryIngest, type MemoryAgentInput, type MemoryIngestStatus } from '@ktx/context/memory';
```

Replace the text port and dependency types with:

```typescript
export interface TextMemoryIngestPort {
  ingest(input: MemoryAgentInput): Promise<{ runId: string }>;
  waitForRun(runId: string): Promise<void>;
  status(runId: string): Promise<MemoryIngestStatus | null>;
}
```

```typescript
export interface KtxTextIngestDeps {
  loadProject?: (options: { projectDir: string }) => Promise<KtxLocalProject>;
  createMemoryIngest?: (project: KtxLocalProject) => TextMemoryIngestPort;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  now?: () => number;
}
```

Update the default factory:

```typescript
function defaultCreateMemoryIngest(project: KtxLocalProject): TextMemoryIngestPort {
  return createLocalProjectMemoryIngest(project);
}
```

Replace `MemoryCaptureStatus` type references with `MemoryIngestStatus`.

- [ ] **Step 4: Update the text ingest runtime calls**

In `runKtxTextIngest`, replace:

```typescript
  const memoryCapture = (deps.createMemoryCapture ?? defaultCreateMemoryCapture)(project);
```

with:

```typescript
  const memoryIngest = (deps.createMemoryIngest ?? defaultCreateMemoryIngest)(project);
```

Replace the run block with:

```typescript
        const ingestInput: MemoryAgentInput = {
          userId: args.userId,
          chatId: `cli-text-ingest-${batchId}-${index + 1}`,
          userMessage: `Ingest external text artifact ${artifactReference(item.label)} into KTX memory.`,
          assistantMessage: item.content.trim(),
          ...(args.connectionId ? { connectionId: args.connectionId } : {}),
          sourceType: 'external_ingest',
        };
        const ingest = await memoryIngest.ingest(ingestInput);
        runId = ingest.runId;
        await memoryIngest.waitForRun(runId);
        const status = await memoryIngest.status(runId);
        if (!status) {
          throw new Error(`Memory ingest run "${runId}" was not found.`);
        }
```

- [ ] **Step 5: Run text ingest tests and commit**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/text-ingest.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src/text-ingest.ts packages/cli/src/text-ingest.test.ts
git commit -m "refactor(cli): rename text ingest memory port"
```

### Task 6: Update analytics skill and docs

**Files:**

- Modify: `packages/cli/src/skills/analytics/SKILL.md`
- Modify: `packages/cli/src/setup-agents.test.ts`
- Modify: `docs-site/content/docs/integrations/agent-clients.mdx`

- [ ] **Step 1: Update the analytics skill text**

In `packages/cli/src/skills/analytics/SKILL.md`, replace line 8 with:

```markdown
You have access to KTX MCP tools for data discovery, semantic-layer analysis, raw read-only SQL, wiki context, and memory ingest. Follow this workflow.
```

Replace workflow step 7 with:

```markdown
7. **Capture durable learnings** - call `memory_ingest` whenever a turn produces something worth remembering (business rules, metric definitions, schema gotchas, recurring findings) **or** whenever the user asks you to remember something. Pass markdown in `content` including any source context the memory agent should weigh. Each call is a feedback loop; better notes today mean smarter `discover_data` and `wiki_search` results tomorrow.
```

Add this rule under `<rules>` after the `dictionary_search` rule:

```markdown
- When `connection_list` shows multiple connections, pass an explicit `connectionId` to every tool that takes one and where user intent pins a specific warehouse. Required: `entity_details`, `sl_read_source`, and `sql_execution`. Required when user intent is warehouse-specific, including wording like "in our warehouse" or "this warehouse": `memory_ingest`; without `connectionId`, the memory agent cannot update the semantic layer and the knowledge lands as wiki-only. Pass `connectionId` when intent pins a warehouse, otherwise omit for unscoped discovery: `sl_query`, `discover_data`, and `dictionary_search`. Never pass `connectionId` to `connection_list`, `wiki_search`, `wiki_read`, or `memory_ingest_status`. If intent is ambiguous for a required-or-scoped tool, ask the user which warehouse before calling.
```

In the first example, replace step 5 with:

```markdown
5. `memory_ingest({ connectionId: "warehouse", content: "Acme Corp order analysis used orders_facts.order_count filtered by customers.name = 'Acme Corp'. Source: current analysis turn." })` captures the durable finding.
```

Add this example before `</examples>`:

```markdown
---

**Input:** "Heads up: ARR is always reported in cents in our warehouse."

**Workflow:**
1. If multiple connections exist, call `connection_list` and identify the warehouse the user means. Ask if ambiguous.
2. `memory_ingest({ connectionId: "warehouse", content: "ARR is reported in cents (not dollars) in this warehouse. Multiply by 0.01 for dollar amounts. Source: user clarification." })` remembers the warehouse-specific rule without running an analysis turn.
```

- [ ] **Step 2: Add setup-agent skill assertions**

In `packages/cli/src/setup-agents.test.ts`, find the test that reads
`.agents/skills/ktx-analytics/SKILL.md` and currently asserts
`name: ktx-analytics`. Extend it with:

```typescript
expect(analyticsSkill).toContain('memory_ingest');
expect(analyticsSkill).toContain('ARR is reported in cents');
expect(analyticsSkill).not.toContain('memory_capture');
```

- [ ] **Step 3: Update docs-site memory wording**

In `docs-site/content/docs/integrations/agent-clients.mdx`, replace:

```markdown
semantic-layer queries, wiki search, SQL execution, and memory capture. The
```

with:

```markdown
semantic-layer queries, wiki search, SQL execution, and memory ingest. The
```

- [ ] **Step 4: Run skill and docs tests and commit**

Run:

```bash
pnpm --filter @ktx/cli exec vitest run src/setup-agents.test.ts
pnpm --filter ktx-docs run build
pnpm --filter ktx-docs run test
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src/skills/analytics/SKILL.md packages/cli/src/setup-agents.test.ts docs-site/content/docs/integrations/agent-clients.mdx
git commit -m "docs: update analytics skill for memory ingest"
```

### Task 7: Full verification and cleanup

**Files:**

- Verify: all files changed in Tasks 1-6

- [ ] **Step 1: Check for stale capture names**

Run:

```bash
rg -n "memory_capture|memory_capture_status|MemoryCapture|createLocalProjectMemoryCapture|TextMemoryCapturePort|memoryCapture" packages/context/src packages/cli/src docs-site/content/docs/integrations/agent-clients.mdx
```

Expected: no matches in MCP, memory service, CLI setup, analytics skill, text
ingest, or docs-site files. Matches in historical `docs/superpowers/` files
are allowed and are intentionally excluded from the command.

- [ ] **Step 2: Check retained MCP tool registration names**

Run:

```bash
rg -n "'(connection_test|wiki_write|sl_list_sources|sl_write_source|sl_validate|ingest_trigger|ingest_status|ingest_report|ingest_replay|scan_trigger|scan_status|scan_report|scan_list_artifacts|scan_read_artifact)'" packages/context/src/mcp packages/cli/src
```

Expected: no matches.

- [ ] **Step 3: Run required context checks**

Run:

```bash
pnpm --filter @ktx/context run test
pnpm --filter @ktx/context run test:slow
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 4: Run required CLI checks**

Run:

```bash
pnpm --filter @ktx/cli run type-check
pnpm --filter @ktx/cli run test
```

Expected: PASS.

- [ ] **Step 5: Run docs-site checks**

Run:

```bash
pnpm --filter ktx-docs run build
pnpm --filter ktx-docs run test
```

Expected: PASS.

- [ ] **Step 6: Run dead-code check**

Run:

```bash
pnpm run dead-code
```

Expected: PASS. If Knip reports only exports intentionally kept for future
admin CLI work, add narrow `knip.json` entries for the exact symbols. Delete
private unused MCP-only helpers instead of ignoring them.

- [ ] **Step 7: Run pre-commit on changed files**

Run this command with the actual changed files from `git diff --name-only`:

```bash
uv run pre-commit run --files packages/context/src/memory/memory-runs.ts packages/context/src/memory/memory-runs.test.ts packages/context/src/memory/local-memory.ts packages/context/src/memory/local-memory.test.ts packages/context/src/memory/index.ts packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts packages/cli/src/mcp-server-factory.ts packages/cli/src/text-ingest.ts packages/cli/src/text-ingest.test.ts packages/cli/src/skills/analytics/SKILL.md packages/cli/src/setup-agents.test.ts docs-site/content/docs/integrations/agent-clients.mdx
```

Expected: PASS. If pre-commit reports missing local tool versions without
changing files, record the exact error in the final handoff and rely on the
passing package checks above.

- [ ] **Step 8: Commit final verification cleanup**

Run:

```bash
git status --short
```

Expected: only intentional files from this plan are modified.

If verification cleanup changed files, commit them:

```bash
git add packages/context/src packages/cli/src docs-site/content/docs/integrations/agent-clients.mdx knip.json
git commit -m "chore: verify mcp surface rename"
```

If no files changed after the previous commits, do not create an empty commit.

## Self-review

- Spec coverage: This plan covers PR 1 from the spec: tool surface reduction,
  `memory_capture` to `memory_ingest` rename, memory input contract, memory
  registration through the shared context tool path, analytics skill updates,
  docs-site wording, CLI factory wiring, text ingest naming, and tests.
- Deferred v1 coverage: PR 2 polish kit and PR 3 progress notifications remain
  v1-blocking follow-up plans after this lands.
- Red-flag scan: The plan avoids deferred-work markers, migration shims,
  compatibility wrappers, and incomplete implementation instructions.
- Type consistency: All new names use `MemoryIngestService`,
  `MemoryIngestPort`, `MemoryIngestStatus`,
  `createLocalProjectMemoryIngest`, `TextMemoryIngestPort`,
  `memory_ingest`, and `memory_ingest_status`.
