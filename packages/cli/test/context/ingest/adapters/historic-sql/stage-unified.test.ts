import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SqlAnalysisPort } from '../../../../../src/context/sql-analysis/ports.js';
import { stageHistoricSqlAggregatedSnapshot } from '../../../../../src/context/ingest/adapters/historic-sql/stage-unified.js';
import type { AggregatedTemplate, HistoricSqlReader } from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-unified-stage-'));
}

async function readJson<T>(root: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relPath), 'utf-8')) as T;
}

function tableRef(value: string): { catalog: string | null; db: string | null; name: string } {
  const parts = value.split('.');
  if (parts.length === 3) return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  if (parts.length === 2) return { catalog: null, db: parts[0]!, name: parts[1]! };
  return { catalog: null, db: null, name: value };
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
            tablesTouched: [tableRef('public.orders'), tableRef('public.customers')],
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
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['public'],
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
      undefined,
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
      tableRef: tableRef('public.orders'),
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
        tablesTouched: [tableRef('public.customers'), tableRef('public.orders')],
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
            tablesTouched: [tableRef('public.api_events')],
            columnsByClause: {
              select: [],
              where: ['api_key', 'note'],
              join: [],
              groupBy: [],
            },
          },
        ],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['public'],
        redactionPatterns: ['sk_live_[A-Za-z0-9]+', '(?i)secret_token_[a-z0-9]+'],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledWith(
      [{ id: 'api-events-with-secret', sql: originalSql }],
      'postgres',
      undefined,
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
            tablesTouched: [tableRef('orbit_analytics.int_active_contract_arr')],
            columnsByClause: { select: [], where: [], join: [], groupBy: [] },
          },
        ],
        [
          'selected-unqualified',
          {
            tablesTouched: [tableRef('orbit_analytics.int_customer_health_signals')],
            columnsByClause: { select: [], where: [], join: [], groupBy: [] },
          },
        ],
        [
          'unselected',
          {
            tablesTouched: [tableRef('orbit_raw.accounts')],
            columnsByClause: { select: [], where: [], join: [], groupBy: [] },
          },
        ],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
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
          tableRef('orbit_analytics.int_active_contract_arr'),
          tableRef('orbit_analytics.int_customer_health_signals'),
        ],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'tables'))).toEqual([
      'orbit_analytics.int_active_contract_arr.json',
      'orbit_analytics.int_customer_health_signals.json',
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
            tablesTouched: [tableRef('public.orders'), tableRef('public.customers')],
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
            tablesTouched: [tableRef('public.orders'), tableRef('public.customers')],
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
            tablesTouched: [tableRef('public.orders')],
            columnsByClause: {
              select: [],
              where: [],
              join: [],
              groupBy: [],
            },
          },
        ],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: { dialect: 'postgres', enabledSchemas: ['public'] },
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

  it("drops ktx's own scan/relationship probes from query history", async () => {
    const stagedDir = await tempDir();
    const fkOverlapProbe =
      'select * from (WITH child_values AS ( SELECT DISTINCT "account_id" AS value FROM "account_owners" WHERE "account_id" IS NOT NULL LIMIT $1 ), parent_values AS ( SELECT DISTINCT "account_id" AS value FROM "accounts" WHERE "account_id" IS NOT NULL ) SELECT (SELECT COUNT(*) FROM child_values) AS child_distinct, (SELECT COUNT(*) FROM parent_values) AS parent_distinct) probe';
    const profileProbe =
      'select * from (SELECT $1 AS column_name, (SELECT COUNT(*) FROM "orbit_raw"."accounts") AS total, (SELECT STRING_AGG(CAST(value AS TEXT), CHR(31)) FROM (SELECT DISTINCT "id" AS value FROM "orbit_raw"."accounts" LIMIT $2) AS relationship_profile_values) AS samples) profile';
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({
          templateId: 'analytic',
          canonicalSql: 'select status, count(*) from public.orders group by status',
        });
        yield aggregate({ templateId: 'ktx-fk-overlap', canonicalSql: fkOverlapProbe });
        yield aggregate({ templateId: 'ktx-profile', canonicalSql: profileProbe });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        [
          'analytic',
          {
            tablesTouched: [tableRef('public.orders')],
            columnsByClause: { select: ['status'], where: [], join: [], groupBy: ['status'] },
          },
        ],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: { dialect: 'postgres', enabledSchemas: ['public'] },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    // ktx scan probes are filtered before SQL analysis, so only the analytic query is parsed.
    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledWith(
      [{ id: 'analytic', sql: 'select status, count(*) from public.orders group by status' }],
      'postgres',
      undefined,
    );
    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['public.orders.json']);
  });

  it('keeps modeled-schema refs and drops unmodeled-schema refs by default', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({ templateId: 'modeled', canonicalSql: 'select count(*) from orbit_raw.accounts' });
        yield aggregate({ templateId: 'noise', canonicalSql: 'select count(*) from metabase.application_table' });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        ['modeled', { tablesTouched: [{ catalog: null, db: 'orbit_raw', name: 'accounts' }], columnsByClause: {} }],
        ['noise', { tablesTouched: [{ catalog: null, db: 'metabase', name: 'application_table' }], columnsByClause: {} }],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['orbit_raw'],
        modeledTableCatalog: [{ catalog: null, db: 'orbit_raw', name: 'accounts' }],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['orbit_raw.accounts.json']);
    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.touchedTableCount).toBe(1);
  });

  it('fails open when the implicit modeled scope is empty', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({ templateId: 'any-table', canonicalSql: 'select count(*) from metabase.application_table' });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        ['any-table', { tablesTouched: [{ catalog: null, db: 'metabase', name: 'application_table' }], columnsByClause: {} }],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: { dialect: 'postgres', enabledSchemas: [], modeledTableCatalog: [] },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['metabase.application_table.json']);
    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.warnings).toContain('query_history_scope_floor_disabled:empty_modeled_scope');
  });

  it('lets enabledSchemas star disable the floor', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({ templateId: 'noise', canonicalSql: 'select count(*) from metabase.application_table' });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        ['noise', { tablesTouched: [{ catalog: null, db: 'metabase', name: 'application_table' }], columnsByClause: {} }],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['*'],
        modeledTableCatalog: [{ catalog: null, db: 'orbit_raw', name: 'accounts' }],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['metabase.application_table.json']);
  });

  it('matches BigQuery dataset scope even when refs include a catalog', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({ templateId: 'modeled', canonicalSql: 'select count(*) from `demo-project.orbit_analytics.orders`' });
        yield aggregate({ templateId: 'noise', canonicalSql: 'select count(*) from `demo-project.metabase.application_table`' });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        ['modeled', { tablesTouched: [{ catalog: 'demo-project', db: 'orbit_analytics', name: 'orders' }], columnsByClause: {} }],
        ['noise', { tablesTouched: [{ catalog: 'demo-project', db: 'metabase', name: 'application_table' }], columnsByClause: {} }],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'bigquery',
        enabledSchemas: ['orbit_analytics'],
        modeledTableCatalog: [{ catalog: 'demo-project', db: 'orbit_analytics', name: 'orders' }],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['demo-project.orbit_analytics.orders.json']);
  });

  it('writes propagated scope-floor warnings to the staged manifest', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({ templateId: 'any-table', canonicalSql: 'select count(*) from metabase.application_table' });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(async () => new Map([
        ['any-table', { tablesTouched: [{ catalog: null, db: 'metabase', name: 'application_table' }], columnsByClause: {} }],
      ])),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['*'],
        scopeFloorWarnings: ['query_history_scope_floor_disabled:catalog_unavailable'],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.warnings).toContain('query_history_scope_floor_disabled:catalog_unavailable');
    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['metabase.application_table.json']);
  });

  it('retries without the catalog and disables the floor when catalog qualification fails wholesale', async () => {
    const stagedDir = await tempDir();
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield aggregate({ templateId: 'noise', canonicalSql: 'select count(*) from metabase.application_table' });
      },
    };
    const sqlAnalysis: SqlAnalysisPort = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi
        .fn()
        .mockRejectedValueOnce(new Error('catalog qualification failed'))
        .mockResolvedValueOnce(
          new Map([
            ['noise', { tablesTouched: [{ catalog: null, db: 'metabase', name: 'application_table' }], columnsByClause: {} }],
          ]),
        ),
      validateReadOnly: vi.fn(async () => ({ ok: true })),
    };

    await stageHistoricSqlAggregatedSnapshot({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: {},
      reader,
      sqlAnalysis,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['orbit_raw'],
        modeledTableCatalog: [{ catalog: null, db: 'orbit_raw', name: 'accounts' }],
      },
      now: new Date('2026-05-11T12:00:00.000Z'),
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledTimes(2);
    expect(sqlAnalysis.analyzeBatch).toHaveBeenNthCalledWith(
      1,
      [{ id: 'noise', sql: 'select count(*) from metabase.application_table' }],
      'postgres',
      { catalog: { tables: [{ catalog: null, db: 'orbit_raw', name: 'accounts' }] } },
    );
    expect(sqlAnalysis.analyzeBatch).toHaveBeenNthCalledWith(
      2,
      [{ id: 'noise', sql: 'select count(*) from metabase.application_table' }],
      'postgres',
      undefined,
    );
    expect(await readdir(join(stagedDir, 'tables'))).toEqual(['metabase.application_table.json']);
    const manifest = await readJson<Record<string, any>>(stagedDir, 'manifest.json');
    expect(manifest.warnings).toContain('query_history_scope_floor_disabled:catalog_qualification_failed');
  });
});
