import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AgentRunnerPort, RunLoopParams } from '../../../llm/index.js';
import { initKtxProject, loadKtxProject, type KtxLocalProject } from '../../../project/index.js';
import {
  type SqlAnalysisBatchItem,
  type SqlAnalysisBatchResult,
  type SqlAnalysisDialect,
  type SqlAnalysisPort,
} from '../../../sql-analysis/index.js';
import { searchLocalSlSources } from '../../../sl/local-sl.js';
import { searchLocalKnowledgePages } from '../../../wiki/local-knowledge.js';
import { runLocalIngest } from '../../local-ingest.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricSqlSourceAdapter } from './historic-sql.adapter.js';
import type { AggregatedTemplate, HistoricSqlReader, HistoricSqlUnifiedPullConfig } from './types.js';

class AcceptanceHistoricSqlReader implements HistoricSqlReader {
  async probe() {
    return { warnings: [], info: [] };
  }

  async *fetchAggregated(
    _client: unknown,
    _window: { start: Date; end: Date },
    _config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate> {
    yield {
      templateId: 'pg:orders-lifecycle',
      canonicalSql:
        'select o.status, c.segment, count(*) from public.orders o join public.customers c on c.id = o.customer_id where o.status = $1 group by o.status, c.segment',
      dialect: 'postgres',
      stats: {
        executions: 42,
        distinctUsers: 4,
        firstSeen: '2026-05-01T00:00:00.000Z',
        lastSeen: '2026-05-11T00:00:00.000Z',
        p50RuntimeMs: 18,
        p95RuntimeMs: 84,
        errorRate: 0,
        rowsProduced: 420,
      },
      topUsers: [{ user: 'analyst@example.test', executions: 42 }],
    };
  }
}

class HistoricSqlAcceptanceAgentRunner implements AgentRunnerPort {
  runLoop = vi.fn(async (params: RunLoopParams) => {
    if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
      return { stopReason: 'natural' as const };
    }

    const emitEvidence = params.toolSet.emit_historic_sql_evidence;
    if (!emitEvidence?.execute) {
      throw new Error('emit_historic_sql_evidence tool was not available to the historic-SQL WorkUnit');
    }

    if (params.telemetryTags.unitKey === 'historic-sql-table-public-orders') {
      const result = await emitEvidence.execute({
        kind: 'table_usage',
        table: 'public.orders',
        rawPath: 'tables/public.orders.json',
        usage: {
          narrative: 'Analysts repeatedly inspect paid order lifecycle by customer segment.',
          frequencyTier: 'high',
          commonFilters: ['status'],
          commonGroupBys: ['status', 'segment'],
          commonJoins: [{ table: 'public.customers', on: ['customer_id', 'id'] }],
          staleSince: null,
        },
      });
      if (!result.markdown.includes('Recorded historic-SQL table_usage evidence')) {
        throw new Error(`Unexpected orders evidence result: ${result.markdown}`);
      }
    }

    if (params.telemetryTags.unitKey === 'historic-sql-table-public-customers') {
      const result = await emitEvidence.execute({
        kind: 'table_usage',
        table: 'public.customers',
        rawPath: 'tables/public.customers.json',
        usage: {
          narrative: 'Customers provide segment context for paid order lifecycle analysis.',
          frequencyTier: 'mid',
          commonFilters: [],
          commonGroupBys: ['segment'],
          commonJoins: [{ table: 'public.orders', on: ['id', 'customer_id'] }],
          staleSince: null,
        },
      });
      if (!result.markdown.includes('Recorded historic-SQL table_usage evidence')) {
        throw new Error(`Unexpected customers evidence result: ${result.markdown}`);
      }
    }

    if (params.telemetryTags.unitKey === 'historic-sql-patterns-part-0001') {
      const result = await emitEvidence.execute({
        kind: 'pattern',
        rawPath: 'patterns-input/part-0001.json',
        pattern: {
          slug: 'paid-order-lifecycle',
          title: 'Paid Order Lifecycle',
          narrative: 'Analysts join orders and customers to compare paid order lifecycle by segment.',
          definitionSql:
            'select o.status, c.segment, count(*) from public.orders o join public.customers c on c.id = o.customer_id group by o.status, c.segment',
          tablesInvolved: ['public.orders', 'public.customers'],
          slRefs: ['orders', 'customers'],
          constituentTemplateIds: ['pg:orders-lifecycle'],
        },
      });
      if (!result.markdown.includes('Recorded historic-SQL pattern evidence')) {
        throw new Error(`Unexpected pattern evidence result: ${result.markdown}`);
      }
    }

    return { stopReason: 'natural' as const };
  });
}

function acceptanceSqlAnalysis(): SqlAnalysisPort {
  return {
    analyzeForFingerprint: async () => {
      throw new Error('analyzeForFingerprint should not be used by unified historic-SQL ingest');
    },
    analyzeBatch: vi.fn(
      async (
        items: SqlAnalysisBatchItem[],
        _dialect: SqlAnalysisDialect,
      ): Promise<Map<string, SqlAnalysisBatchResult>> => {
        return new Map(
          items.map((item) => [
            item.id,
            {
              tablesTouched: ['public.orders', 'public.customers'],
              columnsByClause: {
                select: ['status', 'segment'],
                where: ['status'],
                join: ['customer_id', 'id'],
                groupBy: ['status', 'segment'],
              },
            },
          ]),
        );
      },
    ),
    validateReadOnly: vi.fn(async () => ({ ok: true })),
  };
}

async function writeHistoricSqlProject(project: KtxLocalProject): Promise<KtxLocalProject> {
  await writeFile(
    join(project.projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    historicSql:',
      '      enabled: true',
      '      dialect: postgres',
      '      minExecutions: 2',
      'ingest:',
      '  adapters:',
      '    - historic-sql',
      '  embeddings:',
      '    backend: deterministic',
      'storage:',
      '  state: sqlite',
      '  search: sqlite-fts5',
      '  git:',
      '    auto_commit: false',
      '    author: KTX Test <system@ktx.local>',
      '',
    ].join('\n'),
    'utf-8',
  );

  const loaded = await loadKtxProject({ projectDir: project.projectDir });
  await loaded.fileStore.writeFile(
    'semantic-layer/warehouse/_schema/public.yaml',
    YAML.stringify({
      tables: {
        orders: {
          table: 'public.orders',
          columns: [
            { name: 'id', type: 'string' },
            { name: 'status', type: 'string' },
            { name: 'customer_id', type: 'string' },
          ],
        },
        customers: {
          table: 'public.customers',
          columns: [
            { name: 'id', type: 'string' },
            { name: 'segment', type: 'string' },
          ],
        },
      },
    }),
    'KTX Test',
    'system@ktx.local',
    'Seed schema shard',
  );
  return loaded;
}

describe('historic-SQL local ingest retrieval acceptance', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-historic-sql-acceptance-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('projects table and pattern evidence into semantic-layer and wiki retrieval surfaces', async () => {
    const initialized = await initKtxProject({ projectDir: join(tempDir, 'project') });
    const project = await writeHistoricSqlProject(initialized);
    const sqlAnalysis = acceptanceSqlAnalysis();
    const agentRunner = new HistoricSqlAcceptanceAgentRunner();
    const adapter = new HistoricSqlSourceAdapter({
      reader: new AcceptanceHistoricSqlReader(),
      queryClient: {},
      sqlAnalysis,
      now: () => new Date('2026-05-11T00:00:00.000Z'),
    });

    const result = await runLocalIngest({
      project,
      adapters: [adapter],
      adapter: 'historic-sql',
      connectionId: 'warehouse',
      jobId: 'historic-sql-retrieval-acceptance',
      agentRunner,
    });

    expect(sqlAnalysis.analyzeBatch).toHaveBeenCalledTimes(1);
    expect(result.result.failedWorkUnits).toEqual([]);
    expect(result.result.workUnitCount).toBe(3);
    expect(agentRunner.runLoop).toHaveBeenCalledTimes(3);
    const postProcessor = result.report.body.postProcessor;
    expect(postProcessor).toBeDefined();
    if (!postProcessor) {
      throw new Error('Expected historic-SQL post-processor result');
    }
    expect(postProcessor).toMatchObject({
      sourceKey: 'historic-sql',
      status: 'success',
      result: {
        tableUsageMerged: 2,
        patternPagesWritten: 1,
      },
    });
    expect(postProcessor.touchedSources).toEqual(
      expect.arrayContaining([
        { connectionId: 'warehouse', sourceName: 'customers' },
        { connectionId: 'warehouse', sourceName: 'orders' },
      ]),
    );

    await expect(readFile(join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8')).resolves
      .toContain('Analysts repeatedly inspect paid order lifecycle by customer segment.');
    await expect(readFile(join(project.projectDir, 'wiki/global/historic-sql-paid-order-lifecycle.md'), 'utf-8'))
      .resolves.toContain('Paid Order Lifecycle');

    const reloaded = await loadKtxProject({ projectDir: project.projectDir });
    await expect(
      searchLocalSlSources(reloaded, { connectionId: 'warehouse', query: 'paid order lifecycle', limit: 5 }),
    ).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'orders',
        frequencyTier: 'high',
        snippet: expect.stringContaining('<mark>'),
        matchReasons: expect.arrayContaining(['lexical']),
      }),
    ]));
    await expect(
      searchLocalKnowledgePages(reloaded, { query: 'paid order lifecycle', userId: 'local', limit: 5 }),
    ).resolves.toEqual([
      expect.objectContaining({
        key: 'historic-sql-paid-order-lifecycle',
        summary: 'Paid Order Lifecycle',
        matchReasons: expect.arrayContaining(['lexical']),
      }),
    ]);
  });
});
