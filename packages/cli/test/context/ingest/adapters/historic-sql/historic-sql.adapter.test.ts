import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlAnalysisPort } from '../../../../../src/context/sql-analysis/ports.js';
import type { SourceAdapter } from '../../../../../src/context/ingest/types.js';
import { HistoricSqlSourceAdapter } from '../../../../../src/context/ingest/adapters/historic-sql/historic-sql.adapter.js';
import type { HistoricSqlReader } from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-adapter-'));
}

const sqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint() {
    throw new Error('analyzeForFingerprint must not be used');
  },
  async analyzeBatch() {
    return new Map();
  },
  async validateReadOnly() {
    return { ok: true };
  },
};

const reader: HistoricSqlReader = {
  async probe() {
    return { warnings: [], info: [] };
  },
  async *fetchAggregated() {},
};

describe('HistoricSqlSourceAdapter', () => {
  it('declares canonical adapter metadata', () => {
    const adapter = new HistoricSqlSourceAdapter({ sqlAnalysis, reader, queryClient: {} });

    expect(adapter.source).toBe('historic-sql');
    expect(adapter.skillNames).toEqual(['historic_sql_table_digest', 'historic_sql_patterns']);
    expect(adapter.reconcileSkillNames).toEqual([]);
    expect((adapter as SourceAdapter).evidenceIndexing).toBeUndefined();
    expect(adapter.triageSupported).toBe(false);
  });

  it('fetches a unified aggregate snapshot and emits unified WorkUnits', async () => {
    const stagedDir = await tempDir();
    const aggregateReader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {
        yield {
          templateId: 'pg:1',
          canonicalSql:
            'select o.status, count(*) from public.orders o join public.customers c on c.id = o.customer_id group by o.status',
          dialect: 'postgres',
          stats: {
            executions: 25,
            distinctUsers: 3,
            firstSeen: '2026-05-01T00:00:00.000Z',
            lastSeen: '2026-05-11T00:00:00.000Z',
            p50RuntimeMs: 10,
            p95RuntimeMs: 20,
            errorRate: 0,
            rowsProduced: 10,
          },
          topUsers: [{ user: 'analyst', executions: 25 }],
        };
      },
    };
    const batchSqlAnalysis: SqlAnalysisPort = {
      async analyzeForFingerprint() {
        throw new Error('analyzeForFingerprint must not be used');
      },
      async analyzeBatch() {
        return new Map([
          [
            'pg:1',
            {
              tablesTouched: [
                { catalog: null, db: 'public', name: 'orders' },
                { catalog: null, db: 'public', name: 'customers' },
              ],
              columnsByClause: { select: ['status'], join: ['customer_id', 'id'], groupBy: ['status'] },
            },
          ],
        ]);
      },
      async validateReadOnly() {
        return { ok: true };
      },
    };
    const adapter = new HistoricSqlSourceAdapter({
      sqlAnalysis: batchSqlAnalysis,
      reader: aggregateReader,
      queryClient: {},
      now: () => new Date('2026-05-11T00:00:00.000Z'),
    });

    await adapter.fetch({ dialect: 'postgres', minExecutions: 5 }, stagedDir, {
      connectionId: 'warehouse',
      sourceKey: 'historic-sql',
    });

    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
    await expect(adapter.chunk(stagedDir)).resolves.toMatchObject({
      workUnits: [
        { unitKey: 'historic-sql-table-public-customers' },
        { unitKey: 'historic-sql-table-public-orders' },
        { unitKey: 'historic-sql-patterns-part-0001' },
      ],
    });
  });
});
