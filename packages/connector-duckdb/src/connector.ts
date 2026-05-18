import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import {
  assertReadOnlySql,
  limitSqlForExecution,
  normalizeQueryRows,
  type KtxSqlQueryExecutionInput,
  type KtxSqlQueryExecutionResult,
  type KtxSqlQueryExecutorPort,
} from '@ktx/context/connections';
import {
  createKtxConnectorCapabilities,
  type KtxColumnSampleInput,
  type KtxColumnSampleResult,
  type KtxColumnStatsInput,
  type KtxColumnStatsResult,
  type KtxConnectionDriver,
  type KtxQueryResult,
  type KtxReadOnlyQueryInput,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanInput,
  type KtxSchemaColumn,
  type KtxSchemaForeignKey,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '@ktx/context/scan';
import { KtxDuckDbDialect } from './dialect.js';
import { loadDuckDbNodeApi, type DuckDbNativeLoader } from './native.js';

const TABLES_SQL = `
  SELECT table_catalog AS catalog, table_schema AS db, table_name AS name, table_type AS type
  FROM information_schema.tables
  WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
  ORDER BY table_schema, table_name
`;

const COLUMNS_SQL = `
  SELECT table_catalog AS catalog, table_schema AS db, table_name, column_name, data_type, is_nullable, ordinal_position
  FROM information_schema.columns
  WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
  ORDER BY table_schema, table_name, ordinal_position
`;

const CONSTRAINTS_SQL = `
  SELECT database_name, schema_name, table_name, constraint_type, constraint_name,
         constraint_column_names, referenced_table, referenced_column_names
  FROM duckdb_constraints()
  WHERE constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
`;

export interface KtxDuckDbConnectionConfig {
  driver?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

export interface DuckDbDatabasePathInput {
  connectionId: string;
  projectDir?: string;
  connection: KtxDuckDbConnectionConfig | undefined;
}

export interface KtxDuckDbScanConnectorOptions extends DuckDbDatabasePathInput {
  now?: () => Date;
  nativeLoader?: DuckDbNativeLoader;
}

export interface KtxDuckDbReadOnlyQueryInput extends KtxReadOnlyQueryInput {}

export interface KtxDuckDbColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxDuckDbColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface DuckDbConnectionState {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}

interface DuckDbTableRow {
  catalog: string | null;
  db: string | null;
  name: string;
  type: string;
}

interface DuckDbColumnRow {
  catalog: string | null;
  db: string | null;
  name: string;
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: string;
}

interface DuckDbConstraintRow {
  catalog: string | null;
  db: string | null;
  name: string;
  tableName: string;
  constraintType: string;
  constraintName: string | null;
  columnNames: string[];
  referencedTable: string | null;
  referencedColumnNames: string[];
}

function resolveTilde(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(1)) : path;
}

function resolveStringReference(key: 'path' | 'url', value: string): string {
  if (value === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  if (value.startsWith('env:')) {
    return process.env[value.slice('env:'.length)] ?? '';
  }
  if (key === 'path' && value.startsWith('file:')) {
    return readFileSync(resolveTilde(value.slice('file:'.length)), 'utf-8').trim();
  }
  return value;
}

function duckDbPathFromUrl(url: string): string {
  if (url === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  return url;
}

function stringConfigValue(
  connection: KtxDuckDbConnectionConfig | undefined,
  key: 'path' | 'url',
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(key, value.trim()) : undefined;
}

export function isKtxDuckDbConnectionConfig(
  connection: KtxDuckDbConnectionConfig | undefined,
): connection is KtxDuckDbConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'duckdb';
}

export function duckDbDatabasePathFromConfig(input: DuckDbDatabasePathInput): string {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxDuckDbConnectionConfig(input.connection)) {
    throw new Error(`Native DuckDB connector cannot run driver "${inputDriver}"`);
  }
  const configuredPath =
    stringConfigValue(input.connection, 'path') ?? duckDbPathFromUrl(stringConfigValue(input.connection, 'url') ?? '');
  if (!configuredPath) {
    throw new Error(`connections.${input.connectionId}.path or url is required`);
  }
  if (configuredPath === ':memory:') {
    throw new Error('DuckDB in-memory connections are not supported');
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.projectDir ?? process.cwd(), configuredPath);
}

export function assertDuckDbDatabaseFile(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`File not found: ${dbPath}`);
  }
  const stats = statSync(dbPath);
  if (stats.isDirectory()) {
    throw new Error(`Expected a DuckDB database file, got directory: ${dbPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Expected a DuckDB database file, got non-file path: ${dbPath}`);
  }
}

export class KtxDuckDbScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'duckdb' as KtxConnectionDriver;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: false,
    formalForeignKeys: true,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly dbPath: string;
  private readonly now: () => Date;
  private readonly dialect = new KtxDuckDbDialect();
  private readonly nativeLoader: DuckDbNativeLoader;
  private state: DuckDbConnectionState | null = null;

  constructor(options: KtxDuckDbScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.dbPath = duckDbDatabasePathFromConfig(options);
    this.now = options.now ?? (() => new Date());
    this.nativeLoader = options.nativeLoader ?? { load: loadDuckDbNodeApi };
    this.id = `duckdb:${options.connectionId}`;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      assertDuckDbDatabaseFile(this.dbPath);
      const { DuckDBInstance } = await this.nativeLoader.load();
      const instance = await DuckDBInstance.create(this.dbPath, { access_mode: 'READ_ONLY' });
      const connection = await instance.connect();
      try {
        await connection.runAndReadAll('SELECT 1');
        return { success: true };
      } finally {
        connection.disconnectSync();
        instance.closeSync();
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const tableRows = (await this.query(TABLES_SQL)).rows.map(tableRowFromQueryRow);
    const columnRows = (await this.query(COLUMNS_SQL)).rows.map(columnRowFromQueryRow);
    const constraintRows = (await this.query(CONSTRAINTS_SQL)).rows.map(constraintRowFromQueryRow);
    const columnsByTable = groupByTableKey(columnRows);
    const constraintsByTable = groupByTableKey(constraintRows);
    const tables = await Promise.all(
      tableRows.map(async (table) => this.readTable(table, columnsByTable.get(tableKey(table)) ?? [], constraintsByTable.get(tableKey(table)) ?? [])),
    );
    const fileStats = existsSync(this.dbPath) ? statSync(this.dbPath) : null;
    return {
      connectionId: this.connectionId,
      driver: this.driver,
      extractedAt: this.now().toISOString(),
      scope: {},
      metadata: {
        file_path: this.dbPath,
        file_size: fileStats ? fileStats.size : 0,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns));
    return { headers: result.headers, rows: result.rows, totalRows: result.totalRows };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    const values = result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]);
    return { values, nullCount: null, distinctCount: null };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxDuckDbReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(limitSqlForExecution(input.sql, input.maxRows));
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxDuckDbColumnDistinctValuesOptions,
  ): Promise<KtxDuckDbColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityResult = await this.query(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, sampleSize),
    );
    if (cardinalityResult.rows.length === 0) {
      return null;
    }
    const cardinality = Number(cardinalityResult.rows[0][0]);
    if (Number.isNaN(cardinality)) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valuesResult = await this.query(this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit));
    return {
      values: valuesResult.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => String(row[0])),
      cardinality,
    };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const result = await this.query(`SELECT COUNT(*) AS count FROM ${this.dialect.quoteIdentifier(tableName)}`);
    return Number(result.rows[0]?.[0] ?? 0);
  }

  qTableName(table: Pick<KtxTableRef, 'catalog' | 'db' | 'name'>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async cleanup(): Promise<void> {
    if (this.state) {
      this.state.connection.disconnectSync();
      this.state.instance.closeSync();
      this.state = null;
    }
  }

  private async database(): Promise<DuckDbConnectionState> {
    if (!this.state) {
      assertDuckDbDatabaseFile(this.dbPath);
      const { DuckDBInstance } = await this.nativeLoader.load();
      const instance = await DuckDBInstance.create(this.dbPath, { access_mode: 'READ_ONLY' });
      const connection = await instance.connect();
      this.state = { instance, connection };
    }
    return this.state;
  }

  private async query(sql: string): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const { connection } = await this.database();
    const reader = await connection.runAndReadAll(assertReadOnlySql(sql));
    const rows = normalizeQueryRows(reader.getRowsJS()).map((row) => row.map(normalizeDuckDbValue));
    return {
      headers: reader.columnNames(),
      rows,
      totalRows: rows.length,
    };
  }

  private async readTable(
    table: DuckDbTableRow,
    columns: DuckDbColumnRow[],
    constraints: DuckDbConstraintRow[],
  ): Promise<KtxSchemaTable> {
    const primaryKeyColumns = new Set(
      constraints
        .filter((constraint) => constraint.constraintType === 'PRIMARY KEY')
        .flatMap((constraint) => constraint.columnNames),
    );
    const estimatedRows =
      table.type.toUpperCase().includes('VIEW')
        ? null
        : Number(
            (await this.query(`SELECT COUNT(*) AS count FROM ${this.qTableName(table)}`)).rows[0]?.[0] ?? 0,
          );
    return {
      catalog: table.catalog,
      db: table.db,
      name: table.name,
      kind: table.type.toUpperCase().includes('VIEW') ? 'view' : 'table',
      comment: null,
      estimatedRows,
      columns: columns.map((column) => this.mapColumn(column, primaryKeyColumns)),
      foreignKeys: this.mapForeignKeys(constraints),
    };
  }

  private mapColumn(column: DuckDbColumnRow, primaryKeyColumns: Set<string>): KtxSchemaColumn {
    return {
      name: column.columnName,
      nativeType: column.dataType,
      normalizedType: this.dialect.mapDataType(column.dataType),
      dimensionType: this.dialect.mapToDimensionType(column.dataType),
      nullable: column.isNullable.toUpperCase() === 'YES' && !primaryKeyColumns.has(column.columnName),
      primaryKey: primaryKeyColumns.has(column.columnName),
      comment: null,
    };
  }

  private mapForeignKeys(rows: DuckDbConstraintRow[]): KtxSchemaForeignKey[] {
    const foreignKeys: KtxSchemaForeignKey[] = [];
    for (const row of rows) {
      if (row.constraintType !== 'FOREIGN KEY' || !row.referencedTable) continue;
      row.columnNames.forEach((fromColumn, index) => {
        const toColumn = row.referencedColumnNames[index];
        if (!fromColumn || !toColumn || !row.referencedTable) return;
        foreignKeys.push({
          fromColumn,
          toCatalog: null,
          toDb: row.db,
          toTable: row.referencedTable,
          toColumn,
          constraintName: row.constraintName,
        });
      });
    }
    return foreignKeys;
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`KTX DuckDB connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}

export function createDuckDbQueryExecutor(): KtxSqlQueryExecutorPort {
  return {
    async execute(input: KtxSqlQueryExecutionInput): Promise<KtxSqlQueryExecutionResult> {
      const connector = new KtxDuckDbScanConnector({
        connectionId: input.connectionId,
        projectDir: input.projectDir,
        connection: input.connection as KtxDuckDbConnectionConfig | undefined,
      });
      try {
        const result = await connector.executeReadOnly(
          { connectionId: input.connectionId, sql: input.sql, maxRows: input.maxRows },
          { runId: 'duckdb-query-executor' },
        );
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
          command: 'SELECT',
          rowCount: result.rowCount,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}

function normalizeDuckDbValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeDuckDbValue);
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeDuckDbValue(nested)]),
    );
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function tableKey(table: Pick<DuckDbTableRow, 'catalog' | 'db' | 'name'>): string {
  return `${table.catalog ?? ''}\0${table.db ?? ''}\0${table.name}`;
}

function groupByTableKey<T extends Pick<DuckDbTableRow, 'catalog' | 'db' | 'name'>>(rows: T[]): Map<string, T[]> {
  const byTable = new Map<string, T[]>();
  for (const row of rows) {
    const key = tableKey(row);
    const current = byTable.get(key);
    if (current) {
      current.push(row);
    } else {
      byTable.set(key, [row]);
    }
  }
  return byTable;
}

function tableRowFromQueryRow(row: unknown[]): DuckDbTableRow {
  return {
    catalog: nullableString(row[0]),
    db: nullableString(row[1]),
    name: String(row[2]),
    type: String(row[3]),
  };
}

function columnRowFromQueryRow(row: unknown[]): DuckDbColumnRow {
  return {
    catalog: nullableString(row[0]),
    db: nullableString(row[1]),
    name: String(row[2]),
    tableName: String(row[2]),
    columnName: String(row[3]),
    dataType: String(row[4]),
    isNullable: String(row[5]),
  };
}

function constraintRowFromQueryRow(row: unknown[]): DuckDbConstraintRow {
  return {
    catalog: nullableString(row[0]),
    db: nullableString(row[1]),
    name: String(row[2]),
    tableName: String(row[2]),
    constraintType: String(row[3]),
    constraintName: nullableString(row[4]),
    columnNames: stringArray(row[5]),
    referencedTable: nullableString(row[6]),
    referencedColumnNames: stringArray(row[7]),
  };
}
