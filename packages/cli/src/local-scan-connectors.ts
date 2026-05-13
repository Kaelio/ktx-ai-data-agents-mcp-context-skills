import type { KtxLocalProject } from '@ktx/context/project';
import type { KtxScanConnector } from '@ktx/context/scan';

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
    const { KtxSqliteScanConnector, isKtxSqliteConnectionConfig } = await import('@ktx/connector-sqlite');
    if (isKtxSqliteConnectionConfig(connection)) {
      return new KtxSqliteScanConnector({ connectionId, connection, projectDir: project.projectDir });
    }
  }
  if (driver === 'postgres' || driver === 'postgresql') {
    const { KtxPostgresScanConnector, isKtxPostgresConnectionConfig } = await import('@ktx/connector-postgres');
    if (isKtxPostgresConnectionConfig(connection)) {
      return new KtxPostgresScanConnector({ connectionId, connection });
    }
  }
  if (driver === 'mysql') {
    const { KtxMysqlScanConnector, isKtxMysqlConnectionConfig } = await import('@ktx/connector-mysql');
    if (isKtxMysqlConnectionConfig(connection)) {
      return new KtxMysqlScanConnector({ connectionId, connection });
    }
  }
  if (driver === 'clickhouse') {
    const { KtxClickHouseScanConnector, isKtxClickHouseConnectionConfig } = await import('@ktx/connector-clickhouse');
    if (isKtxClickHouseConnectionConfig(connection)) {
      return new KtxClickHouseScanConnector({ connectionId, connection });
    }
  }
  if (driver === 'sqlserver') {
    const { KtxSqlServerScanConnector, isKtxSqlServerConnectionConfig } = await import('@ktx/connector-sqlserver');
    if (isKtxSqlServerConnectionConfig(connection)) {
      return new KtxSqlServerScanConnector({ connectionId, connection });
    }
  }
  if (driver === 'bigquery') {
    const { KtxBigQueryScanConnector, isKtxBigQueryConnectionConfig } = await import('@ktx/connector-bigquery');
    if (isKtxBigQueryConnectionConfig(connection)) {
      return new KtxBigQueryScanConnector({ connectionId, connection });
    }
  }
  if (driver === 'snowflake') {
    const { KtxSnowflakeScanConnector, isKtxSnowflakeConnectionConfig } = await import('@ktx/connector-snowflake');
    if (isKtxSnowflakeConnectionConfig(connection)) {
      return new KtxSnowflakeScanConnector({ connectionId, connection });
    }
  }
  throw new Error(
    `Connection "${connectionId}" uses driver "${driver}", which has no native standalone KTX scan connector. Supported drivers: ${SUPPORTED_DRIVERS}.`,
  );
}
