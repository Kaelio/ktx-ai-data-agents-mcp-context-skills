#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedLinksFromSnapshot, normalizeSqliteType } from './build-benchmark-snapshot.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { stringify: yamlStringify } = require('yaml');

const fixtureId = 'adventureworks_oltp_with_declared_metadata';
const defaultFixtureDir = path.join(
  repoRoot,
  'packages',
  'context',
  'test',
  'fixtures',
  'relationship-benchmarks',
  fixtureId,
);

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteSqlServerIdentifier(value) {
  return `[${String(value).replaceAll(']', ']]')}]`;
}

function flattenTableName(table) {
  return `${table.db}.${table.name}`;
}

function sqliteDimensionType(nativeType, columnName) {
  const type = normalizeSqliteType(nativeType);
  const name = columnName.toLowerCase();
  if (/date|time/.test(name) || /date|time/.test(String(nativeType).toLowerCase())) {
    return 'time';
  }
  if (type === 'integer' || type === 'real') {
    return 'number';
  }
  return 'string';
}

function sqliteValue(value) {
  if (value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

export function snapshotForSqliteBenchmark(sqlServerSnapshot) {
  const tableNameByOriginal = new Map(
    sqlServerSnapshot.tables
      .filter((table) => table.kind === 'table')
      .map((table) => [`${table.db}.${table.name}`, flattenTableName(table)]),
  );

  return {
    connectionId: fixtureId,
    driver: 'sqlite',
    extractedAt: sqlServerSnapshot.extractedAt,
    scope: { catalogs: ['main'], schemas: ['main'] },
    metadata: {
      ...sqlServerSnapshot.metadata,
      source_driver: 'sqlserver',
      source_connection_id: sqlServerSnapshot.connectionId,
      source_database: sqlServerSnapshot.metadata?.database ?? null,
    },
    tables: sqlServerSnapshot.tables
      .filter((table) => table.kind === 'table')
      .map((table) => ({
        catalog: null,
        db: 'main',
        name: flattenTableName(table),
        kind: 'table',
        comment: table.comment ?? null,
        estimatedRows: table.estimatedRows ?? 0,
        columns: table.columns.map((column) => ({
          name: column.name,
          nativeType: column.nativeType,
          normalizedType: normalizeSqliteType(column.nativeType),
          dimensionType: sqliteDimensionType(column.nativeType, column.name),
          nullable: column.nullable,
          primaryKey: column.primaryKey,
          comment: column.comment ?? null,
        })),
        foreignKeys: (table.foreignKeys ?? []).flatMap((fk) => {
          const originalTarget = `${fk.toDb}.${fk.toTable}`;
          const targetName = tableNameByOriginal.get(originalTarget);
          if (!targetName) {
            return [];
          }
          return [
            {
              fromColumn: fk.fromColumn,
              toCatalog: null,
              toDb: 'main',
              toTable: targetName,
              toColumn: fk.toColumn,
              constraintName: fk.constraintName,
            },
          ];
        }),
      })),
  };
}

export function writeAdventureWorksFixtureConfig(fixtureDir) {
  const fixture = {
    id: fixtureId,
    name: 'AdventureWorks OLTP (SQL Server 2022, declared metadata)',
    tier: 'row_bearing',
    thresholdEligible: true,
    defaultModes: [
      'metadata_present',
      'declared_pks_and_declared_fks_removed',
      'declared_pks_removed',
      'declared_fks_removed',
      'profiling_disabled',
      'validation_disabled',
      'llm_disabled',
      'embeddings_disabled',
    ],
  };
  writeFileSync(path.join(fixtureDir, 'fixture.yaml'), yamlStringify(fixture), 'utf8');
}

export function writeAdventureWorksSnapshotAndLabels(fixtureDir, sqliteSnapshot) {
  writeFileSync(path.join(fixtureDir, 'snapshot.json'), `${JSON.stringify(sqliteSnapshot, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(fixtureDir, 'expected-links.yaml'), yamlStringify(expectedLinksFromSnapshot(sqliteSnapshot)), 'utf8');
}

export async function copySqlServerRowsToSqlite(input) {
  const { connector, sourceSnapshot, sqliteSnapshot, fixtureDir } = input;
  const sqlitePath = path.join(fixtureDir, 'data.sqlite');
  rmSync(sqlitePath, { force: true });
  const db = new Database(sqlitePath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('BEGIN');
    for (const sourceTable of sourceSnapshot.tables.filter((table) => table.kind === 'table')) {
      const sqliteTable = sqliteSnapshot.tables.find((table) => table.name === flattenTableName(sourceTable));
      if (!sqliteTable) {
        continue;
      }
      const columns = sqliteTable.columns;
      const createColumns = columns
        .map((column) => `${quoteSqliteIdentifier(column.name)} ${normalizeSqliteType(column.nativeType).toUpperCase()}`)
        .join(', ');
      db.exec(`CREATE TABLE ${quoteSqliteIdentifier(sqliteTable.name)} (${createColumns})`);

      const selectSql = `SELECT * FROM ${quoteSqlServerIdentifier(sourceTable.db)}.${quoteSqlServerIdentifier(sourceTable.name)}`;
      const result = await connector.executeReadOnly(
        {
          connectionId: sourceSnapshot.connectionId,
          sql: selectSql,
          maxRows: Math.max(sourceTable.estimatedRows ?? 0, 1000000),
        },
        { runId: `adventureworks-oltp-copy:${sqliteTable.name}` },
      );
      const bindSlots = columns.map(() => '?').join(', ');
      const insert = db.prepare(
        `INSERT INTO ${quoteSqliteIdentifier(sqliteTable.name)} (${columns
          .map((column) => quoteSqliteIdentifier(column.name))
          .join(', ')}) VALUES (${bindSlots})`,
      );
      for (const row of result.rows) {
        insert.run(row.map(sqliteValue));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export async function buildAdventureWorksOltpFixture(input) {
  const fixtureDir = input.fixtureDir ?? defaultFixtureDir;
  mkdirSync(fixtureDir, { recursive: true });

  const sourceSnapshot = await input.connector.introspect(
    { connectionId: input.connectionId, driver: 'sqlserver' },
    { runId: 'adventureworks-oltp-fixture:introspect' },
  );
  const sqliteSnapshot = snapshotForSqliteBenchmark(sourceSnapshot);

  writeAdventureWorksFixtureConfig(fixtureDir);
  writeAdventureWorksSnapshotAndLabels(fixtureDir, sqliteSnapshot);
  await copySqlServerRowsToSqlite({ connector: input.connector, sourceSnapshot, sqliteSnapshot, fixtureDir });

  return {
    fixtureDir,
    tableCount: sqliteSnapshot.tables.length,
    expected: expectedLinksFromSnapshot(sqliteSnapshot),
  };
}

async function main() {
  const url = process.env.KTX_ADVENTUREWORKS_SQLSERVER_URL;
  if (!url) {
    throw new Error(
      'Set KTX_ADVENTUREWORKS_SQLSERVER_URL to a read-only SQL Server URL for a full AdventureWorks OLTP database before running this script.',
    );
  }

  const source = JSON.parse(readFileSync(path.join(scriptDir, 'adventureworks-oltp-source.json'), 'utf8'));
  const { KtxSqlServerScanConnector } = await import('../packages/cli/dist/connectors/sqlserver/index.js');
  const connector = new KtxSqlServerScanConnector({
    connectionId: fixtureId,
    connection: {
      driver: 'sqlserver',
      url,
      schemas: ['dbo', 'HumanResources', 'Person', 'Production', 'Purchasing', 'Sales'],
      trustServerCertificate: true,
    },
    now: () => new Date('2026-05-07T00:00:00.000Z'),
  });

  const result = await buildAdventureWorksOltpFixture({ connector, connectionId: fixtureId });
  if (result.tableCount !== source.expectedTables) {
    throw new Error(`Expected ${source.expectedTables} tables, generated ${result.tableCount}`);
  }
  if (result.expected.expectedPks.length !== source.expectedPrimaryKeys) {
    throw new Error(`Expected ${source.expectedPrimaryKeys} PK entries, generated ${result.expected.expectedPks.length}`);
  }
  if (result.expected.expectedLinks.length !== source.expectedForeignKeys) {
    throw new Error(`Expected ${source.expectedForeignKeys} FK links, generated ${result.expected.expectedLinks.length}`);
  }
  console.log(
    `[built] ${fixtureId}: ${result.tableCount} tables, ${result.expected.expectedPks.length} PKs, ${result.expected.expectedLinks.length} FKs`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
