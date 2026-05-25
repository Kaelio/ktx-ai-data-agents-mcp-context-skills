import { describe, expect, it, vi } from 'vitest';
import { HistoricSqlGrantsMissingError } from '../../../../src/context/ingest/adapters/historic-sql/errors.js';
import { SnowflakeAccountUsageProbeRunner } from '../../../../src/context/ingest/historic-sql-probes/snowflake-runner.js';

describe('SnowflakeAccountUsageProbeRunner', () => {
  it('runs the account usage reader and cleans up the client', async () => {
    const cleanup = vi.fn(async () => undefined);
    const reader = {
      probe: vi.fn(async () => ({ warnings: [], info: ['query history available'] })),
    };
    const runner = new SnowflakeAccountUsageProbeRunner({
      reader,
      createClient: () => ({ client: { executeQuery: vi.fn() }, cleanup }),
    });

    await expect(
      runner.run({
        projectDir: '/work/project',
        connectionId: 'warehouse',
        connection: {
          driver: 'snowflake',
          account: 'ACCT',
          warehouse: 'WH',
          database: 'ANALYTICS',
          username: 'reader',
        },
        env: {},
      }),
    ).resolves.toEqual({ warnings: [], info: ['query history available'] });
    expect(reader.probe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects non-Snowflake connections', async () => {
    const runner = new SnowflakeAccountUsageProbeRunner({
      reader: { probe: vi.fn() },
      createClient: () => ({ client: {}, cleanup: vi.fn() }),
    });

    await expect(
      runner.run({
        projectDir: '/work/project',
        connectionId: 'warehouse',
        connection: { driver: 'postgres' },
        env: {},
      }),
    ).rejects.toThrow('Native Snowflake connector cannot run driver "postgres"');
  });

  it('formats successful Snowflake details', () => {
    const runner = new SnowflakeAccountUsageProbeRunner();

    expect(
      runner.formatSuccessDetail({
        warnings: ['query history is delayed'],
        info: ['warehouse: WH'],
      }),
    ).toEqual({
      detail: 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY ready; warehouse: WH',
      warnings: ['query history is delayed'],
    });
  });

  it('maps Snowflake grant errors to runner advice', () => {
    const runner = new SnowflakeAccountUsageProbeRunner();

    expect(
      runner.fixAdvice(
        new HistoricSqlGrantsMissingError({
          dialect: 'snowflake',
          message: 'role cannot read account usage',
          remediation:
            'GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <connection role>;',
        }),
      ),
    ).toEqual({
      failHeadline: 'Snowflake role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
      remediation:
        'GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <connection role>;',
    });
  });
});
