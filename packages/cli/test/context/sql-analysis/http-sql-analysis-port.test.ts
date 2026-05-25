import { describe, expect, it, vi } from 'vitest';
import { createHttpSqlAnalysisPort } from '../../../src/context/sql-analysis/http-sql-analysis-port.js';

describe('createHttpSqlAnalysisPort', () => {
  it('calls the SQL-analysis fingerprint endpoint and maps snake_case response fields', async () => {
    const requestJson = vi.fn(async () => ({
      fingerprint: 'fingerprint-template',
      normalized_sql: 'SELECT * FROM analytics.orders WHERE status = ?',
      tables_touched: ['analytics.orders'],
      literal_slots: [{ position: 1, type: 'string', example_value: 'paid' }],
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(
      port.analyzeForFingerprint("SELECT * FROM analytics.orders WHERE status = 'paid'", 'postgres'),
    ).resolves.toEqual({
      fingerprint: 'fingerprint-template',
      normalizedSql: 'SELECT * FROM analytics.orders WHERE status = ?',
      tablesTouched: ['analytics.orders'],
      literalSlots: [{ position: 1, type: 'string', exampleValue: 'paid' }],
    });

    expect(requestJson).toHaveBeenCalledWith('/api/sql/analyze-for-fingerprint', {
      sql: "SELECT * FROM analytics.orders WHERE status = 'paid'",
      dialect: 'postgres',
    });
  });

  it('preserves SQL-analysis parse errors in the mapped result', async () => {
    const requestJson = vi.fn(async () => ({
      fingerprint: '',
      normalized_sql: '',
      tables_touched: [],
      literal_slots: [],
      error: 'Invalid expression / Unexpected token',
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(port.analyzeForFingerprint('SELECT * FROM WHERE', 'postgres')).resolves.toEqual({
      fingerprint: '',
      normalizedSql: '',
      tablesTouched: [],
      literalSlots: [],
      error: 'Invalid expression / Unexpected token',
    });
  });

  it('calls the SQL batch endpoint and maps snake_case response fields into a Map', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: ['public.orders', 'public.customers'],
          columns_by_clause: {
            select: ['status'],
            where: ['created_at'],
            join: ['customer_id', 'id'],
          },
          error: null,
        },
        broken: {
          tables_touched: [],
          columns_by_clause: {},
          error: 'Invalid expression / Unexpected token',
        },
      },
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(
      port.analyzeBatch(
        [
          { id: 'orders', sql: 'select status from public.orders' },
          { id: 'broken', sql: 'select * from where' },
        ],
        'postgres',
      ),
    ).resolves.toEqual(
      new Map([
        [
          'orders',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: ['status'],
              where: ['created_at'],
              join: ['customer_id', 'id'],
            },
            error: null,
          },
        ],
        [
          'broken',
          {
            tablesTouched: [],
            columnsByClause: {},
            error: 'Invalid expression / Unexpected token',
          },
        ],
      ]),
    );

    expect(requestJson).toHaveBeenCalledWith('/sql/analyze-batch', {
      dialect: 'postgres',
      items: [
        { id: 'orders', sql: 'select status from public.orders' },
        { id: 'broken', sql: 'select * from where' },
      ],
    });
  });

  it('maps read-only SQL validation responses', async () => {
    const requests: Array<{ path: string; payload: Record<string, unknown> }> = [];
    const port = createHttpSqlAnalysisPort({
      baseUrl: 'http://127.0.0.1:8765',
      requestJson: async (path, payload) => {
        requests.push({ path, payload });
        return { ok: false, error: 'SQL contains read/write operation: Insert' };
      },
    });

    await expect(
      port.validateReadOnly('with x as (insert into t values (1)) select * from x', 'postgres'),
    ).resolves.toEqual({
      ok: false,
      error: 'SQL contains read/write operation: Insert',
    });
    expect(requests).toEqual([
      {
        path: '/sql/validate-read-only',
        payload: {
          dialect: 'postgres',
          sql: 'with x as (insert into t values (1)) select * from x',
        },
      },
    ]);
  });

  it('rejects malformed read-only validation responses', async () => {
    const port = createHttpSqlAnalysisPort({
      baseUrl: 'http://127.0.0.1:8765',
      requestJson: async () => ({ ok: 'yes' }),
    });

    await expect(port.validateReadOnly('select 1', 'postgres')).rejects.toThrow(
      'sql analysis response is missing boolean field ok',
    );
  });

  it('rejects malformed SQL batch responses instead of inventing defaults', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: ['public.orders'],
          columns_by_clause: { select: ['status'], where: [42] },
          error: null,
        },
      },
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(port.analyzeBatch([{ id: 'orders', sql: 'select status from public.orders' }], 'postgres')).rejects
      .toThrow('sql analysis response is missing string[] field columns_by_clause.where');
  });

  it('rejects malformed daemon responses instead of inventing defaults', async () => {
    const requestJson = vi.fn(async () => ({
      fingerprint: 'abc',
      normalized_sql: 'SELECT ?',
      tables_touched: 'orders',
      literal_slots: [],
    }));
    const port = createHttpSqlAnalysisPort({ baseUrl: 'http://python.test', requestJson });

    await expect(port.analyzeForFingerprint('SELECT 1', 'postgres')).rejects.toThrow(
      'sql analysis response is missing string[] field tables_touched',
    );
  });
});
