# Research Agent MCP Discover Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the MCP-shaped `discover_data` tool so external research agents get one ranked discovery view across wiki pages, semantic-layer sources/measures/dimensions, and raw warehouse schema.

**Architecture:** Create a focused local discovery service in `packages/context/src/search/discover.ts` that builds deterministic per-kind refs from existing wiki, semantic-layer, and latest scan artifacts, fuses the wiki/SL/raw sub-searches with the existing RRF core, and re-reads local artifacts on every call for MCP daemon freshness. Register the service through the MCP context port and local project MCP ports without changing the existing ingest-only `discover_data` adapter yet.

**Tech Stack:** TypeScript, Vitest, Zod, KTX local file store, KTX wiki/SL/scan services, KTX MCP context ports, existing `HybridSearchCore`/RRF search utilities.

---

## Audit Summary

Original spec: `docs/superpowers/specs/2026-05-14-research-agent-mcp-tools-design.md`

Implemented v1 slices confirmed in current source:

- Existing in-process MCP semantic runtime exists in `packages/context/src/mcp/server.ts`, `packages/context/src/mcp/context-tools.ts`, and `packages/context/src/mcp/local-project-ports.ts`.
- Ingest-only warehouse verification tools exist under `packages/context/src/ingest/tools/warehouse-verification/`.
- MCP `sql_execution` is implemented and parser-gated: `python/ktx-daemon/src/ktx_daemon/sql_analysis.py` has `validate_read_only_sql_response`, `python/ktx-daemon/src/ktx_daemon/app.py` exposes `POST /sql/validate-read-only`, `packages/context/src/sql-analysis/ports.ts` has `validateReadOnly()`, and `packages/context/src/mcp/context-tools.ts` registers `sql_execution`.
- MCP `entity_details` is implemented: `packages/context/src/scan/entity-details.ts`, `KtxEntityDetailsMcpPort`, context-tool registration, and local project wiring all exist.
- MCP `dictionary_search` is implemented: `packages/context/src/sl/dictionary-search.ts`, `KtxDictionarySearchMcpPort`, context-tool registration, and local project wiring all exist.

V1-blocking gaps still open:

- `discover_data` is not implemented on the MCP surface. There is no `packages/context/src/search/discover.ts`, no `KtxDiscoverDataMcpPort`, no `ports.discover`, no MCP registration, and no local project wiring.
- `ktx mcp start|stop|status|logs` and the HTTP Streamable MCP daemon do not exist. There is no `packages/cli/src/commands/mcp-commands.ts`, no `packages/cli/src/managed-mcp-daemon.ts`, and `packages/cli/src/cli-program.ts` does not register an `mcp` command subtree.
- `ktx setup-agents` does not install `ktx-research`, write Claude Code/Cursor MCP JSON entries, or print Codex/opencode snippets. `plannedKtxAgentFiles()` still installs only the existing `ktx` skill/rule files.
- Ingest-side warehouse verification tools still use `connectionName`, `targets`, and `rowLimit` contracts. The original spec says these should converge on `connectionId` naming, but that cleanup can be planned after the MCP research surface is complete because this plan adds a separate MCP adapter with the required shape.

Non-blocking or explicitly out-of-scope gaps:

- Python code execution via MCP.
- Stdio MCP transport.
- OS-level auto-start.
- Native TLS, audit logging, rate limiting, per-tool authorization, and multi-project daemon routing.
- Streaming SQL results.

This plan covers only the next dependency-ordered v1 blocker: MCP `discover_data`. Later v1 plans still need to cover the HTTP daemon and setup-agent/research-skill installation.

## File Structure

Create:

- `packages/context/src/search/discover.ts`
  - Defines MCP-shaped `discover_data` input, ref, and response types.
  - Searches wiki pages through `searchLocalKnowledgePages()` and `readLocalKnowledgePage()`.
  - Searches semantic-layer records through `loadLocalSlSourceRecords()`.
  - Searches raw schema by reading the latest `raw-sources/<connectionId>/live-database/<syncId>` scan artifacts directly.
  - Fuses wiki, SL, and raw-schema candidates with `HybridSearchCore` using equal lane weights and normalizes final scores to `0..1`.
  - Re-reads artifacts on every call; no long-lived cache.
- `packages/context/src/search/discover.test.ts`
  - Covers unified result shape, kind filtering, connection scoping, score normalization, snippet cap, raw table refs, and freshness after a newer scan appears.

Modify:

- `packages/context/src/search/index.ts`
  - Export `createKtxDiscoverDataService` and discover types.
- `packages/context/src/mcp/types.ts`
  - Add `KtxDiscoverDataMcpPort` and `discover?: KtxDiscoverDataMcpPort` to `KtxMcpContextPorts`.
- `packages/context/src/mcp/context-tools.ts`
  - Add the `discover_data` Zod schema and tool registration.
- `packages/context/src/mcp/server.test.ts`
  - Assert `discover_data` registration and structured array output.
- `packages/context/src/mcp/local-project-ports.ts`
  - Wire local project `discover.search()` to `createKtxDiscoverDataService()`.
- `packages/context/src/mcp/local-project-ports.test.ts`
  - Cover local-port `discover_data` across wiki, SL, and raw schema.
- `packages/context/src/mcp/index.ts`
  - Export the new MCP port type if it is not already covered by existing barrel exports.

## Task 1: Add The Local Discover Data Service

**Files:**
- Create: `packages/context/src/search/discover.test.ts`
- Create: `packages/context/src/search/discover.ts`
- Modify: `packages/context/src/search/index.ts`

- [ ] **Step 1: Write failing service tests**

Create `packages/context/src/search/discover.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../project/index.js';
import { writeLocalKnowledgePage } from '../wiki/local-knowledge.js';
import { createKtxDiscoverDataService } from './discover.js';

describe('createKtxDiscoverDataService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-discover-data-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project'), projectName: 'warehouse' });
    project.config.connections.warehouse = { driver: 'postgres', url: 'env:DATABASE_URL' };
    project.config.connections.billing = { driver: 'postgres', url: 'env:BILLING_DATABASE_URL' };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedWiki(): Promise<void> {
    await writeLocalKnowledgePage(project, {
      key: 'orders-playbook',
      scope: 'GLOBAL',
      summary: 'Paid order operations',
      content: 'Use paid orders and order_count to inspect monthly customer activity for Acme Corp.',
      tags: ['orders'],
    });
  }

  async function seedSl(): Promise<void> {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      [
        'name: orders',
        'descriptions:',
        '  user: Paid order facts',
        'table: public.orders',
        'grain: [id]',
        'columns:',
        '  - name: status',
        '    type: string',
        '    descriptions:',
        '      user: Payment status for the order',
        '  - name: ordered_at',
        '    type: time',
        'measures:',
        '  - name: order_count',
        '    expr: count(*)',
        '    description: Number of paid orders',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed sl source',
    );
  }

  async function seedScan(input: {
    connectionId?: string;
    syncId: string;
    tableName?: string;
    comment?: string;
    sampleValues?: string[];
  }): Promise<void> {
    const connectionId = input.connectionId ?? 'warehouse';
    const root = `raw-sources/${connectionId}/live-database/${input.syncId}`;
    const tableName = input.tableName ?? 'orders';
    await project.fileStore.writeFile(
      `${root}/connection.json`,
      JSON.stringify(
        {
          connectionId,
          driver: 'postgres',
          extractedAt: `2026-05-14T09:00:00.000Z`,
          scope: { schemas: ['public'] },
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed scan connection',
    );
    await project.fileStore.writeFile(
      `${root}/tables/public-${tableName}.json`,
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: tableName,
          kind: 'table',
          comment: input.comment ?? 'Orders table from warehouse',
          estimatedRows: 123,
          descriptions: { db: input.comment ?? 'Orders table from warehouse' },
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
              sampleValues: input.sampleValues ?? ['paid', 'pending'],
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed table',
    );
    await project.fileStore.writeFile(
      `${root}/scan-report.json`,
      JSON.stringify(
        {
          connectionId,
          driver: 'postgres',
          syncId: input.syncId,
          runId: `scan-${input.syncId}`,
          trigger: 'mcp',
          mode: 'enriched',
          dryRun: false,
          artifactPaths: {
            rawSourcesDir: root,
            reportPath: `${root}/scan-report.json`,
            manifestShards: [],
            enrichmentArtifacts: [],
          },
          diffSummary: {
            tablesAdded: 1,
            tablesModified: 0,
            tablesDeleted: 0,
            tablesUnchanged: 0,
            columnsAdded: 0,
            columnsModified: 0,
            columnsDeleted: 0,
          },
          manifestShardsWritten: 0,
          structuralSyncStats: {
            tablesCreated: 0,
            tablesUpdated: 0,
            tablesDeleted: 0,
            columnsCreated: 0,
            columnsUpdated: 0,
            columnsDeleted: 0,
          },
          enrichment: {
            dataDictionary: 'completed',
            tableDescriptions: 'completed',
            columnDescriptions: 'completed',
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
      'ktx',
      'ktx@example.com',
      'seed scan report',
    );
  }

  it('returns unified ranked refs across wiki, semantic-layer, and raw schema', async () => {
    await seedWiki();
    await seedSl();
    await seedScan({ syncId: 'sync-1', sampleValues: ['paid', 'refunded'] });
    const service = createKtxDiscoverDataService(project, { userId: 'local-user' });

    const results = await service.search({ query: 'paid orders', connectionId: 'warehouse', limit: 10 });

    expect(results.map((result) => result.kind)).toEqual(
      expect.arrayContaining(['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column']),
    );
    expect(results.every((result) => result.score >= 0 && result.score <= 1)).toBe(true);
    expect(results.every((result) => result.snippet === null || result.snippet.length <= 200)).toBe(true);
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: 'table',
        id: 'public.orders',
        connectionId: 'warehouse',
        tableRef: { catalog: null, db: 'public', name: 'orders' },
        matchedOn: expect.stringMatching(/name|description|comment|display/),
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: 'column',
        id: 'public.orders.status',
        connectionId: 'warehouse',
        columnName: 'status',
        matchedOn: expect.stringMatching(/name|comment|description|sample_value/),
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: 'sl_measure',
        id: 'orders.order_count',
        connectionId: 'warehouse',
        summary: 'Number of paid orders',
        snippet: 'count(*)',
        matchedOn: expect.stringMatching(/name|description|expr/),
      }),
    );
  });

  it('honors kind filters and connection scope', async () => {
    await seedWiki();
    await seedSl();
    await seedScan({ syncId: 'sync-1', connectionId: 'warehouse', tableName: 'orders' });
    await seedScan({ syncId: 'sync-2', connectionId: 'billing', tableName: 'invoices', comment: 'Billing invoices' });
    const service = createKtxDiscoverDataService(project);

    const results = await service.search({
      query: 'orders',
      connectionId: 'warehouse',
      kinds: ['table', 'column'],
      limit: 10,
    });

    expect(results.every((result) => result.kind === 'table' || result.kind === 'column')).toBe(true);
    expect(results.every((result) => result.connectionId === 'warehouse')).toBe(true);
    expect(results.some((result) => result.id.includes('invoices'))).toBe(false);
    expect(results.some((result) => result.kind === 'wiki')).toBe(false);
  });

  it('re-reads the latest scan artifacts on each call', async () => {
    await seedScan({ syncId: 'sync-1', tableName: 'orders', comment: 'Old orders table' });
    const service = createKtxDiscoverDataService(project);
    await expect(service.search({ query: 'orders', connectionId: 'warehouse', kinds: ['table'], limit: 10 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'public.orders' })]),
    );

    await seedScan({ syncId: 'sync-2', tableName: 'invoices', comment: 'Invoice facts' });
    const fresh = await service.search({ query: 'invoice', connectionId: 'warehouse', kinds: ['table'], limit: 10 });

    expect(fresh).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'public.invoices' })]));
    expect(fresh.some((result) => result.id === 'public.orders')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing service tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/search/discover.test.ts
```

Expected: FAIL with `Cannot find module './discover.js'`.

- [ ] **Step 3: Implement the discover service**

Create `packages/context/src/search/discover.ts`:

```typescript
import type { KtxEmbeddingPort } from '../core/index.js';
import type { KtxLocalProject } from '../project/index.js';
import type { KtxScanReport, KtxSchemaColumn, KtxSchemaTable, KtxTableRef } from '../scan/index.js';
import { DEFAULT_PRIORITY, loadLocalSlSourceRecords, resolveDescription } from '../sl/index.js';
import type { SemanticLayerSource } from '../sl/index.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages } from '../wiki/local-knowledge.js';
import { HybridSearchCore, type FusedSearchCandidate, type SearchCandidateGenerator } from './index.js';

export type KtxDiscoverDataKind = 'wiki' | 'sl_source' | 'sl_measure' | 'sl_dimension' | 'table' | 'column';
export type KtxDiscoverDataMatchedOn =
  | 'name'
  | 'display'
  | 'description'
  | 'comment'
  | 'expr'
  | 'sample_value'
  | 'body';

export interface KtxDiscoverDataInput {
  query: string;
  connectionId?: string;
  kinds?: KtxDiscoverDataKind[];
  limit?: number;
}

export interface KtxDiscoverDataRef {
  kind: KtxDiscoverDataKind;
  id: string;
  score: number;
  summary: string | null;
  snippet: string | null;
  matchedOn: KtxDiscoverDataMatchedOn;
  connectionId?: string;
  tableRef?: KtxTableRef;
  columnName?: string;
}

export type KtxDiscoverDataResponse = KtxDiscoverDataRef[];

export interface KtxDiscoverDataServiceOptions {
  userId?: string;
  embeddingService?: KtxEmbeddingPort | null;
}

interface CandidateRecord {
  ref: Omit<KtxDiscoverDataRef, 'score'>;
  rankScore: number;
}

type RawTable = KtxSchemaTable & {
  descriptions?: Record<string, string>;
  columns: Array<KtxSchemaColumn & { descriptions?: Record<string, string>; sampleValues?: unknown[] }>;
};

interface LatestScan {
  report: KtxScanReport;
  rawSourcesDir: string;
  tables: RawTable[];
}

const ALL_KINDS: KtxDiscoverDataKind[] = ['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column'];

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

function hasKind(kinds: ReadonlySet<KtxDiscoverDataKind>, kind: KtxDiscoverDataKind): boolean {
  return kinds.has(kind);
}

function cap200(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 200 ? compact.slice(0, 200) : compact;
}

function snippetAround(text: string | null | undefined, terms: readonly string[]): string | null {
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? 0;
  return cap200(text.slice(Math.max(0, index - 60), index + 140));
}

function textScore(value: string | null | undefined, terms: readonly string[]): number {
  const haystack = normalize(value);
  if (!haystack || terms.length === 0) {
    return 0;
  }
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

function bestField(
  fields: Array<{ matchedOn: KtxDiscoverDataMatchedOn; text: string | null | undefined; weight: number }>,
  terms: readonly string[],
): { matchedOn: KtxDiscoverDataMatchedOn; score: number; text: string | null } | null {
  const scored = fields
    .map((field) => ({
      matchedOn: field.matchedOn,
      score: textScore(field.text, terms) * field.weight,
      text: field.text ?? null,
    }))
    .filter((field) => field.score > 0)
    .sort((left, right) => right.score - left.score || left.matchedOn.localeCompare(right.matchedOn));
  return scored[0] ?? null;
}

function displayForTable(table: KtxTableRef): string {
  return [table.catalog, table.db, table.name].filter((part): part is string => Boolean(part)).join('.');
}

function tableRef(table: KtxSchemaTable): KtxTableRef {
  return { catalog: table.catalog, db: table.db, name: table.name };
}

async function readJson<T>(project: KtxLocalProject, path: string): Promise<T> {
  return JSON.parse((await project.fileStore.readFile(path)).content) as T;
}

async function latestScan(project: KtxLocalProject, connectionId: string): Promise<LatestScan | null> {
  const root = `raw-sources/${connectionId}/live-database`;
  let files: string[];
  try {
    files = (await project.fileStore.listFiles(root)).files;
  } catch {
    return null;
  }

  const reportPath = files.filter((path) => path.endsWith('/scan-report.json')).sort().at(-1);
  if (!reportPath) {
    return null;
  }
  const report = await readJson<KtxScanReport>(project, reportPath);
  const rawSourcesDir = report.artifactPaths.rawSourcesDir ?? reportPath.slice(0, -'/scan-report.json'.length);
  const listedTables = await project.fileStore.listFiles(`${rawSourcesDir}/tables`);
  const tables: RawTable[] = [];
  for (const path of listedTables.files.filter((file) => file.endsWith('.json')).sort()) {
    tables.push(await readJson<RawTable>(project, path));
  }
  return { report, rawSourcesDir, tables };
}

function configuredConnectionIds(project: KtxLocalProject, connectionId?: string): string[] {
  return connectionId ? [connectionId] : Object.keys(project.config.connections).sort();
}

async function wikiCandidates(
  project: KtxLocalProject,
  input: KtxDiscoverDataInput,
  options: KtxDiscoverDataServiceOptions,
  terms: readonly string[],
): Promise<CandidateRecord[]> {
  const searchResults = await searchLocalKnowledgePages(project, {
    query: input.query,
    userId: options.userId,
    embeddingService: options.embeddingService ?? null,
    limit: Math.max(input.limit ?? 15, 25),
  });
  const records: CandidateRecord[] = [];
  for (const result of searchResults) {
    const page = await readLocalKnowledgePage(project, { key: result.key, userId: options.userId });
    const content = page?.content ?? '';
    const matched = bestField(
      [
        { matchedOn: 'name', text: result.key, weight: 1.1 },
        { matchedOn: 'description', text: result.summary, weight: 1 },
        { matchedOn: 'body', text: content, weight: 0.8 },
      ],
      terms,
    );
    records.push({
      rankScore: result.score + (matched?.score ?? 0),
      ref: {
        kind: 'wiki',
        id: result.key,
        summary: result.summary || null,
        snippet: snippetAround(content, terms),
        matchedOn: matched?.matchedOn ?? 'body',
      },
    });
  }
  return records.sort((left, right) => right.rankScore - left.rankScore || left.ref.id.localeCompare(right.ref.id));
}

async function slCandidates(
  project: KtxLocalProject,
  input: KtxDiscoverDataInput,
  kinds: ReadonlySet<KtxDiscoverDataKind>,
  terms: readonly string[],
): Promise<CandidateRecord[]> {
  const records: CandidateRecord[] = [];
  for (const connectionId of configuredConnectionIds(project, input.connectionId)) {
    const sources = await loadLocalSlSourceRecords(project, { connectionId }).catch(() => []);
    for (const sourceRecord of sources) {
      const source = sourceRecord.source;
      if (hasKind(kinds, 'sl_source')) {
        const description = resolveDescription(source.descriptions, { priority: DEFAULT_PRIORITY });
        const matched = bestField(
          [
            { matchedOn: 'name', text: source.name, weight: 1.2 },
            { matchedOn: 'description', text: description, weight: 1 },
            { matchedOn: 'display', text: source.table ?? source.sql ?? null, weight: 0.8 },
          ],
          terms,
        );
        if (matched) {
          records.push({
            rankScore: matched.score,
            ref: {
              kind: 'sl_source',
              id: source.name,
              connectionId,
              summary: description,
              snippet:
                matched.matchedOn === 'description'
                  ? snippetAround(description, terms)
                  : cap200(`${source.name}: ${[...source.measures.map((measure) => measure.name), ...source.columns.map((column) => column.name)].slice(0, 3).join(', ')}`),
              matchedOn: matched.matchedOn,
            },
          });
        }
      }

      if (hasKind(kinds, 'sl_measure')) {
        for (const measure of source.measures) {
          const matched = bestField(
            [
              { matchedOn: 'name', text: measure.name, weight: 1.2 },
              { matchedOn: 'description', text: measure.description, weight: 1 },
              { matchedOn: 'expr', text: measure.expr, weight: 0.9 },
            ],
            terms,
          );
          if (matched) {
            records.push({
              rankScore: matched.score,
              ref: {
                kind: 'sl_measure',
                id: `${source.name}.${measure.name}`,
                connectionId,
                summary: measure.description ?? null,
                snippet: cap200(measure.expr),
                matchedOn: matched.matchedOn,
              },
            });
          }
        }
      }

      if (hasKind(kinds, 'sl_dimension')) {
        for (const column of source.columns) {
          const description = resolveDescription(column.descriptions, { priority: DEFAULT_PRIORITY });
          const matched = bestField(
            [
              { matchedOn: 'name', text: column.name, weight: 1.2 },
              { matchedOn: 'description', text: description, weight: 1 },
              { matchedOn: 'expr', text: column.expr, weight: 0.9 },
            ],
            terms,
          );
          if (matched) {
            records.push({
              rankScore: matched.score,
              ref: {
                kind: 'sl_dimension',
                id: `${source.name}.${column.name}`,
                connectionId,
                summary: description,
                snippet: cap200(`${column.name} (${column.type})`),
                matchedOn: matched.matchedOn,
              },
            });
          }
        }
      }
    }
  }
  return records.sort((left, right) => right.rankScore - left.rankScore || left.ref.id.localeCompare(right.ref.id));
}

async function rawCandidates(
  project: KtxLocalProject,
  input: KtxDiscoverDataInput,
  kinds: ReadonlySet<KtxDiscoverDataKind>,
  terms: readonly string[],
): Promise<CandidateRecord[]> {
  const records: CandidateRecord[] = [];
  for (const connectionId of configuredConnectionIds(project, input.connectionId)) {
    const scan = await latestScan(project, connectionId);
    if (!scan) {
      continue;
    }
    for (const table of scan.tables) {
      const ref = tableRef(table);
      const display = displayForTable(ref);
      const tableDescription = resolveDescription(table.descriptions, { priority: DEFAULT_PRIORITY }) ?? table.comment;
      if (hasKind(kinds, 'table')) {
        const matched = bestField(
          [
            { matchedOn: 'name', text: table.name, weight: 1.2 },
            { matchedOn: 'display', text: display, weight: 1.1 },
            { matchedOn: 'description', text: tableDescription, weight: 1 },
            { matchedOn: 'comment', text: table.comment, weight: 1 },
          ],
          terms,
        );
        if (matched) {
          records.push({
            rankScore: matched.score,
            ref: {
              kind: 'table',
              id: display,
              connectionId,
              tableRef: ref,
              summary: tableDescription,
              snippet:
                matched.matchedOn === 'description' || matched.matchedOn === 'comment'
                  ? snippetAround(matched.text, terms)
                  : cap200(table.columns.slice(0, 5).map((column) => column.name).join(', ')),
              matchedOn: matched.matchedOn,
            },
          });
        }
      }

      if (hasKind(kinds, 'column')) {
        for (const column of table.columns) {
          const columnDescription = resolveDescription(column.descriptions, { priority: DEFAULT_PRIORITY }) ?? column.comment;
          const samples = (column.sampleValues ?? []).map((value) => String(value)).slice(0, 5);
          const matched = bestField(
            [
              { matchedOn: 'name', text: column.name, weight: 1.2 },
              { matchedOn: 'display', text: `${display}.${column.name}`, weight: 1.1 },
              { matchedOn: 'description', text: columnDescription, weight: 1 },
              { matchedOn: 'comment', text: column.comment, weight: 1 },
              { matchedOn: 'sample_value', text: samples.join(' '), weight: 0.9 },
            ],
            terms,
          );
          if (matched) {
            records.push({
              rankScore: matched.score,
              ref: {
                kind: 'column',
                id: `${display}.${column.name}`,
                connectionId,
                tableRef: ref,
                columnName: column.name,
                summary: columnDescription,
                snippet:
                  matched.matchedOn === 'sample_value'
                    ? cap200(`${column.nativeType} - samples: ${samples.join(', ')}`)
                    : matched.matchedOn === 'description' || matched.matchedOn === 'comment'
                      ? snippetAround(matched.text, terms)
                      : cap200(column.nativeType),
                matchedOn: matched.matchedOn,
              },
            });
          }
        }
      }
    }
  }
  return records.sort((left, right) => right.rankScore - left.rankScore || left.ref.id.localeCompare(right.ref.id));
}

function generator(name: string, candidates: CandidateRecord[], refsByKey: Map<string, Omit<KtxDiscoverDataRef, 'score'>>): SearchCandidateGenerator {
  candidates.forEach((candidate) => refsByKey.set(`${candidate.ref.kind}:${candidate.ref.connectionId ?? ''}:${candidate.ref.id}`, candidate.ref));
  return {
    lane: name,
    weight: 1,
    async generate() {
      return {
        candidates: candidates.map((candidate, index) => ({
          id: `${candidate.ref.kind}:${candidate.ref.connectionId ?? ''}:${candidate.ref.id}`,
          rank: index + 1,
          rawScore: candidate.rankScore,
        })),
      };
    },
  };
}

function hydrate(fused: FusedSearchCandidate[], refsByKey: Map<string, Omit<KtxDiscoverDataRef, 'score'>>): KtxDiscoverDataRef[] {
  const maxScore = Math.max(...fused.map((candidate) => candidate.score), 0);
  return fused
    .map((candidate) => {
      const ref = refsByKey.get(candidate.id);
      if (!ref) {
        return null;
      }
      return {
        ...ref,
        score: maxScore > 0 ? Number((candidate.score / maxScore).toFixed(6)) : 0,
      };
    })
    .filter((result): result is KtxDiscoverDataRef => result !== null);
}

export function createKtxDiscoverDataService(
  project: KtxLocalProject,
  options: KtxDiscoverDataServiceOptions = {},
): { search(input: KtxDiscoverDataInput): Promise<KtxDiscoverDataResponse> } {
  return {
    async search(input) {
      const limit = Math.max(1, Math.min(input.limit ?? 15, 50));
      const query = input.query.trim();
      if (!query) {
        return [];
      }
      const kinds = new Set(input.kinds ?? ALL_KINDS);
      const terms = queryTerms(query);
      const refsByKey = new Map<string, Omit<KtxDiscoverDataRef, 'score'>>();
      const generators: SearchCandidateGenerator[] = [];

      if (hasKind(kinds, 'wiki')) {
        generators.push(generator('wiki', await wikiCandidates(project, { ...input, limit }, options, terms), refsByKey));
      }
      if (hasKind(kinds, 'sl_source') || hasKind(kinds, 'sl_measure') || hasKind(kinds, 'sl_dimension')) {
        generators.push(generator('semantic_layer', await slCandidates(project, { ...input, limit }, kinds, terms), refsByKey));
      }
      if (hasKind(kinds, 'table') || hasKind(kinds, 'column')) {
        generators.push(generator('raw_schema', await rawCandidates(project, { ...input, limit }, kinds, terms), refsByKey));
      }
      if (generators.length === 0) {
        return [];
      }

      const result = await new HybridSearchCore().search({
        queryText: query,
        limit,
        generators,
        laneWeights: { wiki: 1, semantic_layer: 1, raw_schema: 1 },
      });
      return hydrate(result.results, refsByKey);
    },
  };
}
```

- [ ] **Step 4: Export the service**

In `packages/context/src/search/index.ts`, add:

```typescript
export { createKtxDiscoverDataService } from './discover.js';
export type {
  KtxDiscoverDataInput,
  KtxDiscoverDataKind,
  KtxDiscoverDataMatchedOn,
  KtxDiscoverDataRef,
  KtxDiscoverDataResponse,
  KtxDiscoverDataServiceOptions,
} from './discover.js';
```

- [ ] **Step 5: Run service tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/search/discover.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the service**

Run:

```bash
git add packages/context/src/search/discover.ts packages/context/src/search/discover.test.ts packages/context/src/search/index.ts
git commit -m "feat: add MCP discover data service"
```

Expected: commit succeeds.

## Task 2: Register `discover_data` In The MCP Tool Surface

**Files:**
- Modify: `packages/context/src/mcp/types.ts`
- Modify: `packages/context/src/mcp/context-tools.ts`
- Modify: `packages/context/src/mcp/server.test.ts`
- Modify: `packages/context/src/mcp/index.ts`

- [ ] **Step 1: Write failing MCP registration test**

In `packages/context/src/mcp/server.test.ts`, extend the import from `./types.js` to include:

```typescript
  KtxDiscoverDataMcpPort,
```

Add this test after the `dictionary_search` registration test:

```typescript
  it('registers discover_data when the host provides a discover port', async () => {
    const fake = makeFakeServer();
    const discover: KtxDiscoverDataMcpPort = {
      search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([
        {
          kind: 'table',
          id: 'public.orders',
          score: 1,
          summary: 'Orders table',
          snippet: 'id, status',
          matchedOn: 'name',
          connectionId: 'warehouse',
          tableRef: { catalog: null, db: 'public', name: 'orders' },
        },
      ]),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { discover },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['discover_data']);
    await expect(
      getTool(fake.tools, 'discover_data').handler({
        query: 'orders',
        connectionId: 'warehouse',
        kinds: ['table'],
        limit: 5,
      }),
    ).resolves.toMatchObject({
      structuredContent: [
        {
          kind: 'table',
          id: 'public.orders',
          connectionId: 'warehouse',
          tableRef: { catalog: null, db: 'public', name: 'orders' },
        },
      ],
    });
    expect(discover.search).toHaveBeenCalledWith({
      query: 'orders',
      connectionId: 'warehouse',
      kinds: ['table'],
      limit: 5,
    });
  });
```

- [ ] **Step 2: Run the failing MCP registration test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t "discover_data"
```

Expected: FAIL with an import or type error for `KtxDiscoverDataMcpPort`.

- [ ] **Step 3: Add MCP discover port types**

In `packages/context/src/mcp/types.ts`, add this import near the other search/scan imports:

```typescript
import type { KtxDiscoverDataInput, KtxDiscoverDataResponse } from '../search/index.js';
```

Add this interface after `KtxDictionarySearchMcpPort`:

```typescript
export interface KtxDiscoverDataMcpPort {
  search(input: KtxDiscoverDataInput): Promise<KtxDiscoverDataResponse>;
}
```

Add this optional port to `KtxMcpContextPorts`:

```typescript
  discover?: KtxDiscoverDataMcpPort;
```

- [ ] **Step 4: Add the Zod schema and registration**

In `packages/context/src/mcp/context-tools.ts`, add this schema after `dictionarySearchSchema`:

```typescript
const discoverDataKindSchema = z.enum(['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column']);

const discoverDataSchema = z.object({
  query: z.string().min(1),
  connectionId: connectionIdSchema.optional(),
  kinds: z.array(discoverDataKindSchema).optional(),
  limit: z.number().int().min(1).max(50).default(15).optional(),
});
```

Add this registration block after the `dictionary_search` registration block and before `sql_execution`:

```typescript
  if (ports.discover) {
    const discover = ports.discover;
    registerParsedTool(
      server,
      'discover_data',
      {
        title: 'Discover Data',
        description:
          'Search across KTX wiki pages, semantic-layer sources/measures/dimensions, and raw warehouse schema refs.',
        inputSchema: discoverDataSchema.shape,
      },
      discoverDataSchema,
      async (input) => jsonToolResult(await discover.search(input)),
    );
  }
```

- [ ] **Step 5: Export MCP port types**

Check `packages/context/src/mcp/index.ts`. If it already exports all types from `./types.js`, leave it unchanged. If it lists individual type exports, add:

```typescript
export type { KtxDiscoverDataMcpPort } from './types.js';
```

- [ ] **Step 6: Run MCP registration tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/server.test.ts -t "discover_data"
```

Expected: PASS.

- [ ] **Step 7: Commit MCP registration**

Run:

```bash
git add packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/index.ts
git commit -m "feat: expose discover data MCP tool"
```

Expected: commit succeeds.

## Task 3: Wire Local Project MCP Ports

**Files:**
- Modify: `packages/context/src/mcp/local-project-ports.ts`
- Modify: `packages/context/src/mcp/local-project-ports.test.ts`

- [ ] **Step 1: Write failing local-port test**

In `packages/context/src/mcp/local-project-ports.test.ts`, add this test inside the existing `describe('createLocalProjectMcpContextPorts', ...)` block:

```typescript
  it('exposes local project discover_data across wiki, semantic-layer, and raw schema', async () => {
    await project.fileStore.writeFile(
      'wiki/global/orders-playbook.md',
      [
        '---',
        'summary: Paid order operations',
        'tags: [orders]',
        'refs: []',
        'sl_refs: []',
        'usage_mode: auto',
        '---',
        '',
        'Paid orders are used for customer activity analysis.',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed wiki',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      [
        'name: orders',
        'descriptions:',
        '  user: Paid order facts',
        'table: public.orders',
        'grain: [id]',
        'columns:',
        '  - name: status',
        '    type: string',
        '    descriptions:',
        '      user: Payment status',
        'measures:',
        '  - name: order_count',
        '    expr: count(*)',
        '    description: Number of paid orders',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed sl',
    );
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/connection.json',
      JSON.stringify({ connectionId: 'warehouse', driver: 'postgres', extractedAt: '2026-05-14T09:00:00.000Z' }, null, 2),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/tables/public-orders.json',
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: 'Orders table',
          estimatedRows: 10,
          columns: [
            {
              name: 'status',
              nativeType: 'text',
              normalizedType: 'text',
              dimensionType: 'string',
              nullable: false,
              primaryKey: false,
              comment: 'Order status',
              sampleValues: ['paid'],
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed table',
    );
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/scan-report.json',
      JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          syncId: 'sync-1',
          runId: 'scan-1',
          trigger: 'mcp',
          mode: 'enriched',
          dryRun: false,
          artifactPaths: {
            rawSourcesDir: 'raw-sources/warehouse/live-database/sync-1',
            reportPath: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
            manifestShards: [],
            enrichmentArtifacts: [],
          },
          diffSummary: {
            tablesAdded: 1,
            tablesModified: 0,
            tablesDeleted: 0,
            tablesUnchanged: 0,
            columnsAdded: 0,
            columnsModified: 0,
            columnsDeleted: 0,
          },
          manifestShardsWritten: 0,
          structuralSyncStats: {
            tablesCreated: 0,
            tablesUpdated: 0,
            tablesDeleted: 0,
            columnsCreated: 0,
            columnsUpdated: 0,
            columnsDeleted: 0,
          },
          enrichment: {
            dataDictionary: 'completed',
            tableDescriptions: 'completed',
            columnDescriptions: 'completed',
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
      'ktx',
      'ktx@example.com',
      'seed scan report',
    );

    const ports = createLocalProjectMcpContextPorts(project);
    const results = await ports.discover?.search({ query: 'paid orders', connectionId: 'warehouse', limit: 10 });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'wiki', id: 'orders-playbook' }),
        expect.objectContaining({ kind: 'sl_source', id: 'orders', connectionId: 'warehouse' }),
        expect.objectContaining({ kind: 'table', id: 'public.orders', connectionId: 'warehouse' }),
      ]),
    );
  });
```

- [ ] **Step 2: Run the failing local-port test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "discover_data"
```

Expected: FAIL because `ports.discover` is undefined.

- [ ] **Step 3: Wire the local port**

In `packages/context/src/mcp/local-project-ports.ts`, add `createKtxDiscoverDataService` to the search import block:

```typescript
import { createKtxDiscoverDataService } from '../search/index.js';
```

Add this port in the `ports` object after `dictionarySearch`:

```typescript
    discover: {
      async search(input) {
        return createKtxDiscoverDataService(project, { userId: 'local', embeddingService }).search(input);
      },
    },
```

- [ ] **Step 4: Run local-port test**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/mcp/local-project-ports.test.ts -t "discover_data"
```

Expected: PASS.

- [ ] **Step 5: Commit local-port wiring**

Run:

```bash
git add packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts
git commit -m "feat: wire local discover data MCP port"
```

Expected: commit succeeds.

## Task 4: Verify The Discover Slice

**Files:**
- Verify: `packages/context/src/search/discover.ts`
- Verify: `packages/context/src/mcp/context-tools.ts`
- Verify: `packages/context/src/mcp/local-project-ports.ts`

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @ktx/context exec vitest run src/search/discover.test.ts src/mcp/server.test.ts src/mcp/local-project-ports.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run context type-check**

Run:

```bash
pnpm --filter @ktx/context run type-check
```

Expected: PASS.

- [ ] **Step 3: Run context test suite**

Run:

```bash
pnpm --filter @ktx/context run test
```

Expected: PASS.

- [ ] **Step 4: Check diff hygiene**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 5: Document remaining v1 blockers in handoff**

Run:

```bash
test -e packages/context/src/search/discover.ts; printf 'discover:%s\n' "$?"
test -e packages/cli/src/commands/mcp-commands.ts; printf 'mcp-commands:%s\n' "$?"
test -e packages/cli/src/managed-mcp-daemon.ts; printf 'managed-mcp:%s\n' "$?"
test -e packages/cli/src/skills/research/SKILL.md; printf 'research-skill:%s\n' "$?"
```

Expected after this plan is implemented:

```text
discover:0
mcp-commands:1
managed-mcp:1
research-skill:1
```

- [ ] **Step 6: Commit verification notes if code changed during verification**

If verification required code fixes, run:

```bash
git status --short
git add packages/context/src/search/discover.ts packages/context/src/search/discover.test.ts packages/context/src/search/index.ts packages/context/src/mcp/types.ts packages/context/src/mcp/context-tools.ts packages/context/src/mcp/server.test.ts packages/context/src/mcp/local-project-ports.ts packages/context/src/mcp/local-project-ports.test.ts packages/context/src/mcp/index.ts
git commit -m "test: verify MCP discover data"
```

Expected: commit succeeds only when there are verification fixes to commit. If `git status --short` is empty, skip this commit.

## Self-Review

- Spec coverage: this plan covers the MCP-shaped `discover_data` input/output contract, kind filtering, optional `connectionId`, RRF fusion across wiki/SL/raw lanes, deterministic summary/snippet provenance, raw `tableRef` and `columnName`, score normalization, local project MCP registration, and freshness by re-reading artifacts on every call.
- Remaining v1-blocking spec coverage after this slice: HTTP Streamable MCP daemon, `ktx mcp` CLI lifecycle commands, setup-agent MCP config writers/snippet printers, `ktx-research` skill installation, and ingest-side `connectionName` contract convergence.
- Placeholder scan: no placeholder or deferred-work wording remains in this plan.
- Type consistency: `KtxDiscoverDataInput`, `KtxDiscoverDataRef`, `KtxDiscoverDataResponse`, and `KtxDiscoverDataMcpPort` are defined before use and match the MCP/local-port registration snippets.
