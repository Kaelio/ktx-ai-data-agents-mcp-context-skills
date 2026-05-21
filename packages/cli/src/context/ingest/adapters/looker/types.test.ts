import { describe, expect, it } from 'vitest';
import { parsedTargetTableSchema } from '../../parsed-target-table.js';
import {
  lookerPullConfigSchema,
  parseLookerPullConfig,
  stagedDashboardFileSchema,
  stagedExploreFileSchema,
  stagedLookerFetchIssueSchema,
  stagedLookerQuerySchema,
  stagedLookerScopeFileSchema,
  stagedLookerSignalsFileSchema,
  stagedLookFileSchema,
  stagedSyncConfigSchema,
} from './types.js';

describe('Looker staged runtime schemas', () => {
  it('parses pull config and staged sync config', () => {
    expect(
      lookerPullConfigSchema.parse({
        lookerConnectionId: '11111111-1111-4111-8111-111111111111',
        instanceBaseUrl: 'https://example.looker.com',
      }),
    ).toEqual({
      lookerConnectionId: '11111111-1111-4111-8111-111111111111',
      instanceBaseUrl: 'https://example.looker.com',
      connectionMappings: {},
      connectionTypes: {},
      parsedTargetTables: {},
    });

    expect(
      stagedSyncConfigSchema.parse({
        lookerConnectionId: '11111111-1111-4111-8111-111111111111',
        fetchedAt: '2026-04-30T12:00:00.000Z',
        instanceBaseUrl: 'https://example.looker.com',
      }),
    ).toMatchObject({
      lookerConnectionId: '11111111-1111-4111-8111-111111111111',
      instanceBaseUrl: 'https://example.looker.com',
    });
  });

  it('parses incremental pull cursors and scope manifests', () => {
    expect(
      parseLookerPullConfig({
        lookerConnectionId: '11111111-1111-4111-8111-111111111111',
        dashboardUpdatedSince: '2026-04-30T10:00:00.000Z',
        lookUpdatedSince: '2026-04-30T11:00:00.000Z',
      }),
    ).toEqual({
      lookerConnectionId: '11111111-1111-4111-8111-111111111111',
      dashboardUpdatedSince: '2026-04-30T10:00:00.000Z',
      lookUpdatedSince: '2026-04-30T11:00:00.000Z',
      connectionMappings: {},
      connectionTypes: {},
      parsedTargetTables: {},
    });

    expect(
      stagedLookerScopeFileSchema.parse({
        mode: 'incremental',
        knownCurrentRawPaths: ['dashboards/10.json', 'looks/20.json'],
        fetchedRawPaths: ['dashboards/10.json'],
      }),
    ).toEqual({
      mode: 'incremental',
      knownCurrentRawPaths: ['dashboards/10.json', 'looks/20.json'],
      fetchedRawPaths: ['dashboards/10.json'],
    });

    expect(
      stagedSyncConfigSchema.parse({
        lookerConnectionId: '11111111-1111-4111-8111-111111111111',
        fetchedAt: '2026-04-30T12:30:00.000Z',
        previousCursors: {
          dashboardsLastSyncedAt: null,
          looksLastSyncedAt: '2026-04-30T11:00:00.000Z',
        },
        nextCursors: {
          dashboardsLastSyncedAt: '2026-04-30T12:00:00.000Z',
          looksLastSyncedAt: '2026-04-30T11:00:00.000Z',
        },
      }).nextCursors,
    ).toEqual({
      dashboardsLastSyncedAt: '2026-04-30T12:00:00.000Z',
      looksLastSyncedAt: '2026-04-30T11:00:00.000Z',
    });
  });

  it('normalizes numeric Looker ids to strings', () => {
    const dashboard = stagedDashboardFileSchema.parse({
      lookerId: 10,
      title: 'Sales Pipeline',
      description: null,
      folderId: 7,
      ownerId: 3,
      updatedAt: '2026-04-30T12:00:00.000Z',
      tiles: [{ id: 100, title: 'ARR', lookId: null, query: { model: 'b2b', view: 'sales_pipeline' } }],
    });

    expect(dashboard.lookerId).toBe('10');
    expect(dashboard.folderId).toBe('7');
    expect(dashboard.ownerId).toBe('3');
    expect(dashboard.tiles[0].id).toBe('100');
  });

  it('parses explores, looks, and signal files with defaults', () => {
    expect(
      stagedExploreFileSchema.parse({
        modelName: 'b2b',
        exploreName: 'sales_pipeline',
        label: 'Sales Pipeline',
        description: null,
        fields: {
          dimensions: [{ name: 'opportunities.id', label: 'Opportunity ID', type: 'number', sql: '${TABLE}.id' }],
          measures: [{ name: 'opportunities.arr', label: 'ARR', type: 'sum', sql: '${TABLE}.arr' }],
        },
        joins: [{ name: 'accounts', type: 'left_outer', relationship: 'many_to_one' }],
      }),
    ).toMatchObject({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      fields: { dimensions: [{ name: 'opportunities.id' }], measures: [{ name: 'opportunities.arr' }] },
    });

    expect(
      stagedLookFileSchema.parse({
        lookerId: '20',
        title: 'Open Pipeline',
        description: null,
        folderId: null,
        ownerId: null,
        updatedAt: null,
        query: { model: 'b2b', view: 'sales_pipeline', fields: ['opportunities.arr'] },
      }),
    ).toMatchObject({ lookerId: '20', query: { fields: ['opportunities.arr'] } });

    expect(stagedLookerSignalsFileSchema.parse({}).dashboardUsage).toEqual([]);
  });

  it('parses warehouse SL mapping pull config and staged target table fields', () => {
    const targetConnectionId = '22222222-2222-4222-8222-222222222222';
    const parsedTargetTable = {
      ok: true as const,
      catalog: 'proj',
      schema: 'dataset',
      name: 'opportunities',
      canonicalTable: 'proj.dataset.opportunities',
    };

    expect(parsedTargetTableSchema.parse(parsedTargetTable)).toEqual(parsedTargetTable);

    expect(
      parseLookerPullConfig({
        lookerConnectionId: '11111111-1111-4111-8111-111111111111',
        connectionMappings: { b2b_sandbox_bq: targetConnectionId },
        connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
        parsedTargetTables: { 'b2b.sales_pipeline': parsedTargetTable },
      }),
    ).toEqual({
      lookerConnectionId: '11111111-1111-4111-8111-111111111111',
      connectionMappings: { b2b_sandbox_bq: targetConnectionId },
      connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
      parsedTargetTables: { 'b2b.sales_pipeline': parsedTargetTable },
    });

    expect(
      stagedExploreFileSchema.parse({
        modelName: 'b2b',
        exploreName: 'sales_pipeline',
        label: 'Sales Pipeline',
        description: null,
        rawSqlTableName: 'proj.dataset.opportunities AS opportunities',
        connectionName: 'b2b_sandbox_bq',
        viewName: 'opportunities',
        fields: {
          dimensions: [{ name: 'opportunities.id', label: 'Opportunity ID', type: 'number', sql: '${TABLE}.id' }],
          measures: [{ name: 'opportunities.arr', label: 'ARR', type: 'sum', sql: '${TABLE}.arr' }],
        },
        joins: [
          {
            name: 'accounts',
            type: 'left_outer',
            relationship: 'many_to_one',
            rawSqlTableName: 'proj.dataset.accounts',
            sqlOn: '${opportunities.account_id} = ${accounts.id}',
            from: null,
            targetTable: {
              ok: true,
              catalog: 'proj',
              schema: 'dataset',
              name: 'accounts',
              canonicalTable: 'proj.dataset.accounts',
            },
          },
        ],
        targetWarehouseConnectionId: targetConnectionId,
        targetTable: parsedTargetTable,
      }),
    ).toMatchObject({
      modelName: 'b2b',
      exploreName: 'sales_pipeline',
      connectionName: 'b2b_sandbox_bq',
      targetWarehouseConnectionId: targetConnectionId,
      targetTable: parsedTargetTable,
      joins: [{ name: 'accounts', targetTable: { ok: true, name: 'accounts' } }],
    });
  });

  it('parses structured Looker mapping fetch warnings', () => {
    expect(
      stagedLookerFetchIssueSchema.parse({
        rawPath: 'looker_connection_mappings/b2b_sandbox_bq',
        entityType: 'looker_connection_mapping',
        entityId: 'b2b_sandbox_bq',
        severity: 'warning',
        statusCode: null,
        message: 'Looker connection b2b_sandbox_bq is not mapped to a warehouse connection.',
        retryRecommended: false,
        kind: 'unmapped_looker_connection',
        details: {
          lookerConnectionName: 'b2b_sandbox_bq',
          affectedExplores: ['b2b.sales_pipeline'],
        },
      }),
    ).toMatchObject({
      entityType: 'looker_connection_mapping',
      kind: 'unmapped_looker_connection',
      details: {
        lookerConnectionName: 'b2b_sandbox_bq',
        affectedExplores: ['b2b.sales_pipeline'],
      },
    });
  });

  it('parses LookML model listing warnings in fetch reports', () => {
    expect(
      stagedLookerFetchIssueSchema.parse({
        rawPath: 'lookml_models.json',
        entityType: 'lookml_models',
        entityId: null,
        severity: 'warning',
        statusCode: 403,
        message: 'LookML model access denied',
        retryRecommended: false,
      }),
    ).toEqual({
      rawPath: 'lookml_models.json',
      entityType: 'lookml_models',
      entityId: null,
      severity: 'warning',
      statusCode: 403,
      message: 'LookML model access denied',
      retryRecommended: false,
    });
  });

  it('accepts slug-shaped connection ids inside KTX Looker runtime schemas', () => {
    const parsedTargetTable = {
      ok: true as const,
      catalog: 'proj',
      schema: 'dataset',
      name: 'opportunities',
      canonicalTable: 'proj.dataset.opportunities',
    };

    expect(
      parseLookerPullConfig({
        lookerConnectionId: 'prod-looker',
        connectionMappings: { b2b_sandbox_bq: 'prod-warehouse' },
        connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
        parsedTargetTables: { 'b2b.sales_pipeline': parsedTargetTable },
      }),
    ).toMatchObject({
      lookerConnectionId: 'prod-looker',
      connectionMappings: { b2b_sandbox_bq: 'prod-warehouse' },
    });

    expect(
      stagedSyncConfigSchema.parse({
        lookerConnectionId: 'prod-looker',
        fetchedAt: '2026-04-30T12:00:00.000Z',
      }),
    ).toMatchObject({
      lookerConnectionId: 'prod-looker',
    });

    expect(
      stagedLookerQuerySchema.parse({
        model: 'b2b',
        view: 'sales_pipeline',
        targetWarehouseConnectionId: 'prod-warehouse',
        targetTable: parsedTargetTable,
      }),
    ).toMatchObject({
      targetWarehouseConnectionId: 'prod-warehouse',
      targetTable: parsedTargetTable,
    });

    expect(
      stagedExploreFileSchema.parse({
        modelName: 'b2b',
        exploreName: 'sales_pipeline',
        label: 'Sales Pipeline',
        description: null,
        fields: { dimensions: [], measures: [] },
        targetWarehouseConnectionId: 'prod-warehouse',
        targetTable: parsedTargetTable,
      }),
    ).toMatchObject({
      targetWarehouseConnectionId: 'prod-warehouse',
      targetTable: parsedTargetTable,
    });
  });

  it('rejects unsafe KTX Looker connection ids', () => {
    expect(() =>
      parseLookerPullConfig({
        lookerConnectionId: '../prod-looker',
      }),
    ).toThrow();

    expect(() =>
      parseLookerPullConfig({
        connectionMappings: { b2b_sandbox_bq: 'prod/warehouse' },
      }),
    ).toThrow();
  });
});
