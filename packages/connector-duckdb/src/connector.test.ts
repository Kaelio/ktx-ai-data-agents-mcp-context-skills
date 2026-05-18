import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
  KtxDuckDbScanConnector,
} from './connector.js';

describe('DuckDB connection config and path resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.KTX_DUCKDB_FIXTURE;
  });

  it('recognizes duckdb configs', () => {
    expect(isKtxDuckDbConnectionConfig({ driver: 'duckdb', path: 'warehouse.duckdb' })).toBe(true);
    expect(isKtxDuckDbConnectionConfig({ driver: 'sqlite', path: 'warehouse.duckdb' })).toBe(false);
  });

  it('resolves project-relative path, env refs, file refs, and file URLs', async () => {
    const dbPath = join(tempDir, 'warehouse.duckdb');
    const pathRefFile = join(tempDir, 'warehouse-path.txt');
    await writeFile(dbPath, '', 'utf-8');
    await writeFile(pathRefFile, dbPath, 'utf-8');
    process.env.KTX_DUCKDB_FIXTURE = dbPath;

    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: 'warehouse.duckdb' },
      }),
    ).toBe(resolve(tempDir, 'warehouse.duckdb'));
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: 'env:KTX_DUCKDB_FIXTURE' },
      }),
    ).toBe(dbPath);
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: `file:${pathRefFile}` },
      }),
    ).toBe(dbPath);
    expect(
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', url: pathToFileURL(dbPath).href },
      }),
    ).toBe(dbPath);
  });

  it('rejects in-memory, missing, and directory targets before opening DuckDB', async () => {
    await mkdir(join(tempDir, 'directory.duckdb'));
    expect(() =>
      new KtxDuckDbScanConnector({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'duckdb', path: ':memory:' },
      }),
    ).toThrow('DuckDB in-memory connections are not supported');

    const missing = join(tempDir, 'missing.duckdb');
    const missingConnector = new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: missing },
    });
    await expect(missingConnector.testConnection()).resolves.toEqual({
      success: false,
      error: `File not found: ${missing}`,
    });
    await expect(stat(missing)).rejects.toThrow();

    const directory = join(tempDir, 'directory.duckdb');
    const directoryConnector = new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: directory },
    });
    await expect(directoryConnector.testConnection()).resolves.toEqual({
      success: false,
      error: `Expected a DuckDB database file, got directory: ${directory}`,
    });

    await expect(readFile(directory)).rejects.toThrow();
  });
});

async function createDuckDbFixture(dbPath: string): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        segment VARCHAR NOT NULL
      )
    `);
    await connection.run(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id),
        amount DOUBLE,
        status VARCHAR
      )
    `);
    await connection.run(`CREATE VIEW paid_orders AS SELECT id, customer_id, amount FROM orders WHERE status = 'paid'`);
    await connection.run(`INSERT INTO customers VALUES (1, 'enterprise'), (2, 'self-serve')`);
    await connection.run(`INSERT INTO orders VALUES (10, 1, 25.5, 'paid'), (11, 1, 5.0, 'open'), (12, 2, NULL, 'paid')`);
  } finally {
    connection.disconnectSync();
    instance.closeSync();
  }
}

describe('KtxDuckDbScanConnector runtime behavior', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-runtime-'));
    dbPath = join(tempDir, 'warehouse.duckdb');
    await createDuckDbFixture(dbPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function connector() {
    return new KtxDuckDbScanConnector({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'duckdb', path: 'warehouse.duckdb' },
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    });
  }

  it('tests the connection without mutating the database', async () => {
    const c = connector();
    await expect(c.testConnection()).resolves.toEqual({ success: true });
    await c.cleanup();
  });

  it('introspects tables, views, primary keys, foreign keys, and row counts', async () => {
    const c = connector();
    const snapshot = await c.introspect({ connectionId: 'warehouse', driver: 'duckdb' as never }, { runId: 'test' });
    await c.cleanup();

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'duckdb',
      extractedAt: '2026-05-18T12:00:00.000Z',
      metadata: { table_count: 3 },
    });
    const orders = snapshot.tables.find((table) => table.name === 'orders');
    expect(orders?.kind).toBe('table');
    expect(orders?.estimatedRows).toBe(3);
    expect(orders?.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
    expect(orders?.foreignKeys).toContainEqual(
      expect.objectContaining({
        fromColumn: 'customer_id',
        toTable: 'customers',
        toColumn: 'id',
      }),
    );
    expect(snapshot.tables.find((table) => table.name === 'paid_orders')?.kind).toBe('view');
  });

  it('samples tables, samples columns, returns distinct values, and counts rows', async () => {
    const c = connector();
    await expect(
      c.sampleTable?.(
        { connectionId: 'warehouse', table: { catalog: null, db: 'main', name: 'orders' }, columns: ['id', 'status'], limit: 2 },
        { runId: 'test' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], totalRows: 2 });
    await expect(
      c.sampleColumn?.(
        { connectionId: 'warehouse', table: { catalog: null, db: 'main', name: 'orders' }, column: 'status', limit: 2 },
        { runId: 'test' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'] });
    await expect(c.getColumnDistinctValues({ catalog: null, db: 'main', name: 'orders' }, 'status', {
      maxCardinality: 10,
      limit: 10,
    })).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(c.getTableRowCount('orders')).resolves.toBe(3);
    await c.cleanup();
  });

  it('executes read-only SQL and rejects mutating SQL before execution', async () => {
    const c = connector();
    await expect(
      c.executeReadOnly?.({ connectionId: 'warehouse', sql: 'select id from orders order by id', maxRows: 2 }, { runId: 'test' }),
    ).resolves.toMatchObject({ headers: ['id'], rows: [[10], [11]], rowCount: 2 });
    await expect(
      c.executeReadOnly?.({ connectionId: 'warehouse', sql: 'create table created_by_test(id int)' }, { runId: 'test' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally.');
    await c.cleanup();
  });
});
