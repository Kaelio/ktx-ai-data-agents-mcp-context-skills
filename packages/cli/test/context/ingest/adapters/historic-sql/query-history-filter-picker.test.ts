import { describe, expect, it, vi } from 'vitest';
import type { KtxLlmRuntimePort } from '../../../../../src/context/llm/runtime-port.js';
import type {
  SqlAnalysisBatchItem,
  SqlAnalysisBatchResult,
  SqlAnalysisPort,
} from '../../../../../src/context/sql-analysis/ports.js';
import {
  proposeQueryHistoryServiceAccountFilters,
  regexEscapeForExactRolePattern,
} from '../../../../../src/context/ingest/adapters/historic-sql/query-history-filter-picker.js';
import type {
  AggregatedTemplate,
  HistoricSqlReader,
} from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

function aggregate(overrides: Partial<AggregatedTemplate> & { templateId: string; canonicalSql: string }): AggregatedTemplate {
  return {
    templateId: overrides.templateId,
    canonicalSql: overrides.canonicalSql,
    dialect: overrides.dialect ?? 'postgres',
    stats: overrides.stats ?? {
      executions: 25,
      distinctUsers: 1,
      firstSeen: '2026-05-01T00:00:00.000Z',
      lastSeen: '2026-06-01T00:00:00.000Z',
      p50RuntimeMs: 50,
      p95RuntimeMs: 100,
      errorRate: 0,
      rowsProduced: 10,
    },
    topUsers: overrides.topUsers ?? [{ user: 'analyst', executions: 25 }],
  };
}

function reader(...templates: AggregatedTemplate[]): HistoricSqlReader {
  return {
    async probe() {
      return { warnings: [], info: [] };
    },
    async *fetchAggregated() {
      for (const template of templates) {
        yield template;
      }
    },
  };
}

function sqlAnalysis(tablesById: Record<string, Array<{ catalog: string | null; db: string | null; name: string }>>): SqlAnalysisPort {
  return {
    analyzeForFingerprint: vi.fn(),
    analyzeBatch: vi.fn(async (items: SqlAnalysisBatchItem[]): Promise<Map<string, SqlAnalysisBatchResult>> =>
      new Map<string, SqlAnalysisBatchResult>(
        items.map((item) => [
          item.id,
          {
            tablesTouched: tablesById[item.id] ?? [],
            columnsByClause: {},
          },
        ]),
      ),
    ),
    validateReadOnly: vi.fn(async () => ({ ok: true })),
  };
}

function llm(decisions: Array<{ role: string; exclude: boolean; reason: string }>): KtxLlmRuntimePort {
  const generateObject = vi.fn(async () => ({ roles: decisions })) as KtxLlmRuntimePort['generateObject'];
  return {
    generateText: vi.fn(),
    generateObject,
    runAgentLoop: vi.fn(),
  };
}

describe('query-history filter picker', () => {
  it('emits anchored escaped patterns for excluded roles from one batched LLM call', async () => {
    const runtime = llm([
      { role: 'svc.loader+prod', exclude: true, reason: 'Runs recurring loader traffic only.' },
      { role: 'analyst', exclude: false, reason: 'Interactive analytic usage.' },
    ]);
    const analysis = sqlAnalysis({
      loader: [{ catalog: null, db: 'analytics', name: 'orders' }],
      analyst: [{ catalog: null, db: 'analytics', name: 'orders' }],
    });

    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'loader',
          canonicalSql: 'merge into analytics.orders using staging.orders_delta on orders.id = orders_delta.id',
          topUsers: [{ user: 'svc.loader+prod', executions: 40 }],
        }),
        aggregate({
          templateId: 'analyst',
          canonicalSql: 'select status, count(*) from analytics.orders group by status',
          topUsers: [{ user: 'analyst', executions: 25 }],
        }),
      ),
      sqlAnalysis: analysis,
      llmRuntime: runtime,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['analytics'],
        enabledTables: [],
        modeledTableCatalog: [{ catalog: null, db: 'analytics', name: 'orders' }],
        filters: { dropTrivialProbes: true },
      },
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    expect(runtime.generateObject).toHaveBeenCalledTimes(1);
    expect(proposal).toMatchObject({
      excludedRoles: [
        {
          role: 'svc.loader+prod',
          pattern: '^svc\\.loader\\+prod$',
          reason: 'Runs recurring loader traffic only.',
        },
      ],
      consideredRoleCount: 2,
      skipped: null,
      warnings: [],
    });
  });

  it('fails open with no LLM runtime', async () => {
    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(),
      sqlAnalysis: sqlAnalysis({}),
      llmRuntime: null,
      pullConfig: { dialect: 'postgres', filters: { dropTrivialProbes: true } },
    });

    expect(proposal).toEqual({
      excludedRoles: [],
      consideredRoleCount: 0,
      skipped: { reason: 'no-llm' },
      warnings: [],
    });
  });

  it('proposes nothing for a single-role stack', async () => {
    const runtime = llm([{ role: 'warehouse_user', exclude: true, reason: 'Only observed role.' }]);

    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'single-role',
          canonicalSql: 'select * from analytics.orders',
          topUsers: [{ user: 'warehouse_user', executions: 40 }],
        }),
      ),
      sqlAnalysis: sqlAnalysis({
        'single-role': [{ catalog: null, db: 'analytics', name: 'orders' }],
      }),
      llmRuntime: runtime,
      pullConfig: { dialect: 'postgres', enabledSchemas: ['analytics'], filters: { dropTrivialProbes: true } },
    });

    expect(runtime.generateObject).not.toHaveBeenCalled();
    expect(proposal.excludedRoles).toEqual([]);
    expect(proposal.skipped).toEqual({ reason: 'no-in-scope-history' });
  });

  it('keeps clean in-scope history when the model excludes nothing', async () => {
    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'bigquery',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'dashboard',
          canonicalSql: 'select status, count(*) from `demo.analytics.orders` group by status',
          dialect: 'bigquery',
          topUsers: [{ user: 'bi_runner', executions: 1 }],
        }),
        aggregate({
          templateId: 'analyst',
          canonicalSql: 'select * from `demo.analytics.orders` where id = @id',
          dialect: 'bigquery',
          topUsers: [{ user: 'analyst', executions: 1 }],
        }),
      ),
      sqlAnalysis: sqlAnalysis({
        dashboard: [{ catalog: 'demo', db: 'analytics', name: 'orders' }],
        analyst: [{ catalog: 'demo', db: 'analytics', name: 'orders' }],
      }),
      llmRuntime: llm([
        { role: 'bi_runner', exclude: false, reason: 'Dashboard usage is analytic.' },
        { role: 'analyst', exclude: false, reason: 'Interactive analyst usage.' },
      ]),
      pullConfig: {
        dialect: 'bigquery',
        windowDays: 90,
        enabledSchemas: ['analytics'],
        filters: { dropTrivialProbes: true },
      },
    });

    expect(proposal.excludedRoles).toEqual([]);
    expect(proposal.consideredRoleCount).toBe(2);
    expect(proposal.skipped).toBeNull();
  });

  it('escapes regex metacharacters for exact role matches', () => {
    expect(regexEscapeForExactRolePattern('svc.loader+prod')).toBe('^svc\\.loader\\+prod$');
    expect(regexEscapeForExactRolePattern('team[etl](west)')).toBe('^team\\[etl\\]\\(west\\)$');
  });
});
