import { describe, expect, it, vi } from 'vitest';
import {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
  HistoricSqlVersionUnsupportedError,
} from '../adapters/historic-sql/errors.js';
import { PostgresPgssProbeRunner } from './postgres-runner.js';

describe('PostgresPgssProbeRunner', () => {
  it('runs the pg_stat_statements reader and cleans up the client', async () => {
    const cleanup = vi.fn(async () => undefined);
    const reader = {
      probe: vi.fn(async () => ({
        pgServerVersion: 'PostgreSQL 16.4',
        warnings: [],
        info: ['tracked statements: 12'],
      })),
    };
    const runner = new PostgresPgssProbeRunner({
      reader,
      createClient: () => ({ client: { executeQuery: vi.fn() }, cleanup }),
    });

    await expect(
      runner.run({
        projectDir: '/work/project',
        connectionId: 'warehouse',
        connection: { driver: 'postgres', url: 'env:DATABASE_URL' },
        env: {},
      }),
    ).resolves.toEqual({
      pgServerVersion: 'PostgreSQL 16.4',
      warnings: [],
      info: ['tracked statements: 12'],
    });
    expect(reader.probe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects non-Postgres connections', async () => {
    const runner = new PostgresPgssProbeRunner({
      reader: { probe: vi.fn() },
      createClient: () => ({ client: {}, cleanup: vi.fn() }),
    });

    await expect(
      runner.run({
        projectDir: '/work/project',
        connectionId: 'warehouse',
        connection: { driver: 'snowflake' },
        env: {},
      }),
    ).rejects.toThrow('Native PostgreSQL connector cannot run driver "snowflake"');
  });

  it('formats successful Postgres details', () => {
    const runner = new PostgresPgssProbeRunner();

    expect(
      runner.formatSuccessDetail({
        pgServerVersion: 'PostgreSQL 16.4',
        warnings: ['pg_stat_statements.track is top'],
        info: ['tracked statements: 12'],
      }),
    ).toEqual({
      detail: 'pg_stat_statements ready (PostgreSQL 16.4); tracked statements: 12',
      warnings: ['pg_stat_statements.track is top'],
    });
  });

  it('maps Postgres probe errors to actionable advice', () => {
    const runner = new PostgresPgssProbeRunner();

    expect(
      runner.fixAdvice(
        new HistoricSqlExtensionMissingError({
          dialect: 'postgres',
          message: 'pg_stat_statements missing',
          remediation: 'CREATE EXTENSION pg_stat_statements;',
        }),
      ),
    ).toEqual({
      failHeadline: 'pg_stat_statements extension is missing',
      remediation: 'CREATE EXTENSION pg_stat_statements;',
    });

    expect(
      runner.fixAdvice(
        new HistoricSqlGrantsMissingError({
          dialect: 'postgres',
          message: 'missing grants',
          remediation: 'GRANT pg_read_all_stats TO <connection role>;',
        }),
      ),
    ).toEqual({
      failHeadline: 'Postgres connection role lacks pg_read_all_stats',
      remediation: 'GRANT pg_read_all_stats TO <connection role>;',
    });

    expect(
      runner.fixAdvice(
        new HistoricSqlVersionUnsupportedError({
          dialect: 'postgres',
          detectedVersion: 'PostgreSQL 13.12',
          minimumVersion: 'PostgreSQL 14',
        }),
      ),
    ).toEqual({
      failHeadline: 'Postgres version too old',
      remediation: 'Use PostgreSQL 14 or newer, or disable query history for this connection',
    });
  });
});
