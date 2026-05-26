import { describe, expect, it, vi } from 'vitest';
import {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
  HistoricSqlVersionUnsupportedError,
} from '../../../../../src/context/ingest/adapters/historic-sql/errors.js';
import { PostgresPgssReader } from '../../../../../src/context/ingest/adapters/historic-sql/postgres-pgss-reader.js';

interface FakeQueryResult {
  headers: string[];
  rows: unknown[][];
  totalRows?: number;
  error?: string;
}

function queryClient(results: Array<FakeQueryResult | Error>) {
  const executeQuery = vi.fn(async (_query: string, _params?: unknown[]) => {
    const next = results.shift();
    if (!next) {
      throw new Error('unexpected query');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { executeQuery };
}

function executedSql(client: ReturnType<typeof queryClient>, index: number): string {
  const call = client.executeQuery.mock.calls[index];
  if (!call) {
    throw new Error(`expected query client call ${index}`);
  }
  return call[0];
}

describe('PostgresPgssReader aggregate path', () => {
  it('probes version, extension presence, grants, and tracking state', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[160004, 'PostgreSQL 16.4 on x86_64-apple-darwin']],
      },
      { headers: ['?column?'], rows: [[1]] },
      { headers: ['has_role'], rows: [[true]] },
      { headers: ['track'], rows: [['top']] },
      { headers: ['max'], rows: [['5000']] },
    ]);
    const reader = new PostgresPgssReader();

    await expect(reader.probe(client)).resolves.toEqual({
      pgServerVersion: 'PostgreSQL 16.4 on x86_64-apple-darwin',
      warnings: [],
      info: [],
    });

    expect(executedSql(client, 0)).toContain("current_setting('server_version_num')::int");
    expect(executedSql(client, 1)).toBe('SELECT 1 FROM pg_stat_statements LIMIT 1');
    expect(executedSql(client, 2)).toBe(
      "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS has_role",
    );
    expect(executedSql(client, 3)).toBe("SELECT current_setting('pg_stat_statements.track') AS track");
    expect(executedSql(client, 4)).toBe("SELECT current_setting('pg_stat_statements.max') AS max");
  });

  it('rejects PostgreSQL versions older than 14 without probing the extension', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[130012, 'PostgreSQL 13.12']],
      },
    ]);
    const reader = new PostgresPgssReader();

    const promise = reader.probe(client);
    await expect(promise).rejects.toMatchObject({
      name: 'HistoricSqlVersionUnsupportedError',
      dialect: 'postgres',
      detectedVersion: 'PostgreSQL 13.12',
      minimumVersion: 'PostgreSQL 14',
    });
    await expect(promise).rejects.toBeInstanceOf(HistoricSqlVersionUnsupportedError);
    expect(client.executeQuery).toHaveBeenCalledTimes(1);
  });

  it('maps a missing pg_stat_statements relation to HistoricSqlExtensionMissingError', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[160004, 'PostgreSQL 16.4']],
      },
      new Error('relation "pg_stat_statements" does not exist'),
    ]);
    const reader = new PostgresPgssReader();

    const promise = reader.probe(client);
    await expect(promise).rejects.toMatchObject({
      name: 'HistoricSqlExtensionMissingError',
      dialect: 'postgres',
    });
    await expect(promise).rejects.toBeInstanceOf(HistoricSqlExtensionMissingError);
  });

  it('maps pg_stat_statements preload failures to HistoricSqlExtensionMissingError with preload remediation', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[160004, 'PostgreSQL 16.4']],
      },
      new Error('pg_stat_statements must be loaded via shared_preload_libraries'),
    ]);
    const reader = new PostgresPgssReader();

    const promise = reader.probe(client);
    await expect(promise).rejects.toMatchObject({
      name: 'HistoricSqlExtensionMissingError',
      dialect: 'postgres',
      message: 'pg_stat_statements is installed but not loaded via shared_preload_libraries.',
      remediation: expect.stringContaining("shared_preload_libraries includes 'pg_stat_statements'"),
    });
    await expect(promise).rejects.toBeInstanceOf(HistoricSqlExtensionMissingError);
  });

  it('maps missing pg_read_all_stats membership to HistoricSqlGrantsMissingError', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[160004, 'PostgreSQL 16.4']],
      },
      { headers: ['?column?'], rows: [[1]] },
      { headers: ['has_role'], rows: [[false]] },
    ]);
    const reader = new PostgresPgssReader();

    const promise = reader.probe(client);
    await expect(promise).rejects.toMatchObject({
      name: 'HistoricSqlGrantsMissingError',
      dialect: 'postgres',
      remediation: 'GRANT pg_read_all_stats TO <connection role>;',
    });
    await expect(promise).rejects.toBeInstanceOf(HistoricSqlGrantsMissingError);
  });

  it('returns a warning instead of failing when pg_stat_statements.track is none', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[160004, 'PostgreSQL 16.4']],
      },
      { headers: ['?column?'], rows: [[1]] },
      { headers: ['has_role'], rows: [[true]] },
      { headers: ['track'], rows: [['none']] },
      { headers: ['max'], rows: [['5000']] },
    ]);
    const reader = new PostgresPgssReader();

    await expect(reader.probe(client)).resolves.toEqual({
      pgServerVersion: 'PostgreSQL 16.4',
      warnings: [
        "pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config",
      ],
      info: [],
    });
  });

  it('returns an info note when pg_stat_statements.max is below the recommended floor', async () => {
    const client = queryClient([
      {
        headers: ['server_version_num', 'server_version'],
        rows: [[160004, 'PostgreSQL 16.4']],
      },
      { headers: ['?column?'], rows: [[1]] },
      { headers: ['has_role'], rows: [[true]] },
      { headers: ['track'], rows: [['top']] },
      { headers: ['max'], rows: [['1000']] },
    ]);
    const reader = new PostgresPgssReader();

    await expect(reader.probe(client)).resolves.toEqual({
      pgServerVersion: 'PostgreSQL 16.4',
      warnings: [],
      info: [
        'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
      ],
    });
  });

  it('aggregates pg_stat_statements rows by queryid and query', async () => {
    const executeQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_stat_statements_info')) {
        return { headers: ['stats_reset', 'dealloc'], rows: [['2026-05-01T00:00:00.000Z', 1]] };
      }
      expect(sql).toContain('GROUP BY queryid, query');
      expect(sql).toContain('HAVING SUM(calls) >= $1');
      expect(params).toEqual([5]);
      return {
        headers: ['template_id', 'canonical_sql', 'executions', 'distinct_users', 'mean_ms', 'rows_produced', 'top_users'],
        rows: [
          [
            '123',
            'select status from public.orders',
            '42',
            '3',
            '11.5',
            '100',
            JSON.stringify([{ user: 'analyst', executions: 40 }]),
          ],
        ],
      };
    });

    const reader = new PostgresPgssReader();
    const rows = [];
    for await (const row of reader.fetchAggregated(
      { executeQuery },
      { start: new Date('2026-02-10T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') },
      { dialect: 'postgres', minExecutions: 5, enabledTables: [], filters: { dropTrivialProbes: true }, redactionPatterns: [], staleArchiveAfterDays: 90 },
    )) {
      rows.push(row);
    }

    expect(rows).toEqual([
      {
        templateId: '123',
        canonicalSql: 'select status from public.orders',
        dialect: 'postgres',
        stats: {
          executions: 42,
          distinctUsers: 3,
          firstSeen: '2026-05-01T00:00:00.000Z',
          lastSeen: '2026-05-11T00:00:00.000Z',
          p50RuntimeMs: 11.5,
          p95RuntimeMs: 11.5,
          errorRate: 0,
          rowsProduced: 100,
        },
        topUsers: [{ user: 'analyst', executions: 40 }],
      },
    ]);
  });
});
