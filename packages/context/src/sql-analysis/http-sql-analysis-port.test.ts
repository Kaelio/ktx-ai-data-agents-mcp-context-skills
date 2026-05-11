import { describe, expect, it, vi } from 'vitest';
import { createHttpSqlAnalysisPort } from './http-sql-analysis-port.js';

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
