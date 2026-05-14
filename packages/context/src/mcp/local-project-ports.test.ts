import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunnerService } from '../agent/index.js';
import { FakeSourceAdapter, type MemoryFlowReplayInput } from '../ingest/index.js';
import { initKtxProject } from '../project/index.js';
import { createKtxConnectorCapabilities, type KtxScanConnector, type KtxSchemaSnapshot } from '../scan/index.js';
import { writeLocalSlSource } from '../sl/index.js';
import { createLocalProjectMcpContextPorts } from './local-project-ports.js';

class TestAgentRunner extends AgentRunnerService {
  override runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' as const });

  constructor() {
    super({ llmProvider: { getModel: () => ({}) as never } as never });
  }
}

describe('createLocalProjectMcpContextPorts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-local-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function testSnapshot(connectionId = 'warehouse'): KtxSchemaSnapshot {
    return {
      connectionId,
      driver: 'postgres',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {},
      tables: [
        {
          catalog: null,
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: null,
          estimatedRows: 1,
          foreignKeys: [],
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
        },
      ],
    };
  }

  function testConnector(snapshot = testSnapshot()): KtxScanConnector {
    return {
      id: `test:${snapshot.connectionId}`,
      driver: snapshot.driver,
      capabilities: createKtxConnectorCapabilities(),
      introspect: vi.fn(async () => snapshot),
      cleanup: vi.fn(async () => {}),
    };
  }

  it('lists local project connections from ktx.yaml', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const ports = createLocalProjectMcpContextPorts(project);

    await expect(ports.connections?.list()).resolves.toEqual([
      { id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' },
    ]);
  });

  it('tests a local project connection through the native scan connector factory', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector();
    const createConnector = vi.fn(async () => connector);
    const ports = createLocalProjectMcpContextPorts(project, {
      localScan: {
        createConnector,
      },
    });

    await expect(ports.connections?.test?.({ connectionId: 'warehouse' })).resolves.toEqual({
      id: 'warehouse',
      connectionType: 'POSTGRESQL',
      ok: true,
      tableCount: 1,
      message: 'Connection test passed.',
      warnings: [],
    });
    expect(createConnector).toHaveBeenCalledWith('warehouse');
    expect(connector.introspect).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        mode: 'structural',
        dryRun: true,
        detectRelationships: false,
      },
      { runId: 'connection-test-warehouse' },
    );
    expect(connector.cleanup).toHaveBeenCalled();
  });

  it('triggers canonical bundle ingest and reads status, report, and replay through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
    };
    project.config.ingest.adapters = ['fake'];
    project.config.ingest.embeddings = {
      backend: 'deterministic',
      dimensions: 8,
      batchSize: 64,
    };
    project.config.llm = {
      provider: { backend: 'none' },
      models: {},
    };

    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const agentRunner = new TestAgentRunner();
    const ports = createLocalProjectMcpContextPorts(project, {
      localIngest: {
        adapters: [new FakeSourceAdapter()],
        jobIdFactory: () => 'mcp-full-1',
        agentRunner,
      },
    });

    const trigger = await ports.ingest?.trigger({
      adapter: 'fake',
      connectionId: 'warehouse',
      trigger: 'manual_resync',
      config: { sourceDir },
    });

    expect(trigger).toMatchObject({
      runId: expect.any(String),
      jobId: 'mcp-full-1',
      reportId: expect.any(String),
    });
    expect(trigger?.runId).not.toBe('mcp-full-1');
    expect(agentRunner.runLoop).toHaveBeenCalledTimes(1);

    await expect(ports.ingest?.status({ runId: trigger?.jobId ?? '' })).resolves.toMatchObject({
      runId: trigger?.runId,
      jobId: 'mcp-full-1',
      reportId: trigger?.reportId,
      status: 'done',
      stage: 'done',
      progress: 1,
      done: true,
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir: null,
      diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      rawFileCount: 1,
      workUnitCount: 1,
      workUnits: [
        {
          unitKey: 'fake-orders',
          rawFiles: ['orders/orders.json'],
          peerFileIndex: [],
          dependencyPaths: [],
        },
      ],
      evictionDeletedRawPaths: [],
      errors: [],
    });

    await expect(ports.ingest?.report?.({ runId: trigger?.reportId ?? '' })).resolves.toMatchObject({
      id: trigger?.reportId,
      runId: trigger?.runId,
      jobId: 'mcp-full-1',
      connectionId: 'warehouse',
      sourceKey: 'fake',
    });

    const replay = (await ports.ingest?.replay?.({ runId: trigger?.runId ?? '' })) as MemoryFlowReplayInput | null;
    expect(replay).toMatchObject({
      runId: trigger?.runId,
      reportId: trigger?.reportId,
      reportPath: trigger?.reportId,
      status: 'done',
      adapter: 'fake',
      connectionId: 'warehouse',
      syncId: expect.stringContaining('mcp-full-1'),
    });
    expect(replay?.events).toEqual(
      expect.arrayContaining([
        { type: 'work_unit_finished', unitKey: 'fake-orders', status: 'success' },
        { type: 'report_created', runId: trigger?.runId, reportPath: trigger?.reportId },
      ]),
    );
  });

  it('returns child run metadata for local Metabase fan-out triggers', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections = {
      'prod-metabase': {
        driver: 'metabase',
        api_url: 'https://metabase.example.com',
      },
      warehouse_a: { driver: 'postgres', url: 'postgres://localhost/a' },
      warehouse_b: { driver: 'postgres', url: 'postgres://localhost/b' },
    };
    project.config.ingest.adapters = ['metabase'];
    const reportA = {
      id: 'report-a',
      runId: 'run-a',
      jobId: 'child-a',
      connectionId: 'warehouse_a',
      sourceKey: 'metabase',
      createdAt: '2026-05-04T12:00:00.000Z',
      body: {
        syncId: 'sync-a',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: null,
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: false,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    };
    const reportB = {
      ...reportA,
      id: 'report-b',
      runId: 'run-b',
      jobId: 'child-b',
      connectionId: 'warehouse_b',
      body: { ...reportA.body, syncId: 'sync-b' },
    };

    const ports = createLocalProjectMcpContextPorts(project, {
      localIngest: {
        runLocalMetabaseIngest: async () => ({
          metabaseConnectionId: 'prod-metabase',
          status: 'all_succeeded',
          totals: { workUnits: 2, failedWorkUnits: 0 },
          children: [
            {
              jobId: 'child-a',
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 1,
              targetConnectionId: 'warehouse_a',
              result: {
                jobId: 'child-a',
                runId: 'run-a',
                syncId: 'sync-a',
                diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
                workUnitCount: 0,
                failedWorkUnits: [],
                artifactsWritten: 0,
                commitSha: null,
              },
              report: reportA,
            },
            {
              jobId: 'child-b',
              metabaseConnectionId: 'prod-metabase',
              metabaseDatabaseId: 2,
              targetConnectionId: 'warehouse_b',
              result: {
                jobId: 'child-b',
                runId: 'run-b',
                syncId: 'sync-b',
                diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
                workUnitCount: 0,
                failedWorkUnits: [],
                artifactsWritten: 0,
                commitSha: null,
              },
              report: reportB,
            },
          ],
        }),
      },
    });

    await expect(
      ports.ingest?.trigger({
        adapter: 'metabase',
        connectionId: 'prod-metabase',
        trigger: 'manual_resync',
      }),
    ).resolves.toEqual({
      runId: 'metabase-fanout:prod-metabase',
      jobId: undefined,
      reportId: undefined,
      fanout: {
        status: 'all_succeeded',
        children: [
          {
            runId: 'run-a',
            jobId: 'child-a',
            reportId: 'report-a',
            targetConnectionId: 'warehouse_a',
            metabaseDatabaseId: 1,
          },
          {
            runId: 'run-b',
            jobId: 'child-b',
            reportId: 'report-b',
            targetConnectionId: 'warehouse_b',
            metabaseDatabaseId: 2,
          },
        ],
      },
    });
  });

  it('writes, reads, and searches global wiki pages', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    const ports = createLocalProjectMcpContextPorts(project);

    await expect(
      ports.knowledge?.write({
        userId: 'local-user',
        key: 'revenue',
        summary: 'Revenue definition',
        content: '# Revenue\n\nRevenue is net of refunds.',
        tags: ['finance'],
        refs: ['docs/revenue.md'],
        slRefs: ['warehouse.orders'],
      }),
    ).resolves.toMatchObject({ success: true, key: 'revenue', action: 'created' });

    await expect(ports.knowledge?.read({ userId: 'local-user', key: 'revenue' })).resolves.toMatchObject({
      key: 'revenue',
      scope: 'GLOBAL',
      summary: 'Revenue definition',
      tags: ['finance'],
      refs: ['docs/revenue.md'],
      slRefs: ['warehouse.orders'],
      content: '# Revenue\n\nRevenue is net of refunds.',
    });

    const search = await ports.knowledge?.search({ userId: 'local-user', query: 'refunds', limit: 5 });
    expect(search).toEqual({
      results: [
        expect.objectContaining({
          key: 'revenue',
          path: 'wiki/global/revenue.md',
          scope: 'GLOBAL',
          summary: 'Revenue definition',
          score: expect.any(Number),
          matchReasons: expect.arrayContaining(['lexical']),
        }),
      ],
      totalFound: 1,
    });
    expect(search?.results[0]?.score).toBeGreaterThan(0);
    await expect(access(join(project.projectDir, '.ktx', 'db.sqlite'))).resolves.toBeUndefined();
  });

  it('writes, lists, reads, and validates semantic-layer sources', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    const ports = createLocalProjectMcpContextPorts(project);

    await expect(
      ports.semanticLayer?.writeSource({
        connectionId: 'warehouse',
        sourceName: 'orders',
        source: {
          name: 'orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [{ name: 'id', type: 'number' }],
          joins: [],
          measures: [{ name: 'order_count', expr: 'count(*)' }],
        },
      }),
    ).resolves.toMatchObject({ success: true, sourceName: 'orders' });

    await expect(ports.semanticLayer?.listSources({ connectionId: 'warehouse' })).resolves.toEqual({
      sources: [
        {
          connectionId: 'warehouse',
          connectionName: 'warehouse',
          name: 'orders',
          columnCount: 1,
          measureCount: 1,
          joinCount: 0,
        },
      ],
      totalSources: 1,
    });

    await expect(
      ports.semanticLayer?.listSources({ connectionId: 'warehouse', query: 'order_count' }),
    ).resolves.toEqual({
      sources: [
        expect.objectContaining({
          connectionId: 'warehouse',
          connectionName: 'warehouse',
          name: 'orders',
          columnCount: 1,
          measureCount: 1,
          joinCount: 0,
          score: expect.any(Number),
          matchReasons: expect.arrayContaining(['lexical']),
        }),
      ],
      totalSources: 1,
    });
    await expect(access(join(project.projectDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();

    await expect(
      ports.semanticLayer?.readSource({ connectionId: 'warehouse', sourceName: 'orders' }),
    ).resolves.toMatchObject({
      sourceName: 'orders',
      yaml: expect.stringContaining('name: orders'),
    });

    await expect(ports.semanticLayer?.validate({ connectionId: 'warehouse' })).resolves.toEqual({
      success: true,
      errors: [],
      warnings: ['Local stdio validation checks YAML shape only; Python semantic validation is not configured.'],
    });
  });

  it('returns semantic-layer hybrid search metadata through local project ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: [
        'name: orders',
        'table: public.orders',
        'grain:',
        '  - order_id',
        'columns:',
        '  - name: order_id',
        '    type: string',
        '  - name: status',
        '    type: string',
        '',
      ].join('\n'),
    });
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 2,
          tables: [],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'string',
              rowCount: 10,
              nullCount: 0,
              distinctCount: 2,
              uniquenessRatio: 0.2,
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
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed dictionary profile',
    );

    const ports = createLocalProjectMcpContextPorts(project);
    await expect(ports.semanticLayer?.listSources({ connectionId: 'warehouse', query: 'paid' })).resolves.toEqual({
      sources: [
        expect.objectContaining({
          connectionId: 'warehouse',
          connectionName: 'warehouse',
          name: 'orders',
          score: expect.any(Number),
          matchReasons: expect.arrayContaining(['dictionary']),
          dictionaryMatches: [{ column: 'status', values: ['paid'] }],
        }),
      ],
      totalSources: 1,
    });
  });

  it('returns historic SQL usage frequency and snippet through semantic-layer list search', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  orders:
    table: public.orders
    usage:
      narrative: Analysts inspect paid order lifecycle by customer segment.
      frequencyTier: high
      commonFilters:
        - status
      commonGroupBys:
        - customer_segment
      commonJoins:
        - table: public.customers
          on:
            - customer_id
    columns:
      - name: order_id
        type: string
      - name: status
        type: string
`,
      'ktx',
      'ktx@example.com',
      'Seed usage-backed manifest shard',
    );

    const ports = createLocalProjectMcpContextPorts(project);
    await expect(
      ports.semanticLayer?.listSources({ connectionId: 'warehouse', query: 'paid order lifecycle' }),
    ).resolves.toEqual({
      sources: [
        expect.objectContaining({
          connectionId: 'warehouse',
          connectionName: 'warehouse',
          name: 'orders',
          frequencyTier: 'high',
          snippet: expect.stringContaining('<mark>'),
          score: expect.any(Number),
          matchReasons: expect.arrayContaining(['lexical']),
        }),
      ],
      totalSources: 1,
    });
  });

  it('uses configured local embeddings for semantic-layer search when available', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.ingest.embeddings = { backend: 'none', dimensions: 2 };
    await writeLocalSlSource(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: [
        'name: orders',
        'descriptions:',
        '  user: Revenue facts',
        'table: public.orders',
        'grain:',
        '  - order_id',
        'columns:',
        '  - name: order_id',
        '    type: string',
        '',
      ].join('\n'),
    });

    const ports = createLocalProjectMcpContextPorts(project, {
      embeddingService: {
        maxBatchSize: 8,
        async computeEmbedding(text: string) {
          return text.includes('cash collection') ? [1, 0] : [0, 1];
        },
        async computeEmbeddingsBulk(texts: string[]) {
          return texts.map((text) => (text.includes('Revenue facts') ? [1, 0] : [0, 1]));
        },
      },
    });

    const result = await ports.semanticLayer?.listSources({ connectionId: 'warehouse', query: 'cash collection' });

    expect(result?.sources[0]).toMatchObject({
      name: 'orders',
      matchReasons: expect.arrayContaining(['semantic']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'semantic', status: 'available' })]),
    });
  });

  it('rejects path traversal keys before touching the project directory', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    const ports = createLocalProjectMcpContextPorts(project);

    await expect(
      ports.knowledge?.read({
        userId: 'local-user',
        key: '../outside',
      }),
    ).rejects.toThrow('Invalid wiki key "../outside". Wiki keys must be flat; use "outside".');

    await expect(
      ports.semanticLayer?.readSource({
        connectionId: 'warehouse',
        sourceName: '../orders',
      }),
    ).rejects.toThrow('Unsafe semantic-layer source name');
  });

  it('uses semantic compute for validation and compile-only sl_query when supplied', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const shapeOnlyPorts = createLocalProjectMcpContextPorts(project);
    await shapeOnlyPorts.semanticLayer?.writeSource({
      connectionId: 'warehouse',
      sourceName: 'orders',
      source: {
        name: 'orders',
        table: 'public.orders',
        grain: ['id'],
        columns: [
          { name: 'id', type: 'number' },
          { name: 'status', type: 'string' },
        ],
        joins: [],
        measures: [{ name: 'order_count', expr: 'count(*)' }],
      },
    });

    const semanticLayerCompute = {
      validateSources: vi.fn(async () => ({
        valid: true,
        errors: [],
        warnings: ['python validation ran'],
        perSourceWarnings: {},
      })),
      query: vi.fn(async () => ({
        sql: 'select status, count(*) as order_count from public.orders group by status',
        dialect: 'postgres',
        columns: [{ name: 'orders.status' }, { name: 'orders.order_count' }],
        plan: { sources_used: ['orders'] },
      })),
      generateSources: vi.fn(),
    };
    const ports = createLocalProjectMcpContextPorts(project, { semanticLayerCompute });

    await expect(ports.semanticLayer?.validate({ connectionId: 'warehouse', names: ['orders'] })).resolves.toEqual({
      success: true,
      errors: [],
      warnings: ['python validation ran'],
    });
    expect(semanticLayerCompute.validateSources).toHaveBeenCalledWith({
      sources: [
        {
          name: 'orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [
            { name: 'id', type: 'number' },
            { name: 'status', type: 'string' },
          ],
          joins: [],
          measures: [{ name: 'order_count', expr: 'count(*)' }],
        },
      ],
      dialect: 'postgres',
      recentlyTouched: ['orders'],
    });

    await expect(
      ports.semanticLayer?.query({
        connectionId: 'warehouse',
        query: {
          measures: ['orders.order_count'],
          dimensions: ['orders.status'],
        },
      }),
    ).resolves.toMatchObject({
      sql: 'select status, count(*) as order_count from public.orders group by status',
      headers: ['orders.status', 'orders.order_count'],
      rows: [],
      totalRows: 0,
      plan: {
        sources_used: ['orders'],
        execution: {
          mode: 'compile_only',
          reason: 'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.',
        },
      },
    });
  });

  it('executes local MCP sl_query when a query executor is configured', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const shapeOnlyPorts = createLocalProjectMcpContextPorts(project);
    await shapeOnlyPorts.semanticLayer?.writeSource({
      connectionId: 'warehouse',
      sourceName: 'orders',
      source: {
        name: 'orders',
        table: 'public.orders',
        grain: ['id'],
        columns: [{ name: 'id', type: 'number' }],
        joins: [],
        measures: [{ name: 'order_count', expr: 'count(*)' }],
      },
    });
    const compute = {
      validateSources: vi.fn(),
      generateSources: vi.fn(),
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
    };
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['orders.order_count'],
        rows: [[3]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      semanticLayerCompute: compute,
      queryExecutor,
    });

    const result = await ports.semanticLayer?.query({
      connectionId: 'warehouse',
      query: { measures: ['orders.order_count'], dimensions: [], limit: 5 },
    });

    expect(result?.rows).toEqual([[3]]);
    expect(result?.totalRows).toBe(1);
    expect(queryExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'warehouse',
        maxRows: 5,
      }),
    );
  });

  it('exposes detailed local ingest trigger and status ports when local ingest is enabled', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = { driver: 'postgres' };
    project.config.ingest.adapters = ['fake'];
    project.config.ingest.embeddings = {
      backend: 'deterministic',
      dimensions: 8,
      batchSize: 64,
    };
    project.config.llm = {
      provider: { backend: 'none' },
      models: {},
    };
    const sourceDir = join(project.projectDir, 'upload');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    let nextJob = 0;
    const agentRunner = new TestAgentRunner();
    const ports = createLocalProjectMcpContextPorts(project, {
      localIngest: {
        adapters: [new FakeSourceAdapter()],
        jobIdFactory: () => `mcp-local-run-${++nextJob}`,
        agentRunner,
      },
    });

    const firstTrigger = await ports.ingest?.trigger({
      adapter: 'fake',
      connectionId: 'warehouse',
      trigger: 'manual_resync',
      config: { sourceDir },
    });

    expect(firstTrigger).toMatchObject({
      runId: expect.any(String),
      jobId: 'mcp-local-run-1',
      reportId: expect.any(String),
    });
    expect(firstTrigger?.runId).not.toBe('mcp-local-run-1');

    await expect(ports.ingest?.status({ runId: 'mcp-local-run-1' })).resolves.toMatchObject({
      runId: firstTrigger?.runId,
      jobId: 'mcp-local-run-1',
      reportId: firstTrigger?.reportId,
      status: 'done',
      stage: 'done',
      done: true,
      progress: 1,
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir: null,
      syncId: expect.stringContaining('mcp-local-run-1'),
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      previousRunId: null,
      diffSummary: {
        added: 1,
        modified: 0,
        deleted: 0,
        unchanged: 0,
      },
      rawFileCount: 1,
      workUnitCount: 1,
      workUnits: [
        {
          unitKey: 'fake-orders',
          rawFiles: ['orders/orders.json'],
          peerFileIndex: [],
          dependencyPaths: [],
        },
      ],
      evictionDeletedRawPaths: [],
      errors: [],
    });

    const secondTrigger = await ports.ingest?.trigger({
      adapter: 'fake',
      connectionId: 'warehouse',
      trigger: 'manual_resync',
      config: { sourceDir },
    });

    expect(secondTrigger).toMatchObject({
      runId: expect.any(String),
      jobId: 'mcp-local-run-2',
      reportId: expect.any(String),
    });
    expect(secondTrigger?.runId).not.toBe('mcp-local-run-2');

    await expect(ports.ingest?.status({ runId: 'mcp-local-run-2' })).resolves.toMatchObject({
      runId: secondTrigger?.runId,
      jobId: 'mcp-local-run-2',
      reportId: secondTrigger?.reportId,
      status: 'done',
      stage: 'done',
      done: true,
      progress: 1,
      adapter: 'fake',
      connectionId: 'warehouse',
      sourceDir: null,
      syncId: expect.stringContaining('mcp-local-run-2'),
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      previousRunId: null,
      diffSummary: {
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 1,
      },
      rawFileCount: 0,
      workUnitCount: 0,
      workUnits: [],
      evictionDeletedRawPaths: [],
      errors: [],
    });
    expect(agentRunner.runLoop).toHaveBeenCalledTimes(1);
  });

  it('passes local ingest pull-config options into runLocalIngest', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = { driver: 'postgres' };
    project.config.ingest.adapters = ['looker'];
    const runLocalIngest = vi.fn(async () => ({
      result: { ok: true },
      report: {
        id: 'report-1',
        runId: 'run-1',
        jobId: 'job-1',
        sourceKey: 'looker',
        connectionId: 'warehouse',
        body: {
          syncId: 'sync-1',
          workUnits: [],
          failedWorkUnits: [],
          diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
          provenanceRows: [],
        },
      },
    }) as never);
    const ports = createLocalProjectMcpContextPorts(project, {
      localIngest: {
        adapters: [
          { source: 'looker', skillNames: [], detect: async () => true, chunk: async () => ({ workUnits: [] }) },
        ],
        pullConfigOptions: {
          looker: {
            daemonBaseUrl: 'http://127.0.0.1:61234',
          },
        },
        runLocalIngest,
      },
    });

    await expect(
      ports.ingest?.trigger({
        adapter: 'looker',
        connectionId: 'warehouse',
        trigger: 'manual_resync',
        config: {},
      }),
    ).resolves.toMatchObject({
      runId: 'run-1',
      jobId: 'job-1',
      reportId: 'report-1',
    });

    expect(runLocalIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        pullConfigOptions: {
          looker: {
            daemonBaseUrl: 'http://127.0.0.1:61234',
          },
        },
      }),
    );
  });

  it('triggers fetch-capable local ingest without sourceDir config', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'postgres://localhost:5432/warehouse',
    };
    project.config.ingest.adapters = ['live-database'];
    project.config.llm = {
      provider: { backend: 'none' },
      models: {},
    };
    const agentRunner = new TestAgentRunner();
    const ports = createLocalProjectMcpContextPorts(project, {
      localIngest: {
        adapters: [
          {
            source: 'live-database',
            skillNames: ['live_database_ingest'],
            async fetch(_pullConfig, stagedDir) {
              await mkdir(join(stagedDir, 'tables'), { recursive: true });
              await writeFile(join(stagedDir, 'connection.json'), '{"connectionId":"warehouse"}\n', 'utf-8');
              await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
              await writeFile(
                join(stagedDir, 'tables', 'orders.json'),
                '{"name":"orders","db":"public","columns":[]}\n',
                'utf-8',
              );
            },
            async detect() {
              return true;
            },
            async chunk() {
              return {
                workUnits: [
                  {
                    unitKey: 'live-database-public-orders',
                    rawFiles: ['tables/orders.json'],
                    dependencyPaths: ['connection.json', 'foreign-keys.json'],
                    peerFileIndex: [],
                  },
                ],
              };
            },
          },
        ],
        jobIdFactory: () => 'local-live-db-mcp',
        agentRunner,
      },
    });

    const result = await ports.ingest?.trigger({
      adapter: 'live-database',
      connectionId: 'warehouse',
      trigger: 'manual_resync',
      config: {},
    });

    expect(result).toMatchObject({
      runId: expect.any(String),
      jobId: 'local-live-db-mcp',
      reportId: expect.any(String),
    });
    expect(result?.runId).not.toBe('local-live-db-mcp');
    await expect(ports.ingest?.status({ runId: 'local-live-db-mcp' })).resolves.toMatchObject({
      runId: result?.runId,
      jobId: 'local-live-db-mcp',
      reportId: result?.reportId,
      adapter: 'live-database',
      sourceDir: null,
      rawFileCount: 1,
      workUnitCount: 1,
    });
    expect(agentRunner.runLoop).toHaveBeenCalledTimes(1);
  });

  it('lists and reads only artifacts that belong to a local scan report', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    project.config.ingest.adapters = ['live-database'];
    const ports = createLocalProjectMcpContextPorts(project, {
      localScan: {
        adapters: [
          {
            source: 'live-database',
            skillNames: ['live_database_ingest'],
            async fetch(_pullConfig, stagedDir) {
              await mkdir(join(stagedDir, 'tables'), { recursive: true });
              await writeFile(join(stagedDir, 'connection.json'), '{"connectionId":"warehouse"}\n', 'utf-8');
              await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
              await writeFile(
                join(stagedDir, 'tables', 'orders.json'),
                '{"name":"orders","db":"public","columns":[]}\n',
                'utf-8',
              );
            },
            async detect() {
              return true;
            },
            async chunk() {
              return {
                workUnits: [
                  {
                    unitKey: 'live-database-public-orders',
                    rawFiles: ['tables/orders.json'],
                    dependencyPaths: ['connection.json', 'foreign-keys.json'],
                    peerFileIndex: [],
                  },
                ],
              };
            },
          },
        ],
        jobIdFactory: () => 'local-scan-artifacts',
        now: () => new Date('2026-04-29T12:00:00.000Z'),
      },
    });

    const trigger = await ports.scan?.trigger({
      connectionId: 'warehouse',
      mode: 'structural',
      detectRelationships: false,
      dryRun: false,
    });

    expect(trigger?.runId).toBe('local-scan-artifacts');
    const syncId = '2026-04-29-120000-local-scan-artifacts';
    await expect(ports.scan?.listArtifacts?.({ runId: 'local-scan-artifacts' })).resolves.toEqual({
      runId: 'local-scan-artifacts',
      artifacts: [
        {
          path: `raw-sources/warehouse/live-database/${syncId}/connection.json`,
          type: 'raw_source',
          size: 29,
        },
        {
          path: `raw-sources/warehouse/live-database/${syncId}/foreign-keys.json`,
          type: 'raw_source',
          size: 19,
        },
        {
          path: `raw-sources/warehouse/live-database/${syncId}/scan-report.json`,
          type: 'report',
          size: expect.any(Number),
        },
        {
          path: `raw-sources/warehouse/live-database/${syncId}/tables/orders.json`,
          type: 'raw_source',
          size: 45,
        },
        {
          path: 'semantic-layer/warehouse/_schema/public.yaml',
          type: 'manifest_shard',
          size: expect.any(Number),
        },
      ],
    });

    await expect(
      ports.scan?.readArtifact?.({
        runId: 'local-scan-artifacts',
        path: `raw-sources/warehouse/live-database/${syncId}/tables/orders.json`,
      }),
    ).resolves.toEqual({
      runId: 'local-scan-artifacts',
      path: `raw-sources/warehouse/live-database/${syncId}/tables/orders.json`,
      type: 'raw_source',
      size: 45,
      content: '{"name":"orders","db":"public","columns":[]}\n',
    });

    await expect(
      ports.scan?.readArtifact?.({
        runId: 'local-scan-artifacts',
        path: 'semantic-layer/warehouse/_schema/public.yaml',
      }),
    ).resolves.toMatchObject({
      runId: 'local-scan-artifacts',
      path: 'semantic-layer/warehouse/_schema/public.yaml',
      type: 'manifest_shard',
      content: expect.stringContaining('orders:'),
    });

    await expect(
      ports.scan?.readArtifact?.({
        runId: 'local-scan-artifacts',
        path: 'ktx.yaml',
      }),
    ).resolves.toBeNull();
    await expect(ports.scan?.listArtifacts?.({ runId: 'missing' })).resolves.toBeNull();
    await expect(readFile(join(project.projectDir, 'ktx.yaml'), 'utf-8')).resolves.not.toContain('project:');
  });
});
