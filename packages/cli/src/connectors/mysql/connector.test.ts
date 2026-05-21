import { describe, expect, it, vi } from 'vitest';
import type { FieldPacket, RowDataPacket } from 'mysql2/promise';
import { createMysqlLiveDatabaseIntrospection } from '../../connectors/mysql/live-database-introspection.js';
import { isKtxMysqlConnectionConfig, KtxMysqlScanConnector, mysqlConnectionPoolConfigFromConfig, type KtxMysqlPoolFactory } from '../../connectors/mysql/connector.js';

function mysqlResult(rows: Record<string, unknown>[], fields: Array<{ name: string; type?: number }>): [RowDataPacket[], FieldPacket[]] {
  return [rows as RowDataPacket[], fields as FieldPacket[]];
}

function fakePoolFactory(): KtxMysqlPoolFactory {
  const query = vi.fn(async (sql: string, params?: unknown): Promise<[RowDataPacket[], FieldPacket[]]> => {
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return mysqlResult(
        [
          { TABLE_NAME: 'customers', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: 'Customer table', TABLE_ROWS: 2 },
          { TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: 'InnoDB free: 1 kB; Order table', TABLE_ROWS: 2 },
          { TABLE_NAME: 'order_summary', TABLE_TYPE: 'VIEW', TABLE_COMMENT: '', TABLE_ROWS: null },
        ],
        [{ name: 'TABLE_NAME' }, { name: 'TABLE_TYPE' }, { name: 'TABLE_COMMENT' }, { name: 'TABLE_ROWS' }],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return mysqlResult(
        [
          { TABLE_NAME: 'customers', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_COMMENT: 'PK' },
          { TABLE_NAME: 'customers', COLUMN_NAME: 'name', DATA_TYPE: 'varchar', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'orders', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'orders', COLUMN_NAME: 'customer_id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'orders', COLUMN_NAME: 'status', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'order_summary', COLUMN_NAME: 'status', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES', COLUMN_COMMENT: '' },
        ],
        [{ name: 'TABLE_NAME' }, { name: 'COLUMN_NAME' }, { name: 'DATA_TYPE' }, { name: 'IS_NULLABLE' }],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && sql.includes("CONSTRAINT_NAME = 'PRIMARY'")) {
      return mysqlResult([{ TABLE_NAME: 'customers', COLUMN_NAME: 'id' }, { TABLE_NAME: 'orders', COLUMN_NAME: 'id' }], []);
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) {
      return mysqlResult(
        [
          {
            TABLE_NAME: 'orders',
            COLUMN_NAME: 'customer_id',
            REFERENCED_TABLE_NAME: 'customers',
            REFERENCED_COLUMN_NAME: 'id',
            CONSTRAINT_NAME: 'orders_customer_id_fk',
          },
        ],
        [],
      );
    }
    if (sql.includes('SELECT `id`, `status` FROM `analytics`.`orders` LIMIT 1')) {
      return mysqlResult([{ id: 10, status: 'paid' }], [{ name: 'id', type: 3 }, { name: 'status', type: 253 }]);
    }
    if (sql.includes('select * from (select id, status from analytics.orders) as ktx_query_result limit 1')) {
      return mysqlResult([{ id: 10, status: 'paid' }], [{ name: 'id', type: 3 }, { name: 'status', type: 253 }]);
    }
    if (sql.includes('SELECT `status` FROM `analytics`.`orders`')) {
      return mysqlResult([{ status: 'paid' }, { status: 'open' }], [{ name: 'status', type: 253 }]);
    }
    if (sql.includes('COUNT(DISTINCT val)')) {
      return mysqlResult([{ cardinality: 2 }], [{ name: 'cardinality', type: 8 }]);
    }
    if (sql.includes('SELECT DISTINCT CAST(`status` AS CHAR) AS val')) {
      return mysqlResult([{ val: 'open' }, { val: 'paid' }], [{ name: 'val', type: 253 }]);
    }
    if (sql.includes('COUNT(*) AS count')) {
      return mysqlResult([{ count: 2 }], [{ name: 'count', type: 8 }]);
    }
    if (sql.includes('INFORMATION_SCHEMA.SCHEMATA')) {
      return mysqlResult([{ SCHEMA_NAME: 'analytics' }, { SCHEMA_NAME: 'warehouse' }], [{ name: 'SCHEMA_NAME' }]);
    }
    if (sql.trim() === 'SELECT 1') {
      return mysqlResult([{ '1': 1 }], [{ name: '1', type: 8 }]);
    }
    throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params)}`);
  });
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  return {
    createPool: vi.fn(() => ({
      getConnection: vi.fn(async () => ({ query, release })),
      end,
    })),
  };
}

describe('KtxMysqlScanConnector', () => {
  it('resolves MySQL connection configuration safely', () => {
    expect(isKtxMysqlConnectionConfig({ driver: 'mysql', host: 'localhost', database: 'analytics' })).toBe(true);
    expect(isKtxMysqlConnectionConfig({ driver: 'postgres', host: 'localhost', database: 'analytics' })).toBe(false);
    expect(
      mysqlConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'mysql',
          host: 'db.example.test',
          port: 3307,
          database: 'analytics',
          username: 'reader',
          password: 'secret', // pragma: allowlist secret
          ssl: true,
        },
      }),
    ).toMatchObject({
      host: 'db.example.test',
      port: 3307,
      database: 'analytics',
      user: 'reader',
      password: 'secret', // pragma: allowlist secret
      ssl: { rejectUnauthorized: false },
    });
  });

  it('introspects schema, primary keys, comments, row counts, views, and foreign keys', async () => {
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'mysql' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'mysql',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['analytics'] },
      metadata: {
        database: 'analytics',
        host: 'db.example.test',
        table_count: 3,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows, table.comment])).toEqual([
      ['customers', 'table', 2, 'Customer table'],
      ['orders', 'table', 2, 'Order table'],
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
        toCatalog: null,
        toDb: 'analytics',
        toTable: 'customers',
        toColumn: 'id',
        constraintName: 'orders_customer_id_fk',
      },
    ]);
  });

  it('runs samples, distinct values, read-only SQL, row count, schema list, and cleanup', async () => {
    const poolFactory = fakePoolFactory();
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory,
    });

    await expect(
      connector.sampleTable(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, columns: ['id', 'status'], limit: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: 'analytics', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from analytics.orders', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(connector.getTableRowCount('orders')).resolves.toBe(2);
    await expect(connector.listSchemas()).resolves.toEqual(['analytics', 'warehouse']);
    await expect(connector.columnStats(
      { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, column: 'status' },
      { runId: 'scan-run-1' },
    )).resolves.toBeNull();

    await connector.cleanup();
  });

  it('adapts native MySQL snapshots to live-database introspection for local ingest', async () => {
    const introspection = createMysqlLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'mysql',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'secret', // pragma: allowlist secret
        },
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'customers')).toMatchObject({
      name: 'customers',
      catalog: null,
      db: 'analytics',
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
          nativeType: 'varchar',
          normalizedType: 'varchar',
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
