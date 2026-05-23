import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteLiveDatabaseIntrospection } from '../../connectors/sqlite/live-database-introspection.js';
import { isKtxSqliteConnectionConfig, KtxSqliteScanConnector, sqliteDatabasePathFromConfig } from '../../connectors/sqlite/connector.js';
import { tableRefSet } from '../../context/scan/table-ref.js';

describe('KtxSqliteScanConnector', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-connector-sqlite-'));
    dbPath = join(tempDir, 'warehouse.db');
    const db = new Database(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        tier TEXT
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        status TEXT,
        total NUMERIC,
        created_at TEXT,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );
      CREATE VIEW recent_orders AS SELECT id, customer_id, status FROM orders;
      INSERT INTO customers (id, name, tier) VALUES (1, 'Ada', 'enterprise'), (2, 'Grace', 'growth');
      INSERT INTO orders (id, customer_id, status, total, created_at)
        VALUES (10, 1, 'paid', 42.5, '2026-04-28'), (11, 2, 'open', 9.5, '2026-04-29');
    `);
    db.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves SQLite path configuration safely', () => {
    const originalDatabaseUrl = process.env.KTX_SQLITE_TEST_URL;
    const pointerPath = join(tempDir, 'sqlite-path.txt');
    process.env.KTX_SQLITE_TEST_URL = `sqlite:${dbPath}`;
    writeFileSync(pointerPath, dbPath, 'utf-8');

    try {
      expect(isKtxSqliteConnectionConfig({ driver: 'sqlite', path: 'warehouse.db' })).toBe(true);
      expect(isKtxSqliteConnectionConfig({ driver: 'postgres', url: 'env:DATABASE_URL' })).toBe(false);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', path: 'warehouse.db' },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', url: 'env:KTX_SQLITE_TEST_URL' },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', url: `file://${dbPath}` },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', path: `file:${pointerPath}` },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', path: 'warehouse.db' },
        }),
      ).toBe(dbPath);
      expect(() =>
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', file_path: 'warehouse.db' },
        }),
      ).toThrow('Native SQLite connector requires connections.warehouse.path or url');
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.KTX_SQLITE_TEST_URL;
      } else {
        process.env.KTX_SQLITE_TEST_URL = originalDatabaseUrl;
      }
    }
  });

  it('introspects schema, primary keys, row counts, views, and foreign keys', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlite' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'sqlite',
      extractedAt: '2026-04-29T10:00:00.000Z',
      metadata: {
        file_path: dbPath,
        table_count: 3,
        total_columns: 11,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows])).toEqual([
      ['customers', 'table', 2],
      ['orders', 'table', 2],
      ['recent_orders', 'view', null],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'customers')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'INTEGER',
      normalizedType: 'INTEGER',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual([
      {
        fromColumn: 'customer_id',
        toCatalog: null,
        toDb: null,
        toTable: 'customers',
        toColumn: 'id',
        constraintName: null,
      },
    ]);
  });

  it('runs samples, distinct values, statistics, and read-only SQL', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
    });

    await expect(
      connector.sampleTable(
        { connectionId: 'warehouse', table: { catalog: null, db: null, name: 'orders' }, columns: ['id'], limit: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id'], rows: [[10]], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: null, name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: null, name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from orders order by id', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: null, db: null, name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();
  });

  it('limits introspection to tables in tableScope', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
    });
    const scope = tableRefSet([{ catalog: null, db: null, name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlite', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
  });

  it('adapts native SQLite snapshots to live-database introspection for local ingest', async () => {
    const introspection = createSqliteLiveDatabaseIntrospection({
      projectDir: tempDir,
      connections: {
        warehouse: { driver: 'sqlite', path: 'warehouse.db' },
      },
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
      db: null,
      columns: [
        {
          name: 'id',
          nativeType: 'INTEGER',
          normalizedType: 'INTEGER',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: null,
        },
        {
          name: 'name',
          nativeType: 'TEXT',
          normalizedType: 'TEXT',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
        {
          name: 'tier',
          nativeType: 'TEXT',
          normalizedType: 'TEXT',
          dimensionType: 'string',
          nullable: true,
          primaryKey: false,
          comment: null,
        },
      ],
      foreignKeys: [],
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')).toMatchObject({
      name: 'orders',
      catalog: null,
      db: null,
      foreignKeys: [{ fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }],
    });
  });
});
