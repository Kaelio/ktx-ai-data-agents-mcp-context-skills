#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { stringify: yamlStringify } = require('yaml');

const TIME_PATTERNS = /(_at$|_date$|^date_|_time$|^timestamp_)/i;
const TIME_TYPES = /(date|time|timestamp)/i;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function normalizeSqliteType(rawType) {
  const t = (rawType || '').toLowerCase().trim();
  if (!t) {
    return 'text';
  }
  if (/int/.test(t)) {
    return 'integer';
  }
  if (/char|text|clob/.test(t)) {
    return 'text';
  }
  if (/real|float|double|numeric|decimal/.test(t)) {
    return 'real';
  }
  if (/blob/.test(t)) {
    return 'blob';
  }
  if (/bool/.test(t)) {
    return 'integer';
  }
  if (/date|time/.test(t)) {
    return 'text';
  }
  return 'text';
}

export function dimensionTypeFor(rawType, columnName) {
  const t = (rawType || '').toLowerCase();
  const n = (columnName || '').toLowerCase();
  if (TIME_PATTERNS.test(n) || TIME_TYPES.test(t)) {
    return 'time';
  }
  if (/bool/.test(t)) {
    return 'boolean';
  }
  if (/int|real|float|double|numeric|decimal/.test(t)) {
    return 'number';
  }
  return 'string';
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function columnsFor(db, table) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((c) => ({
      cid: c.cid,
      name: c.name,
      nativeType: c.type ?? '',
      nullable: !c.notnull,
      primaryKey: c.pk > 0,
      pkOrdinal: c.pk > 0 ? c.pk : null,
    }));
}

function rawForeignKeys(db, table) {
  return db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all();
}

function rowCount(db, table) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`).get();
  return Number(row?.c ?? 0);
}

function groupedForeignKeys(rawFks, table) {
  const byId = new Map();
  for (const row of rawFks) {
    const list = byId.get(row.id) ?? [];
    list.push(row);
    byId.set(row.id, list);
  }
  const out = [];
  for (const rows of byId.values()) {
    rows.sort((a, b) => a.seq - b.seq);
    out.push({
      from: rows.map((r) => r.from),
      toTable: rows[0].table,
      to: rows.map((r) => r.to),
      constraintName: `${table}_${rows.map((r) => r.from).join('_')}_fkey`,
    });
  }
  return out;
}

function groupedSnapshotForeignKeys(table) {
  const byKey = new Map();
  for (const fk of table.foreignKeys ?? []) {
    const key = fk.constraintName ?? `${table.name}:${fk.toTable}:${fk.toColumn}`;
    const rows = byKey.get(key) ?? [];
    rows.push(fk);
    byKey.set(key, rows);
  }
  return [...byKey.values()].map((rows) => ({
    fromTable: table.name,
    fromColumns: rows.map((row) => row.fromColumn),
    toTable: rows[0].toTable,
    toColumns: rows.map((row) => row.toColumn),
    relationship: 'many_to_one',
  }));
}

export function expectedLinksFromSnapshot(snapshot) {
  const expectedPks = [];
  const expectedLinks = [];

  for (const table of snapshot.tables ?? []) {
    if (table.kind !== 'table') {
      continue;
    }
    const pkColumns = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
    if (pkColumns.length) {
      expectedPks.push({ table: table.name, columns: pkColumns });
    }
    expectedLinks.push(...groupedSnapshotForeignKeys(table));
  }

  expectedPks.sort((left, right) => left.table.localeCompare(right.table));
  expectedLinks.sort((left, right) => {
    const leftKey = `${left.fromTable}.${left.fromColumns.join(',')}->${left.toTable}.${left.toColumns.join(',')}`;
    const rightKey = `${right.fromTable}.${right.fromColumns.join(',')}->${right.toTable}.${right.toColumns.join(',')}`;
    return leftKey.localeCompare(rightKey);
  });

  return { expectedPks, expectedLinks };
}

export function buildBenchmarkSnapshot(input) {
  const { db, fixtureId, extractedAt } = input;
  const names = tableNames(db);
  const tables = [];

  for (const name of names) {
    const cols = columnsFor(db, name);
    const grouped = groupedForeignKeys(rawForeignKeys(db, name), name);
    const estimatedRows = rowCount(db, name);

    const columns = cols.map((c) => ({
      name: c.name,
      nativeType: c.nativeType,
      normalizedType: normalizeSqliteType(c.nativeType),
      dimensionType: dimensionTypeFor(c.nativeType, c.name),
      nullable: c.nullable,
      primaryKey: c.primaryKey,
      comment: null,
    }));

    const foreignKeys = grouped.flatMap((g) =>
      g.from.map((fromColumn, index) => ({
        fromColumn,
        toCatalog: null,
        toDb: 'main',
        toTable: g.toTable,
        toColumn: g.to[index],
        constraintName: g.constraintName,
      })),
    );

    tables.push({
      catalog: null,
      db: 'main',
      name,
      kind: 'table',
      comment: null,
      estimatedRows,
      columns,
      foreignKeys,
    });
  }

  return {
    snapshot: {
      connectionId: fixtureId,
      driver: 'sqlite',
      extractedAt: extractedAt ?? '2026-05-07T00:00:00.000Z',
      scope: {},
      metadata: {},
      tables,
    },
    expected: expectedLinksFromSnapshot({
      connectionId: fixtureId,
      driver: 'sqlite',
      extractedAt: extractedAt ?? '2026-05-07T00:00:00.000Z',
      scope: {},
      metadata: {},
      tables,
    }),
  };
}

export function writeFixtureFiles(input) {
  const { fixtureDir, snapshot, expected } = input;
  writeFileSync(path.join(fixtureDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(fixtureDir, 'expected-links.yaml'), yamlStringify(expected), 'utf8');
}

export function rebuildAllPublicSnapshots(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(scriptDir, '..');
  const fixturesRoot =
    options.fixturesRoot ?? path.join(repoRoot, 'packages', 'context', 'test', 'fixtures', 'relationship-benchmarks');
  const manifestPath = options.manifestPath ?? path.join(scriptDir, 'public-benchmark-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const fixture of manifest.fixtures) {
    const fixtureDir = path.join(fixturesRoot, fixture.id);
    const dataPath = path.join(fixtureDir, 'data.sqlite');
    if (!existsSync(dataPath)) {
      console.log(`[skip] ${fixture.id}: data.sqlite missing (run relationships:acquire-public-fixtures first)`);
      continue;
    }
    const db = new Database(dataPath, { readonly: true });
    try {
      const result = buildBenchmarkSnapshot({ db, fixtureId: fixture.id });
      writeFixtureFiles({ fixtureDir, snapshot: result.snapshot, expected: result.expected });
      console.log(
        `[built] ${fixture.id}: ${result.snapshot.tables.length} tables, ${result.expected.expectedLinks.length} expected links`,
      );
    } finally {
      db.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--rebuild-all') {
    rebuildAllPublicSnapshots();
  } else if (args.length === 2) {
    const [dataPath, fixtureDir] = args;
    const db = new Database(dataPath, { readonly: true });
    try {
      const fixtureId = path.basename(fixtureDir);
      const result = buildBenchmarkSnapshot({ db, fixtureId });
      writeFixtureFiles({ fixtureDir, snapshot: result.snapshot, expected: result.expected });
      console.log(`[built] ${fixtureId}`);
    } finally {
      db.close();
    }
  } else {
    console.error('Usage: build-benchmark-snapshot.mjs <data.sqlite> <fixtureDir> | --rebuild-all');
    process.exit(2);
  }
}
