import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { buildBenchmarkSnapshot } from './build-benchmark-snapshot.mjs';

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const Database = require('better-sqlite3');

describe('buildBenchmarkSnapshot', () => {
  it('emits a KtxSchemaSnapshot-shaped object plus expected-links from declared FKs', () => {
    const db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        total REAL,
        created_at TEXT
      );
      INSERT INTO accounts (id, name) VALUES (1, 'a'), (2, 'b');
      INSERT INTO orders (id, account_id, total, created_at) VALUES
        (1, 1, 10.0, '2024-01-01'), (2, 1, 20.0, '2024-01-02'), (3, 2, 30.0, '2024-01-03');
    `);

    const result = buildBenchmarkSnapshot({ db, fixtureId: 'fixture_x' });
    db.close();

    assert.equal(result.snapshot.connectionId, 'fixture_x');
    assert.equal(result.snapshot.driver, 'sqlite');
    assert.equal(result.snapshot.tables.length, 2);

    const accounts = result.snapshot.tables.find((t) => t.name === 'accounts');
    assert.ok(accounts);
    assert.equal(accounts.estimatedRows, 2);
    assert.deepEqual(accounts.foreignKeys, []);
    const idCol = accounts.columns.find((c) => c.name === 'id');
    assert.equal(idCol.primaryKey, true);
    assert.equal(idCol.normalizedType, 'integer');
    assert.equal(idCol.dimensionType, 'number');

    const orders = result.snapshot.tables.find((t) => t.name === 'orders');
    assert.equal(orders.foreignKeys.length, 1);
    assert.equal(orders.foreignKeys[0].fromColumn, 'account_id');
    assert.equal(orders.foreignKeys[0].toTable, 'accounts');
    assert.equal(orders.foreignKeys[0].toColumn, 'id');

    const createdAt = orders.columns.find((c) => c.name === 'created_at');
    assert.equal(createdAt.dimensionType, 'time');

    const total = orders.columns.find((c) => c.name === 'total');
    assert.equal(total.dimensionType, 'number');
    assert.equal(total.nullable, true);

    assert.deepEqual(
      result.expected.expectedPks.sort((a, b) => a.table.localeCompare(b.table)),
      [
        { table: 'accounts', columns: ['id'] },
        { table: 'orders', columns: ['id'] },
      ],
    );
    assert.deepEqual(result.expected.expectedLinks, [
      {
        fromTable: 'orders',
        fromColumns: ['account_id'],
        toTable: 'accounts',
        toColumns: ['id'],
        relationship: 'many_to_one',
      },
    ]);
  });

  it('skips internal SQLite tables (sqlite_*) and views', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE keep_me (id INTEGER PRIMARY KEY);
      CREATE VIEW keep_me_view AS SELECT id FROM keep_me;
      INSERT INTO keep_me (id) VALUES (1);
    `);
    const result = buildBenchmarkSnapshot({ db, fixtureId: 'fx' });
    db.close();
    assert.equal(result.snapshot.tables.length, 1);
    assert.equal(result.snapshot.tables[0].name, 'keep_me');
  });

  it('groups composite foreign keys into a single ordered link', () => {
    const db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE order_lines (
        order_id INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        sku TEXT NOT NULL,
        PRIMARY KEY (order_id, line_number)
      );
      CREATE TABLE allocations (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        FOREIGN KEY (order_id, line_number) REFERENCES order_lines(order_id, line_number)
      );
    `);
    const result = buildBenchmarkSnapshot({ db, fixtureId: 'fx' });
    db.close();

    const composite = result.expected.expectedLinks.find((l) => l.fromTable === 'allocations');
    assert.deepEqual(composite, {
      fromTable: 'allocations',
      fromColumns: ['order_id', 'line_number'],
      toTable: 'order_lines',
      toColumns: ['order_id', 'line_number'],
      relationship: 'many_to_one',
    });

    const compositePk = result.expected.expectedPks.find((p) => p.table === 'order_lines');
    assert.deepEqual(compositePk.columns, ['order_id', 'line_number']);
  });

  it('derives expected PKs and grouped FKs from an existing snapshot', async () => {
    const { expectedLinksFromSnapshot } = await import('./build-benchmark-snapshot.mjs');

    const expected = expectedLinksFromSnapshot({
      connectionId: 'fixture',
      driver: 'sqlite',
      extractedAt: '2026-05-07T00:00:00.000Z',
      scope: {},
      metadata: {},
      tables: [
        {
          catalog: null,
          db: 'main',
          name: 'Sales.SalesOrderHeader',
          kind: 'table',
          comment: null,
          estimatedRows: 3,
          columns: [
            {
              name: 'SalesOrderID',
              nativeType: 'int',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
            {
              name: 'CustomerID',
              nativeType: 'int',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
          ],
          foreignKeys: [
            {
              fromColumn: 'CustomerID',
              toCatalog: null,
              toDb: 'main',
              toTable: 'Sales.Customer',
              toColumn: 'CustomerID',
              constraintName: 'FK_SalesOrderHeader_Customer_CustomerID',
            },
          ],
        },
        {
          catalog: null,
          db: 'main',
          name: 'Sales.Customer',
          kind: 'table',
          comment: null,
          estimatedRows: 2,
          columns: [
            {
              name: 'CustomerID',
              nativeType: 'int',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
          ],
          foreignKeys: [],
        },
        {
          catalog: null,
          db: 'main',
          name: 'Sales.SalesOrderDetail',
          kind: 'table',
          comment: null,
          estimatedRows: 6,
          columns: [
            {
              name: 'SalesOrderID',
              nativeType: 'int',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
            {
              name: 'SalesOrderDetailID',
              nativeType: 'int',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
          ],
          foreignKeys: [
            {
              fromColumn: 'SalesOrderID',
              toCatalog: null,
              toDb: 'main',
              toTable: 'Sales.SalesOrderHeader',
              toColumn: 'SalesOrderID',
              constraintName: 'FK_SalesOrderDetail_SalesOrderHeader_SalesOrderID',
            },
          ],
        },
      ],
    });

    assert.deepEqual(expected.expectedPks, [
      { table: 'Sales.Customer', columns: ['CustomerID'] },
      { table: 'Sales.SalesOrderDetail', columns: ['SalesOrderID', 'SalesOrderDetailID'] },
      { table: 'Sales.SalesOrderHeader', columns: ['SalesOrderID'] },
    ]);
    assert.deepEqual(expected.expectedLinks, [
      {
        fromTable: 'Sales.SalesOrderDetail',
        fromColumns: ['SalesOrderID'],
        toTable: 'Sales.SalesOrderHeader',
        toColumns: ['SalesOrderID'],
        relationship: 'many_to_one',
      },
      {
        fromTable: 'Sales.SalesOrderHeader',
        fromColumns: ['CustomerID'],
        toTable: 'Sales.Customer',
        toColumns: ['CustomerID'],
        relationship: 'many_to_one',
      },
    ]);
  });

  it('exposes relationship benchmarks as an explicit CLI package script', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));

    assert.equal(
      packageJson.scripts['relationships:benchmarks:test'],
      'KTX_RUN_RELATIONSHIP_BENCHMARKS=1 vitest run test/context/scan/relationship-benchmarks.test.ts',
    );
  });
});
