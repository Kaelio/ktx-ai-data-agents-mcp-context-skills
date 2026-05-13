import mysql, { type FieldPacket, type Pool, type RowDataPacket } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { assertReadOnlySql, limitSqlForExecution } from '@ktx/context/connections';
import {
  createKtxConnectorCapabilities,
  type KtxColumnSampleInput,
  type KtxColumnSampleResult,
  type KtxColumnStatsInput,
  type KtxColumnStatsResult,
  type KtxQueryResult,
  type KtxReadOnlyQueryInput,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanInput,
  type KtxSchemaColumn,
  type KtxTableListEntry,
  type KtxSchemaForeignKey,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '@ktx/context/scan';
import { KtxMysqlDialect } from './dialect.js';

export interface KtxMysqlConnectionConfig {
  driver?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
  url?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  readonly?: boolean;
  [key: string]: unknown;
}

export interface KtxMysqlPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  connectionLimit: number;
  waitForConnections: true;
  ssl?: { rejectUnauthorized: boolean };
}

interface KtxMysqlConnection {
  query(sql: string, params?: unknown): Promise<[RowDataPacket[], FieldPacket[]]>;
  release(): void;
}

interface KtxMysqlPool {
  getConnection(): Promise<KtxMysqlConnection>;
  end(): Promise<void>;
}

export interface KtxMysqlPoolFactory {
  createPool(config: KtxMysqlPoolConfig): KtxMysqlPool;
}

interface KtxMysqlResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxMysqlEndpointResolver {
  resolve(input: { host: string; port: number; connection: KtxMysqlConnectionConfig }): Promise<KtxMysqlResolvedEndpoint>;
}

export interface KtxMysqlScanConnectorOptions {
  connectionId: string;
  connection: KtxMysqlConnectionConfig | undefined;
  poolFactory?: KtxMysqlPoolFactory;
  endpointResolver?: KtxMysqlEndpointResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxMysqlReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown> | unknown[];
}

export interface KtxMysqlColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxMysqlColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface MysqlTableRow extends RowDataPacket {
  TABLE_NAME: string;
  TABLE_TYPE: string;
  TABLE_COMMENT: string | null;
  TABLE_ROWS: number | null;
}

interface MysqlColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_COMMENT: string | null;
}

interface MysqlPrimaryKeyRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
}

interface MysqlForeignKeyRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
}

interface MysqlSchemaRow extends RowDataPacket {
  SCHEMA_NAME: string;
}

interface MysqlTableListRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
}

interface MysqlCountRow extends RowDataPacket {
  count?: unknown;
  cardinality?: unknown;
}

interface MysqlDistinctValueRow extends RowDataPacket {
  val: unknown;
}

class DefaultMysqlPoolFactory implements KtxMysqlPoolFactory {
  createPool(config: KtxMysqlPoolConfig): KtxMysqlPool {
    return mysql.createPool(config) as Pool;
  }
}

function stringConfigValue(
  connection: KtxMysqlConnectionConfig | undefined,
  key: keyof KtxMysqlConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function resolveStringReference(value: string, env: NodeJS.ProcessEnv): string {
  if (value.startsWith('env:')) {
    const envName = value.slice('env:'.length);
    return env[envName] ?? '';
  }
  if (value.startsWith('file:')) {
    const rawPath = value.slice('file:'.length);
    const path = rawPath.startsWith('~') ? resolve(homedir(), rawPath.slice(1)) : rawPath;
    return readFileSync(path, 'utf-8').trim();
  }
  return value;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseMysqlUrl(url: string): Partial<KtxMysqlConnectionConfig> {
  const parsed = new URL(url);
  const sslParam = parsed.searchParams.get('ssl') ?? parsed.searchParams.get('sslmode');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname.replace(/^\/+/, '') || undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl: sslParam === 'true' || sslParam === 'required',
  };
}

function cleanMySqlTableComment(comment: string | null): string | null {
  if (!comment) {
    return null;
  }
  if (comment.startsWith('InnoDB free:')) {
    const semiIndex = comment.indexOf(';');
    if (semiIndex === -1) {
      return null;
    }
    const userComment = comment.slice(semiIndex + 1).trim();
    return userComment || null;
  }
  return comment;
}

function groupByTable<T extends { TABLE_NAME: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const tableRows = grouped.get(row.TABLE_NAME) ?? [];
    tableRows.push(row);
    grouped.set(row.TABLE_NAME, tableRows);
  }
  return grouped;
}

function primaryKeyMap(rows: MysqlPrimaryKeyRow[]): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = grouped.get(row.TABLE_NAME) ?? new Set<string>();
    columns.add(row.COLUMN_NAME);
    grouped.set(row.TABLE_NAME, columns);
  }
  return grouped;
}

function queryParams(params: Record<string, unknown> | unknown[] | undefined): unknown[] | undefined {
  if (!params) {
    return undefined;
  }
  return Array.isArray(params) ? params : Object.values(params);
}

export function isKtxMysqlConnectionConfig(connection: KtxMysqlConnectionConfig | undefined): boolean {
  return String(connection?.driver ?? '').toLowerCase() === 'mysql';
}

export function mysqlConnectionPoolConfigFromConfig(input: {
  connectionId: string;
  connection: KtxMysqlConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxMysqlPoolConfig {
  if (!isKtxMysqlConnectionConfig(input.connection)) {
    throw new Error(`Native MySQL connector cannot run driver "${input.connection?.driver ?? 'unknown'}"`);
  }
  if (input.connection?.readonly !== true) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.readonly: true`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parseMysqlUrl(referencedUrl) : {};
  const merged: KtxMysqlConnectionConfig = { ...urlConfig, ...input.connection };
  const host = stringConfigValue(merged, 'host', env);
  const database = stringConfigValue(merged, 'database', env);
  const user = stringConfigValue(merged, 'username', env) ?? stringConfigValue(merged, 'user', env);

  if (!host) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.host or url`);
  }
  if (!database) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.database or url`);
  }
  if (!user) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.username, user, or url`);
  }

  const ssl = merged.ssl === true ? { rejectUnauthorized: false } : typeof merged.ssl === 'object' ? merged.ssl : undefined;
  return {
    host,
    port: maybeNumber(merged.port) ?? 3306,
    database,
    user,
    password: stringConfigValue(merged, 'password', env),
    connectionLimit: 10,
    waitForConnections: true,
    ...(ssl ? { ssl: { rejectUnauthorized: ssl.rejectUnauthorized ?? false } } : {}),
  };
}

export class KtxMysqlScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'mysql' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: true,
    formalForeignKeys: true,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly connection: KtxMysqlConnectionConfig;
  private readonly poolConfig: KtxMysqlPoolConfig;
  private readonly poolFactory: KtxMysqlPoolFactory;
  private readonly endpointResolver?: KtxMysqlEndpointResolver;
  private readonly now: () => Date;
  private readonly dialect = new KtxMysqlDialect();
  private pool: KtxMysqlPool | null = null;
  private resolvedEndpoint: KtxMysqlResolvedEndpoint | null = null;

  constructor(options: KtxMysqlScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    this.poolConfig = mysqlConnectionPoolConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.poolFactory = options.poolFactory ?? new DefaultMysqlPoolFactory();
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
    this.id = `mysql:${options.connectionId}`;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.query('SELECT 1');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const database = this.poolConfig.database;
    const tables = await this.queryRaw<MysqlTableRow>(
      `
      SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_NAME
      `,
      [database],
    );
    const columns = await this.queryRaw<MysqlColumnRow>(
      `
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_COMMENT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      [database],
    );
    const primaryKeys = await this.queryRaw<MysqlPrimaryKeyRow>(
      `
      SELECT TABLE_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      [database],
    );
    const foreignKeys = await this.queryRaw<MysqlForeignKeyRow>(
      `
      SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, COLUMN_NAME
      `,
      [database],
    );

    const columnsByTable = groupByTable(columns);
    const primaryKeysByTable = primaryKeyMap(primaryKeys);
    const foreignKeysByTable = groupByTable(foreignKeys);
    const schemaTables = tables.map((table) =>
      this.toSchemaTable(table, columnsByTable.get(table.TABLE_NAME) ?? [], primaryKeysByTable, foreignKeysByTable),
    );

    return {
      connectionId: this.connectionId,
      driver: 'mysql',
      extractedAt: this.now().toISOString(),
      scope: { schemas: [database] },
      metadata: {
        database,
        host: this.poolConfig.host,
        table_count: schemaTables.length,
        total_columns: schemaTables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables: schemaTables,
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

  async executeReadOnly(input: KtxMysqlReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = Array.isArray(input.params)
      ? { sql: limitedSql, params: input.params }
      : this.dialect.prepareQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxMysqlColumnDistinctValuesOptions,
  ): Promise<KtxMysqlColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityRows = await this.queryRaw<MysqlCountRow>(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, sampleSize),
    );
    const cardinality = Number(cardinalityRows[0]?.cardinality);
    if (Number.isNaN(cardinality)) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valuesRows = await this.queryRaw<MysqlDistinctValueRow>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return {
      values: valuesRows.filter((row) => row.val !== null).map((row) => String(row.val)),
      cardinality,
    };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const rows = await this.queryRaw<MysqlCountRow>(
      `SELECT COUNT(*) AS count FROM ${this.dialect.quoteIdentifier(tableName)}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryRaw<MysqlSchemaRow>(`
      SELECT SCHEMA_NAME
      FROM INFORMATION_SCHEMA.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY SCHEMA_NAME
    `);
    return rows.map((row) => row.SCHEMA_NAME);
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filterSchemas = schemas ?? (await this.listSchemas());
    if (filterSchemas.length === 0) return [];
    const placeholders = filterSchemas.map(() => '?').join(', ');
    const rows = await this.queryRaw<MysqlTableListRow>(
      `
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA IN (${placeholders})
        AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_SCHEMA, TABLE_NAME
      `,
      filterSchemas,
    );
    return rows.map((row) => ({
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
      kind: row.TABLE_TYPE === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.resolvedEndpoint?.close) {
      await this.resolvedEndpoint.close();
      this.resolvedEndpoint = null;
    }
  }

  private toSchemaTable(
    table: MysqlTableRow,
    columns: MysqlColumnRow[],
    primaryKeysByTable: Map<string, Set<string>>,
    foreignKeysByTable: Map<string, MysqlForeignKeyRow[]>,
  ): KtxSchemaTable {
    const tableName = table.TABLE_NAME;
    const kind = table.TABLE_TYPE === 'VIEW' ? 'view' : 'table';
    const estimatedRows = kind === 'view' ? null : Number(table.TABLE_ROWS ?? 0);
    return {
      catalog: null,
      db: this.poolConfig.database,
      name: tableName,
      kind,
      comment: cleanMySqlTableComment(table.TABLE_COMMENT),
      estimatedRows: Number.isFinite(estimatedRows) ? estimatedRows : null,
      columns: columns.map((column) => this.toSchemaColumn(column, primaryKeysByTable.get(tableName) ?? new Set())),
      foreignKeys: (foreignKeysByTable.get(tableName) ?? []).map((row) => this.toSchemaForeignKey(row)),
    };
  }

  private toSchemaColumn(column: MysqlColumnRow, primaryKeys: Set<string>): KtxSchemaColumn {
    return {
      name: column.COLUMN_NAME,
      nativeType: column.DATA_TYPE,
      normalizedType: this.dialect.mapDataType(column.DATA_TYPE),
      dimensionType: this.dialect.mapToDimensionType(column.DATA_TYPE),
      nullable: column.IS_NULLABLE === 'YES',
      primaryKey: primaryKeys.has(column.COLUMN_NAME),
      comment: column.COLUMN_COMMENT || null,
    };
  }

  private toSchemaForeignKey(row: MysqlForeignKeyRow): KtxSchemaForeignKey {
    return {
      fromColumn: row.COLUMN_NAME,
      toCatalog: null,
      toDb: this.poolConfig.database,
      toTable: row.REFERENCED_TABLE_NAME,
      toColumn: row.REFERENCED_COLUMN_NAME,
      constraintName: row.CONSTRAINT_NAME || null,
    };
  }

  private async poolForQuery(): Promise<KtxMysqlPool> {
    if (!this.pool) {
      const config = { ...this.poolConfig };
      if (this.endpointResolver) {
        this.resolvedEndpoint = await this.endpointResolver.resolve({
          host: config.host,
          port: config.port,
          connection: this.connection,
        });
        config.host = this.resolvedEndpoint.host;
        config.port = this.resolvedEndpoint.port;
      }
      this.pool = this.poolFactory.createPool(config);
    }
    return this.pool;
  }

  private async queryRaw<T extends RowDataPacket>(sql: string, params?: unknown): Promise<T[]> {
    const pool = await this.poolForQuery();
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query(sql, params);
      return rows as T[];
    } finally {
      connection.release();
    }
  }

  private async query(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const pool = await this.poolForQuery();
    const connection = await pool.getConnection();
    try {
      const [rows, fields] = await connection.query(assertReadOnlySql(sql), queryParams(params));
      const headers = fields.map((field) => field.name);
      const headerTypes = fields.map((field) => String(field.type ?? 'unknown'));
      return {
        headers,
        headerTypes,
        rows: rows.map((row) => headers.map((header) => row[header])),
        totalRows: rows.length,
      };
    } finally {
      connection.release();
    }
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`KTX MySQL connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
