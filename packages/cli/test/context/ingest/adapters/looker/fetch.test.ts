import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkLookerStagedDir } from '../../../../../src/context/ingest/adapters/looker/chunk.js';
import { fetchLookerRuntimeBundle, type LookerRuntimeClient } from '../../../../../src/context/ingest/adapters/looker/fetch.js';

const connectionId = '11111111-1111-4111-8111-111111111111';

function makeClient(): LookerRuntimeClient {
  return {
    listDashboards: vi.fn().mockResolvedValue([{ id: '10' }]),
    getDashboard: vi.fn().mockResolvedValue({
      lookerId: '10',
      title: 'Sales Pipeline',
      description: 'Pipeline health',
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-04-30T12:00:00.000Z',
      tiles: [{ id: '100', title: 'ARR', lookId: null, query: { model: 'b2b', view: 'sales_pipeline' } }],
    }),
    listLooks: vi.fn().mockResolvedValue([{ id: '20' }]),
    getLook: vi.fn().mockResolvedValue({
      lookerId: '20',
      title: 'Open Pipeline',
      description: null,
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-04-30T12:00:00.000Z',
      query: { model: 'b2b', view: 'sales_pipeline', fields: ['opportunities.arr'] },
    }),
    listFolders: vi
      .fn()
      .mockResolvedValue({ folders: [{ id: '7', name: 'Sandbox', parentId: null, path: ['Sandbox'] }] }),
    listUsers: vi.fn().mockResolvedValue([{ id: '3', displayName: 'Ada Lovelace', email: null }]),
    listGroups: vi.fn().mockResolvedValue([{ id: '4', name: 'Sales' }]),
    listLookmlModels: vi.fn().mockResolvedValue({
      models: [{ name: 'b2b', label: 'B2B', explores: [{ name: 'sales_pipeline', label: 'Sales Pipeline' }] }],
    }),
    getExplore: vi.fn().mockResolvedValue({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      label: 'Sales Pipeline',
      description: null,
      fields: { dimensions: [{ name: 'opportunities.id' }], measures: [{ name: 'opportunities.arr' }] },
      joins: [],
    }),
    getSignals: vi.fn().mockResolvedValue({
      dashboardUsage: [{ contentId: '10', queryCount30d: 50, uniqueUsers30d: 8, lastRunAt: null, topUsers: ['3'] }],
      lookUsage: [{ contentId: '20', queryCount30d: 20, uniqueUsers30d: 5, lastRunAt: null, topUsers: ['3'] }],
      scheduledPlans: [
        { contentId: '10', contentType: 'dashboard', isScheduled: true, scheduleCount: 1, recipientCount: 3 },
      ],
      favorites: [{ contentId: '10', contentType: 'dashboard', favoriteCount: 4 }],
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

describe('fetchLookerRuntimeBundle', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-fetch-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('writes dashboards, looks, folders, users, groups, models, explores, signals, and sync config', async () => {
    const client = makeClient();
    await fetchLookerRuntimeBundle({
      pullConfig: { lookerConnectionId: connectionId, instanceBaseUrl: 'https://example.looker.com' },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'dashboards'))).toEqual(['10.json']);
    expect(await readdir(join(stagedDir, 'looks'))).toEqual(['20.json']);
    expect(await readdir(join(stagedDir, 'users'))).toEqual(['3.json']);
    expect(await readdir(join(stagedDir, 'groups'))).toEqual(['4.json']);
    expect(await readdir(join(stagedDir, 'explores/b2b'))).toEqual(['sales_pipeline.json']);

    const syncConfig = JSON.parse(await readFile(join(stagedDir, 'sync-config.json'), 'utf-8'));
    expect(syncConfig).toEqual({
      lookerConnectionId: connectionId,
      fetchedAt: '2026-04-30T12:30:00.000Z',
      instanceBaseUrl: 'https://example.looker.com',
      previousCursors: {
        dashboardsLastSyncedAt: null,
        looksLastSyncedAt: null,
      },
      nextCursors: {
        dashboardsLastSyncedAt: null,
        looksLastSyncedAt: null,
      },
    });

    const scope = JSON.parse(await readFile(join(stagedDir, 'looker-scope.json'), 'utf-8'));
    expect(scope).toEqual({
      mode: 'full',
      knownCurrentRawPaths: ['dashboards/10.json', 'looks/20.json'],
      fetchedRawPaths: ['dashboards/10.json', 'looks/20.json'],
    });

    const dashboardUsage = JSON.parse(await readFile(join(stagedDir, 'signals/dashboard_usage.json'), 'utf-8'));
    expect(dashboardUsage).toEqual([
      { contentId: '10', queryCount30d: 50, uniqueUsers30d: 8, lastRunAt: null, topUsers: ['3'] },
    ]);

    const lookUsage = JSON.parse(await readFile(join(stagedDir, 'signals/look_usage.json'), 'utf-8'));
    const scheduledPlans = JSON.parse(await readFile(join(stagedDir, 'signals/scheduled_plans.json'), 'utf-8'));
    const favorites = JSON.parse(await readFile(join(stagedDir, 'signals/favorites.json'), 'utf-8'));

    expect(lookUsage).toEqual([
      { contentId: '20', queryCount30d: 20, uniqueUsers30d: 5, lastRunAt: null, topUsers: ['3'] },
    ]);
    expect(scheduledPlans).toEqual([
      { contentId: '10', contentType: 'dashboard', isScheduled: true, scheduleCount: 1, recipientCount: 3 },
    ]);
    expect(favorites).toEqual([{ contentId: '10', contentType: 'dashboard', favoriteCount: 4 }]);
  });

  it('stages only changed Dashboard and Look entity bodies during incremental pulls', async () => {
    const client = makeClient();
    vi.mocked(client.listDashboards).mockResolvedValue([
      { id: '10', updatedAt: '2026-04-30T12:00:00.000Z' },
      { id: '11', updatedAt: '2026-04-30T12:10:00.000Z' },
    ]);
    vi.mocked(client.getDashboard).mockImplementation(async (id: string) => ({
      lookerId: id,
      title: `Dashboard ${id}`,
      description: null,
      folderId: '7',
      ownerId: '3',
      updatedAt: id === '11' ? '2026-04-30T12:10:00.000Z' : '2026-04-30T12:00:00.000Z',
      tiles: [],
    }));
    vi.mocked(client.listLooks).mockResolvedValue([
      { id: '20', updatedAt: '2026-04-30T11:00:00.000Z' },
      { id: '21', updatedAt: null },
    ]);
    vi.mocked(client.getLook).mockImplementation(async (id: string) => ({
      lookerId: id,
      title: `Look ${id}`,
      description: null,
      folderId: '7',
      ownerId: '3',
      updatedAt: id === '21' ? null : '2026-04-30T11:00:00.000Z',
      query: null,
    }));

    await fetchLookerRuntimeBundle({
      pullConfig: {
        lookerConnectionId: connectionId,
        dashboardUpdatedSince: '2026-04-30T12:00:00.000Z',
        lookUpdatedSince: '2026-04-30T11:00:00.000Z',
      },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    expect(client.getDashboard).toHaveBeenCalledTimes(1);
    expect(client.getDashboard).toHaveBeenCalledWith('11');
    expect(client.getLook).toHaveBeenCalledTimes(1);
    expect(client.getLook).toHaveBeenCalledWith('21');

    await expect(readdir(join(stagedDir, 'dashboards'))).resolves.toEqual(['11.json']);
    await expect(readdir(join(stagedDir, 'looks'))).resolves.toEqual(['21.json']);

    const syncConfig = JSON.parse(await readFile(join(stagedDir, 'sync-config.json'), 'utf-8'));
    expect(syncConfig.previousCursors).toEqual({
      dashboardsLastSyncedAt: '2026-04-30T12:00:00.000Z',
      looksLastSyncedAt: '2026-04-30T11:00:00.000Z',
    });
    expect(syncConfig.nextCursors).toEqual({
      dashboardsLastSyncedAt: '2026-04-30T12:10:00.000Z',
      looksLastSyncedAt: '2026-04-30T11:00:00.000Z',
    });

    const scope = JSON.parse(await readFile(join(stagedDir, 'looker-scope.json'), 'utf-8'));
    expect(scope).toEqual({
      mode: 'incremental',
      knownCurrentRawPaths: ['dashboards/10.json', 'dashboards/11.json', 'looks/20.json', 'looks/21.json'],
      fetchedRawPaths: ['dashboards/11.json', 'looks/21.json'],
    });
  });

  it('falls back to empty signal files when the client has no signal support', async () => {
    const client = makeClient();
    delete client.getSignals;

    await fetchLookerRuntimeBundle({
      pullConfig: { lookerConnectionId: connectionId },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    expect(JSON.parse(await readFile(join(stagedDir, 'signals/look_usage.json'), 'utf-8'))).toEqual([]);
  });

  it('stamps explore warehouse targets from pull config and reports unmapped Looker connections', async () => {
    const client = makeClient();
    const warehouseConnectionId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(client.listLookmlModels).mockResolvedValue({
      models: [
        {
          name: 'b2b',
          label: 'B2B',
          explores: [
            { name: 'sales_pipeline', label: 'Sales Pipeline' },
            { name: 'marketing', label: 'Marketing' },
          ],
        },
      ],
    });
    vi.mocked(client.getExplore).mockImplementation(async (_modelName: string, exploreName: string) => {
      if (exploreName === 'marketing') {
        return {
          modelName: 'b2b',
          exploreName: 'marketing',
          label: 'Marketing',
          description: null,
          rawSqlTableName: 'proj.dataset.marketing',
          connectionName: 'missing_mapping',
          viewName: 'marketing',
          fields: {
            dimensions: [{ name: 'marketing.id', label: null, type: null, sql: null, description: null }],
            measures: [{ name: 'marketing.spend', label: null, type: null, sql: null, description: null }],
          },
          joins: [],
          targetWarehouseConnectionId: null,
          targetTable: null,
        };
      }
      return {
        modelName: 'b2b',
        exploreName: 'sales_pipeline',
        label: 'Sales Pipeline',
        description: null,
        rawSqlTableName: 'proj.dataset.opportunities AS opportunities',
        connectionName: 'b2b_sandbox_bq',
        viewName: 'opportunities',
        fields: {
          dimensions: [{ name: 'opportunities.id', label: null, type: null, sql: null, description: null }],
          measures: [{ name: 'opportunities.arr', label: null, type: null, sql: null, description: null }],
        },
        joins: [
          {
            name: 'accounts',
            type: 'left_outer',
            relationship: 'many_to_one',
            rawSqlTableName: 'proj.dataset.accounts',
            sqlOn: '$' + '{opportunities.account_id} = $' + '{accounts.id}',
            from: null,
            targetTable: null,
          },
        ],
        targetWarehouseConnectionId: null,
        targetTable: null,
      };
    });

    await fetchLookerRuntimeBundle({
      pullConfig: {
        lookerConnectionId: connectionId,
        connectionMappings: { b2b_sandbox_bq: warehouseConnectionId },
        connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
        parsedTargetTables: {
          'b2b.sales_pipeline': {
            ok: true,
            catalog: 'proj',
            schema: 'dataset',
            name: 'opportunities',
            canonicalTable: 'proj.dataset.opportunities',
          },
          'b2b.sales_pipeline.accounts': {
            ok: true,
            catalog: 'proj',
            schema: 'dataset',
            name: 'accounts',
            canonicalTable: 'proj.dataset.accounts',
          },
        },
      },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    const salesPipeline = JSON.parse(await readFile(join(stagedDir, 'explores/b2b/sales_pipeline.json'), 'utf-8'));
    expect(salesPipeline).toMatchObject({
      connectionName: 'b2b_sandbox_bq',
      targetWarehouseConnectionId: warehouseConnectionId,
      targetTable: {
        ok: true,
        catalog: 'proj',
        schema: 'dataset',
        name: 'opportunities',
        canonicalTable: 'proj.dataset.opportunities',
      },
      joins: [
        {
          name: 'accounts',
          targetTable: {
            ok: true,
            catalog: 'proj',
            schema: 'dataset',
            name: 'accounts',
            canonicalTable: 'proj.dataset.accounts',
          },
        },
      ],
    });

    const marketing = JSON.parse(await readFile(join(stagedDir, 'explores/b2b/marketing.json'), 'utf-8'));
    expect(marketing).toMatchObject({
      connectionName: 'missing_mapping',
      targetWarehouseConnectionId: null,
      targetTable: {
        ok: false,
        reason: 'no_connection_mapping',
      },
    });

    const report = JSON.parse(await readFile(join(stagedDir, 'looker-fetch-report.json'), 'utf-8'));
    expect(report.status).toBe('partial');
    expect(report.skipped).toEqual([]);
    expect(report.warnings).toEqual([
      {
        rawPath: 'looker_connection_mappings/missing_mapping',
        entityType: 'looker_connection_mapping',
        entityId: 'missing_mapping',
        severity: 'warning',
        statusCode: null,
        message: 'Looker connection missing_mapping is not mapped to a warehouse connection; 1 explore will be wiki-only.',
        retryRecommended: false,
        kind: 'unmapped_looker_connection',
        details: {
          lookerConnectionName: 'missing_mapping',
          affectedExplores: ['b2b.marketing'],
        },
      },
    ]);
  });

  it('reports parsed target table failures without retrying the Looker fetch', async () => {
    const client = makeClient();
    const warehouseConnectionId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(client.getExplore).mockResolvedValue({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      label: 'Sales Pipeline',
      description: null,
      rawSqlTableName: '$' + '{derived.SQL_TABLE_NAME}',
      connectionName: 'b2b_sandbox_bq',
      viewName: 'opportunities',
      fields: {
        dimensions: [{ name: 'opportunities.id', label: null, type: null, sql: null, description: null }],
        measures: [{ name: 'opportunities.arr', label: null, type: null, sql: null, description: null }],
      },
      joins: [],
      targetWarehouseConnectionId: null,
      targetTable: null,
    });

    await fetchLookerRuntimeBundle({
      pullConfig: {
        lookerConnectionId: connectionId,
        connectionMappings: { b2b_sandbox_bq: warehouseConnectionId },
        connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
        parsedTargetTables: {
          'b2b.sales_pipeline': {
            ok: false,
            reason: 'looker_template_unresolved',
            detail: 'Looker template markers cannot be resolved before parsing.',
          },
        },
      },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    const explore = JSON.parse(await readFile(join(stagedDir, 'explores/b2b/sales_pipeline.json'), 'utf-8'));
    expect(explore).toMatchObject({
      targetWarehouseConnectionId: warehouseConnectionId,
      targetTable: {
        ok: false,
        reason: 'looker_template_unresolved',
      },
    });

    const report = JSON.parse(await readFile(join(stagedDir, 'looker-fetch-report.json'), 'utf-8'));
    expect(report).toMatchObject({
      status: 'partial',
      retryRecommended: false,
      skipped: [],
      warnings: [
        {
          rawPath: 'looker_connection_mappings/b2b_sandbox_bq',
          entityType: 'looker_connection_mapping',
          entityId: 'b2b_sandbox_bq',
          severity: 'warning',
          statusCode: null,
          message:
            'Looker explore b2b.sales_pipeline has sql_table_name that cannot be mapped to a physical warehouse table: looker_template_unresolved.',
          retryRecommended: false,
          kind: 'looker_template_unresolved',
          details: {
            lookerConnectionName: 'b2b_sandbox_bq',
            rawSqlTableName: '$' + '{derived.SQL_TABLE_NAME}',
            reason: 'looker_template_unresolved',
          },
        },
      ],
    });
  });

  it('propagates parent explore warehouse targets onto Dashboard tile and Look queries', async () => {
    const client = makeClient();
    const warehouseConnectionId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(client.getExplore).mockResolvedValue({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      label: 'Sales Pipeline',
      description: null,
      rawSqlTableName: 'proj.dataset.opportunities AS opportunities',
      connectionName: 'b2b_sandbox_bq',
      viewName: 'opportunities',
      fields: {
        dimensions: [{ name: 'opportunities.id', label: null, type: null, sql: null, description: null }],
        measures: [{ name: 'opportunities.arr', label: null, type: null, sql: null, description: null }],
      },
      joins: [],
      targetWarehouseConnectionId: null,
      targetTable: null,
    });

    await fetchLookerRuntimeBundle({
      pullConfig: {
        lookerConnectionId: connectionId,
        connectionMappings: { b2b_sandbox_bq: warehouseConnectionId },
        connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
        parsedTargetTables: {
          'b2b.sales_pipeline': {
            ok: true,
            catalog: 'proj',
            schema: 'dataset',
            name: 'opportunities',
            canonicalTable: 'proj.dataset.opportunities',
          },
        },
      },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    const dashboard = JSON.parse(await readFile(join(stagedDir, 'dashboards/10.json'), 'utf-8'));
    expect(dashboard.tiles[0].query).toMatchObject({
      model: 'b2b',
      view: 'sales_pipeline',
      targetWarehouseConnectionId: warehouseConnectionId,
      targetTable: {
        ok: true,
        catalog: 'proj',
        schema: 'dataset',
        name: 'opportunities',
        canonicalTable: 'proj.dataset.opportunities',
      },
    });

    const look = JSON.parse(await readFile(join(stagedDir, 'looks/20.json'), 'utf-8'));
    expect(look.query).toMatchObject({
      model: 'b2b',
      view: 'sales_pipeline',
      targetWarehouseConnectionId: warehouseConnectionId,
      targetTable: {
        ok: true,
        catalog: 'proj',
        schema: 'dataset',
        name: 'opportunities',
        canonicalTable: 'proj.dataset.opportunities',
      },
    });
  });

  it('records skipped detail entities and keeps cursors pinned for affected entity types', async () => {
    const client = makeClient();
    vi.mocked(client.listDashboards).mockResolvedValue([
      { id: '10', updatedAt: '2026-04-30T12:00:00.000Z' },
      { id: '11', updatedAt: '2026-04-30T12:10:00.000Z' },
    ]);
    vi.mocked(client.getDashboard).mockImplementation(async (id: string) => {
      if (id === '11') {
        const error = new Error('Looker API rate limit remained after retry');
        Object.assign(error, { statusCode: 429 });
        throw error;
      }
      return {
        lookerId: id,
        title: `Dashboard ${id}`,
        description: null,
        folderId: '7',
        ownerId: '3',
        updatedAt: '2026-04-30T12:00:00.000Z',
        tiles: [],
      };
    });
    vi.mocked(client.listLooks).mockResolvedValue([{ id: '20', updatedAt: '2026-04-30T11:15:00.000Z' }]);
    vi.mocked(client.getLook).mockResolvedValue({
      lookerId: '20',
      title: 'Look 20',
      description: null,
      folderId: '7',
      ownerId: '3',
      updatedAt: '2026-04-30T11:15:00.000Z',
      query: null,
    });

    await fetchLookerRuntimeBundle({
      pullConfig: {
        lookerConnectionId: connectionId,
        dashboardUpdatedSince: '2026-04-30T12:00:00.000Z',
        lookUpdatedSince: '2026-04-30T11:00:00.000Z',
      },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    await expect(readdir(join(stagedDir, 'dashboards'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(stagedDir, 'looks'))).resolves.toEqual(['20.json']);

    const syncConfig = JSON.parse(await readFile(join(stagedDir, 'sync-config.json'), 'utf-8'));
    expect(syncConfig.nextCursors).toEqual({
      dashboardsLastSyncedAt: '2026-04-30T12:00:00.000Z',
      looksLastSyncedAt: '2026-04-30T11:15:00.000Z',
    });

    const report = JSON.parse(await readFile(join(stagedDir, 'looker-fetch-report.json'), 'utf-8'));
    expect(report).toEqual({
      status: 'partial',
      retryRecommended: true,
      skipped: [
        {
          rawPath: 'dashboards/11.json',
          entityType: 'dashboard',
          entityId: '11',
          severity: 'error',
          statusCode: 429,
          message: 'Looker API rate limit remained after retry',
          retryRecommended: true,
        },
      ],
      warnings: [],
    });
  });

  it('continues without explore bootstrap when LookML model listing is denied', async () => {
    const client = makeClient();
    const error = new Error('LookML model access denied');
    Object.assign(error, { statusCode: 403 });
    vi.mocked(client.listLookmlModels).mockRejectedValue(error);

    await fetchLookerRuntimeBundle({
      pullConfig: { lookerConnectionId: connectionId },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    await expect(readdir(join(stagedDir, 'dashboards'))).resolves.toEqual(['10.json']);
    await expect(readdir(join(stagedDir, 'looks'))).resolves.toEqual(['20.json']);
    await expect(readFile(join(stagedDir, 'lookml_models.json'), 'utf-8')).resolves.toBe('{\n  "models": []\n}\n');
    await expect(readdir(join(stagedDir, 'explores'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(client.getExplore).not.toHaveBeenCalled();

    const report = JSON.parse(await readFile(join(stagedDir, 'looker-fetch-report.json'), 'utf-8'));
    expect(report).toEqual({
      status: 'success',
      retryRecommended: false,
      skipped: [],
      warnings: [
        {
          rawPath: 'lookml_models.json',
          entityType: 'lookml_models',
          entityId: null,
          severity: 'warning',
          statusCode: 403,
          message: 'LookML model access denied',
          retryRecommended: false,
        },
      ],
    });

    const chunked = await chunkLookerStagedDir(stagedDir);
    expect(chunked.workUnits.map((wu) => wu.unitKey).sort()).toEqual(['looker-dashboard-10', 'looker-look-20']);
    expect(chunked.workUnits.flatMap((wu) => wu.dependencyPaths)).not.toContain('explores/b2b/sales_pipeline.json');
  });

  it('cleans up the Looker client after a successful fetch', async () => {
    const client = makeClient();

    await fetchLookerRuntimeBundle({
      pullConfig: { lookerConnectionId: connectionId },
      stagedDir,
      ctx: { connectionId, sourceKey: 'looker' },
      clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
      now: () => new Date('2026-04-30T12:30:00.000Z'),
    });

    expect(client.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up the Looker client when fetch throws', async () => {
    const client = makeClient();
    vi.mocked(client.listDashboards).mockRejectedValue(new Error('Looker API unavailable'));

    await expect(
      fetchLookerRuntimeBundle({
        pullConfig: { lookerConnectionId: connectionId },
        stagedDir,
        ctx: { connectionId, sourceKey: 'looker' },
        clientFactory: { createClient: vi.fn().mockResolvedValue(client) },
        now: () => new Date('2026-04-30T12:30:00.000Z'),
      }),
    ).rejects.toThrow('Looker API unavailable');

    expect(client.cleanup).toHaveBeenCalledTimes(1);
  });
});
