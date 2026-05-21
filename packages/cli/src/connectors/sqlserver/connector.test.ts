import { describe, expect, it, vi } from 'vitest';
import { createSqlServerLiveDatabaseIntrospection } from '../../connectors/sqlserver/live-database-introspection.js';
import { isKtxSqlServerConnectionConfig, KtxSqlServerScanConnector, sqlServerConnectionPoolConfigFromConfig, type KtxSqlServerPoolFactory, type KtxSqlServerQueryResult } from '../../connectors/sqlserver/connector.js';

function recordset<T extends Record<string, unknown>>(
  rows: T[],
  columnNames: string[],
): T[] & { columns: Record<string, { type: { declaration: string } }> } {
  const withColumns = rows as T[] & { columns: Record<string, { type: { declaration: string } }> };
  withColumns.columns = Object.fromEntries(columnNames.map((name) => [name, { type: { declaration: 'nvarchar' } }]));
  return withColumns;
}

function result<T extends Record<string, unknown>>(rows: T[], columnNames: string[]): KtxSqlServerQueryResult {
  return { recordset: recordset(rows, columnNames) };
}

function fakePoolFactory(): KtxSqlServerPoolFactory {
  const query = vi.fn(async (sql: string): Promise<KtxSqlServerQueryResult> => {
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return result(
        [
          { table_name: 'customers', table_type: 'BASE TABLE' },
          { table_name: 'orders', table_type: 'BASE TABLE' },
          { table_name: 'order_summary', table_type: 'VIEW' },
        ],
        ['table_name', 'table_type'],
      );
    }
    if (sql.includes("ep.name = 'MS_Description'") && sql.includes('ep.minor_id = 0')) {
      return result([{ table_name: 'customers', table_comment: 'Customer table' }], [
        'table_name',
        'table_comment',
      ]);
    }
    if (sql.includes("ep.name = 'MS_Description'") && sql.includes('ep.minor_id = c.column_id')) {
      return result([{ table_name: 'customers', column_name: 'id', column_comment: 'PK' }], [
        'table_name',
        'column_name',
        'column_comment',
      ]);
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return result(
        [
          { table_name: 'customers', column_name: 'id', data_type: 'int', is_nullable: 'NO' },
          { table_name: 'customers', column_name: 'name', data_type: 'nvarchar', is_nullable: 'NO' },
          { table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO' },
          { table_name: 'orders', column_name: 'customer_id', data_type: 'int', is_nullable: 'NO' },
          { table_name: 'orders', column_name: 'status', data_type: 'nvarchar', is_nullable: 'YES' },
          { table_name: 'order_summary', column_name: 'status', data_type: 'nvarchar', is_nullable: 'YES' },
        ],
        ['table_name', 'column_name', 'data_type', 'is_nullable'],
      );
    }
    if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      return result(
        [
          { table_name: 'customers', column_name: 'id' },
          { table_name: 'orders', column_name: 'id' },
        ],
        ['table_name', 'column_name'],
      );
    }
    if (sql.includes('REFERENTIAL_CONSTRAINTS')) {
      return result(
        [
          {
            table_name: 'orders',
            column_name: 'customer_id',
            referenced_table_schema: 'dbo',
            referenced_table_name: 'customers',
            referenced_column_name: 'id',
            constraint_name: 'orders_customer_id_fk',
          },
        ],
        [
          'table_name',
          'column_name',
          'referenced_table_schema',
          'referenced_table_name',
          'referenced_column_name',
          'constraint_name',
        ],
      );
    }
    if (sql.includes('sys.partitions') && sql.includes('GROUP BY t.name')) {
      return result(
        [
          { table_name: 'customers', row_count: 2 },
          { table_name: 'orders', row_count: 2 },
        ],
        ['table_name', 'row_count'],
      );
    }
    if (sql.includes('SELECT TOP 1 [id], [status] FROM [dbo].[orders]')) {
      return result([{ id: 10, status: 'paid' }], ['id', 'status']);
    }
    if (sql.includes('SELECT TOP 1 * FROM (select id, status from dbo.orders) AS ktx_query_result')) {
      return result([{ id: 10, status: 'paid' }], ['id', 'status']);
    }
    if (sql.includes('SELECT TOP 5 [status] FROM [dbo].[orders]')) {
      return result([{ status: 'paid' }, { status: 'open' }], ['status']);
    }
    if (sql.includes('COUNT(DISTINCT val)')) {
      return result([{ cardinality: 2 }], ['cardinality']);
    }
    if (sql.includes('SELECT TOP 10 val')) {
      return result([{ val: 'open' }, { val: 'paid' }], ['val']);
    }
    if (sql.includes('SUM(p.rows) AS row_count') && sql.includes('t.name = @tableName')) {
      return result([{ row_count: 2 }], ['row_count']);
    }
    if (sql.includes('SELECT s.name AS schema_name')) {
      return result([{ schema_name: 'dbo' }, { schema_name: 'sales' }], ['schema_name']);
    }
    if (sql.trim() === 'SELECT 1') {
      return result([{ ok: 1 }], ['ok']);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const request: { input(name: string, value: unknown): typeof request; query: typeof query } = {
    input: vi.fn((_key: string, _value: unknown) => request),
    query,
  };
  const close = vi.fn(async () => undefined);
  return {
    createPool: vi.fn(async () => ({
      request: () => request,
      close,
    })),
  };
}

describe('KtxSqlServerScanConnector', () => {
  it('resolves SQL Server connection configuration safely', () => {
    expect(
      isKtxSqlServerConnectionConfig({
        driver: 'sqlserver',
        host: 'localhost',
        database: 'analytics',
      }),
    ).toBe(true);
    expect(isKtxSqlServerConnectionConfig({ driver: 'mysql', host: 'localhost', database: 'analytics' })).toBe(false);
    expect(
      sqlServerConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'sqlserver',
          host: 'db.example.test',
          port: 14330,
          database: 'analytics',
          username: 'reader',
          trustServerCertificate: false,
        },
      }),
    ).toMatchObject({
      server: 'db.example.test',
      port: 14330,
      database: 'analytics',
      user: 'reader',
      options: { encrypt: true, trustServerCertificate: false },
    });
  });

  it('introspects schema, primary keys, comments, row counts, views, and foreign keys', async () => {
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T16:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlserver' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'sqlserver',
      extractedAt: '2026-04-29T16:00:00.000Z',
      scope: { catalogs: ['analytics'], schemas: ['dbo'] },
      metadata: {
        database: 'analytics',
        host: 'db.example.test',
        schemas: ['dbo'],
        table_count: 3,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows, table.comment])).toEqual([
      ['customers', 'table', 2, 'Customer table'],
      ['orders', 'table', 2, null],
      ['order_summary', 'view', null, null],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'customers')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'int',
      normalizedType: 'int',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
      comment: 'PK',
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual([
      {
        fromColumn: 'customer_id',
        toCatalog: 'analytics',
        toDb: 'dbo',
        toTable: 'customers',
        toColumn: 'id',
        constraintName: 'orders_customer_id_fk',
      },
    ]);
  });

  it('runs samples, distinct values, read-only SQL, row count, schema list, and cleanup', async () => {
    const poolFactory = fakePoolFactory();
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory,
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'analytics', db: 'dbo', name: 'orders' },
          columns: ['id', 'status'],
          limit: 1,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({
      headers: ['id', 'status'],
      headerTypes: ['nvarchar', 'nvarchar'],
      rows: [[10, 'paid']],
      totalRows: 1,
    });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: 'analytics', db: 'dbo', name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: 'analytics', db: 'dbo', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from dbo.orders', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(connector.getTableRowCount('orders')).resolves.toBe(2);
    await expect(connector.listSchemas()).resolves.toEqual(['dbo', 'sales']);
    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: 'analytics', db: 'dbo', name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();

    await connector.cleanup();
  });

  it('adapts native SQL Server snapshots to live-database introspection for local ingest', async () => {
    const introspection = createSqlServerLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'sqlserver',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          schema: 'dbo',
        },
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T16:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T16:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'customers')).toMatchObject({
      name: 'customers',
      catalog: 'analytics',
      db: 'dbo',
      columns: [
        {
          name: 'id',
          nativeType: 'int',
          normalizedType: 'int',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'PK',
        },
        {
          name: 'name',
          nativeType: 'nvarchar',
          normalizedType: 'nvarchar',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
      ],
      foreignKeys: [],
    });
  });
});
