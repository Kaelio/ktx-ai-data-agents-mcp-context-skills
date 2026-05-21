import { describe, expect, it, vi } from 'vitest';
import { bigQueryConnectionConfigFromConfig, isKtxBigQueryConnectionConfig, type KtxBigQueryClient, KtxBigQueryScanConnector, type KtxBigQueryClientFactory, type KtxBigQueryDataset, type KtxBigQueryQueryJob, type KtxBigQueryTableRef } from '../../connectors/bigquery/connector.js';
import { createBigQueryLiveDatabaseIntrospection } from '../../connectors/bigquery/live-database-introspection.js';

function fakeClientFactory(): KtxBigQueryClientFactory {
  const queryResults = vi.fn(async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
    [{ id: 1, status: 'paid' }],
    undefined,
    { schema: { fields: [{ name: 'id', type: 'INT64' }, { name: 'status', type: 'STRING' }] } },
  ]);
  const createQueryJob = vi.fn(async (input: { query: string }): ReturnType<KtxBigQueryClient['createQueryJob']> => {
    if (input.query.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ table_name: 'orders', column_name: 'id' }],
            undefined,
            { schema: { fields: [{ name: 'table_name', type: 'STRING' }, { name: 'column_name', type: 'STRING' }] } },
          ],
        },
      ];
    }
    if (input.query.includes('APPROX_COUNT_DISTINCT')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ cardinality: 2 }],
            undefined,
            { schema: { fields: [{ name: 'cardinality', type: 'INT64' }] } },
          ],
        },
      ];
    }
    if (input.query.includes('SELECT DISTINCT CAST')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ val: 'open' }, { val: 'paid' }],
            undefined,
            { schema: { fields: [{ name: 'val', type: 'STRING' }] } },
          ],
        },
      ];
    }
    if (input.query.includes('SELECT `status`')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ status: 'paid' }],
            undefined,
            { schema: { fields: [{ name: 'status', type: 'STRING' }] } },
          ],
        },
      ];
    }
    return [{ getQueryResults: queryResults }];
  });
  const getTable = vi.fn(async (): ReturnType<KtxBigQueryTableRef['get']> => [
    {
      metadata: {
        type: 'TABLE',
        numRows: '12',
        description: 'Orders table',
        schema: {
          fields: [
            { name: 'id', type: 'INT64', mode: 'REQUIRED', description: 'Order id' },
            { name: 'status', type: 'STRING', mode: 'NULLABLE' },
            { name: 'payload', type: 'RECORD', mode: 'NULLABLE' },
          ],
        },
      },
    },
  ]);
  const tableRef: KtxBigQueryTableRef = { id: 'orders', get: getTable };
  return {
    createClient: vi.fn(() => ({
      getDatasets: vi.fn(async (): ReturnType<KtxBigQueryClient['getDatasets']> => [[{ id: 'analytics' }, { id: 'staging' }]]),
      dataset: vi.fn(
        (datasetId: string): KtxBigQueryDataset => ({
        get: vi.fn(async () => [{ id: datasetId }]),
        getTables: vi.fn(async (): ReturnType<KtxBigQueryDataset['getTables']> => [[tableRef]]),
      }),
      ),
      createQueryJob,
    })),
  };
}

const connection = {
  driver: 'bigquery',
  dataset_id: 'analytics',
  credentials_json: JSON.stringify({ project_id: 'project-1', client_email: 'reader@example.test' }),
  location: 'US',
} as const;

describe('KtxBigQueryScanConnector', () => {
  it('resolves configuration safely', () => {
    expect(isKtxBigQueryConnectionConfig(connection)).toBe(true);
    expect(isKtxBigQueryConnectionConfig({ driver: 'mysql' })).toBe(false);
    expect(bigQueryConnectionConfigFromConfig({ connectionId: 'warehouse', connection })).toMatchObject({
      projectId: 'project-1',
      datasetIds: ['analytics'],
      location: 'US',
    });
  });

  it('introspects datasets, table metadata, primary keys, and normalized types', async () => {
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-04-29T17:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'bigquery' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'bigquery',
      extractedAt: '2026-04-29T17:00:00.000Z',
      scope: { catalogs: ['project-1'], datasets: ['analytics'] },
      metadata: {
        project_id: 'project-1',
        datasets: ['analytics'],
        table_count: 1,
        total_columns: 3,
      },
    });
    expect(snapshot.tables[0]).toMatchObject({
      catalog: 'project-1',
      db: 'analytics',
      name: 'orders',
      kind: 'table',
      comment: 'Orders table',
      estimatedRows: 12,
      foreignKeys: [],
    });
    expect(snapshot.tables[0]?.columns).toEqual([
      {
        name: 'id',
        nativeType: 'INT64',
        normalizedType: 'BIGINT',
        dimensionType: 'number',
        nullable: false,
        primaryKey: true,
        comment: 'Order id',
      },
      {
        name: 'status',
        nativeType: 'STRING',
        normalizedType: 'VARCHAR',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
      {
        name: 'payload',
        nativeType: 'RECORD',
        normalizedType: 'JSON',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
    ]);
  });

  it('runs samples, read-only SQL, distinct values, dataset listing, row counts, and cleanup', async () => {
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'project-1', db: 'analytics', name: 'orders' },
          columns: ['id', 'status'],
          limit: 1,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({
      headers: ['id', 'status'],
      headerTypes: ['INT64', 'STRING'],
      rows: [[1, 'paid']],
      totalRows: 1,
    });

    await expect(
      connector.sampleColumn(
        {
          connectionId: 'warehouse',
          table: { catalog: 'project-1', db: 'analytics', name: 'orders' },
          column: 'status',
          limit: 5,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid'], nullCount: null, distinctCount: null });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from `project-1`.`analytics`.`orders`', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[1, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(
      connector.getColumnDistinctValues(
        { catalog: 'project-1', db: 'analytics', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(connector.getTableRowCount('orders')).resolves.toBe(12);
    await expect(connector.listDatasets()).resolves.toEqual(['analytics', 'staging']);
    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: 'project-1', db: 'analytics', name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();
    await connector.cleanup();
  });

  it('applies maximumBytesBilled to read-only queries when configured', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory,
      maxBytesBilled: 123456789,
    });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from `project-1`.`analytics`.`orders`', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ rows: [[1, 'paid']], rowCount: 1 });

    const client = vi.mocked(clientFactory.createClient).mock.results[0]?.value as KtxBigQueryClient;
    expect(client.createQueryJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maximumBytesBilled: '123456789',
      }),
    );
  });

  it('applies canonical BigQuery YAML scan limits to query jobs', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: { ...connection, max_bytes_billed: '987654321', job_timeout_ms: 30_000 },
      clientFactory,
    });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from `project-1`.`analytics`.`orders`', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ rows: [[1, 'paid']], rowCount: 1 });

    const client = vi.mocked(clientFactory.createClient).mock.results[0]?.value as KtxBigQueryClient;
    expect(client.createQueryJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maximumBytesBilled: '987654321',
        jobTimeoutMs: 30_000,
      }),
    );
  });

  it('adapts native snapshots to live-database introspection snapshots', async () => {
    const introspection = createBigQueryLiveDatabaseIntrospection({
      connections: { warehouse: connection },
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-04-29T17:00:00.000Z'),
    });

    await expect(introspection.extractSchema('warehouse')).resolves.toMatchObject({
      connectionId: 'warehouse',
      metadata: { project_id: 'project-1' },
      tables: expect.arrayContaining([
        expect.objectContaining({
          catalog: 'project-1',
          db: 'analytics',
          name: 'orders',
          columns: expect.arrayContaining([
            {
              name: 'id',
              nativeType: 'INT64',
              normalizedType: 'BIGINT',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Order id',
            },
          ]),
        }),
      ]),
    });
  });
});
