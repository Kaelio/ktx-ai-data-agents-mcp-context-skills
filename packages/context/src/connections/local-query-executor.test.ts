import { describe, expect, it, vi } from 'vitest';
import { createDefaultLocalQueryExecutor } from './local-query-executor.js';

describe('createDefaultLocalQueryExecutor', () => {
  it('dispatches postgres and sqlite drivers to their executors', async () => {
    const postgres = {
      execute: vi.fn(async () => ({
        headers: ['pg'],
        rows: [[1]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };
    const sqlite = {
      execute: vi.fn(async () => ({
        headers: ['sqlite'],
        rows: [[2]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };
    const executor = createDefaultLocalQueryExecutor({ postgres, sqlite });

    await expect(
      executor.execute({
        connectionId: 'pg',
        connection: { driver: 'postgres' },
        sql: 'select 1',
      }),
    ).resolves.toMatchObject({ headers: ['pg'] });
    await expect(
      executor.execute({
        connectionId: 'local',
        connection: { driver: 'sqlite' },
        sql: 'select 1',
      }),
    ).resolves.toMatchObject({ headers: ['sqlite'] });

    expect(postgres.execute).toHaveBeenCalledTimes(1);
    expect(sqlite.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported local execution drivers', async () => {
    const executor = createDefaultLocalQueryExecutor({
      postgres: { execute: vi.fn() },
      sqlite: { execute: vi.fn() },
    });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'snowflake' },
        sql: 'select 1',
      }),
    ).rejects.toThrow('No local query executor is configured for driver "snowflake".');
  });
});
