import { describe, expect, it, vi } from 'vitest';
import { createPostgresQueryExecutor } from '../../../src/context/connections/postgres-query-executor.js';

function makeClient() {
  const calls: unknown[] = [];
  const client = {
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (input: unknown) => {
      calls.push(input);
      if (input === 'BEGIN READ ONLY') {
        return { rows: [], fields: [], rowCount: null, command: 'BEGIN' };
      }
      if (input === 'COMMIT') {
        return { rows: [], fields: [], rowCount: null, command: 'COMMIT' };
      }
      return {
        rows: [
          ['paid', 2],
          ['open', 1],
        ],
        fields: [{ name: 'status' }, { name: 'order_count' }],
        rowCount: 2,
        command: 'SELECT',
      };
    }),
    end: vi.fn(async () => undefined),
  };
  return { client, calls };
}

describe('createPostgresQueryExecutor', () => {
  it('runs a read-only transaction in array row mode and closes the client', async () => {
    const { client, calls } = makeClient();
    const executor = createPostgresQueryExecutor({
      clientFactory: vi.fn(() => client),
    });

    const result = await executor.execute({
      connectionId: 'warehouse',
      connection: { driver: 'postgres', url: 'postgres://example/db' },
      sql: 'select status, count(*) as order_count from public.orders group by status',
      maxRows: 50,
    });

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls[1]).toEqual({
      text: 'select * from (select status, count(*) as order_count from public.orders group by status) as ktx_query_result limit 50',
      rowMode: 'array',
    });
    expect(calls[2]).toBe('COMMIT');
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      headers: ['status', 'order_count'],
      rows: [
        ['paid', 2],
        ['open', 1],
      ],
      totalRows: 2,
      command: 'SELECT',
      rowCount: 2,
    });
  });

  it('rolls back and closes the client when query execution fails', async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      query: vi.fn(async (input: unknown) => {
        if (input === 'BEGIN READ ONLY' || input === 'ROLLBACK') {
          return { rows: [], fields: [], rowCount: null, command: String(input) };
        }
        throw new Error('syntax error');
      }),
      end: vi.fn(async () => undefined),
    };
    const executor = createPostgresQueryExecutor({
      clientFactory: vi.fn(() => client),
    });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'postgres', url: 'postgres://example/db' },
        sql: 'select * from broken',
        maxRows: 10,
      }),
    ).rejects.toThrow('syntax error');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('requires a Postgres url', async () => {
    const executor = createPostgresQueryExecutor({ clientFactory: vi.fn() });

    await expect(
      executor.execute({
        connectionId: 'warehouse',
        connection: { driver: 'postgres' },
        sql: 'select 1',
      }),
    ).rejects.toThrow('Local Postgres execution requires connections.warehouse.url');
  });
});
