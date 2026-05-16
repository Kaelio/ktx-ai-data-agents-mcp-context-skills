import type { KtxSqlQueryExecutorPort } from '../connections/index.js';
import type { KtxSemanticLayerComputePort } from '../daemon/index.js';
import type { KtxLocalProject } from '../project/index.js';
import { loadLocalSlSourceRecords } from './local-sl.js';
import { toResolvedWire } from './semantic-layer.service.js';
import type { SemanticLayerQueryExecutionResult, SemanticLayerQueryInput } from './types.js';

const COMPILE_ONLY_REASON =
  'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.';

export interface CompileLocalSlQueryOptions {
  connectionId?: string;
  query: SemanticLayerQueryInput;
  compute: KtxSemanticLayerComputePort;
  execute?: boolean;
  maxRows?: number;
  queryExecutor?: KtxSqlQueryExecutorPort;
}

export interface CompileLocalSlQueryResult extends SemanticLayerQueryExecutionResult {
  connectionId: string;
  dialect: string;
}

function assertSafePathToken(kind: string, value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.includes('//')
  ) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

function assertSafeConnectionId(connectionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  return assertSafePathToken('connection id', connectionId);
}

function dialectForDriver(driver: string | undefined): string {
  const normalized = (driver ?? 'postgres').toUpperCase();
  const map: Record<string, string> = {
    POSTGRESQL: 'postgres',
    POSTGRES: 'postgres',
    BIGQUERY: 'bigquery',
    SNOWFLAKE: 'snowflake',
    MYSQL: 'mysql',
    SQLSERVER: 'tsql',
    MSSQL: 'tsql',
    SQLITE: 'sqlite',
    DUCKDB: 'duckdb',
    CLICKHOUSE: 'clickhouse',
    REDSHIFT: 'redshift',
    DATABRICKS: 'databricks',
  };
  return map[normalized] ?? 'postgres';
}

function resolveLocalConnectionId(project: KtxLocalProject, requested: string | undefined): string {
  if (requested) {
    return assertSafeConnectionId(requested);
  }
  const ids = Object.keys(project.config.connections).sort();
  if (ids.length === 1) {
    return assertSafeConnectionId(ids[0]);
  }
  throw new Error('connectionId is required when the local project has zero or multiple connections.');
}

async function loadComputableSources(
  project: KtxLocalProject,
  connectionId: string,
): Promise<ReturnType<typeof toResolvedWire>[]> {
  return (await loadLocalSlSourceRecords(project, { connectionId: assertSafeConnectionId(connectionId) }))
    .filter((record) => record.source.table || record.source.sql)
    .map((record) => toResolvedWire(record.source));
}

function headersFromColumns(columns: Array<Record<string, unknown>>): string[] {
  return columns
    .map((column) => column.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export async function compileLocalSlQuery(
  project: KtxLocalProject,
  options: CompileLocalSlQueryOptions,
): Promise<CompileLocalSlQueryResult> {
  const connectionId = resolveLocalConnectionId(project, options.connectionId);
  const dialect = dialectForDriver(project.config.connections[connectionId]?.driver);
  const response = await options.compute.query({
    sources: await loadComputableSources(project, connectionId),
    dialect,
    query: options.query,
  });

  if (!options.execute) {
    return {
      connectionId,
      dialect: response.dialect,
      sql: response.sql,
      headers: headersFromColumns(response.columns),
      rows: [],
      totalRows: 0,
      plan: {
        ...response.plan,
        execution: {
          mode: 'compile_only',
          reason: COMPILE_ONLY_REASON,
        },
      },
    };
  }

  if (!options.queryExecutor) {
    throw new Error('Local semantic-layer execution requires a query executor.');
  }

  const maxRows = options.maxRows ?? options.query.limit;
  const execution = await options.queryExecutor.execute({
    connectionId,
    projectDir: project.projectDir,
    connection: project.config.connections[connectionId],
    sql: response.sql,
    maxRows,
  });

  return {
    connectionId,
    dialect: response.dialect,
    sql: response.sql,
    headers: execution.headers,
    rows: execution.rows,
    totalRows: execution.totalRows,
    plan: {
      ...response.plan,
      execution: {
        mode: 'executed',
        driver: project.config.connections[connectionId]?.driver ?? 'unknown',
        maxRows,
        rowCount: execution.rowCount,
      },
    },
  };
}
