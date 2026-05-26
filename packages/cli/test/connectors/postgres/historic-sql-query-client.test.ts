import { describe, expect, it, vi } from 'vitest';
import { KtxPostgresHistoricSqlQueryClient } from '../../../src/connectors/postgres/historic-sql-query-client.js';
import type { KtxPostgresPoolConfig, KtxPostgresPoolFactory } from '../../../src/connectors/postgres/connector.js';

describe('KtxPostgresHistoricSqlQueryClient', () => {
  it('executes parameterized read-only SQL through the native Postgres connector pool', async () => {
    const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const release = vi.fn();
    const end = vi.fn(async () => {});
    const poolFactory: KtxPostgresPoolFactory = {
      createPool(_config: KtxPostgresPoolConfig) {
        return {
          async connect() {
            return {
              async query(sql: string, params?: unknown[]) {
                queryCalls.push({ sql, params });
                return {
                  fields: [{ name: 'answer', dataTypeID: 23 }],
                  rows: [{ answer: 42 }],
                };
              },
              release,
            };
          },
          end,
        };
      },
    };
    const client = new KtxPostgresHistoricSqlQueryClient({
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres',
        url: 'postgresql://readonly:secret@pg.example.test/warehouse', // pragma: allowlist secret
      },
      poolFactory,
    });

    await expect(client.executeQuery('SELECT $1::int AS answer', [42])).resolves.toEqual({
      headers: ['answer'],
      rows: [[42]],
      totalRows: 1,
    });
    expect(queryCalls).toEqual([{ sql: 'SELECT $1::int AS answer', params: [42] }]);

    await client.cleanup();
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
