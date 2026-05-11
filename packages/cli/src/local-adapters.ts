import { join } from 'node:path';
import { createBigQueryLiveDatabaseIntrospection, isKtxBigQueryConnectionConfig } from '@ktx/connector-bigquery';
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
  createDaemonLiveDatabaseIntrospection,
  createDefaultLocalIngestAdapters,
  type DefaultLocalIngestAdaptersOptions,
  type LiveDatabaseIntrospectionPort,
  LiveDatabaseSourceAdapter,
  type SourceAdapter,
} from '@ktx/context/ingest';
import type { KtxLocalProject } from '@ktx/context/project';
import { createHttpSqlAnalysisPort } from '@ktx/context/sql-analysis';
import {
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  managedDaemonDatabaseIntrospectionOptions,
  type ManagedPythonCoreDaemonOptions,
} from './managed-python-http.js';

function hasSnowflakeDriver(connection: unknown): boolean {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    String((connection as { driver?: unknown }).driver ?? '').toLowerCase() === 'snowflake'
  );
}

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
  sqlAnalysisUrl?: string;
  managedDaemon?: ManagedPythonCoreDaemonOptions;
}

function isEnabledPostgresHistoricSqlConnection(connection: KtxPostgresConnectionConfig | undefined): boolean {
  if (!connection || !isKtxPostgresConnectionConfig(connection)) {
    return false;
  }
  const historicSql =
    typeof connection.historicSql === 'object' &&
    connection.historicSql !== null &&
    !Array.isArray(connection.historicSql)
      ? (connection.historicSql as Record<string, unknown>)
      : null;
  return historicSql?.enabled === true && historicSql.dialect === 'postgres';
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

function historicSqlOptionsForLocalRun(project: KtxLocalProject, options: KtxCliLocalIngestAdaptersOptions) {
  const connectionId = options.historicSqlConnectionId;
  if (!connectionId) {
    return undefined;
  }
  const connection = project.config.connections[connectionId] as KtxPostgresConnectionConfig | undefined;
  if (!isEnabledPostgresHistoricSqlConnection(connection)) {
    return undefined;
  }
  return {
    sqlAnalysis: ktxCliHistoricSqlAnalysis(options),
    postgresQueryClient: createEphemeralPostgresHistoricSqlClient(project, connectionId),
    postgresBaselineRootDir: join(project.projectDir, '.ktx/cache/historic-sql'),
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
