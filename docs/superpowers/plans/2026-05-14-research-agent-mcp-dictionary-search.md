# Research Agent MCP Dictionary Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the MCP-shaped `dictionary_search` tool so external research agents can resolve user-mentioned literal values to profile-sampled warehouse columns.

**Architecture:** Reuse the existing relationship-profile dictionary extraction as the source of truth, add a focused local dictionary-search service that reports coverage and non-authoritative misses per connection, then register the service through the MCP context tool surface and local project ports. The service re-reads the latest profile artifact on each call instead of keeping a long-lived cache, so scan freshness is correct for the MCP daemon v1.

**Tech Stack:** TypeScript, Vitest, Zod, KTX local file store, relationship-profile artifacts, KTX MCP context ports.

---

## Current Audit

Original spec: `docs/superpowers/specs/2026-05-14-research-agent-mcp-tools-design.md`

Implemented v1 slices:

- `docs/superpowers/plans/2026-05-14-research-agent-mcp-sql-execution-foundation.md` is implemented. Current source has sqlglot read-only validation in `python/ktx-daemon/src/ktx_daemon/sql_analysis.py`, `SqlAnalysisPort.validateReadOnly()` in `packages/context/src/sql-analysis/ports.ts`, MCP `sql_execution` registration in `packages/context/src/mcp/context-tools.ts`, and local connector execution gated by validation in `packages/context/src/mcp/local-project-ports.ts`.
- `docs/superpowers/plans/2026-05-14-research-agent-mcp-entity-details.md` is implemented. Current source has `packages/context/src/scan/entity-details.ts`, MCP `entity_details` registration in `packages/context/src/mcp/context-tools.ts`, and local project wiring in `packages/context/src/mcp/local-project-ports.ts`.

V1-blocking gaps remaining against the original spec:

- `dictionary_search` is not registered on the MCP surface and `KtxMcpContextPorts` has no dictionary-search port.
- `discover_data` is not registered on the MCP surface and the unified ranked result shape is not implemented.
- The ingest-side warehouse-verification tools still use `connectionName` / `targets` / `rowLimit` contracts and have not been fully converged with shared MCP-shaped services.
- `ktx mcp start|stop|status|logs` and the HTTP Streamable MCP daemon do not exist.
- `ktx setup-agents` does not install MCP client config entries or the `ktx-research` skill.

This plan covers only the next focused blocker: MCP `dictionary_search`. Later plans still need to cover `discover_data`, ingest contract convergence, the HTTP daemon, and setup-agent/research-skill installation.

Non-blocking or explicitly out-of-scope gaps:

- Python code execution over MCP.
- Stdio MCP transport.
- OS-level auto-start.
- Native TLS, audit logging, rate limiting, per-tool authorization, and multi-project daemon routing.
- Streaming SQL results.

## File Structure

Create:

- `packages/context/src/sl/dictionary-search.ts`
  - Reads the latest `relationship-profile.json` per searched connection.
  - Uses `loadLatestSlDictionaryEntries()` for dictionary entries.
  - Returns spec-shaped `searched` coverage records, matches, and per-value miss reasons.
  - Re-reads artifacts per call rather than caching, satisfying MCP freshness for v1.
- `packages/context/src/sl/dictionary-search.test.ts`
  - Covers matches, non-authoritative misses, missing profile artifacts, no candidate columns, case-insensitive substring matching, and connection scoping.

Modify:

- `packages/context/src/sl/index.ts`
  - Export the new service and response types.
- `packages/context/src/mcp/types.ts`
  - Add `KtxDictionarySearchMcpPort` and include `dictionarySearch` in `KtxMcpContextPorts`.
- `packages/context/src/mcp/context-tools.ts`
  - Add the `dictionary_search` Zod schema and registration.
- `packages/context/src/mcp/server.test.ts`
  - Assert MCP registration and structured output for `dictionary_search`.
- `packages/context/src/mcp/local-project-ports.ts`
  - Wire local project dictionary search to the new service.
- `packages/context/src/mcp/local-project-ports.test.ts`
  - Cover local-port `dictionary_search` success and missing-profile behavior.
- `packages/context/src/mcp/index.ts`
  - Export the new MCP port type if it is not already covered by existing barrel exports.

## Task 1: Add The Dictionary Search Service

**Files:**
- Create: `packages/context/src/sl/dictionary-search.test.ts`
- Create: `packages/context/src/sl/dictionary-search.ts`
- Modify: `packages/context/src/sl/index.ts`

- [ ] **Step 1: Write failing service tests**

Create `packages/context/src/sl/dictionary-search.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { createKtxDictionarySearchService } from './dictionary-search.js';

describe('createKtxDictionarySearchService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-dictionary-search-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', url: 'env:DATABASE_URL' };
    project.config.connections.billing = { driver: 'postgres', url: 'env:BILLING_DATABASE_URL' };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedProfile(input: {
    connectionId: string;
    syncId: string;
    columns: Record<string, unknown>;
  }): Promise<void> {
    await project.fileStore.writeFile(
      `raw-sources/${input.connectionId}/live-database/${input.syncId}/enrichment/relationship-profile.json`,
      `${JSON.stringify(
        {
          connectionId: input.connectionId,
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 4,
          tables: [],
          columns: input.columns,
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed relationship profile',
    );
  }

  it('returns matches and non-authoritative misses across configured connections', async () => {
    await seedProfile({
      connectionId: 'warehouse',
      syncId: 'sync-1',
      columns: {
        'orders.status': {
          table: { catalog: null, db: 'public', name: 'orders' },
          column: 'status',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 3,
          sampleValues: ['paid', 'refunded', 'pending'],
        },
      },
    });
    await seedProfile({
      connectionId: 'billing',
      syncId: 'sync-2',
      columns: {
        'customers.name': {
          table: { catalog: null, db: 'public', name: 'customers' },
          column: 'name',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 4,
          sampleValues: ['Acme Corp', 'Globex'],
        },
      },
    });
    const service = createKtxDictionarySearchService(project);

    await expect(service.search({ values: ['PAID', 'missing'] })).resolves.toEqual({
      searched: [
        {
          connectionId: 'billing',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 1,
            syncId: 'sync-2',
            profiledAt: null,
          },
          status: 'ready',
        },
        {
          connectionId: 'warehouse',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 1,
            syncId: 'sync-1',
            profiledAt: null,
          },
          status: 'ready',
        },
      ],
      results: [
        {
          value: 'PAID',
          matches: [
            {
              connectionId: 'warehouse',
              sourceName: 'orders',
              columnName: 'status',
              matchedValue: 'paid',
              cardinality: 3,
            },
          ],
          misses: [{ connectionId: 'billing', reason: 'value_not_in_sample' }],
        },
        {
          value: 'missing',
          matches: [],
          misses: [
            { connectionId: 'billing', reason: 'value_not_in_sample' },
            { connectionId: 'warehouse', reason: 'value_not_in_sample' },
          ],
        },
      ],
    });
  });

  it('distinguishes missing profile artifacts from profiles with no candidate columns', async () => {
    await seedProfile({
      connectionId: 'billing',
      syncId: 'sync-empty',
      columns: {
        'events.id': {
          table: { catalog: null, db: 'public', name: 'events' },
          column: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          distinctCount: 100,
          sampleValues: [1, 2, 3],
        },
      },
    });
    const service = createKtxDictionarySearchService(project);

    await expect(service.search({ values: ['Acme'] })).resolves.toEqual({
      searched: [
        {
          connectionId: 'billing',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 0,
            syncId: 'sync-empty',
            profiledAt: null,
          },
          status: 'no_candidate_columns',
        },
        {
          connectionId: 'warehouse',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 0,
            syncId: null,
            profiledAt: null,
          },
          status: 'no_profile_artifact',
        },
      ],
      results: [
        {
          value: 'Acme',
          matches: [],
          misses: [
            { connectionId: 'billing', reason: 'no_candidate_columns' },
            { connectionId: 'warehouse', reason: 'no_profile_artifact' },
          ],
        },
      ],
    });
  });

  it('scopes search to the requested connection', async () => {
    await seedProfile({
      connectionId: 'warehouse',
      syncId: 'sync-1',
      columns: {
        'orders.status': {
          table: { catalog: null, db: 'public', name: 'orders' },
          column: 'status',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 3,
          sampleValues: ['paid'],
        },
      },
    });
    await seedProfile({
      connectionId: 'billing',
      syncId: 'sync-2',
      columns: {
        'invoices.status': {
          table: { catalog: null, db: 'public', name: 'invoices' },
          column: 'status',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 2,
          sampleValues: ['paid'],
        },
      },
    });
    const service = createKtxDictionarySearchService(project);

    await expect(service.search({ connectionId: 'billing', values: ['paid'] })).resolves.toMatchObject({
      searched: [{ connectionId: 'billing', status: 'ready' }],
      results: [
        {
          value: 'paid',
          matches: [{ connectionId: 'billing', sourceName: 'invoices', columnName: 'status', matchedValue: 'paid' }],
          misses: [],
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run service tests to verify they fail**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/dictionary-search.test.ts
```

Expected: FAIL with `Cannot find module './dictionary-search.js'`.

- [ ] **Step 3: Implement the dictionary search service**

Create `packages/context/src/sl/dictionary-search.ts`:

```typescript
import type { KtxLocalProject } from '../project/index.js';
import { loadLatestSlDictionaryEntries, type SlDictionaryEntry } from './sl-dictionary-profile.js';

export type KtxDictionarySearchStatus = 'ready' | 'no_profile_artifact' | 'no_candidate_columns';
export type KtxDictionarySearchMissReason = 'no_profile_artifact' | 'no_candidate_columns' | 'value_not_in_sample';

export interface KtxDictionarySearchInput {
  values: string[];
  connectionId?: string;
}

export interface KtxDictionarySearchCoverage {
  sampledRows: number | null;
  valuesPerColumn: number | null;
  profiledColumns: number;
  syncId: string | null;
  profiledAt: string | null;
}

export interface KtxDictionarySearchSearchedConnection {
  connectionId: string;
  coverage: KtxDictionarySearchCoverage;
  status: KtxDictionarySearchStatus;
}

export interface KtxDictionarySearchMatch {
  connectionId: string;
  sourceName: string;
  columnName: string;
  matchedValue: string;
  cardinality: number | null;
}

export interface KtxDictionarySearchMiss {
  connectionId: string;
  reason: KtxDictionarySearchMissReason;
}

export interface KtxDictionarySearchValueResult {
  value: string;
  matches: KtxDictionarySearchMatch[];
  misses: KtxDictionarySearchMiss[];
}

export interface KtxDictionarySearchResponse {
  searched: KtxDictionarySearchSearchedConnection[];
  results: KtxDictionarySearchValueResult[];
}

interface RelationshipProfileArtifact {
  connectionId?: string;
  profileSampleRows?: unknown;
  sampleValuesPerColumn?: unknown;
  profiledAt?: unknown;
  extractedAt?: unknown;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function latestProfileSyncId(path: string): string | null {
  const parts = path.split('/');
  return parts.at(-3) ?? null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function latestProfilePath(project: KtxLocalProject, connectionId: string): Promise<string | null> {
  const root = `raw-sources/${connectionId}/live-database`;
  let files: string[];
  try {
    files = (await project.fileStore.listFiles(root)).files;
  } catch {
    return null;
  }
  return files
    .filter((path) => path.endsWith('/enrichment/relationship-profile.json'))
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;
}

async function readProfile(project: KtxLocalProject, path: string): Promise<RelationshipProfileArtifact> {
  const raw = await project.fileStore.readFile(path);
  const parsed = JSON.parse(raw.content) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as RelationshipProfileArtifact)
    : {};
}

function profiledColumnCount(entries: readonly SlDictionaryEntry[]): number {
  return new Set(entries.map((entry) => `${entry.sourceName}\u001f${entry.columnName}`)).size;
}

async function searchedConnection(
  project: KtxLocalProject,
  connectionId: string,
  entries: readonly SlDictionaryEntry[],
): Promise<KtxDictionarySearchSearchedConnection> {
  const path = await latestProfilePath(project, connectionId);
  if (!path) {
    return {
      connectionId,
      coverage: {
        sampledRows: null,
        valuesPerColumn: null,
        profiledColumns: 0,
        syncId: null,
        profiledAt: null,
      },
      status: 'no_profile_artifact',
    };
  }

  const profile = await readProfile(project, path);
  const count = profiledColumnCount(entries);
  return {
    connectionId,
    coverage: {
      sampledRows: optionalNumber(profile.profileSampleRows),
      valuesPerColumn: optionalNumber(profile.sampleValuesPerColumn),
      profiledColumns: count,
      syncId: latestProfileSyncId(path),
      profiledAt: optionalString(profile.profiledAt) ?? optionalString(profile.extractedAt),
    },
    status: count > 0 ? 'ready' : 'no_candidate_columns',
  };
}

function entryMatchesValue(entry: SlDictionaryEntry, value: string): boolean {
  return entry.value.toLowerCase().includes(value.toLowerCase());
}

function toMatch(entry: SlDictionaryEntry): KtxDictionarySearchMatch {
  return {
    connectionId: entry.connectionId,
    sourceName: entry.sourceName,
    columnName: entry.columnName,
    matchedValue: entry.value,
    cardinality: entry.cardinality,
  };
}

function sortMatches(matches: KtxDictionarySearchMatch[]): KtxDictionarySearchMatch[] {
  return matches.sort(
    (left, right) =>
      left.connectionId.localeCompare(right.connectionId) ||
      left.sourceName.localeCompare(right.sourceName) ||
      left.columnName.localeCompare(right.columnName) ||
      left.matchedValue.localeCompare(right.matchedValue),
  );
}

function missReason(status: KtxDictionarySearchStatus): KtxDictionarySearchMissReason {
  return status === 'ready' ? 'value_not_in_sample' : status;
}

export function createKtxDictionarySearchService(project: KtxLocalProject) {
  return {
    async search(input: KtxDictionarySearchInput): Promise<KtxDictionarySearchResponse> {
      const connectionIds = input.connectionId ? [input.connectionId] : uniqueSorted(Object.keys(project.config.connections));
      const entries = await loadLatestSlDictionaryEntries(project, connectionIds);
      const entriesByConnection = new Map<string, SlDictionaryEntry[]>();
      for (const connectionId of connectionIds) {
        entriesByConnection.set(
          connectionId,
          entries.filter((entry) => entry.connectionId === connectionId),
        );
      }

      const searched = (
        await Promise.all(
          connectionIds.map((connectionId) =>
            searchedConnection(project, connectionId, entriesByConnection.get(connectionId) ?? []),
          ),
        )
      ).sort((left, right) => left.connectionId.localeCompare(right.connectionId));
      const searchedByConnection = new Map(searched.map((connection) => [connection.connectionId, connection]));

      return {
        searched,
        results: input.values.map((value) => {
          const matches = sortMatches(entries.filter((entry) => entryMatchesValue(entry, value)).map(toMatch));
          const matchedConnections = new Set(matches.map((match) => match.connectionId));
          return {
            value,
            matches,
            misses: searched
              .filter((connection) => !matchedConnections.has(connection.connectionId))
              .map((connection) => ({
                connectionId: connection.connectionId,
                reason: missReason(searchedByConnection.get(connection.connectionId)?.status ?? 'no_profile_artifact'),
              })),
          };
        }),
      };
    },
  };
}
```

- [ ] **Step 4: Export the service**

In `packages/context/src/sl/index.ts`, add:

```typescript
export {
  createKtxDictionarySearchService,
} from './dictionary-search.js';
export type {
  KtxDictionarySearchCoverage,
  KtxDictionarySearchInput,
  KtxDictionarySearchMatch,
  KtxDictionarySearchMiss,
  KtxDictionarySearchMissReason,
  KtxDictionarySearchResponse,
  KtxDictionarySearchSearchedConnection,
  KtxDictionarySearchStatus,
  KtxDictionarySearchValueResult,
} from './dictionary-search.js';
```

- [ ] **Step 5: Run service tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/dictionary-search.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the service slice**

Run:

```bash
git add packages/context/src/sl/dictionary-search.ts packages/context/src/sl/dictionary-search.test.ts packages/context/src/sl/index.ts
git commit -m "feat(context): add dictionary search service"
```

## Task 2: Register The MCP `dictionary_search` Tool

**Files:**
- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/context-tools.ts`
- Modify: `packages/context/src/mcp/server.test.ts`
- Modify: `packages/context/src/mcp/index.ts`

- [ ] **Step 1: Add MCP port types**

In `packages/context/src/mcp/types.ts`, extend the imports:

```typescript
import type { KtxDictionarySearchInput, KtxDictionarySearchResponse } from '../sl/index.js';
```

Add this interface near the other MCP port interfaces:

```typescript
export interface KtxDictionarySearchMcpPort {
  search(input: KtxDictionarySearchInput): Promise<KtxDictionarySearchResponse>;
}
```

Add the new optional port to `KtxMcpContextPorts`:

```typescript
export interface KtxMcpContextPorts {
  connections?: KtxConnectionsMcpPort;
  knowledge?: KtxKnowledgeMcpPort;
  semanticLayer?: KtxSemanticLayerMcpPort;
  entityDetails?: KtxEntityDetailsMcpPort;
  dictionarySearch?: KtxDictionarySearchMcpPort;
  sqlExecution?: KtxSqlExecutionMcpPort;
  ingest?: KtxIngestMcpPort;
  scan?: KtxScanMcpPort;
}
```

- [ ] **Step 2: Write failing MCP registration test**

In `packages/context/src/mcp/server.test.ts`, update the type import list to include:

```typescript
KtxDictionarySearchMcpPort,
```

Add this test after the `entity_details` registration test:

```typescript
  it('registers dictionary_search when the host provides a dictionary-search port', async () => {
    const fake = makeFakeServer();
    const dictionarySearch: KtxDictionarySearchMcpPort = {
      search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({
        searched: [
          {
            connectionId: 'warehouse',
            coverage: {
              sampledRows: null,
              valuesPerColumn: null,
              profiledColumns: 1,
              syncId: 'sync-1',
              profiledAt: null,
            },
            status: 'ready',
          },
        ],
        results: [
          {
            value: 'paid',
            matches: [
              {
                connectionId: 'warehouse',
                sourceName: 'orders',
                columnName: 'status',
                matchedValue: 'paid',
                cardinality: 3,
              },
            ],
            misses: [],
          },
        ],
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { dictionarySearch },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['dictionary_search']);
    await expect(
      getTool(fake.tools, 'dictionary_search').handler({
        connectionId: 'warehouse',
        values: ['paid'],
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        searched: [{ connectionId: 'warehouse', status: 'ready' }],
        results: [
          {
            value: 'paid',
            matches: [{ connectionId: 'warehouse', sourceName: 'orders', columnName: 'status' }],
            misses: [],
          },
        ],
      },
    });
    expect(dictionarySearch.search).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      values: ['paid'],
    });
  });
```

- [ ] **Step 3: Run failing MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t "dictionary_search"
```

Expected: FAIL because `dictionary_search` is not registered.

- [ ] **Step 4: Add the MCP schema and registration**

In `packages/context/src/mcp/context-tools.ts`, add the input schema near the other research schemas:

```typescript
const dictionarySearchSchema = z.object({
  values: z.array(z.string().min(1)).min(1).max(20),
  connectionId: connectionIdSchema.optional(),
});
```

Add this registration block after `entity_details` and before `sql_execution`:

```typescript
  if (ports.dictionarySearch) {
    const dictionarySearch = ports.dictionarySearch;
    registerParsedTool(
      server,
      'dictionary_search',
      {
        title: 'Dictionary Search',
        description:
          'Search profile-sampled warehouse values and report matching connection/source/column locations plus non-authoritative miss reasons.',
        inputSchema: dictionarySearchSchema.shape,
      },
      dictionarySearchSchema,
      async (input) => jsonToolResult(await dictionarySearch.search(input)),
    );
  }
```

- [ ] **Step 5: Confirm MCP barrel exports**

Open `packages/context/src/mcp/index.ts`. If it exports from `./types.js`, no change is needed. If it lists named type exports, add `KtxDictionarySearchMcpPort` to that list.

- [ ] **Step 6: Run MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t "dictionary_search"
```

Expected: PASS.

- [ ] **Step 7: Commit MCP registration**

Run:

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/index.ts
git commit -m "feat(context): register MCP dictionary search tool"
```

## Task 3: Wire Local Project MCP Ports

**Files:**
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write failing local-port tests**

In `packages/context/src/mcp/local-project-ports.test.ts`, add this test after the entity-details local-port tests:

```typescript
  it('exposes local dictionary search through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 4,
          tables: [],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'string',
              distinctCount: 2,
              sampleValues: ['paid', 'refunded'],
            },
          },
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed dictionary profile',
    );

    const ports = createLocalProjectMcpContextPorts(project);

    await expect(ports.dictionarySearch?.search({ values: ['paid'] })).resolves.toMatchObject({
      searched: [{ connectionId: 'warehouse', status: 'ready' }],
      results: [
        {
          value: 'paid',
          matches: [{ connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', matchedValue: 'paid' }],
          misses: [],
        },
      ],
    });
  });

  it('reports missing local dictionary profiles through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };

    const ports = createLocalProjectMcpContextPorts(project);

    await expect(ports.dictionarySearch?.search({ values: ['paid'] })).resolves.toEqual({
      searched: [
        {
          connectionId: 'warehouse',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 0,
            syncId: null,
            profiledAt: null,
          },
          status: 'no_profile_artifact',
        },
      ],
      results: [
        {
          value: 'paid',
          matches: [],
          misses: [{ connectionId: 'warehouse', reason: 'no_profile_artifact' }],
        },
      ],
    });
  });
```

- [ ] **Step 2: Run failing local-port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "dictionary"
```

Expected: FAIL because `ports.dictionarySearch` is undefined.

- [ ] **Step 3: Wire the local port**

In `packages/context/src/mcp/local-project-ports.ts`, update the SL import block to include:

```typescript
createKtxDictionarySearchService,
```

Add this port to the `ports` object returned by `createLocalProjectMcpContextPorts()` near `entityDetails`:

```typescript
    dictionarySearch: {
      async search(input) {
        return createKtxDictionarySearchService(project).search(input);
      },
    },
```

- [ ] **Step 4: Run local-port tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "dictionary"
```

Expected: PASS.

- [ ] **Step 5: Commit local-port wiring**

Run:

```bash
git add packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat(context): expose local MCP dictionary search"
```

## Task 4: Final Verification

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/sl/dictionary-search.test.ts src/mcp/server.test.ts src/mcp/local-project-ports.test.ts
```

Expected: PASS for dictionary-search service, MCP registration, and local-port coverage.

- [ ] **Step 2: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Inspect diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only the dictionary-search service, MCP type/registration, tests, and exports changed.

- [ ] **Step 4: Commit verification note if needed**

If the previous tasks already committed all source changes, do not create an empty commit. If a small follow-up fix was required during verification, commit only those files:

```bash
git add packages/context/src/sl/dictionary-search.ts packages/context/src/sl/dictionary-search.test.ts packages/context/src/sl/index.ts packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/index.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "test(context): cover MCP dictionary search"
```
