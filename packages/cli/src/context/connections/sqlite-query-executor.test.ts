import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteQueryExecutor, sqliteDatabasePathFromConnection } from './sqlite-query-executor.js';

describe('createSqliteQueryExecutor', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sqlite-query-'));
    dbPath = join(tempDir, 'warehouse.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        amount INTEGER NOT NULL
      );
      INSERT INTO orders (status, amount) VALUES
        ('paid', 20),
        ('paid', 30),
        ('open', 10);
    `);
    db.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('executes read-only SELECT SQL against a relative SQLite path', async () => {
    const executor = createSqliteQueryExecutor();

    const result = await executor.execute({
      connectionId: 'warehouse',
      projectDir: tempDir,
      connection: { driver: 'sqlite', path: 'warehouse.db' },
      sql: 'select status, count(*) as order_count from orders group by status order by status',
      maxRows: 10,
    });

    expect(result).toEqual({
      headers: ['status', 'order_count'],
      rows: [
        ['open', 1],
        ['paid', 2],
      ],
      totalRows: 2,
      command: 'SELECT',
      rowCount: 2,
    });
  });

  it('supports file urls for SQLite database paths', async () => {
    expect(
      sqliteDatabasePathFromConnection({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'sqlite', url: `file://${dbPath}` },
        sql: 'select 1',
      }),
    ).toBe(dbPath);
  });

  it('resolves file references for SQLite path fields', async () => {
    const pointerPath = join(tempDir, 'sqlite-path.txt');
    writeFileSync(pointerPath, dbPath, 'utf-8');

    expect(
      sqliteDatabasePathFromConnection({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'sqlite', path: `file:${pointerPath}` },
        sql: 'select 1',
      }),
    ).toBe(dbPath);
  });

  it('resolves env references for SQLite database urls', async () => {
    const originalDatabaseUrl = process.env.KTX_SQLITE_TEST_URL;
    process.env.KTX_SQLITE_TEST_URL = `sqlite:${dbPath}`;

    try {
      expect(
        sqliteDatabasePathFromConnection({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', url: 'env:KTX_SQLITE_TEST_URL' },
          sql: 'select 1',
        }),
      ).toBe(dbPath);
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.KTX_SQLITE_TEST_URL;
      } else {
        process.env.KTX_SQLITE_TEST_URL = originalDatabaseUrl;
      }
    }
  });

  it('rejects mutating SQL before opening the database', async () => {
    const executor = createSqliteQueryExecutor();

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'sqlite', path: 'warehouse.db' },
        sql: 'delete from orders',
      }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');
  });

  it('requires a SQLite driver and a database path', async () => {
    const executor = createSqliteQueryExecutor();

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'postgres', path: 'warehouse.db' },
        sql: 'select 1',
      }),
    ).rejects.toThrow('Local SQLite execution cannot run driver "postgres"');

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        projectDir: tempDir,
        connection: { driver: 'sqlite' },
        sql: 'select 1',
      }),
    ).rejects.toThrow('Local SQLite execution requires connections.warehouse.path or connections.warehouse.url');
  });
});
