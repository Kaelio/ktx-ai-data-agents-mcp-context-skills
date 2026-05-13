import { describe, expect, it } from 'vitest';
import {
  aggregatedTemplateSchema,
  historicSqlUnifiedPullConfigSchema,
  stagedManifestSchema,
  stagedPatternsInputSchema,
  stagedTableInputSchema,
} from './types.js';

describe('historic-sql unified contracts', () => {
  it('parses minExecutions and service-account filters', () => {
    expect(historicSqlUnifiedPullConfigSchema.parse({ dialect: 'postgres', minExecutions: 9 })).toMatchObject({
      dialect: 'postgres',
      minExecutions: 9,
      windowDays: 90,
      concurrency: 12,
      redactionPatterns: [],
      staleArchiveAfterDays: 90,
    });

    const parsed = historicSqlUnifiedPullConfigSchema.parse({
      dialect: 'postgres',
      minExecutions: 7,
      filters: {
        serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
      },
    });
    expect(parsed.minExecutions).toBe(7);
    expect(parsed.filters.serviceAccounts).toEqual({ patterns: ['^svc_'], mode: 'exclude' });
  });

  it('validates aggregate templates from warehouse readers', () => {
    const parsed = aggregatedTemplateSchema.parse({
      templateId: 'pg:123',
      canonicalSql: 'select status, count(*) from public.orders group by status',
      dialect: 'postgres',
      stats: {
        executions: 42,
        distinctUsers: 3,
        firstSeen: '2026-05-01T00:00:00.000Z',
        lastSeen: '2026-05-11T00:00:00.000Z',
        p50RuntimeMs: 12.5,
        p95RuntimeMs: 40,
        errorRate: 0,
        rowsProduced: 100,
      },
      topUsers: [{ user: 'analyst', executions: 40 }],
    });

    expect(parsed.templateId).toBe('pg:123');
    expect(parsed.topUsers).toEqual([{ user: 'analyst', executions: 40 }]);
  });

  it('validates staged table, patterns, and manifest artifacts', () => {
    expect(
      stagedTableInputSchema.parse({
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
          where: [['created_at', 'mid']],
        },
        observedJoins: [{ withTable: 'public.customers', on: ['customer_id'], freq: 'high' }],
        topTemplates: [{ id: 'pg:123', canonicalSql: 'select * from public.orders', topUsers: [{ user: 'analyst' }] }],
      }).table,
    ).toBe('public.orders');

    expect(
      stagedPatternsInputSchema.parse({
        templates: [
          {
            id: 'pg:123',
            canonicalSql: 'select * from public.orders',
            tablesTouched: ['public.orders'],
            executionsBucket: '10-100',
            distinctUsersBucket: '2-5',
            dialect: 'postgres',
          },
        ],
      }).templates,
    ).toHaveLength(1);

    expect(
      stagedManifestSchema.parse({
        source: 'historic-sql',
        connectionId: 'warehouse',
        dialect: 'postgres',
        fetchedAt: '2026-05-11T00:00:00.000Z',
        windowStart: '2026-02-10T00:00:00.000Z',
        windowEnd: '2026-05-11T00:00:00.000Z',
        snapshotRowCount: 2,
        touchedTableCount: 1,
        parseFailures: 1,
        warnings: ['parse_failed:bad'],
        probeWarnings: [],
        staleArchiveAfterDays: 90,
      }).staleArchiveAfterDays,
    ).toBe(90);
  });
});
