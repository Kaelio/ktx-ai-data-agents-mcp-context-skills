import { describe, expect, it, vi } from 'vitest';
import {
  createPostgresLiveDatabaseIntrospection,
  isKtxPostgresConnectionConfig,
  KtxPostgresScanConnector,
  postgresPoolConfigFromConfig,
  type KtxPostgresPoolFactory,
} from './index.js';

interface FakeQueryResult {
  rows: Record<string, unknown>[];
  fields?: Array<{ name: string; dataTypeID: number }>;
}

function fakePoolFactory(results: Map<string, FakeQueryResult>): KtxPostgresPoolFactory {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    for (const [key, value] of results.entries()) {
      if (normalized.includes(key)) {
        return value;
      }
    }
    throw new Error(`Unexpected SQL: ${normalized} params=${JSON.stringify(params ?? [])}`);
  });
  return {
    createPool() {
      return {
        async connect() {
          return {
            query,
            release: vi.fn(),
          };
        },
        end: vi.fn(async () => undefined),
      };
    },
  };
}

function metadataResults(): Map<string, FakeQueryResult> {
  return new Map<string, FakeQueryResult>([
    [
      'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n',
      {
        rows: [
          { table_name: 'customers', table_kind: 'r', row_count: '2', table_comment: 'Customers' },
          { table_name: 'orders', table_kind: 'r', row_count: '3', table_comment: null },
          { table_name: 'recent_orders', table_kind: 'v', row_count: '0', table_comment: 'Recent orders' },
        ],
      },
    ],
    [
      'FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c',
      {
        rows: [
          { table_name: 'customers', column_name: 'id', data_type: 'integer', is_nullable: false, column_comment: null },
          { table_name: 'customers', column_name: 'name', data_type: 'text', is_nullable: false, column_comment: 'Name' },
          { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: false, column_comment: null },
          { table_name: 'orders', column_name: 'customer_id', data_type: 'integer', is_nullable: false, column_comment: null },
          { table_name: 'orders', column_name: 'status', data_type: 'text', is_nullable: true, column_comment: null },
          { table_name: 'recent_orders', column_name: 'id', data_type: 'integer', is_nullable: true, column_comment: null },
        ],
      },
    ],
    [
      "tc.constraint_type = 'FOREIGN KEY'",
      {
        rows: [
          {
            table_name: 'orders',
            column_name: 'customer_id',
            foreign_table_schema: 'public',
            foreign_table_name: 'customers',
            foreign_column_name: 'id',
            constraint_name: 'orders_customer_id_fkey',
          },
        ],
      },
    ],
    [
      "tc.constraint_type = 'PRIMARY KEY'",
      {
        rows: [
          { table_name: 'customers', column_name: 'id' },
          { table_name: 'orders', column_name: 'id' },
        ],
      },
    ],
    ['SELECT "id" FROM "public"."orders" LIMIT 1', { rows: [{ id: 10 }], fields: [{ name: 'id', dataTypeID: 23 }] }],
    [
      'SELECT "status" FROM "public"."orders" WHERE "status" IS NOT NULL',
      { rows: [{ status: 'paid' }, { status: 'open' }], fields: [{ name: 'status', dataTypeID: 25 }] },
    ],
    ['COUNT(DISTINCT val) AS cardinality', { rows: [{ cardinality: '2' }] }],
    ['SELECT DISTINCT "status"::text AS val', { rows: [{ val: 'open' }, { val: 'paid' }] }],
    ['SELECT COUNT(*) AS count FROM "public"."orders"', { rows: [{ count: '3' }] }],
    ['FROM pg_stats s', { rows: [{ column_name: 'status', estimated_cardinality: '2' }] }],
    ['SELECT 1', { rows: [{ '?column?': 1 }], fields: [{ name: '?column?', dataTypeID: 23 }] }],
    ['SELECT schema_name FROM information_schema.schemata', { rows: [{ schema_name: 'public' }] }],
  ]);
}

describe('KtxPostgresScanConnector', () => {
  it('resolves configuration safely', () => {
    expect(isKtxPostgresConnectionConfig({ driver: 'postgres', url: 'env:DATABASE_URL' })).toBe(true);
    expect(isKtxPostgresConnectionConfig({ driver: 'postgresql', host: 'db', database: 'analytics' })).toBe(true);
    expect(isKtxPostgresConnectionConfig({ driver: 'mysql', host: 'db' })).toBe(false);
    expect(
      postgresPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'postgres',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'test-password', // pragma: allowlist secret
          schemas: ['analytics', 'public'],
          ssl: true,
          rejectUnauthorized: false,
        },
      }),
    ).toMatchObject({
      host: 'db.example.test',
      port: 5432,
      database: 'analytics',
      user: 'reader',
      password: 'test-password', // pragma: allowlist secret
      options: '-c search_path=analytics,public',
      ssl: { rejectUnauthorized: false },
    });
    const libpqPreferConfig = postgresPoolConfigFromConfig({
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres',
        url: 'env:DEMO_DATABASE_URL',
      },
      env: {
        DEMO_DATABASE_URL: 'postgresql://reader@demo.example.test:5432/demo?sslmode=prefer',
      },
    });
    expect(libpqPreferConfig).toMatchObject({
      host: 'demo.example.test',
      port: 5432,
      database: 'demo',
      user: 'reader',
    });
    expect(libpqPreferConfig).not.toHaveProperty('connectionString');
    expect(libpqPreferConfig).not.toHaveProperty('ssl');
    expect(
      postgresPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { driver: 'postgres', host: 'db.example.test', database: 'analytics', username: 'reader' },
      }),
    ).toMatchObject({
      host: 'db.example.test',
      database: 'analytics',
      user: 'reader',
    });
  });

  it('introspects schemas, tables, views, primary keys, comments, row counts, and foreign keys', async () => {
    const connector = new KtxPostgresScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory: fakePoolFactory(metadataResults()),
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'postgres' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-04-29T10:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {
        database: 'analytics',
        schemas: ['public'],
        host: 'db.example.test',
        table_count: 3,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => [table.db, table.name, table.kind, table.estimatedRows])).toEqual([
      ['public', 'customers', 'table', 2],
      ['public', 'orders', 'table', 3],
      ['public', 'recent_orders', 'view', null],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'customers')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'integer',
      normalizedType: 'integer',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual([
      {
        fromColumn: 'customer_id',
        toCatalog: null,
        toDb: 'public',
        toTable: 'customers',
        toColumn: 'id',
        constraintName: 'orders_customer_id_fkey',
      },
    ]);
  });

  it('runs samples, distinct values, statistics, read-only SQL, and schema listing', async () => {
    const connector = new KtxPostgresScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory: fakePoolFactory(metadataResults()),
    });

    await expect(
      connector.sampleTable(
        { connectionId: 'warehouse', table: { catalog: null, db: 'public', name: 'orders' }, columns: ['id'], limit: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id'], headerTypes: ['integer'], rows: [[10]], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: 'public', name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: 'public', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(connector.getColumnStatistics({ catalog: null, db: 'public', name: 'orders' })).resolves.toEqual({
      cardinalityByColumn: new Map([['status', 2]]),
    });
    await expect(connector.getTableRowCount({ db: 'public', name: 'orders' })).resolves.toBe(3);
    await expect(connector.listSchemas()).resolves.toEqual(['public']);
    await expect(connector.testConnection()).resolves.toEqual({ success: true });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');
  });

  it('adapts native PostgreSQL snapshots to live-database introspection for local ingest', async () => {
    const introspection = createPostgresLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'postgres',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'test-password', // pragma: allowlist secret
          schema: 'public',
        },
      },
      poolFactory: fakePoolFactory(metadataResults()),
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T10:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'customers')).toMatchObject({
      name: 'customers',
      catalog: null,
      db: 'public',
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
        {
          name: 'name',
          nativeType: 'text',
          normalizedType: 'text',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: 'Name',
        },
      ],
      foreignKeys: [],
    });
  });

  it('does not end the pool before introspection completes', async () => {
    let endCalled = false;
    const endAwarePoolFactory: KtxPostgresPoolFactory = {
      createPool() {
        const inner = fakePoolFactory(metadataResults()).createPool({
          max: 1,
          idleTimeoutMillis: 1,
          connectionTimeoutMillis: 1,
        });
        return {
          async connect() {
            if (endCalled) {
              throw new Error('Cannot use a pool after calling end on the pool');
            }
            return inner.connect();
          },
          async end() {
            endCalled = true;
            return inner.end();
          },
        };
      },
    };
    const introspection = createPostgresLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'postgres',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'test-password', // pragma: allowlist secret
          schema: 'public',
        },
      },
      poolFactory: endAwarePoolFactory,
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');
    expect(snapshot.tables.length).toBeGreaterThan(0);
    expect(endCalled).toBe(true);
  });

  it('attaches an error listener to the pg pool', async () => {
    const on = vi.fn();
    const poolFactory: KtxPostgresPoolFactory = {
      createPool() {
        return {
          on,
          async connect() {
            return {
              query: vi.fn(async () => ({ rows: [{ '?column?': 1 }], fields: [{ name: '?column?', dataTypeID: 23 }] })),
              release: vi.fn(),
            };
          },
          end: vi.fn(async () => undefined),
        };
      },
    };
    const connector = new KtxPostgresScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
      },
      poolFactory,
    });

    await expect(connector.testConnection()).resolves.toEqual({ success: true });

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
