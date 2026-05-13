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
        return { warnings: ['pg_stat_statements.track is none; aggregation still proceeds'], info: [] };
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
      probeWarnings: ['pg_stat_statements.track is none; aggregation still proceeds'],
      staleArchiveAfterDays: 90,
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

  it('redacts configured SQL substrings in staged artifacts while analyzing original SQL', async () => {
    const stagedDir = await tempDir();
    const originalSql =
      "select * from public.api_events where api_key = 'sk_live_abc123' and note = 'Secret_Token_9f'"; // pragma: allowlist secret
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'api-events-with-secret',
          canonicalSql: originalSql,
          stats: {
            executions: 15,
            distinctUsers: 2,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 12,
            p95RuntimeMs: 25,
            errorRate: 0,
            rowsProduced: 15,
          },
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'api-events-with-secret',
          {
            tablesTouched: ['public.api_events'],
            columnsByClause: {
              select: [],
              where: ['api_key', 'note'],
              join: [],
              groupBy: [],
            },
          },
        ],
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
        redactionPatterns: ['sk_live_[A-Za-z0-9]+', '(?i)secret_token_[a-z0-9]+'],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledWith(
      [{ id: 'api-events-with-secret', sql: originalSql }],
      'postgres',
    );

    const tableJson = await readFile(join(stagedDir, 'tables/public.api_events.json'), 'utf-8');
    const patternsJson = await readFile(join(stagedDir, 'patterns-input.json'), 'utf-8');
    expect(tableJson).not.toContain('sk_live_abc123');
    expect(tableJson).not.toContain('Secret_Token_9f');
    expect(patternsJson).not.toContain('sk_live_abc123');
    expect(patternsJson).not.toContain('Secret_Token_9f');
    expect(tableJson).toContain('[REDACTED]');
    expect(patternsJson).toContain('[REDACTED]');
  });

  it('limits staged table artifacts to configured enabled tables', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'selected-qualified',
          canonicalSql: 'select count(*) from orbit_analytics.int_active_contract_arr',
        });
        yield aggregate({
          templateId: 'selected-unqualified',
          canonicalSql: 'select count(*) from int_customer_health_signals',
        });
        yield aggregate({
          templateId: 'unselected',
          canonicalSql: 'select count(*) from orbit_raw.accounts',
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'selected-qualified',
          {
            tablesTouched: ['orbit_analytics.int_active_contract_arr'],
            columnsByClause: { select: [], where: [], join: [], groupBy: [] },
          },
        ],
        [
          'selected-unqualified',
          {
            tablesTouched: ['int_customer_health_signals'],
            columnsByClause: { select: [], where: [], join: [], groupBy: [] },
          },
        ],
        [
          'unselected',
          {
            tablesTouched: ['orbit_raw.accounts'],
            columnsByClause: { select: [], where: [], join: [], groupBy: [] },
          },
        ],
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
        enabledTables: [
          'orbit_analytics.int_active_contract_arr',
          'orbit_analytics.int_customer_health_signals',
        ],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'tables'))).toEqual([
      'int_customer_health_signals.json',
      'orbit_analytics.int_active_contract_arr.json',
    ]);
    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.touchedTableCount).toBe(2);
    const patterns = await readJson<Record<string, any>>(stagedDir, 'patterns-input.json');
    expect(patterns.templates.map((entry: any) => entry.id)).toEqual(['selected-qualified', 'selected-unqualified']);
  });

  it('preserves full patterns audit input and writes bounded cross-table pattern shards', async () => {
    const stagedDir = await tempDir();
    const largeSql = `select * from public.orders o join public.customers c on c.id = o.customer_id where payload = '${'x'.repeat(8000)}'`;
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'orders-customers-a',
          canonicalSql: largeSql,
          stats: {
            executions: 25,
            distinctUsers: 4,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 15,
            p95RuntimeMs: 90,
            errorRate: 0,
            rowsProduced: 250,
          },
        });
        yield aggregate({
          templateId: 'orders-customers-b',
          canonicalSql: largeSql.replace('payload', 'payload_b'),
          stats: {
            executions: 22,
            distinctUsers: 3,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 20,
            p95RuntimeMs: 95,
            errorRate: 0,
            rowsProduced: 220,
          },
        });
        yield aggregate({
          templateId: 'orders-single-table',
          canonicalSql: 'select count(*) from public.orders',
          stats: {
            executions: 30,
            distinctUsers: 2,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 10,
            p95RuntimeMs: 20,
            errorRate: 0,
            rowsProduced: 30,
          },
        });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'orders-customers-a',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: [],
              where: ['payload'],
              join: ['customer_id', 'id'],
              groupBy: [],
            },
          },
        ],
        [
          'orders-customers-b',
          {
            tablesTouched: ['public.orders', 'public.customers'],
            columnsByClause: {
              select: [],
              where: ['payload_b'],
              join: ['customer_id', 'id'],
              groupBy: [],
            },
          },
        ],
        [
          'orders-single-table',
          {
            tablesTouched: ['public.orders'],
            columnsByClause: {
              select: [],
              where: [],
              join: [],
              groupBy: [],
            },
          },
        ],
      ])),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: { dialect: 'postgres' },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    const audit = await readJson<Record<string, any>>(stagedDir, 'patterns-input.json');
    expect(audit.templates.map((entry: any) => entry.id)).toEqual([
      'orders-customers-a',
      'orders-customers-b',
      'orders-single-table',
    ]);

    const firstShard = await readJson<Record<string, any>>(stagedDir, 'patterns-input/part-0001.json');
    expect(firstShard.templates.map((entry: any) => entry.id)).toEqual(['orders-customers-a', 'orders-customers-b']);
    expect(firstShard.templates.some((entry: any) => entry.id === 'orders-single-table')).toBe(false);

    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.warnings).toEqual([]);
  });
});
