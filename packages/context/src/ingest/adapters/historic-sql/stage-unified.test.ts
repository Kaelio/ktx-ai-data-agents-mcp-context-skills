import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import { stageHistoricSqlAggregatedSnapshot } from './stage-unified.js';
import type { AggregatedTemplate, HistoricSqlReader } from './types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-unified-stage-'));
}

async function readJson<T>(root: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relPath), 'utf-8')) as T;
}

function aggregate(overrides: Partial<AggregatedTemplate> & { templateId: string; canonicalSql: string }): AggregatedTemplate {
  return {
    templateId: overrides.templateId,
    canonicalSql: overrides.canonicalSql,
    dialect: overrides.dialect ?? 'postgres',
    stats: overrides.stats ?? {
      executions: 42,
      distinctUsers: 3,
      firstSeen: '2026-05-01T00:00:00.000Z',
      lastSeen: '2026-05-11T00:00:00.000Z',
      p50RuntimeMs: 20,
      p95RuntimeMs: 80,
      errorRate: 0,
      rowsProduced: 100,
    },
    topUsers: overrides.topUsers ?? [{ user: 'analyst', executions: 40 }],
  };
}

describe('stageHistoricSqlAggregatedSnapshot', () => {
  it('batch parses templates and writes stable table and patterns artifacts', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: ['pg_stat_statements.max is low; aggregation still proceeds'] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'orders-by-status',
          canonicalSql: 'select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id where o.created_at >= $1 group by o.status',
        });
        yield aggregate({
          templateId: 'service-account-only',
          canonicalSql: 'select * from public.orders where id = $1',
          stats: {
            executions: 20,
            distinctUsers: 1,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 5,
            p95RuntimeMs: 10,
            errorRate: 0,
            rowsProduced: 1,
          },
          topUsers: [{ user: 'svc_loader', executions: 20 }],
        });
        yield aggregate({
          templateId: 'bad-parse',
          canonicalSql: 'select broken from',
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'orders-by-status',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: ['status'],
              where: ['created_at'],
              join: ['customer_id'],
              groupBy: ['status'],
            },
          },
        ],
        ['bad-parse', { tablesTouched: [], columnsByClause: {}, error: 'parse failed' }],
      ])),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        filters: {
          serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
        },
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledTimes(1);
    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledWith(
      [
        {
          id: 'orders-by-status',
          sql: 'select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id where o.created_at >= $1 group by o.status',
        },
        { id: 'bad-parse', sql: 'select broken from' },
      ],
      'postgres',
    );

    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['public.customers.json', 'public.orders.json']);

    const manifest = await readJson<Record<string, unknown>>(stagedDir, 'manifest.json');
    expect(manifest).toMatchObject({
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      snapshotRowCount: 3,
      touchedTableCount: 2,
      parseFailures: 1,
      warnings: ['parse_failed:bad-parse'],
      probeWarnings: ['pg_stat_statements.max is low; aggregation still proceeds'],
    });

    const orders = await readJson<Record<string, any>>(stagedDir, 'tables/public.orders.json');
    expect(orders).toMatchObject({
      table: 'public.orders',
      stats: {
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        errorRateBucket: 'none',
        p95RuntimeBucket: '<100ms',
        recencyBucket: 'current',
      },
      columnsByClause: {
        select: [['status', 'high']],
        where: [['created_at', 'high']],
        join: [['customer_id', 'high']],
        groupBy: [['status', 'high']],
      },
      observedJoins: [{ withTable: 'public.customers', on: ['customer_id'], freq: 'high' }],
      topTemplates: [
        {
          id: 'orders-by-status',
          topUsers: [{ user: 'analyst' }],
        },
      ],
    });
    expect(orders.topTemplates[0].canonicalSql).toContain('group by o.status');

    const patterns = await readJson<Record<string, any>>(stagedDir, 'patterns-input.json');
    expect(patterns.templates).toEqual([
      {
        id: 'orders-by-status',
        canonicalSql: expect.stringContaining('public.orders'),
        tablesTouched: ['public.customers', 'public.orders'],
        executionsBucket: '10-100',
        distinctUsersBucket: '2-5',
        dialect: 'postgres',
      },
    ]);
  });
});
