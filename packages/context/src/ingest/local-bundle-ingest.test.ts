import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AgentRunnerService } from '../agent/index.js';
import { initKtxProject, type KtxLocalProject, loadKtxProject } from '../project/index.js';
import { makeLocalGitRepo } from '../test/make-local-git-repo.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSourceAdapter } from './adapters/fake/fake.adapter.js';
import { LocalLookerRuntimeStore } from './adapters/looker/local-runtime-store.js';
import { createDefaultLocalIngestAdapters, localPullConfigForAdapter } from './local-adapters.js';
import { getLocalIngestStatus, runLocalIngest } from './local-ingest.js';

class TestAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' as const });

  constructor() {
    super({ llmProvider: { getModel: () => ({}) as never } as never });
  }
}

class LookerSlWritingAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn(async (params: any) => {
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
        { toolCallId: 'looker-sl-write' },
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

class WikiWritingAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn(async (params: any) => {
    if (params.telemetryTags?.operationName === 'ingest-bundle-wu') {
      const wikiWrite = params.toolSet.wiki_write;
      if (!wikiWrite?.execute) {
        throw new Error('wiki_write tool was not available to the WorkUnit');
      }
      const result = await wikiWrite.execute(
        {
          key: 'orders_context',
          summary: 'Orders source context',
          content: 'Orders are purchase records used for revenue analysis.',
          tags: ['orders'],
        },
        { toolCallId: 'wiki-write' },
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

function makeLookerRuntimeClient() {
  const lookerModels = {
    models: [{ name: 'ecommerce', label: 'Ecommerce', explores: [{ name: 'orders', label: 'Orders' }] }],
  };
  const lookerExplore = {
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

function makeLookerParser() {
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

describe('canonical local ingest', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-full-ingest-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        'ingest:',
        '  adapters:',
        '    - fake',
        '  embeddings:',
        '    backend: deterministic',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs the full IngestBundleRunner through local ports and stores a bundle report', async () => {
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const agentRunner = new TestAgentRunner();

    const result = await runLocalIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'full-local-1',
      agentRunner,
    });

    expect(agentRunner.runLoop).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({
      jobId: 'full-local-1',
      runId: expect.any(String),
      workUnitCount: 1,
      failedWorkUnits: [],
    });
    expect(result.report).toMatchObject({
      jobId: 'full-local-1',
      connectionId: 'warehouse',
      sourceKey: 'fake',
      body: {
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        failedWorkUnits: [],
        workUnits: [
          expect.objectContaining({
            unitKey: 'fake-orders',
            status: 'success',
            rawFiles: ['orders/orders.json'],
          }),
        ],
      },
    });
    expect(result.report.body.provenanceRows).toEqual([
      {
        rawPath: 'orders/orders.json',
        artifactKind: null,
        artifactKey: null,
        targetConnectionId: null,
        actionType: 'skipped',
      },
    ]);

    const stagedRawPath = join(
      project.projectDir,
      'raw-sources',
      'warehouse',
      'fake',
      result.report.body.syncId,
      'orders',
      'orders.json',
    );
    await expect(readFile(stagedRawPath, 'utf-8')).resolves.toBe('{"name":"orders"}\n');

    await expect(getLocalIngestStatus(project, result.report.id)).resolves.toMatchObject({
      id: result.report.id,
      jobId: 'full-local-1',
    });
    await expect(getLocalIngestStatus(project, result.report.runId)).resolves.toMatchObject({
      id: result.report.id,
      jobId: 'full-local-1',
    });
    await expect(getLocalIngestStatus(project, 'full-local-1')).resolves.toMatchObject({
      id: result.report.id,
      jobId: 'full-local-1',
    });
  });

  it('indexes wiki pages written by local ingest into the SQLite knowledge tables', async () => {
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
    const agentRunner = new WikiWritingAgentRunner();

    const result = await runLocalIngest({
      project,
      adapters: [new FakeSourceAdapter()],
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir,
      jobId: 'wiki-local-1',
      agentRunner,
    });

    expect(result.result.failedWorkUnits).toEqual([]);
    const db = new Database(join(project.projectDir, '.ktx', 'db.sqlite'), { readonly: true });
    try {
      expect(db.prepare('SELECT key, summary FROM knowledge_pages ORDER BY key').all()).toEqual([
        { key: 'orders_context', summary: 'Orders source context' },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects direct Metabase scheduled pulls before requiring a local ingest LLM provider', async () => {
    const projectDir = join(tempDir, 'metabase-project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });
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
    const metabaseProject = await loadKtxProject({ projectDir });

    await expect(
      runLocalIngest({
        project: metabaseProject,
        adapters: createDefaultLocalIngestAdapters(metabaseProject),
        adapter: 'metabase',
        connectionId: 'warehouse',
        jobId: 'metabase-local',
      }),
    ).rejects.toThrow('Metabase scheduled pulls fan out by mapping');
  });

  it('runs full MetricFlow local ingest from a dbt repo fixture through the canonical runner', async () => {
    const projectDir = join(tempDir, 'metricflow-run-project');
    await initKtxProject({ projectDir, projectName: 'warehouse' });

    const fixtureDir = join(tempDir, 'metricflow-fixture');
    await mkdir(join(fixtureDir, 'models'), { recursive: true });
    await writeFile(
      join(fixtureDir, 'dbt_project.yml'),
      [
        'name: analytics',
        'version: "1.0.0"',
        'config-version: 2',
        'profile: analytics',
        'model-paths: ["models"]',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(fixtureDir, 'models/orders.yml'),
      [
        'semantic_models:',
        '  - name: orders',
        '    model: ref("orders")',
        '    entities:',
        '      - name: order',
        '        type: primary',
        '        expr: order_id',
        '    dimensions:',
        '      - name: ordered_at',
        '        type: time',
        '        expr: ordered_at',
        '    measures:',
        '      - name: revenue',
        '        agg: sum',
        '        expr: revenue',
        'metrics:',
        '  - name: total_revenue',
        '    type: simple',
        '    type_params:',
        '      measure: revenue',
        '',
      ].join('\n'),
      'utf-8',
    );
    const repo = await makeLocalGitRepo(fixtureDir, join(tempDir, 'metricflow-origin'));

    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    metricflow:',
        `      repoUrl: ${repo.repoUrl}`,
        '      branch: main',
        'ingest:',
        '  adapters:',
        '    - metricflow',
        '  embeddings:',
        '    backend: deterministic',
        'storage:',
        '  state: sqlite',
        '  search: sqlite-fts5',
        '  git:',
        '    auto_commit: false',
        '    author: KTX Test <system@ktx.local>',
        '',
      ].join('\n'),
      'utf-8',
    );

    const metricflowProject = await loadKtxProject({ projectDir });
    const agentRunner = new TestAgentRunner();
    const result = await runLocalIngest({
      project: metricflowProject,
      adapters: createDefaultLocalIngestAdapters(metricflowProject),
      adapter: 'metricflow',
      connectionId: 'warehouse',
      jobId: 'metricflow-local-full',
      agentRunner,
    });

    expect(agentRunner.runLoop).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({
      jobId: 'metricflow-local-full',
      workUnitCount: 1,
      failedWorkUnits: [],
    });
    expect(result.report).toMatchObject({
      jobId: 'metricflow-local-full',
      connectionId: 'warehouse',
      sourceKey: 'metricflow',
      body: {
        failedWorkUnits: [],
        workUnits: [
          expect.objectContaining({
            unitKey: 'metricflow-orders',
            status: 'success',
            rawFiles: ['models/orders.yml'],
          }),
        ],
      },
    });

    const stagedRawPath = join(
      metricflowProject.projectDir,
      'raw-sources',
      'warehouse',
      'metricflow',
      result.report.body.syncId,
      'models',
      'orders.yml',
    );
    await expect(readFile(stagedRawPath, 'utf-8')).resolves.toContain('semantic_models:');
  });

  it('local metricflow ingest can fetch from connection metricflow config without sourceDir', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-local-mf-fetch-'));
    const fixtureDir = join(projectDir, 'fixture-src');
    await mkdir(join(fixtureDir, 'models'), { recursive: true });
    await writeFile(join(fixtureDir, 'dbt_project.yml'), 'name: analytics\n', 'utf-8');
    await writeFile(
      join(fixtureDir, 'models/orders.yml'),
      'semantic_models:\n  - name: orders\n    model: ref("orders")\n',
      'utf-8',
    );
    const repo = await makeLocalGitRepo(fixtureDir, join(projectDir, 'origin'));
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: local-mf',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    metricflow:',
        `      repoUrl: ${repo.repoUrl}`,
        '      branch: main',
        'storage:',
        '  state: sqlite',
        '  search: sqlite-fts5',
        '  git:',
        '    auto_commit: false',
        '    author: KTX Test <system@ktx.local>',
        '',
      ].join('\n'),
      'utf-8',
    );

    const metricflowProject = await loadKtxProject({ projectDir });
    const adapters = createDefaultLocalIngestAdapters(metricflowProject);
    const metricflow = adapters.find((adapter) => adapter.source === 'metricflow');

    expect(metricflow?.fetch).toBeTypeOf('function');
    await expect(localPullConfigForAdapter(metricflowProject, metricflow!, 'warehouse')).resolves.toMatchObject({
      repoUrl: repo.repoUrl,
      branch: 'main',
      path: null,
      authToken: null,
      parsedTargetTables: {},
    });
  });

  it('runs scheduled Looker ingest through the canonical local runner and records SL target evidence', async () => {
    const projectDir = join(tempDir, 'looker-project');
    await initKtxProject({ projectDir, projectName: 'looker-runtime' });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: looker-runtime',
        'connections:',
        '  prod-looker:',
        '    driver: looker',
        '    base_url: https://looker.example.test',
        '    client_id: client',
        '  prod-warehouse:',
        '    driver: postgres',
        '    url: postgresql://readonly@warehouse.example.test/analytics',
        'ingest:',
        '  adapters:',
        '    - looker',
        '  embeddings:',
        '    backend: deterministic',
        'storage:',
        '  state: sqlite',
        '  search: sqlite-fts5',
        '  git:',
        '    auto_commit: false',
        '    author: KTX Test <system@ktx.local>',
        '',
      ].join('\n'),
      'utf-8',
    );

    const lookerProject = await loadKtxProject({ projectDir });
    const localStore = new LocalLookerRuntimeStore({ dbPath: join(lookerProject.projectDir, '.ktx', 'db.sqlite') });
    await localStore.setCursors('prod-looker', {
      dashboardsLastSyncedAt: null,
      looksLastSyncedAt: null,
    });
    await localStore.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'analytics',
      ktxConnectionId: 'prod-warehouse',
      source: 'cli',
    });

    const runtimeClient = makeLookerRuntimeClient();
    const parser = makeLookerParser();
    const agentRunner = new LookerSlWritingAgentRunner();

    const result = await runLocalIngest({
      project: lookerProject,
      adapters: createDefaultLocalIngestAdapters(lookerProject, { looker: { runtimeClient } }),
      adapter: 'looker',
      connectionId: 'prod-looker',
      jobId: 'looker-local-report-parity',
      agentRunner,
      pullConfigOptions: {
        looker: {
          client: runtimeClient,
          parser,
        },
      },
    });

    expect(runtimeClient.cleanup).toHaveBeenCalledTimes(1);
    expect(parser.parse).toHaveBeenCalledWith([
      { key: 'ecommerce.orders', sql_table_name: 'public.orders', dialect: 'postgres' },
      { key: 'ecommerce.orders.users', sql_table_name: 'public.users', dialect: 'postgres' },
    ]);
    expect(result.result).toMatchObject({
      jobId: 'looker-local-report-parity',
      workUnitCount: 3,
      failedWorkUnits: [],
    });
    expect(result.report).toMatchObject({
      jobId: 'looker-local-report-parity',
      connectionId: 'prod-looker',
      sourceKey: 'looker',
      body: {
        fetch: {
          status: 'success',
          retryRecommended: false,
          skipped: [],
          warnings: [],
        },
        failedWorkUnits: [],
      },
    });

    const exploreWorkUnit = result.report.body.workUnits.find((wu) => wu.unitKey === 'looker-explore-ecommerce-orders');
    expect(exploreWorkUnit).toMatchObject({
      status: 'success',
      rawFiles: expect.arrayContaining(['explores/ecommerce/orders.json']),
      actions: [
        expect.objectContaining({
          target: 'sl',
          type: 'created',
          key: 'looker__ecommerce__orders',
          targetConnectionId: 'prod-warehouse',
        }),
      ],
      touchedSlSources: [{ connectionId: 'prod-warehouse', sourceName: 'looker__ecommerce__orders' }],
    });

    expect(result.report.body.provenanceRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawPath: 'explores/ecommerce/orders.json',
          artifactKind: 'sl',
          artifactKey: 'looker__ecommerce__orders',
          targetConnectionId: 'prod-warehouse',
          actionType: 'source_created',
        }),
      ]),
    );

    const rawRoot = join(
      lookerProject.projectDir,
      'raw-sources',
      'prod-looker',
      'looker',
      result.report.body.syncId,
    );
    const explore = JSON.parse(await readFile(join(rawRoot, 'explores/ecommerce/orders.json'), 'utf-8'));
    expect(explore).toMatchObject({
      targetWarehouseConnectionId: 'prod-warehouse',
      targetTable: {
        ok: true,
        schema: 'public',
        name: 'orders',
        canonicalTable: 'public.orders',
      },
      joins: [
        expect.objectContaining({
          name: 'users',
          targetTable: expect.objectContaining({
            ok: true,
            schema: 'public',
            name: 'users',
            canonicalTable: 'public.users',
          }),
        }),
      ],
    });

    const dashboard = JSON.parse(await readFile(join(rawRoot, 'dashboards/10.json'), 'utf-8'));
    expect(dashboard.tiles[0].query).toMatchObject({
      targetWarehouseConnectionId: 'prod-warehouse',
      targetTable: expect.objectContaining({ ok: true, canonicalTable: 'public.orders' }),
    });

    const sourceYaml = await readFile(
      join(lookerProject.projectDir, 'semantic-layer/prod-warehouse/looker__ecommerce__orders.yaml'),
      'utf-8',
    );
    expect(sourceYaml).toContain('table: public.orders');
    expect(sourceYaml).toContain('total_revenue');
  });
});
