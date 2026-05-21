import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunnerPort, RunLoopParams } from './context/llm/runtime-port.js';
import { KtxYamlMetabaseSourceStateReader, LocalMetabaseDiscoveryCache } from './context/ingest/adapters/metabase/local-source-state-store.js';
import { MetabaseSourceAdapter } from './context/ingest/adapters/metabase/metabase.adapter.js';
import { getLocalIngestStatus, type LocalIngestResult, type RunLocalIngestOptions } from './context/ingest/local-ingest.js';
import type { ChunkResult, FetchContext, SourceAdapter } from './context/ingest/types.js';
import type { IngestReportSnapshot } from './context/ingest/reports.js';
import type { LookerMappingClient, LookerTableIdentifierParser } from './context/ingest/adapters/looker/mapping.js';
import type { LookerRuntimeClient } from './context/ingest/adapters/looker/fetch.js';
import type { MemoryFlowEventSink } from './context/ingest/memory-flow/types.js';
import type { MetabaseCard, MetabaseCardSummary, MetabaseClientFactory, MetabaseRuntimeClient } from './context/ingest/adapters/metabase/client-port.js';
import type { SqliteBundleIngestStore } from './context/ingest/sqlite-bundle-ingest-store.js';
import { ktxLocalStateDbPath } from './context/project/local-state-db.js';
import { loadKtxProject } from './context/project/project.js';
import { expect, vi } from 'vitest';
import { runKtxIngest } from './ingest.js';

export function makeIo(
  options: {
    isTTY?: boolean;
    stdinIsTTY?: boolean;
    columns?: number;
    rawMode?: boolean;
    keypresses?: { name?: string; ctrl?: boolean }[];
  } = {},
) {
  let stdout = '';
  let stderr = '';
  type TestKey = { name?: string; ctrl?: boolean };

  class TestStdin extends EventEmitter {
    isTTY = options.stdinIsTTY ?? false;
    isRaw = false;

    setRawMode =
      options.rawMode === false
        ? undefined
        : (value: boolean): void => {
            this.isRaw = value;
          };

    resume(): void {
      return undefined;
    }

    pause(): void {
      return undefined;
    }

    override on(eventName: string | symbol, listener: (chunk: string, key: TestKey) => void): this {
      const result = super.on(eventName, listener);
      if (eventName === 'keypress') {
        for (const key of options.keypresses ?? []) {
          queueMicrotask(() => listener('', key));
        }
      }
      return result;
    }

    override off(eventName: string | symbol, listener: (chunk: string, key: TestKey) => void): this {
      return super.off(eventName, listener);
    }

    override removeListener(eventName: string | symbol, listener: (chunk: string, key: TestKey) => void): this {
      return super.removeListener(eventName, listener);
    }
  }

  const stdin = new TestStdin();

  return {
    io: {
      stdin,
      stdout: {
        isTTY: options.isTTY,
        columns: options.columns,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export async function writeWarehouseConfig(projectDir: string): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  prod-metabase:',
      '    driver: metabase',
      '    api_url: https://metabase.example.test',
      '  warehouse_a:',
      '    driver: postgres',
      'ingest:',
      '  adapters:',
      '    - fake',
      '',
    ].join('\n'),
    'utf-8',
  );
}

export async function writeMetabaseConfig(projectDir: string): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      'ingest:',
      '  adapters:',
      '    - metabase',
      '  embeddings:',
      '    backend: none',
      '',
    ].join('\n'),
    'utf-8',
  );
}

export function bundleReportSnapshot(): IngestReportSnapshot {
  return {
    id: 'report-1',
    runId: 'run-1',
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    createdAt: '2026-04-30T12:00:00.000Z',
    body: {
      syncId: 'sync-1',
      diffSummary: { added: 2, modified: 0, deleted: 0, unchanged: 0 },
      commitSha: 'abc12345',
      workUnits: [
        {
          unitKey: 'cards',
          rawFiles: ['cards/1.json', 'cards/2.json'],
          status: 'success',
          actions: [
            { target: 'wiki', type: 'created', key: 'wiki/global/revenue.md', detail: 'Revenue overview' },
            { target: 'sl', type: 'updated', key: 'warehouse.orders', detail: 'Added order amount measure' },
          ],
          touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'warehouse.orders' }],
        },
      ],
      failedWorkUnits: [],
      reconciliationSkipped: false,
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [
        {
          rawPath: 'cards/1.json',
          artifactKind: 'wiki',
          artifactKey: 'wiki/global/revenue.md',
          actionType: 'wiki_written',
        },
        {
          rawPath: 'cards/2.json',
          artifactKind: 'sl',
          artifactKey: 'warehouse.orders',
          actionType: 'measure_added',
        },
      ],
      toolTranscripts: [
        {
          unitKey: 'cards',
          path: 'tool-transcripts/cards.jsonl',
          toolCallCount: 4,
          errorCount: 0,
          toolNames: ['ingest_triage', 'wiki_capture', 'sl_capture'],
        },
      ],
    },
  };
}

export function completedLocalBundleRun(input: RunLocalIngestOptions, jobId: string): LocalIngestResult {
  const nextReport = localFakeBundleReport(jobId, {
    id: 'report-live-1',
    runId: 'run-live-1',
    connectionId: input.connectionId,
    sourceKey: input.adapter,
  });
  return {
    result: {
      jobId,
      runId: nextReport.runId,
      syncId: nextReport.body.syncId,
      diffSummary: nextReport.body.diffSummary,
      workUnitCount: nextReport.body.workUnits.length,
      failedWorkUnits: nextReport.body.failedWorkUnits,
      artifactsWritten: nextReport.body.provenanceRows.length,
      commitSha: nextReport.body.commitSha,
    },
    report: nextReport,
  };
}

export function failedLocalBundleRun(input: RunLocalIngestOptions, jobId: string): LocalIngestResult {
  const failedWorkUnit = {
    ...bundleReportSnapshot().body.workUnits[0],
    status: 'failed' as const,
    reason: 'writer tool failed',
    actions: [],
    touchedSlSources: [],
  };
  const nextReport = localFakeBundleReport(jobId, {
    id: 'report-failed-1',
    runId: 'run-failed-1',
    connectionId: input.connectionId,
    sourceKey: input.adapter,
    body: {
      workUnits: [failedWorkUnit],
      failedWorkUnits: [failedWorkUnit.unitKey],
    },
  });
  return {
    result: {
      jobId,
      runId: nextReport.runId,
      syncId: nextReport.body.syncId,
      diffSummary: nextReport.body.diffSummary,
      workUnitCount: nextReport.body.workUnits.length,
      failedWorkUnits: nextReport.body.failedWorkUnits,
      artifactsWritten: nextReport.body.provenanceRows.length,
      commitSha: nextReport.body.commitSha,
    },
    report: nextReport,
  };
}

export class CliLookerSlWritingAgentRunner implements AgentRunnerPort {
  runLoop = vi.fn(async (params: RunLoopParams) => {
    if (
      params.telemetryTags?.operationName === 'ingest-bundle-wu' &&
      params.telemetryTags?.unitKey === 'looker-explore-ecommerce-orders'
    ) {
      const ledger = params.toolSet.record_verification_ledger;
      if (!ledger?.execute) {
        throw new Error('record_verification_ledger tool was not available to the Looker WorkUnit');
      }
      await ledger.execute({
        summary: 'Test fixture verified Looker explore target identifiers before writing SL.',
        verifiedIdentifiers: ['prod-warehouse', 'public.orders'],
        unverifiedIdentifiers: [],
      });
      const slWrite = params.toolSet.sl_write_source;
      if (!slWrite?.execute) {
        throw new Error('sl_write_source tool was not available to the Looker WorkUnit');
      }
      const result = await slWrite.execute({
        connectionId: 'prod-warehouse',
        sourceName: 'looker__ecommerce__orders',
        source: {
          name: 'looker__ecommerce__orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [
            { name: 'id', type: 'number' },
            { name: 'revenue', type: 'number' },
          ],
          measures: [{ name: 'total_revenue', expr: 'sum(revenue)' }],
        },
      });
      if (!(result.structured as { success?: boolean } | undefined)?.success) {
        throw new Error(result.markdown);
      }
    }
    return { stopReason: 'natural' as const };
  });
}

export class CliMetabaseAgentRunner implements AgentRunnerPort {
  runLoop = vi.fn(async () => ({ stopReason: 'natural' as const }));
}

export class CliMetabaseSourceAdapter implements SourceAdapter {
  readonly source = 'metabase';
  readonly skillNames: string[] = [];
  readonly fetchCalls: Array<{ metabaseConnectionId: string; metabaseDatabaseId: number; connectionId: string }> = [];
  private readonly databaseByStagedDir = new Map<string, number>();

  detect(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const config = pullConfig as { metabaseConnectionId: string; metabaseDatabaseId: number };
    this.fetchCalls.push({
      metabaseConnectionId: config.metabaseConnectionId,
      metabaseDatabaseId: config.metabaseDatabaseId,
      connectionId: ctx.connectionId,
    });
    this.databaseByStagedDir.set(stagedDir, config.metabaseDatabaseId);
    await mkdir(join(stagedDir, 'cards'), { recursive: true });
    await mkdir(join(stagedDir, 'databases'), { recursive: true });
    await writeFile(
      join(stagedDir, 'cards', `${config.metabaseDatabaseId}.json`),
      JSON.stringify({ connectionId: ctx.connectionId, databaseId: config.metabaseDatabaseId }),
      'utf-8',
    );
    await writeFile(
      join(stagedDir, 'databases', `${config.metabaseDatabaseId}.json`),
      JSON.stringify({ metabaseConnectionId: config.metabaseConnectionId }),
      'utf-8',
    );
  }

  async chunk(stagedDir: string): Promise<ChunkResult> {
    const databaseId = this.databaseByStagedDir.get(stagedDir);
    if (!databaseId) {
      throw new Error(`Missing Metabase database id for staged dir ${stagedDir}`);
    }
    return {
      workUnits: [
        {
          unitKey: `metabase-db-${databaseId}`,
          rawFiles: [`cards/${databaseId}.json`],
          peerFileIndex: [],
          dependencyPaths: [`databases/${databaseId}.json`],
        },
      ],
    };
  }
}

const SYNC_MODE_METABASE_CARDS: MetabaseCard[] = [
  {
    id: 101,
    name: 'Collection 12 Revenue',
    description: null,
    type: 'question',
    query_type: 'native',
    database_id: 1,
    collection_id: 12,
    archived: false,
    result_metadata: [],
    dataset_query: { type: 'native', database: 1, stages: [{ 'lib/type': 'mbql.stage/native', native: 'select 101 as id' }] },
    parameters: [],
    dashboard_count: 0,
  },
  {
    id: 102,
    name: 'Collection 12 Margin',
    description: null,
    type: 'question',
    query_type: 'native',
    database_id: 1,
    collection_id: 12,
    archived: false,
    result_metadata: [],
    dataset_query: { type: 'native', database: 1, stages: [{ 'lib/type': 'mbql.stage/native', native: 'select 102 as id' }] },
    parameters: [],
    dashboard_count: 0,
  },
  {
    id: 103,
    name: 'Collection 13 Pipeline',
    description: null,
    type: 'question',
    query_type: 'native',
    database_id: 1,
    collection_id: 13,
    archived: false,
    result_metadata: [],
    dataset_query: { type: 'native', database: 1, stages: [{ 'lib/type': 'mbql.stage/native', native: 'select 103 as id' }] },
    parameters: [],
    dashboard_count: 0,
  },
];

function metabaseCardSummary(card: MetabaseCard): MetabaseCardSummary {
  return {
    id: card.id,
    name: card.name,
    archived: card.archived,
    database_id: card.database_id,
    collection_id: card.collection_id,
  };
}

function createSyncModeMetabaseClient(): MetabaseRuntimeClient {
  const cardsById = new Map(SYNC_MODE_METABASE_CARDS.map((card) => [card.id, card]));
  return {
    testConnection: async () => ({ success: true }),
    getCurrentUser: async () => ({ id: 1, email: 'local@example.test' }),
    getDatabases: async () => [{ id: 1, name: 'Warehouse A', engine: 'postgres' }],
    getDatabase: async (id) => ({ id, name: 'Warehouse A', engine: 'postgres' }),
    getCollectionTree: async () => [
      { id: 12, name: 'Selected Collection', parent_id: 'root', children: [] },
      { id: 13, name: 'Other Collection', parent_id: 'root', children: [] },
    ],
    getCollection: async (id) => ({
      id,
      name: id === 12 ? 'Selected Collection' : 'Other Collection',
      parent_id: 'root',
      children: [],
    }),
    getCollectionItems: async (collectionId) =>
      SYNC_MODE_METABASE_CARDS.filter((card) => card.collection_id === collectionId).map((card) => ({
        id: card.id,
        model: 'card',
        name: card.name,
        collection_id: card.collection_id,
        database_id: card.database_id,
      })),
    getCard: async (id) => {
      const card = cardsById.get(id);
      if (!card) {
        throw new Error(`unexpected card ${id}`);
      }
      return card;
    },
    getAllCards: async () => SYNC_MODE_METABASE_CARDS.map(metabaseCardSummary),
    convertMbqlToNative: async () => ({ query: 'select 1' }),
    getNativeSql: (card) => card.dataset_query?.stages?.[0]?.native ?? null,
    getTemplateTags: () => ({}),
    getCardSql: async (card) => card.dataset_query?.stages?.[0]?.native ?? null,
    getResolvedSql: async (card) => ({
      resolvedSql: card.dataset_query?.stages?.[0]?.native ?? `select ${card.id} as id`,
      templateTags: [],
      resolutionStatus: 'resolved',
    }),
    cleanup: async () => undefined,
  };
}

export class StaticMetabaseClientFactory implements MetabaseClientFactory {
  constructor(private readonly client: MetabaseRuntimeClient) {}

  createClient(): MetabaseRuntimeClient {
    return this.client;
  }
}

type SyncModeCase = {
  name: string;
  syncMode: 'ALL' | 'ONLY' | 'EXCEPT';
  selections: Array<{ selectionType: 'collection' | 'item'; metabaseObjectId: number }>;
  expectedRawFiles: string[];
  expectedWorkUnitKeys: string[];
};

export async function runPublicMetabaseSyncModeCase(tempDir: string, input: SyncModeCase): Promise<void> {
  const projectDir = join(tempDir, `metabase-sync-mode-${input.name}`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  prod-metabase:',
      '    driver: metabase',
      '    api_url: https://metabase.example.test',
      '    api_key: literal-test-key',
      '    mappings:',
      '      databaseMappings:',
      '        "1": warehouse_a',
      '      syncEnabled:',
      '        "1": true',
      `      syncMode: ${input.syncMode}`,
      '      selections:',
      `        collections: [${input.selections
        .filter((selection) => selection.selectionType === 'collection')
        .map((selection) => selection.metabaseObjectId)
        .join(', ')}]`,
      `        items: [${input.selections
        .filter((selection) => selection.selectionType === 'item')
        .map((selection) => selection.metabaseObjectId)
        .join(', ')}]`,
      '      defaultTagNames:',
      '        - sync-mode-smoke',
      '  warehouse_a:',
      '    driver: postgres',
      '    url: postgresql://readonly@db.example.test/warehouse_a',
      'ingest:',
      '  adapters:',
      '    - metabase',
      '  embeddings:',
      '    backend: none',
      '',
    ].join('\n'),
    'utf-8',
  );

  const project = await loadKtxProject({ projectDir });
  const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(project) });
  await discoveryCache.refreshDiscoveredDatabases({
    connectionId: 'prod-metabase',
    discovered: [{ id: 1, name: 'Warehouse A', engine: 'postgres', host: 'db.example.test', dbName: 'warehouse_a' }],
  });

  const adapter = new MetabaseSourceAdapter({
    clientFactory: new StaticMetabaseClientFactory(createSyncModeMetabaseClient()),
    sourceStateReader: new KtxYamlMetabaseSourceStateReader(project, { discoveryCache }),
  });
  const jobId = `metabase-sync-mode-${input.name}-child`;
  const io = makeIo();

  await expect(
    runKtxIngest(
      {
        command: 'run',
        projectDir,
        connectionId: 'prod-metabase',
        adapter: 'metabase',
        outputMode: 'plain',
      },
      io.io,
      {
        createAdapters: vi.fn(() => [adapter]),
        jobIdFactory: () => jobId,
        localIngestOptions: {
          agentRunner: new CliMetabaseAgentRunner(),
        },
      },
    ),
  ).resolves.toBe(0);

  expect(io.stderr()).toContain('Metabase ingest: prod-metabase');
  expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
  expect(io.stdout()).toContain(`target=warehouse_a database=1 status=done job=${jobId}`);

  const report = await getLocalIngestStatus(project, jobId);
  expect(report).not.toBeNull();
  expect(report?.body.workUnits.map((wu) => wu.unitKey).sort()).toEqual(input.expectedWorkUnitKeys);
  expect(report?.body.workUnits.flatMap((wu) => wu.rawFiles).sort()).toEqual(input.expectedRawFiles);
}

type CliLookerRuntimeClient = LookerRuntimeClient &
  Pick<LookerMappingClient, 'listLookerConnections'> & {
    cleanup: ReturnType<typeof vi.fn<NonNullable<LookerRuntimeClient['cleanup']>>>;
  };

export function makeCliLookerRuntimeClient(): CliLookerRuntimeClient {
  const lookerModels = {
    source: 'looker',
    fetchedAt: '2026-05-05T00:00:00.000Z',
    models: [{ name: 'ecommerce', label: 'Ecommerce', explores: [{ name: 'orders', label: 'Orders' }] }],
  };
  const lookerExplore = {
    source: 'looker',
    modelName: 'ecommerce',
    exploreName: 'orders',
    label: 'Orders',
    description: null,
    connectionName: 'analytics',
    viewName: 'orders',
    rawSqlTableName: 'public.orders',
    fields: {
      dimensions: [{ name: 'orders.id', label: null, type: null, sql: null, description: null }],
      measures: [{ name: 'orders.revenue', label: null, type: null, sql: null, description: null }],
    },
    joins: [
      {
        name: 'users',
        type: 'left_outer',
        relationship: 'many_to_one',
        rawSqlTableName: 'public.users',
        sqlOn: '${orders.user_id} = ${users.id}',
        from: null,
        targetTable: null,
      },
    ],
    targetWarehouseConnectionId: null,
    targetTable: null,
  };

  return {
    listLookerConnections: vi.fn().mockResolvedValue([
      {
        name: 'analytics',
        host: 'db.example.test',
        database: 'analytics',
        schema: null,
        dialect: 'postgres',
      },
    ]),
    listDashboards: vi.fn().mockResolvedValue([{ id: '10', updatedAt: '2026-05-05T08:00:00.000Z' }]),
    getDashboard: vi.fn().mockResolvedValue({
      lookerId: '10',
      title: 'Revenue Overview',
      description: 'Revenue dashboard',
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-05-05T08:00:00.000Z',
      tiles: [{ id: '100', title: 'Revenue', lookId: null, query: { model: 'ecommerce', view: 'orders' } }],
    }),
    listLooks: vi.fn().mockResolvedValue([{ id: '20', updatedAt: '2026-05-05T08:10:00.000Z' }]),
    getLook: vi.fn().mockResolvedValue({
      lookerId: '20',
      title: 'Revenue Look',
      description: null,
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-05-05T08:10:00.000Z',
      query: { model: 'ecommerce', view: 'orders', fields: ['orders.revenue'] },
    }),
    listFolders: vi.fn().mockResolvedValue({ folders: [{ id: '7', name: 'Shared', parentId: null, path: ['Shared'] }] }),
    listUsers: vi.fn().mockResolvedValue([{ id: '3', displayName: 'Ada Lovelace', email: 'ada@example.test' }]),
    listGroups: vi.fn().mockResolvedValue([{ id: '4', name: 'Analysts' }]),
    listLookmlModels: vi.fn().mockResolvedValue(lookerModels),
    getExplore: vi.fn().mockResolvedValue(lookerExplore),
    getSignals: vi.fn().mockResolvedValue({
      dashboardUsage: [{ contentId: '10', queryCount30d: 12, uniqueUsers30d: 3, lastRunAt: null, topUsers: ['3'] }],
      lookUsage: [{ contentId: '20', queryCount30d: 4, uniqueUsers30d: 2, lastRunAt: null, topUsers: ['3'] }],
      scheduledPlans: [
        { contentId: '10', contentType: 'dashboard', isScheduled: true, scheduleCount: 1, recipientCount: 4 },
      ],
      favorites: [{ contentId: '10', contentType: 'dashboard', favoriteCount: 2 }],
    }),
    cleanup: vi.fn<NonNullable<LookerRuntimeClient['cleanup']>>().mockResolvedValue(undefined),
  };
}

interface TestLookerTableIdentifierParser extends LookerTableIdentifierParser {
  parse: ReturnType<typeof vi.fn<LookerTableIdentifierParser['parse']>>;
}

export function makeCliLookerParser(): TestLookerTableIdentifierParser {
  return {
    parse: vi.fn<LookerTableIdentifierParser['parse']>().mockResolvedValue({
      'ecommerce.orders': {
        ok: true,
        catalog: null,
        schema: 'public',
        name: 'orders',
        canonical_table: 'public.orders',
      },
      'ecommerce.orders.users': {
        ok: true,
        catalog: null,
        schema: 'public',
        name: 'users',
        canonical_table: 'public.users',
      },
    }),
  };
}

export function localFakeBundleReport(
  jobId: string,
  overrides: Partial<Omit<IngestReportSnapshot, 'body'>> & { body?: Partial<IngestReportSnapshot['body']> } = {},
): IngestReportSnapshot {
  const report = bundleReportSnapshot();
  return {
    ...report,
    id: `report-${jobId}`,
    runId: `run-${jobId}`,
    jobId,
    connectionId: 'warehouse',
    sourceKey: 'fake',
    ...overrides,
    body: {
      ...report.body,
      syncId: 'sync-live-1',
      ...(overrides.body ?? {}),
    },
  };
}

export async function localBundleStore(projectDir: string, ids: [string, string]): Promise<SqliteBundleIngestStore> {
  const { SqliteBundleIngestStore } = await import('./context/ingest/sqlite-bundle-ingest-store.js');;
  const project = await loadKtxProject({ projectDir });
  return new SqliteBundleIngestStore({
    dbPath: ktxLocalStateDbPath(project),
    idFactory: (() => {
      let index = 0;
      return () => ids[index++] ?? `generated-${index}`;
    })(),
  });
}

export async function persistLocalBundleReport(projectDir: string, report = bundleReportSnapshot()): Promise<void> {
  const store = await localBundleStore(projectDir, [report.runId, report.id]);
  const run = await store.create({
    jobId: report.jobId,
    connectionId: report.connectionId,
    sourceKey: report.sourceKey,
    syncId: report.body.syncId,
    trigger: 'manual_resync',
  });
  await store.markCompleted(run.id, report.body.diffSummary);
  await store.create({
    runId: run.id,
    jobId: report.jobId,
    connectionId: report.connectionId,
    sourceKey: report.sourceKey,
    body: report.body,
  });
}

export async function writeBundleReportFile(tempDir: string, report = bundleReportSnapshot()): Promise<string> {
  const reportFile = join(tempDir, 'bundle-report.json');
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return reportFile;
}

export function emitLiveLocalMemoryFlow(memoryFlow: MemoryFlowEventSink | undefined): void {
  memoryFlow?.emit({ type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 1 });
  memoryFlow?.update({ syncId: 'sync-live-1' });
  memoryFlow?.emit({ type: 'raw_snapshot_written', syncId: 'sync-live-1', rawFileCount: 1 });
  memoryFlow?.emit({ type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 });
  memoryFlow?.update({
    plannedWorkUnits: [
      {
        unitKey: 'fake-orders',
        rawFiles: ['orders/orders.json'],
        peerFileCount: 0,
        dependencyCount: 0,
      },
    ],
  });
  memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
  memoryFlow?.emit({ type: 'report_created', runId: 'live-viz-run' });
  memoryFlow?.finish('done');
}
