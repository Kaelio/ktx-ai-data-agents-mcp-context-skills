import { buildDefaultKtxProjectConfig, type KtxProjectConnectionConfig } from '@ktx/context/project';
import { HistoricSqlExtensionMissingError } from '@ktx/context/ingest';
import { describe, expect, it, vi } from 'vitest';
import {
  runPostgresHistoricSqlDoctorChecks,
  type HistoricSqlDoctorProject,
  type PostgresHistoricSqlDoctorProbe,
} from './historic-sql-doctor.js';

function projectWithConnections(connections: Record<string, KtxProjectConnectionConfig>): HistoricSqlDoctorProject {
  return {
    projectDir: '/tmp/ktx-project',
    config: {
      ...buildDefaultKtxProjectConfig('warehouse'),
      connections,
      ingest: {
        ...buildDefaultKtxProjectConfig('warehouse').ingest,
        adapters: ['live-database', 'historic-sql'],
      },
    },
  };
}

describe('runPostgresHistoricSqlDoctorChecks', () => {
  it('passes when no Postgres historic-SQL connections are enabled', async () => {
    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: { driver: 'sqlite', path: './warehouse.db', readonly: true },
      }),
      {
        postgresHistoricSqlProbe: vi.fn<PostgresHistoricSqlDoctorProbe>(),
      },
    );

    expect(checks).toEqual([
      {
        id: 'historic-sql-postgres',
        label: 'Postgres Historic SQL',
        status: 'pass',
        detail: 'No enabled Postgres historic-SQL connections',
      },
    ]);
  });

  it('passes when the PGSS probe succeeds without warnings', async () => {
    const probe = vi.fn<PostgresHistoricSqlDoctorProbe>(async () => ({
      pgServerVersion: 'PostgreSQL 16.4',
      warnings: [],
    }));

    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          historicSql: { enabled: true, dialect: 'postgres' },
        },
      }),
      { postgresHistoricSqlProbe: probe },
    );

    expect(probe).toHaveBeenCalledWith({
      projectDir: '/tmp/ktx-project',
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres',
        url: 'env:WAREHOUSE_DATABASE_URL',
        readonly: true,
        historicSql: { enabled: true, dialect: 'postgres' },
      },
      env: process.env,
    });
    expect(checks).toEqual([
      {
        id: 'historic-sql-postgres-warehouse',
        label: 'Postgres Historic SQL (warehouse)',
        status: 'pass',
        detail: 'pg_stat_statements ready (PostgreSQL 16.4)',
      },
    ]);
  });

  it('passes with an informational note when only pg_stat_statements.max is below the recommended floor', async () => {
    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          historicSql: { enabled: true, dialect: 'postgres' },
        },
      }),
      {
        postgresHistoricSqlProbe: async () => ({
          pgServerVersion: 'PostgreSQL 16.4',
          warnings: [],
          info: [
            'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
          ],
        }),
      },
    );

    expect(checks).toEqual([
      {
        id: 'historic-sql-postgres-warehouse',
        label: 'Postgres Historic SQL (warehouse)',
        status: 'pass',
        detail:
          'pg_stat_statements ready (PostgreSQL 16.4); info: pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
      },
    ]);
  });

  it('warns when pg_stat_statements tracking is disabled', async () => {
    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          historicSql: { enabled: true, dialect: 'postgres' },
        },
      }),
      {
        postgresHistoricSqlProbe: async () => ({
          pgServerVersion: 'PostgreSQL 16.4',
          warnings: [
            'pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config',
          ],
          info: [
            'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
          ],
        }),
      },
    );

    expect(checks).toEqual([
      {
        id: 'historic-sql-postgres-warehouse',
        label: 'Postgres Historic SQL (warehouse)',
        status: 'warn',
        detail:
          'pg_stat_statements ready (PostgreSQL 16.4) with warnings: pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config; info: pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
        fix: 'Update the Postgres parameter group or config, then rerun `ktx dev doctor --project-dir /tmp/ktx-project`',
      },
    ]);
  });

  it('fails when a connection has postgres historic SQL but is not a Postgres driver', async () => {
    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: {
          driver: 'mysql',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          historicSql: { enabled: true, dialect: 'postgres' },
        },
      }),
      {
        postgresHistoricSqlProbe: vi.fn<PostgresHistoricSqlDoctorProbe>(),
      },
    );

    expect(checks).toEqual([
      {
        id: 'historic-sql-postgres-warehouse',
        label: 'Postgres Historic SQL (warehouse)',
        status: 'fail',
        detail: 'connections.warehouse.historicSql.dialect is postgres but driver is mysql',
        fix: 'Set connections.warehouse.driver to postgres or disable historicSql for this connection',
      },
    ]);
  });

  it('maps PGSS capability errors to actionable failures', async () => {
    const checks = await runPostgresHistoricSqlDoctorChecks(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'env:WAREHOUSE_DATABASE_URL',
          readonly: true,
          historicSql: { enabled: true, dialect: 'postgres' },
        },
      }),
      {
        postgresHistoricSqlProbe: async () => {
          throw new HistoricSqlExtensionMissingError({
            dialect: 'postgres',
            message: 'pg_stat_statements extension is not installed in the connection database.',
            remediation: 'Run CREATE EXTENSION pg_stat_statements; against the connection database.',
          });
        },
      },
    );

    expect(checks).toEqual([
      {
        id: 'historic-sql-postgres-warehouse',
        label: 'Postgres Historic SQL (warehouse)',
        status: 'fail',
        detail: 'pg_stat_statements extension is not installed in the connection database.',
        fix: 'Run CREATE EXTENSION pg_stat_statements; against the connection database.',
      },
    ]);
  });
});
