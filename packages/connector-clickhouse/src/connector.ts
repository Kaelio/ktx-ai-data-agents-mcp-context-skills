import { createClient } from '@clickhouse/client';
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
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableListEntry,
  type KtxTableSampleResult,
} from '@ktx/context/scan';
import { readFileSync } from 'node:fs';
import { Agent as HttpsAgent } from 'node:https';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { KtxClickHouseDialect } from './dialect.js';

export interface KtxClickHouseConnectionConfig {
  driver?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
  url?: string;
  ssl?: boolean;
  readonly?: boolean;
  [key: string]: unknown;
}

export interface KtxClickHouseResolvedClientConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl: boolean;
}

interface ClickHouseQueryInput {
  query: string;
  format: 'JSONCompact' | 'JSONEachRow';
  query_params?: Record<string, unknown>;
}

interface ClickHouseResultSet {
  json(): Promise<unknown>;
}

export interface KtxClickHouseClient {
  query(input: ClickHouseQueryInput): Promise<ClickHouseResultSet>;
  close(): Promise<void>;
}

export interface KtxClickHouseClientFactory {
  createClient(config: Parameters<typeof createClient>[0]): KtxClickHouseClient;
}

interface KtxClickHouseResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxClickHouseEndpointResolver {
  resolve(input: {
    host: string;
    port: number;
    connection: KtxClickHouseConnectionConfig;
  }): Promise<KtxClickHouseResolvedEndpoint>;
}

export interface KtxClickHouseScanConnectorOptions {
  connectionId: string;
  connection: KtxClickHouseConnectionConfig | undefined;
  clientFactory?: KtxClickHouseClientFactory;
  endpointResolver?: KtxClickHouseEndpointResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxClickHouseReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown>;
}

export interface KtxClickHouseColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxClickHouseColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface ClickHouseTableRow {
  name: string;
  engine: string;
  comment: string;
}

interface ClickHouseColumnRow {
  table: string;
  name: string;
  type: string;
  comment: string;
  is_in_primary_key: number;
}

interface ClickHouseRowCountRow {
  table?: string;
  row_count?: string | number;
  count?: string | number;
}

interface ClickHouseDatabaseRow {
  name: string;
}

interface ClickHouseTableListRow {
  database: string;
  name: string;
  engine: string;
}

interface ClickHouseCompactResponse {
  meta?: Array<{ name: string; type: string }>;
  data?: unknown[][];
  rows?: number;
}

class DefaultClickHouseClientFactory implements KtxClickHouseClientFactory {
  createClient(config: Parameters<typeof createClient>[0]): KtxClickHouseClient {
    return createClient(config);
  }
}

function stringConfigValue(
  connection: KtxClickHouseConnectionConfig | undefined,
  key: keyof KtxClickHouseConnectionConfig,
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

function parseClickHouseUrl(url: string): Partial<KtxClickHouseConnectionConfig> {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname.replace(/^\/+/, '') || undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl: parsed.protocol === 'https:' || parsed.searchParams.get('ssl') === 'true',
  };
}

function tableKind(engine: string): KtxSchemaTable['kind'] {
  return engine === 'View' || engine === 'MaterializedView' ? 'view' : 'table';
}

function isNullableClickHouseType(type: string): boolean {
  return type.startsWith('Nullable(') || type.startsWith('LowCardinality(Nullable(');
}

export function isKtxClickHouseConnectionConfig(connection: KtxClickHouseConnectionConfig | undefined): boolean {
  return String(connection?.driver ?? '').toLowerCase() === 'clickhouse';
}

export function clickHouseClientConfigFromConfig(input: {
  connectionId: string;
  connection: KtxClickHouseConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxClickHouseResolvedClientConfig {
  if (!isKtxClickHouseConnectionConfig(input.connection)) {
    throw new Error(`Native ClickHouse connector cannot run driver "${input.connection?.driver ?? 'unknown'}"`);
  }
  if (input.connection?.readonly !== true) {
    throw new Error(`Native ClickHouse connector requires connections.${input.connectionId}.readonly: true`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parseClickHouseUrl(referencedUrl) : {};
  const merged: KtxClickHouseConnectionConfig = { ...urlConfig, ...input.connection };
  const host = stringConfigValue(merged, 'host', env);
  const database = stringConfigValue(merged, 'database', env) ?? 'default';
  const username = stringConfigValue(merged, 'username', env) ?? stringConfigValue(merged, 'user', env) ?? 'default';

  if (!host) {
    throw new Error(`Native ClickHouse connector requires connections.${input.connectionId}.host or url`);
  }

  return {
    host,
    port: maybeNumber(merged.port) ?? 8123,
    database,
    username,
    password: stringConfigValue(merged, 'password', env),
    ssl: merged.ssl === true,
  };
}

export class KtxClickHouseScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'clickhouse' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: true,
    formalForeignKeys: false,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly connection: KtxClickHouseConnectionConfig;
  private readonly clientConfig: KtxClickHouseResolvedClientConfig;
  private readonly clientFactory: KtxClickHouseClientFactory;
  private readonly endpointResolver?: KtxClickHouseEndpointResolver;
  private readonly now: () => Date;
  private readonly dialect = new KtxClickHouseDialect();
  private client: KtxClickHouseClient | null = null;
  private resolvedEndpoint: KtxClickHouseResolvedEndpoint | null = null;

  constructor(options: KtxClickHouseScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    this.clientConfig = clickHouseClientConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.clientFactory = options.clientFactory ?? new DefaultClickHouseClientFactory();
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
    this.id = `clickhouse:${options.connectionId}`;
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
    const database = this.clientConfig.database;
    const tables = await this.queryEachRow<ClickHouseTableRow>(
      `
      SELECT name, engine, comment
      FROM system.tables
      WHERE database = {database:String}
        AND engine NOT IN ('Dictionary')
      ORDER BY name
      `,
      { database },
    );
    const columns = await this.queryEachRow<ClickHouseColumnRow>(
      `
      SELECT table, name, type, comment, is_in_primary_key
      FROM system.columns
      WHERE database = {database:String}
      ORDER BY table, position
      `,
      { database },
    );
    const rowCounts = await this.queryEachRow<ClickHouseRowCountRow>(
      `
      SELECT table, sum(rows) AS row_count
      FROM system.parts
      WHERE database = {database:String}
        AND active = 1
      GROUP BY table
      `,
      { database },
    );
    const columnsByTable = new Map<string, ClickHouseColumnRow[]>();
    for (const column of columns) {
      columnsByTable.set(column.table, [...(columnsByTable.get(column.table) ?? []), column]);
    }
    const rowCountByTable = new Map(rowCounts.map((row) => [String(row.table), Number(row.row_count ?? 0)]));
    const schemaTables = tables.map((table) =>
      this.toSchemaTable(table, columnsByTable.get(table.name) ?? [], rowCountByTable.get(table.name) ?? 0),
    );

    return {
      connectionId: this.connectionId,
      driver: 'clickhouse',
      extractedAt: this.now().toISOString(),
      scope: { schemas: [database] },
      metadata: {
        database,
        host: this.clientConfig.host,
        table_count: schemaTables.length,
        total_columns: schemaTables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables: schemaTables,
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns),
    );
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

  async executeReadOnly(input: KtxClickHouseReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = this.dialect.prepareQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxClickHouseColumnDistinctValuesOptions,
  ): Promise<KtxClickHouseColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityResult = await this.query(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, sampleSize),
    );
    const cardinality = Number(cardinalityResult.rows[0]?.[0]);
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
      values: valuesResult.rows.filter((row) => row[0] !== null).map((row) => String(row[0])),
      cardinality,
    };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const result = await this.query(
      `
      SELECT sum(rows) AS count
      FROM system.parts
      WHERE database = {database:String}
        AND table = {table:String}
        AND active = 1
      `,
      { database: this.clientConfig.database, table: tableName },
    );
    return Number(result.rows[0]?.[0] ?? 0);
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryEachRow<ClickHouseDatabaseRow>(
      `
      SELECT name
      FROM system.databases
      WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
      ORDER BY name
      `,
    );
    return rows.map((row) => row.name);
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filterSchemas = schemas ?? (await this.listSchemas());
    if (filterSchemas.length === 0) return [];
    const rows = await this.queryEachRow<ClickHouseTableListRow>(
      `
      SELECT database, name, engine
      FROM system.tables
      WHERE database IN ({schemas:Array(String)})
      ORDER BY database, name
      `,
      { schemas: filterSchemas },
    );
    return rows.map((row) => ({
      schema: row.database,
      name: row.name,
      kind: row.engine === 'View' || row.engine === 'MaterializedView' ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.resolvedEndpoint?.close) {
      await this.resolvedEndpoint.close();
      this.resolvedEndpoint = null;
    }
  }

  private toSchemaTable(table: ClickHouseTableRow, columns: ClickHouseColumnRow[], estimatedRows: number): KtxSchemaTable {
    const kind = tableKind(table.engine);
    return {
      catalog: null,
      db: this.clientConfig.database,
      name: table.name,
      kind,
      comment: table.comment || null,
      estimatedRows: kind === 'view' ? null : estimatedRows,
      columns: columns.map((column) => this.toSchemaColumn(column)),
      foreignKeys: [],
    };
  }

  private toSchemaColumn(column: ClickHouseColumnRow): KtxSchemaColumn {
    return {
      name: column.name,
      nativeType: column.type,
      normalizedType: this.dialect.mapDataType(column.type),
      dimensionType: this.dialect.mapToDimensionType(column.type),
      nullable: isNullableClickHouseType(column.type),
      primaryKey: column.is_in_primary_key === 1,
      comment: column.comment || null,
    };
  }

  private async clientForQuery(): Promise<KtxClickHouseClient> {
    if (!this.client) {
      const config = { ...this.clientConfig };
      if (this.endpointResolver) {
        this.resolvedEndpoint = await this.endpointResolver.resolve({
          host: config.host,
          port: config.port,
          connection: this.connection,
        });
        config.host = this.resolvedEndpoint.host;
        config.port = this.resolvedEndpoint.port;
      }
      const protocol = config.ssl ? 'https' : 'http';
      const isProxied = config.host !== this.clientConfig.host;
      this.client = this.clientFactory.createClient({
        url: `${protocol}://${config.host}:${config.port}`,
        username: config.username,
        password: config.password ?? '',
        database: config.database,
        request_timeout: 30_000,
        clickhouse_settings: {
          output_format_json_quote_64bit_integers: 1,
        },
        ...(isProxied && config.ssl
          ? {
              http_agent: new HttpsAgent({
                servername: this.clientConfig.host,
                keepAlive: true,
              }),
            }
          : {}),
      });
    }
    return this.client;
  }

  private async queryEachRow<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
    const client = await this.clientForQuery();
    const resultSet = await client.query({
      query: assertReadOnlySql(sql),
      format: 'JSONEachRow',
      ...(params ? { query_params: params } : {}),
    });
    return (await resultSet.json()) as T[];
  }

  private async query(sql: string, params?: Record<string, unknown>): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const client = await this.clientForQuery();
    const resultSet = await client.query({
      query: assertReadOnlySql(sql),
      format: 'JSONCompact',
      ...(params ? { query_params: params } : {}),
    });
    const response = (await resultSet.json()) as ClickHouseCompactResponse;
    const meta = response.meta ?? [];
    return {
      headers: meta.map((field) => field.name),
      headerTypes: meta.map((field) => field.type),
      rows: response.data ?? [],
      totalRows: response.rows ?? response.data?.length ?? 0,
    };
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`KTX ClickHouse connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
