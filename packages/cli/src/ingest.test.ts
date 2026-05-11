import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunnerService, type RunLoopParams } from '@ktx/context/agent';
import {
  LocalLookerRuntimeStore,
  LocalMetabaseSourceStateReader,
  MetabaseSourceAdapter,
  getLocalIngestStatus,
  type ChunkResult,
  type FetchContext,
  type IngestReportSnapshot,
  type LocalIngestResult,
  type LocalMetabaseFanoutProgress,
  type MemoryFlowEventSink,
  type MemoryFlowReplayInput,
  type MetabaseCard,
  type MetabaseCardSummary,
  type MetabaseClientFactory,
  type MetabaseRuntimeClient,
  type RunLocalIngestOptions,
  type SourceAdapter,
  type SqliteBundleIngestStore,
} from '@ktx/context/ingest';
import { initKtxProject, ktxLocalStateDbPath, loadKtxProject } from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KtxIngestArgs, runKtxIngest } from './ingest.js';
import { resetVizFallbackWarningsForTest } from './viz-fallback.js';

function makeIo(
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

async function writeWarehouseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  prod-metabase:',
      '    driver: metabase',
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

async function writeMetabaseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      'ingest:',
      '  adapters:',
      '    - metabase',
      '  embeddings:',
      '    backend: deterministic',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function bundleReportSnapshot(): IngestReportSnapshot {
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
            { target: 'wiki', type: 'created', key: 'knowledge/global/revenue.md', detail: 'Revenue overview' },
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
          artifactKey: 'knowledge/global/revenue.md',
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
          toolNames: ['ingest_triage', 'knowledge_capture', 'sl_capture'],
        },
      ],
    },
  };
}

function completedLocalBundleRun(input: RunLocalIngestOptions, jobId: string): LocalIngestResult {
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

class CliLookerSlWritingAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn(async (params: RunLoopParams) => {
    if (
      params.telemetryTags?.operationName === 'ingest-bundle-wu' &&
      params.telemetryTags?.unitKey === 'looker-explore-ecommerce-orders'
    ) {
      const slWrite = params.toolSet.sl_write_source;
      if (!slWrite?.execute) {
        throw new Error('sl_write_source tool was not available to the Looker WorkUnit');
      }
      const result = await slWrite.execute(
        {
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
        },
        { toolCallId: 'cli-looker-sl-write', messages: [] },
      );
      if (!result.structured.success) {
        throw new Error(result.markdown);
      }
    }
    return { stopReason: 'natural' as const };
  });

  constructor() {
    super({ llmProvider: { getModel: () => ({}) as never } as never });
  }
}

class CliMetabaseAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn(async () => ({ stopReason: 'natural' as const }));

  constructor() {
    super({ llmProvider: { getModel: () => ({}) as never } as never });
  }
}

class CliMetabaseSourceAdapter implements SourceAdapter {
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
    dataset_query: { type: 'native', database: 1, native: { query: 'select 101 as id' } },
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
    dataset_query: { type: 'native', database: 1, native: { query: 'select 102 as id' } },
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
    dataset_query: { type: 'native', database: 1, native: { query: 'select 103 as id' } },
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
    getNativeSql: (card) => card.dataset_query?.native?.query ?? null,
    getTemplateTags: () => ({}),
    getCardSql: async (card) => card.dataset_query?.native?.query ?? null,
    getResolvedSql: async (card) => ({
      resolvedSql: card.dataset_query?.native?.query ?? `select ${card.id} as id`,
      templateTags: [],
      resolutionStatus: 'resolved',
    }),
    cleanup: async () => undefined,
  };
}

class StaticMetabaseClientFactory implements MetabaseClientFactory {
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

async function runPublicMetabaseSyncModeCase(tempDir: string, input: SyncModeCase): Promise<void> {
  const projectDir = join(tempDir, `metabase-sync-mode-${input.name}`);
  await initKtxProject({ projectDir, projectName: `metabase-sync-mode-${input.name}` });
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      `project: metabase-sync-mode-${input.name}`,
      'connections:',
      '  prod-metabase:',
      '    driver: metabase',
      '    api_url: https://metabase.example.test',
      '    api_key: literal-test-key',
      '  warehouse_a:',
      '    driver: postgres',
      '    url: postgresql://readonly@db.example.test/warehouse_a',
      'ingest:',
      '  adapters:',
      '    - metabase',
      '  embeddings:',
      '    backend: deterministic',
      '',
    ].join('\n'),
    'utf-8',
  );

  const project = await loadKtxProject({ projectDir });
  const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(project) });
  await store.replaceSourceState({
    connectionId: 'prod-metabase',
    syncMode: input.syncMode,
    defaultTagNames: ['sync-mode-smoke'],
    selections: input.selections,
    mappings: [
      {
        metabaseDatabaseId: 1,
        metabaseDatabaseName: 'Warehouse A',
        metabaseEngine: 'postgres',
        metabaseHost: 'db.example.test',
        metabaseDbName: 'warehouse_a',
        targetConnectionId: 'warehouse_a',
        syncEnabled: true,
        source: 'refresh',
      },
    ],
  });

  const adapter = new MetabaseSourceAdapter({
    clientFactory: new StaticMetabaseClientFactory(createSyncModeMetabaseClient()),
    sourceStateReader: store,
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

  expect(io.stderr()).toBe('');
  expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
  expect(io.stdout()).toContain(`target=warehouse_a database=1 status=done job=${jobId}`);

  const report = await getLocalIngestStatus(project, jobId);
  expect(report).not.toBeNull();
  expect(report?.body.workUnits.map((wu) => wu.unitKey).sort()).toEqual(input.expectedWorkUnitKeys);
  expect(report?.body.workUnits.flatMap((wu) => wu.rawFiles).sort()).toEqual(input.expectedRawFiles);
}

function makeCliLookerRuntimeClient() {
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
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCliLookerParser() {
  return {
    parse: vi.fn().mockResolvedValue({
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

function localFakeBundleReport(jobId: string, overrides: Partial<IngestReportSnapshot> = {}): IngestReportSnapshot {
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

async function localBundleStore(projectDir: string, ids: [string, string]): Promise<SqliteBundleIngestStore> {
  const { SqliteBundleIngestStore } = await import('@ktx/context/ingest');
  const project = await loadKtxProject({ projectDir });
  return new SqliteBundleIngestStore({
    dbPath: ktxLocalStateDbPath(project),
    idFactory: (() => {
      let index = 0;
      return () => ids[index++] ?? `generated-${index}`;
    })(),
  });
}

async function persistLocalBundleReport(projectDir: string, report = bundleReportSnapshot()): Promise<void> {
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

async function writeBundleReportFile(tempDir: string, report = bundleReportSnapshot()): Promise<string> {
  const reportFile = join(tempDir, 'bundle-report.json');
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return reportFile;
}

function emitLiveLocalMemoryFlow(memoryFlow: MemoryFlowEventSink | undefined): void {
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

describe('runKtxIngest', () => {
  let tempDir: string;
  let originalTerm: string | undefined;

  beforeEach(async () => {
    resetVizFallbackWarningsForTest();
    originalTerm = process.env.TERM;
    process.env.TERM = 'xterm-256color';
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-ingest-'));
  });

  afterEach(async () => {
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs local ingest and reads status', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      const result = completedLocalBundleRun(input, 'cli-local-run-1');
      await persistLocalBundleReport(projectDir, result.report);
      return result;
    });

    const runIo = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        runIo.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'cli-local-run-1',
        },
      ),
    ).resolves.toBe(0);

    expect(runIo.stdout()).toContain('Report: report-live-1');
    expect(runIo.stdout()).toContain('Run: run-live-1');
    expect(runIo.stdout()).toContain('Job: cli-local-run-1');
    expect(runIo.stdout()).toContain('Status: done');
    expect(runIo.stdout()).toContain('Diff: +2/~0/-0/=0');
    expect(runIo.stdout()).toContain('Saved memory: 1 wiki, 1 SL');

    const statusIo = makeIo();
    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'cli-local-run-1', outputMode: 'plain' }, statusIo.io),
    ).resolves.toBe(0);

    expect(statusIo.stdout()).toContain('Report: report-live-1');
    expect(statusIo.stdout()).toContain('Run: run-live-1');
    expect(statusIo.stdout()).toContain('Job: cli-local-run-1');
    expect(statusIo.stdout()).toContain('Status: done');
    expect(statusIo.stdout()).toContain('Diff: +2/~0/-0/=0');
    expect(statusIo.stderr()).toBe('');
  });

  it('routes metabase scheduled pulls to the fan-out runner and prints child summaries', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const report = localFakeBundleReport('metabase-child-1', {
      id: 'report-metabase-child-1',
      runId: 'run-a',
      jobId: 'metabase-child-1',
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
    });

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
          runLocalMetabaseIngest: async () => ({
            metabaseConnectionId: 'prod-metabase',
            status: 'all_succeeded',
            totals: { workUnits: 2, failedWorkUnits: 0 },
            children: [
              {
                jobId: 'metabase-child-1',
                metabaseConnectionId: 'prod-metabase',
                metabaseDatabaseId: 1,
                targetConnectionId: 'warehouse_a',
                result: {
                  jobId: 'metabase-child-1',
                  runId: 'run-a',
                  syncId: 'sync-a',
                  diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
                  workUnitCount: 1,
                  failedWorkUnits: [],
                  artifactsWritten: 0,
                  commitSha: null,
                },
                report,
              },
            ],
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).toContain('warehouse_a');
    expect(io.stdout()).toContain('metabase-child-1');
    expect(io.stderr()).toBe('');
  });

  it('prints Metabase fan-out progress before the final summary', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeMetabaseConfig(projectDir);
    const io = makeIo();
    const report = localFakeBundleReport('metabase-child-1', {
      id: 'report-metabase-child-1',
      runId: 'run-a',
      jobId: 'metabase-child-1',
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
    });

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
          runLocalMetabaseIngest: async (input) => {
            const progress = (input as { progress?: LocalMetabaseFanoutProgress }).progress;
            progress?.onMetabaseFanoutPlanned?.({
              metabaseConnectionId: 'prod-metabase',
              children: [{ metabaseDatabaseId: 1, targetConnectionId: 'warehouse_a' }],
            });
            progress?.onMetabaseChildStarted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
            });
            progress?.onMetabaseChildCompleted?.({
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              jobId: 'metabase-child-1',
              status: 'done',
            });
            return {
              metabaseConnectionId: 'prod-metabase',
              status: 'all_succeeded',
              totals: { workUnits: 2, failedWorkUnits: 0 },
              children: [
                {
                  jobId: 'metabase-child-1',
                  metabaseConnectionId: 'prod-metabase',
                  metabaseDatabaseId: 1,
                  targetConnectionId: 'warehouse_a',
                  result: {
                    jobId: 'metabase-child-1',
                    runId: 'run-a',
                    syncId: 'sync-a',
                    diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
                    workUnitCount: 1,
                    failedWorkUnits: [],
                    artifactsWritten: 0,
                    commitSha: null,
                  },
                  report,
                },
              ],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Metabase ingest: prod-metabase');
    expect(io.stdout()).toContain('Targets: 1 mapped database');
    expect(io.stdout()).toContain('- database=1 target=warehouse_a status=running job=metabase-child-1');
    expect(io.stdout()).toContain('- database=1 target=warehouse_a status=done job=metabase-child-1');
    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stderr()).toBe('');
  });

  it('runs Metabase scheduled ingest through the public CLI command path with real fan-out', async () => {
    const projectDir = join(tempDir, 'metabase-cli-project');
    await initKtxProject({ projectDir, projectName: 'metabase-cli' });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: metabase-cli',
        'connections:',
        '  prod-metabase:',
        '    driver: metabase',
        '    api_url: https://metabase.example.test',
        '    api_key: literal-test-key',
        '  warehouse_a:',
        '    driver: postgres',
        '    url: postgresql://readonly@db.example.test/warehouse_a',
        '  warehouse_b:',
        '    driver: postgres',
        '    url: postgresql://readonly@db.example.test/warehouse_b',
        'ingest:',
        '  adapters:',
        '    - metabase',
        '  embeddings:',
        '    backend: deterministic',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir });
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(project) });
    await store.replaceSourceState({
      connectionId: 'prod-metabase',
      syncMode: 'ALL',
      defaultTagNames: ['ktx'],
      selections: [],
      mappings: [
        {
          metabaseDatabaseId: 1,
          metabaseDatabaseName: 'Warehouse A',
          metabaseEngine: 'postgres',
          metabaseHost: 'db.example.test',
          metabaseDbName: 'warehouse_a',
          targetConnectionId: 'warehouse_a',
          syncEnabled: true,
          source: 'refresh',
        },
        {
          metabaseDatabaseId: 2,
          metabaseDatabaseName: 'Warehouse B',
          metabaseEngine: 'postgres',
          metabaseHost: 'db.example.test',
          metabaseDbName: 'warehouse_b',
          targetConnectionId: 'warehouse_b',
          syncEnabled: true,
          source: 'refresh',
        },
      ],
    });
    const adapter = new CliMetabaseSourceAdapter();
    const agentRunner = new CliMetabaseAgentRunner();
    const childJobIds = ['metabase-child-1', 'metabase-child-2'];
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
          jobIdFactory: () => childJobIds.shift() ?? 'metabase-child-extra',
          localIngestOptions: {
            agentRunner,
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Metabase fan-out: all_succeeded');
    expect(io.stdout()).toContain('Source: prod-metabase');
    expect(io.stdout()).toContain('Children: 2');
    expect(io.stdout()).toContain('target=warehouse_a database=1 status=done job=metabase-child-1');
    expect(io.stdout()).toContain('target=warehouse_b database=2 status=done job=metabase-child-2');
    expect(adapter.fetchCalls).toEqual([
      { metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 1, connectionId: 'warehouse_a' },
      { metabaseConnectionId: 'prod-metabase', metabaseDatabaseId: 2, connectionId: 'warehouse_b' },
    ]);

    const statusIo = makeIo();
    await expect(
      runKtxIngest(
        { command: 'status', projectDir, runId: 'metabase-child-1', outputMode: 'plain' },
        statusIo.io,
      ),
    ).resolves.toBe(0);
    expect(statusIo.stdout()).toContain('Job: metabase-child-1');
    expect(statusIo.stdout()).toContain('Adapter: metabase');
    expect(statusIo.stdout()).toContain('Connection: warehouse_a');
    expect(statusIo.stderr()).toBe('');
  });

  it('runs public Metabase CLI scheduled ingest for ALL, ONLY, and EXCEPT sync modes', async () => {
    await runPublicMetabaseSyncModeCase(tempDir, {
      name: 'all',
      syncMode: 'ALL',
      selections: [],
      expectedWorkUnitKeys: ['metabase-col-12', 'metabase-col-13'],
      expectedRawFiles: [
        'cards/101.json',
        'cards/102.json',
        'cards/103.json',
        'collections/12.json',
        'collections/13.json',
      ],
    });

    await runPublicMetabaseSyncModeCase(tempDir, {
      name: 'only',
      syncMode: 'ONLY',
      selections: [{ selectionType: 'collection', metabaseObjectId: 12 }],
      expectedWorkUnitKeys: ['metabase-col-12'],
      expectedRawFiles: ['cards/101.json', 'cards/102.json', 'collections/12.json'],
    });

    await runPublicMetabaseSyncModeCase(tempDir, {
      name: 'except',
      syncMode: 'EXCEPT',
      selections: [{ selectionType: 'item', metabaseObjectId: 102 }],
      expectedWorkUnitKeys: ['metabase-col-12', 'metabase-col-13'],
      expectedRawFiles: ['cards/101.json', 'cards/103.json', 'collections/12.json', 'collections/13.json'],
    });
  });

  it('prints metabase fan-out JSON results', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeMetabaseConfig(projectDir);
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-metabase',
          adapter: 'metabase',
          outputMode: 'json',
        },
        io.io,
        {
          runLocalMetabaseIngest: async () => ({
            metabaseConnectionId: 'prod-metabase',
            status: 'all_succeeded',
            totals: { workUnits: 0, failedWorkUnits: 0 },
            children: [],
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      metabaseConnectionId: 'prod-metabase',
      status: 'all_succeeded',
      children: [],
    });
    expect(io.stderr()).toBe('');
  });

  it('rejects source-dir uploads through the metabase fan-out route', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeMetabaseConfig(projectDir);
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          adapter: 'metabase',
          connectionId: 'prod-metabase',
          sourceDir: projectDir,
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalMetabaseIngest: async () => {
            throw new Error('fan-out should not be called');
          },
        },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('source-dir uploads are not supported for the Metabase fan-out adapter');
    expect(io.stderr()).not.toContain('ktx dev ingest run requires llm.provider.backend');
    expect(io.stdout()).toBe('');
  });

  it('prints previous run and diff summary for local ingest results', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'local-job-1'));

    const io = makeIo();
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Report: report-live-1\n');
    expect(io.stdout()).toContain('Job: local-job-1\n');
    expect(io.stdout()).toContain('Diff: +2/~0/-0/=0\n');
  });

  it('passes the debug LLM request file to local ingest runs', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const runLocalIngest = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, 'job-debug'),
    );
    const io = makeIo();
    const debugFile = join(projectDir, '.ktx', 'llm-debug.jsonl');

    const exitCode = await runKtxIngest(
      {
        command: 'run',
        projectDir,
        connectionId: 'warehouse',
        adapter: 'fake',
        outputMode: 'plain',
        debugLlmRequestFile: debugFile,
      },
      io.io,
      { runLocalIngest },
    );

    expect(exitCode).toBe(0);
    expect(runLocalIngest).toHaveBeenCalledWith(expect.objectContaining({ llmDebugRequestFile: debugFile }));
  });

  it('passes daemon database introspection URL to default local ingest adapters', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    expect(createAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), {
      databaseIntrospectionUrl: 'http://127.0.0.1:8765',
    });
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: createdAdapters,
        adapter: 'fake',
        connectionId: 'warehouse',
        pullConfigOptions: {
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
        },
      }),
    );
  });

  it('passes managed daemon options to adapters and pull-config options when no explicit daemon URL is set', async () => {
    const projectDir = join(tempDir, 'managed-daemon-ingest-project');
    await initKtxProject({ projectDir, projectName: 'managed-daemon-ingest-project' });
    await writeWarehouseConfig(projectDir);
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
        },
      ),
    ).resolves.toBe(0);

    const expectedManagedDaemon = {
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
    };
    expect(createAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), {
      managedDaemon: expectedManagedDaemon,
    });
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        pullConfigOptions: {
          managedDaemon: expectedManagedDaemon,
        },
      }),
    );
  });

  it('passes the target connection id when constructing local historic-sql adapters', async () => {
    const projectDir = join(tempDir, 'historic-sql-project');
    await initKtxProject({ projectDir, projectName: 'historic-sql-project' });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: historic-sql-project',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        '      minCalls: 2',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
      'utf-8',
    );
    const createdAdapters: SourceAdapter[] = [
      { source: 'historic-sql', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-historic-job'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'historic-sql',
          outputMode: 'plain',
        },
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-historic-job',
        },
      ),
    ).resolves.toBe(0);

    expect(createAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), {
      historicSqlConnectionId: 'warehouse',
    });
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: createdAdapters,
        adapter: 'historic-sql',
        connectionId: 'warehouse',
      }),
    );
  });

  it('passes local Looker pull-config options and agent runner into scheduled ingest for Looker scheduled ingest', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const pullConfigOptions = {
      looker: {
        parser: { parse: vi.fn() },
      },
    };
    const agentRunner = { runLoop: vi.fn() } as never;
    const createdAdapters: SourceAdapter[] = [
      { source: 'fake', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
    ];
    const createAdapters = vi.fn(() => createdAdapters as never);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) =>
      completedLocalBundleRun(input, input.jobId ?? 'local-job-1'),
    );
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'plain',
        } satisfies KtxIngestArgs,
        io.io,
        {
          createAdapters,
          runLocalIngest: runLocal,
          jobIdFactory: () => 'local-job-1',
          localIngestOptions: {
            agentRunner,
            pullConfigOptions,
          },
        },
      ),
    ).resolves.toBe(0);

    expect(createAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), {
      looker: {
        parser: pullConfigOptions.looker.parser,
      },
    });
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunner,
        pullConfigOptions,
      }),
    );
  });

  it('runs Looker scheduled ingest through the public CLI command path', async () => {
    const projectDir = join(tempDir, 'looker-project');
    await initKtxProject({ projectDir, projectName: 'looker-cli' });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: looker-cli',
        'connections:',
        '  prod-looker:',
        '    driver: looker',
        '    base_url: https://looker.example.test',
        '    client_id: client',
        '  prod-warehouse:',
        '    driver: postgres',
        '    url: postgresql://readonly@db.example.test/analytics',
        'ingest:',
        '  adapters:',
        '    - looker',
      '  embeddings:',
      '    backend: deterministic',
      '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir });
    const store = new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });
    await store.setCursors('prod-looker', {
      dashboardsLastSyncedAt: null,
      looksLastSyncedAt: null,
    });
    await store.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'analytics',
      ktxConnectionId: 'prod-warehouse',
      source: 'cli',
    });
    const runtimeClient = makeCliLookerRuntimeClient();
    const parser = makeCliLookerParser();
    const agentRunner = new CliLookerSlWritingAgentRunner();
    const io = makeIo();

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'prod-looker',
          adapter: 'looker',
          outputMode: 'plain',
        },
        io.io,
        {
          jobIdFactory: () => 'cli-looker-job',
          localIngestOptions: {
            agentRunner,
            pullConfigOptions: {
              looker: {
                client: runtimeClient,
                runtimeClient,
                parser,
              },
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toBe('');
    expect(io.stdout()).toContain('Job: cli-looker-job');
    expect(io.stdout()).toContain('Adapter: looker');
    expect(io.stdout()).toContain('Connection: prod-looker');
    expect(io.stdout()).toContain('Status: done');
    expect(io.stdout()).toContain('Saved memory: 0 wiki, 1 SL');
    expect(parser.parse).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ecommerce.orders', sql_table_name: 'public.orders', dialect: 'postgres' }),
        expect.objectContaining({ key: 'ecommerce.orders.users', sql_table_name: 'public.users', dialect: 'postgres' }),
      ]),
    );
    expect(runtimeClient.cleanup).toHaveBeenCalledTimes(1);
    const slPath = join(projectDir, 'semantic-layer', 'prod-warehouse', 'looker__ecommerce__orders.yaml');
    await access(slPath);
    await expect(readFile(slPath, 'utf-8')).resolves.toContain('table: public.orders');

    const statusIo = makeIo();
    await expect(
      runKtxIngest(
        { command: 'status', projectDir, runId: 'cli-looker-job', outputMode: 'plain' },
        statusIo.io,
      ),
    ).resolves.toBe(0);
    expect(statusIo.stdout()).toContain('Job: cli-looker-job');
    expect(statusIo.stdout()).toContain('Adapter: looker');
    expect(statusIo.stderr()).toBe('');
  });

  it('renders live memory-flow frames for run --viz when stdout is interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      input.memoryFlow?.emit({ type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 1 });
      input.memoryFlow?.update({ syncId: 'sync-live-1' });
      input.memoryFlow?.emit({ type: 'raw_snapshot_written', syncId: 'sync-live-1', rawFileCount: 1 });
      input.memoryFlow?.emit({ type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 });
      input.memoryFlow?.update({
        plannedWorkUnits: [
          {
            unitKey: 'fake-orders',
            rawFiles: ['orders/orders.json'],
            peerFileCount: 0,
            dependencyCount: 0,
          },
        ],
      });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
      input.memoryFlow?.emit({ type: 'report_created', runId: 'live-viz-run' });
      input.memoryFlow?.finish('done');

      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => null);

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
          now: () => new Date('2026-04-30T14:00:00.000Z'),
        },
      ),
    ).resolves.toBe(0);

    expect(runLocal).toHaveBeenCalledWith(expect.objectContaining({ memoryFlow: expect.any(Object) }));
    expect(io.stdout()).toContain('\u001b[2J\u001b[H');
    expect((io.stdout().match(/KTX memory flow/g) ?? []).length).toBeGreaterThan(1);
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('fake-orders');
    expect(io.stderr()).toBe('');
  });

  it('uses the TUI live session for run --viz when stdin and stdout are interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
          now: () => new Date('2026-04-30T14:00:00.000Z'),
        },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).toHaveBeenCalledTimes(1);
    expect(startLiveMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'live-viz-run',
      connectionId: 'warehouse',
      adapter: 'fake',
      status: 'running',
    });
    expect(liveSession.update).toHaveBeenCalled();
    expect(liveSession.close).toHaveBeenCalledTimes(1);
    expect(io.stdout()).not.toContain('\u001b[2J\u001b[H');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toBe('');
  });

  it('prints a final plain summary after live viz completes', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-summary');
    });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'viz',
        },
        io.io,
        { runLocalIngest: runLocal, startLiveMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(liveSession.close).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Memory-flow summary: done');
    expect(io.stdout()).toContain('Connection: warehouse');
  });

  it('falls back to text live rendering when the TUI live session is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => null);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('\u001b[2J\u001b[H');
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('falls back to text live rendering when TUI startup fails with a redacted warning', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const startLiveMemoryFlow = vi.fn(
      async (_input: MemoryFlowReplayInput, ioArg: { stderr: { write(chunk: string): void } }) => {
        ioArg.stderr.write('TUI visualization unavailable: Failed [redacted-url] [redacted]; using text renderer.\n');
        return null;
      },
    );
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('TUI visualization unavailable: Failed [redacted-url] [redacted]');
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('\u001b[2J\u001b[H');
  });

  it('does not start live TUI when run --viz disables input', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      return completedLocalBundleRun(input, 'no-input-live-viz-run');
    });
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => ({
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    }));
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
        { runLocalIngest: runLocal, startLiveMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).not.toHaveBeenCalled();
    expect(runLocal).toHaveBeenCalledWith(expect.not.objectContaining({ memoryFlow: expect.anything() }));
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('does not attach a live memory-flow sink for plain run output', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'plain-run'));
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        { runLocalIngest: runLocal },
      ),
    ).resolves.toBe(0);

    expect(runLocal).toHaveBeenCalledWith(expect.not.objectContaining({ memoryFlow: expect.anything() }));
    expect(io.stdout()).toContain('Job: plain-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
  });

  it('falls back to plain run output for run --viz when stdout is not interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const io = makeIo({ isTTY: false });
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'non-tty-viz-run'));
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'non-tty-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Job: non-tty-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('falls back to plain run output for run --viz when stdin raw mode is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const io = makeIo({ isTTY: true, stdinIsTTY: true, rawMode: false, columns: 120 });
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'raw-missing-viz-run'));
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => ({
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    }));

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'raw-missing-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).not.toHaveBeenCalled();
    expect(runLocal).toHaveBeenCalledWith(expect.not.objectContaining({ memoryFlow: expect.anything() }));
    expect(io.stdout()).toContain('Job: raw-missing-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdin raw mode is unavailable; printing plain output.',
    );
  });

  it('returns an error code for missing status', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    const io = makeIo();

    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'missing-run', outputMode: 'plain' }, io.io),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Local ingest run or report "missing-run" was not found');
  });

  it('uses the latest local ingest report when status has no run id', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    await persistLocalBundleReport(projectDir, localFakeBundleReport('older-run'));
    await persistLocalBundleReport(projectDir, localFakeBundleReport('newer-run'));
    const io = makeIo();

    await expect(runKtxIngest({ command: 'status', projectDir, outputMode: 'plain' }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-newer-run');
    expect(io.stdout()).toContain('Job: newer-run');
    expect(io.stderr()).toBe('');
  });

  it('renders the latest local ingest report through watch when run id is omitted', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    await persistLocalBundleReport(projectDir, localFakeBundleReport('watch-latest'));
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest({ command: 'watch', projectDir, outputMode: 'viz', inputMode: 'disabled' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('Run: run-watch-latest');
    expect(io.stderr()).toBe('');
  });

  it('renders report-file replay through the memory-flow TUI', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'job-1',
          reportFile,
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/metabase  done');
    expect(io.stdout()).toContain('Saved 2 memories from 2 raw files');
    expect(io.stdout()).toContain('Commit: abc12345  Run: run-1  Report: report-1');
    expect(io.stdout()).toContain('SOURCE');
    expect(io.stdout()).toContain('ACTIONS');
    expect(io.stdout()).toContain('SAVED');
    expect(io.stderr()).toBe('');
  });

  it('prints report-file JSON without looking up local ingest status', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo();

    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'report-1', reportFile, outputMode: 'json' }, io.io),
    ).resolves.toBe(0);

    const parsed = JSON.parse(io.stdout());
    expect(parsed).toMatchObject({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
    });
    expect(io.stderr()).toBe('');
  });

  it('routes interactive report-file replay through the stored TUI renderer', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'run-1',
          reportFile,
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(renderStoredMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-1',
      reportId: 'report-1',
      connectionId: 'warehouse',
      adapter: 'metabase',
    });
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('rejects report-file replay when the requested id does not match the report', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo();

    await expect(
      runKtxIngest({ command: 'replay', projectDir, runId: 'unrelated-id', reportFile, outputMode: 'plain' }, io.io),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain(
      `Report file ${reportFile} does not match ingest replay id "unrelated-id"; expected one of report-1, run-1, job-1`,
    );
    expect(io.stdout()).toBe('');
  });

  it('renders memory-flow snapshot for status --viz when stdout is interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('viz-run-1'));

    const io = makeIo({ isTTY: true });
    await expect(
      runKtxIngest(
        { command: 'status', projectDir, runId: 'viz-run-1', outputMode: 'viz', inputMode: 'disabled' },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('SOURCE');
    expect(io.stdout()).toContain('CHUNKS');
    expect(io.stdout()).toContain('WORKUNITS');
    expect(io.stdout()).toContain('Saved 2 memories from 2 raw files');
    expect(io.stderr()).toBe('');
  });

  it('uses the TUI renderer for stored status --viz when stdin and stdout are interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('tui-viz-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          runId: 'tui-viz-run',
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(renderStoredMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-tui-viz-run',
      connectionId: 'warehouse',
      adapter: 'fake',
    });
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('falls back to the text renderer when TUI declines stored status --viz', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('tui-fallback-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120, keypresses: [{ name: 'q' }] });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => false);

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          runId: 'tui-fallback-run',
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('does not use TUI for stored --viz when input is disabled', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('tui-no-input-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'tui-no-input-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('falls back to plain status for stored --viz when stdin raw mode is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('raw-missing-stored-viz-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, rawMode: false, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'raw-missing-stored-viz-run',
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Run: run-raw-missing-stored-viz-run');
    expect(io.stdout()).toContain('Job: raw-missing-stored-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdin raw mode is unavailable; printing plain output.',
    );
  });

  it('keeps stored --viz snapshot-only when input is disabled', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('no-input-viz-run'));

    const io = makeIo({ isTTY: true, columns: 120 });
    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'no-input-viz-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).not.toContain('\u001b[2J\u001b[H');
    expect(io.stderr()).toBe('');
  });

  it('keeps disabled-input stored --viz snapshot output even when stdin raw mode is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('disabled-raw-missing-viz-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, rawMode: false, columns: 120 });
    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'disabled-raw-missing-viz-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).not.toContain('\u001b[2J\u001b[H');
    expect(io.stderr()).toBe('');
  });

  it('degrades stored --viz snapshots to plain status when stdout is redirected even when input is disabled', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('redirected-no-input-viz-run'));

    const io = makeIo({ isTTY: false });
    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'redirected-no-input-viz-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-redirected-no-input-viz-run');
    expect(io.stdout()).toContain('Job: redirected-no-input-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('degrades ingest replay --viz to plain status when TERM is dumb', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('dumb-terminal-viz-run'));

    const io = makeIo({ isTTY: true });
    await expect(
      runKtxIngest(
        { command: 'replay', projectDir, runId: 'dumb-terminal-viz-run', outputMode: 'viz' },
        io.io,
        { env: { ...process.env, TERM: 'dumb' } },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-dumb-terminal-viz-run');
    expect(io.stdout()).toContain('Job: dumb-terminal-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but TERM=dumb does not support the visual renderer; printing plain output.',
    );
  });

  it('falls back to plain status for --viz when stdout is not interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('viz-run-2'));

    const io = makeIo({ isTTY: false });
    await expect(
      runKtxIngest({ command: 'replay', projectDir, runId: 'viz-run-2', outputMode: 'viz' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-viz-run-2');
    expect(io.stdout()).toContain('Job: viz-run-2');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('prints JSON for status --json', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('json-run-1'));

    const io = makeIo();
    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'json-run-1', outputMode: 'json' }, io.io),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      runId: 'run-json-run-1',
      jobId: 'json-run-1',
      sourceKey: 'fake',
      connectionId: 'warehouse',
    });
    expect(io.stderr()).toBe('');
  });
});
