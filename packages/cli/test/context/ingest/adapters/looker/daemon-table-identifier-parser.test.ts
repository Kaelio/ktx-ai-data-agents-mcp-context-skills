import { describe, expect, it, vi } from 'vitest';
import { createDaemonLookerTableIdentifierParser } from '../../../../../src/context/ingest/adapters/looker/daemon-table-identifier-parser.js';

describe('createDaemonLookerTableIdentifierParser', () => {
  it('posts parse items to the daemon endpoint', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          ok: true,
          catalog: null,
          schema: 'public',
          name: 'orders',
          canonical_table: 'public.orders',
        },
      },
    }));
    const parser = createDaemonLookerTableIdentifierParser({
      baseUrl: 'http://127.0.0.1:8765',
      requestJson,
    });

    await expect(parser.parse([{ key: 'orders', sql_table_name: 'public.orders', dialect: 'postgres' }])).resolves.toEqual({
      orders: {
        ok: true,
        catalog: null,
        schema: 'public',
        name: 'orders',
        canonical_table: 'public.orders',
      },
    });
    expect(requestJson).toHaveBeenCalledWith('/sql/parse-table-identifier', {
      items: [{ key: 'orders', sql_table_name: 'public.orders', dialect: 'postgres' }],
    });
  });

  it('rejects non-object daemon responses', async () => {
    const parser = createDaemonLookerTableIdentifierParser({
      baseUrl: 'http://127.0.0.1:8765',
      requestJson: async () => ({ results: null }),
    });

    await expect(parser.parse([])).rejects.toThrow('ktx-daemon table identifier parser returned invalid results');
  });
});
