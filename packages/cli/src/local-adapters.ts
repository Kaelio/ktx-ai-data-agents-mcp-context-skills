import { join } from 'node:path';
import {
  createBigQueryLiveDatabaseIntrospection,
  isKtxBigQueryConnectionConfig,
  KtxBigQueryScanConnector,
  type KtxBigQueryConnectionConfig,
} from '@ktx/connector-bigquery';
import { createClickHouseLiveDatabaseIntrospection, isKtxClickHouseConnectionConfig } from '@ktx/connector-clickhouse';
import { createMysqlLiveDatabaseIntrospection, isKtxMysqlConnectionConfig } from '@ktx/connector-mysql';
import {
  createPostgresLiveDatabaseIntrospection,
  isKtxPostgresConnectionConfig,
  type KtxPostgresConnectionConfig,
  KtxPostgresHistoricSqlQueryClient,
} from '@ktx/connector-postgres';
import { createSqliteLiveDatabaseIntrospection, isKtxSqliteConnectionConfig } from '@ktx/connector-sqlite';
import { createSqlServerLiveDatabaseIntrospection, isKtxSqlServerConnectionConfig } from '@ktx/connector-sqlserver';
import {
  BigQueryHistoricSqlQueryHistoryReader,
  createDaemonLiveDatabaseIntrospection,
  createDefaultLocalIngestAdapters,
  type DefaultLocalIngestAdaptersOptions,
  type HistoricSqlReader,
  type LiveDatabaseIntrospectionPort,
  LiveDatabaseSourceAdapter,
  PostgresPgssReader,
  SnowflakeHistoricSqlQueryHistoryReader,
  type SourceAdapter,
} from '@ktx/context/ingest';
import type { KtxLocalProject } from '@ktx/context/project';
import { createHttpSqlAnalysisPort, type SqlAnalysisPort } from '@ktx/context/sql-analysis';
import {
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  managedDaemonDatabaseIntrospectionOptions,
  type ManagedPythonCoreDaemonOptions,
} from './managed-python-http.js';
import type { KtxOperationalLogger } from './io/logger.js';

function hasSnowflakeDriver(connection: unknown): boolean {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    String((connection as { driver?: unknown }).driver ?? '').toLowerCase() === 'snowflake'
  );
}

type SnowflakeConnectorModule = typeof import('@ktx/connector-snowflake');

function ktxCliDaemonDatabaseIntrospectionOptions(
  options: KtxCliLocalIngestAdaptersOptions,
): DefaultLocalIngestAdaptersOptions['databaseIntrospection'] {
  if (options.databaseIntrospectionUrl || options.databaseIntrospection?.requestJson || !options.managedDaemon) {
    return options.databaseIntrospection;
  }
  return {
    ...(options.databaseIntrospection ?? {}),
    ...managedDaemonDatabaseIntrospectionOptions(options.managedDaemon),
  };
}

function ktxCliLookerOptions(
  options: KtxCliLocalIngestAdaptersOptions,
): DefaultLocalIngestAdaptersOptions['looker'] {
  const looker = options.looker;
  if (looker?.parser || looker?.daemonBaseUrl || process.env.KTX_DAEMON_URL || !options.managedDaemon) {
    return looker;
  }
  return {
    ...(looker ?? {}),
    parser: createManagedDaemonLookerTableIdentifierParser(options.managedDaemon),
  };
}

function ktxCliHistoricSqlAnalysis(options: KtxCliLocalIngestAdaptersOptions) {
  if (options.sqlAnalysis) {
    return options.sqlAnalysis;
  }
  if (options.sqlAnalysisUrl) {
    return createHttpSqlAnalysisPort({ baseUrl: options.sqlAnalysisUrl });
  }
  if (process.env.KTX_SQL_ANALYSIS_URL) {
    return createHttpSqlAnalysisPort({ baseUrl: process.env.KTX_SQL_ANALYSIS_URL });
  }
  if (process.env.KTX_DAEMON_URL) {
    return createHttpSqlAnalysisPort({ baseUrl: process.env.KTX_DAEMON_URL });
  }
  if (options.managedDaemon) {
    return createManagedDaemonSqlAnalysisPort(options.managedDaemon);
  }
  return createHttpSqlAnalysisPort({ baseUrl: 'http://127.0.0.1:8765' });
}

function createKtxCliLiveDatabaseIntrospection(
  project: KtxLocalProject,
  options: KtxCliLocalIngestAdaptersOptions = {},
): LiveDatabaseIntrospectionPort {
  const databaseIntrospection = ktxCliDaemonDatabaseIntrospectionOptions(options);
  const daemon = createDaemonLiveDatabaseIntrospection({
    connections: project.config.connections,
    ...databaseIntrospection,
    ...(options.databaseIntrospectionUrl ? { baseUrl: options.databaseIntrospectionUrl } : {}),
  });
  const sqlite = createSqliteLiveDatabaseIntrospection({
    projectDir: project.projectDir,
    connections: project.config.connections,
  });
  const mysql = createMysqlLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const postgres = createPostgresLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const clickhouse = createClickHouseLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const sqlserver = createSqlServerLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const bigquery = createBigQueryLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  return {
    async extractSchema(connectionId: string) {
      const connection = project.config.connections[connectionId];
      if (isKtxPostgresConnectionConfig(connection)) {
        return postgres.extractSchema(connectionId);
      }
      if (isKtxSqliteConnectionConfig(connection)) {
        return sqlite.extractSchema(connectionId);
      }
      if (isKtxMysqlConnectionConfig(connection)) {
        return mysql.extractSchema(connectionId);
      }
      if (isKtxClickHouseConnectionConfig(connection)) {
        return clickhouse.extractSchema(connectionId);
      }
      if (isKtxSqlServerConnectionConfig(connection)) {
        return sqlserver.extractSchema(connectionId);
      }
      if (isKtxBigQueryConnectionConfig(connection)) {
        return bigquery.extractSchema(connectionId);
      }
      if (hasSnowflakeDriver(connection)) {
        const { createSnowflakeLiveDatabaseIntrospection, isKtxSnowflakeConnectionConfig } = await import(
          '@ktx/connector-snowflake'
        );
        if (!isKtxSnowflakeConnectionConfig(connection)) {
          return daemon.extractSchema(connectionId);
        }
        const snowflake = createSnowflakeLiveDatabaseIntrospection({
          connections: project.config.connections,
        });
        return snowflake.extractSchema(connectionId);
      }
      return daemon.extractSchema(connectionId);
    },
  };
}

export interface KtxCliLocalIngestAdaptersOptions extends DefaultLocalIngestAdaptersOptions {
  historicSqlConnectionId?: string;
  sqlAnalysis?: SqlAnalysisPort;
  sqlAnalysisUrl?: string;
  managedDaemon?: ManagedPythonCoreDaemonOptions;
  logger?: KtxOperationalLogger;
}

function historicSqlRecord(connection: unknown): Record<string, unknown> | null {
  if (
    connection &&
    typeof connection === 'object' &&
    'historicSql' in connection &&
    typeof (connection as { historicSql?: unknown }).historicSql === 'object' &&
    (connection as { historicSql?: unknown }).historicSql !== null &&
    !Array.isArray((connection as { historicSql?: unknown }).historicSql)
  ) {
    return (connection as { historicSql: Record<string, unknown> }).historicSql;
  }
  return null;
}

function enabledHistoricSqlDialect(connection: unknown): 'postgres' | 'bigquery' | 'snowflake' | null {
  const historicSql = historicSqlRecord(connection);
  if (historicSql?.enabled !== true) {
    return null;
  }
  const dialect = String(historicSql.dialect ?? '').toLowerCase();
  return dialect === 'postgres' || dialect === 'bigquery' || dialect === 'snowflake' ? dialect : null;
}

function createEphemeralPostgresHistoricSqlClient(project: KtxLocalProject, connectionId: string) {
  const connection = project.config.connections[connectionId] as KtxPostgresConnectionConfig | undefined;
  if (!isKtxPostgresConnectionConfig(connection)) {
    throw new Error(
      `Historic SQL local ingest requires a Postgres connection, got ${String(connection?.driver ?? 'unknown')}`,
    );
  }
  return {
    async executeQuery(sql: string, params?: unknown[]) {
      const client = new KtxPostgresHistoricSqlQueryClient({
        connectionId,
        connection,
      });
      try {
        return await client.executeQuery(sql, params);
      } finally {
        await client.cleanup();
      }
    },
  };
}

function createEphemeralBigQueryHistoricSqlClient(project: KtxLocalProject, connectionId: string) {
  const connection = project.config.connections[connectionId] as KtxBigQueryConnectionConfig | undefined;
  if (!isKtxBigQueryConnectionConfig(connection)) {
    throw new Error(
      `Historic SQL local ingest requires a BigQuery connection, got ${String(connection?.driver ?? 'unknown')}`,
    );
  }
  return {
    async executeQuery(query: string) {
      const connector = new KtxBigQueryScanConnector({
        connectionId,
        connection,
      });
      try {
        const result = await connector.executeReadOnly({ connectionId, sql: query }, {} as never);
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}

async function createEphemeralSnowflakeHistoricSqlClient(
  project: KtxLocalProject,
  connectionId: string,
  connectorModule: SnowflakeConnectorModule,
) {
  const connection = project.config.connections[connectionId];
  if (!connectorModule.isKtxSnowflakeConnectionConfig(connection)) {
    throw new Error(
      `Historic SQL local ingest requires a Snowflake connection, got ${String(connection?.driver ?? 'unknown')}`,
    );
  }
  return {
    async executeQuery(query: string) {
      const connector = new connectorModule.KtxSnowflakeScanConnector({
        connectionId,
        connection,
      });
      try {
        const result = await connector.executeReadOnly({ connectionId, sql: query }, {} as never);
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}

function bigQueryProjectId(connection: KtxBigQueryConnectionConfig, env: NodeJS.ProcessEnv): string {
  const raw = typeof connection.credentials_json === 'string' ? connection.credentials_json : '';
  const resolved = raw.startsWith('env:') ? env[raw.slice('env:'.length)] ?? '' : raw;
  const parsed = JSON.parse(resolved) as { project_id?: unknown };
  if (typeof parsed.project_id !== 'string' || parsed.project_id.trim().length === 0) {
    throw new Error('Historic SQL BigQuery connection requires credentials_json.project_id');
  }
  return parsed.project_id;
}

function bigQueryRegion(connection: KtxBigQueryConnectionConfig): string {
  return typeof connection.location === 'string' && connection.location.trim().length > 0
    ? connection.location.trim()
    : 'us';
}

function historicSqlOptionsForLocalRun(project: KtxLocalProject, options: KtxCliLocalIngestAdaptersOptions) {
  const connectionId = options.historicSqlConnectionId;
  if (!connectionId) {
    return undefined;
  }
  const connection = project.config.connections[connectionId];
  const dialect = enabledHistoricSqlDialect(connection);
  if (!dialect) {
    return undefined;
  }

  const base = {
    sqlAnalysis: ktxCliHistoricSqlAnalysis(options),
    postgresBaselineRootDir: join(project.projectDir, '.ktx/cache/historic-sql'),
  };

  if (dialect === 'postgres') {
    return {
      ...base,
      reader: new PostgresPgssReader() satisfies HistoricSqlReader,
      queryClient: createEphemeralPostgresHistoricSqlClient(project, connectionId),
    };
  }

  if (dialect === 'bigquery') {
    if (!isKtxBigQueryConnectionConfig(connection)) {
      throw new Error(
        `Historic SQL local ingest requires a BigQuery connection, got ${String(connection?.driver ?? 'unknown')}`,
      );
    }
    return {
      ...base,
      reader: new BigQueryHistoricSqlQueryHistoryReader({
        projectId: bigQueryProjectId(connection, process.env),
        region: bigQueryRegion(connection),
      }) satisfies HistoricSqlReader,
      queryClient: createEphemeralBigQueryHistoricSqlClient(project, connectionId),
    };
  }

  return {
    ...base,
    reader: new SnowflakeHistoricSqlQueryHistoryReader() satisfies HistoricSqlReader,
    queryClient: {
      async executeQuery(query: string) {
        const connectorModule = await import('@ktx/connector-snowflake');
        const client = await createEphemeralSnowflakeHistoricSqlClient(project, connectionId, connectorModule);
        return client.executeQuery(query);
      },
    },
  };
}

export function createKtxCliLocalIngestAdapters(
  project: KtxLocalProject,
  options: KtxCliLocalIngestAdaptersOptions = {},
): SourceAdapter[] {
  const historicSql = historicSqlOptionsForLocalRun(project, options);
  const base = createDefaultLocalIngestAdapters(project, {
    ...options,
    databaseIntrospection: ktxCliDaemonDatabaseIntrospectionOptions(options),
    looker: ktxCliLookerOptions(options),
    ...(historicSql ? { historicSql } : {}),
  });
  const liveDatabase = new LiveDatabaseSourceAdapter({
    introspection: createKtxCliLiveDatabaseIntrospection(project, options),
  });
  return base.map((adapter) => (adapter.source === 'live-database' ? liveDatabase : adapter));
}
