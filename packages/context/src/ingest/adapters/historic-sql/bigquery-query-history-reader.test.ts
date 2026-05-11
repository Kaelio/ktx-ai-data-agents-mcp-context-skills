import { describe, expect, it, vi } from 'vitest';
import { BigQueryHistoricSqlQueryHistoryReader } from './bigquery-query-history-reader.js';
import { HistoricSqlGrantsMissingError } from './errors.js';

interface FakeQueryResult {
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  error?: string;
}

function queryClient(results: FakeQueryResult[]) {
  const executeQuery = vi.fn(async (_query: string) => {
    const next = results.shift();
    if (!next) {
      throw new Error('unexpected query');
    }
    return next;
  });
  return { executeQuery };
}

function firstQuery(client: ReturnType<typeof queryClient>): string {
  const call = client.executeQuery.mock.calls[0];
  if (!call) {
    throw new Error('expected query client to be called');
  }
  return call[0];
}

describe('BigQueryHistoricSqlQueryHistoryReader', () => {
  it('probes region-qualified INFORMATION_SCHEMA.JOBS_BY_PROJECT', async () => {
    const client = queryClient([{ headers: ['1'], rows: [[1]], totalRows: 1 }]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

    await expect(reader.probe(client)).resolves.toEqual({ warnings: [], info: [] });

    expect(client.executeQuery).toHaveBeenCalledWith(
      'SELECT 1 FROM `project-1.region-us.INFORMATION_SCHEMA.JOBS_BY_PROJECT` LIMIT 1',
    );
  });

  it('turns probe result errors into HistoricSqlGrantsMissingError', async () => {
    const client = queryClient([{ headers: [], rows: [], totalRows: 0, error: 'Access Denied: jobs.listAll' }]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'us-central1' });

    await expect(reader.probe(client)).rejects.toMatchObject({
      name: 'HistoricSqlGrantsMissingError',
      dialect: 'bigquery',
      remediation:
        'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.',
    });
  });

  it('turns thrown probe failures into HistoricSqlGrantsMissingError', async () => {
    const client = {
      executeQuery: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

    await expect(reader.probe(client)).rejects.toBeInstanceOf(HistoricSqlGrantsMissingError);
  });

  it('fetches aggregated BigQuery query templates', async () => {
    const client = queryClient([
      {
        headers: [
          'template_id',
          'canonical_sql',
          'executions',
          'distinct_users',
          'first_seen',
          'last_seen',
          'p50_ms',
          'p95_ms',
          'error_rate',
          'rows_produced',
          'top_users',
        ],
        rows: [
          [
            'hash-1',
            'select status from orders',
            42,
            3,
            '2026-05-01T00:00:00.000Z',
            '2026-05-11T00:00:00.000Z',
            12,
            40,
            0.05,
            null,
            JSON.stringify([{ user: 'analyst@example.test', executions: 1 }]),
          ],
        ],
        totalRows: 1,
      },
    ]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'demo', region: 'us' });

    const rows = [];
    for await (const row of reader.fetchAggregated(
      client,
      { start: new Date('2026-02-10T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') },
      { dialect: 'bigquery', minExecutions: 5, windowDays: 90, concurrency: 12, filters: { dropTrivialProbes: true }, redactionPatterns: [], staleArchiveAfterDays: 90 },
    )) {
      rows.push(row);
    }

    const sql = firstQuery(client);
    expect(sql).toContain('COUNT(*) AS executions');
    expect(sql).toContain('COUNT(DISTINCT user_email) AS distinct_users');
    expect(sql).toContain('GROUP BY query_hash');
    expect(sql).toContain('HAVING COUNT(*) >= 5');
    expect(rows).toMatchObject([
      {
        templateId: 'hash-1',
        stats: {
          executions: 42,
          errorRate: 0.05,
        },
        topUsers: [{ user: 'analyst@example.test', executions: 1 }],
      },
    ]);
  });

  it('throws a clear error when the query client cannot execute SQL', async () => {
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

    await expect(async () => {
      for await (const _row of reader.fetchAggregated(
        {},
        { start: new Date(), end: new Date() },
        {
          dialect: 'bigquery',
          minExecutions: 5,
          windowDays: 90,
          concurrency: 12,
          filters: { dropTrivialProbes: true },
          redactionPatterns: [],
          staleArchiveAfterDays: 90,
        },
      )) {
        throw new Error('unreachable');
      }
    }).rejects.toThrow('Historic SQL BigQuery reader requires a query client with executeQuery(query)');
  });

  it('rejects unsafe project and region identifiers before building SQL', () => {
    expect(() => new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project`1', region: 'US' })).toThrow(
      'Invalid BigQuery project id for historic-SQL ingest: project`1',
    );
    expect(() => new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US;DROP' })).toThrow(
      'Invalid BigQuery region for historic-SQL ingest: US;DROP',
    );
  });
});
