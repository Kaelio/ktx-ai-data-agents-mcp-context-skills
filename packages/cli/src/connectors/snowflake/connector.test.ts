import { describe, expect, it, vi } from 'vitest';
import { createSnowflakeLiveDatabaseIntrospection } from '../../connectors/snowflake/live-database-introspection.js';
import { isKtxSnowflakeConnectionConfig, KtxSnowflakeScanConnector, snowflakeConnectionConfigFromConfig, type KtxSnowflakeDriver, type KtxSnowflakeDriverFactory } from '../../connectors/snowflake/connector.js';

function fakeDriverFactory(): KtxSnowflakeDriverFactory {
  const driver: KtxSnowflakeDriver = {
    test: vi.fn(async () => ({ success: true })),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        return { headers: ['TABLE_NAME', 'COLUMN_NAME'], rows: [['ORDERS', 'ID']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT "ID", "STATUS" FROM "ANALYTICS"."PUBLIC"."ORDERS"')) {
        return {
          headers: ['ID', 'STATUS'],
          headerTypes: ['NUMBER', 'VARCHAR'],
          rows: [[1, 'paid']],
          totalRows: 1,
          rowCount: 1,
        };
      }
      if (sql.includes('select * from (select ID, STATUS from ORDERS) as ktx_query_result limit 1')) {
        return { headers: ['ID', 'STATUS'], rows: [[1, 'paid']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT "STATUS" FROM "ANALYTICS"."PUBLIC"."ORDERS"')) {
        return { headers: ['STATUS'], rows: [['paid'], ['open']], totalRows: 2, rowCount: 2 };
      }
      if (sql.includes('COUNT(DISTINCT val)')) {
        return { headers: ['CARDINALITY'], rows: [[2]], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT "STATUS"::VARCHAR AS val')) {
        return { headers: ['VAL'], rows: [['open'], ['paid']], totalRows: 2, rowCount: 2 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    getSchemaMetadata: vi.fn(async () => [
      {
        name: 'ORDERS',
        catalog: 'ANALYTICS',
        db: 'PUBLIC',
        rowCount: 12,
        comment: 'Orders',
        columns: [
          { name: 'ID', type: 'NUMBER(38,0)', nullable: false, comment: 'Primary key' },
          { name: 'STATUS', type: 'VARCHAR', nullable: true, comment: null },
        ],
      },
      {
        name: 'ORDER_SUMMARY',
        catalog: 'ANALYTICS',
        db: 'PUBLIC',
        rowCount: 3,
        comment: null,
        columns: [{ name: 'STATUS', type: 'VARCHAR', nullable: true, comment: null }],
      },
    ]),
    listSchemas: vi.fn(async () => ['PUBLIC', 'MART']),
    listTables: vi.fn(async () => [
      { schema: 'PUBLIC', name: 'ORDERS', kind: 'table' as const },
      { schema: 'PUBLIC', name: 'ORDER_SUMMARY', kind: 'view' as const },
    ]),
    cleanup: vi.fn(async () => undefined),
  };
  return { createDriver: vi.fn(() => driver) };
}

describe('KtxSnowflakeScanConnector', () => {
  it('resolves Snowflake connection configuration safely', () => {
    expect(
      isKtxSnowflakeConnectionConfig({
        driver: 'snowflake',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        username: 'reader',
      }),
    ).toBe(true);
    expect(isKtxSnowflakeConnectionConfig({ driver: 'bigquery' })).toBe(false);
    expect(
      snowflakeConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'snowflake',
          authMethod: 'password',
          account: 'acct',
          warehouse: 'WH',
          database: 'ANALYTICS',
          schema_name: 'PUBLIC',
          username: 'reader',
          password: 'fixture-pass', // pragma: allowlist secret
        },
      }),
    ).toMatchObject({
      account: 'acct',
      warehouse: 'WH',
      database: 'ANALYTICS',
      schemas: ['PUBLIC'],
      username: 'reader',
      authMethod: 'password',
    });
  });

  it('introspects schema, primary keys, comments, row counts, and dimensions', async () => {
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory: fakeDriverFactory(),
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'snowflake' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'snowflake',
      extractedAt: '2026-04-29T18:00:00.000Z',
      scope: { catalogs: ['ANALYTICS'], schemas: ['PUBLIC'] },
      metadata: {
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schemas: ['PUBLIC'],
        table_count: 2,
        total_columns: 3,
      },
    });
    expect(snapshot.tables.find((table) => table.name === 'ORDERS')?.columns).toEqual([
      {
        name: 'ID',
        nativeType: 'NUMBER(38,0)',
        normalizedType: 'NUMBER(38,0)',
        dimensionType: 'number',
        nullable: false,
        primaryKey: true,
        comment: 'Primary key',
      },
      {
        name: 'STATUS',
        nativeType: 'VARCHAR',
        normalizedType: 'VARCHAR',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
    ]);
  });

  it('continues introspection when primary-key discovery is not authorized', async () => {
    const driverFactory = fakeDriverFactory();
    const driver = (driverFactory.createDriver as ReturnType<typeof vi.fn>).getMockImplementation() as
      | (() => KtxSnowflakeDriver)
      | undefined;
    if (!driver) throw new Error('driver mock missing');
    const built = driver();
    (built.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        throw new Error(
          "SQL compilation error: Object 'ANALYTICS.INFORMATION_SCHEMA.KEY_COLUMN_USAGE' does not exist or not authorized.",
        );
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    (driverFactory.createDriver as ReturnType<typeof vi.fn>).mockReturnValue(built);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const connector = new KtxSnowflakeScanConnector({
        connectionId: 'warehouse',
        connection: {
          driver: 'snowflake',
          authMethod: 'password',
          account: 'acct',
          warehouse: 'WH',
          database: 'ANALYTICS',
          schema_name: 'PUBLIC',
          username: 'reader',
          password: 'fixture-pass', // pragma: allowlist secret
        },
        driverFactory,
      });

      const snapshot = await connector.introspect(
        { connectionId: 'warehouse', driver: 'snowflake' },
        { runId: 'scan-run-pk-skip' },
      );

      expect(snapshot.tables.map((table) => table.name).sort()).toEqual(['ORDERS', 'ORDER_SUMMARY']);
      expect(snapshot.tables.every((table) => table.columns.every((column) => column.primaryKey === false))).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Snowflake primary-key discovery skipped for ANALYTICS.PUBLIC'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('supports read-only query, sampling, distinct values, row counts, schema listing, and cleanup', async () => {
    const driverFactory = fakeDriverFactory();
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory,
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' },
          limit: 1,
          columns: ['ID', 'STATUS'],
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['ID', 'STATUS'], rows: [[1, 'paid']], totalRows: 1 });
    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select ID, STATUS from ORDERS', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['ID', 'STATUS'], rows: [[1, 'paid']], rowCount: 1 });
    await expect(
      connector.sampleColumn(
        {
          connectionId: 'warehouse',
          table: { catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' },
          column: 'STATUS',
          limit: 2,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ values: ['paid', 'open'], nullCount: null, distinctCount: null });
    await expect(
      connector.getColumnDistinctValues({ catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' }, 'STATUS', {
        maxCardinality: 10,
        limit: 5,
      }),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(connector.getTableRowCount('ORDERS')).resolves.toBe(12);
    await expect(connector.listSchemas()).resolves.toEqual(['PUBLIC', 'MART']);
    await connector.cleanup();
    const driver = (driverFactory.createDriver as ReturnType<typeof vi.fn>).mock.results[0]?.value as KtxSnowflakeDriver;
    expect(driver.cleanup).toHaveBeenCalledTimes(1);
  });

  it('converts a native snapshot into a live-database introspection snapshot', async () => {
    const introspection = createSnowflakeLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'snowflake',
          authMethod: 'password',
          account: 'acct',
          warehouse: 'WH',
          database: 'ANALYTICS',
          schema_name: 'PUBLIC',
          username: 'reader',
          password: 'fixture-pass', // pragma: allowlist secret
        },
      },
      driverFactory: fakeDriverFactory(),
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    });

    await expect(introspection.extractSchema('warehouse')).resolves.toMatchObject({
      connectionId: 'warehouse',
      metadata: { database: 'ANALYTICS', schemas: ['PUBLIC'] },
      tables: expect.arrayContaining([
        expect.objectContaining({ catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' }),
      ]),
    });
  });
});
