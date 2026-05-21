import type { KtxLocalProject } from './context/project/project.js';
import type { KtxScanConnector } from './context/scan/types.js';

const SUPPORTED_DRIVERS = 'sqlite, postgres, mysql, clickhouse, sqlserver, bigquery, snowflake';

export async function createKtxCliScanConnector(
  project: KtxLocalProject,
  connectionId: string,
): Promise<KtxScanConnector> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const driver = String(connection.driver ?? '').toLowerCase();
  if (!driver) {
    throw new Error(
      `Connection "${connectionId}" has no \`driver\` field in ktx.yaml. Supported drivers: ${SUPPORTED_DRIVERS}.`,
    );
  }
  if (driver === 'sqlite' || driver === 'sqlite3') {
    const { KtxSqliteScanConnector, isKtxSqliteConnectionConfig } = await import('./connectors/sqlite/connector.js');;
    if (!isKtxSqliteConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxSqliteScanConnector({ connectionId, connection, projectDir: project.projectDir });
  }
  if (driver === 'postgres' || driver === 'postgresql') {
    const { KtxPostgresScanConnector, isKtxPostgresConnectionConfig } = await import('./connectors/postgres/connector.js');;
    if (!isKtxPostgresConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxPostgresScanConnector({ connectionId, connection });
  }
  if (driver === 'mysql') {
    const { KtxMysqlScanConnector, isKtxMysqlConnectionConfig } = await import('./connectors/mysql/connector.js');;
    if (!isKtxMysqlConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxMysqlScanConnector({ connectionId, connection });
  }
  if (driver === 'clickhouse') {
    const { KtxClickHouseScanConnector, isKtxClickHouseConnectionConfig } = await import('./connectors/clickhouse/connector.js');;
    if (!isKtxClickHouseConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxClickHouseScanConnector({ connectionId, connection });
  }
  if (driver === 'sqlserver') {
    const { KtxSqlServerScanConnector, isKtxSqlServerConnectionConfig } = await import('./connectors/sqlserver/connector.js');;
    if (!isKtxSqlServerConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxSqlServerScanConnector({ connectionId, connection });
  }
  if (driver === 'bigquery') {
    const { KtxBigQueryScanConnector, isKtxBigQueryConnectionConfig } = await import('./connectors/bigquery/connector.js');;
    if (!isKtxBigQueryConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxBigQueryScanConnector({ connectionId, connection });
  }
  if (driver === 'snowflake') {
    const { KtxSnowflakeScanConnector, isKtxSnowflakeConnectionConfig } = await import('./connectors/snowflake/connector.js');;
    if (!isKtxSnowflakeConnectionConfig(connection)) {
      throw invalidConnectionConfigError(connectionId, driver);
    }
    return new KtxSnowflakeScanConnector({ connectionId, connection });
  }
  throw new Error(
    `Connection "${connectionId}" uses driver "${driver}", which has no native standalone KTX scan connector. Supported drivers: ${SUPPORTED_DRIVERS}.`,
  );
}

function invalidConnectionConfigError(connectionId: string, driver: string): Error {
  return new Error(
    `Connection "${connectionId}" uses driver "${driver}" but its configuration in ktx.yaml does not match the expected shape for that driver. Check the required fields for ${driver} (e.g. url/host/database).`,
  );
}
